// The real gate on the database: every attempt logged, retries chained, auto-fixes saved, and
// the full chain reject → fix → pass → approve → applied → audit row (docs/03 section 11).
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { GateRefused, runGateForSubmission } from '../../src/lib/gate-server/run';
import { actAs, actAsServer, APPROVE, count, submitDraft, type PayloadRow, type TestUser, withUsers } from './harness';

let client: pg.Client;
let milestone: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  milestone = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' and status not in ('complete', 'cancelled') order by milestone_id limit 1")).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

const update = (fields: Record<string, unknown>): PayloadRow => ({ entity: 'milestone', op: 'update', id: milestone, fields });

// The seeded milestone was due in August and still says "on track" (stale since 29 Jul), so a
// realistic update catches it up: delayed, with a new date and the reason.
const catchUp = { status: 'delayed', forecast_date: '2026-12-15', blocker: 'Waiting for the minister to sign', next_action: 'Send the decree to the minister' };

/** B08: open items need a named owner. Seeded milestones only have owner text, so give this one a person. */
async function giveOwner(owner: TestUser): Promise<void> {
  await actAsServer(client);
  await client.query('update milestones set owner_person_id = $1 where milestone_id = $2', [owner.personId, milestone]);
}

async function gate(submissionId: string, user: TestUser) {
  await actAsServer(client);
  return runGateForSubmission(client, { submissionId, actingUserId: user.userId });
}

