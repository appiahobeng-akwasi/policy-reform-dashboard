// Review packs (build step 13, spec 01 sections 8 and 9): the facts for a monthly Pillar 1 review
// or a QSR, in the order the meeting uses them (Prepare, Review, Decide, Track). Built as the
// signed-in admin, so row-level security still applies, and saved as a fixed version (decision 54).
// The data holds codes, names and numbers, never sentences: the renderer words it in either language.
import type pg from 'pg';
import type { AuthClaims } from '../auth';
import { asUser } from '../server-db';

export const REVIEW_TYPES = ['monthly_pillar_review', 'quarterly_strategy_review'] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];
export const isReviewType = (value: unknown): value is ReviewType => typeof value === 'string' && (REVIEW_TYPES as readonly string[]).includes(value);

export type Names = { en: string; fr: string | null };
export type PackReform = {
  reformId: string;
  name: Names;
  stage: Names | null;
  rag: string;
  overdue: number;
  due30: number;
  stale: number;
  risksHigh: number | null;
  decisionsOpen: number | null;
  hasSample: boolean;
};
export type PackItem = {
  objectType: string;
  objectId: string;
  name: string;
  reformId: string | null;
  owner: string | null;
  dueDate: string | null;
  daysOverdue: number;
  isStale: boolean;
  rag: string;
  isSample: boolean;
};
export type PackEscalation = { level: number; reason: string; objectType: string; objectId: string; name: Names | null; reformId: string | null; owner: string | null; raisedAt: string };
export type RiskState = { inherent: number | null; residual: number | null; status: string };
export type PackRiskChange = { riskId: string; description: string; change: 'new' | 'closed' | 'score' | 'status'; before: RiskState | null; after: RiskState; at: string };
export type PackRisk = { riskId: string; description: string; inherent: number | null; residual: number | null; owner: string | null; reviewDate: string | null; reviewOverdue: boolean; reforms: string[] };
export type PackValue = { periodEnd: string; value: number | null; confidence: string | null; isProxy: boolean };
export type PackIndicator = {
  code: string;
  name: Names;
  reformId: string | null;
  unit: string | null;
  latest: PackValue;
  previous: PackValue | null;
  newSinceLastReview: boolean;
  targetY1: number | null;
  targetY1Text: string | null;
  /** Only once confirmed (CLAUDE.md: life-of-programme targets are unconfirmed). */
  targetLop: number | null;
};
export type PackDecision = {
  decisionId: string;
  date: string;
  type: string;
  tier: number | null;
  summary: string;
  followUpAction: string | null;
  followUpDue: string | null;
  followUpOwner: string | null;
  followUpOverdue: boolean;
  reforms: string[];
};
export type PackAction = { actionId: string; description: string; owner: string | null; dueDate: string | null; status: string; overdue: boolean };

export type PackData = {
  schema: 1;
  reviewType: ReviewType;
  reviewDate: string;
  windowStart: string;
  dataAsOf: string | null;
  prepare: {
    reforms: PackReform[];
    programme: PackItem[];
    staleTotal: number;
    quality: { attempts: number; firstTimePassRate: number | null; averageScore: number | null };
  };
  review: { escalations: PackEscalation[]; overdue: PackItem[]; riskChanges: PackRiskChange[]; highRisks: PackRisk[]; indicators: PackIndicator[] };
  decide: { open: PackDecision[] };
  track: { implemented: PackDecision[]; actions: PackAction[] };
};

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
/** Inherent score of 15 or more is a high risk, as on the Executive view (migration 0004). */
export const HIGH_RISK = 15;

/**
 * Since the last review: when the previous pack of the same type was prepared, or else one month
 * (monthly) or three months (QSR) before the review date (decision 56).
 */
export async function windowStart(db: pg.ClientBase, type: ReviewType, reviewDate: string): Promise<string> {
  const { rows } = await db.query<{ start: string }>(
    `select coalesce(
       (select max(generated_at) from review_packs where review_type = $1 and review_date < $2::date),
       ($2::date - case when $1 = 'quarterly_strategy_review' then interval '3 months' else interval '1 month' end)::timestamp at time zone 'Africa/Kinshasa'
     )::text as start`,
    [type, reviewDate],
  );
  return rows[0]!.start;
}

