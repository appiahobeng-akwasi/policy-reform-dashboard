// Users and access (spec 01 section 3, build step 11). Admin actions go straight to the tables as
// the signed-in admin (decision 42): row-level security says who may, the guards in migration 0014
// stop self-lockout and super administrator changes, and every change lands in the audit log.
import type pg from 'pg';
import type { AuthAdmin, AuthClaims } from '../auth';
import { asUser } from '../server-db';

export const ROLES = ['super_admin', 'programme_admin', 'reform_lead', 'contributor', 'merl_officer', 'viewer_internal', 'viewer_counterpart'] as const;
export type Role = (typeof ROLES)[number];
export const ADMIN_ROLES: readonly string[] = ['super_admin', 'programme_admin'];
export const PAGE_SIZE = 50;

export type Scope = { reformId: string; canApprove: boolean };
export type AccessInput = {
  name: string;
  email: string;
  role: Role;
  language: 'en' | 'fr';
  scope: Scope[];
};
export type PersonInput = {
  name: string;
  email: string | null;
  institutionId: string | null;
  roleTitle: string | null;
  language: 'en' | 'fr';
};
/** Problems with what was typed; each has a message in the catalogues under admin.problem_*. */
export type Problem = 'name' | 'email' | 'role' | 'institution';
/** Refusals from the database (U01 to U08) or row-level security. Messages under admin.error_*. */
export type ErrorCode = 'U01' | 'U02' | 'U03' | 'U04' | 'U05' | 'U06' | 'U07' | 'U08' | 'U09' | 'forbidden' | 'other';
export type Result<T = undefined> = { ok: true; value: T } | { ok: false; code: ErrorCode };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Reads the add or edit form. Reforms come as scope_RA1 (works on) and approve_RA1 (approves). */
export function readAccessForm(form: FormData, reforms: readonly string[]): { input: AccessInput; problems: Problem[] } {
  const role = String(form.get('role') ?? '');
  const input: AccessInput = {
    name: String(form.get('name') ?? '').trim(),
    email: normaliseEmail(String(form.get('email') ?? '')),
    role: role as Role,
    language: form.get('language') === 'fr' ? 'fr' : 'en',
    scope: reforms
      .filter((r) => form.get(`scope_${r}`) === 'on' || form.get(`approve_${r}`) === 'on')
      .map((r) => ({
        reformId: r,
        canApprove: form.get(`approve_${r}`) === 'on',
      })),
  };
  const problems: Problem[] = [];
  if (!input.name) problems.push('name');
  if (!EMAIL.test(input.email)) problems.push('email');
  if (!(ROLES as readonly string[]).includes(role)) problems.push('role');
  return { input, problems };
}

export function readPersonForm(form: FormData, institutions: readonly string[]): { input: PersonInput; problems: Problem[] } {
  const email = normaliseEmail(String(form.get('email') ?? ''));
  const institution = String(form.get('institution') ?? '');
  const input: PersonInput = {
    name: String(form.get('name') ?? '').trim(),
    email: email || null,
    institutionId: institution || null,
    roleTitle: String(form.get('role_title') ?? '').trim() || null,
    language: form.get('language') === 'en' ? 'en' : 'fr',
  };
  const problems: Problem[] = [];
  if (!input.name) problems.push('name');
  if (input.email !== null && !EMAIL.test(input.email)) problems.push('email');
  if (input.institutionId !== null && !institutions.includes(input.institutionId)) problems.push('institution');
  return { input, problems };
}

/** Maps a database refusal to a code with a message for the person. */
export function accessError(error: unknown): ErrorCode {
  const e = error as { message?: string; code?: string };
  const code = /^(U0\d)\b/.exec(e.message ?? '')?.[1];
  if (code) return code as ErrorCode;
  if (e.code === '23505') return 'U08';
  if (e.code === '42501') return 'forbidden';
  return 'other';
}

