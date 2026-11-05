// Scheduled jobs (build step 12, migration 0015, spec 01 section 10). Each job is run for a
// chosen day so the ladder can be walked step by step. Everything is rolled back.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, count, expectFailure, withUsers, type TestUser, type Users } from './harness';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

const D = '2031-03-20';
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function job(name: 'nightly' | 'daily' | 'weekly' | 'month_end', day: string): Promise<Record<string, number>> {
  await actAsServer(client);
  return (await client.query(`select job_${name}($1::date) as c`, [day])).rows[0].c;
}

async function notices(objectId: string, kind?: string): Promise<{ kind: string; person_id: string; detail: Record<string, unknown> | null; for_date: string }[]> {
  await actAsServer(client);
  const { rows } = await client.query(
    "select kind, person_id, detail, to_char(for_date, 'YYYY-MM-DD') as for_date from notification_log where object_id = $1 and ($2::text is null or kind = $2) order by for_date, kind, person_id",
    [objectId, kind ?? null],
  );
  return rows;
}

async function openEscalations(objectId: string): Promise<{ level: number; reason: string }[]> {
  await actAsServer(client);
  return (await client.query('select level, reason from escalations where object_id = $1 and resolved_at is null order by level', [objectId])).rows;
}

/** An RA1 milestone owned by `owner`, due on `due`, confirmed today so it is not stale. */
async function milestone(owner: TestUser | null, due: string, id = 'MS-101'): Promise<string> {
  await actAsServer(client);
  await client.query("update milestones set owner_person_id = $2, planned_date = $3, forecast_date = null, status = 'on_track', last_confirmed_at = $3::date - 1 where milestone_id = $1", [
    id,
    owner?.personId ?? null,
    due,
  ]);
  return id;
}

/** A workstream owned by `lead` with a deliverable owned by `owner`, so the workstream owner is the lead. */
async function deliverable(owner: TestUser, lead: TestUser, due: string): Promise<string> {
  await actAsServer(client);
  await client.query("insert into workstreams (workstream_id, reform_id, name, workstream_type, owner_person_id) values ('WS-RA2-90', 'RA2', 'Test workstream', 'policy', $1)", [lead.personId]);
  await client.query(
    "insert into deliverables (deliverable_id, workstream_id, name, owner_person_id, due_date, status, last_confirmed_at) values ('DL-RA2-901', 'WS-RA2-90', 'Test deliverable', $1, $2, 'on_track', $2::date - 1)",
    [owner.personId, due],
  );
  return 'DL-RA2-901';
}

