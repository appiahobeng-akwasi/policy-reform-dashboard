// The data quality gate (docs/03). One engine for every route: web form, bulk upload and
// on-behalf entry. The server run is authoritative; the browser runs the same code for hints.
//
// Order: file rules (bulk upload; any failure stops the run), auto-fixes, blocking rules,
// scored rules. Pass = no file or blocking failures AND quality score >= threshold.
import { AUTOFIX } from './checks/autofix';
import { BLOCKING } from './checks/blocking';
import type { CheckEnv, CheckRow, Failure, Fix } from './checks/common';
import { FILE } from './checks/file';
import { SCORED } from './checks/scored';
import { ENTITY_SPECS, STORED_ONLY_SPECS } from './entities';
import { fillMessage, shown } from './messages';
import { RULE_SET_V1, type Rule, type RuleSet } from './rules';
import type { Finding, GateContext, GateInput, GateResult, GateRow, RuleStats } from './types';

const IMPLEMENTED: Record<string, Record<string, unknown>> = { file: FILE, blocking: BLOCKING, scored: SCORED, autofix: AUTOFIX };

/** Rule IDs the code implements; must equal the rule set's (tests/dq/engine.test.ts). */
export const IMPLEMENTED_RULE_IDS = Object.values(IMPLEMENTED).flatMap((checks) => Object.keys(checks)).sort();

/** Throws if the rule set has a rule this code does not implement, or the other way round. */
export function assertRuleSetSupported(ruleSet: RuleSet): void {
  for (const rule of ruleSet.rules) {
    if (!(rule.id in (IMPLEMENTED[rule.tier] ?? {}))) throw new Error(`Rule ${rule.id} (${rule.tier}) has no implementation in the gate engine.`);
  }
  const inSet = new Set(ruleSet.rules.map((rule) => rule.id));
  const extra = IMPLEMENTED_RULE_IDS.filter((id) => !inSet.has(id));
  if (extra.length > 0) throw new Error(`The gate engine implements rules missing from rule set ${ruleSet.version}: ${extra.join(', ')}.`);
}

/**
 * Score from weighted sums, rounded half up to one decimal (79.95 → 80.0). Whole-number
 * arithmetic, so no floating-point rounding can move a result across the threshold.
 */
export function qualityScore(passed: number, applicable: number): number {
  if (applicable === 0) return 100;
  const tenths = Math.floor((2000 * passed + applicable) / (2 * applicable));
  return tenths / 10;
}

function applies(rule: Rule, entity: string, input: GateInput): boolean {
  return rule.appliesTo.includes(entity) && (rule.routes === 'all' || rule.routes.includes(input.route));
}

function specFor(entity: string, context: GateContext) {
  return ENTITY_SPECS[entity] ?? (context.mode === 'stored' ? STORED_ONLY_SPECS[entity] : undefined);
}

function toCheckRow(row: GateRow, index: number, context: GateContext): CheckRow {
  const spec = specFor(row.entity, context);
  if (spec === undefined) throw new TypeError(`Row ${index + 1}: unknown entity "${row.entity}".`);
  if (row.op !== 'create' && row.op !== 'update') throw new TypeError(`Row ${index + 1}: op must be create or update.`);
  const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id : null;
  const fields = row.fields ?? {};
  const stored = row.op === 'update' && id !== null ? (context.stored?.[`${row.entity}:${id.trim()}`] ?? {}) : {};
  return {
    index,
    rowNo: row.ref?.row ?? index + 1,
    sheet: row.ref?.sheet ?? null,
    entity: row.entity,
    spec,
    op: row.op,
    id,
    fields,
    merged: { ...stored, ...fields },
    row,
  };
}

function applyFix(row: GateRow, fix: Fix, idField: string): GateRow {
  if (fix.field === idField && fix.to === (typeof row.id === 'string' ? row.id.trim() : row.id)) return { ...row, id: fix.to as string };
  if (fix.field === 'evidence_ids' || fix.field === 'depends_on') return { ...row, [fix.field]: fix.to as string[] };
  if (fix.field === 'links') return { ...row, links: fix.to as NonNullable<GateRow['links']> };
  return { ...row, fields: { ...row.fields, [fix.field]: fix.to } };
}

function finding(rule: Rule, failure: Failure, row: CheckRow | null, severity: Finding['severity'], extraVars: Record<string, unknown> = {}): Finding {
  const value = failure.value === undefined ? null : shown(failure.value);
  const vars = {
    row: row?.rowNo,
    field: failure.field ?? undefined,
    value: value ?? undefined,
    sheet: failure.sheet ?? row?.sheet ?? undefined,
    cell: failure.cell ?? undefined,
    ...Object.fromEntries(Object.entries({ ...extraVars, ...failure.vars }).map(([k, v]) => [k, v === undefined || v === null ? undefined : shown(v)])),
  };
  return {
    ruleId: rule.id,
    tier: rule.tier,
    severity,
    entity: row?.entity ?? null,
    sheet: failure.sheet ?? row?.sheet ?? null,
    rowRef: row?.rowNo ?? null,
    field: failure.field ?? null,
    cell: failure.cell ?? null,
    valueSeen: value,
    messageEn: fillMessage(rule.messageEn, vars),
    messageFr: fillMessage(rule.messageFr, vars),
    weight: rule.weight,
  };
}

