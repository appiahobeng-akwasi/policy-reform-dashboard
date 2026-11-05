// Build step 6 in the database: no silent overwrites (W10), uploads visible only to their
// owner, and an attached file becoming evidence linked to the item on approval.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, APPROVE, count, expectFailure, propose, recordUpload, withUsers, type TestUser } from './harness';

let client: pg.Client;
let milestone: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  milestone = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 1")).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

async function version(): Promise<string> {
  await actAsServer(client);
  return (await client.query<{ v: string }>('select updated_at::text as v from milestones where milestone_id = $1', [milestone])).rows[0]!.v;
}

async function upload(user: TestUser, sha: string): Promise<string> {
  await actAsServer(client);
  const { rows } = await client.query<{ upload_id: string }>(
    `insert into evidence_uploads (uploaded_by, file_name, file_path, file_sha256, file_mime, file_bytes)
     values ($1, 'minutes.pdf', 'evidence/2026/' || $2 || '.pdf', $2, 'application/pdf', 2048) returning upload_id`,
    [user.userId, sha],
  );
  return rows[0]!.upload_id;
}

describe('no silent overwrites (W10)', () => {
  it('applies an update made against the current version', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: milestone, fields: { comments: 'Checked today' }, base_updated_at: await version() }]);
      await actAs(client, users.lead_ra1);
      expect((await client.query<{ status: string }>(APPROVE, [id, null, false])).rows[0]!.status).toBe('applied');
    });
  });

  it('refuses an update if someone else\'s change was applied after the form was opened', async () => {
    await withUsers(client, async (users) => {
      const seen = await version();
      const first = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: milestone, fields: { comments: 'First change' }, base_updated_at: seen }]);
      const second = await propose(client, users.lead_ra2, [{ entity: 'milestone', op: 'update', id: milestone, fields: { comments: 'Second change' }, base_updated_at: seen }]);
      await actAs(client, users.lead_ra1);
      await client.query(APPROVE, [first, null, false]);
      await actAs(client, users.programme_admin);
      const error = await expectFailure(client, APPROVE, [second, null, false]);
      expect(error.message).toMatch(/^W10/);
      await actAsServer(client);
      expect(await count(client, "select * from milestones where milestone_id = $1 and comments = 'First change'", [milestone])).toBe(1);
    });
  });
});

describe('evidence uploads', () => {
  it('each person sees only their own uploads; admins see all; nobody writes them directly', async () => {
    await withUsers(client, async (users) => {
      await upload(users.contributor_ra1, 'aaa1');
      await upload(users.lead_ra1, 'bbb2');
      await actAs(client, users.contributor_ra1);
      expect(await count(client, 'select * from evidence_uploads')).toBe(1);
      await actAs(client, users.programme_admin);
      expect(await count(client, 'select * from evidence_uploads')).toBe(2);
      await actAs(client, users.contributor_ra1);
      const error = await expectFailure(
        client,
        "insert into evidence_uploads (uploaded_by, file_name, file_path, file_sha256, file_mime, file_bytes) values ($1, 'x.pdf', 'evidence/2026/x.pdf', 'x', 'application/pdf', 1)",
        [users.contributor_ra1.userId],
      );
      expect(error.code).toBe('42501');
    });
  });

  it('an attached file becomes evidence linked to the item when the update is approved', async () => {
    await withUsers(client, async (users) => {
      await recordUpload(client, users.contributor_ra1, 'evidence/2026/ccc3.pdf');
      const id = await propose(client, users.contributor_ra1, [
        { entity: 'milestone', op: 'update', id: milestone, fields: { comments: 'Minutes attached' } },
        {
          entity: 'evidence_item',
          op: 'create',
          fields: { title: 'Minutes of the land working group', evidence_type: 'meeting_minutes', access_level: 'restricted', file_path: 'evidence/2026/ccc3.pdf', file_sha256: 'ccc3', file_mime: 'application/pdf', file_bytes: 2048 },
          links: [{ object_type: 'milestone', object_id: milestone }],
        },
      ]);
      await actAs(client, users.lead_ra1);
      await client.query(APPROVE, [id, null, false]);
      await actAsServer(client);
      const evidence = await client.query<{ evidence_id: string; uploaded_by: string; validation_status: string }>(
        "select evidence_id, uploaded_by, validation_status from evidence_items where file_sha256 = 'ccc3'",
      );
      expect(evidence.rows[0]).toMatchObject({ uploaded_by: users.contributor_ra1.userId, validation_status: 'pending' });
      expect(await count(client, "select * from evidence_links where evidence_id = $1 and object_type = 'milestone' and object_id = $2", [evidence.rows[0]!.evidence_id, milestone])).toBe(1);
    });
  });
});
