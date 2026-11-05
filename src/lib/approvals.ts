// The approvals screen (spec 01 section 7): the queue, one submission side by side, and the
// approve and return actions. Every read runs as the approver; who may approve what is decided
// by the database (can_i_approve, approve_submission), never here.
import { ENTITY_TABLES } from './entity-tables';
import type { GateRow } from './gate/types';
import { asUser } from './server-db';

type User = NonNullable<App.Locals['user']>;

export type QueueItem = {
  submissionId: string;
  route: string;
  createdAt: string;
  submittedBy: string;
  onBehalfOf: string | null;
  entities: string[];
  reformIds: string[];
  rowCount: number;
  qualityScore: number | null;
  isConfirmation: boolean;
  fileName: string | null;
  /** The first item in the update, so the inbox can name it ("MS-008: Working group set up"). */
  first: { type: string; id: string; name: string | null } | null;
};

export async function loadQueue(user: User): Promise<QueueItem[]> {
  return asUser(user.claims, async (db) => {
    const { rows } = await db.query<{
      submission_id: string;
      route: string;
      created_at: string;
      submitted_by_name: string;
      on_behalf_name: string | null;
      entities: string[];
      reform_ids: string[];
      row_count: number;
      quality_score: string | null;
      is_confirmation: boolean;
      file_name: string | null;
      first_type: string | null;
      first_id: string | null;
      first_name: string | null;
    }>(
      `select a.*, a.created_at::text, r.entity as first_type, r.id as first_id, f.name as first_name
         from approvable_submissions() a
         left join submissions s on s.submission_id = a.submission_id
         left join lateral (select e ->> 'entity' as entity, e ->> 'id' as id
                              from jsonb_array_elements(s.payload -> 'rows') with ordinality as x(e, n)
                             where e ->> 'entity' in ('workstream', 'deliverable', 'activity', 'milestone')
                             order by n limit 1) r on true
         left join v_delivery_flags f on f.object_type = r.entity and f.object_id = r.id
        order by a.created_at, a.submission_id`,
    );
    return rows.map((r) => ({
      submissionId: r.submission_id,
      route: r.route,
      createdAt: r.created_at,
      submittedBy: r.submitted_by_name,
      onBehalfOf: r.on_behalf_name,
      entities: r.entities,
      reformIds: r.reform_ids,
      rowCount: r.row_count,
      qualityScore: r.quality_score === null ? null : Number(r.quality_score),
      isConfirmation: r.is_confirmation,
      fileName: r.file_name,
      first: r.first_type && r.first_id ? { type: r.first_type, id: r.first_id, name: r.first_name } : null,
    }));
  });
}

export type Change = { field: string; current: unknown; proposed: unknown };
export type ReviewRow = {
  index: number;
  entity: string;
  id: string | null;
  name: string | null;
  op: 'create' | 'update';
  sheet: string | null;
  sheetRow: number | null;
  changes: Change[];
  isConfirmation: boolean;
  links: string[];
  evidenceIds: string[];
  dependsOn: string[];
  reportedBy: string | null;
};

export type Review = {
  submissionId: string;
  status: string;
  route: string;
  createdAt: string;
  submittedBy: string;
  onBehalfOf: string | null;
  channel: string | null;
  receivedOn: string | null;
  note: string | null;
  canApprove: boolean;
  canBreakGlass: boolean;
  quality: { score: number | null; threshold: number | null; points: { severity: string; ruleId: string; field: string | null; sheet: string | null; rowRef: number | null; messageEn: string; messageFr: string }[] };
  files: { kind: string; label: string; path: string }[];
  rows: ReviewRow[];
  totalRows: number;
  /** Labels for controlled values and names for people, so values read as words. */
  labels: Record<string, { en: string; fr: string }>;
  people: Record<string, string>;
};

const NAME_FIELDS = ['name', 'title', 'summary', 'description', 'change_requested'];

