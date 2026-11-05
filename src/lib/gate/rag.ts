// TypeScript copy of computed_rag() in db/migrations/0002, used by rule Q06 (manual RAG differs
// from the computed one). tests/db/rag-parity.test.ts checks it gives the same answer as the
// database for every status and date case, so the two cannot drift apart.
import { daysBetween } from './dates';

export type Rag = 'green' | 'amber' | 'red' | 'grey' | 'blue';

export function computedRag(
  status: string | null,
  start: string | null,
  due: string | null,
  _forecast: string | null,
  progress: number | null,
  today: string,
): Rag {
  if (status === 'complete') return 'blue';
  if (status === 'cancelled') return 'grey';
  if (status === 'blocked') return 'red';
  // In SQL, "p_status <> 'complete'" is not true when status is null, so null status skips this line.
  if (due !== null && status !== null && daysBetween(due, today) > 14) return 'red';
  if (status === 'not_started' && start !== null && daysBetween(start, today) >= 14) return 'red';
  if (status === 'at_risk' || status === 'delayed') return 'amber';
  if (due !== null && today > due) return 'amber';
  if (due !== null && daysBetween(today, due) <= 7 && (progress ?? 0) < 50) return 'amber';
  if (status === 'not_started') return 'grey';
  return 'green';
}
