// Adds a person and their sign-in account. Used by `npm run users:add` and the end-to-end tests.
// Runs on the server's own database connection; the audit log records the new account.
import type pg from 'pg';

export const ROLES = ['super_admin', 'programme_admin', 'reform_lead', 'contributor', 'merl_officer', 'viewer_internal', 'viewer_counterpart'] as const;
export type Role = (typeof ROLES)[number];

export type NewUser = {
  email: string;
  name: string;
  role: Role;
  language?: 'en' | 'fr';
  /** Reforms the user works on, e.g. ['RA1'], with approval rights where approve is true. */
  scope?: { reformId: string; canApprove: boolean }[];
};

/** Parses "RA1" or "RA1:approve". */
export function parseScope(value: string): { reformId: string; canApprove: boolean } {
  const match = /^(RA[0-9])(:approve)?$/.exec(value.trim());
  if (!match) throw new Error(`Scope "${value}" is not valid. Use a reform ID such as RA1, or RA1:approve.`);
  return { reformId: match[1]!, canApprove: match[2] !== undefined };
}

export async function addUser(client: pg.Client, user: NewUser): Promise<string> {
  const email = user.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`"${user.email}" is not an email address.`);
  if (!ROLES.includes(user.role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
  if (!user.name.trim()) throw new Error('A name is needed.');

  await client.query('begin');
  try {
    const existing = await client.query('select 1 from app_users where lower(email) = $1', [email]);
    if (existing.rowCount) throw new Error(`${email} already has an account.`);
    const person = await client.query<{ person_id: string }>(
      `insert into people (full_name, email, preferred_language) values ($1, $2, $3)
       on conflict (email) do update set full_name = excluded.full_name returning person_id`,
      [user.name.trim(), email, user.language ?? 'en'],
    );
    const account = await client.query<{ user_id: string }>(
      'insert into app_users (person_id, email, app_role, invited_at) values ($1, $2, $3, now()) returning user_id',
      [person.rows[0]!.person_id, email, user.role],
    );
    const userId = account.rows[0]!.user_id;
    for (const scope of user.scope ?? []) {
      await client.query('insert into user_reform_scope (user_id, reform_id, can_approve) values ($1, $2, $3)', [userId, scope.reformId, scope.canApprove]);
    }
    await client.query('commit');
    return userId;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export type NewPerson = { name: string; email?: string; institution?: string; roleTitle?: string; language?: 'en' | 'fr' };

/** Adds someone who owns items but will not sign in (decision 24). Returns the person ID. */
export async function addPerson(client: pg.Client, person: NewPerson): Promise<string> {
  const name = person.name.trim();
  if (!name) throw new Error('A name is needed.');
  const email = person.email?.trim().toLowerCase() || null;
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`"${person.email}" is not an email address.`);
  let institutionId: string | null = null;
  if (person.institution) {
    const found = await client.query<{ institution_id: string }>(
      'select institution_id from institutions where lower(name) = lower($1) or lower(acronym) = lower($1)',
      [person.institution.trim()],
    );
    if (!found.rows[0]) throw new Error(`No institution called "${person.institution}". Check the spelling against the institutions list.`);
    institutionId = found.rows[0].institution_id;
  }
  const same = await client.query('select 1 from people where lower(full_name) = lower($1) or ($2::text is not null and lower(email) = $2)', [name, email]);
  if (same.rowCount) throw new Error(`${name}${email ? ` or ${email}` : ''} is already in the people list.`);
  const { rows } = await client.query<{ person_id: string }>(
    'insert into people (full_name, email, institution_id, role_title, preferred_language) values ($1, $2, $3, $4, $5) returning person_id',
    [name, email, institutionId, person.roleTitle?.trim() || null, person.language ?? 'fr'],
  );
  return rows[0]!.person_id;
}
