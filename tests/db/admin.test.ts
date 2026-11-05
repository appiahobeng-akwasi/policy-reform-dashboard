// Users and access admin, and the data quality figures (build step 11, migration 0014,
// decisions 42 to 46). Everything runs in a rolled-back transaction.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { buildOwnReport, buildReport, readFilter, type Filter } from '../../src/lib/admin/data-quality';
import { actAs, actAsServer, count, expectFailure, withUsers, type TestUser, type Users } from './harness';

let client: pg.Client;
let ra1: string;
let ra2: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  ra1 = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 1")).rows[0]!.id;
  ra2 = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA2' order by milestone_id limit 1")).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

async function addAccount(role: string): Promise<string> {
  const person = await client.query<{ person_id: string }>("insert into people (full_name, email) values ('New person', $1) returning person_id", [`new-${role}@test.invalid`]);
  const account = await client.query<{ user_id: string }>("insert into app_users (person_id, email, app_role) values ($1, $2, $3) returning user_id", [
    person.rows[0]!.person_id,
    `new-${role}@test.invalid`,
    role,
  ]);
  return account.rows[0]!.user_id;
}

describe('who may manage accounts and people', () => {
  it('a programme admin adds a person and an account, and the audit log names them', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      const userId = await addAccount('contributor');
      await client.query("insert into user_reform_scope (user_id, reform_id, can_approve) values ($1, 'RA1', true)", [userId]);
      await actAsServer(client);
      const actors = await client.query<{ table_name: string; actor_user_id: string }>(
        "select table_name, actor_user_id from audit_log where table_name in ('people', 'app_users', 'user_reform_scope') and (record_id = $1 or after ->> 'email' = 'new-contributor@test.invalid')",
        [userId],
      );
      expect(actors.rows.map((r) => r.table_name).sort()).toEqual(['app_users', 'people', 'user_reform_scope']);
      for (const row of actors.rows) expect(row.actor_user_id).toBe(users.programme_admin.userId);
    });
  });

  it('nobody else may add people, accounts or reforms', async () => {
    await withUsers(client, async (users) => {
      for (const key of ['lead_ra1', 'contributor_ra1', 'merl', 'viewer', 'counterpart_ra1'] as const) {
        await actAs(client, users[key]);
        const error = await expectFailure(client, "insert into people (full_name) values ('Someone')");
        expect(error.message, key).toMatch(/row-level security/);
        const scope = await expectFailure(client, "insert into user_reform_scope (user_id, reform_id) values ($1, 'RA2')", [users[key].userId]);
        expect(scope.message, key).toMatch(/row-level security/);
        expect(await client.query("update app_users set app_role = 'programme_admin' where user_id = $1", [users[key].userId]).then((r) => r.rowCount), key).toBe(0);
      }
    });
  });

  it('only a super administrator creates or changes a super administrator (U02)', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      const person = await client.query<{ person_id: string }>("insert into people (full_name, email) values ('Super', 'super-new@test.invalid') returning person_id");
      const create = await expectFailure(client, "insert into app_users (person_id, email, app_role) values ($1, 'super-new@test.invalid', 'super_admin')", [person.rows[0]!.person_id]);
      expect(create.message).toMatch(/^U02/);
      for (const sql of ["update app_users set app_role = 'programme_admin' where user_id = $1", 'update app_users set is_active = false where user_id = $1']) {
        expect((await expectFailure(client, sql, [users.super_admin.userId])).message).toMatch(/^U02/);
      }
      const scope = await expectFailure(client, "insert into user_reform_scope (user_id, reform_id) values ($1, 'RA1')", [users.super_admin.userId]);
      expect(scope.message).toMatch(/row-level security/);
      // A programme admin may promote someone to programme admin (spec 01 section 3).
      expect((await client.query("update app_users set app_role = 'programme_admin' where user_id = $1", [users.lead_ra1.userId])).rowCount).toBe(1);

      await actAs(client, users.super_admin);
      expect((await client.query("update app_users set app_role = 'super_admin' where user_id = $1", [users.programme_admin_2.userId])).rowCount).toBe(1);
    });
  });

  it('nobody changes their own role or turns off their own account (U01)', async () => {
    await withUsers(client, async (users) => {
      for (const key of ['super_admin', 'programme_admin'] as const) {
        await actAs(client, users[key]);
        expect((await expectFailure(client, "update app_users set app_role = 'viewer_internal' where user_id = $1", [users[key].userId])).message).toMatch(/^U01/);
        expect((await expectFailure(client, 'update app_users set is_active = false where user_id = $1', [users[key].userId])).message).toMatch(/^U01/);
        // Their own name and language are fine.
        expect((await client.query("update people set preferred_language = 'fr' where person_id = $1", [users[key].personId])).rowCount).toBe(1);
      }
    });
  });

  it('accounts are turned off, not deleted; the sign-in link is not set by hand (U03, U04)', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      expect((await expectFailure(client, 'delete from app_users where user_id = $1', [users.contributor_ra1.userId])).message).toMatch(/^U04/);
      expect((await expectFailure(client, 'update app_users set auth_user_id = gen_random_uuid() where user_id = $1', [users.contributor_ra1.userId])).message).toMatch(/^U03/);
      expect((await client.query('update app_users set is_active = false where user_id = $1', [users.contributor_ra1.userId])).rowCount).toBe(1);
      // A turned-off account is not signed in any more (me() is empty).
      await actAs(client, users.contributor_ra1);
      expect((await client.query('select (me()).user_id as id')).rows[0].id).toBeNull();
    });
  });

  it('a new email address unlinks the old sign-in identity, so only the new address can sign in', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      await client.query("update app_users set email = ' New.Address@Test.invalid ' where user_id = $1", [users.contributor_ra1.userId]);
      await actAsServer(client);
      const row = await client.query<{ email: string; auth_user_id: string | null }>('select email, auth_user_id from app_users where user_id = $1', [users.contributor_ra1.userId]);
      expect(row.rows[0]).toEqual({ email: 'new.address@test.invalid', auth_user_id: null });
    });
  });

  it('there is always one active super administrator, even for the server (U05)', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      await client.query("update app_users set is_active = false where app_role = 'super_admin' and user_id <> $1", [users.super_admin.userId]);
      const error = await expectFailure(client, 'update app_users set is_active = false where user_id = $1', [users.super_admin.userId]);
      expect(error.message).toMatch(/^U05/);
      await addAccount('super_admin');
      expect((await client.query('update app_users set is_active = false where user_id = $1', [users.super_admin.userId])).rowCount).toBe(1);
    });
  });
});

