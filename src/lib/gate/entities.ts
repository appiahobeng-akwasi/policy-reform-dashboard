// What each field of each entity is, so the rules know which fields are dates, numbers,
// controlled values, references or free text. Field names are the database columns that a
// submission may write (submission_entities in migration 0005); a database test checks the
// two lists match.

export type NumberRule = { min: number; max: number | null; integer: boolean };

export type EntitySpec = {
  idField: string;
  /** Key into the rule set's id_patterns; null where the database assigns a UUID. */
  idPattern: string | null;
  example: string;
  /** True where the system can assign the next ID (web form, new row). */
  generatesId: boolean;
  writable: readonly string[];
  references: Record<string, string>;
  /** Field → controlled list name (lookup_values, or SCHEMA_LISTS below). */
  controlled: Record<string, string>;
  dates: readonly string[];
  numbers: Record<string, NumberRule>;
  booleans: readonly string[];
  /** Names and descriptions for Q08; optional ones are checked only when filled in. */
  nameFields: readonly { field: string; required: boolean }[];
  ownerField: string | null;
  startField: string | null;
  dueField: string | null;
  actualField: string | null;
  /** Statuses that mean the item is still open (B08, Q01, Q10 ...). */
  activeStatuses: readonly string[] | null;
};

const DELIVERY_ACTIVE = ['not_started', 'on_track', 'at_risk', 'delayed', 'blocked'] as const;
const PERCENT: NumberRule = { min: 0, max: 100, integer: true };
const ONE_TO_FIVE: NumberRule = { min: 1, max: 5, integer: true };
const DELIVERY_DATES = ['start_date', 'due_date', 'forecast_date', 'actual_date'] as const;

/**
 * Lists defined only by a database CHECK constraint, not in lookup_values. Adding them to
 * lookup_values would need French labels nobody has agreed yet. tests/db/gate-lists.test.ts
 * checks each matches its constraint.
 */
export const SCHEMA_LISTS: Record<string, readonly string[]> = {
  milestone_scope: ['reform', 'programme'],
  governance_tier: ['1', '2', '3'],
  adaptation_trigger: ['delay', 'political_change', 'new_opportunity', 'risk_escalation', 'evidence_change', 'other'],
  access_level: ['internal', 'restricted', 'external', 'public'],
};