describe('the escalation ladder (spec 01 section 10)', () => {
  it('reminds 3 days before, then escalates at 1, 7 and 14 days overdue, one step at a time', async () => {
    await withUsers(client, async (users) => {
      const id = await milestone(users.contributor_ra1, D);
      await job('daily', shift(D, -4));
      expect(await notices(id)).toEqual([]);

      await job('daily', shift(D, -3));
      await job('daily', shift(D, -3));
      await job('daily', shift(D, -1));
      expect(await notices(id, 'due_soon')).toEqual([{ kind: 'due_soon', person_id: users.contributor_ra1.personId, detail: { due_date: D }, for_date: shift(D, -3) }]);

      await job('daily', shift(D, 1));
      expect(await openEscalations(id)).toEqual([{ level: 1, reason: 'overdue_1' }]);
      // The owner, and one step up: the RA1 reform lead (milestones have no workstream yet).
      const step1 = await notices(id);
      expect(step1.filter((n) => n.for_date === shift(D, 1)).map((n) => [n.kind, n.person_id])).toEqual([
        ['escalation', users.lead_ra1.personId],
        ['overdue', users.contributor_ra1.personId],
      ]);

      // Nothing new between steps.
      const before = (await notices(id)).length;
      for (const day of [2, 3, 6]) await job('daily', shift(D, day));
      expect((await notices(id)).length).toBe(before);

      await job('daily', shift(D, 7));
      expect(await openEscalations(id)).toEqual([{ level: 2, reason: 'overdue_7' }]);
      await job('daily', shift(D, 14));
      expect(await openEscalations(id)).toEqual([{ level: 3, reason: 'overdue_14' }]);
      expect((await notices(id, 'overdue')).map((n) => n.detail)).toEqual([
        { level: 1, days: 1 },
        { level: 2, days: 7 },
        { level: 3, days: 14 },
      ]);

      // Done: the nightly job resolves it.
      await client.query("update milestones set status = 'complete', actual_date = $2 where milestone_id = $1", [id, shift(D, 15)]);
      expect((await job('nightly', shift(D, 15))).escalations_resolved).toBeGreaterThanOrEqual(1);
      expect(await openEscalations(id)).toEqual([]);
    });
  });

  it('an item already 30 days overdue goes straight to level 3', async () => {
    await withUsers(client, async (users) => {
      const id = await milestone(users.contributor_ra1, shift(D, -30));
      await job('daily', D);
      await actAsServer(client);
      expect((await client.query('select level from escalations where object_id = $1 order by level', [id])).rows).toEqual([{ level: 3 }]);
    });
  });

  it('a new date resolves the escalation; a later slip raises it again', async () => {
    await withUsers(client, async (users) => {
      const id = await milestone(users.contributor_ra1, shift(D, -8));
      await job('daily', D);
      expect(await openEscalations(id)).toEqual([{ level: 2, reason: 'overdue_7' }]);
      await client.query('update milestones set planned_date = $2 where milestone_id = $1', [id, shift(D, 10)]);
      await job('nightly', shift(D, 1));
      expect(await openEscalations(id)).toEqual([]);
      await job('daily', shift(D, 11));
      expect(await openEscalations(id)).toEqual([{ level: 1, reason: 'overdue_1' }]);
    });
  });

  it('one step up is the workstream owner, or programme admins for programme-wide milestones', async () => {
    await withUsers(client, async (users) => {
      const dl = await deliverable(users.contributor_ra1, users.lead_ra2, shift(D, -1));
      await job('daily', D);
      expect((await notices(dl, 'escalation')).map((n) => n.person_id)).toEqual([users.lead_ra2.personId]);

      const programmeWide = (await client.query<{ id: string }>("select milestone_id as id from milestones where scope = 'programme' and status <> 'complete' order by 1 limit 1")).rows[0]!.id;
      await milestone(users.contributor_ra1, shift(D, -1), programmeWide);
      await job('daily', D);
      const leads = (await notices(programmeWide, 'escalation')).map((n) => n.person_id);
      expect(leads).toContain(users.programme_admin.personId);
      expect(leads).toContain(users.programme_admin_2.personId);
      expect(leads).not.toContain(users.lead_ra1.personId);
    });
  });
});

describe('staleness, risks and stages', () => {
  it('stale at 30 days, then weekly', async () => {
    await withUsers(client, async (users) => {
      const id = await milestone(users.contributor_ra1, '2031-12-31');
      await client.query('update milestones set last_confirmed_at = $2 where milestone_id = $1', [id, shift(D, -31)]);
      await job('nightly', D);
      await job('nightly', shift(D, 1));
      await job('nightly', shift(D, 6));
      await job('nightly', shift(D, 7));
      expect((await notices(id, 'stale_item')).map((n) => [n.for_date, n.detail])).toEqual([
        [D, { days: 31 }],
        [shift(D, 7), { days: 38 }],
      ]);
    });
  });

  it('a risk past its review date reminds its owner weekly', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      await client.query("update risks set owner_person_id = $1, review_date = $2, status = 'open' where risk_id = 'RK-001'", [users.merl.personId, shift(D, -1)]);
      await job('daily', D);
      await job('daily', shift(D, 3));
      await job('daily', shift(D, 7));
      expect((await notices('RK-001', 'risk_review')).map((n) => n.for_date)).toEqual([D, shift(D, 7)]);
    });
  });

  it('a stage in progress for two monthly reviews (or 60 days with none recorded) is flagged once', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      await client.query("update reform_stages set status = 'complete', exit_date = entry_date where status in ('in_progress', 'blocked')");
      await client.query("update reform_stages set status = 'in_progress', exit_date = null, entry_date = $2, responsible_person_id = $3 where stage_record_id = $1", [
        'PT-003',
        shift(D, -59),
        users.lead_ra1.personId,
      ]);
      await job('nightly', D);
      expect(await openEscalations('PT-003')).toEqual([]);
      await job('nightly', shift(D, 1));
      expect(await openEscalations('PT-003')).toEqual([{ level: 2, reason: 'pathway_stalled' }]);
      expect((await notices('PT-003', 'pathway_stalled')).map((n) => n.person_id)).toEqual([users.lead_ra1.personId]);

      // Once reviews are recorded, it is two reviews, not 60 days. One review is not enough.
      await client.query("update escalations set resolved_at = now() where object_id = 'PT-003'");
      await client.query("insert into reviews (review_type, review_date) values ('monthly_pillar_review', $1)", [shift(D, -30)]);
      await job('nightly', shift(D, 2));
      expect(await openEscalations('PT-003')).toEqual([]);
      await client.query("insert into reviews (review_type, review_date) values ('monthly_pillar_review', $1)", [shift(D, -1)]);
      await job('nightly', shift(D, 3));
      expect(await openEscalations('PT-003')).toEqual([{ level: 2, reason: 'pathway_stalled' }]);

      // The stage moves on: resolved.
      await client.query("update reform_stages set status = 'complete', exit_date = $1 where stage_record_id = 'PT-003'", [shift(D, 4)]);
      await job('nightly', shift(D, 4));
      expect(await openEscalations('PT-003')).toEqual([]);
    });
  });
});

