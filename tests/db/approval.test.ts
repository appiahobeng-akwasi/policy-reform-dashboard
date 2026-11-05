// The submit → gate → approve → apply chain (docs/03 sections 6 and 11, docs/01 section 7).
// The gate itself is built in step 5; passGate() stands in for it here.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import {
  actAs,
  actAsServer,
  APPROVE,
  count,
  expectFailure,
  passGate,
  propose,
  RETURN,
  submitDraft,
  type PayloadRow,
  withUsers,
} from './harness';

let client: pg.Client;
let ra1Milestone: string;
let ra2Milestone: string;
let programmeMilestone: string;
let indicator: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  const pick = async (sql: string) => (await client.query<{ id: string }>(sql)).rows[0]!.id;
  ra1Milestone = await pick("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 1");
  ra2Milestone = await pick("select milestone_id as id from milestones where reform_id = 'RA2' order by milestone_id limit 1");
  programmeMilestone = await pick("select milestone_id as id from milestones where scope = 'programme' order by milestone_id limit 1");
  indicator = await pick('select indicator_code as id from indicators order by indicator_code limit 1');
});

afterAll(async () => {
  await client?.end();
});

const milestoneUpdate = (id: string, fields: Record<string, unknown> = {}): PayloadRow => ({ entity: 'milestone', op: 'update', id, fields });
const indicatorValue = (reformId: string, periodEnd = '2026-09-30'): PayloadRow => ({
  entity: 'indicator_value',
  op: 'create',
  fields: { indicator_code: indicator, reform_id: reformId, period_end: periodEnd, snapshot_type: 'Monthly', value: 5, evidence_basis: 'Test value' },
});

describe('the full chain', () => {
  it('submit → gate → approve → applied, with audit rows and a notice to the submitter', async () => {
    await withUsers(client, async (users) => {
      const before = (await client.query<{ status: string }>('select status from milestones where milestone_id = $1', [ra1Milestone])).rows[0]!;

      const id = await submitDraft(client, users.contributor_ra1, [
        milestoneUpdate(ra1Milestone, { status: 'on_track', next_action: 'Send the draft decree to the minister' }),
      ]);
      const draft = await client.query<{ status: string; reform_ids: string[]; entities: string[] }>(
        'select status, reform_ids, entities from submissions where submission_id = $1',
        [id],
      );
      expect(draft.rows[0]).toEqual({ status: 'draft', reform_ids: ['RA1'], entities: ['milestone'] });

      await passGate(client, id, users.contributor_ra1);
      await actAs(client, users.lead_ra1);
      const approved = await client.query<{ status: string; reviewer: string }>(APPROVE, [id, 'Looks right', false]);
      expect(approved.rows[0]).toMatchObject({ status: 'applied', reviewer: users.lead_ra1.userId });

      await actAsServer(client);
      const live = await client.query<{ status: string; next_action: string; updated_by: string; fresh: boolean }>(
        "select status, next_action, updated_by, last_confirmed_at > now() - interval '1 minute' as fresh from milestones where milestone_id = $1",
        [ra1Milestone],
      );
      expect(live.rows[0]).toEqual({
        status: 'on_track',
        next_action: 'Send the draft decree to the minister',
        updated_by: users.contributor_ra1.userId,
        fresh: true,
      });

      const audit = await client.query<{ actor_user_id: string; submission_id: string; before_status: string; after_status: string }>(
        `select actor_user_id, submission_id, before ->> 'status' as before_status, after ->> 'status' as after_status
           from audit_log where table_name = 'milestones' and record_id = $1 and action = 'update'`,
        [ra1Milestone],
      );
      expect(audit.rows).toEqual([
        { actor_user_id: users.contributor_ra1.userId, submission_id: id, before_status: before.status, after_status: 'on_track' },
      ]);

      const approval = await client.query<{ actor_user_id: string }>(
        "select actor_user_id from audit_log where table_name = 'submissions' and record_id = $1 and after ->> 'status' = 'applied'",
        [id],
      );
      expect(approval.rows).toEqual([{ actor_user_id: users.lead_ra1.userId }]);

      expect(
        await count(client, "select * from notification_log where kind = 'submission_approved' and person_id = $1 and object_id = $2 and status = 'queued'", [
          users.contributor_ra1.personId,
          id,
        ]),
      ).toBe(1);

      await actAs(client, users.viewer);
      const view = await client.query<{ status: string }>("select status from v_delivery_items where object_type = 'milestone' and object_id = $1", [ra1Milestone]);
      expect(view.rows[0]!.status).toBe('on_track');
    });
  });

  it('a "nothing changed" confirmation only refreshes last_confirmed_at', async () => {
    await withUsers(client, async (users) => {
      const before = (await client.query('select name, status, next_action from milestones where milestone_id = $1', [ra1Milestone])).rows[0];
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.lead_ra1);
      await client.query(APPROVE, [id, null, false]);
      await actAsServer(client);
      const after = await client.query("select name, status, next_action, last_confirmed_at > now() - interval '1 minute' as fresh from milestones where milestone_id = $1", [ra1Milestone]);
      expect(after.rows[0]).toEqual({ ...before, fresh: true });
    });
  });

  it('creates new items, assigns IDs and lets a later row refer to an earlier one', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [
        { entity: 'workstream', op: 'create', fields: { reform_id: 'RA1', name: 'Land registry reform workstream', workstream_type: 'policy' } },
        { entity: 'deliverable', op: 'create', fields: { workstream_id: 'WS-RA1-01', name: 'Draft decree on land registration' } },
        {
          entity: 'risk',
          op: 'create',
          fields: { category: 'political', description: 'Test risk created through the workflow', likelihood: 3, impact: 4 },
          links: [{ object_type: 'reform', object_id: 'RA1' }],
        },
      ]);
      await actAs(client, users.lead_ra1);
      await client.query(APPROVE, [id, null, false]);
      await actAsServer(client);
      expect(await count(client, "select * from workstreams where workstream_id = 'WS-RA1-01' and reform_id = 'RA1'")).toBe(1);
      expect(await count(client, "select * from deliverables where deliverable_id = 'DL-RA1-001' and workstream_id = 'WS-RA1-01'")).toBe(1);
      const risk = await client.query<{ risk_id: string; updated_by: string }>(
        "select risk_id, updated_by from risks where description = 'Test risk created through the workflow'",
      );
      expect(risk.rows[0]!.risk_id).toMatch(/^RK-\d{3}$/);
      expect(risk.rows[0]!.updated_by).toBe(users.contributor_ra1.userId);
      expect(await count(client, "select * from risk_links where risk_id = $1 and object_type = 'reform' and object_id = 'RA1'", [risk.rows[0]!.risk_id])).toBe(1);
      expect(await count(client, "select * from audit_log where table_name = 'risk_links' and record_id = $1 and submission_id = $2", [risk.rows[0]!.risk_id, id])).toBe(1);
    });
  });

  it('applies all rows or none', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone, { next_action: 'Should not be saved' }), milestoneUpdate('MS-999')]);
      await actAs(client, users.lead_ra1);
      const error = await expectFailure(client, APPROVE, [id, null, false]);
      expect(error.message).toMatch(/^B03: row 2/);
      expect(JSON.parse(error.hint ?? '{}')).toEqual({ code: 'B03', row: 2, field: 'milestone_id', value: 'MS-999' });
      await actAsServer(client);
      expect(await count(client, "select * from milestones where next_action = 'Should not be saved'")).toBe(0);
      expect(await count(client, "select * from submissions where submission_id = $1 and status = 'proposed'", [id])).toBe(1);
    });
  });
});

