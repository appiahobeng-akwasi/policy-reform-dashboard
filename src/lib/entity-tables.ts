// Table and key of each entity a submission can change (as submission_entities in migration 0005).
export const ENTITY_TABLES: Record<string, { table: string; idField: string }> = {
  workstream: { table: 'workstreams', idField: 'workstream_id' },
  deliverable: { table: 'deliverables', idField: 'deliverable_id' },
  activity: { table: 'activities', idField: 'activity_id' },
  milestone: { table: 'milestones', idField: 'milestone_id' },
  reform_stage: { table: 'reform_stages', idField: 'stage_record_id' },
  risk: { table: 'risks', idField: 'risk_id' },
  decision: { table: 'decisions', idField: 'decision_id' },
  action: { table: 'actions', idField: 'action_id' },
  adaptation: { table: 'adaptations', idField: 'adaptation_id' },
  evidence_item: { table: 'evidence_items', idField: 'evidence_id' },
  indicator_value: { table: 'indicator_values', idField: 'value_id' },
  readiness_assessment: { table: 'readiness_assessments', idField: 'readiness_id' },
};