describe('people without accounts (decision 49)', () => {
  it('their reminders go on a follow-up list for each programme admin', async () => {
    await withUsers(client, async (users: Users) => {
      await actAsServer(client);
      const person = (await client.query<{ person_id: string }>("insert into people (full_name) values ('Ministry focal point') returning person_id")).rows[0]!.person_id;
      await client.query("update milestones set owner_person_id = $1, planned_date = $2, status = 'on_track', last_confirmed_at = $2::date - 1 where milestone_id = 'MS-102'", [
        person,
        shift(D, 2),
      ]);
      await job('daily', D);
      const lists = await notices(D, 'follow_up_list');
      const admins = lists.map((n) => n.person_id);
      expect(admins).toContain(users.programme_admin.personId);
      expect(admins).toContain(users.programme_admin_2.personId);
      expect(admins).not.toContain(users.super_admin.personId);
      expect((lists[0]!.detail as { reminders: number }).reminders).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('weekly digest and month-end snapshot', () => {
  it('a digest notice for each person who owns open items and for each admin, not for viewers', async () => {
    await withUsers(client, async (users) => {
      await milestone(users.contributor_ra1, '2031-12-31');
      await job('weekly', D);
      const to = (await notices(D, 'weekly_digest')).map((n) => n.person_id);
      for (const key of ['contributor_ra1', 'super_admin', 'programme_admin'] as const) expect(to, key).toContain(users[key].personId);
      for (const key of ['viewer', 'counterpart_ra1', 'merl'] as const) expect(to, key).not.toContain(users[key].personId);
      await job('weekly', D);
      expect((await notices(D, 'weekly_digest')).length).toBe(to.length);
    });
  });

  it('freezes one row per reform at a month end, once; refuses a day that is not a month end', async () => {
    await withUsers(client, async () => {
      expect((await job('month_end', '2031-02-28')).snapshots).toBe(3);
      expect((await job('month_end', '2031-02-28')).snapshots).toBe(0);
      expect(await count(client, "select 1 from reform_status_snapshots where snapshot_date = '2031-02-28'")).toBe(3);
      expect((await expectFailure(client, "select job_month_end('2031-02-27')")).message).toMatch(/^J01/);
    });
  });
});

describe('who may run jobs and read their log', () => {
  it('signed-in people cannot run the job functions; only admins read the job log; nobody writes it', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      await client.query("insert into job_runs (job, run_for, triggered_by) values ('daily', '2031-03-20', 'schedule')");
      for (const key of ['super_admin', 'programme_admin', 'lead_ra1', 'contributor_ra1'] as const) {
        await actAs(client, users[key]);
        expect((await expectFailure(client, "select job_daily('2031-03-20')")).message, key).toMatch(/permission denied/);
        expect((await expectFailure(client, "insert into job_runs (job, run_for, triggered_by) values ('daily', '2031-03-21', 'admin')")).message, key).toMatch(
          /row-level security|permission denied/,
        );
      }
      await actAs(client, users.programme_admin);
      expect(await count(client, "select 1 from job_runs where run_for = '2031-03-20'")).toBe(1);
      await actAs(client, users.lead_ra1);
      expect(await count(client, 'select 1 from job_runs')).toBe(0);
    });
  });

  it('each person turns their own daily email on or off', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.contributor_ra1);
      await client.query('select set_my_email_reminders(false)');
      await actAsServer(client);
      expect((await client.query('select email_reminders from people where person_id = $1', [users.contributor_ra1.personId])).rows[0].email_reminders).toBe(false);
      expect((await client.query('select email_reminders from people where person_id = $1', [users.lead_ra1.personId])).rows[0].email_reminders).toBe(true);
    });
  });
});
