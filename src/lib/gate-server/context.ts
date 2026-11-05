// Loads the live data the gate needs for one submission (GateContext), with one query per kind
// of data rather than one per row, so a 2,000-row upload stays fast. Runs on the server's own
// database connection: it reads past row-level security, and only for this submission's rows.
import type pg from 'pg';
import { kinshasaToday } from '../gate/dates';
import { entityOfId, ENTITY_SPECS, SCHEMA_LISTS } from '../gate/entities';
import { TEMPLATE_VERSION } from '../gate/checks/file';
import type { RuleSet } from '../gate/rules';
import type { GateContext, GateRow, WorkbookInfo } from '../gate/types';

const trim = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** Every (type, id) the rows refer to, trimmed as the X01 auto-fix will trim them. */
function referencedObjects(rows: readonly GateRow[], ruleSet: RuleSet): [string, string][] {
  const found = new Map<string, [string, string]>();
  const add = (type: string | null, id: unknown) => {
    const clean = trim(id);
    if (type !== null && clean !== null) found.set(`${type}:${clean}`, [type, clean]);
  };
  for (const row of rows) {
    const spec = ENTITY_SPECS[row.entity];
    if (spec === undefined) continue;
    if (row.op === 'update') add(row.entity, row.id);
    for (const [field, type] of Object.entries(spec.references)) add(type, row.fields?.[field]);
    const sourceType = trim(row.fields?.['source_type']);
    if (row.entity === 'action' && sourceType !== null) add(sourceType, row.fields?.['source_id']);
    for (const link of row.links ?? []) add(trim(link.object_type), link.object_id);
    for (const id of row.evidence_ids ?? []) add('evidence_item', id);
    for (const id of row.depends_on ?? []) add(entityOfId(id.trim(), ruleSet.idPatterns), id);
    add('person', row.on_behalf_of_person_id);
  }
  return [...found.values()];
}

