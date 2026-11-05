// Building submission rows from the update card. No server code, so the browser uses the same
// functions for its live hints as the server uses to save.
import { ENTITY_SPECS } from './gate/entities';
import type { GateRow } from './gate/types';

export const DELIVERY_ENTITIES = {
  workstream: { table: 'workstreams' },
  deliverable: { table: 'deliverables' },
  activity: { table: 'activities' },
  milestone: { table: 'milestones' },
} as const;
export type DeliveryEntity = keyof typeof DELIVERY_ENTITIES;

export function isDeliveryEntity(value: unknown): value is DeliveryEntity {
  return typeof value === 'string' && value in DELIVERY_ENTITIES;
}

/** Fields on the update card, in order. Owner only for reform leads and admins (decision 23). */
export function cardFields(entity: DeliveryEntity, canAssignOwner: boolean): string[] {
  const spec = ENTITY_SPECS[entity]!;
  const fields = ['status', 'progress_pct', 'forecast_date', 'actual_date', 'next_action', 'blocker', 'comments', 'evidence_confidence'];
  return [...(canAssignOwner ? ['owner_person_id'] : []), ...fields.filter((f) => spec.writable.includes(f))];
}

/** A form value as it should be stored: blank is null; progress is a number when it is one. */
export function formValue(field: string, raw: FormDataEntryValue | null): unknown {
  if (raw === null || typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;
  if (field === 'progress_pct' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  return String(a) === String(b);
}

/**
 * The update row: only the fields that changed (docs/04: send only changed fields). A "nothing
 * changed" confirmation is an update with no fields; approval then refreshes last_confirmed_at.
 */
export function buildUpdateRow(
  item: { entity: DeliveryEntity; id: string; record: Record<string, unknown>; version: string },
  values: Record<string, unknown>,
  allowedFields: readonly string[],
): GateRow {
  const fields: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (!(field in values)) continue;
    if (!sameValue(values[field], item.record[field])) fields[field] = values[field];
  }
  return { entity: item.entity, op: 'update', id: item.id, fields, base_updated_at: item.version };
}

/** An evidence row for a checked upload, linked to the item (B09, B16). */
export function evidenceRow(
  upload: { upload_id: string; file_name: string; file_path: string; file_sha256: string; file_mime: string; file_bytes: number },
  details: { title: string; evidenceType: string; evidenceDate: string | null; sourceInstitution: string | null },
  item: { entity: string; id: string },
): GateRow {
  return {
    entity: 'evidence_item',
    op: 'create',
    fields: {
      title: details.title,
      evidence_type: details.evidenceType,
      evidence_date: details.evidenceDate,
      source_institution: details.sourceInstitution,
      access_level: 'restricted',
      file_path: upload.file_path,
      file_sha256: upload.file_sha256,
      file_mime: upload.file_mime,
      file_bytes: Number(upload.file_bytes),
    },
    links: [{ object_type: item.entity, object_id: item.id }],
    upload_id: upload.upload_id,
  };
}