const ITEM_SELECT = `select f.object_type, f.object_id, f.name, f.reform_id, p.full_name as owner, f.due_date, f.days_overdue::int, f.is_stale, f.rag, f.is_sample
  from v_delivery_flags f left join people p on p.person_id = f.owner_person_id`;
type ItemRow = { object_type: string; object_id: string; name: string; reform_id: string | null; owner: string | null; due_date: string | null; days_overdue: number; is_stale: boolean; rag: string; is_sample: boolean };
const toItem = (r: ItemRow): PackItem => ({
  objectType: r.object_type,
  objectId: r.object_id,
  name: r.name,
  reformId: r.reform_id,
  owner: r.owner,
  dueDate: r.due_date,
  daysOverdue: r.days_overdue,
  isStale: r.is_stale,
  rag: r.rag,
  isSample: r.is_sample,
});

type DecisionRow = {
  decision_id: string;
  decision_date: string;
  decision_type: string;
  governance_tier: number | null;
  summary: string;
  follow_up_action: string | null;
  follow_up_due: string | null;
  owner: string | null;
  overdue: boolean;
  reforms: string[];
};
const toDecision = (r: DecisionRow): PackDecision => ({
  decisionId: r.decision_id,
  date: r.decision_date,
  type: r.decision_type,
  tier: r.governance_tier,
  summary: r.summary,
  followUpAction: r.follow_up_action,
  followUpDue: r.follow_up_due,
  followUpOwner: r.owner,
  followUpOverdue: r.overdue,
  reforms: r.reforms,
});
// One row per decision, however many reforms it links to (CLAUDE.md: count by decision_id).
const DECISION_SELECT = `select d.decision_id, d.decision_date, d.decision_type, d.governance_tier, d.summary, d.follow_up_action, d.follow_up_due,
       coalesce(p.full_name, d.follow_up_owner_text) as owner,
       d.status = 'open' and d.follow_up_due < $1::date as overdue,
       coalesce((select array_agg(l.object_id order by l.object_id) from decision_links l where l.decision_id = d.decision_id and l.object_type = 'reform'), '{}') as reforms
  from decisions d left join people p on p.person_id = d.follow_up_owner_person_id`;

