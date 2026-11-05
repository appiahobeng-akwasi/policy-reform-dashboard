// Entering updates for someone else (build step 8, spec 01 section 5.3, decisions 30 to 33).
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { notifyEnteredFor } from '../../src/lib/gate-server/run';
import { actAs, actAsServer, APPROVE, count, expectFailure, passGate, propose, submitDraft, withUsers, type PayloadRow } from './harness';

let client: pg.Client;
let ra1: string[];
let ra2: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  ra1 = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 2")).rows.map((r) => r.id);
  ra2 = (await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA2' order by milestone_id limit 1")).rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

const update = (id: string, extra: Partial<PayloadRow> = {}): PayloadRow => ({ entity: 'milestone', op: 'update', id, fields: { comments: 'Update given by phone' }, ...extra });

async function personWithoutAccount(name: string): Promise<string> {
  await actAsServer(client);
  return (await client.query<{ person_id: string }>('insert into people (full_name) values ($1) returning person_id', [name])).rows[0]!.person_id;
}

describe('who may enter for someone else (decision 30)', () => {
  it('programme admins may; reform leads and contributors may not', async () => {
    await withUsers(client, async (users) => {
      const person = await personWithoutAccount('Focal point (test)');
      expect(await submitDraft(client, users.programme_admin, [update(ra1[0]!)], { onBehalfOf: person })).toMatch(/^[0-9a-f-]{36}$/);
      for (const key of ['lead_ra1', 'contributor_ra1'] as const) {
        await actAs(client, users[key]);
        const error = await expectFailure(
          client,
          "insert into submissions (route, submitted_by, on_behalf_of_person_id, payload, on_behalf_channel, on_behalf_received_on) values ('on_behalf', $1, $2, '{\"rows\": []}', 'phone', '2026-11-02')",
          [users[key].userId, person],
        );
        expect(error.code, key).toBe('42501');
      }
    });
  });

  it('an on-behalf entry must say how and when it was received (decision 31)', async () => {
    await withUsers(client, async (users) => {
      const person = await personWithoutAccount('Focal point (test)');
      await actAs(client, users.programme_admin);
      const error = await expectFailure(
        client,
        "insert into submissions (route, submitted_by, on_behalf_of_person_id, payload) values ('on_behalf', $1, $2, '{\"rows\": []}')",
        [users.programme_admin.userId, person],
      );
      expect(error.code).toBe('23514');
    });
  });
});

describe('"entered by A for B" (acceptance 6)', () => {
  it('shows who entered the last applied update and for whom, to internal users only', async () => {
    await withUsers(client, async (users) => {
      const person = await personWithoutAccount('Marie Example (test)');
      const id = await propose(client, users.programme_admin, [update(ra1[0]!)], { onBehalfOf: person });
      await actAs(client, users.programme_admin_2);
      await client.query(APPROVE, [id, null, false]);

      await actAs(client, users.viewer);
      const { rows } = await client.query<{ entered_by: string; entered_for: string; channel: string }>('select entered_by, entered_for, channel from item_last_update($1, $2)', ['milestone', ra1[0]]);
      expect(rows[0]).toEqual({ entered_by: 'Test user programme_admin', entered_for: 'Marie Example (test)', channel: 'phone' });

      await actAs(client, users.counterpart_ra1);
      expect(await count(client, 'select * from item_last_update($1, $2)', ['milestone', ra1[0]])).toBe(0);
    });
  });
});

describe('bulk rows reported by different people (decision 33)', () => {
  it('attributes each row to its own person in the audit log', async () => {
    await withUsers(client, async (users) => {
      const a = await personWithoutAccount('Reporter A (test)');
      const b = await personWithoutAccount('Reporter B (test)');
      const id = await propose(client, users.programme_admin, [update(ra1[0]!, { on_behalf_of_person_id: a }), update(ra1[1]!, { on_behalf_of_person_id: b })]);
      await actAs(client, users.programme_admin_2);
      await client.query(APPROVE, [id, null, false]);
      await actAsServer(client);
      const { rows } = await client.query<{ record_id: string; on_behalf_of_person_id: string }>(
        "select record_id, on_behalf_of_person_id from audit_log where table_name = 'milestones' and submission_id = $1 order by record_id",
        [id],
      );
      expect(rows).toEqual([
        { record_id: ra1[0], on_behalf_of_person_id: a },
        { record_id: ra1[1], on_behalf_of_person_id: b },
      ].sort((x, y) => x.record_id!.localeCompare(y.record_id!)));
    });
  });

  it('nobody named on any row may approve the file', async () => {
    await withUsers(client, async (users) => {
      const outsider = await personWithoutAccount('Reporter (test)');
      const id = await propose(client, users.programme_admin, [update(ra1[0]!, { on_behalf_of_person_id: outsider }), update(ra1[1]!, { on_behalf_of_person_id: users.lead_ra1.personId })]);
      await actAs(client, users.lead_ra1);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W04: row 2/);
    });
  });

  it('checks each row against its own person\'s scope (B11)', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [update(ra2, { on_behalf_of_person_id: users.contributor_ra1.personId })]);
      await actAs(client, users.programme_admin_2);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^B11/);
    });
  });

  it('refuses a reporter who is not in the system (B03)', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.programme_admin, [update(ra1[0]!, { on_behalf_of_person_id: 'unknown@example.org' })]);
      await actAs(client, users.programme_admin_2);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^B03: row 1/);
    });
  });

  it('only the Secretariat\'s submissions may name a reporter per row', async () => {
    await withUsers(client, async (users) => {
      const person = await personWithoutAccount('Reporter (test)');
      const id = await propose(client, users.lead_ra1, [update(ra1[0]!, { on_behalf_of_person_id: person })]);
      await actAs(client, users.programme_admin);
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W05: row 1/);
    });
  });
});

describe('telling people an update was entered for them', () => {
  it('queues one notice per person named, once', async () => {
    await withUsers(client, async (users) => {
      const a = await personWithoutAccount('Reporter A (test)');
      const b = await personWithoutAccount('Reporter B (test)');
      const id = await submitDraft(client, users.programme_admin, [update(ra1[0]!, { on_behalf_of_person_id: a }), update(ra1[1]!, { on_behalf_of_person_id: b })], { onBehalfOf: a });
      await passGate(client, id, users.programme_admin);
      await notifyEnteredFor(client, id);
      await notifyEnteredFor(client, id);
      const { rows } = await client.query<{ person_id: string }>(
        "select person_id from notification_log where kind = 'entered_on_behalf' and object_id = $1 order by person_id",
        [id],
      );
      expect(rows.map((r) => r.person_id)).toEqual([a, b].sort());
    });
  });
});
