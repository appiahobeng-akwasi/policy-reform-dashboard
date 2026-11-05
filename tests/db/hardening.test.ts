// Build step 14 (migration 0018): rate-limit counters and the error log. Rolled back.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, count, expectFailure, withUsers } from './harness';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

const hit = async (bucket: string, key: string, limit: number) =>
  (await client.query<{ ok: boolean }>('select hit_rate_limit($1, $2, $3, 3600) as ok', [bucket, key, limit])).rows[0]!.ok;

describe('rate limits (decision 63)', () => {
  it('allows up to the limit in a window, per bucket and key, and stores no key in clear', async () => {
    await withUsers(client, async () => {
      await actAsServer(client);
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await hit('test_bucket', 'someone@example.com', 3));
      expect(results).toEqual([true, true, true, false]);
      expect(await hit('test_bucket', 'someone-else@example.com', 3)).toBe(true);
      expect(await hit('other_bucket', 'someone@example.com', 3)).toBe(true);
      expect(await count(client, "select 1 from rate_limit_counters where key_hash like '%@%'")).toBe(0);
    });
  });

  it('signed-in people cannot count, reset or read the counters', async () => {
    await withUsers(client, async (users) => {
      for (const key of ['super_admin', 'contributor_ra1'] as const) {
        await actAs(client, users[key]);
        expect((await expectFailure(client, "select hit_rate_limit('x', 'y', 1, 60)")).message, key).toMatch(/permission denied/);
        expect(await count(client, 'select 1 from rate_limit_counters'), key).toBe(0);
        expect((await client.query('delete from rate_limit_counters')).rowCount, key).toBe(0);
      }
    });
  });
});

describe('the error log (decision 64)', () => {
  it('admins read it; nobody else does; nobody writes it but the server', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      await client.query("insert into error_log (reference, source, message) values ('E-TEST01', 'request', 'boom')");
      await actAs(client, users.programme_admin);
      expect(await count(client, "select 1 from error_log where reference = 'E-TEST01'")).toBe(1);
      for (const key of ['lead_ra1', 'viewer', 'contributor_ra1'] as const) {
        await actAs(client, users[key]);
        expect(await count(client, 'select 1 from error_log'), key).toBe(0);
        const write = await expectFailure(client, "insert into error_log (reference, source, message) values ('E-TEST02', 'request', 'x')");
        expect(write.message, key).toMatch(/row-level security/);
      }
    });
  });

  it('an error alert is sent to each super administrator once an hour', async () => {
    await withUsers(client, async (users) => {
      await actAsServer(client);
      const alert = "insert into notification_log (kind, person_id, channel, object_type, object_id, status) values ('error_alert', $1, 'in_app', 'hour', '2031-03-20T10', 'queued') on conflict do nothing";
      expect((await client.query(alert, [users.super_admin.personId])).rowCount).toBe(1);
      expect((await client.query(alert, [users.super_admin.personId])).rowCount).toBe(0);
    });
  });
});