describe('resetting an authenticator app', () => {
  it('super administrators only, never their own, and it is recorded', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      expect((await expectFailure(client, 'select record_mfa_reset($1)', [users.programme_admin_2.userId])).message).toMatch(/^U02/);
      await actAs(client, users.super_admin);
      expect((await expectFailure(client, 'select record_mfa_reset($1)', [users.super_admin.userId])).message).toMatch(/^U01/);
      const { rows } = await client.query<{ id: string }>('select record_mfa_reset($1) as id', [users.programme_admin.userId]);
      expect(rows[0]!.id).toBe(users.programme_admin.authId);
      await actAsServer(client);
      expect(
        await count(client, "select 1 from audit_log where table_name = 'authenticator_app' and record_id = $1 and actor_user_id = $2", [
          users.programme_admin.userId,
          users.super_admin.userId,
        ]),
      ).toBe(1);
    });
  });
});

describe('training notices', () => {
  it('admins send one a day, naming one to three rules; nobody else can', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, "select send_training_notice($1, '{B04}')", [users.contributor_ra1.userId])).message).toMatch(/^U02/);
      await actAs(client, users.programme_admin);
      expect((await expectFailure(client, "select send_training_notice($1, '{B04,B08,Q01,Q02}')", [users.contributor_ra1.userId])).message).toMatch(/^U07/);
      expect((await expectFailure(client, "select send_training_notice($1, '{drop}')", [users.contributor_ra1.userId])).message).toMatch(/^U07/);
      expect((await client.query("select send_training_notice($1, '{B04,B08}') as sent", [users.contributor_ra1.userId])).rows[0].sent).toBe(true);
      expect((await client.query("select send_training_notice($1, '{B04,B08}') as sent", [users.contributor_ra1.userId])).rows[0].sent).toBe(false);
      await actAs(client, users.contributor_ra1);
      const mine = await client.query("select object_id from notification_log where kind = 'training_suggested' and person_id = (me()).person_id");
      expect(mine.rows).toEqual([{ object_id: 'B04,B08' }]);
    });
  });
});

