// Shared set-up for the row-level security and approval tests.
// Every test runs inside one transaction that is rolled back, so the users, submissions and
// changes it makes are never kept. Users are switched with `set local role authenticated` and
// JWT claims, the same way Supabase's API sets them for a signed-in request.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { ROOT } from '../../scripts/lib/db';

export const FIXTURE_USERS = {
  super_admin: { role: 'super_admin', scope: [] },
  programme_admin: { role: 'programme_admin', scope: [] },
  programme_admin_2: { role: 'programme_admin', scope: [] },
  lead_ra1: { role: 'reform_lead', scope: [['RA1', true]] },
  lead_ra2: { role: 'reform_lead', scope: [['RA2', true]] },
  contributor_ra1: { role: 'contributor', scope: [['RA1', false]] },
  merl: { role: 'merl_officer', scope: [] },
  viewer: { role: 'viewer_internal', scope: [] },
  counterpart_ra1: { role: 'viewer_counterpart', scope: [['RA1', false]] },
} as const satisfies Record<string, { role: string; scope: readonly (readonly [string, boolean])[] }>;

export type UserKey = keyof typeof FIXTURE_USERS;
export type TestUser = { key: UserKey; userId: string; personId: string; authId: string };
export type Users = Record<UserKey, TestUser>;

export type PayloadRow = {
  entity: string;
  op: 'create' | 'update';
  id?: string;
  fields?: Record<string, unknown>;
  links?: { object_type: string; object_id: string }[];
  base_updated_at?: string;
  on_behalf_of_person_id?: string;
};

export async function inRollback(client: pg.Client, fn: () => Promise<void>): Promise<void> {
  await client.query('begin');
  try {
    await fn();
  } finally {
    await client.query('rollback');
  }
}

// Local Supabase has the API roles; plain Postgres in CI does not. Create any that are missing
// (inside the transaction, so they are rolled back) and give them the grants Supabase gets.
async function setUpApiRoles(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')",
  );
  const have = new Set(rows.map((r) => r.rolname));
  if (!have.has('anon')) await client.query('create role anon nologin');
  if (!have.has('authenticated')) await client.query('create role authenticated nologin');
  if (!have.has('service_role')) await client.query('create role service_role nologin bypassrls');
  await client.query(readFileSync(join(ROOT, 'db/platform/supabase_grants.sql'), 'utf8'));
}

async function createUsers(client: pg.Client): Promise<Users> {
  const users = {} as Users;
  for (const [key, spec] of Object.entries(FIXTURE_USERS) as [UserKey, (typeof FIXTURE_USERS)[UserKey]][]) {
    const authId = randomUUID();
    const person = await client.query<{ person_id: string }>(
      'insert into people (full_name, email) values ($1, $2) returning person_id',
      [`Test user ${key}`, `${key}@test.invalid`],
    );
    const personId = person.rows[0]!.person_id;
    const user = await client.query<{ user_id: string }>(
      'insert into app_users (auth_user_id, person_id, email, app_role) values ($1, $2, $3, $4) returning user_id',
      [authId, personId, `${key}@test.invalid`, spec.role],
    );
    const userId = user.rows[0]!.user_id;
    for (const [reformId, canApprove] of spec.scope) {
      await client.query('insert into user_reform_scope (user_id, reform_id, can_approve) values ($1, $2, $3)', [
        userId,
        reformId,
        canApprove,
      ]);
    }
    users[key] = { key, userId, personId, authId };
  }
  return users;
}

// Runs fn in a rolled-back transaction with the API roles and the fixture users in place.
export async function withUsers(client: pg.Client, fn: (users: Users) => Promise<void>): Promise<void> {
  await inRollback(client, async () => {
    await setUpApiRoles(client);
    await fn(await createUsers(client));
  });
}

