// Pure helpers for the Pathway view (decision 89): where a reform is on its eight stages, which
// escalation comes next, and the order of the delivery table. No database, no i18n: tested in
// tests/unit/pathway.test.ts.

export type StageState = 'done' | 'current' | 'blocked' | 'todo';

/** The display state of a stage from its stored status. */
export function stageState(status: string): StageState {
  if (status === 'complete') return 'done';
  if (status === 'in_progress') return 'current';
  if (status === 'blocked') return 'blocked';
  return 'todo';
}

/** True when the reform has reached this stage (complete, under way or stuck on it). */
export const reached = (state: StageState): boolean => state !== 'todo';

export type Position = { kind: 'at'; numbers: number[]; total: number } | { kind: 'complete'; total: number } | { kind: 'not_started'; total: number };

/**
 * Where a reform is: the 1-based numbers of the stages under way or blocked, or all complete,
 * or not started. Stages are in pathway order.
 */
export function position(states: StageState[]): Position {
  const total = states.length;
  const numbers = states.flatMap((s, i) => (s === 'current' || s === 'blocked' ? [i + 1] : []));
  if (numbers.length > 0) return { kind: 'at', numbers, total };
  if (total > 0 && states.every((s) => s === 'done')) return { kind: 'complete', total };
  if (states.some((s) => s === 'done')) {
    // Between stages: the next one to start is where the reform stands.
    const next = states.findIndex((s) => s === 'todo');
    return { kind: 'at', numbers: [next + 1], total };
  }
  return { kind: 'not_started', total };
}

/**
 * The first stage still to start, after the furthest one reached, that is flagged for
 * escalation: the next blocker to raise. Null when there is none.
 */
export function nextEscalation<T extends { state: StageState; escalationNeeded: boolean }>(stages: T[]): T | null {
  let furthest = -1;
  stages.forEach((s, i) => {
    if (reached(s.state)) furthest = i;
  });
  return stages.slice(furthest + 1).find((s) => s.state === 'todo' && s.escalationNeeded) ?? null;
}

type Leaf = { days_overdue: number; due_date: string | null; object_id: string };

/** Overdue first (most overdue at the top), then by due date, undated last, then by ID. */
export function orderLeaves<T extends Leaf>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const lateA = a.days_overdue > 0 ? a.days_overdue : 0;
    const lateB = b.days_overdue > 0 ? b.days_overdue : 0;
    if (lateA !== lateB) return lateB - lateA;
    if (a.due_date !== b.due_date) {
      if (a.due_date === null) return 1;
      if (b.due_date === null) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return a.object_id.localeCompare(b.object_id);
  });
}

/** How many rows a delivery table shows before "Show more". */
export const FIRST_ROWS = 5;

/** Splits rows into those shown and those behind "Show more". */
export function fold<T>(rows: T[], first = FIRST_ROWS): { shown: T[]; more: T[] } {
  // Never fold a single row away: "Show 1 more" costs as much space as the row itself.
  if (rows.length <= first + 1) return { shown: rows, more: [] };
  return { shown: rows.slice(0, first), more: rows.slice(first) };
}

/** The page address with some query values changed (null removes one), keeping the rest. */
export function pathwayLink(params: URLSearchParams, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return `/pathway${query ? `?${query}` : ''}`;
}