// ---------------------------------------------------------------------------
// The figures, on fixed data in 2031 so nothing else in the database is counted.
// ---------------------------------------------------------------------------
const NOW = new Date('2031-06-15T12:00:00Z');
const ALL: Filter = { period: 'last3', route: null, reform: null, userId: null };

type Run = { user: TestUser; milestone: string; at: string; outcomes: ('pass' | 'reject')[]; failed?: string[][] };

/** One submission and its chain of attempts, an hour apart unless the gap says otherwise. */
async function addChain(run: Run, gapHours = 4): Promise<string> {
  await actAsServer(client);
  const sub = await client.query<{ submission_id: string }>(
    "insert into submissions (route, submitted_by, entity, payload, status) values ('web_form', $1, 'milestone', $2, 'proposed') returning submission_id",
    [run.user.userId, JSON.stringify({ rows: [{ entity: 'milestone', op: 'update', id: run.milestone, fields: { comments: 'x' } }] })],
  );
  const submissionId = sub.rows[0]!.submission_id;
  let previous: string | null = null;
  for (const [i, outcome] of run.outcomes.entries()) {
    const at = new Date(new Date(run.at).getTime() + i * gapHours * 3_600_000).toISOString();
    const inserted: pg.QueryResult<{ dq_run_id: string }> = await client.query(
      `insert into dq_runs (submission_id, attempt_no, previous_run_id, ruleset_version, route, run_by, started_at, threshold, outcome, quality_score, reject_reason)
       select $1, $2, $3, (select ruleset_version from dq_rulesets where is_current), 'web_form', $4, $5, 80, $6, $7, $8 returning dq_run_id`,
      [submissionId, i + 1, previous, run.user.userId, at, outcome, outcome === 'pass' ? 90 : 60, outcome === 'pass' ? null : 'blocking_rules'],
    );
    previous = inserted.rows[0]!.dq_run_id;
    for (const rule of run.failed?.[i] ?? []) {
      await client.query(
        "insert into dq_findings (dq_run_id, rule_id, tier, severity, message_en, message_fr) values ($1, $2, 'blocking', 'error', $3, $3)",
        [previous, rule, `Row 2: example for ${rule}.`],
      );
    }
  }
  return submissionId;
}

async function fixture(users: Users): Promise<void> {
  const a = users.contributor_ra1;
  // Five first attempts, two pass: 40% first time, under 60%, so training is suggested.
  await addChain({ user: a, milestone: ra1, at: '2031-06-01T08:00:00Z', outcomes: ['reject', 'pass'], failed: [['B04', 'B08']] });
  await addChain({ user: a, milestone: ra1, at: '2031-06-02T08:00:00Z', outcomes: ['reject'], failed: [['B04']] });
  await addChain({ user: a, milestone: ra1, at: '2031-06-03T08:00:00Z', outcomes: ['reject'], failed: [['B04']] });
  await addChain({ user: a, milestone: ra1, at: '2031-06-04T08:00:00Z', outcomes: ['pass'] });
  await addChain({ user: a, milestone: ra1, at: '2031-06-05T08:00:00Z', outcomes: ['pass'] });
  // Someone else, all passes; one in May on RA2.
  await addChain({ user: users.lead_ra1, milestone: ra1, at: '2031-06-06T08:00:00Z', outcomes: ['pass'] });
  await addChain({ user: users.lead_ra1, milestone: ra2, at: '2031-05-20T08:00:00Z', outcomes: ['pass'] });
}

