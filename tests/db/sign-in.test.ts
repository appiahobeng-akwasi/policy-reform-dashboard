// Sign-in support in the database (migration 0007 and the Supabase sign-in hook).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, actAsServer, APPROVE, count, expectFailure, propose, withUsers } from './harness';

let client: pg.Client;
let ra1Milestone: string;

beforeAll(async () => {
  client = await connect(databaseUrl());
  const { rows } = await client.query<{ id: string }>("select milestone_id as id from milestones where reform_id = 'RA1' order by milestone_id limit 1");
  ra1Milestone = rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
});

describe('MFA enforced by the database (decision 17)', () => {
  it.each(['super_admin', 'programme_admin'] as const)('%s is nobody until the session has passed MFA', async (key) => {
    await withUsers(client, async (users) => {
      await actAs(client, users[key], { aal: 'aal1' });
      expect(await count(client, 'select * from reforms')).toBe(0);
      expect(await count(client, 'select * from audit_log')).toBe(0);
      const { rows } = await client.query<{ user_id: string | null }>('select (me()).user_id');
      expect(rows[0]!.user_id).toBeNull();
      await actAs(client, users[key], { aal: 'aal2' });
      expect(await count(client, 'select * from reforms')).toBe(3);
    });
  });

  it('an admin without MFA cannot approve', async () => {
    await withUsers(client, async (users) => {
      const id = await propose(client, users.contributor_ra1, [{ entity: 'milestone', op: 'update', id: ra1Milestone, fields: {} }]);
      await actAs(client, users.programme_admin, { aal: 'aal1' });
      expect((await expectFailure(client, APPROVE, [id, null, false])).message).toMatch(/^W05/);
    });
  });

  it.each(['lead_ra1', 'contributor_ra1', 'merl', 'viewer'] as const)('%s does not need MFA', async (key) => {
    await withUsers(client, async (users) => {
      await actAs(client, users[key], { aal: 'aal1' });
      expect(await count(client, 'select * from reforms')).toBe(3);
    });
  });
});

describe('set_my_language() (decision 16)', () => {
  it('changes only the caller\'s own language', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.counterpart_ra1);
      await client.query("select set_my_language('fr')");
      await actAsServer(client);
      const { rows } = await client.query<{ person_id: string; preferred_language: string }>(
        'select person_id, preferred_language from people where person_id = any ($1)',
        [Object.values(users).map((u) => u.personId)],
      );
      for (const row of rows) {
        expect(row.preferred_language, row.person_id).toBe(row.person_id === users.counterpart_ra1.personId ? 'fr' : 'en');
      }
    });
  });

  it('accepts only en or fr', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.viewer);
      expect((await expectFailure(client, "select set_my_language('de')")).message).toMatch(/^W07/);
    });
  });

  it('refuses a stranger', async () => {
    await withUsers(client, async () => {
      await actAs(client, randomUUID());
      expect((await expectFailure(client, "select set_my_language('fr')")).message).toMatch(/^W05/);
    });
  });

  it('is still the only way to change people: a direct update changes nothing', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.lead_ra1);
      const result = await client.query("update people set preferred_language = 'fr' where person_id = $1", [users.lead_ra1.personId]);
      expect(result.rowCount).toBe(0);
    });
  });
});

describe('link_auth_user()', () => {
  async function addUnlinked(email: string, active = true): Promise<void> {
    const person = await client.query<{ person_id: string }>('insert into people (full_name, email) values ($1, $2) returning person_id', ['New user (test)', email]);
    await client.query("insert into app_users (person_id, email, app_role, is_active) values ($1, $2, 'contributor', $3)", [person.rows[0]!.person_id, email, active]);
  }

  it('links a listed email on first sign-in, whatever its case, and records the sign-in', async () => {
    await withUsers(client, async () => {
      await addUnlinked('new.user@test.invalid');
      const authId = randomUUID();
      const { rows } = await client.query<{ user_id: string | null }>('select link_auth_user($1, $2) as user_id', ['New.User@Test.Invalid', authId]);
      expect(rows[0]!.user_id).not.toBeNull();
      const linked = await client.query<{ auth_user_id: string; signed_in: boolean }>(
        "select auth_user_id, last_sign_in_at > now() - interval '1 minute' as signed_in from app_users where email = 'new.user@test.invalid'",
      );
      expect(linked.rows[0]).toEqual({ auth_user_id: authId, signed_in: true });
      const again = await client.query<{ user_id: string | null }>('select link_auth_user($1, $2) as user_id', ['new.user@test.invalid', authId]);
      expect(again.rows[0]!.user_id).toBe(rows[0]!.user_id);
    });
  });

  it('refuses an unlisted email, an inactive account, and a second identity for the same email', async () => {
    await withUsers(client, async (users) => {
      await addUnlinked('inactive.user@test.invalid', false);
      const link = async (email: string) =>
        (await client.query<{ user_id: string | null }>('select link_auth_user($1, $2) as user_id', [email, randomUUID()])).rows[0]!.user_id;
      expect(await link('nobody@test.invalid')).toBeNull();
      expect(await link('inactive.user@test.invalid')).toBeNull();
      expect(await link(`${users.lead_ra1.key}@test.invalid`)).toBeNull();
    });
  });

  it('cannot be called by signed-in users', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.programme_admin);
      const error = await expectFailure(client, 'select link_auth_user($1, $2)', ['x@test.invalid', randomUUID()]);
      expect(error.code).toBe('42501');
    });
  });
});

const { rows: hookRows } = await (async () => {
  const probe = await connect(databaseUrl());
  try {
    return await probe.query("select 1 from pg_proc where proname = 'hook_before_user_created'");
  } finally {
    await probe.end();
  }
})();

describe.runIf(hookRows.length > 0)('Supabase sign-in hook (local Supabase only)', () => {
  it('lets a listed email get a sign-in identity and refuses any other', async () => {
    await withUsers(client, async (users) => {
      const hook = async (email: string) =>
        (await client.query<{ result: Record<string, unknown> }>('select hook_before_user_created($1) as result', [
          JSON.stringify({ user: { email } }),
        ])).rows[0]!.result;
      expect(await hook(`${users.viewer.key}@test.invalid`)).toEqual({});
      expect(await hook('stranger@test.invalid')).toMatchObject({ error: { http_code: 403 } });
    });
  });
});
