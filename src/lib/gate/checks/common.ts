// Shared shapes and helpers for the rule checks.
import type { EntitySpec } from '../entities';
import type { MessageVars } from '../messages';
import type { RuleSet } from '../rules';
import type { GateContext, GateRow, Route, WorkbookInfo } from '../types';

/** One row as the checks see it: the fields sent, and the record as it will be after the change. */
export type CheckRow = {
  index: number;
  rowNo: number;
  sheet: string | null;
  entity: string;
  spec: EntitySpec;
  op: 'create' | 'update';
  id: string | null;
  fields: Record<string, unknown>;
  /** Stored record (for updates) with the submitted fields on top. */
  merged: Record<string, unknown>;
  row: GateRow;
};

export type CheckEnv = {
  route: Route;
  context: GateContext;
  ruleSet: RuleSet;
  rows: readonly CheckRow[];
  /** "type:id" of items created by rows in this submission. */
  created: ReadonlySet<string>;
  /** "type:id" of items that evidence rows in this submission link to. */
  evidenceTargets: ReadonlySet<string>;
};

export type Failure = { field?: string | null; value?: unknown; cell?: string | null; sheet?: string | null; vars?: MessageVars };

/** 'na': the rule does not apply to this row; 'unknown': live data needed is missing (browser hints). */
export type Outcome = { kind: 'na' } | { kind: 'unknown' } | { kind: 'checked'; failures: Failure[] };

export type RowCheck = (row: CheckRow, env: CheckEnv) => Outcome;
export type FileCheck = (workbook: WorkbookInfo, env: CheckEnv) => Outcome;
export type Fix = { field: string; from: unknown; to: unknown };
export type AutoFix = (row: CheckRow, env: CheckEnv) => Fix[];

export const NA: Outcome = { kind: 'na' };
export const UNKNOWN: Outcome = { kind: 'unknown' };
export const PASS: Outcome = { kind: 'checked', failures: [] };

export function checked(failures: Failure[]): Outcome {
  return { kind: 'checked', failures };
}

export function failIf(condition: boolean, failure: Failure = {}): Outcome {
  return checked(condition ? [failure] : []);
}

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

export function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** A number, or a string holding one; null otherwise. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function isTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

export function status(row: CheckRow): string | null {
  return text(row.merged['status']);
}

export function isActive(row: CheckRow): boolean {
  const current = status(row);
  return row.spec.activeStatuses !== null && current !== null && row.spec.activeStatuses.includes(current);
}

export function key(type: string, id: string): string {
  return `${type}:${id}`;
}

/** Does the item exist, in the database or as a new row in this submission? undefined if unknown. */
export function exists(env: CheckEnv, type: string, id: string): boolean | undefined {
  if (env.created.has(key(type, id))) return true;
  if (env.context.existing === undefined) return undefined;
  return env.context.existing.includes(key(type, id));
}

/** Does the item have evidence: in the row, from evidence rows in this submission, or already stored? */
export function hasEvidence(row: CheckRow, env: CheckEnv): boolean | undefined {
  if ((row.row.evidence_ids ?? []).length > 0) return true;
  if (row.id !== null && env.evidenceTargets.has(key(row.entity, row.id))) return true;
  if (row.op === 'create' || row.id === null) return false;
  if (env.context.evidenceLinked === undefined) return undefined;
  return env.context.evidenceLinked.includes(key(row.entity, row.id));
}

export function missing(row: CheckRow, fields: readonly string[]): string[] {
  return fields.filter((field) => isBlank(row.merged[field]));
}
