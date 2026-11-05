// Runs the data quality gate on a submission and logs the attempt (CLAUDE.md rules 4 and 5):
// every run, pass or reject, is written to dq_runs with its findings in dq_findings, the rule
// set version and the threshold used. A pass moves the submission to 'proposed' for approval;
// a reject to 'rejected_by_gate', with the payload kept for fix and retry.
//
// Call inside a transaction on the server's own database connection (inServerTransaction()).
import type pg from 'pg';
import { assertRuleSetSupported, runGate } from '../gate/engine';
import { parseRuleSet } from '../gate/rules';
import type { Finding, GateResult, GateRow, WorkbookInfo } from '../gate/types';
import { loadGateContext } from './context';

export class GateRefused extends Error {
  constructor(
    readonly code: 'W01' | 'W02' | 'W05' | 'W07',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const RERUNNABLE = ['draft', 'returned', 'rejected_by_gate'];

export async function runGateForSubmission(
  db: pg.ClientBase,
  options: { submissionId: string; actingUserId: string; workbook?: WorkbookInfo; cellFor?: (finding: Finding) => string | null },
): Promise<{ dqRunId: string; attemptNo: number; result: GateResult }> {
  const started = Date.now();
  const { rows: found } = await db.query<{
    submission_id: string;
    route: 'web_form' | 'bulk_upload' | 'on_behalf';
    submitted_by: string;
    on_behalf_of_person_id: string | null;
    batch_id: string | null;
    status: string;
    payload: { rows?: unknown };
  }>('select submission_id, route, submitted_by, on_behalf_of_person_id, batch_id, status, payload from submissions where submission_id = $1 for update', [
    options.submissionId,
  ]);
  const submission = found[0];
  if (!submission) throw new GateRefused('W01', 'submission not found');
  if (submission.submitted_by !== options.actingUserId) throw new GateRefused('W05', 'only the submitter can send a submission through the gate');
  if (!RERUNNABLE.includes(submission.status)) throw new GateRefused('W02', `a ${submission.status} submission cannot go through the gate again`);
  if (!Array.isArray(submission.payload.rows)) throw new GateRefused('W07', 'the payload has no rows');
  const rows = submission.payload.rows as GateRow[];

  // The current rule set in the database is authoritative; the code must implement exactly its rules.
  const { rows: current } = await db.query<{ rules: unknown }>('select rules from dq_rulesets where is_current');
  if (!current[0]) throw new Error('No current rule set in dq_rulesets.');
  const ruleSet = parseRuleSet(current[0].rules);
  assertRuleSetSupported(ruleSet);

  const context = await loadGateContext(
    db,
    { submissionId: submission.submission_id, submittedBy: submission.submitted_by, onBehalfOfPersonId: submission.on_behalf_of_person_id, batchId: submission.batch_id },
    rows,
    ruleSet,
    options.workbook,
  );
  const result = runGate({ route: submission.route, rows, ...(options.workbook ? { workbook: options.workbook } : {}) }, context, ruleSet);

  // Save the auto-fixed rows, so approval applies exactly what passed the gate.
  if (JSON.stringify(result.rows) !== JSON.stringify(rows)) {
    await db.query('update submissions set payload = jsonb_set(payload, $2, $3::jsonb) where submission_id = $1', [
      submission.submission_id,
      ['rows'],
      JSON.stringify(result.rows),
    ]);
  }

  // Attempts are numbered across the retry chain: this submission and those it replaced.
  const { rows: chain } = await db.query<{ attempts: number; last_run: string | null }>(
    `with recursive chain as (
       select submission_id, previous_submission_id from submissions where submission_id = $1
       union all
       select s.submission_id, s.previous_submission_id from submissions s join chain c on s.submission_id = c.previous_submission_id)
     select count(r.dq_run_id)::int as attempts,
            (array_agg(r.dq_run_id order by r.started_at desc, r.attempt_no desc) filter (where r.dq_run_id is not null))[1] as last_run
       from chain c left join dq_runs r on r.submission_id = c.submission_id`,
    [submission.submission_id],
  );
  const attemptNo = (chain[0]?.attempts ?? 0) + 1;

  const { rows: run } = await db.query<{ dq_run_id: string }>(
    `insert into dq_runs (submission_id, attempt_no, previous_run_id, ruleset_version, route, run_by, on_behalf_of_person_id, duration_ms,
                          rows_total, rows_with_blocking, file_failures, blocking_failures, scored_checks_applicable, scored_checks_passed,
                          quality_score, threshold, outcome, reject_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     returning dq_run_id`,
    [
      submission.submission_id,
      attemptNo,
      chain[0]?.last_run ?? null,
      result.rulesetVersion,
      submission.route,
      options.actingUserId,
      submission.on_behalf_of_person_id,
      Date.now() - started,
      result.rowsTotal,
      result.rowsWithBlocking,
      result.fileFailures,
      result.blockingFailures,
      result.scoredApplicable,
      result.scoredPassed,
      result.qualityScore,
      result.threshold,
      result.outcome,
      result.rejectReason,
    ],
  );
  const dqRunId = run[0]!.dq_run_id;

  if (result.findings.length > 0) {
    await db.query(
      `insert into dq_findings (dq_run_id, rule_id, tier, severity, entity, sheet, row_ref, field, cell, value_seen, message_en, message_fr, weight)
       select $1, f."ruleId", f.tier, f.severity, f.entity, f.sheet, f."rowRef", f.field, f.cell, f."valueSeen", f."messageEn", f."messageFr", f.weight
         from jsonb_to_recordset($2::jsonb) as f("ruleId" text, tier text, severity text, entity text, sheet text, "rowRef" int, field text,
                                                 cell text, "valueSeen" text, "messageEn" text, "messageFr" text, weight numeric)`,
      [dqRunId, JSON.stringify(result.findings.map((f) => ({ ...f, cell: f.cell ?? options.cellFor?.(f) ?? null })))],
    );
  }

  await db.query('update submissions set dq_run_id = $1, status = $2 where submission_id = $3', [
    dqRunId,
    result.outcome === 'pass' ? 'proposed' : 'rejected_by_gate',
    submission.submission_id,
  ]);
  // Spec 01 section 7.1: the people who may approve it are told (decision 36).
  if (result.outcome === 'pass') await db.query('select notify_approvers($1)', [submission.submission_id]);
  return { dqRunId, attemptNo, result };
}

/**
 * Tells each person an update was entered for (decisions 31 and 33), so they can object if it is
 * wrong. Queued once per person and submission; sent by the scheduled jobs (build step 12).
 */
export async function notifyEnteredFor(db: pg.ClientBase, submissionId: string): Promise<void> {
  await db.query(
    `insert into notification_log (kind, person_id, channel, object_type, object_id, status)
     select distinct 'entered_on_behalf', p.person_id, 'email', 'submission', s.submission_id::text, 'queued'
       from submissions s
       cross join lateral (
         select s.on_behalf_of_person_id as person_id
         union
         select (r ->> 'on_behalf_of_person_id')::uuid
           from jsonb_array_elements(s.payload -> 'rows') r
          where r ->> 'on_behalf_of_person_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') p
      where s.submission_id = $1 and p.person_id is not null
     on conflict do nothing`,
    [submissionId],
  );
}
