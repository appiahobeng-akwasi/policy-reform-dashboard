// Delivery items (workstreams, deliverables, activities, milestones) for My items and the update
// card. Reads run as the signed-in user (row-level security); writes go through a submission,
// the gate and approval (CLAUDE.md rule 2).
import type pg from 'pg';
import { ENTITY_SPECS } from './gate/entities';
import type { GateRow } from './gate/types';
import { DELIVERY_ENTITIES, type DeliveryEntity } from './item-rows';

export { cardFields, DELIVERY_ENTITIES, isDeliveryEntity, type DeliveryEntity } from './item-rows';

export type Item = {
  entity: DeliveryEntity;
  id: string;
  record: Record<string, unknown>;
  /** updated_at as exact text, sent back with an update so approval can refuse a stale one (W10). */
  version: string;
  reformId: string | null;
  rag: string;
  daysOverdue: number;
  /** Days until the due date; null when overdue or there is no due date. */
  daysToDue: number | null;
  isStale: boolean;
  ownerName: string | null;
};

export async function loadItem(db: pg.PoolClient, entity: DeliveryEntity, id: string): Promise<Item | null> {
  const { table } = DELIVERY_ENTITIES[entity];
  const idField = ENTITY_SPECS[entity]!.idField;
  const { rows } = await db.query<{ record: Record<string, unknown>; version: string; reform_id: string | null; rag: string; days_overdue: number; days_to_due: number | null; is_stale: boolean; owner_name: string | null }>(
    `select to_jsonb(t) as record, t.updated_at::text as version, f.reform_id, f.rag, f.days_overdue, f.days_to_due, f.is_stale, p.full_name as owner_name
       from ${table} t
       join v_delivery_flags f on f.object_type = $1 and f.object_id = t.${idField}
       left join people p on p.person_id = t.owner_person_id
      where t.${idField} = $2 and t.archived_at is null`,
    [entity, id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    entity,
    id,
    record: row.record,
    version: row.version,
    reformId: row.reform_id,
    rag: row.rag,
    daysOverdue: row.days_overdue,
    daysToDue: row.days_to_due,
    isStale: row.is_stale,
    ownerName: row.owner_name,
  };
}

/** What the update card needs to show controlled values and owners, with labels in both languages. */
export async function loadChoices(db: pg.PoolClient) {
  const lists = await db.query<{ list_name: string; code: string; label_en: string; label_fr: string }>(
    "select list_name, code, label_en, label_fr from lookup_values where is_active and list_name in ('delivery_status', 'confidence') order by list_name, sort_order",
  );
  const people = await db.query<{ person_id: string; full_name: string }>('select person_id, full_name from people where is_active order by full_name');
  return { lists: lists.rows, people: people.rows };
}

export type Evidence = { evidenceId: string; title: string; validationStatus: string; hasFile: boolean };

export async function loadEvidence(db: pg.PoolClient, entity: DeliveryEntity, id: string): Promise<Evidence[]> {
  const { rows } = await db.query<{ evidence_id: string; title: string; validation_status: string; has_file: boolean }>(
    `select e.evidence_id, e.title, e.validation_status, e.file_path is not null as has_file
       from evidence_links l join evidence_items e on e.evidence_id = l.evidence_id
      where l.object_type = $1 and l.object_id = $2 order by e.evidence_id`,
    [entity, id],
  );
  return rows.map((r) => ({ evidenceId: r.evidence_id, title: r.title, validationStatus: r.validation_status, hasFile: r.has_file }));
}

export type LatestSubmission = {
  submissionId: string;
  rows: GateRow[];
  status: string;
  reviewNote: string | null;
  createdAt: string;
  findings: { ruleId: string; severity: string; field: string | null; messageEn: string; messageFr: string }[];
  qualityScore: number | null;
};

/** The signed-in person's latest submission for this item, with the gate's findings. */
export async function loadLatestSubmission(db: pg.PoolClient, entity: DeliveryEntity, id: string): Promise<LatestSubmission | null> {
  const { rows } = await db.query<{ submission_id: string; payload: { rows?: GateRow[] }; status: string; review_note: string | null; created_at: string; dq_run_id: string | null; quality_score: string | null }>(
    `select s.submission_id, s.payload, s.status, s.review_note, s.created_at::text, s.dq_run_id,
            (select r.quality_score from dq_runs r where r.submission_id = s.submission_id order by r.started_at desc, r.attempt_no desc limit 1) as quality_score
       from submissions s
      where s.submitted_by = (me()).user_id and s.status <> 'withdrawn'
        and s.payload -> 'rows' @> jsonb_build_array(jsonb_build_object('entity', $1::text, 'id', $2::text))
      order by s.created_at desc limit 1`,
    [entity, id],
  );
  const row = rows[0];
  if (!row) return null;
  const findings = await db.query<{ rule_id: string; severity: string; field: string | null; message_en: string; message_fr: string }>(
    `select f.rule_id, f.severity, f.field, f.message_en, f.message_fr from dq_findings f
      where f.dq_run_id = (select r.dq_run_id from dq_runs r where r.submission_id = $1 order by r.started_at desc, r.attempt_no desc limit 1)
      order by f.finding_id`,
    [row.submission_id],
  );
  return {
    submissionId: row.submission_id,
    rows: Array.isArray(row.payload.rows) ? row.payload.rows : [],
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    findings: findings.rows.map((f) => ({ ruleId: f.rule_id, severity: f.severity, field: f.field, messageEn: f.message_en, messageFr: f.message_fr })),
  };
}


/** One step in an item's activity (decision 81): sent, approved or returned, by whom, when. */
export type ActivityEvent = { at: string; event: 'sent' | 'approved' | 'returned'; actor: string | null; forPerson: string | null; note: string | null; route: string };

/** The item's activity, newest first. The database returns rows only to the item's owner, the leads of its reform and admins. */
export async function loadActivity(db: pg.PoolClient, entity: DeliveryEntity, id: string): Promise<ActivityEvent[]> {
  const { rows } = await db.query<{ at: string; event: ActivityEvent['event']; actor: string | null; for_person: string | null; note: string | null; route: string }>(
    'select at::text, event, actor, for_person, note, route from item_activity($1, $2)',
    [entity, id],
  );
  return rows.map((r) => ({ at: r.at, event: r.event, actor: r.actor, forPerson: r.for_person, note: r.note, route: r.route }));
}

/** Whether to offer the Activity tab: the same people the database shows it to (decision 81). */
export function mayReadActivity(user: { role: string; personId: string }, item: { reformId: string | null; record: Record<string, unknown> }, myReforms: string[]): boolean {
  if (user.role === 'super_admin' || user.role === 'programme_admin') return true;
  if (item.record['owner_person_id'] === user.personId) return true;
  return user.role === 'reform_lead' && item.reformId !== null && myReforms.includes(item.reformId);
}
