// Smoke test: after `npm run db:reset`, the schema and seed are loaded as
// documented in docs/06_SOURCE_DATA_REVIEW.md section 3.
// Connects as the database owner, so row-level security does not apply here;
// RLS is tested per role in tests/rls (step 2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPending, connect, databaseUrl, ROOT, sqlFiles } from '../../scripts/lib/db';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

async function count(sql: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql);
  return Number(rows[0]?.n);
}

describe('seed', () => {
  it('v_reform_summary returns RA1, RA2 and RA3', async () => {
    const { rows } = await client.query<{ reform_id: string }>('select reform_id from v_reform_summary order by reform_id');
    expect(rows.map((r) => r.reform_id)).toEqual(['RA1', 'RA2', 'RA3']);
  });

  // Figures from docs/06 section 3 (seed load result).
  it.each([
    ['reforms', 3],
    ['reform_stages', 24],
    ['milestones', 24],
    ['risks', 14],
    ['risk_links', 16],
    ['decisions', 6],
    ['decision_links', 10],
    ['adaptations', 4],
    ['adaptation_links', 8],
    ['evidence_items', 10],
    ['evidence_links', 17],
    ['indicators', 21],
    ['indicator_values', 13],
    ['disaggregation_facts', 37],
    ['readiness_assessments', 3],
    ['governance_raci', 18],
    ['institutions', 19],
    ['learning_log', 7],
    ['reform_status_snapshots', 6],
    ['publications', 1],
    ['dq_rulesets', 1],
    ['reporting_periods', 1],
  ])('%s has %i rows', async (table, expected) => {
    expect(await count(`select count(*) as n from ${table}`)).toBe(expected);
  });

  it('has no workstreams, deliverables or activities yet (the source had none)', async () => {
    expect(await count('select count(*) as n from workstreams')).toBe(0);
    expect(await count('select count(*) as n from deliverables')).toBe(0);
    expect(await count('select count(*) as n from activities')).toBe(0);
  });

  it('keeps programme-wide milestones apart from reforms', async () => {
    expect(await count("select count(*) as n from milestones where scope = 'programme'")).toBeGreaterThan(0);
    expect(await count("select count(*) as n from milestones where scope = 'programme' and reform_id is not null")).toBe(0);
  });

  it('loads all evidence as pending, because no files exist yet', async () => {
    expect(await count("select count(*) as n from evidence_items where validation_status <> 'pending'")).toBe(0);
  });

  it('shows every reform red, because the seed is stale since 29 Jul 2026 (correct, not a bug)', async () => {
    const { rows } = await client.query<{ reform_id: string; rag: string }>('select reform_id, rag from v_reform_summary');
    expect(rows.every((r) => r.rag === 'red')).toBe(true);
  });

  it('has the one reporting period locked', async () => {
    expect(await count('select count(*) as n from reporting_periods where is_locked')).toBe(1);
  });

  it('stores rule set 1.0.0 as current, with the same rules as rules/dq_rules.v1.json', async () => {
    const { rows } = await client.query<{ ruleset_version: string; rules: unknown }>(
      'select ruleset_version, rules from dq_rulesets where is_current',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ruleset_version).toBe('1.0.0');
    const fromFile: unknown = JSON.parse(readFileSync(join(ROOT, 'rules/dq_rules.v1.json'), 'utf8'));
    expect(rows[0]?.rules).toEqual(fromFile);
  });
});

describe('schema', () => {
  it('has row-level security on every table in public (CLAUDE.md rule 1)', async () => {
    const { rows } = await client.query<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
       order by 1`);
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('recorded every migration and seed file with its checksum', async () => {
    const { rows } = await client.query<{ file_name: string; checksum_sha256: string }>(
      'select file_name, checksum_sha256 from app_meta.schema_files order by file_name',
    );
    const expected = sqlFiles()
      .map((f) => ({ file_name: f.name, checksum_sha256: f.checksum }))
      .sort((a, b) => a.file_name.localeCompare(b.file_name));
    expect(rows).toEqual(expected);
  });
});

describe('db:migrate', () => {
  it('has nothing to apply on a freshly reset database', async () => {
    expect(await applyPending(client)).toEqual([]);
  });

  it('refuses to run when an applied file has been edited (forward-only)', async () => {
    await client.query('begin');
    try {
      await client.query("update app_meta.schema_files set checksum_sha256 = 'edited' where file_name like '0001_%'");
      await expect(applyPending(client)).rejects.toThrow(/changed after they were applied: 0001_core_schema\.sql/);
    } finally {
      await client.query('rollback');
    }
  });
});