export async function loadReview(user: User, submissionId: string, page: number, pageSize: number): Promise<Review | null> {
  return asUser(user.claims, async (db) => {
    const allowed = await db.query<{ ok: boolean }>('select may_see_submission_detail($1) as ok', [submissionId]);
    if (!allowed.rows[0]?.ok) return null;
    const found = await db.query<{
      status: string;
      route: string;
      created_at: string;
      payload: { rows?: GateRow[] };
      submitted_by: string;
      on_behalf: string | null;
      on_behalf_channel: string | null;
      on_behalf_received_on: string | null;
      on_behalf_note: string | null;
    }>(
      `select s.status, s.route, s.created_at::text, s.payload, coalesce(user_display_name(s.submitted_by), '') as submitted_by, pb.full_name as on_behalf,
              s.on_behalf_channel, s.on_behalf_received_on::text, s.on_behalf_note
         from submissions s
         left join people pb on pb.person_id = s.on_behalf_of_person_id
        where s.submission_id = $1`,
      [submissionId],
    );
    const submission = found.rows[0];
    if (!submission) return null;
    const [canApprove, canBreakGlass, quality, files, lookups] = await Promise.all([
      db.query<{ ok: boolean }>('select can_i_approve($1) as ok', [submissionId]),
      db.query<{ ok: boolean }>("select my_role() = 'super_admin' and can_i_approve($1, true) as ok", [submissionId]),
      db.query<{ quality_score: string | null; threshold: string | null; rule_id: string | null; severity: string | null; field: string | null; sheet: string | null; row_ref: number | null; message_en: string | null; message_fr: string | null }>(
        'select * from submission_quality($1)',
        [submissionId],
      ),
      db.query<{ kind: string; label: string; file_path: string }>('select * from review_files($1)', [submissionId]),
      db.query<{ list_name: string; code: string; label_en: string; label_fr: string }>('select list_name, code, label_en, label_fr from lookup_values'),
    ]);

    const allRows = submission.payload.rows ?? [];
    const pageRows = allRows.slice((page - 1) * pageSize, page * pageSize);
    // Current values of the items this page of rows updates.
    const current = new Map<string, Record<string, unknown>>();
    for (const [entity, table] of Object.entries(ENTITY_TABLES)) {
      const ids = pageRows.filter((r) => r.entity === entity && r.op === 'update' && r.id).map((r) => String(r.id).trim());
      if (ids.length === 0) continue;
      const { rows } = await db.query<{ id: string; record: Record<string, unknown> }>(
        `select t.${table.idField}::text as id, to_jsonb(t) as record from ${table.table} t where t.${table.idField}::text = any ($1)`,
        [ids],
      );
      for (const row of rows) current.set(`${entity}:${row.id}`, row.record);
    }
    const personIds = new Set<string>();
    const rows: ReviewRow[] = pageRows.map((row, i) => {
      const record = row.id ? (current.get(`${row.entity}:${String(row.id).trim()}`) ?? {}) : {};
      const fields = row.fields ?? {};
      const changes = Object.entries(fields).map(([field, proposed]) => ({ field, current: row.op === 'update' ? (record[field] ?? null) : null, proposed }));
      for (const change of changes) {
        for (const v of [change.current, change.proposed]) if (typeof v === 'string' && /person_id$/.test(change.field)) personIds.add(v);
      }
      if (row.on_behalf_of_person_id) personIds.add(row.on_behalf_of_person_id);
      const nameField = NAME_FIELDS.find((f) => typeof (fields[f] ?? record[f]) === 'string');
      const isConfirmation = row.op === 'update' && changes.length === 0 && !row.links?.length && !row.evidence_ids?.length && !row.depends_on?.length;
      return {
        index: (page - 1) * pageSize + i,
        entity: row.entity,
        id: row.id ?? null,
        name: nameField ? String(fields[nameField] ?? record[nameField]) : null,
        op: row.op,
        sheet: row.ref?.sheet ?? null,
        sheetRow: row.ref?.row ?? null,
        changes,
        isConfirmation,
        links: (row.links ?? []).map((l) => l.object_id),
        evidenceIds: row.evidence_ids ?? [],
        dependsOn: row.depends_on ?? [],
        reportedBy: row.on_behalf_of_person_id ?? null,
      };
    });
    const people = personIds.size
      ? Object.fromEntries((await db.query<{ person_id: string; full_name: string }>('select person_id::text, full_name from people where person_id::text = any ($1)', [[...personIds]])).rows.map((p) => [p.person_id, p.full_name]))
      : {};
    const first = quality.rows[0];
    return {
      submissionId,
      status: submission.status,
      route: submission.route,
      createdAt: submission.created_at,
      submittedBy: submission.submitted_by,
      onBehalfOf: submission.on_behalf,
      channel: submission.on_behalf_channel,
      receivedOn: submission.on_behalf_received_on,
      note: submission.on_behalf_note,
      canApprove: canApprove.rows[0]?.ok === true,
      canBreakGlass: canBreakGlass.rows[0]?.ok === true,
      quality: {
        score: first?.quality_score == null ? null : Number(first.quality_score),
        threshold: first?.threshold == null ? null : Number(first.threshold),
        points: quality.rows
          .filter((q) => q.rule_id !== null)
          .map((q) => ({ severity: q.severity!, ruleId: q.rule_id!, field: q.field, sheet: q.sheet, rowRef: q.row_ref, messageEn: q.message_en!, messageFr: q.message_fr! })),
      },
      files: files.rows.map((f) => ({ kind: f.kind, label: f.label, path: f.file_path })),
      rows,
      totalRows: allRows.length,
      labels: Object.fromEntries(lookups.rows.map((l) => [`${l.list_name}:${l.code}`, { en: l.label_en, fr: l.label_fr }])),
      people,
    };
  });
}

export type ActionResult = { ok: true } | { ok: false; code: string };

/** The workflow code at the start of a database error (W05, B11 ...), or 'other'. */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(W\d\d|B\d\d)\b/.exec(message)?.[1] ?? 'other';
}

export async function approve(user: User, submissionId: string, note: string | null, breakGlass: boolean): Promise<ActionResult> {
  try {
    await asUser(user.claims, (db) => db.query('select approve_submission($1, $2, $3)', [submissionId, note, breakGlass]));
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

export async function returnForChanges(user: User, submissionId: string, note: string): Promise<ActionResult> {
  try {
    await asUser(user.claims, (db) => db.query('select return_submission($1, $2)', [submissionId, note]));
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

/** Decision 37: only "nothing changed" confirmations may be approved together. Each is its own transaction. */
export async function approveConfirmations(user: User, submissionIds: string[]): Promise<{ approved: number; failed: number }> {
  const queue = await loadQueue(user);
  const confirmations = new Set(queue.filter((q) => q.isConfirmation).map((q) => q.submissionId));
  let approved = 0;
  let failed = 0;
  for (const id of submissionIds) {
    if (!confirmations.has(id)) {
      failed += 1;
      continue;
    }
    if ((await approve(user, id, null, false)).ok) approved += 1;
    else failed += 1;
  }
  return { approved, failed };
}
