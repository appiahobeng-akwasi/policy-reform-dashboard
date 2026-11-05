// Row-level security checks who is asking once per query, not once per row (migration 0019,
// decision 68). A policy that calls the helpers plainly makes every page slower as data grows,
// so this fails the build if one appears. Write `(select is_internal())`, not `is_internal()`.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

const HELPER = '\\m(is_internal|is_admin|my_role|me)\\(\\)';
// How Postgres prints `(select is_internal())` back: "( SELECT is_internal() AS is_internal)".
const WRAPPED = 'SELECT (is_internal|is_admin|my_role|me)\\(\\)';

describe('policies check who is asking once per query (decision 68)', () => {
  it('every call to is_internal, is_admin, my_role or me in a policy is wrapped in a subquery', async () => {
    const { rows } = await client.query<{ policy: string; calls: number; wrapped: number }>(
      `select tablename || '.' || policyname as policy,
              (coalesce(regexp_count(qual, $1), 0) + coalesce(regexp_count(with_check, $1), 0))::int as calls,
              (coalesce(regexp_count(qual, $2), 0) + coalesce(regexp_count(with_check, $2), 0))::int as wrapped
         from pg_policies where schemaname = 'public'`,
      [HELPER, WRAPPED],
    );
    const plain = rows.filter((r) => r.calls !== r.wrapped).map((r) => r.policy);
    expect(plain, 'policies calling a helper once per row').toEqual([]);
    expect(rows.reduce((n, r) => n + r.calls, 0)).toBeGreaterThan(100);
  });
});