describe('who may approve', () => {
  it('four-eyes: nobody approves their own submission', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.lead_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W04/);
    });
  });

  it('four-eyes: the person a submission was entered for cannot approve it', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [milestoneUpdate(ra1Milestone)], { onBehalfOf: users.lead_ra1.personId });
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W04/);
    });
  });

  it('a reform lead cannot approve another reform', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.lead_ra2, [milestoneUpdate(ra2Milestone)]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W05/);
    });
  });

  it.each(['contributor_ra1', 'merl', 'viewer'] as const)('%s cannot approve a milestone', async (key) => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.lead_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users[key]);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W05/);
    });
  });

  it('MERL approves indicator values for every reform (decision 14)', async () => {
    await withUsers(client, async (users) => {
      const fromContributor = await propose(client, users.contributor_ra1, [indicatorValue('RA1')]);
      const fromAdmin = await propose(client, users.programme_admin, [indicatorValue('RA2'), indicatorValue('RA3')]);
      await actAs(client, users.merl);
      await client.query(APPROVE, [fromContributor, null, false]);
      await client.query(APPROVE, [fromAdmin, null, false]);
      await actAsServer(client);
      const values = await client.query<{ reform_id: string; approval_status: string; approved_by: string }>(
        "select reform_id, approval_status, approved_by from indicator_values where period_end = '2026-09-30' order by reform_id",
      );
      expect(values.rows).toEqual(
        ['RA1', 'RA2', 'RA3'].map((reform_id) => ({ reform_id, approval_status: 'approved', approved_by: users.merl.userId })),
      );
    });
  });

  it('a reform lead does not approve indicator values', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [indicatorValue('RA1')]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W05/);
    });
  });

  it('programme-wide milestones need a programme admin', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [milestoneUpdate(programmeMilestone)]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W05/);
      await actAs(client, users.programme_admin_2);
      expect((await client.query<{ status: string }>(APPROVE, [id, null, false])).rows[0]!.status).toBe('applied');
    });
  });
});

