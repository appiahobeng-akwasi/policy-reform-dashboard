// Database access from the app server. Plain Postgres (pg), so it works on any host.
//
// asUser() runs queries as the signed-in user: inside one transaction it switches to the
// 'authenticated' role and sets the verified sign-in claims, so row-level security decides
// what the query sees, exactly as for Supabase's own API. Everything the app shows to a user
// goes through asUser().
//
// The other functions are the few server-side lookups that must see past row-level security
// (sign-in allowlist, linking a new sign-in, the session's own profile). Call them only with
// values from verified sign-in claims.
import pg from 'pg';
import type { AuthClaims } from './auth';
import { env } from './env';
import { decodeCa, pgConnection } from './db-ssl';
import { isLang, type Lang } from '../i18n';

let pool: pg.Pool | undefined;

// Dates (no time) come back as 'YYYY-MM-DD' text, not as JavaScript dates at local midnight,
// so they never shift by a day between time zones.
const DATE_OID = 1082;
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID ? (value: string) => value : pg.types.getTypeParser(oid, format as 'text')) as pg.CustomTypesConfig['getTypeParser'],
};

function getPool(): pg.Pool {
  pool ??= new pg.Pool({ ...pgConnection(env.databaseUrl, decodeCa(env.databaseSslCa)), max: env.databasePoolSize, types });
  return pool;
}

export async function asUser<T>(claims: AuthClaims, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query('begin');
    // Claims and role in one round trip (setting 'role' locally is the same as SET LOCAL ROLE).
    await db.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify(claims)]);
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}

export type Profile = {
  userId: string;
  personId: string;
  role: string;
  mfaRequired: boolean;
  email: string;
  name: string;
  lang: Lang | null;
};

export async function findProfile(authUserId: string): Promise<Profile | null> {
  const { rows } = await getPool().query<{
    user_id: string;
    person_id: string;
    app_role: string;
    mfa_required: boolean;
    email: string;
    full_name: string;
    preferred_language: string;
  }>(
    `select u.user_id, u.person_id, u.app_role, u.mfa_required, u.email, p.full_name, p.preferred_language
       from app_users u join people p on p.person_id = u.person_id
      where u.auth_user_id = $1 and u.is_active`,
    [authUserId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    personId: row.person_id,
    role: row.app_role,
    mfaRequired: row.mfa_required,
    email: row.email,
    name: row.full_name,
    lang: isLang(row.preferred_language) ? row.preferred_language : null,
  };
}

export async function isAllowedEmail(email: string): Promise<boolean> {
  const { rows } = await getPool().query<{ allowed: boolean }>('select is_allowed_email($1) as allowed', [email]);
  return rows[0]?.allowed === true;
}

/** Links a verified sign-in to the account with that email. Null if it may not sign in. */
export async function linkAuthUser(email: string, authUserId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ user_id: string | null }>('select link_auth_user($1, $2) as user_id', [email, authUserId]);
  return rows[0]?.user_id ?? null;
}

/** Runs fn in a transaction on the server's own connection (past row-level security). */
export async function inServerTransaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query('begin');
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}

/** Closes the pool, for commands that must exit when done (npm run jobs). */
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