describe('the gate on the database', () => {
  it('reject → fix → pass → approve → applied, with every attempt logged and chained', async () => {
    await withUsers(client, async (users) => {
      await giveOwner(users.contributor_ra1);
      const id = await submitDraft(client, users.contributor_ra1, [update({ ...catchUp, status: 'finished' })]);

      const first = await gate(id, users.contributor_ra1);
      expect(first.result).toMatchObject({ outcome: 'reject', rejectReason: 'blocking_rules' });
      expect(first.attemptNo).toBe(1);
      const run1 = await client.query('select attempt_no, previous_run_id, ruleset_version, threshold, outcome, blocking_failures, run_by from dq_runs where dq_run_id = $1', [first.dqRunId]);
      expect(run1.rows[0]).toMatchObject({ attempt_no: 1, previous_run_id: null, ruleset_version: '1.0.0', threshold: '80.0', outcome: 'reject', blocking_failures: 1, run_by: users.contributor_ra1.userId });
      const findings = await client.query<{ rule_id: string; severity: string; field: string; message_en: string; message_fr: string }>(
        'select rule_id, severity, field, message_en, message_fr from dq_findings where dq_run_id = $1',
        [first.dqRunId],
      );
      expect(findings.rows).toEqual([expect.objectContaining({ rule_id: 'B04', severity: 'error', field: 'status' })]);
      expect(findings.rows[0]!.message_fr).toMatch(/^Ligne 1 : « finished »/);
      expect(await count(client, "select * from submissions where submission_id = $1 and status = 'rejected_by_gate'", [id])).toBe(1);

      // The submitter fixes the row and tries again.
      await actAs(client, users.contributor_ra1);
      await client.query("update submissions set payload = $1, status = 'draft' where submission_id = $2", [
        JSON.stringify({ rows: [update(catchUp)] }),
        id,
      ]);
      const second = await gate(id, users.contributor_ra1);
      expect(second.result).toMatchObject({ outcome: 'pass', qualityScore: 100 });
      expect(second.attemptNo).toBe(2);
      const run2 = await client.query('select previous_run_id from dq_runs where dq_run_id = $1', [second.dqRunId]);
      expect(run2.rows[0]!.previous_run_id).toBe(first.dqRunId);
      expect(await count(client, "select * from submissions where submission_id = $1 and status = 'proposed' and dq_run_id = $2", [id, second.dqRunId])).toBe(1);

      await actAs(client, users.lead_ra1);
      await client.query(APPROVE, [id, null, false]);
      await actAsServer(client);
      expect(await count(client, "select * from milestones where milestone_id = $1 and status = 'delayed' and forecast_date = '2026-12-15'", [milestone])).toBe(1);
      expect(await count(client, "select * from audit_log where table_name = 'milestones' and record_id = $1 and submission_id = $2", [milestone, id])).toBe(1);

      // The per-user data quality view sees both attempts.
      const metrics = await client.query('select attempts, first_attempts, first_attempt_passes, rejects from v_dq_user_metrics where user_id = $1', [users.contributor_ra1.userId]);
      expect(metrics.rows[0]).toEqual({ attempts: '2', first_attempts: '1', first_attempt_passes: '0', rejects: '1' });
    });
  });

  it('a resubmission continues the attempt count of the submission it replaces', async () => {
    await withUsers(client, async (users) => {
      await giveOwner(users.contributor_ra1);
      const original = await submitDraft(client, users.contributor_ra1, [update({ ...catchUp, status: 'finished' })]);
      const first = await gate(original, users.contributor_ra1);
      await actAs(client, users.contributor_ra1);
      const { rows } = await client.query<{ submission_id: string }>(
        `insert into submissions (route, submitted_by, payload, previous_submission_id) values ('web_form', $1, $2, $3) returning submission_id`,
        [users.contributor_ra1.userId, JSON.stringify({ rows: [update(catchUp)] }), original],
      );
      const retry = await gate(rows[0]!.submission_id, users.contributor_ra1);
      expect(retry.attemptNo).toBe(2);
      expect((await client.query('select previous_run_id from dq_runs where dq_run_id = $1', [retry.dqRunId])).rows[0]!.previous_run_id).toBe(first.dqRunId);
    });
  });

  it('saves the auto-fixed rows, so approval applies what passed', async () => {
    await withUsers(client, async (users) => {
      await giveOwner(users.contributor_ra1);
      const id = await submitDraft(client, users.contributor_ra1, [{ ...update({ ...catchUp, status: 'Delayed' }), id: ` ${milestone} ` }]);
      const { result } = await gate(id, users.contributor_ra1);
      expect(result.outcome).toBe('pass');
      const saved = await client.query<{ payload: { rows: PayloadRow[] } }>('select payload from submissions where submission_id = $1', [id]);
      expect(saved.rows[0]!.payload.rows[0]).toMatchObject({ id: milestone, fields: { status: 'delayed' } });
      expect(await count(client, "select * from dq_findings f join dq_runs r using (dq_run_id) where r.submission_id = $1 and f.severity = 'fixed'", [id])).toBe(2);
    });
  });

  it('B08 blocks an open seeded milestone until it has a named owner', async () => {
    await withUsers(client, async (users) => {
      const id = await submitDraft(client, users.contributor_ra1, [update({})]);
      const { result } = await gate(id, users.contributor_ra1);
      expect(result.findings.map((f) => f.ruleId)).toContain('B08');
      expect(result.outcome).toBe('reject');
    });
  });

  it('B11 uses the same scope rules as approval', async () => {
    await withUsers(client, async (users) => {
      const ra2 = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA2' order by milestone_id limit 1")).rows[0]!.id;
      const id = await submitDraft(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: ra2, fields: {} }]);
      const { result } = await gate(id, users.contributor_ra1);
      expect(result.findings.find((f) => f.ruleId === 'B11')?.valueSeen).toBe('RA2');
    });
  });

  it('B12 and Q17 read reporting periods and previous approved values from the database', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      const code = (await client.query<{ code: string }>('select indicator_code as code from indicators order by indicator_code limit 1')).rows[0]!.code;
      await client.query(
        "insert into indicator_values (indicator_code, reform_id, period_end, snapshot_type, value, approval_status) values ($1, 'RA1', '2026-09-30', 'Monthly', 10, 'approved')",
        [code],
      );
      const value = (period: string, v: number): PayloadRow => ({
        entity: 'indicator_value',
        op: 'create',
        fields: { indicator_code: code, reform_id: 'RA1', period_end: period, snapshot_type: 'Monthly', value: v, confidence: 'medium', evidence_basis: 'Ministry register' },
      });
      const id = await submitDraft(client, users.merl, [value('2026-06-30', 4), value('2026-10-31', 25)]);
      const { result } = await gate(id, users.merl);
      expect(result.findings.filter((f) => f.ruleId === 'B12').map((f) => f.rowRef)).toEqual([1]);
      expect(result.findings.find((f) => f.ruleId === 'Q17')?.messageEn).toBe('Row 2: the value moved from 10 to 25. Explain the change.');
    });
  });

  it('only the submitter can send their submission through the gate, and only before it is proposed', async () => {
    await withUsers(client, async (users) => {
      await giveOwner(users.contributor_ra1);
      const id = await submitDraft(client, users.contributor_ra1, [update(catchUp)]);
      await expect(gate(id, users.lead_ra1)).rejects.toThrow(GateRefused);
      await gate(id, users.contributor_ra1);
      await expect(gate(id, users.contributor_ra1)).rejects.toThrow(/^W02/);
    });
  });

  it('refuses to run if the current rule set has a rule the code does not implement', async () => {
    await withUsers(client, async (users) => {
      await giveOwner(users.contributor_ra1);
      const id = await submitDraft(client, users.contributor_ra1, [update({})]);
      await actAsServer(client);
      await client.query(
        `update dq_rulesets set rules = jsonb_set(rules, '{rules}', (rules -> 'rules') || '[{"id": "B99", "tier": "blocking", "applies_to": ["milestone"], "field": null, "weight": null, "routes": "all", "auto_fix": null, "message_en": "x", "message_fr": "x"}]'::jsonb)
          where is_current`,
      );
      await expect(gate(id, users.contributor_ra1)).rejects.toThrow(/B99/);
    });
  });
});