describe('data quality figures (docs/03 section 7)', () => {
  it('headline, people, rules, time to fix and attempts for an admin', async () => {
    await withUsers(client, async (users) => {
      await fixture(users);
      await actAs(client, users.programme_admin);
      const report = await buildReport(client, ALL, 1, NOW);

      // 8 attempts; 7 first attempts of which 4 passed (57.1%); 3 rejects at 60 and 5 passes at 90 average 78.75.
      expect(report.headline).toEqual({ attempts: 8, firstAttempts: 7, firstTimePassRate: 57.1, averageScore: 78.8, rejects: 3 });
      // Listed by name, not by score.
      expect(report.people.map((p) => p.name)).toEqual(['Test user contributor_ra1', 'Test user lead_ra1']);
      expect(report.people[0]).toMatchObject({ attempts: 6, firstAttempts: 5, firstTimePassRate: 40, rejects: 3 });

      // B04 failed for one of the two people active in June: 50%, over 30%, so review the rule first.
      const june = report.rules.filter((r) => r.month === '2031-06');
      expect(june[0]).toMatchObject({ ruleId: 'B04', failures: 3, usersAffected: 1, pctOfActiveUsers: 50, exampleEn: 'Row 2: example for B04.' });
      expect(june.map((r) => r.ruleId)).toEqual(['B04', 'B08']);

      // 7 chains: one fixed after 4 hours, two not passed yet, 8 attempts over 7 chains.
      expect(report.timeToFix).toEqual({ chains: 7, fixed: 1, notYetFixed: 2, medianHours: 4, averageAttempts: 1.1 });

      expect(report.attempts.total).toBe(8);
      expect(report.attempts.rows[0]).toMatchObject({ name: 'Test user lead_ra1', outcome: 'pass', attemptNo: 1 });

      expect(report.trend.map((t) => t.month)).toEqual(['2031-05-01', '2031-06-01']);
      expect(report.trend[1]).toMatchObject({ runs: 7, passRate: 50 });
    });
  });

  it('training is suggested under 60% over the last five submissions, with the top three rules', async () => {
    await withUsers(client, async (users) => {
      await fixture(users);
      await actAs(client, users.programme_admin);
      const flags = (await buildReport(client, ALL, 1, NOW)).training;
      const flag = flags.find((f) => f.userId === users.contributor_ra1.userId);
      expect(flag).toMatchObject({ passes: 2, topRules: ['B04', 'B08'], lastNoticeAt: null });
      expect(flags.find((f) => f.userId === users.lead_ra1.userId)).toBeUndefined();
    });
  });

  it('filters by month, route, reform and person', async () => {
    await withUsers(client, async (users) => {
      await fixture(users);
      await actAs(client, users.programme_admin);
      const attempts = async (filter: Partial<Filter>) => (await buildReport(client, { ...ALL, ...filter }, 1, NOW)).headline.attempts;
      expect(await attempts({ period: '2031-05' })).toBe(1);
      expect(await attempts({ period: '2031-06' })).toBe(7);
      expect(await attempts({ reform: 'RA2' })).toBe(1);
      expect(await attempts({ reform: 'RA1' })).toBe(7);
      expect(await attempts({ route: 'bulk_upload' })).toBe(0);
      expect(await attempts({ userId: users.lead_ra1.userId })).toBe(2);
    });
  });

  it('per-person figures are private: everyone else sees only their own runs', async () => {
    await withUsers(client, async (users) => {
      await fixture(users);
      for (const [key, expected] of [
        ['contributor_ra1', 6],
        ['lead_ra1', 2],
        ['merl', 0],
        ['viewer', 0],
      ] as const) {
        await actAs(client, users[key]);
        const report = await buildReport(client, ALL, 1, NOW);
        expect(report.headline.attempts, key).toBe(expected);
        expect(new Set(report.people.map((p) => p.userId)).size, key).toBeLessThanOrEqual(1);
      }
      await actAs(client, users.contributor_ra1);
      const own = await buildOwnReport(client, users.contributor_ra1.userId, ALL, 1, NOW);
      expect(own.headline.firstTimePassRate).toBe(40);
      expect(own.training).toMatchObject({ passes: 2, topRules: ['B04', 'B08'] });
    });
  });
});

describe('reading the filter', () => {
  it('keeps valid values and drops anything else', () => {
    const read = (q: string) => readFilter(new URLSearchParams(q), ['RA1', 'RA2', 'RA3']);
    expect(read('')).toEqual(ALL);
    expect(read('period=2031-05&route=bulk_upload&reform=RA2&user=00000000-0000-0000-0000-000000000000')).toEqual({
      period: '2031-05',
      route: 'bulk_upload',
      reform: 'RA2',
      userId: '00000000-0000-0000-0000-000000000000',
    });
    expect(read("period=2031-13&route=x&reform=RA9&user=1' or 1=1")).toEqual(ALL);
  });
});
