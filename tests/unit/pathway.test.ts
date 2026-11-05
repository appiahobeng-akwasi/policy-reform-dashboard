// The Pathway view's logic (decision 89): stage states, where a reform stands, the next
// escalation, and the order and fold of the delivery table.
import { describe, expect, it } from 'vitest';
import { fold, nextEscalation, orderLeaves, pathwayLink, position, stageState, type StageState } from '../../src/lib/pathway';

describe('stageState', () => {
  it('maps every stored status, unknown ones to not started', () => {
    expect(['complete', 'in_progress', 'blocked', 'not_started', 'odd'].map(stageState)).toEqual(['done', 'current', 'blocked', 'todo', 'todo']);
  });
});

describe('position', () => {
  const s = (...states: StageState[]) => states;

  it('names every stage under way, as today in all three reforms (3 and 4 of 8)', () => {
    expect(position(s('done', 'done', 'current', 'current', 'todo', 'todo', 'todo', 'todo'))).toEqual({ kind: 'at', numbers: [3, 4], total: 8 });
  });

  it('counts a blocked stage as where the reform stands', () => {
    expect(position(s('done', 'blocked', 'todo'))).toEqual({ kind: 'at', numbers: [2], total: 3 });
  });

  it('between stages, stands at the next one to start', () => {
    expect(position(s('done', 'done', 'todo', 'todo'))).toEqual({ kind: 'at', numbers: [3], total: 4 });
  });

  it('knows complete and not started', () => {
    expect(position(s('done', 'done'))).toEqual({ kind: 'complete', total: 2 });
    expect(position(s('todo', 'todo'))).toEqual({ kind: 'not_started', total: 2 });
    expect(position([])).toEqual({ kind: 'not_started', total: 0 });
  });
});

describe('nextEscalation', () => {
  const st = (state: StageState, escalationNeeded = false, name = '') => ({ state, escalationNeeded, name });

  it('finds the first flagged stage after the furthest one reached', () => {
    const stages = [st('done'), st('current'), st('current'), st('todo', true, 'Validation'), st('todo', true, 'Approval')];
    expect(nextEscalation(stages)?.name).toBe('Validation');
  });

  it('ignores flags on stages already reached', () => {
    expect(nextEscalation([st('done', true), st('current', true), st('todo')])).toBeNull();
  });

  it('is null when nothing ahead is flagged', () => {
    expect(nextEscalation([st('done'), st('todo'), st('todo')])).toBeNull();
  });
});

describe('orderLeaves', () => {
  const leaf = (object_id: string, days_overdue: number, due_date: string | null) => ({ object_id, days_overdue, due_date });

  it('puts the most overdue first, then by due date, undated last', () => {
    const ordered = orderLeaves([leaf('A', 0, '2026-12-01'), leaf('B', 10, '2026-10-20'), leaf('C', 0, null), leaf('D', 91, '2026-08-05'), leaf('E', 0, '2026-11-15')]);
    expect(ordered.map((x) => x.object_id)).toEqual(['D', 'B', 'E', 'A', 'C']);
  });

  it('breaks ties by ID and does not change the input', () => {
    const input = [leaf('MS-2', 5, '2026-09-01'), leaf('MS-1', 5, '2026-09-01')];
    expect(orderLeaves(input).map((x) => x.object_id)).toEqual(['MS-1', 'MS-2']);
    expect(input[0]!.object_id).toBe('MS-2');
  });
});

describe('fold', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('shows the first five and folds the rest', () => {
    expect(fold(rows(8))).toEqual({ shown: [0, 1, 2, 3, 4], more: [5, 6, 7] });
  });

  it('never folds away a single row', () => {
    expect(fold(rows(6))).toEqual({ shown: rows(6), more: [] });
    expect(fold(rows(5)).more).toEqual([]);
    expect(fold([])).toEqual({ shown: [], more: [] });
  });
});

describe('pathwayLink', () => {
  it('changes one value and keeps the others', () => {
    expect(pathwayLink(new URLSearchParams('rag=red&owner=p1'), { reform: 'RA2' })).toBe('/pathway?rag=red&owner=p1&reform=RA2');
  });

  it('removes values set to null or empty', () => {
    expect(pathwayLink(new URLSearchParams('reform=RA1&stage=PT-003'), { stage: null })).toBe('/pathway?reform=RA1');
    expect(pathwayLink(new URLSearchParams('reform=RA1'), { reform: '' })).toBe('/pathway');
  });
});
