// Scored rules Q01 to Q24. Each (row, rule) pair that applies adds the rule's weight to the
// total; a pass adds it to the passed total too (docs/03 section 2).
import { daysBetween, dateOf, isIsoDate } from '../dates';
import { entityOfId, READINESS_DIMENSIONS } from '../entities';
import { computedRag } from '../rag';
import {
  checked,
  exists,
  failIf,
  hasEvidence,
  isActive,
  isBlank,
  isTrue,
  key,
  missing,
  NA,
  numberOf,
  PASS,
  status,
  text,
  UNKNOWN,
  type CheckEnv,
  type CheckRow,
  type RowCheck,
} from './common';

const PLACEHOLDERS = new Set(['tbc', 'tbd', 'n/a', 'na', 'x', 'xx', 'xxx', 'test', 'todo', '-', '--', '?', 'poc placeholder', 'placeholder', 'name', 'description', 'title', 'summary']);
const NAME_MIN_LENGTH = 10;
const STALE_DAYS = 30;

function isPlaceholder(value: unknown, row: CheckRow): boolean {
  const name = text(value)?.trim().toLowerCase() ?? '';
  return name.length < NAME_MIN_LENGTH || PLACEHOLDERS.has(name) || row.spec.writable.includes(name.replace(/\s+/g, '_'));
}

function dueDate(row: CheckRow): string | null {
  const field = row.spec.dueField;
  const value = field === null ? null : row.merged[field];
  return isIsoDate(value) ? value : null;
}

function overdue(row: CheckRow, env: CheckEnv): boolean {
  const due = dueDate(row);
  const current = status(row);
  return due !== null && due < env.context.today && current !== 'complete' && current !== 'cancelled';
}

/** Does following depends_on from this row lead back to it? */
function createsLoop(row: CheckRow, env: CheckEnv): boolean {
  if (row.id === null) return false;
  const start = key(row.entity, row.id);
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);
  for (const [from, to] of env.context.dependencies ?? []) add(from, to);
  for (const other of env.rows) {
    if (other.id === null) continue;
    for (const target of other.row.depends_on ?? []) {
      const type = entityOfId(target, env.ruleSet.idPatterns);
      if (type !== null) add(key(other.entity, other.id), key(type, target));
    }
  }
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === start) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(edges.get(node) ?? []));
  }
  return false;
}

