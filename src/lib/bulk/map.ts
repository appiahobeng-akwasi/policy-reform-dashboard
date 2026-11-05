// Turns template rows (templates/template_manifest.v1.json) into submission rows. Pure: the
// live data it needs (people by email, stored records) comes in as Lookups.
//
//   - An ID that exists means update, with only the changed, non-blank cells (decision 27).
//   - An ID that does not exist means a new item with that ID; a blank ID means a new item
//     without one, which rule B01 refuses on uploads (open question 25).
//   - Indicator values have no ID column: they are matched on indicator, reform and period.
//   - Owner emails become people; reform lists and linked objects become links.
import { entityOfId } from '../gate/entities';
import type { GateRow } from '../gate/types';
import type { Cell, SourceRow } from './read';

type ColumnMap =
  | { field: string }
  | { person: string }
  | { yesNo: string }
  | { links: 'reform' | 'any' }
  | { list: 'evidence_ids' | 'depends_on' }
  | { ignore: 'reported_by' | 'not_used' };

export type SheetMap = { entity: string; idColumn: string | null; columns: Record<string, ColumnMap> };

const f = (field: string): ColumnMap => ({ field });
const same = (...names: string[]) => Object.fromEntries(names.map((n) => [n, f(n)]));
const REPORTED_BY = { reported_by_email: { ignore: 'reported_by' } } as const;

export const SHEETS: Record<string, SheetMap> = {
  Workstreams: {
    entity: 'workstream',
    idColumn: 'workstream_id',
    columns: {
      ...same('workstream_id', 'reform_id', 'name', 'workstream_type', 'start_date', 'due_date', 'status', 'progress_pct', 'rag_override', 'rag_override_reason', 'next_action', 'blocker', 'comments'),
      owner_email: { person: 'owner_person_id' },
      ...REPORTED_BY,
    },
  },
  Deliverables: {
    entity: 'deliverable',
    idColumn: 'deliverable_id',
    columns: {
      ...same('deliverable_id', 'workstream_id', 'name', 'description', 'start_date', 'due_date', 'forecast_date', 'actual_date', 'status', 'progress_pct', 'evidence_confidence', 'next_action', 'blocker', 'comments'),
      owner_email: { person: 'owner_person_id' },
      evidence_ids: { list: 'evidence_ids' },
      depends_on: { list: 'depends_on' },
      ...REPORTED_BY,
    },
  },
  Activities: {
    entity: 'activity',
    idColumn: 'activity_id',
    columns: {
      ...same('activity_id', 'deliverable_id', 'name', 'start_date', 'due_date', 'forecast_date', 'actual_date', 'status', 'progress_pct', 'next_action', 'blocker', 'comments'),
      owner_email: { person: 'owner_person_id' },
      depends_on: { list: 'depends_on' },
      ...REPORTED_BY,
    },
  },
  Milestones: {
    entity: 'milestone',
    idColumn: 'milestone_id',
    columns: {
      ...same('milestone_id', 'reform_id', 'deliverable_id', 'name', 'milestone_type', 'pathway_stage', 'planned_date', 'forecast_date', 'actual_date', 'status', 'evidence_confidence', 'next_action', 'blocker', 'comments'),
      is_decision_gate: { yesNo: 'is_decision_gate' },
      owner_email: { person: 'owner_person_id' },
      evidence_ids: { list: 'evidence_ids' },
      ...REPORTED_BY,
    },
  },
  Stage_Updates: {
    entity: 'reform_stage',
    idColumn: 'stage_record_id',
    columns: {
      ...same('stage_record_id', 'reform_id', 'stage', 'entry_date', 'exit_date', 'status', 'escalation_to', 'comments'),
      evidence_ids: { list: 'evidence_ids' },
      // Validation is done by MERL, not by upload (decision 29).
      validation_status: { ignore: 'not_used' },
      responsible_email: { person: 'responsible_person_id' },
      escalation_needed: { yesNo: 'escalation_needed' },
      ...REPORTED_BY,
    },
  },
  Risks: {
    entity: 'risk',
    idColumn: 'risk_id',
    columns: {
      ...same('risk_id', 'category', 'description', 'likelihood', 'impact', 'mitigation', 'trigger', 'residual_likelihood', 'residual_impact', 'treatment', 'review_date', 'status'),
      reform_ids: { links: 'reform' },
      owner_email: { person: 'owner_person_id' },
      ...REPORTED_BY,
    },
  },
  Decisions: {
    entity: 'decision',
    idColumn: 'decision_id',
    columns: {
      ...same('decision_id', 'decision_date', 'decision_type', 'decision_body', 'decision_maker', 'summary', 'reason', 'follow_up_action', 'follow_up_due', 'status'),
      reform_ids: { links: 'reform' },
      follow_up_owner_email: { person: 'follow_up_owner_person_id' },
      evidence_ids: { list: 'evidence_ids' },
      ...REPORTED_BY,
    },
  },
  Actions: {
    entity: 'action',
    idColumn: 'action_id',
    columns: {
      ...same('action_id', 'source_type', 'source_id', 'description', 'due_date', 'status', 'comments'),
      owner_email: { person: 'owner_person_id' },
      ...REPORTED_BY,
    },
  },
  Indicator_Values: {
    entity: 'indicator_value',
    idColumn: null,
    columns: {
      ...same('indicator_code', 'reform_id', 'period_end', 'value', 'confidence', 'evidence_basis', 'comment'),
      is_proxy: { yesNo: 'is_proxy' },
      evidence_ids: { list: 'evidence_ids' },
      ...REPORTED_BY,
    },
  },
  Evidence_Register: {
    entity: 'evidence_item',
    idColumn: 'evidence_id',
    columns: {
      ...same('evidence_id', 'title', 'evidence_type', 'source_institution', 'evidence_date', 'external_url'),
      linked_objects: { links: 'any' },
      // Evidence has no comments field (decision 29).
      comments: { ignore: 'not_used' },
      ...REPORTED_BY,
    },
  },
};