async function attempt<T>(claims: AuthClaims, fn: (db: pg.PoolClient) => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await asUser(claims, fn) };
  } catch (error) {
    const code = accessError(error);
    if (code === 'other') throw error;
    return { ok: false, code };
  }
}

export type UserRow = {
  userId: string;
  personId: string;
  authUserId: string | null;
  name: string;
  email: string;
  role: Role;
  language: 'en' | 'fr';
  isActive: boolean;
  lastSignInAt: string | null;
  scope: Scope[];
};

const USER_SELECT = `select u.user_id, u.person_id, u.auth_user_id, p.full_name, u.email, u.app_role, p.preferred_language, u.is_active, u.last_sign_in_at::text,
       coalesce((select json_agg(json_build_object('reformId', s.reform_id, 'canApprove', s.can_approve) order by s.reform_id)
                   from user_reform_scope s where s.user_id = u.user_id), '[]') as scope
  from app_users u join people p on p.person_id = u.person_id`;

type UserDbRow = {
  user_id: string;
  person_id: string;
  auth_user_id: string | null;
  full_name: string;
  email: string;
  app_role: Role;
  preferred_language: 'en' | 'fr';
  is_active: boolean;
  last_sign_in_at: string | null;
  scope: Scope[];
};
const toUser = (r: UserDbRow): UserRow => ({
  userId: r.user_id,
  personId: r.person_id,
  authUserId: r.auth_user_id,
  name: r.full_name,
  email: r.email,
  role: r.app_role,
  language: r.preferred_language,
  isActive: r.is_active,
  lastSignInAt: r.last_sign_in_at,
  scope: r.scope,
});

export type UserFilter = {
  q: string;
  role: string | null;
  status: 'active' | 'inactive' | 'all';
  page: number;
};

export async function listUsers(claims: AuthClaims, f: UserFilter): Promise<{ rows: UserRow[]; total: number }> {
  return asUser(claims, async (db) => {
    const where = `where ($1 = '' or position(lower($1) in lower(p.full_name || ' ' || u.email)) > 0)
                     and ($2::text is null or u.app_role = $2)
                     and ($3 = 'all' or u.is_active = ($3 = 'active'))`;
    const total = await db.query<{ n: number }>(`select count(*)::int as n from app_users u join people p on p.person_id = u.person_id ${where}`, [
      f.q,
      f.role,
      f.status,
    ]);
    const { rows } = await db.query<UserDbRow>(`${USER_SELECT} ${where} order by lower(p.full_name) limit ${PAGE_SIZE} offset $4`, [
      f.q,
      f.role,
      f.status,
      (f.page - 1) * PAGE_SIZE,
    ]);
    return { rows: rows.map(toUser), total: total.rows[0]?.n ?? 0 };
  });
}

export async function getUser(claims: AuthClaims, userId: string): Promise<UserRow | null> {
  return asUser(claims, async (db) => {
    const { rows } = await db.query<UserDbRow>(`${USER_SELECT} where u.user_id = $1`, [userId]);
    return rows[0] ? toUser(rows[0]) : null;
  });
}

async function saveScope(db: pg.PoolClient, userId: string, scope: Scope[]): Promise<void> {
  await db.query('delete from user_reform_scope where user_id = $1', [userId]);
  for (const s of scope) {
    await db.query('insert into user_reform_scope (user_id, reform_id, can_approve) values ($1, $2, $3)', [userId, s.reformId, s.canApprove]);
  }
}