// Act as a signed-in person. Pass an auth ID with no account to act as a stranger.
// Sessions are at aal2 (MFA done) unless the test says otherwise; admins need it (0007).
export async function actAs(client: pg.Client, who: TestUser | string, options: { aal?: 'aal1' | 'aal2' } = {}): Promise<void> {
  const sub = typeof who === 'string' ? who : who.authId;
  await client.query('reset role');
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub, role: 'authenticated', aal: options.aal ?? 'aal2' }),
  ]);
  await client.query('set local role authenticated');
}

// Act as the server's own database connection (bypasses row-level security).
export async function actAsServer(client: pg.Client): Promise<void> {
  await client.query('reset role');
  await client.query("select set_config('request.jwt.claims', '', true)");
}

export async function count(client: pg.Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`select count(*) as n from (${sql}) q`, params);
  return Number(rows[0]?.n);
}

// Runs a statement that is expected to fail, inside a savepoint so the test can carry on.
export async function expectFailure(client: pg.Client, sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
  await client.query('savepoint expect_failure');
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query('rollback to savepoint expect_failure');
    return error as pg.DatabaseError;
  }
  await client.query('release savepoint expect_failure');
  throw new Error(`Expected this statement to fail: ${sql}`);
}

// A submitter creates a draft through row-level security, as the app will.
export async function submitDraft(
  client: pg.Client,
  user: TestUser,
  rows: PayloadRow[],
  options: { onBehalfOf?: string } = {},
): Promise<string> {
  await actAs(client, user);
  const route = options.onBehalfOf ? 'on_behalf' : 'web_form';
  // An on-behalf entry records how and when it was received (migration 0011).
  const { rows: inserted } = await client.query<{ submission_id: string }>(
    `insert into submissions (route, submitted_by, on_behalf_of_person_id, entity, payload, on_behalf_channel, on_behalf_received_on)
     values ($1, $2, $3, $4, $5, $6, $7) returning submission_id`,
    [
      route,
      user.userId,
      options.onBehalfOf ?? null,
      rows[0]?.entity ?? null,
      JSON.stringify({ rows }),
      options.onBehalfOf ? 'phone' : null,
      options.onBehalfOf ? '2026-11-02' : null,
    ],
  );
  return inserted[0]!.submission_id;
}

// Stands in for the step 5 gate: records a passing run on the current rule set and proposes it.
export async function passGate(client: pg.Client, submissionId: string, runBy: TestUser, rulesetVersion?: string): Promise<string> {
  await actAsServer(client);
  const { rows } = await client.query<{ dq_run_id: string }>(
    `insert into dq_runs (submission_id, attempt_no, ruleset_version, route, run_by, threshold, outcome, quality_score)
     select $1, 1, coalesce($3, (select ruleset_version from dq_rulesets where is_current)), 'web_form', $2, 80, 'pass', 100
     returning dq_run_id`,
    [submissionId, runBy.userId, rulesetVersion ?? null],
  );
  const runId = rows[0]!.dq_run_id;
  await client.query("update submissions set dq_run_id = $1, status = 'proposed' where submission_id = $2", [runId, submissionId]);
  return runId;
}

export async function propose(client: pg.Client, user: TestUser, rows: PayloadRow[], options: { onBehalfOf?: string } = {}): Promise<string> {
  const id = await submitDraft(client, user, rows, options);
  await passGate(client, id, user);
  return id;
}

// Records a finished upload for this person, as the upload endpoint does (decision 91: a
// submission may only name files its submitter uploaded).
export async function recordUpload(client: pg.Client, user: TestUser, path: string): Promise<string> {
  await actAsServer(client);
  const { rows } = await client.query<{ upload_id: string }>(
    `insert into evidence_uploads (uploaded_by, file_name, file_path, file_sha256, file_mime, file_bytes)
     values ($1, $2, $3, md5($3), 'application/pdf', 10) returning upload_id`,
    [user.userId, path.split('/').pop(), path],
  );
  return rows[0]!.upload_id;
}

export const APPROVE = 'select * from approve_submission($1, $2, $3)';
export const RETURN = 'select * from return_submission($1, $2)';
