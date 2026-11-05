// Review packs (build step 13, migration 0016, decisions 53 to 57). Rolled back.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { buildPackData, preparePack, windowStart } from '../../src/lib/reviews/pack';
import { actAs, actAsServer, count, expectFailure, withUsers } from './harness';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

const REVIEW = '2031-03-20';
// For changes made during the test (stamped now), a review a week from today keeps them in the window.
const NEAR = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

describe('who prepares and reads packs', () => {
  it('admins prepare numbered versions; internal users read; counterparts do not; nobody changes one', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      const v1 = await preparePack(client, users.programme_admin.userId, 'monthly_pillar_review', REVIEW);
      const v2 = await preparePack(client, users.programme_admin.userId, 'monthly_pillar_review', REVIEW);
      const qsr = await preparePack(client, users.programme_admin.userId, 'quarterly_strategy_review', REVIEW);
      expect([v1.version, v2.version, qsr.version]).toEqual([1, 2, 1]);

      for (const key of ['lead_ra1', 'contributor_ra1', 'merl', 'viewer'] as const) {
        await actAs(client, users[key]);
        expect(await count(client, 'select 1 from review_packs where review_date = $1', [REVIEW]), key).toBe(3);
        // Who prepared it is kept with the pack, so readers see it without reading accounts.
        expect((await client.query('select generated_by_name from review_packs where pack_id = $1', [v1.packId])).rows[0].generated_by_name, key).toBe('Test user programme_admin');
      }
      await actAs(client, users.counterpart_ra1);
      expect(await count(client, 'select 1 from review_packs')).toBe(0);

      for (const key of ['lead_ra1', 'viewer'] as const) {
        await actAs(client, users[key]);
        const error = await expectFailure(client, "insert into review_packs (review_type, review_date, window_start, generated_by, data) values ('monthly_pillar_review', $1, now(), $2, '{}')", [
          REVIEW,
          users[key].userId,
        ]);
        expect(error.message, key).toMatch(/row-level security/);
      }
      // An admin cannot prepare one in someone else's name.
      await actAs(client, users.programme_admin);
      const other = await expectFailure(client, "insert into review_packs (review_type, review_date, window_start, generated_by, data) values ('monthly_pillar_review', $1, now(), $2, '{}')", [
        REVIEW,
        users.programme_admin_2.userId,
      ]);
      expect(other.message).toMatch(/row-level security/);

      await actAsServer(client);
      expect((await expectFailure(client, "update review_packs set data = '{}' where pack_id = $1", [v1.packId])).message).toMatch(/^R01/);
      expect((await expectFailure(client, 'delete from review_packs where pack_id = $1', [v1.packId])).message).toMatch(/^R01/);
    });
  });
});

describe('since the last review (decision 56)', () => {
  it('one month before a monthly review, three before a QSR, or since the previous pack of the same type', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      expect(await windowStart(client, 'monthly_pillar_review', REVIEW)).toBe('2031-02-19 23:00:00+00');
      expect(await windowStart(client, 'quarterly_strategy_review', REVIEW)).toBe('2030-12-19 23:00:00+00');
      const earlier = await preparePack(client, users.programme_admin.userId, 'monthly_pillar_review', '2031-02-20');
      const { rows } = await client.query<{ at: string }>('select generated_at::text as at from review_packs where pack_id = $1', [earlier.packId]);
      expect(await windowStart(client, 'monthly_pillar_review', REVIEW)).toBe(rows[0]!.at);
      // A QSR does not count from a monthly pack.
      expect(await windowStart(client, 'quarterly_strategy_review', REVIEW)).toBe('2030-12-19 23:00:00+00');
    });
  });
});