describe('break-glass (super_admin)', () => {
  it('super_admin approves only through break-glass, with a reason', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.super_admin);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W06/);
      expect((await expectFailure(client, APPROVE, [id, '  ', true])).message).toMatch(/^W06/);
    });
  });

  it('nobody else may use break-glass', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.programme_admin);
      expect((await expectFailure(client, APPROVE, [id, 'Urgent', true])).message).toMatch(/^W05/);
    });
  });

  it('break-glass lets super_admin approve their own submission, and is logged', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.super_admin, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.super_admin);
      const result = await client.query(APPROVE, [id, 'Reform lead unreachable before the steering committee', true]);
      expect(result.rows[0]).toMatchObject({
        status: 'applied',
        break_glass: true,
        break_glass_reason: 'Reform lead unreachable before the steering committee',
      });
      await actAsServer(client);
      expect(
        await count(client, "select * from audit_log where table_name = 'submissions' and record_id = $1 and (after ->> 'break_glass')::boolean", [id]),
      ).toBe(1);
    });
  });
});

describe('live-data checks at approval (B03, B11, B12)', () => {
  it('B11: the submitter must be in scope for the reform', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra2Milestone)]);
      await actAs(client, users.programme_admin);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^B11/);
    });
  });

  it('B11: the person entered for must be in scope too, if they have an account', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [milestoneUpdate(ra2Milestone)], { onBehalfOf: users.contributor_ra1.personId });
      await actAs(client, users.programme_admin_2);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^B11/);
    });
  });

  it('B12: values for a closed reporting period are refused', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [indicatorValue('RA1', '2026-06-30')]);
      await actAs(client, users.merl);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^B12/);
    });
  });

  it('B03: links must point to something that exists', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [
        {
          entity: 'risk',
          op: 'create',
          fields: { category: 'political', description: 'Risk linked to a missing milestone' },
          links: [{ object_type: 'reform', object_id: 'RA1' }, { object_type: 'milestone', object_id: 'MS-998' }],
        },
      ]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^B03/);
    });
  });

  it('refuses fields a submission may not change', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone, { last_confirmed_at: '2026-01-01' })]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W07/);
    });
  });
});

describe('status rules', () => {
  it('only a proposed submission can be approved', async () => {
    await withUsers(client, async (users) => {
      const id = await submitDraft(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W02/);
    });
  });

  it('a proposed submission needs a passing gate run on the current rule set', async () => {
    await withUsers(client, async (users) => {
      const noRun = await submitDraft(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAsServer(client);
      await client.query("update submissions set status = 'proposed' where submission_id = $1", [noRun]);

      await client.query(
        "insert into dq_rulesets (ruleset_version, effective_from, rules, checksum_sha256, is_current) values ('0.9.0', '2026-01-01', '{}', 'test', false)",
      );
      const oldRules = await submitDraft(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await passGate(client, oldRules, users.contributor_ra1, '0.9.0');

      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [noRun, null, false])).message).toMatch(/^W03/);
      expect((await expectFailure(client, APPROVE, [oldRules, null, false])).message).toMatch(/^W03/);
    });
  });

  it('changing the payload sends it back through the gate', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.contributor_ra1);
      await client.query("update submissions set payload = $1, status = 'draft' where submission_id = $2", [
        JSON.stringify({ rows: [milestoneUpdate(ra1Milestone, { next_action: 'Changed after the gate' })] }),
        id,
      ]);
      const { rows } = await client.query<{ status: string; dq_run_id: string | null }>('select status, dq_run_id from submissions where submission_id = $1', [id]);
      expect(rows[0]).toEqual({ status: 'draft', dq_run_id: null });
    });
  });

  it('a withdrawn submission cannot be approved', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.contributor_ra1);
      await client.query("update submissions set status = 'withdrawn' where submission_id = $1", [id]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W02/);
    });
  });
});

describe('returning a submission', () => {
  it('an approver returns it with a note, and the submitter is told', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, RETURN, [id, ' '])).message).toMatch(/^W06/);
      const returned = await client.query(RETURN, [id, 'Attach the signed minutes']);
      expect(returned.rows[0]).toMatchObject({ status: 'returned', reviewer: users.lead_ra1.userId, review_note: 'Attach the signed minutes' });
      await actAsServer(client);
      expect(
        await count(client, "select * from notification_log where kind = 'submission_returned' and person_id = $1 and object_id = $2", [
          users.contributor_ra1.personId,
          id,
        ]),
      ).toBe(1);
    });
  });

  it('only someone who could approve it may return it', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [milestoneUpdate(ra1Milestone)]);
      await actAs(client, users.lead_ra2);
      expect((await expectFailure(client, RETURN, [id, 'Not mine to review'])).message).toMatch(/^W05/);
    });
  });
});