export const SCORED: Record<string, RowCheck> = {
  Q01(row) {
    if (!isActive(row)) return NA;
    return failIf(isBlank(row.merged['next_action']), { field: 'next_action' });
  },

  Q02(row) {
    const current = status(row);
    if (current !== 'at_risk' && current !== 'delayed' && current !== 'blocked') return NA;
    return failIf(isBlank(row.merged['blocker']) && isBlank(row.merged['comments']), { field: 'blocker' });
  },

  Q03(row, env) {
    if (!row.spec.writable.includes('forecast_date')) return NA;
    if (status(row) !== 'delayed' && !overdue(row, env)) return NA;
    return failIf(isBlank(row.merged['forecast_date']), { field: 'forecast_date' });
  },

  Q04(row, env) {
    if (!overdue(row, env)) return NA;
    return failIf(status(row) === 'on_track', { field: 'status', value: status(row) });
  },

  Q05(row) {
    if (!('progress_pct' in row.spec.numbers)) return NA;
    const current = status(row);
    if (current === null || current === 'cancelled') return NA;
    const progress = numberOf(row.merged['progress_pct']);
    const ok =
      progress !== null &&
      (current === 'complete' ? progress === 100 : current === 'not_started' ? progress === 0 : progress >= 1 && progress <= 99);
    return failIf(!ok, { field: 'progress_pct', value: row.merged['progress_pct'] ?? '', vars: { status: current } });
  },

  Q06(row, env) {
    const override = text(row.merged['rag_override']);
    if (override === null) return NA;
    const rag =
      row.entity === 'reform'
        ? text(row.merged['computed_rag'])
        : computedRag(
            status(row),
            dateOf(row.merged['start_date']),
            dateOf(row.merged['due_date']),
            dateOf(row.merged['forecast_date']),
            numberOf(row.merged['progress_pct']),
            env.context.today,
          );
    if (rag === null) return UNKNOWN;
    if (override === rag) return NA;
    return failIf(isBlank(row.merged['rag_override_reason']), { field: 'rag_override_reason', value: override });
  },

  Q07(row, env) {
    if (!('evidence_confidence' in row.spec.controlled)) return NA;
    const evidence = hasEvidence(row, env);
    if (status(row) !== 'complete' && evidence === false) return NA;
    if (status(row) !== 'complete' && evidence === undefined) return UNKNOWN;
    return failIf(isBlank(row.merged['evidence_confidence']), { field: 'evidence_confidence' });
  },

  Q08(row) {
    if (row.spec.nameFields.length === 0) return NA;
    const failures = row.spec.nameFields
      .filter(({ field, required }) => (required || !isBlank(row.merged[field])) && isPlaceholder(row.merged[field], row))
      .map(({ field }) => ({ field, value: row.merged[field] ?? '' }));
    return checked(failures.slice(0, 1));
  },

  Q09(row, env) {
    const targets = row.row.depends_on ?? [];
    if (targets.length === 0) return NA;
    for (const target of targets) {
      const type = entityOfId(target, env.ruleSet.idPatterns);
      const found = type === null ? false : exists(env, type, target);
      if (found === undefined) return UNKNOWN;
      if (!found) return checked([{ field: 'depends_on', value: target }]);
    }
    if (env.context.dependencies === undefined) return UNKNOWN;
    return failIf(createsLoop(row, env), { field: 'depends_on', value: targets.join(', ') });
  },

  Q10(row) {
    if (!isActive(row)) return NA;
    const gaps = missing(row, ['mitigation', 'trigger', 'review_date']);
    return failIf(gaps.length > 0, { field: gaps[0] ?? null });
  },

  Q11(row) {
    const [l, i, rl, ri] = ['likelihood', 'impact', 'residual_likelihood', 'residual_impact'].map((f) => numberOf(row.merged[f]));
    if (l == null || i == null || rl == null || ri == null) return NA;
    return failIf(rl * ri > l * i, { field: 'residual_likelihood', value: rl * ri });
  },

  Q12(row, env) {
    const review = row.merged['review_date'];
    if (!isActive(row) || !isIsoDate(review)) return NA;
    return failIf(review < env.context.today, { field: 'review_date', value: review });
  },

  Q13(row) {
    if (status(row) !== 'open') return NA;
    const gaps = missing(row, ['follow_up_action', 'follow_up_owner_person_id', 'follow_up_due']);
    return failIf(gaps.length > 0, { field: gaps[0] ?? null });
  },

  Q14(row) {
    return failIf(isBlank(row.merged['evidence_basis']), { field: 'evidence_basis' });
  },

  Q15(row) {
    return failIf(isBlank(row.merged['confidence']), { field: 'confidence' });
  },

  Q16(row) {
    if (!isTrue(row.merged['is_proxy'])) return NA;
    return failIf(isBlank(row.merged['comment']), { field: 'comment' });
  },

  Q17(row, env) {
    const value = numberOf(row.merged['value']);
    const code = text(row.merged['indicator_code']);
    const period = text(row.merged['period_end']);
    if (value === null || code === null || period === null) return NA;
    if (env.context.previousValues === undefined) return UNKNOWN;
    const previous = env.context.previousValues[`${code}|${text(row.merged['reform_id']) ?? ''}|${period}`];
    if (previous === undefined || previous === 0) return NA;
    const bigChange = Math.abs(value - previous) / Math.abs(previous) > 0.5;
    if (!bigChange) return PASS;
    return failIf(isBlank(row.merged['comment']), { field: 'comment', value, vars: { prev: previous } });
  },

  Q18(row) {
    // The schema keeps Year 1 and life-of-programme targets in separate columns, so a target
    // with no type can only arrive as a bare "target" field.
    if (!isBlank(row.merged['target'])) return checked([{ field: 'target', value: row.id ?? '' }]);
    const typed = ['target_y1', 'target_y1_text', 'target_lop'].some((f) => !isBlank(row.merged[f]));
    return typed ? PASS : NA;
  },

  Q19(row) {
    const gaps = missing(row, ['source_institution', 'evidence_date', 'evidence_type']);
    return failIf(gaps.length > 0, { field: gaps[0] ?? null });
  },

  Q20(row) {
    if (!isTrue(row.merged['escalation_needed'])) return NA;
    return failIf(isBlank(row.merged['escalation_to']), { field: 'escalation_to' });
  },

  Q21(row) {
    const gaps = missing(row, [...READINESS_DIMENSIONS, 'assessor']);
    return failIf(gaps.length > 0, { field: gaps[0] ?? null });
  },

  Q22(row) {
    if (!isTrue(row.merged['change_approved'])) return NA;
    const gaps = missing(row, ['rationale', 'approved_by', 'approval_date']);
    return failIf(gaps.length > 0, { field: gaps[0] ?? null });
  },

  Q23(row, env) {
    // Decision 20: submitting a row brings it up to date, so staleness never counts at the gate.
    // It is checked on stored records (nightly job, data quality page).
    if (env.context.mode === 'gate' || !isActive(row)) return NA;
    const last = dateOf(row.merged['last_confirmed_at']) ?? dateOf(row.merged['updated_at']);
    if (last === null) return checked([{ field: 'last_update', value: '' }]);
    return failIf(daysBetween(last, env.context.today) > STALE_DAYS, { field: 'last_update', value: last });
  },

  Q24(row) {
    const name = text(row.merged['name_en']);
    if (name === null || !name.toLowerCase().startsWith('percentage')) return NA;
    return failIf(text(row.merged['unit']) !== '%', { field: 'unit', value: row.id ?? '' });
  },
};
