// Bulk upload on the server (spec 01 section 5.2): keep the original file for audit, read it,
// turn its rows into one submission, run the gate (file rules included), and let the person fix
// cells in the preview, each fix being a new attempt.
import { createHash } from 'node:crypto';
import manifest from '../../../templates/template_manifest.v1.json';
import { notifyEnteredFor, runGateForSubmission } from '../gate-server/run';
import type { Finding, GateResult, GateRow } from '../gate/types';
import { RULE_SET_V1 } from '../gate/rules';
import { ENTITY_TABLES } from '../entity-tables';
import { storage } from '../platform/s3-storage';
import { asUser, inServerTransaction } from '../server-db';
import { columnForField, mapRow, SHEETS, type Lookups, type MapOptions, type Stored } from './map';
import { readUpload, type Cell, type SourceRow } from './read';

type User = NonNullable<App.Locals['user']>;

export { BULK_ROLES } from './roles';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // F02 reports anything over 5 MB; the server refuses to keep more than 10 MB
const TABLES = ENTITY_TABLES;

/** Column letter of a template column on a sheet (A, B, ... AA). */
export function columnLetter(sheetName: string, column: string): string | null {
  const columns = (manifest.sheets as Record<string, string[]>)[sheetName];
  const index = columns?.indexOf(column) ?? -1;
  if (index < 0) return null;
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** The spreadsheet cell a finding points at, e.g. "L14", when it is about one column. */
export function cellFor(finding: Pick<Finding, 'sheet' | 'rowRef' | 'field'>): string | null {
  if (!finding.sheet || finding.rowRef === null) return null;
  const column = columnForField(finding.sheet, finding.field);
  const letter = column === null ? null : columnLetter(finding.sheet, column);
  return letter === null ? null : `${letter}${finding.rowRef}`;
}

/** Live data the mapping needs, read as the uploader through row-level security. */
async function loadLookups(user: User, sheets: Record<string, SourceRow[]>): Promise<Lookups> {
  const ids: Record<string, string[]> = {};
  const emails = new Set<string>();
  const valueKeys: { code: string; reform: string; period: string }[] = [];
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const sheet = SHEETS[sheetName];
    if (!sheet) continue;
    for (const { cells } of rows) {
      if (sheet.idColumn && typeof cells[sheet.idColumn] === 'string') (ids[sheet.entity] ??= []).push(String(cells[sheet.idColumn]).trim());
      for (const [column, map] of Object.entries(sheet.columns)) {
        const isPerson = 'person' in map || ('ignore' in map && map.ignore === 'reported_by');
        if (isPerson && cells[column] != null) emails.add(String(cells[column]).trim().toLowerCase());
      }
      if (sheet.entity === 'indicator_value' && cells['indicator_code'] != null && cells['period_end'] != null) {
        valueKeys.push({ code: String(cells['indicator_code']).trim(), reform: String(cells['reform_id'] ?? '').trim(), period: String(cells['period_end']) });
      }
    }
  }
  return asUser(user.claims, async (db) => {
    const people = await db.query<{ person_id: string; email: string }>('select person_id, lower(email) as email from people where lower(email) = any ($1)', [[...emails]]);
    const stored = new Map<string, Stored>();
    for (const [entity, list] of Object.entries(ids)) {
      const table = TABLES[entity];
      if (!table || list.length === 0) continue;
      const { rows } = await db.query<{ id: string; record: Record<string, unknown>; version: string }>(
        `select t.${table.idField} as id, to_jsonb(t) as record, coalesce(t.updated_at::text, '') as version from ${table.table} t where t.${table.idField} = any ($1)`,
        [list],
      );
      for (const row of rows) stored.set(`${entity}:${row.id}`, { record: row.record, version: row.version });
    }
    const values = await db.query<{ k: string; value_id: string; record: Record<string, unknown> }>(
      `select x.code || '|' || x.reform || '|' || x.period as k, v.value_id, to_jsonb(v) as record
         from unnest($1::text[], $2::text[], $3::text[]) as x(code, reform, period)
         join indicator_values v on v.indicator_code = x.code and coalesce(v.reform_id, '') = x.reform
          and x.period ~ '^\\d{4}-\\d{2}-\\d{2}$' and v.period_end = x.period::date and v.snapshot_type = $4`,
      [valueKeys.map((k) => k.code), valueKeys.map((k) => k.reform), valueKeys.map((k) => k.period), 'Monthly'],
    );
    const byKey = new Map(values.rows.map((r) => [r.k, r]));
    const personByEmail = new Map(people.rows.map((p) => [p.email, p.person_id]));
    return {
      idPatterns: RULE_SET_V1.idPatterns,
      personByEmail: (email) => personByEmail.get(email),
      stored: (entity, id) => stored.get(`${entity}:${id}`),
      indicatorValue: (code, reform, period) => {
        const found = byKey.get(`${code}|${reform ?? ''}|${period}`);
        // indicator_values has no updated_at; values are not version-checked.
        return found ? { id: found.value_id, record: found.record, version: '' } : undefined;
      },
    };
  });
}