export function runGate(input: GateInput, context: GateContext, ruleSet: RuleSet = RULE_SET_V1): GateResult {
  assertRuleSetSupported(ruleSet);
  const findings: Finding[] = [];
  const byTier = (tier: Rule['tier']) => ruleSet.rules.filter((rule) => rule.tier === tier);
  const emptyEnv = (rows: CheckRow[]): CheckEnv => {
    const created = new Set(rows.filter((r) => r.op === 'create' && r.id !== null).map((r) => `${r.entity}:${r.id}`));
    const evidenceTargets = new Set(
      rows.filter((r) => r.entity === 'evidence_item').flatMap((r) => (r.row.links ?? []).map((l) => `${l.object_type}:${l.object_id}`)),
    );
    return { route: input.route, context, ruleSet, rows, created, evidenceTargets };
  };
  const base = {
    rulesetVersion: ruleSet.version,
    threshold: ruleSet.threshold,
    rowsTotal: input.rows.length,
  };

  const checksRun: Record<string, number> = {};
  const counted = (ruleId: string) => (checksRun[ruleId] = (checksRun[ruleId] ?? 0) + 1);

  // 1. File rules: any failure stops the run.
  let fileFailures = 0;
  if (input.workbook !== undefined) {
    const env = emptyEnv([]);
    for (const rule of byTier('file')) {
      if (rule.routes !== 'all' && !rule.routes.includes(input.route)) continue;
      const outcome = FILE[rule.id]!(input.workbook, env);
      if (outcome.kind !== 'checked') continue;
      counted(rule.id);
      for (const failure of outcome.failures) findings.push(finding(rule, failure, null, 'error'));
      fileFailures += outcome.failures.length;
    }
  }
  if (fileFailures > 0) {
    return {
      ...base,
      outcome: 'reject',
      rejectReason: 'file_rules',
      qualityScore: null,
      fileFailures,
      blockingFailures: 0,
      rowsWithBlocking: 0,
      scoredApplicable: 0,
      scoredPassed: 0,
      ruleStats: {},
      checksRun,
      findings,
      rows: input.rows,
    };
  }

  // 2. Auto-fixes, applied to the rows that will be saved.
  let rows = input.rows.map((row) => ({ ...row }));
  for (const rule of byTier('autofix')) {
    const env = emptyEnv(rows.map((row, i) => toCheckRow(row, i, context)));
    rows = rows.map((row, index) => {
      const checkRow = env.rows[index]!;
      if (!applies(rule, row.entity, input)) return row;
      let fixed = row;
      for (const fix of AUTOFIX[rule.id]!(checkRow, env)) {
        findings.push(finding(rule, { field: fix.field, value: fix.from }, checkRow, 'fixed', { canonical: fix.to }));
        fixed = applyFix(fixed, fix, checkRow.spec.idField);
      }
      return fixed;
    });
  }

  // 3 and 4. Blocking rules, then scored rules.
  const env = emptyEnv(rows.map((row, i) => toCheckRow(row, i, context)));
  let blockingFailures = 0;
  const rowsWithBlocking = new Set<number>();
  for (const rule of byTier('blocking')) {
    for (const row of env.rows) {
      if (!applies(rule, row.entity, input)) continue;
      const outcome = BLOCKING[rule.id]!(row, env);
      if (outcome.kind !== 'checked') continue;
      counted(rule.id);
      for (const failure of outcome.failures) findings.push(finding(rule, failure, row, 'error'));
      if (outcome.failures.length > 0) {
        blockingFailures += outcome.failures.length;
        rowsWithBlocking.add(row.index);
      }
    }
  }

  let applicable = 0;
  let passed = 0;
  const ruleStats: Record<string, RuleStats> = {};
  for (const rule of byTier('scored')) {
    const weight = rule.weight ?? 0;
    for (const row of env.rows) {
      if (!applies(rule, row.entity, input)) continue;
      const outcome = SCORED[rule.id]!(row, env);
      if (outcome.kind !== 'checked') continue;
      counted(rule.id);
      const stats = (ruleStats[rule.id] ??= { applicable: 0, passed: 0 });
      applicable += weight;
      stats.applicable += weight;
      if (outcome.failures.length === 0) {
        passed += weight;
        stats.passed += weight;
      }
      for (const failure of outcome.failures) findings.push(finding(rule, failure, row, 'warning'));
    }
  }

  const score = qualityScore(passed, applicable);
  const belowThreshold = score < ruleSet.threshold;
  const blocked = blockingFailures > 0;
  return {
    ...base,
    outcome: blocked || belowThreshold ? 'reject' : 'pass',
    rejectReason: blocked && belowThreshold ? 'blocking_and_score' : blocked ? 'blocking_rules' : belowThreshold ? 'score_below_threshold' : null,
    qualityScore: score,
    fileFailures: 0,
    blockingFailures,
    rowsWithBlocking: rowsWithBlocking.size,
    scoredApplicable: applicable,
    scoredPassed: passed,
    ruleStats,
    checksRun,
    findings,
    rows,
  };
}