export async function loadGateContext(
  db: pg.ClientBase,
  submission: { submissionId: string; submittedBy: string; onBehalfOfPersonId: string | null; batchId: string | null },
  rows: readonly GateRow[],
  ruleSet: RuleSet,
  workbook?: WorkbookInfo,
): Promise<GateContext> {
  const lists = await db.query<{ list_name: string; codes: string[] }>(
    'select list_name, array_agg(code order by sort_order) as codes from lookup_values where is_active group by list_name',
  );

  const refs = referencedObjects(rows, ruleSet);
  const existing = await db.query<{ k: string }>(
    `select t || ':' || i as k from unnest($1::text[], $2::text[]) as x(t, i) where object_exists(t, i)`,
    [refs.map(([t]) => t), refs.map(([, i]) => i)],
  );

  const updates = rows
    .filter((row) => row.op === 'update' && trim(row.id) !== null && ENTITY_SPECS[row.entity] !== undefined)
    .map((row) => [row.entity, trim(row.id)!] as const);
  const stored = await db.query<{ k: string; record: Record<string, unknown> }>(
    `select t || ':' || i as k, object_record(t, i) as record from unnest($1::text[], $2::text[]) as x(t, i)
      where object_record(t, i) is not null`,
    [updates.map(([t]) => t), updates.map(([, i]) => i)],
  );
  const linked = await db.query<{ k: string }>(
    `select distinct l.object_type || ':' || l.object_id as k from evidence_links l
       join unnest($1::text[], $2::text[]) as x(t, i) on l.object_type = x.t and l.object_id = x.i`,
    [updates.map(([t]) => t), updates.map(([, i]) => i)],
  );
  const evidenceIds = updates.filter(([t]) => t === 'evidence_item').map(([, i]) => i);
  const evidenceWithLinks = await db.query<{ evidence_id: string }>(
    'select distinct evidence_id from evidence_links where evidence_id = any ($1)',
    [evidenceIds],
  );

  // B11: the same database functions approval uses, so the gate and approval cannot disagree.
  // Each row is checked for the person it was given by: the row's own (bulk upload) or the submission's.
  const trimmedRows = rows.map((row) => ({ ...row, id: trim(row.id) }));
  const scope = await db.query<{ reforms: string[]; ok: boolean }>(
    `select r.reforms,
            user_can_submit($2, x.e ->> 'entity', r.reforms)
              and (ob.user_id is null or user_can_submit(ob.user_id, x.e ->> 'entity', r.reforms)) as ok
       from jsonb_array_elements($1::jsonb) with ordinality as x(e, n)
       cross join lateral (select payload_row_reforms(x.e) as reforms) r
       left join lateral (
         select u.user_id from app_users u
          where u.is_active and u.person_id = coalesce(
            case when x.e ->> 'on_behalf_of_person_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (x.e ->> 'on_behalf_of_person_id')::uuid end,
            $3::uuid)) ob on true
      order by x.n`,
    [JSON.stringify(trimmedRows), submission.submittedBy, submission.onBehalfOfPersonId],
  );

  const locked = await db.query<{ period_end: string }>("select to_char(period_end, 'YYYY-MM-DD') as period_end from reporting_periods where is_locked");

  const valueRows = rows.filter((row) => row.entity === 'indicator_value');
  const keys = valueRows.map((row) => ({
    code: trim(row.fields?.['indicator_code']) ?? '',
    reform: trim(row.fields?.['reform_id']) ?? '',
    period: trim(row.fields?.['period_end']) ?? '',
  }));
  const previous = await db.query<{ k: string; value: string }>(
    `select x.code || '|' || x.reform || '|' || x.period as k, p.value
       from unnest($1::text[], $2::text[], $3::text[]) as x(code, reform, period),
            lateral (select v.value from indicator_values v
                      where v.indicator_code = x.code and coalesce(v.reform_id, '') = x.reform
                        and v.approval_status = 'approved' and v.value is not null
                        and x.period ~ '^\\d{4}-\\d{2}-\\d{2}$' and v.period_end < x.period::date
                      order by v.period_end desc limit 1) p`,
    [keys.map((k) => k.code), keys.map((k) => k.reform), keys.map((k) => k.period)],
  );

  const shas = rows.map((row) => trim(row.fields?.['file_sha256'])).filter((sha): sha is string => sha !== null);
  const files = await db.query<{ file_sha256: string; evidence_id: string }>(
    'select file_sha256, evidence_id from evidence_items where file_sha256 = any ($1)',
    [shas],
  );

  const accepted = workbook
    ? await db.query<{ file_sha256: string; accepted_on: string }>(
        `select b.file_sha256, to_char(min(r.started_at) at time zone 'Africa/Kinshasa', 'YYYY-MM-DD') as accepted_on
           from upload_batches b
           join submissions s on s.batch_id = b.batch_id and s.submission_id <> $2
           join dq_runs r on r.submission_id = s.submission_id and r.outcome = 'pass'
          where b.file_sha256 = $1 and r.started_at > now() - interval '90 days'
          group by b.file_sha256`,
        [workbook.sha256, submission.submissionId],
      )
    : { rows: [] };

  const dependencies = await db.query<{ from_key: string; to_key: string }>(
    "select from_type || ':' || from_id as from_key, to_type || ':' || to_id as to_key from dependencies",
  );

  return {
    today: kinshasaToday(),
    mode: 'gate',
    lists: { ...Object.fromEntries(lists.rows.map((r) => [r.list_name, r.codes])), ...SCHEMA_LISTS },
    existing: existing.rows.map((r) => r.k),
    stored: Object.fromEntries(stored.rows.map((r) => [r.k, r.record])),
    evidenceLinked: linked.rows.map((r) => r.k),
    evidenceWithLinks: evidenceWithLinks.rows.map((r) => r.evidence_id),
    rowScope: scope.rows.map((r) => r.ok),
    rowReforms: scope.rows.map((r) => r.reforms),
    lockedPeriods: locked.rows.map((r) => r.period_end),
    previousValues: Object.fromEntries(previous.rows.map((r) => [r.k, Number(r.value)])),
    evidenceFiles: Object.fromEntries(files.rows.map((r) => [r.file_sha256, r.evidence_id])),
    acceptedUploads: Object.fromEntries(accepted.rows.map((r) => [r.file_sha256, r.accepted_on])),
    dependencies: dependencies.rows.map((r) => [r.from_key, r.to_key] as const),
    supportedTemplateVersions: [TEMPLATE_VERSION],
  };
}