describe('what the pack holds', () => {
  it('reforms and programme-wide milestones apart; overdue items; escalations by review type', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      const programme = (await client.query<{ id: string }>("select milestone_id as id from milestones where scope = 'programme' and status <> 'complete' order by 1 limit 1")).rows[0]!.id;
      await client.query("update milestones set planned_date = current_date - 10, status = 'on_track' where milestone_id = 'MS-101'");
      await client.query("insert into escalations (object_type, object_id, level, reason) values ('milestone', 'MS-101', 2, 'overdue_7'), ('milestone', 'MS-102', 3, 'overdue_14')");

      await actAs(client, users.programme_admin);
      const monthly = await buildPackData(client, 'monthly_pillar_review', REVIEW);
      expect(monthly.prepare.reforms.map((r) => r.reformId)).toEqual(['RA1', 'RA2', 'RA3']);
      expect(monthly.prepare.programme.map((m) => m.objectId)).toContain(programme);
      expect(monthly.prepare.programme.every((m) => m.reformId === null)).toBe(true);
      expect(monthly.review.overdue.find((i) => i.objectId === 'MS-101')).toMatchObject({ reformId: 'RA1', daysOverdue: 10 });
      expect(monthly.review.escalations.map((e) => [e.objectId, e.level])).toEqual(expect.arrayContaining([['MS-102', 3], ['MS-101', 2]]));

      const qsr = await buildPackData(client, 'quarterly_strategy_review', REVIEW);
      expect(qsr.review.escalations.map((e) => e.objectId)).toContain('MS-102');
      expect(qsr.review.escalations.map((e) => e.objectId)).not.toContain('MS-101');
    });
  });

  it('one row per decision, however many reforms it links to; open in Decide, implemented in Track', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      await client.query('delete from decision_links where decision_id = $1', ['DC-002']);
      await client.query("insert into decision_links (decision_id, object_type, object_id) values ('DC-002', 'reform', 'RA1'), ('DC-002', 'reform', 'RA2')");
      // Through the app, so the audit log names who did it; seeded decisions marked implemented do not count.
      await client.query("select set_config('app.actor_user_id', $1, true)", [users.lead_ra1.userId]);
      await client.query("update decisions set status = 'implemented', updated_at = now() where decision_id = 'DC-003'");
      await client.query("select set_config('app.actor_user_id', '', true)");
      await client.query("insert into actions (action_id, source_type, source_id, description, due_date, status) values ('AN-9001', 'decision', 'DC-002', 'Send the note', '2026-10-01', 'open')");

      await actAs(client, users.programme_admin);
      const pack = await buildPackData(client, 'monthly_pillar_review', NEAR);
      const dc2 = pack.decide.open.filter((d) => d.decisionId === 'DC-002');
      expect(dc2).toHaveLength(1);
      expect(dc2[0]!.reforms).toEqual(['RA1', 'RA2']);
      expect(dc2[0]!.followUpOverdue).toBe(true);
      expect(pack.decide.open.map((d) => d.decisionId)).not.toContain('DC-003');
      expect(pack.track.implemented.map((d) => d.decisionId)).toEqual(['DC-003']);
      expect(pack.track.actions).toEqual([expect.objectContaining({ actionId: 'AN-9001', overdue: true, status: 'open' })]);
    });
  });

  it('risk changes made through the app count; the seed load does not', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      const before = await buildPackData(client, 'monthly_pillar_review', NEAR);
      expect(before.review.riskChanges).toEqual([]);

      // As apply_submission does: the change carries its actor.
      await actAsServer(client);
      await client.query("select set_config('app.actor_user_id', $1, true)", [users.programme_admin.userId]);
      await client.query("update risks set likelihood = 1, impact = 2 where risk_id = 'RK-001'");
      await client.query("update risks set status = 'closed' where risk_id = 'RK-002'");
      await client.query("select set_config('app.actor_user_id', '', true)");

      await actAs(client, users.programme_admin);
      const after = await buildPackData(client, 'monthly_pillar_review', NEAR);
      expect(after.review.riskChanges.map((c) => [c.riskId, c.change])).toEqual([
        ['RK-001', 'score'],
        ['RK-002', 'closed'],
      ]);
      expect(after.review.riskChanges[0]!.after.inherent).toBe(2);
      expect(after.review.highRisks.map((k) => k.riskId)).not.toContain('RK-002');
    });
  });

  it('indicators: the latest approved value and the one before; life-of-programme only once confirmed', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      const code = (await client.query<{ code: string }>("select indicator_code as code from indicator_values where reform_id is null order by 1 limit 1")).rows[0]!.code;
      await client.query(
        "insert into indicator_values (indicator_code, reform_id, period_end, snapshot_type, value, approval_status, approved_at) values ($1, null, '2026-09-30', 'Monthly', 7, 'approved', now()), ($1, null, '2026-10-31', 'Monthly', 9, 'proposed', null)",
        [code],
      );
      await client.query('update indicators set target_lop = 50, target_lop_confirmed = false where indicator_code = $1', [code]);

      await actAs(client, users.programme_admin);
      let row = (await buildPackData(client, 'monthly_pillar_review', NEAR)).review.indicators.find((i) => i.code === code && i.reformId === null)!;
      // The proposed October value is not approved, so September is the latest.
      expect(row.latest).toMatchObject({ periodEnd: '2026-09-30', value: 7 });
      expect(row.previous?.periodEnd).toBe('2026-06-30');
      expect(row.newSinceLastReview).toBe(true);
      // Seeded values were loaded, not approved, so they are never "new".
      const seeded = (await buildPackData(client, 'monthly_pillar_review', NEAR)).review.indicators.filter((i) => i.latest.periodEnd === '2026-06-30');
      expect(seeded.length).toBeGreaterThan(0);
      expect(seeded.every((i) => !i.newSinceLastReview)).toBe(true);
      expect(row.targetLop).toBeNull();

      await actAsServer(client);
      await client.query('update indicators set target_lop_confirmed = true where indicator_code = $1', [code]);
      await actAs(client, users.programme_admin);
      row = (await buildPackData(client, 'monthly_pillar_review', NEAR)).review.indicators.find((i) => i.code === code && i.reformId === null)!;
      expect(row.targetLop).toBe(50);
    });
  });
});
