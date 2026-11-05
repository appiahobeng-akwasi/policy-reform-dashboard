// The Portfolio, Risk, MERL and Governance views (decisions 58 to 60): the proposed readiness
// score, and who can read what each view shows. Rolled back.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { actAs, count, withUsers } from './harness';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

const score = async (...ratings: (string | null)[]) => (await client.query<{ s: number | null }>('select readiness_score_v1(variadic $1::text[]) as s', [ratings])).rows[0]!.s;

describe('readiness score, proposed method v1 (docs/02)', () => {
  it('High 3, Medium 2, Low 1; the sum over 18, times 100, rounded', async () => {
    expect(await score('high', 'high', 'high', 'high', 'high', 'high')).toBe(100);
    expect(await score('low', 'low', 'low', 'low', 'low', 'low')).toBe(33);
    expect(await score('high', 'high', 'medium', 'medium', 'medium', 'medium')).toBe(78);
  });

  it('no score unless all six are rated with a known value', async () => {
    expect(await score('high', 'high', 'medium', 'medium', 'medium', null)).toBeNull();
    expect(await score('high', 'high', 'medium', 'medium', 'medium', 'excellent')).toBeNull();
    expect(await score('high', 'high', 'medium')).toBeNull();
  });

  it('the seeded assessments get a score, one latest row per reform, the source score kept apart', async () => {
    const { rows } = await client.query<{ reform_id: string; score_proposed: number; overall_score_source: string }>(
      'select reform_id, score_proposed, overall_score_source from v_readiness where is_latest order by reform_id',
    );
    expect(rows.map((r) => r.reform_id)).toEqual(['RA1', 'RA2', 'RA3']);
    for (const r of rows) expect(r.score_proposed).toBeGreaterThan(0);
    expect(rows.map((r) => r.overall_score_source)).toEqual(['72', '68', '64']);
  });
});

describe('what each role reads in the four views (spec 01 section 3)', () => {
  const TABLES = ['v_readiness', 'risks', 'decisions', 'adaptations', 'governance_raci', 'indicators', 'indicator_values', 'learning_log', 'disaggregation_facts'];

  it('internal users read them all', async () => {
    await withUsers(client, async (users) => {
      for (const key of ['viewer', 'contributor_ra1', 'lead_ra1', 'merl'] as const) {
        await actAs(client, users[key]);
        for (const table of TABLES) expect(await count(client, `select 1 from ${table}`), `${key} ${table}`).toBeGreaterThan(0);
      }
    });
  });

  it('counterparts read none of them, only their reforms and stages', async () => {
    await withUsers(client, async (users) => {
      await actAs(client, users.counterpart_ra1);
      for (const table of TABLES) expect(await count(client, `select 1 from ${table}`), table).toBe(0);
      expect((await client.query<{ reform_id: string }>('select reform_id from reforms')).rows.map((r) => r.reform_id)).toEqual(['RA1']);
      expect(await count(client, "select 1 from reform_stages where reform_id <> 'RA1'")).toBe(0);
      expect(await count(client, "select 1 from reform_stages where reform_id = 'RA1'")).toBeGreaterThan(0);
    });
  });
});
