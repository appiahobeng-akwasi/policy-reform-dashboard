// Row-level security, one or more tests per role (CLAUDE.md non-negotiables 1, 2 and 5).
// The database decides who sees and changes what; these tests act as each role through the
// same database role and JWT claims that Supabase's API uses.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, count, expectFailure, propose, submitDraft, type UserKey, withUsers } from './harness';

let client: pg.Client;
let ra1Milestone: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  const { rows } = await client.query<{ milestone_id: string }>(
    "select milestone_id from milestones where reform_id = 'RA1' order by milestone_id limit 1",
  );
  ra1Milestone = rows[0]!.milestone_id;
});

afterAll(async () => {
  await client?.end();
});

const INTERNAL: UserKey[] = ['super_admin', 'programme_admin', 'lead_ra1', 'contributor_ra1', 'merl', 'viewer'];
const NOT_SUPER: UserKey[] = ['programme_admin', 'lead_ra1', 'contributor_ra1', 'merl', 'viewer', 'counterpart_ra1'];

describe('reading', () => {
  it('a signed-in person with no account sees nothing', async () => {
    await withUsers(client, async () => {
      await actAs(client, randomUUID());
      for (const sql of ['select * from reforms', 'select * from milestones', 'select * from lookup_values', 'select * from v_reform_summary', 'select * from v_delivery_items', 'select * from submission_entities']) {
        expect(await count(client, sql), sql).toBe(0);
      }
    });
  });

  it.each(INTERNAL)('%s reads every reform, risk and decision', async (key) => {
    await withUsers(client, async (users) => {
      await actAs(client, users[key]);
      expect(await count(client, 'select * from reforms')).toBe(3);
      expect(await count(client, 'select * from risks')).toBe(14);
      expect(await count(client, 'select * from decisions')).toBe(6);
      const { rows } = await client.query<{ risks_open: string | null }>('select risks_open from v_reform_summary');
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.risks_open !== null)).toBe(true);
    });
  });

  it('a counterpart sees only their reform, and no risks, decisions, readiness or RACI', async () => {
    await withUsers(client, async (users) => {
      const expectedMilestones = await count(client, "select * from milestones where reform_id = 'RA1' or scope = 'programme'");
      await actAs(client, users.counterpart_ra1);
      const reforms = await client.query<{ reform_id: string }>('select reform_id from reforms');
      expect(reforms.rows.map((r) => r.reform_id)).toEqual(['RA1']);
      for (const table of ['risks', 'risk_links', 'decisions', 'adaptations', 'readiness_assessments', 'governance_raci', 'submissions']) {
        expect(await count(client, `select * from ${table}`), table).toBe(0);
      }
      expect(await count(client, 'select * from milestones')).toBe(expectedMilestones);
      expect(await count(client, "select * from evidence_items where access_level not in ('external', 'public')")).toBe(0);
      const summary = await client.query<{ reform_id: string; risks_open: string | null; decisions_open: string | null }>(
        'select reform_id, risks_open, decisions_open from v_reform_summary',
      );
      expect(summary.rows).toEqual([{ reform_id: 'RA1', risks_open: null, decisions_open: null }]);
    });
  });

  it('only admins read the audit log', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      expect(await count(client, 'select * from audit_log')).toBeGreaterThan(0);
      for (const key of ['lead_ra1', 'contributor_ra1', 'merl', 'viewer', 'counterpart_ra1'] as const) {
        await actAs(client, users[key]);
        expect(await count(client, 'select * from audit_log'), key).toBe(0);
      }
    });
  });

  it('people see only their own account; admins see every account', async () => {
    await withUsers(client, async (users) => {
      for (const key of ['lead_ra1', 'contributor_ra1', 'merl', 'viewer', 'counterpart_ra1'] as const) {
        await actAs(client, users[key]);
        const { rows } = await client.query<{ user_id: string }>('select user_id from app_users');
        expect(rows.map((r) => r.user_id), key).toEqual([users[key].userId]);
      }
      // Every account, including any added outside the fixtures (such as the local super admin).
      await actAsServer(client);
      const all = await count(client, 'select * from app_users');
      expect(all).toBeGreaterThanOrEqual(9);
      await actAs(client, users.programme_admin);
      expect(await count(client, 'select * from app_users')).toBe(all);
    });
  });
});

