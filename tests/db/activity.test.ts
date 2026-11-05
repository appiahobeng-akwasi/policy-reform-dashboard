// An item's activity (decision 81): sent, approved and returned, with who and the approver's note,
// for the item's owner, the leads of its reform and admins only. A test per role. Rolled back.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, APPROVE, propose, RETURN, withUsers, type Users } from './harness';

let client: pg.Client;
let milestone: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  milestone = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 1")).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

const ACTIVITY = 'select event, actor, note from item_activity($1, $2)';
const events = async () => (await client.query<{ event: string; actor: string; note: string | null }>(ACTIVITY, ['milestone', milestone])).rows;

/** The contributor owns the RA1 milestone, sends two updates; the RA1 lead returns one and approves the other. */
async function history(users: Users): Promise<void> {
  await actAsServer(client);
  await client.query('update milestones set owner_person_id = $1 where milestone_id = $2', [users.contributor_ra1.personId, milestone]);
  const first = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: milestone, fields: { next_action: 'Draft the note' } }]);
  await actAs(client, users.lead_ra1);
  await client.query(RETURN, [first, 'Add the date of the meeting']);
  const second = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: milestone, fields: { next_action: 'Draft the note by 20 Nov' } }]);
  await actAs(client, users.lead_ra1);
  await client.query(APPROVE, [second, 'Thank you', false]);
  // One transaction has one clock; spread the steps out as they would be in real use.
  await actAsServer(client);
  await client.query("update submissions set created_at = now() - interval '4 hours', reviewed_at = now() - interval '3 hours' where submission_id = $1", [first]);
  await client.query("update submissions set created_at = now() - interval '2 hours', reviewed_at = now() - interval '1 hour' where submission_id = $1", [second]);
}

describe('item activity (decision 81)', () => {
  it('the owner sees every step, newest first, with who and the approver\'s note', async () => {
    await withUsers(client, async (users) => {
      await history(users);
      await actAs(client, users.contributor_ra1);
      const rows = await events();
      expect(rows.map((r) => r.event)).toEqual(['approved', 'sent', 'returned', 'sent']);
      expect(rows[0]).toMatchObject({ actor: 'Test user lead_ra1', note: 'Thank you' });
      expect(rows[2]).toMatchObject({ event: 'returned', note: 'Add the date of the meeting' });
      expect(rows[1]!.actor).toBe('Test user contributor_ra1');
    });
  });

  it('the lead of its reform and admins see it too', async () => {
    await withUsers(client, async (users) => {
      await history(users);
      for (const key of ['lead_ra1', 'programme_admin', 'super_admin'] as const) {
        await actAs(client, users[key], { aal: 'aal2' });
        expect((await events()).length, key).toBe(4);
      }
    });
  });

  it('everyone else gets nothing: other leads, other contributors, MERL, viewers and counterparts', async () => {
    await withUsers(client, async (users) => {
      await history(users);
      for (const key of ['lead_ra2', 'merl', 'viewer', 'counterpart_ra1'] as const) {
        await actAs(client, users[key]);
        expect(await events(), key).toEqual([]);
      }
      // A contributor in the same reform who does not own the item sees nothing either.
      await actAsServer(client);
      await client.query('update milestones set owner_person_id = $1 where milestone_id = $2', [users.viewer.personId, milestone]);
      await actAs(client, users.contributor_ra1);
      expect(await events()).toEqual([]);
    });
  });

  it('an item nobody has updated through the dashboard has no activity', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin, { aal: 'aal2' });
      expect(await events()).toEqual([]);
    });
  });
});