/** Every fact for the pack, read now. */
export async function buildPackData(db: pg.ClientBase, type: ReviewType, reviewDate: string): Promise<PackData> {
  const start = await windowStart(db, type, reviewDate);

  const reforms = await db.query<{
    reform_id: string;
    name_en: string;
    name_fr: string | null;
    stage_en: string | null;
    stage_fr: string | null;
    rag: string;
    items_overdue: number;
    milestones_due_30d: number;
    items_stale: number;
    risks_high: number | null;
    decisions_open: number | null;
    has_sample: boolean;
  }>(
    `select s.reform_id, r.name_en, r.name_fr, ps.label_en as stage_en, ps.label_fr as stage_fr, s.rag, s.items_overdue::int, s.milestones_due_30d::int,
            s.items_stale::int, s.risks_high::int, s.decisions_open::int,
            exists (select 1 from v_delivery_items i where i.reform_id = s.reform_id and i.is_sample) as has_sample
       from v_reform_summary s join reforms r using (reform_id) left join pathway_stages ps on ps.code = s.current_stage
      order by s.reform_id`,
  );
  // Programme-wide milestones have no reform and are shown apart (CLAUDE.md).
  const programme = await db.query<ItemRow>(
    `${ITEM_SELECT} where f.object_type = 'milestone' and f.reform_id is null and f.status not in ('complete', 'cancelled') order by f.due_date nulls last, f.object_id`,
  );
  const asOf = await db.query<{ as_of: string | null; stale: number }>(
    `select max(last_confirmed_at)::text as as_of, count(*) filter (where is_stale and status not in ('complete', 'cancelled'))::int as stale
       from v_delivery_flags`,
  );
  const quality = await db.query<{ attempts: number; rate: string | null; score: string | null }>(
    `select count(*)::int as attempts,
            round(100.0 * count(*) filter (where attempt_no = 1 and outcome = 'pass') / nullif(count(*) filter (where attempt_no = 1), 0), 1) as rate,
            round(avg(quality_score), 1) as score
       from dq_runs where started_at >= $1::timestamptz`,
    [start],
  );

  // Level 3 is the Programme Director's list; a monthly review also takes level 2 (spec 01 section 10).
  const minLevel = type === 'monthly_pillar_review' ? 2 : 3;
  const escalations = await db.query<{
    level: number;
    reason: string;
    object_type: string;
    object_id: string;
    name: string | null;
    name_fr: string | null;
    reform_id: string | null;
    owner: string | null;
    raised_at: string;
  }>(
    `select e.level, e.reason, e.object_type, e.object_id,
            coalesce(i.name, ps.label_en) as name, ps.label_fr as name_fr, coalesce(i.reform_id, s.reform_id) as reform_id,
            coalesce(po.full_name, ps2.full_name) as owner, e.raised_at::text
       from escalations e
       left join v_delivery_items i on i.object_type = e.object_type and i.object_id = e.object_id
       left join people po on po.person_id = i.owner_person_id
       left join reform_stages s on e.object_type = 'reform_stage' and s.stage_record_id = e.object_id
       left join pathway_stages ps on ps.code = s.stage
       left join people ps2 on ps2.person_id = s.responsible_person_id
      where e.resolved_at is null and e.level >= $1
      order by e.level desc, coalesce(i.reform_id, s.reform_id) nulls last, e.object_id`,
    [minLevel],
  );
  const overdue = await db.query<ItemRow>(`${ITEM_SELECT} where f.days_overdue > 0 order by f.reform_id nulls last, f.days_overdue desc, f.object_id`);

  // Changes made through the app since the last review; the seed load has no actor and is not a change.
  const riskChanges = await db.query<{ risk_id: string; description: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown>; at: string }>(
    `select a.record_id as risk_id, a.after ->> 'description' as description, a.action, a.before, a.after, a.at::text
       from audit_log a
      where a.table_name = 'risks' and a.at >= $1::timestamptz and a.actor_user_id is not null and a.action in ('insert', 'update')
      order by a.at`,
    [start],
  );
  const highRisks = await db.query<{
    risk_id: string;
    description: string;
    inherent_score: number | null;
    residual_score: number | null;
    owner: string | null;
    review_date: string | null;
    review_overdue: boolean;
    reforms: string[];
  }>(
    `select k.risk_id, k.description, k.inherent_score, k.residual_score, coalesce(p.full_name, k.owner_text) as owner, k.review_date,
            coalesce(k.review_date < $1::date, false) as review_overdue,
            coalesce((select array_agg(l.object_id order by l.object_id) from risk_links l where l.risk_id = k.risk_id and l.object_type = 'reform'), '{}') as reforms
       from risks k left join people p on p.person_id = k.owner_person_id
      where k.status <> 'closed' and (k.inherent_score >= $2 or k.review_date < $1::date)
      order by k.inherent_score desc nulls last, k.risk_id`,
    [reviewDate, HIGH_RISK],
  );
  const indicators = await db.query<{
    indicator_code: string;
    name_en: string;
    name_fr: string | null;
    reform_id: string | null;
    unit: string | null;
    target_y1: string | null;
    target_y1_text: string | null;
    target_lop: string | null;
    target_lop_confirmed: boolean;
    latest: PackValue;
    previous: PackValue | null;
    latest_at: string | null;
  }>(
    `with ranked as (
       select v.*, row_number() over (partition by v.indicator_code, v.reform_id order by v.period_end desc, v.created_at desc) as n
         from indicator_values v where v.approval_status = 'approved' and v.period_end <= $1::date),
     pick as (
       select r1.indicator_code, r1.reform_id,
              jsonb_build_object('periodEnd', r1.period_end, 'value', r1.value, 'confidence', r1.confidence, 'isProxy', r1.is_proxy) as latest,
              r1.approved_at as latest_at,
              (select jsonb_build_object('periodEnd', r2.period_end, 'value', r2.value, 'confidence', r2.confidence, 'isProxy', r2.is_proxy)
                 from ranked r2 where r2.indicator_code = r1.indicator_code and r2.reform_id is not distinct from r1.reform_id and r2.n = 2) as previous
         from ranked r1 where r1.n = 1)
     select p.indicator_code, i.name_en, i.name_fr, p.reform_id, i.unit, i.target_y1, i.target_y1_text, i.target_lop, i.target_lop_confirmed,
            p.latest, p.previous, p.latest_at::text
       from pick p join indicators i using (indicator_code)
      where i.is_active
      order by p.indicator_code, p.reform_id nulls first`,
    [reviewDate],
  );
  const open = await db.query<DecisionRow>(`${DECISION_SELECT} where d.status = 'open' order by d.follow_up_due nulls last, d.decision_id`, [reviewDate]);
  // Marked implemented through the app since the last review (the audit log has the actor).
  const implemented = await db.query<DecisionRow>(
    `${DECISION_SELECT}
      where d.status = 'implemented'
        and exists (select 1 from audit_log a where a.table_name = 'decisions' and a.record_id = d.decision_id and a.at >= $2::timestamptz
                       and a.actor_user_id is not null and a.after ->> 'status' = 'implemented'
                       and (a.before ->> 'status') is distinct from 'implemented')
      order by d.decision_id`,
    [reviewDate, start],
  );
  const actions = await db.query<{ action_id: string; description: string; owner: string | null; due_date: string | null; status: string; overdue: boolean }>(
    `select a.action_id, a.description, p.full_name as owner, a.due_date, a.status, a.status = 'open' and a.due_date < $1::date as overdue
       from actions a left join people p on p.person_id = a.owner_person_id
      where a.status = 'open' or a.completed_at >= $2::timestamptz
      order by a.status, a.due_date nulls last, a.action_id`,
    [reviewDate, start],
  );

  const state = (row: Record<string, unknown> | null): RiskState | null =>
    row ? { inherent: num(row['inherent_score']), residual: num(row['residual_score']), status: String(row['status'] ?? '') } : null;

  return {
    schema: 1,
    reviewType: type,
    reviewDate,
    windowStart: start,
    dataAsOf: asOf.rows[0]?.as_of ?? null,
    prepare: {
      reforms: reforms.rows.map((r) => ({
        reformId: r.reform_id,
        name: { en: r.name_en, fr: r.name_fr },
        stage: r.stage_en ? { en: r.stage_en, fr: r.stage_fr } : null,
        rag: r.rag,
        overdue: r.items_overdue,
        due30: r.milestones_due_30d,
        stale: r.items_stale,
        risksHigh: r.risks_high,
        decisionsOpen: r.decisions_open,
        hasSample: r.has_sample,
      })),
      programme: programme.rows.map(toItem),
      staleTotal: asOf.rows[0]?.stale ?? 0,
      quality: { attempts: quality.rows[0]?.attempts ?? 0, firstTimePassRate: num(quality.rows[0]?.rate), averageScore: num(quality.rows[0]?.score) },
    },
    review: {
      escalations: escalations.rows.map((e) => ({
        level: e.level,
        reason: e.reason,
        objectType: e.object_type,
        objectId: e.object_id,
        name: e.name ? { en: e.name, fr: e.name_fr } : null,
        reformId: e.reform_id,
        owner: e.owner,
        raisedAt: e.raised_at,
      })),
      overdue: overdue.rows.map(toItem),
      riskChanges: riskChanges.rows.flatMap((c): PackRiskChange[] => {
        const before = state(c.before);
        const after = state(c.after)!;
        const change: PackRiskChange['change'] | null =
          c.action === 'insert'
            ? 'new'
            : after.status === 'closed' && before?.status !== 'closed'
              ? 'closed'
              : before && (before.inherent !== after.inherent || before.residual !== after.residual)
                ? 'score'
                : before && before.status !== after.status
                  ? 'status'
                  : null;
        return change ? [{ riskId: c.risk_id, description: c.description, change, before, after, at: c.at }] : [];
      }),
      highRisks: highRisks.rows.map((k) => ({
        riskId: k.risk_id,
        description: k.description,
        inherent: k.inherent_score,
        residual: k.residual_score,
        owner: k.owner,
        reviewDate: k.review_date,
        reviewOverdue: k.review_overdue,
        reforms: k.reforms,
      })),
      indicators: indicators.rows.map((i) => ({
        code: i.indicator_code,
        name: { en: i.name_en, fr: i.name_fr },
        reformId: i.reform_id,
        unit: i.unit,
        latest: { ...i.latest, value: num(i.latest.value) },
        previous: i.previous ? { ...i.previous, value: num(i.previous.value) } : null,
        // Approved through the app since the last review; seeded values have no approval time.
        newSinceLastReview: i.latest_at !== null && Date.parse(i.latest_at) >= Date.parse(start),
        targetY1: num(i.target_y1),
        targetY1Text: i.target_y1_text,
        targetLop: i.target_lop_confirmed ? num(i.target_lop) : null,
      })),
    },
    decide: { open: open.rows.map(toDecision) },
    track: {
      implemented: implemented.rows.map(toDecision),
      actions: actions.rows.map((a) => ({ actionId: a.action_id, description: a.description, owner: a.owner, dueDate: a.due_date, status: a.status, overdue: a.overdue })),
    },
  };
}

