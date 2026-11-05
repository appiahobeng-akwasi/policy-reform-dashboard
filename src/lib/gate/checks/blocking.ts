// Blocking rules B01 to B16. One failure rejects the submission, whatever the score.
import { dateOf, isIsoDate } from '../dates';
import { entityOfId, textFields } from '../entities';
import {
  checked,
  exists,
  failIf,
  hasEvidence,
  isActive,
  isBlank,
  NA,
  numberOf,
  PASS,
  status,
  text,
  UNKNOWN,
  type CheckRow,
  type Failure,
  type RowCheck,
} from './common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_MIN = '2026-01-01';
const DATE_MAX = '2031-12-31';
const TEXT_MAX = 2000;
const HTML_OR_SCRIPT = /<\s*\/?\s*[a-z!?][^>]*>|javascript\s*:/i;
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const EVIDENCE_TYPES: Record<string, readonly string[]> = {
  pdf: ['application/pdf'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

/** Every (field, id) reference a row makes, for B03. */
function references(row: CheckRow, idPatterns: Record<string, string>): { field: string; type: string | null; id: string }[] {
  const found: { field: string; type: string | null; id: string }[] = [];
  for (const [field, type] of Object.entries(row.spec.references)) {
    const value = text(row.fields[field]);
    if (value !== null) found.push({ field, type, id: value });
  }
  if (row.entity === 'action') {
    const sourceType = text(row.merged['source_type']);
    const sourceId = text(row.fields['source_id']);
    if (sourceId !== null && (sourceType === 'decision' || sourceType === 'risk' || sourceType === 'adaptation')) {
      found.push({ field: 'source_id', type: sourceType, id: sourceId });
    }
  }
  for (const link of row.row.links ?? []) found.push({ field: 'links', type: link.object_type, id: link.object_id });
  for (const id of row.row.evidence_ids ?? []) found.push({ field: 'evidence_ids', type: 'evidence_item', id });
  for (const id of row.row.depends_on ?? []) found.push({ field: 'depends_on', type: entityOfId(id, idPatterns), id });
  if (row.row.on_behalf_of_person_id) found.push({ field: 'on_behalf_of_person_id', type: 'person', id: row.row.on_behalf_of_person_id });
  return found;
}

export const BLOCKING: Record<string, RowCheck> = {
  B01(row, env) {
    const field = row.spec.idField;
    if (row.id === null) {
      const allowed = row.op === 'create' && row.spec.generatesId && (env.route === 'web_form' || row.spec.idPattern === null);
      return failIf(!allowed, { field, value: '', vars: { example: row.spec.example } });
    }
    const pattern = row.spec.idPattern === null ? UUID : new RegExp(env.ruleSet.idPatterns[row.spec.idPattern] ?? '^$');
    return failIf(!pattern.test(row.id), { field, value: row.id, vars: { example: row.spec.example } });
  },

  B02(row, env) {
    if (row.id === null) return NA;
    const first = env.rows.find((other) => other.entity === row.entity && other.id === row.id);
    return failIf(first !== undefined && first.index !== row.index, { field: row.spec.idField, value: row.id });
  },

  B03(row, env) {
    const failures: Failure[] = [];
    let unknown = false;
    if (row.op === 'update' && row.id !== null) {
      const found = exists(env, row.entity, row.id);
      if (found === undefined) unknown = true;
      else if (!found) failures.push({ field: row.spec.idField, value: row.id });
    }
    for (const ref of references(row, env.ruleSet.idPatterns)) {
      if (ref.type === null) {
        failures.push({ field: ref.field, value: ref.id });
        continue;
      }
      const found = exists(env, ref.type, ref.id);
      if (found === undefined) unknown = true;
      else if (!found) failures.push({ field: ref.field, value: ref.id });
    }
    if (failures.length === 0 && unknown) return UNKNOWN;
    return checked(failures);
  },

  B04(row, env) {
    const failures: Failure[] = [];
    for (const [field, listName] of Object.entries(row.spec.controlled)) {
      const value = text(row.fields[field]);
      const list = env.context.lists[listName];
      if (value === null || list === undefined) continue;
      if (!list.includes(value)) failures.push({ field, value, vars: { allowed: list.join(', ') } });
    }
    // Yes/no fields come from the template's yes_no list; the upload reads yes/no as true/false.
    for (const field of row.spec.booleans) {
      const value = row.fields[field];
      if (value === undefined || value === null || typeof value === 'boolean') continue;
      failures.push({ field, value, vars: { allowed: 'yes, no' } });
    }
    return checked(failures);
  },

  B05(row) {
    const failures: Failure[] = [];
    for (const field of row.spec.dates) {
      const value = row.fields[field];
      if (isBlank(value)) continue;
      const date = field === 'completed_at' ? dateOf(value) : isIsoDate(value) ? value : null;
      if (date === null || date < DATE_MIN || date > DATE_MAX) failures.push({ field, value });
    }
    return checked(failures);
  },

  B06(row) {
    const { startField, dueField } = row.spec;
    if (startField === null || dueField === null || startField === dueField) return NA;
    const start = row.merged[startField];
    const due = row.merged[dueField];
    if (!isIsoDate(start) || !isIsoDate(due)) return NA;
    return failIf(start > due, { field: startField, value: start });
  },

  B07(row, env) {
    const field = row.spec.actualField;
    if (field === null) return NA;
    const actual = row.merged[field];
    if (!isIsoDate(actual)) return NA;
    return failIf(actual > env.context.today, { field, value: actual });
  },

  B08(row) {
    const field = row.spec.ownerField;
    if (field === null || !isActive(row)) return NA;
    return failIf(isBlank(row.merged[field]), { field });
  },

  B09(row, env) {
    if (status(row) !== 'complete') return NA;
    const evidence = hasEvidence(row, env);
    if (evidence === undefined) return UNKNOWN;
    const dateField = row.spec.actualField;
    const dated = dateField !== null && !isBlank(row.merged[dateField]);
    return failIf(!evidence || !dated, { field: evidence ? dateField : 'evidence' });
  },

  B10(row) {
    const failures: Failure[] = [];
    for (const [field, rule] of Object.entries(row.spec.numbers)) {
      const value = row.fields[field];
      if (isBlank(value)) continue;
      const n = numberOf(value);
      const bad = n === null || (rule.integer && !Number.isInteger(n)) || n < rule.min || (rule.max !== null && n > rule.max);
      if (bad) failures.push({ field, value, vars: { min: rule.min, max: rule.max ?? '∞' } });
    }
    return checked(failures);
  },

  B11(row, env) {
    const allowed = env.context.rowScope?.[row.index];
    if (allowed === undefined) return UNKNOWN;
    const reforms = env.context.rowReforms?.[row.index] ?? [];
    return failIf(!allowed, { field: 'reform_id', value: reforms.length > 0 ? reforms.join(', ') : row.id ?? row.entity });
  },

  B12(row, env) {
    const period = row.merged['period_end'];
    if (!isIsoDate(period)) return NA;
    if (env.context.lockedPeriods === undefined) return UNKNOWN;
    return failIf(env.context.lockedPeriods.includes(period), { field: 'period_end', value: period });
  },

  B13(row) {
    if (status(row) !== 'not_started') return NA;
    const field = row.spec.actualField ?? 'actual_date';
    return failIf(!isBlank(row.merged[field]), { field, value: row.merged[field] });
  },

  B14(row) {
    const failures: Failure[] = [];
    for (const field of textFields(row.spec)) {
      const value = row.fields[field];
      if (typeof value !== 'string') continue;
      if (value.length > TEXT_MAX || HTML_OR_SCRIPT.test(value)) failures.push({ field, value: value.slice(0, 80) });
    }
    return checked(failures);
  },

  B15(row, env) {
    const path = text(row.merged['file_path']);
    const sha = text(row.merged['file_sha256']);
    if (path === null && sha === null) return NA;
    const extension = path?.split('.').pop()?.toLowerCase() ?? '';
    const mime = text(row.merged['file_mime']);
    const typeOk = extension in EVIDENCE_TYPES && (mime === null || (EVIDENCE_TYPES[extension] ?? []).includes(mime));
    const bytes = numberOf(row.merged['file_bytes']);
    const sizeOk = bytes !== null && bytes <= EVIDENCE_MAX_BYTES;
    if (!typeOk || !sizeOk) return checked([{ field: 'file', value: path, vars: { existing: '' } }]);
    if (sha === null) return PASS;
    if (env.context.evidenceFiles === undefined) return UNKNOWN;
    const existing = env.context.evidenceFiles[sha];
    return failIf(existing !== undefined && existing !== row.id, { field: 'file', value: path, vars: { existing } });
  },

  B16(row, env) {
    if ((row.row.links ?? []).length > 0) return PASS;
    if (row.op === 'create' || row.id === null) return checked([{ field: 'links' }]);
    if (env.context.evidenceWithLinks === undefined) return UNKNOWN;
    return failIf(!env.context.evidenceWithLinks.includes(row.id), { field: 'links' });
  },
};
