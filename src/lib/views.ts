// Shared reads for the management views (spec 01 section 8): every view says how fresh the data
// is, and shows list values in the reader's language from lookup_values.
import type pg from 'pg';
import type { Lang } from '../i18n';

/** What a view's freshness date measures (decision 92): each view says how fresh its own data is. */
export type AsOfKind = 'delivery' | 'risks' | 'merl' | 'governance' | 'portfolio';
export type AsOf = { kind: AsOfKind; asOf: string | null; period?: string | null; stale: number };

/**
 * How fresh a view's data is (spec 01 section 8, decision 92). Delivery: the most recent
 * confirmation (last_confirmed_at only: an ordinary edit is not a confirmation). Risks, MERL,
 * governance and portfolio use their own records. The stale count is always the delivery
 * items not confirmed for over 30 days.
 */
export async function dataAsOf(db: pg.ClientBase, kind: AsOfKind = 'delivery'): Promise<AsOf> {
  const delivery = await db.query<{ confirmed: string | null; stale: number }>(
    `select max(last_confirmed_at)::text as confirmed,
            count(*) filter (where is_stale and status not in ('complete', 'cancelled'))::int as stale
       from v_delivery_flags`,
  );
  const stale = delivery.rows[0]?.stale ?? 0;
  const own = {
    delivery: null,
    risks: "select max(updated_at)::text as as_of, null::text as period from risks where status <> 'closed'",
    merl: "select max(approved_at)::text as as_of, max(period_end)::text as period from indicator_values where approval_status = 'approved'",
    governance: 'select greatest((select max(updated_at) from decisions), (select max(updated_at) from adaptations))::text as as_of, null::text as period',
    portfolio: 'select max(assessment_date)::text as as_of, null::text as period from readiness_assessments',
  }[kind];
  if (!own) return { kind, asOf: delivery.rows[0]?.confirmed ?? null, stale };
  const { rows } = await db.query<{ as_of: string | null; period: string | null }>(own);
  return { kind, asOf: rows[0]?.as_of ?? null, period: rows[0]?.period ?? null, stale };
}

export type Labeller = (list: string, code: string | null) => string;

/** Labels for list values, falling back to the code itself. */
export async function loadLabels(db: pg.ClientBase, lists: string[], lang: Lang): Promise<Labeller> {
  const { rows } = await db.query<{ list_name: string; code: string; label_en: string; label_fr: string | null }>(
    'select list_name, code, label_en, label_fr from lookup_values where list_name = any ($1)',
    [lists],
  );
  const map = new Map(rows.map((r) => [`${r.list_name}:${r.code}`, lang === 'fr' && r.label_fr ? r.label_fr : r.label_en]));
  return (list, code) => (code === null ? '' : (map.get(`${list}:${code}`) ?? code));
}