export type PackSummary = { packId: string; reviewType: ReviewType; reviewDate: string; version: number; generatedAt: string; generatedBy: string };

/** Builds the pack and saves it as the next version, in one transaction. */
export async function preparePack(db: pg.ClientBase, userId: string, type: ReviewType, reviewDate: string): Promise<{ packId: string; version: number }> {
  const data = await buildPackData(db, type, reviewDate);
  const { rows } = await db.query<{ pack_id: string; version: number }>(
    'insert into review_packs (review_type, review_date, window_start, generated_by, data) values ($1, $2, $3, $4, $5) returning pack_id, version',
    [type, reviewDate, data.windowStart, userId, data],
  );
  return { packId: rows[0]!.pack_id, version: rows[0]!.version };
}

export async function prepare(claims: AuthClaims, userId: string, type: ReviewType, reviewDate: string): Promise<{ packId: string; version: number }> {
  return asUser(claims, (db) => preparePack(db, userId, type, reviewDate));
}

export async function listPacks(claims: AuthClaims): Promise<PackSummary[]> {
  return asUser(claims, async (db) => {
    const { rows } = await db.query<{ pack_id: string; review_type: ReviewType; review_date: string; version: number; generated_at: string; generated_by: string }>(
      `select k.pack_id, k.review_type, k.review_date, k.version, k.generated_at::text, k.generated_by_name as generated_by
         from review_packs k
        order by k.review_date desc, k.review_type, k.version desc limit 100`,
    );
    return rows.map((r) => ({ packId: r.pack_id, reviewType: r.review_type, reviewDate: r.review_date, version: r.version, generatedAt: r.generated_at, generatedBy: r.generated_by }));
  });
}

export async function getPack(claims: AuthClaims, packId: string): Promise<(PackSummary & { data: PackData }) | null> {
  return asUser(claims, async (db) => {
    const { rows } = await db.query<{ pack_id: string; review_type: ReviewType; review_date: string; version: number; generated_at: string; generated_by: string; data: PackData }>(
      `select k.pack_id, k.review_type, k.review_date, k.version, k.generated_at::text, k.generated_by_name as generated_by, k.data
         from review_packs k where k.pack_id = $1`,
      [packId],
    );
    const r = rows[0];
    return r ? { packId: r.pack_id, reviewType: r.review_type, reviewDate: r.review_date, version: r.version, generatedAt: r.generated_at, generatedBy: r.generated_by, data: r.data } : null;
  });
}
