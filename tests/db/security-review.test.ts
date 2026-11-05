// Fixes from the security review of 4 Nov 2026 (decision 91, migration 0021): null-safe role
// checks, counterpart evidence scoped to their reforms, files in a submission must be the
// submitter's own, and risks stay internal. Each fix has a case that passes and one that fails.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, count, expectFailure, propose, recordUpload, submitDraft, withUsers, type Users } from './harness';

let client: pg.Client;
let ra1Milestone: string;
let ra2Milestone: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  const pick = async (reform: string) =>
    (await client.query<{ id: string }>('select milestone_id as id from milestones where reform_id = $1 order by milestone_id limit 1', [reform])).rows[0]!.id;
  ra1Milestone = await pick('RA1');
  ra2Milestone = await pick('RA2');
});

afterAll(async () => {
  await client?.end();
});

const EVIDENCE = `insert into evidence_items (evidence_id, title, evidence_type, access_level) values ($1, $2, 'report', $3)`;
const LINK = `insert into evidence_links (evidence_id, object_type, object_id) values ($1, 'milestone', $2)`;

async function evidence(id: string, access: string, milestone: string): Promise<void> {
  await actAsServer(client);
  await client.query(EVIDENCE, [id, `Fixture ${id}`, access]);
  await client.query(LINK, [id, milestone]);
}

describe('role checks are null-safe', () => {
  it('an identity with no account is not an admin, and cannot send a training notice', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, randomUUID());
      const { rows } = await client.query<{ admin: boolean; internal: boolean }>('select is_admin() as admin, is_internal() as internal');
      expect(rows[0]).toEqual({ admin: false, internal: false });
      const error = await expectFailure(client, 'select send_training_notice($1, $2)', [users.contributor_ra1.userId, ['B04']]);
      expect(error.message).toMatch(/^U02/);
    });
  });

  it('an administrator still can', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      const { rows } = await client.query<{ ok: boolean }>('select send_training_notice($1, $2) as ok', [users.contributor_ra1.userId, ['B04']]);
      expect(rows[0]!.ok).toBe(true);
    });
  });
});

describe('counterparts see evidence for their own reforms only', () => {
  const seen = async (users: Users) => {
    await actAs(client, users.counterpart_ra1);
    return (await client.query<{ evidence_id: string }>("select evidence_id from evidence_items where evidence_id in ('EV-9901', 'EV-9902', 'EV-9903', 'EV-9904') order by 1")).rows.map(
      (r) => r.evidence_id,
    );
  };

  it('external evidence on their reform and public evidence anywhere, nothing else', async () => {
    await withUsers(client, async (users) => {
      await evidence('EV-9901', 'external', ra1Milestone);
      await evidence('EV-9902', 'external', ra2Milestone);
      await evidence('EV-9903', 'public', ra2Milestone);
      await evidence('EV-9904', 'restricted', ra1Milestone);
      expect(await seen(users)).toEqual(['EV-9901', 'EV-9903']);
      // Internal staff are unaffected.
      await actAs(client, users.viewer);
      expect(await count(client, "select 1 from evidence_items where evidence_id in ('EV-9901', 'EV-9902', 'EV-9903', 'EV-9904')")).toBe(4);
    });
  });
});

describe('a submission may name only files its submitter uploaded', () => {
  const evidenceRow = (path: string) => ({
    entity: 'evidence_item',
    op: 'create' as const,
    fields: { title: 'Minutes', evidence_type: 'meeting_minutes', file_path: path, file_sha256: 'x', file_mime: 'application/pdf', file_bytes: 10 },
    links: [{ object_type: 'milestone', object_id: ra1Milestone }],
  });

  it('their own upload is accepted and listed for the approver', async () => {
    await withUsers(client, async (users) => {
      await recordUpload(client, users.contributor_ra1, 'evidence/2026/own.pdf');
      const id = await propose(client, users.contributor_ra1, [evidenceRow('evidence/2026/own.pdf')]);
      await actAs(client, users.lead_ra1);
      expect((await client.query<{ file_path: string }>('select file_path from review_files($1)', [id])).rows).toEqual([{ file_path: 'evidence/2026/own.pdf' }]);
    });
  });

  it("someone else's upload is refused (E01)", async () => {
    await withUsers(client, async (users) => {
      await recordUpload(client, users.lead_ra2, 'evidence/2026/theirs.pdf');
      await actAs(client, users.contributor_ra1);
      const error = await expectFailure(
        client,
        `insert into submissions (route, submitted_by, entity, payload) values ('web_form', $1, 'evidence_item', $2)`,
        [users.contributor_ra1.userId, JSON.stringify({ rows: [evidenceRow('evidence/2026/theirs.pdf')] })],
      );
      expect(error.message).toMatch(/^E01/);
    });
  });

  it("an instruction file that is someone else's is refused (E01)", async () => {
    await withUsers(client, async (users) => {
      const theirs = await recordUpload(client, users.lead_ra2, 'evidence/2026/instruction.pdf');
      const draft = await submitDraft(client, users.programme_admin, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: { comments: 'x' } }]);
      await actAs(client, users.programme_admin);
      const error = await expectFailure(client, 'update submissions set instruction_upload_id = $1 where submission_id = $2', [theirs, draft]);
      expect(error.message).toMatch(/^E01/);
    });
  });

  it('a forged path written past the trigger is still never listed for review', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: { comments: 'x' } }]);
      await actAsServer(client);
      await client.query(`update submissions set payload = $1 where submission_id = $2`, [JSON.stringify({ rows: [evidenceRow('evidence/2026/forged.pdf')] }), id]);
      await actAs(client, users.lead_ra1);
      expect(await count(client, 'select * from review_files($1)', [id])).toBe(0);
    });
  });
});

describe('risks stay internal', () => {
  it('a counterpart cannot own a risk (R01); a programme person can', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      const error = await expectFailure(client, "update risks set owner_person_id = $1 where risk_id = 'RK-001'", [users.counterpart_ra1.personId]);
      expect(error.message).toMatch(/^R01/);
      await client.query("update risks set owner_person_id = $1 where risk_id = 'RK-001'", [users.lead_ra1.personId]);
    });
  });

  it('no notice about a risk is recorded for a counterpart', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      const insert = `insert into notification_log (kind, person_id, channel, object_type, object_id, status) values ('due_soon', $1, 'in_app', 'risk', 'RK-001', 'queued')`;
      await client.query(insert, [users.counterpart_ra1.personId]);
      await client.query(insert, [users.lead_ra1.personId]);
      expect(await count(client, "select 1 from notification_log where object_type = 'risk' and object_id = 'RK-001' and person_id = $1", [users.counterpart_ra1.personId])).toBe(0);
      expect(await count(client, "select 1 from notification_log where object_type = 'risk' and object_id = 'RK-001' and person_id = $1", [users.lead_ra1.personId])).toBe(1);
    });
  });
});
