// Backup and restore (spec 01 section 11, decision 65). A backup is one dated folder:
//   database.dump   pg_dump of the app's schemas (public and app_meta), custom format
//   files/          every object in file storage (evidence, uploads), by key
//   manifest.json   when, row counts per table, and each file's size and sha256
// Uses pg_dump / pg_restore when installed (PG_BIN_DIR, or on the PATH); otherwise, for the local
// Supabase stack only, the same tools inside its database container.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { decodeCa, libpqUrl } from '../../src/lib/db-ssl';
import { isLocalDatabase, ROOT } from './db';

export const SCHEMAS = ['public', 'app_meta'];

export type Manifest = {
  format: 1;
  createdAt: string;
  source: string;
  migrations: string[];
  tables: Record<string, number>;
  files: { key: string; size: number; sha256: string }[];
};

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Row counts for every table in the app's schemas, to compare after a restore. */
export async function tableCounts(client: pg.Client): Promise<Record<string, number>> {
  const { rows } = await client.query<{ name: string }>(
    `select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema = any ($1) and table_type = 'BASE TABLE' order by 1`,
    [SCHEMAS],
  );
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const [schema, table] = r.name.split('.');
    counts[r.name] = Number((await client.query(`select count(*) as n from ${schema}."${table}"`)).rows[0].n);
  }
  return counts;
}

type Tool = { run: (args: string[], io: { stdin?: string; stdout?: string }) => Promise<void>; how: string };

function onPath(binary: string): string | null {
  const dir = process.env['PG_BIN_DIR'];
  if (dir && existsSync(join(dir, binary))) return join(dir, binary);
  const found = spawnSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

function localContainer(): string | null {
  const id = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8'))?.[1];
  if (!id) return null;
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  const name = `supabase_db_${id}`;
  return ps.status === 0 && ps.stdout.split('\n').includes(name) ? name : null;
}

function runProcess(command: string, args: string[], io: { stdin?: string; stdout?: string }, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
    if (io.stdin) createReadStream(io.stdin).pipe(child.stdin!);
    if (io.stdout) child.stdout!.pipe(createWriteStream(io.stdout));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args[0] ?? ''} failed (${code}): ${stderr.trim()}`))));
  });
}

function majorOf(path: string): number {
  const out = spawnSync(path, ['--version'], { encoding: 'utf8' }).stdout ?? '';
  return Number(/(\d+)(?:\.\d+)?/.exec(out)?.[1] ?? 0);
}

/** The root certificate as a file for libpq (it reads files only), or null (decision 91). */
function caFile(): string | null {
  const ca = decodeCa(process.env.DATABASE_SSL_CA);
  if (!ca) return null;
  const dir = mkdtempSync(join(tmpdir(), 'ggp-ca-'));
  const file = join(dir, 'root.crt');
  writeFileSync(file, ca, { mode: 0o600 });
  return file;
}

export { libpqUrl };

/**
 * pg_dump or pg_restore for this database: installed tools if they are at least the server's
 * version, otherwise (local Supabase only) the tools inside its database container.
 */
export async function pgTool(binary: 'pg_dump' | 'pg_restore', url: string, client: pg.Client): Promise<Tool> {
  const serverMajor = Math.floor(Number((await client.query<{ v: string }>('show server_version_num')).rows[0]!.v) / 10000);
  const path = onPath(binary);
  if (path && majorOf(path) >= serverMajor) return { how: path, run: (args, io) => runProcess(path, [...args, `--dbname=${libpqUrl(url, caFile())}`], io, process.env) };
  const container = isLocalDatabase(url) ? localContainer() : null;
  if (!container) {
    throw new Error(`${binary} version ${serverMajor} or later was not found. Install the PostgreSQL ${serverMajor} client tools, or set PG_BIN_DIR.`);
  }
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.slice(1)) || 'postgres';
  return {
    how: `${binary} in the ${container} container`,
    run: (args, io) =>
      runProcess(
        'docker',
        ['exec', '-i', '-e', `PGPASSWORD=${decodeURIComponent(u.password)}`, container, binary, ...args, '-h', 'localhost', '-U', decodeURIComponent(u.username) || 'postgres', '-d', database],
        io,
        process.env,
      ),
  };
}
