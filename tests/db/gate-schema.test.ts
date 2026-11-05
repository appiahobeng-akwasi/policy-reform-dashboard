// The gate engine's picture of the schema must match the database: writable fields, lists,
// ID patterns and the RAG calculation.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { entityOfId, ENTITY_SPECS, SCHEMA_LISTS } from '../../src/lib/gate/entities';
import { computedRag } from '../../src/lib/gate/rag';
import { RULE_SET_V1 } from '../../src/lib/gate/rules';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

describe('entity map', () => {
  it('matches submission_entities: same entities, keys and writable fields', async () => {
    const { rows } = await client.query<{ entity: string; pk_column: string; writable_columns: string[] }>(
      'select entity, pk_column, writable_columns from submission_entities order by entity',
    );
    expect(rows.map((r) => r.entity)).toEqual(Object.keys(ENTITY_SPECS).sort());
    for (const row of rows) {
      const spec = ENTITY_SPECS[row.entity]!;
      expect(spec.idField, row.entity).toBe(row.pk_column);
      expect([...spec.writable].sort(), row.entity).toEqual([...row.writable_columns].sort());
    }
  });

  it('every controlled list exists, in lookup_values or as a schema list', async () => {
    const { rows } = await client.query<{ list_name: string }>('select distinct list_name from lookup_values');
    const known = new Set([...rows.map((r) => r.list_name), ...Object.keys(SCHEMA_LISTS)]);
    const used = Object.values(ENTITY_SPECS).flatMap((spec) => Object.values(spec.controlled));
    expect(used.filter((name) => !known.has(name))).toEqual([]);
  });

  it.each([
    ['milestone_scope', 'milestones', 'scope'],
    ['governance_tier', 'decisions', 'governance_tier'],
    ['adaptation_trigger', 'adaptations', 'trigger_type'],
    ['access_level', 'evidence_items', 'access_level'],
  ])('schema list %s matches the CHECK constraint on %s.%s', async (list, table, column) => {
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = $1::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ~ ('^CHECK \\(\\(+' || $2 || '\\M')`,
      [table, column],
    );
    const values = [...(rows[0]?.def ?? '').matchAll(/'([^']+)'|\b(\d)\b/g)].map((m) => m[1] ?? m[2]);
    expect(values.sort()).toEqual([...(SCHEMA_LISTS[list] ?? [])].sort());
  });

  it('id_object_type() in the database reads IDs the same way as the engine', async () => {
    const ids = ['RA1', 'WS-RA1-01', 'DL-RA2-003', 'AC-RA3-0004', 'MS-009', 'PT-012', 'RK-101', 'DC-006', 'AN-0001', 'EV-010', 'AD-004', 'RD-003', 'O1.1', 'MS-1', 'nonsense'];
    const { rows } = await client.query<{ id: string; type: string | null }>('select id, id_object_type(id) as type from unnest($1::text[]) as id', [ids]);
    for (const row of rows) expect(row.type, row.id).toBe(entityOfId(row.id, RULE_SET_V1.idPatterns));
  });
});

describe('RAG', () => {
  it('the engine computes the same RAG as computed_rag() in the database, for every case', async () => {
    const today = (await client.query<{ d: string }>("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0]!.d;
    const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const statuses = [null, 'not_started', 'on_track', 'at_risk', 'delayed', 'blocked', 'complete', 'cancelled'];
    const dates = [null, ...[-30, -15, -14, -13, -8, -7, -1, 0, 1, 6, 7, 8, 30].map(shift)];
    const progress = [null, 0, 49, 50, 100];
    const cases = statuses.flatMap((s) => dates.flatMap((start) => dates.flatMap((due) => progress.map((p) => [s, start, due, p] as const))));
    const { rows } = await client.query<{ rag: string }>(
      `select computed_rag(s, st::date, du::date, null, p) as rag
         from unnest($1::text[], $2::text[], $3::text[], $4::int[]) with ordinality as x(s, st, du, p, n) order by n`,
      [cases.map((c) => c[0]), cases.map((c) => c[1]), cases.map((c) => c[2]), cases.map((c) => c[3])],
    );
    const mismatches = cases.filter((c, i) => computedRag(c[0], c[1], c[2], null, c[3], today) !== rows[i]!.rag);
    expect(cases.length).toBeGreaterThan(5000);
    expect(mismatches).toEqual([]);
  });
});
