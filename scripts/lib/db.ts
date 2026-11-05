// Shared code for db:reset and db:migrate. Plain Postgres: works on local
// Supabase, a hosted Supabase project, or any self-hosted Postgres 15+.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { decodeCa, pgConnection } from '../../src/lib/db-ssl';

export const ROOT = join(import.meta.dirname, '../..');
const MIGRATIONS_DIR = join(ROOT, 'db/migrations');
const SEED_DIR = join(ROOT, 'db/seed');
const SUPABASE_GRANTS = join(ROOT, 'db/platform/supabase_grants.sql');
const SUPABASE_AUTH_HOOK = join(ROOT, 'db/platform/supabase_auth_hook.sql');

export type SqlFile = { kind: 'migration' | 'seed'; name: string; sql: string; checksum: string };

/** Reads .env, or the file ENV_FILE names (which must exist), for example .env.hosted. */
export function loadEnv(): void {
  if (process.env.ENV_FILE) {
    process.loadEnvFile(process.env.ENV_FILE);
    return;
  }
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env file: use the environment as it is (CI).
  }
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  return url;
}

/** True only for a database on this machine. */
export function isLocalDatabase(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

/** Host and database name only, never the password. */
export function describeDatabase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readSqlDir(dir: string, kind: SqlFile['kind']): SqlFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { kind, name, sql, checksum: sha256(sql) };
    });
}

/** Every migration in order, then every seed file in order. */
export function sqlFiles(): SqlFile[] {
  return [...readSqlDir(MIGRATIONS_DIR, 'migration'), ...readSqlDir(SEED_DIR, 'seed')];
}

export async function connect(url: string): Promise<pg.Client> {
  // Verified against DATABASE_SSL_CA when it is set (decision 91).
  const client = new pg.Client(pgConnection(url, decodeCa(process.env.DATABASE_SSL_CA)));
  await client.connect();
  return client;
}

// Bookkeeping for the runner itself, kept out of the public (API) schema.
async function ensureMetaTable(client: pg.Client): Promise<void> {
  await client.query(`
    create schema if not exists app_meta;
    revoke all on schema app_meta from public;
    create table if not exists app_meta.schema_files (
      file_name       text primary key,
      kind            text not null check (kind in ('migration','seed')),
      checksum_sha256 text not null,
      applied_at      timestamptz not null default now()
    );
    alter table app_meta.schema_files enable row level security;
  `);
}

/**
 * Applies every migration and seed file not yet recorded. Forward-only: if a
 * file that was already applied has changed, nothing runs and an error says so.
 */
export async function applyPending(client: pg.Client, log: (line: string) => void = () => {}): Promise<string[]> {
  await ensureMetaTable(client);
  const { rows } = await client.query<{ file_name: string; checksum_sha256: string }>(
    'select file_name, checksum_sha256 from app_meta.schema_files',
  );
  const applied = new Map(rows.map((r) => [r.file_name, r.checksum_sha256]));
  const files = sqlFiles();

  const changed = files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.checksum);
  if (changed.length > 0) {
    throw new Error(
      `These files changed after they were applied: ${changed.map((f) => f.name).join(', ')}. ` +
        'Migrations are forward-only. Undo the edit and add a new numbered migration instead.',
    );
  }

  const done: string[] = [];
  for (const file of files.filter((f) => !applied.has(f.name))) {
    // Seed files open and commit their own transaction; anything else is wrapped
    // here so the file and its bookkeeping row commit together.
    const ownsTransaction = /^\s*begin\s*;/im.test(file.sql);
    const record = () =>
      client.query('insert into app_meta.schema_files (file_name, kind, checksum_sha256) values ($1, $2, $3)', [
        file.name,
        file.kind,
        file.checksum,
      ]);
    try {
      if (ownsTransaction) {
        await client.query(file.sql);
        await record();
      } else {
        await client.query('begin');
        await client.query(file.sql);
        await record();
        await client.query('commit');
      }
    } catch (error) {
      await client.query('rollback');
      throw new Error(`${file.name} failed: ${(error as Error).message}`, { cause: error });
    }
    log(`  applied ${file.kind} ${file.name}`);
    done.push(file.name);
  }
  return done;
}

/** On Supabase only: let the API roles reach the tables. RLS still decides what they see. */
export async function applyPlatformGrants(client: pg.Client, log: (line: string) => void = () => {}): Promise<void> {
  const { rows } = await client.query("select 1 from pg_roles where rolname = 'authenticated'");
  if (rows.length === 0) return;
  await client.query(readFileSync(SUPABASE_GRANTS, 'utf8'));
  log('  applied Supabase API grants');
  const auth = await client.query("select 1 from pg_roles where rolname = 'supabase_auth_admin'");
  if (auth.rows.length === 0) return;
  await client.query(readFileSync(SUPABASE_AUTH_HOOK, 'utf8'));
  log('  applied Supabase sign-in hook');
}
