// Fixes in migrations 0004 and 0006, checked as the database owner.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl } from '../../scripts/lib/db';
import { inRollback } from './harness';

let client: pg.Client;

beforeAll(async () => {
  client = await connect(databaseUrl());
});

afterAll(async () => {
  await client?.end();
});

describe('v_reform_summary', () => {
  it('shows a reform with no items as grey', async () => {
    await inRollback(client, async () => {
      await client.query("insert into reforms (reform_id, name_en) values ('RA9', 'Reform with no items (test)')");
      const { rows } = await client.query<{ rag: string }>("select rag from v_reform_summary where reform_id = 'RA9'");
      expect(rows[0]!.rag).toBe('grey');
    });
  });

  it('gives the server risk and decision counts', async () => {
    const { rows } = await client.query<{ risks_open: string | null }>('select risks_open from v_reform_summary');
    expect(rows.every((r) => r.risks_open !== null)).toBe(true);
  });
});

describe('views respect row-level security', () => {
  it('every view runs with the rights of the person querying it', async () => {
    const { rows } = await client.query<{ relname: string; invoker: boolean }>(
      `select c.relname, coalesce('security_invoker=on' = any (c.reloptions) or 'security_invoker=true' = any (c.reloptions), false) as invoker
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v' order by c.relname`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.invoker).map((r) => r.relname)).toEqual([]);
  });
});

describe('pathway stage labels (decision 13)', () => {
  it('every stage has the French label from pathway_stages', async () => {
    const { rows } = await client.query<{ code: string; lookup_fr: string; stage_fr: string }>(
      `select p.code, l.label_fr as lookup_fr, p.label_fr as stage_fr
         from pathway_stages p join lookup_values l on l.list_name = 'pathway_stage' and l.code = p.code`,
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.lookup_fr, row.code).toBe(row.stage_fr);
      expect(row.lookup_fr, row.code).not.toBe(row.code);
    }
  });

  it('stays in step when a stage label is edited', async () => {
    await inRollback(client, async () => {
      await client.query("update pathway_stages set label_fr = 'Validation (modifié)' where code = 'validation'");
      const { rows } = await client.query<{ label_fr: string }>("select label_fr from lookup_values where list_name = 'pathway_stage' and code = 'validation'");
      expect(rows[0]!.label_fr).toBe('Validation (modifié)');
    });
  });
});

describe('submission_entities', () => {
  it('names only real tables and columns', async () => {
    const { rows } = await client.query<{ entity: string; missing: string[] }>(
      `select e.entity, array(select c from unnest(e.writable_columns || e.pk_column) c
                                where not table_has_column(e.table_name, c)) as missing
         from submission_entities e`,
    );
    expect(rows.length).toBe(12);
    expect(rows.filter((r) => r.missing.length > 0)).toEqual([]);
  });
});