export const ENTITY_SPECS: Record<string, EntitySpec> = {
  workstream: {
    idField: 'workstream_id',
    idPattern: 'workstream',
    example: 'WS-RA1-01',
    generatesId: true,
    writable: ['reform_id', 'name', 'workstream_type', 'owner_person_id', 'lead_institution_id', ...DELIVERY_DATES, 'status', 'progress_pct', 'rag_override', 'rag_override_reason', 'next_action', 'blocker', 'comments'],
    references: { reform_id: 'reform', owner_person_id: 'person', lead_institution_id: 'institution' },
    controlled: { workstream_type: 'workstream_type', status: 'delivery_status', rag_override: 'rag' },
    dates: DELIVERY_DATES,
    numbers: { progress_pct: PERCENT },
    booleans: [],
    nameFields: [{ field: 'name', required: true }],
    ownerField: 'owner_person_id',
    startField: 'start_date',
    dueField: 'due_date',
    actualField: 'actual_date',
    activeStatuses: DELIVERY_ACTIVE,
  },
  deliverable: {
    idField: 'deliverable_id',
    idPattern: 'deliverable',
    example: 'DL-RA1-001',
    generatesId: true,
    writable: ['workstream_id', 'name', 'description', 'owner_person_id', ...DELIVERY_DATES, 'status', 'progress_pct', 'evidence_required', 'evidence_confidence', 'rag_override', 'rag_override_reason', 'next_action', 'blocker', 'comments'],
    references: { workstream_id: 'workstream', owner_person_id: 'person' },
    controlled: { status: 'delivery_status', evidence_confidence: 'confidence', rag_override: 'rag' },
    dates: DELIVERY_DATES,
    numbers: { progress_pct: PERCENT },
    booleans: [],
    nameFields: [
      { field: 'name', required: true },
      { field: 'description', required: false },
    ],
    ownerField: 'owner_person_id',
    startField: 'start_date',
    dueField: 'due_date',
    actualField: 'actual_date',
    activeStatuses: DELIVERY_ACTIVE,
  },
  activity: {
    idField: 'activity_id',
    idPattern: 'activity',
    example: 'AC-RA1-0001',
    generatesId: true,
    writable: ['deliverable_id', 'name', 'owner_person_id', ...DELIVERY_DATES, 'status', 'progress_pct', 'next_action', 'blocker', 'comments'],
    references: { deliverable_id: 'deliverable', owner_person_id: 'person' },
    controlled: { status: 'delivery_status' },
    dates: DELIVERY_DATES,
    numbers: { progress_pct: PERCENT },
    booleans: [],
    nameFields: [{ field: 'name', required: true }],
    ownerField: 'owner_person_id',
    startField: 'start_date',
    dueField: 'due_date',
    actualField: 'actual_date',
    activeStatuses: DELIVERY_ACTIVE,
  },
  milestone: {
    idField: 'milestone_id',
    idPattern: 'milestone',
    example: 'MS-001',
    generatesId: true,
    writable: ['scope', 'reform_id', 'deliverable_id', 'name', 'milestone_type', 'pathway_stage', 'is_decision_gate', 'owner_person_id', 'planned_date', 'forecast_date', 'actual_date', 'status', 'evidence_required', 'evidence_confidence', 'escalation_action', 'next_action', 'blocker', 'comments'],
    references: { reform_id: 'reform', deliverable_id: 'deliverable', owner_person_id: 'person' },
    controlled: { scope: 'milestone_scope', milestone_type: 'milestone_type', pathway_stage: 'pathway_stage', status: 'delivery_status', evidence_confidence: 'confidence' },
    dates: ['planned_date', 'forecast_date', 'actual_date'],
    numbers: {},
    booleans: ['is_decision_gate'],
    nameFields: [{ field: 'name', required: true }],
    ownerField: 'owner_person_id',
    startField: null,
    dueField: 'planned_date',
    actualField: 'actual_date',
    activeStatuses: DELIVERY_ACTIVE,
  },
  reform_stage: {
    idField: 'stage_record_id',
    idPattern: 'reform_stage',
    example: 'PT-001',
    generatesId: false,
    writable: ['reform_id', 'stage', 'entry_date', 'exit_date', 'status', 'evidence_required', 'responsible_person_id', 'escalation_needed', 'escalation_to', 'comments'],
    references: { reform_id: 'reform', responsible_person_id: 'person' },
    controlled: { stage: 'pathway_stage', status: 'stage_status' },
    dates: ['entry_date', 'exit_date'],
    numbers: {},
    booleans: ['escalation_needed'],
    nameFields: [],
    ownerField: null,
    startField: 'entry_date',
    dueField: 'exit_date',
    actualField: 'exit_date',
    activeStatuses: ['not_started', 'in_progress', 'blocked'],
  },
  risk: {
    idField: 'risk_id',
    idPattern: 'risk',
    example: 'RK-001',
    generatesId: true,
    writable: ['category', 'description', 'likelihood', 'impact', 'mitigation', 'trigger', 'owner_person_id', 'residual_likelihood', 'residual_impact', 'treatment', 'review_date', 'status'],
    references: { owner_person_id: 'person' },
    controlled: { category: 'risk_category', treatment: 'treatment', status: 'risk_status' },
    dates: ['review_date'],
    numbers: { likelihood: ONE_TO_FIVE, impact: ONE_TO_FIVE, residual_likelihood: ONE_TO_FIVE, residual_impact: ONE_TO_FIVE },
    booleans: [],
    nameFields: [{ field: 'description', required: true }],
    ownerField: 'owner_person_id',
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: ['open', 'monitoring'],
  },
  decision: {
    idField: 'decision_id',
    idPattern: 'decision',
    example: 'DC-001',
    generatesId: true,
    writable: ['decision_date', 'decision_type', 'decision_body', 'decision_maker', 'governance_tier', 'summary', 'reason', 'follow_up_action', 'follow_up_owner_person_id', 'follow_up_due', 'status', 'pathway_stage'],
    references: { follow_up_owner_person_id: 'person' },
    controlled: { decision_type: 'decision_type', governance_tier: 'governance_tier', status: 'decision_status', pathway_stage: 'pathway_stage' },
    dates: ['decision_date', 'follow_up_due'],
    numbers: {},
    booleans: [],
    nameFields: [{ field: 'summary', required: true }],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: ['open'],
  },
  action: {
    idField: 'action_id',
    idPattern: 'action',
    example: 'AN-0001',
    generatesId: true,
    writable: ['source_type', 'source_id', 'description', 'owner_person_id', 'due_date', 'status', 'completed_at', 'comments'],
    references: { owner_person_id: 'person' },
    controlled: { source_type: 'action_source', status: 'action_status' },
    dates: ['due_date', 'completed_at'],
    numbers: {},
    booleans: [],
    nameFields: [{ field: 'description', required: true }],
    ownerField: 'owner_person_id',
    startField: null,
    dueField: 'due_date',
    actualField: null,
    activeStatuses: ['open'],
  },
  adaptation: {
    idField: 'adaptation_id',
    idPattern: 'adaptation',
    example: 'AD-001',
    generatesId: false,
    writable: ['trigger_event', 'trigger_type', 'original_plan', 'change_requested', 'change_approved', 'approval_date', 'approved_by', 'rationale', 'expected_impact', 'follow_up_action'],
    references: {},
    controlled: { trigger_type: 'adaptation_trigger' },
    dates: ['approval_date'],
    numbers: {},
    booleans: ['change_approved'],
    nameFields: [{ field: 'change_requested', required: true }],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: null,
  },
  evidence_item: {
    idField: 'evidence_id',
    idPattern: 'evidence_item',
    example: 'EV-001',
    generatesId: true,
    writable: ['title', 'evidence_type', 'source_institution', 'evidence_date', 'file_path', 'file_sha256', 'file_mime', 'file_bytes', 'external_url', 'access_level', 'pathway_stage'],
    references: {},
    controlled: { evidence_type: 'evidence_type', access_level: 'access_level', pathway_stage: 'pathway_stage' },
    dates: ['evidence_date'],
    numbers: { file_bytes: { min: 0, max: null, integer: true } },
    booleans: [],
    nameFields: [{ field: 'title', required: true }],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: null,
  },
  indicator_value: {
    idField: 'value_id',
    idPattern: null,
    example: '(assigned by the system)',
    generatesId: true,
    writable: ['indicator_code', 'reform_id', 'period_end', 'snapshot_type', 'value', 'is_proxy', 'confidence', 'evidence_basis', 'comment'],
    references: { indicator_code: 'indicator', reform_id: 'reform' },
    controlled: { confidence: 'confidence' },
    dates: ['period_end'],
    // "Not negative unless the indicator allows it": no indicator allows it yet (no such flag in the schema).
    numbers: { value: { min: 0, max: null, integer: false } },
    booleans: ['is_proxy'],
    nameFields: [],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: null,
  },
  readiness_assessment: {
    idField: 'readiness_id',
    idPattern: 'readiness_assessment',
    example: 'RD-001',
    generatesId: false,
    writable: ['reform_id', 'political_commitment', 'institutional_ownership', 'technical_readiness', 'financial_readiness', 'stakeholder_alignment', 'implementation_capacity', 'assessment_date', 'assessor', 'comments'],
    references: { reform_id: 'reform' },
    controlled: {
      political_commitment: 'confidence',
      institutional_ownership: 'confidence',
      technical_readiness: 'confidence',
      financial_readiness: 'confidence',
      stakeholder_alignment: 'confidence',
      implementation_capacity: 'confidence',
    },
    dates: ['assessment_date'],
    numbers: {},
    booleans: [],
    nameFields: [],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: null,
  },
};