/** New indicator values from an upload are monthly values (the template has no snapshot column). */
export const UPLOAD_SNAPSHOT_TYPE = 'Monthly';

export type Stored = { record: Record<string, unknown>; version: string };

export type Lookups = {
  idPatterns: Record<string, string>;
  /** person_id for an email (lower case), if that person exists. */
  personByEmail: (email: string) => string | undefined;
  /** The stored item, if the ID exists. */
  stored: (entity: string, id: string) => Stored | undefined;
  /** An existing indicator value with this indicator, reform (or programme) and period. */
  indicatorValue: (code: string, reformId: string | null, periodEnd: string) => (Stored & { id: string }) | undefined;
};

const blank = (value: Cell | undefined): boolean => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const items = (value: Cell): string[] =>
  String(value)
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');

/** yes/no as the template's list has it, also oui/non and true/false; anything else is kept for B04 to flag. */
function yesNo(value: Cell): Cell {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['yes', 'oui', 'true', 'y', '1'].includes(text)) return true;
  if (['no', 'non', 'false', 'n', '0'].includes(text)) return false;
  return String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  return String(a) === String(b);
}

export type MapOptions = {
  /** Uploads by the Secretariat attribute each row to its reported_by_email person (decision 33). */
  reportedByPerRow?: boolean;
};

export function mapRow(sheetName: string, source: SourceRow, lookups: Lookups, options: MapOptions = {}): GateRow {
  const sheet = SHEETS[sheetName];
  if (!sheet) throw new TypeError(`No mapping for sheet ${sheetName}.`);
  const cells = source.cells;
  const fields: Record<string, unknown> = {};
  const links: { object_type: string; object_id: string }[] = [];
  const lists: { evidence_ids?: string[]; depends_on?: string[] } = {};
  const ignored: string[] = [];
  let reportedBy: string | undefined;

  for (const [column, map] of Object.entries(sheet.columns)) {
    const value = cells[column];
    if (blank(value)) continue;
    if ('field' in map) fields[map.field] = value;
    else if ('person' in map) fields[map.person] = lookups.personByEmail(String(value).trim().toLowerCase()) ?? String(value).trim();
    else if ('yesNo' in map) fields[map.yesNo] = yesNo(value!);
    else if ('links' in map) {
      for (const id of items(value!)) links.push({ object_type: map.links === 'reform' ? 'reform' : (entityOfId(id, lookups.idPatterns) ?? 'unknown'), object_id: id });
    } else if ('list' in map) lists[map.list] = items(value!);
    else if (map.ignore === 'not_used') ignored.push(column);
    else if (map.ignore === 'reported_by' && options.reportedByPerRow) {
      // An unknown email is kept so rule B03 can flag it, like an unknown owner.
      reportedBy = lookups.personByEmail(String(value).trim().toLowerCase()) ?? String(value).trim();
    }
  }

  const ref = { sheet: sheetName, row: source.row };
  const common = {
    ...(links.length > 0 ? { links } : {}),
    ...lists,
    ...(reportedBy !== undefined ? { on_behalf_of_person_id: reportedBy } : {}),
    ref,
    source: cells,
    ...(ignored.length > 0 ? { ignored } : {}),
  };

  // The ID column is the item's ID, not a field to write.
  const id = sheet.idColumn === null || blank(cells[sheet.idColumn]) ? null : String(cells[sheet.idColumn]);
  if (sheet.idColumn !== null) delete fields[sheet.idColumn];

  let existing: (Stored & { id: string }) | undefined;
  if (sheet.entity === 'indicator_value') {
    const code = fields['indicator_code'];
    const period = fields['period_end'];
    if (typeof code === 'string' && typeof period === 'string') {
      existing = lookups.indicatorValue(code.trim(), typeof fields['reform_id'] === 'string' ? fields['reform_id'].trim() : null, period);
    }
  } else if (id !== null) {
    const stored = lookups.stored(sheet.entity, id.trim());
    if (stored) existing = { ...stored, id };
  }

  if (!existing) {
    if (sheet.entity === 'indicator_value') fields['snapshot_type'] = UPLOAD_SNAPSHOT_TYPE;
    return { entity: sheet.entity, op: 'create', ...(id !== null ? { id } : {}), fields, ...common };
  }
  // Update: only cells that differ from what is stored. Blank cells were skipped above (decision 27).
  const changed = Object.fromEntries(Object.entries(fields).filter(([field, value]) => !sameValue(value, existing.record[field])));
  return { entity: sheet.entity, op: 'update', id: existing.id, fields: changed, base_updated_at: existing.version, ...common };
}

/** Template column for a finding's field, so the preview can colour the right cell. */
export function columnForField(sheetName: string, field: string | null): string | null {
  const sheet = SHEETS[sheetName];
  if (!sheet || field === null) return null;
  for (const [column, map] of Object.entries(sheet.columns)) {
    if ('field' in map && map.field === field) return column;
    if ('person' in map && map.person === field) return column;
    if ('yesNo' in map && map.yesNo === field) return column;
    if ('list' in map && map.list === field) return column;
    if ('links' in map && field === 'links') return column;
  }
  if (field === 'evidence' && 'evidence_ids' in sheet.columns) return 'evidence_ids';
  if (field === 'on_behalf_of_person_id') return 'reported_by_email';
  return null;
}