/** Only the Secretariat enters updates for someone else (decision 30), so only their uploads attribute rows. */
export function mapOptionsFor(user: Pick<User, 'role'>): MapOptions {
  return { reportedByPerRow: user.role === 'programme_admin' || user.role === 'super_admin' };
}

function mapSheets(sheets: Record<string, SourceRow[]>, lookups: Lookups, options: MapOptions): GateRow[] {
  const rows: GateRow[] = [];
  for (const sheetName of Object.keys(manifest.sheets)) {
    for (const source of sheets[sheetName] ?? []) {
      const row = mapRow(sheetName, source, lookups, options);
      // Indicator values carry no version (the table has no updated_at).
      if (row.base_updated_at === '') delete row.base_updated_at;
      rows.push(row);
    }
  }
  return rows;
}

const gate = (user: User, submissionId: string, workbook?: Parameters<typeof runGateForSubmission>[1]['workbook']) =>
  inServerTransaction(async (db) => {
    const run = await runGateForSubmission(db, { submissionId, actingUserId: user.userId, cellFor, ...(workbook ? { workbook } : {}) });
    if (run.result.outcome === 'pass') await notifyEnteredFor(db, submissionId);
    return run;
  });

/** Keeps the original file, reads it and sends it through the gate. Every attempt is logged, even an unreadable file. */
export async function processUpload(
  user: User,
  file: { bytes: Uint8Array; fileName: string },
  previousSubmissionId: string | null = null,
): Promise<{ submissionId: string; result: GateResult }> {
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  const ext = (file.fileName.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const key = `uploads/${new Date().getUTCFullYear()}/${sha256}.${ext}`;
  if (!(await storage.exists(key))) await storage.put(key, file.bytes, 'application/octet-stream');

  const read = readUpload(file.bytes, file.fileName, sha256);
  const lookups = await loadLookups(user, read.sheets);
  const rows = mapSheets(read.sheets, lookups, mapOptionsFor(user));
  const reportedBy = [...new Set(Object.values(read.sheets).flatMap((r) => r.map((s) => s.cells['reported_by_email'])).filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()))];

  const submissionId = await asUser(user.claims, async (db) => {
    const batch = await db.query<{ batch_id: string }>(
      `insert into upload_batches (file_name, file_path, file_sha256, file_bytes, template_version, sheets_found, uploaded_by, reported_by_emails)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning batch_id`,
      [file.fileName.slice(0, 200), key, sha256, file.bytes.length, read.workbook.templateVersion, read.workbook.sheets.map((s) => s.name), user.userId, reportedBy],
    );
    const created = await db.query<{ submission_id: string }>(
      `insert into submissions (route, batch_id, submitted_by, payload, previous_submission_id) values ('bulk_upload', $1, $2, $3, $4) returning submission_id`,
      [batch.rows[0]!.batch_id, user.userId, JSON.stringify({ rows }), previousSubmissionId],
    );
    return created.rows[0]!.submission_id;
  });
  const { result } = await gate(user, submissionId, read.workbook);
  return { submissionId, result };
}

export type CellEdit = { rowIndex: number; column: string; value: string };

/** Fixes made in the preview: change the cells, map the rows again, and run the gate as the next attempt. */
export async function applyPreviewEdits(user: User, submissionId: string, edits: CellEdit[]): Promise<GateResult | null> {
  const rows = await asUser(user.claims, async (db) => {
    const { rows: found } = await db.query<{ payload: { rows: GateRow[] } }>(
      "select payload from submissions where submission_id = $1 and submitted_by = $2 and route = 'bulk_upload' and status in ('draft', 'rejected_by_gate', 'returned')",
      [submissionId, user.userId],
    );
    return found[0]?.payload.rows ?? null;
  });
  if (rows === null) return null;
  const touched = new Set<number>();
  for (const edit of edits) {
    const row = rows[edit.rowIndex];
    const sheet = row?.ref?.sheet;
    if (!row || !sheet || !SHEETS[sheet] || !(edit.column in SHEETS[sheet].columns)) continue;
    const value: Cell = edit.value.trim() === '' ? null : edit.value;
    row.source = { ...(row.source ?? {}), [edit.column]: value };
    touched.add(edit.rowIndex);
  }
  if (touched.size > 0) {
    const sources: Record<string, SourceRow[]> = {};
    for (const i of touched) {
      const row = rows[i]!;
      (sources[row.ref!.sheet!] ??= []).push({ row: row.ref!.row!, cells: row.source ?? {} });
    }
    const lookups = await loadLookups(user, sources);
    for (const i of touched) {
      const row = rows[i]!;
      const mapped = mapRow(row.ref!.sheet!, { row: row.ref!.row!, cells: row.source ?? {} }, lookups, mapOptionsFor(user));
      if (mapped.base_updated_at === '') delete mapped.base_updated_at;
      rows[i] = mapped;
    }
  }
  await asUser(user.claims, (db) =>
    db.query("update submissions set payload = $1, status = 'draft' where submission_id = $2 and submitted_by = $3", [JSON.stringify({ rows }), submissionId, user.userId]),
  );
  return (await gate(user, submissionId)).result;
}