/** Records the gate checks only as stored data (Q06 for reforms; Q18 and Q24 for indicators). */
export const STORED_ONLY_SPECS: Record<string, EntitySpec> = {
  indicator: {
    idField: 'indicator_code',
    idPattern: 'indicator',
    example: 'O1.1',
    generatesId: false,
    writable: [],
    references: {},
    controlled: {},
    dates: [],
    numbers: {},
    booleans: [],
    nameFields: [],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: null,
  },
  reform: {
    idField: 'reform_id',
    idPattern: 'reform',
    example: 'RA1',
    generatesId: false,
    writable: [],
    references: {},
    controlled: {},
    dates: [],
    numbers: {},
    booleans: [],
    nameFields: [],
    ownerField: null,
    startField: null,
    dueField: null,
    actualField: null,
    activeStatuses: null,
  },
};

export const READINESS_DIMENSIONS = Object.keys(ENTITY_SPECS['readiness_assessment']!.controlled);

/** Entities a submission can carry. Indicators and reforms are checked only as stored records. */
export const SUBMITTABLE = Object.keys(ENTITY_SPECS);

/** Fields of an entity that are free text (for B14). */
export function textFields(spec: EntitySpec): string[] {
  const typed = new Set([...Object.keys(spec.references), ...Object.keys(spec.controlled), ...spec.dates, ...Object.keys(spec.numbers), ...spec.booleans]);
  return spec.writable.filter((field) => !typed.has(field) && field !== 'file_sha256' && field !== 'file_mime' && field !== 'file_path');
}

/** The entity an ID belongs to, from the rule set's ID patterns (as id_object_type() in 0008). */
export function entityOfId(id: string, idPatterns: Record<string, string>): string | null {
  for (const [entity, pattern] of Object.entries(idPatterns)) {
    if (new RegExp(pattern).test(id)) return entity;
  }
  return null;
}
