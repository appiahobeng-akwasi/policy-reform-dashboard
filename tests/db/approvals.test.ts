// The approvals screen's database side (build step 9, decisions 34 to 37).
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, count, propose, recordUpload, withUsers, type PayloadRow, type UserKey } from './harness';

let client: pg.Client;
let ra1: string;
let programme: string;
let indicator: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  ra1 = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 1")).rows[0]!.id;
  programme = (await client.query<{ id: string }>("select milestone_id as id from milestones where scope = 'programme' order by milestone_id limit 1")).rows[0]!.id;
  indicator = (await client.query<{ id: string }>('select indicator_code as id from indicators order by indicator_code limit 1')).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

const update = (id: string, fields: Record<string, unknown> = { comments: 'Checked' }): PayloadRow => ({ entity: 'milestone', op: 'update', id, fields });
const value: PayloadRow = { entity: 'indicator_value', op: 'create', fields: { indicator_code: 'X', reform_id: 'RA2', period_end: '2026-09-30', value: 1 } };

async function queueFor(key: UserKey, users: Parameters<Parameters<typeof withUsers>[1]>[0]): Promise<string[]> {
  await actAs(client, users[key]);
  return (await client.query<{ submission_id: string }>('select submission_id from approvable_submissions()')).rows.map((r) => r.submission_id);
}

describe('the queue shows exactly what each person may approve', () => {
  it('reform leads their reforms, admins everything, never the submitter, never super_admin outside break-glass', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [update(ra1)]);
      expect(await queueFor('lead_ra1', users)).toContain(id);
      expect(await queueFor('programme_admin', users)).toContain(id);
      for (const key of ['lead_ra2', 'merl', 'viewer', 'contributor_ra1', 'super_admin'] as const) {
        expect(await queueFor(key, users), key).not.toContain(id);
      }
    });
  });

  it('MERL sees indicator values; reform leads do not', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [{ ...value, fields: { ...value.fields, indicator_code: indicator } }]);
      expect(await queueFor('merl', users)).toContain(id);
      expect(await queueFor('lead_ra2', users)).not.toContain(id);
    });
  });

  it('programme-wide items go to programme admins only', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [update(programme)]);
      expect(await queueFor('programme_admin_2', users)).toContain(id);
      expect(await queueFor('lead_ra1', users)).not.toContain(id);
    });
  });

  it('not to the person an update was entered for', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [update(ra1)], { onBehalfOf: users.lead_ra1.personId });
      expect(await queueFor('lead_ra1', users)).not.toContain(id);
      expect(await queueFor('programme_admin_2', users)).toContain(id);
    });
  });

  it('marks "nothing changed" confirmations (decision 37)', async () => {
    await withUsers(client, async (users) => {
      const confirmation = await propose(client, users.contributor_ra1, [update(ra1, {})]);
      const change = await propose(client, users.contributor_ra1, [update(ra1)]);
      await actAs(client, users.lead_ra1);
      const { rows } = await client.query<{ submission_id: string; is_confirmation: boolean }>('select submission_id, is_confirmation from approvable_submissions()');
      expect(rows.find((r) => r.submission_id === confirmation)?.is_confirmation).toBe(true);
      expect(rows.find((r) => r.submission_id === change)?.is_confirmation).toBe(false);
    });
  });
});

describe('what approvers may see (decisions 34 and 35)', () => {
  it('the score and points of a submission go to its approvers, its submitter and admins only', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [update(ra1)]);
      for (const [key, sees] of [['lead_ra1', true], ['contributor_ra1', true], ['programme_admin', true], ['lead_ra2', false], ['viewer', false]] as const) {
        await actAs(client, users[key]);
        expect(await count(client, 'select * from submission_quality($1)', [id]), key).toBe(sees ? 1 : 0);
      }
      // Per-user data quality stays private: the lead still cannot read the contributor's runs.
      await actAs(client, users.lead_ra1);
      expect(await count(client, 'select * from dq_runs where submission_id = $1', [id])).toBe(0);
    });
  });

  it('files open to approvers only', async () => {
    await withUsers(client, async (users) => {
      await recordUpload(client, users.contributor_ra1, 'evidence/2026/abc.pdf');
      const id = await propose(client, users.contributor_ra1, [
        update(ra1),
        {
          entity: 'evidence_item',
          op: 'create',
          fields: { title: 'Minutes of the working group', evidence_type: 'meeting_minutes', file_path: 'evidence/2026/abc.pdf', file_sha256: 'abc', file_mime: 'application/pdf', file_bytes: 10 },
          links: [{ object_type: 'milestone', object_id: ra1 }],
        },
      ]);
      await actAs(client, users.lead_ra1);
      const { rows } = await client.query<{ kind: string; file_path: string }>('select kind, file_path from review_files($1)', [id]);
      expect(rows).toEqual([{ kind: 'evidence', file_path: 'evidence/2026/abc.pdf' }]);
      await actAs(client, users.lead_ra2);
      expect(await count(client, 'select * from review_files($1)', [id])).toBe(0);
    });
  });
});

describe('notices (decision 36)', () => {
  it('approval_needed goes to everyone who may approve, and to nobody else', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [update(ra1)]);
      await actAsServer(client);
      await client.query('select notify_approvers($1)', [id]);
      const { rows } = await client.query<{ person_id: string }>("select person_id from notification_log where kind = 'approval_needed' and object_id = $1", [id]);
      const notified = new Set(rows.map((r) => r.person_id));
      expect(notified.has(users.lead_ra1.personId)).toBe(true);
      expect(notified.has(users.programme_admin.personId)).toBe(true);
      for (const key of ['lead_ra2', 'contributor_ra1', 'merl', 'viewer', 'super_admin'] as const) expect(notified.has(users[key].personId), key).toBe(false);
    });
  });

  it('marking notices read touches only your own', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [update(ra1)]);
      await actAsServer(client);
      await client.query('select notify_approvers($1)', [id]);
      await actAs(client, users.lead_ra1);
      expect((await client.query<{ n: number }>('select mark_my_notices_read() as n')).rows[0]!.n).toBe(1);
      await actAsServer(client);
      expect(await count(client, "select * from notification_log where object_id = $1 and kind = 'approval_needed' and read_at is null and person_id = $2", [id, users.programme_admin.personId])).toBe(1);
    });
  });
});

describe('names on the review page', () => {
  it('an approver sees who sent an update without reading the accounts table', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [update(ra1)]);
      await actAs(client, users.lead_ra1);
      expect(await count(client, 'select * from app_users where user_id = $1', [users.contributor_ra1.userId])).toBe(0);
      const { rows } = await client.query<{ name: string }>('select user_display_name(submitted_by) as name from submissions where submission_id = $1', [id]);
      expect(rows[0]!.name).toBe('Test user contributor_ra1');
      await actAs(client, users.counterpart_ra1);
      expect((await client.query<{ name: string | null }>('select user_display_name($1) as name', [users.contributor_ra1.userId])).rows[0]!.name).toBeNull();
    });
  });
});