/** Adds a sign-in account. Someone already on the people list (by email) becomes the account's person. */
export async function createUser(claims: AuthClaims, input: AccessInput): Promise<Result<string>> {
  return attempt(claims, async (db) => {
    const taken = await db.query('select 1 from app_users where email = $1', [input.email]);
    if (taken.rowCount) throw new Error('U08: this email already has an account');
    const existing = await db.query<{ person_id: string }>('select person_id from people where lower(email) = $1', [input.email]);
    let personId = existing.rows[0]?.person_id;
    if (personId) {
      await db.query('update people set full_name = $2, preferred_language = $3, is_active = true, updated_at = now() where person_id = $1', [
        personId,
        input.name,
        input.language,
      ]);
    } else {
      const person = await db.query<{ person_id: string }>(
        'insert into people (full_name, email, preferred_language) values ($1, $2, $3) returning person_id',
        [input.name, input.email, input.language],
      );
      personId = person.rows[0]!.person_id;
    }
    const account = await db.query<{ user_id: string }>(
      'insert into app_users (person_id, email, app_role, invited_at) values ($1, $2, $3, now()) returning user_id',
      [personId, input.email, input.role],
    );
    const userId = account.rows[0]!.user_id;
    await saveScope(db, userId, input.scope);
    return userId;
  });
}

export async function updateUser(claims: AuthClaims, userId: string, input: AccessInput): Promise<Result> {
  return attempt(claims, async (db) => {
    const account = await db.query<{ person_id: string }>(
      'update app_users set email = $2, app_role = $3, updated_at = now() where user_id = $1 returning person_id',
      [userId, input.email, input.role],
    );
    const personId = account.rows[0]?.person_id;
    if (!personId) throw new Error('U06: there is no such account');
    await db.query('update people set full_name = $2, email = $3, preferred_language = $4, updated_at = now() where person_id = $1', [
      personId,
      input.name,
      input.email,
      input.language,
    ]);
    await saveScope(db, userId, input.scope);
    return undefined;
  });
}

export async function setUserActive(claims: AuthClaims, userId: string, active: boolean): Promise<Result> {
  return attempt(claims, async (db) => {
    const done = await db.query('update app_users set is_active = $2, updated_at = now() where user_id = $1', [userId, active]);
    if (!done.rowCount) throw new Error('U06: there is no such account');
    return undefined;
  });
}

/**
 * Resets a lost authenticator app (decision 45). The audit record and the provider call share one
 * transaction: if the provider fails, nothing is recorded. The person sets up a new app at their
 * next sign-in.
 */
export async function resetAuthenticator(claims: AuthClaims, userId: string, admin: AuthAdmin | null): Promise<Result<number>> {
  if (!admin) return { ok: false, code: 'U09' };
  return attempt(claims, async (db) => {
    const { rows } = await db.query<{ auth_user_id: string | null }>('select record_mfa_reset($1) as auth_user_id', [userId]);
    const authUserId = rows[0]?.auth_user_id;
    return authUserId ? admin.removeAuthenticator(authUserId) : 0;
  });
}

// ---------------------------------------------------------------------------
// People who own items but do not sign in (decision 24).
// ---------------------------------------------------------------------------

export type PersonRow = {
  personId: string;
  name: string;
  email: string | null;
  institutionId: string | null;
  institution: string | null;
  roleTitle: string | null;
  language: 'en' | 'fr';
  isActive: boolean;
  items: number;
};

const PERSON_SELECT = `select p.person_id, p.full_name, p.email, p.institution_id, coalesce(i.acronym, i.name) as institution, p.role_title,
       p.preferred_language, p.is_active,
       (select count(*)::int from v_delivery_items d where d.owner_person_id = p.person_id) as items
  from people p left join institutions i on i.institution_id = p.institution_id`;

type PersonDbRow = {
  person_id: string;
  full_name: string;
  email: string | null;
  institution_id: string | null;
  institution: string | null;
  role_title: string | null;
  preferred_language: 'en' | 'fr';
  is_active: boolean;
  items: number;
};
const toPerson = (r: PersonDbRow): PersonRow => ({
  personId: r.person_id,
  name: r.full_name,
  email: r.email,
  institutionId: r.institution_id,
  institution: r.institution,
  roleTitle: r.role_title,
  language: r.preferred_language,
  isActive: r.is_active,
  items: r.items,
});