describe('writing', () => {
  it.each(NOT_SUPER)('%s cannot change a live table directly', async (key) => {
    await withUsers(client, async (users) => {
      await actAs(client, users[key]);
      const updated = await client.query('update milestones set name = name');
      expect(updated.rowCount).toBe(0);
      const error = await expectFailure(
        client,
        "insert into risks (risk_id, category, description) values ('RK-999', 'political', 'Direct write attempt')",
      );
      expect(error.code).toBe('42501');
    });
  });

  it('super_admin can write directly, and the change is in the audit log', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.super_admin);
      const updated = await client.query('update milestones set name = name where milestone_id = $1', [ra1Milestone]);
      expect(updated.rowCount).toBe(1);
      await actAsServer(client);
      expect(await count(client, "select * from audit_log where table_name = 'milestones' and record_id = $1 and action = 'update'", [ra1Milestone])).toBe(1);
    });
  });

  it.each(['programme_admin', 'lead_ra1', 'contributor_ra1', 'merl'] as const)('%s can create a draft submission', async (key) => {
    await withUsers(client, async (users) => {
      const id = await submitDraft(client, users[key], [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: {} }]);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it.each(['viewer', 'counterpart_ra1'] as const)('%s cannot create a submission', async (key) => {
    await withUsers(client, async (users) => {
      await actAs(client, users[key]);
      const error = await expectFailure(
        client,
        "insert into submissions (route, submitted_by, payload) values ('web_form', $1, '{\"rows\": []}')",
        [users[key].userId],
      );
      expect(error.code).toBe('42501');
    });
  });

  it('nobody can submit in someone else\'s name', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.contributor_ra1);
      const error = await expectFailure(
        client,
        "insert into submissions (route, submitted_by, payload) values ('web_form', $1, '{\"rows\": []}')",
        [users.lead_ra1.userId],
      );
      expect(error.code).toBe('42501');
    });
  });

  it('a new submission must start as a draft', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.contributor_ra1);
      const error = await expectFailure(
        client,
        "insert into submissions (route, submitted_by, payload, status) values ('web_form', $1, '{\"rows\": []}', 'proposed')",
        [users.contributor_ra1.userId],
      );
      expect(error.message).toMatch(/^W09/);
    });
  });

  it('a submitter cannot change who submitted it or set the reforms it touches', async () => {
    await withUsers(client, async (users) => {
      const id = await submitDraft(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: {} }]);
      const error = await expectFailure(client, 'update submissions set submitted_by = $1 where submission_id = $2', [users.lead_ra2.userId, id]);
      expect(error.message).toMatch(/^W09/);
      await client.query("update submissions set reform_ids = '{RA2}' where submission_id = $1", [id]);
      const { rows } = await client.query<{ reform_ids: string[] }>('select reform_ids from submissions where submission_id = $1', [id]);
      expect(rows[0]!.reform_ids).toEqual(['RA1']);
    });
  });
});

describe('who sees which submissions (decisions 14 and 15)', () => {
  it('reform leads see their own reforms only; MERL sees indicator values; admins see all', async () => {
    await withUsers(client, async (users) => {
      const { rows } = await client.query<{ indicator_code: string }>('select indicator_code from indicators order by indicator_code limit 1');
      const milestoneSub = await submitDraft(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: {} }]);
      const valueSub = await submitDraft(client, users.programme_admin, [
        { entity: 'indicator_value', op: 'create', fields: { indicator_code: rows[0]!.indicator_code, reform_id: 'RA3', period_end: '2026-09-30', value: 1 } },
      ]);
      const visible = async (key: UserKey) => {
        await actAs(client, users[key]);
        const result = await client.query<{ submission_id: string }>('select submission_id from submissions order by submission_id');
        return result.rows.map((r) => r.submission_id).sort();
      };
      expect(await visible('lead_ra1')).toEqual([milestoneSub]);
      expect(await visible('lead_ra2')).toEqual([]);
      expect(await visible('merl')).toEqual([valueSub]);
      expect(await visible('contributor_ra1')).toEqual([milestoneSub]);
      expect(await visible('programme_admin')).toEqual([milestoneSub, valueSub].sort());
      expect(await visible('viewer')).toEqual([]);
    });
  });
});

describe('data quality privacy (CLAUDE.md non-negotiable 5)', () => {
  it('each person sees only their own gate runs and findings; admins see everyone\'s', async () => {
    await withUsers(client, async (users) => {
      const a = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: {} }]);
      const b = await propose(client, users.lead_ra1, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: {} }]);
      await client.query(
        `insert into dq_findings (dq_run_id, rule_id, tier, severity, message_en, message_fr)
         select dq_run_id, 'Q01', 'scored', 'warning', 'Test finding', 'Constat de test' from dq_runs where submission_id in ($1, $2)`,
        [a, b],
      );
      const seen = async (key: UserKey) => {
        await actAs(client, users[key]);
        return {
          runs: await count(client, 'select * from dq_runs'),
          findings: await count(client, 'select * from dq_findings'),
          metrics: await count(client, 'select * from v_dq_user_metrics'),
        };
      };
      expect(await seen('contributor_ra1')).toEqual({ runs: 1, findings: 1, metrics: 1 });
      expect(await seen('lead_ra1')).toEqual({ runs: 1, findings: 1, metrics: 1 });
      expect(await seen('merl')).toEqual({ runs: 0, findings: 0, metrics: 0 });
      expect(await seen('viewer')).toEqual({ runs: 0, findings: 0, metrics: 0 });
      expect(await seen('programme_admin')).toEqual({ runs: 2, findings: 2, metrics: 2 });
    });
  });
});

describe('internal functions', () => {
  it('signed-in people cannot call internal functions', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      for (const sql of [
        "select is_allowed_email('someone@example.org')",
        `select apply_submission('${randomUUID()}', '${randomUUID()}')`,
        "select object_reforms('risk', 'RK-001')",
      ]) {
        const error = await expectFailure(client, sql);
        expect(error.code, sql).toBe('42501');
      }
    });
  });

  it('signed-out visitors cannot probe the sign-in allowlist', async () => {
    await withUsers(client, async () => {
      await client.query('set local role anon');
      const error = await expectFailure(client, "select is_allowed_email('someone@example.org')");
      expect(error.code).toBe('42501');
    });
  });

  it('a stranger can call approve_submission but is refused', async () => {
    await withUsers(client, async () => {
      await actAs(client, randomUUID());
      const error = await expectFailure(client, 'select approve_submission($1)', [randomUUID()]);
      expect(error.message).toMatch(/^W05/);
    });
  });
});