export async function listPeople(claims: AuthClaims, q: string, page: number): Promise<{ rows: PersonRow[]; total: number }> {
  return asUser(claims, async (db) => {
    const where = `where not exists (select 1 from app_users u where u.person_id = p.person_id)
                     and ($1 = '' or position(lower($1) in lower(p.full_name || ' ' || coalesce(p.email, ''))) > 0)`;
    const total = await db.query<{ n: number }>(`select count(*)::int as n from people p ${where}`, [q]);
    const { rows } = await db.query<PersonDbRow>(`${PERSON_SELECT} ${where} order by lower(p.full_name) limit ${PAGE_SIZE} offset $2`, [
      q,
      (page - 1) * PAGE_SIZE,
    ]);
    return { rows: rows.map(toPerson), total: total.rows[0]?.n ?? 0 };
  });
}

export async function getPerson(claims: AuthClaims, personId: string): Promise<(PersonRow & { hasAccount: boolean }) | null> {
  return asUser(claims, async (db) => {
    const { rows } = await db.query<PersonDbRow & { has_account: boolean }>(
      `${PERSON_SELECT.replace('from people p', ', exists (select 1 from app_users u where u.person_id = p.person_id) as has_account from people p')} where p.person_id = $1`,
      [personId],
    );
    return rows[0] ? { ...toPerson(rows[0]), hasAccount: rows[0].has_account } : null;
  });
}

export async function listInstitutions(claims: AuthClaims): Promise<{ id: string; label: string }[]> {
  return asUser(claims, async (db) => {
    const { rows } = await db.query<{ institution_id: string; label: string }>(
      "select institution_id, coalesce(acronym || ' (' || name || ')', name) as label from institutions order by lower(coalesce(acronym, name))",
    );
    return rows.map((r) => ({ id: r.institution_id, label: r.label }));
  });
}

async function sameName(db: pg.PoolClient, input: PersonInput, except: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    'select 1 from people where person_id is distinct from $3 and (lower(full_name) = lower($1) or ($2::text is not null and lower(email) = $2))',
    [input.name, input.email, except],
  );
  return (rowCount ?? 0) > 0;
}

export async function createPerson(claims: AuthClaims, input: PersonInput): Promise<Result<string>> {
  return attempt(claims, async (db) => {
    if (await sameName(db, input, null)) throw new Error('U08: this name or email is already on the people list');
    const { rows } = await db.query<{ person_id: string }>(
      'insert into people (full_name, email, institution_id, role_title, preferred_language) values ($1, $2, $3, $4, $5) returning person_id',
      [input.name, input.email, input.institutionId, input.roleTitle, input.language],
    );
    return rows[0]!.person_id;
  });
}

export async function updatePerson(claims: AuthClaims, personId: string, input: PersonInput, active: boolean): Promise<Result> {
  return attempt(claims, async (db) => {
    if (await sameName(db, input, personId)) throw new Error('U08: this name or email is already on the people list');
    const done = await db.query(
      `update people set full_name = $2, email = $3, institution_id = $4, role_title = $5, preferred_language = $6, is_active = $7, updated_at = now()
        where person_id = $1 and not exists (select 1 from app_users u where u.person_id = people.person_id)`,
      [personId, input.name, input.email, input.institutionId, input.roleTitle, input.language, active],
    );
    if (!done.rowCount) throw new Error('U06: there is no such person, or they have an account (edit them under users)');
    return undefined;
  });
}

/** Gives someone on the people list a sign-in account. They need an email. */
export async function giveAccess(claims: AuthClaims, personId: string, role: Role, scope: Scope[]): Promise<Result<string>> {
  return attempt(claims, async (db) => {
    const { rows } = await db.query<{ email: string | null }>('select email from people where person_id = $1', [personId]);
    const email = rows[0]?.email;
    if (!email) throw new Error('U06: add an email for this person first');
    const account = await db.query<{ user_id: string }>(
      'insert into app_users (person_id, email, app_role, invited_at) values ($1, $2, $3, now()) returning user_id',
      [personId, normaliseEmail(email), role],
    );
    const userId = account.rows[0]!.user_id;
    await db.query('update people set is_active = true where person_id = $1', [personId]);
    await saveScope(db, userId, scope);
    return userId;
  });
}
