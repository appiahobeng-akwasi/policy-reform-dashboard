// Data quality figures (docs/03 sections 7 and 8) for the admin page and for each person's own
// page. Every query runs as the signed-in person, so row-level security decides whose runs are
// counted: admins see everyone's, everyone else only their own (spec 01 section 3, decision 44).
import type pg from 'pg';
import type { AuthClaims } from '../auth';
import { asUser } from '../server-db';

export const PAGE_SIZE = 50;
/** docs/03 section 8: a rule failing for more than this share of active users is reviewed first. */
export const RULE_REVIEW_PCT = 30;
/** docs/03 section 8: training is suggested under this first-time pass rate over the last submissions. */
export const TRAINING_PASS_PCT = 60;
export const TRAINING_WINDOW = 5;
export const ROUTES = ['web_form', 'bulk_upload', 'on_behalf'] as const;

/** Kinshasa is UTC+1 all year (no summer time). Months on this page are Kinshasa months. */
const KINSHASA_OFFSET_MS = 60 * 60 * 1000;

export type Filter = {
  /** 'last3', 'last12' or a month 'YYYY-MM'. */
  period: string;
  route: string | null;
  reform: string | null;
  userId: string | null;
};

/** Reads the filter from the query string, ignoring anything not valid. */
export function readFilter(params: URLSearchParams, reforms: readonly string[]): Filter {
  const period = params.get('period') ?? '';
  const route = params.get('route') ?? '';
  const reform = params.get('reform') ?? '';
  const userId = params.get('user') ?? '';
  return {
    period: period === 'last12' || /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : 'last3',
    route: (ROUTES as readonly string[]).includes(route) ? route : null,
    reform: reforms.includes(reform) ? reform : null,
    userId: /^[0-9a-f-]{36}$/.test(userId) ? userId : null,
  };
}

/** The first instant of the Kinshasa month that contains `at`, moved by `months`. */
function kinshasaMonthStart(at: Date, months = 0): Date {
  const local = new Date(at.getTime() + KINSHASA_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1) - KINSHASA_OFFSET_MS);
}

/** Start (inclusive) and end (exclusive, null = open) of the period, as instants. */
export function periodBounds(period: string, now = new Date()): { from: Date; to: Date | null } {
  if (period === 'last12') return { from: kinshasaMonthStart(now, -11), to: null };
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const from = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1) - KINSHASA_OFFSET_MS);
    return { from, to: kinshasaMonthStart(from, 1) };
  }
  return { from: kinshasaMonthStart(now, -2), to: null };
}

/** The last twelve Kinshasa months, newest first, as 'YYYY-MM', for the month filter. */
export function recentMonths(now = new Date(), count = 12): string[] {
  return Array.from({ length: count }, (_, i) => kinshasaMonthStart(now, -i)).map((start) =>
    new Date(start.getTime() + KINSHASA_OFFSET_MS).toISOString().slice(0, 7),
  );
}

// Runs in the filter. $1 from, $2 to (or null), $3 route, $4 reform, $5 user.
const RUNS = `runs as (
  select r.*, s.batch_id
    from dq_runs r left join submissions s using (submission_id)
   where r.started_at >= $1 and ($2::timestamptz is null or r.started_at < $2)
     and ($3::text is null or r.route = $3)
     and ($4::text is null or $4 = any (s.reform_ids))
     and ($5::uuid is null or r.run_by = $5))`;

export type Headline = {
  attempts: number;
  firstAttempts: number;
  firstTimePassRate: number | null;
  averageScore: number | null;
  rejects: number;
};
export type PersonRow = Headline & {
  userId: string;
  name: string;
  lastAttemptAt: string;
};
export type TrainingFlag = {
  userId: string;
  passes: number;
  topRules: string[];
  lastNoticeAt: string | null;
};
/** exampleEn and exampleFr: the latest message this rule gave, as an example of what went wrong. */
export type RuleRow = {
  month: string;
  ruleId: string;
  tier: string;
  failures: number;
  usersAffected: number;
  pctOfActiveUsers: number | null;
  exampleEn: string;
  exampleFr: string;
};
export type TimeToFix = {
  chains: number;
  fixed: number;
  notYetFixed: number;
  medianHours: number | null;
  averageAttempts: number | null;
};
export type TrendPoint = {
  month: string;
  score: number;
  runs: number;
  passRate: number | null;
};
export type StaleOwner = {
  personId: string | null;
  name: string | null;
  items: number;
  oldestDays: number;
};
export type Attempt = {
  dqRunId: string;
  submissionId: string;
  startedAt: string;
  name: string;
  route: string;
  attemptNo: number;
  score: number | null;
  outcome: string;
  rejectReason: string | null;
  isUpload: boolean;
};

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function params(filter: Filter, now: Date): unknown[] {
  const { from, to } = periodBounds(filter.period, now);
  return [from.toISOString(), to?.toISOString() ?? null, filter.route, filter.reform, filter.userId];
}

async function headline(db: pg.ClientBase, p: unknown[]): Promise<Headline> {
  const { rows } = await db.query(
    `with ${RUNS}
     select count(*)::int as attempts,
            count(*) filter (where attempt_no = 1)::int as first_attempts,
            round(100.0 * count(*) filter (where attempt_no = 1 and outcome = 'pass') / nullif(count(*) filter (where attempt_no = 1), 0), 1) as rate,
            round(avg(quality_score), 1) as score,
            count(*) filter (where outcome = 'reject')::int as rejects
       from runs`,
    p,
  );
  const r = rows[0]!;
  return {
    attempts: r.attempts,
    firstAttempts: r.first_attempts,
    firstTimePassRate: num(r.rate),
    averageScore: num(r.score),
    rejects: r.rejects,
  };
}

/** Per person, sorted by name: never ranked (docs/03 section 8.3). */
async function people(db: pg.ClientBase, p: unknown[]): Promise<PersonRow[]> {
  const { rows } = await db.query(
    `with ${RUNS}
     select r.run_by as user_id, coalesce(pp.full_name, u.email) as name,
            count(*)::int as attempts,
            count(*) filter (where r.attempt_no = 1)::int as first_attempts,
            round(100.0 * count(*) filter (where r.attempt_no = 1 and r.outcome = 'pass') / nullif(count(*) filter (where r.attempt_no = 1), 0), 1) as rate,
            round(avg(r.quality_score), 1) as score,
            count(*) filter (where r.outcome = 'reject')::int as rejects,
            max(r.started_at)::text as last_attempt_at
       from runs r join app_users u on u.user_id = r.run_by left join people pp on pp.person_id = u.person_id
      group by 1, 2 order by lower(coalesce(pp.full_name, u.email))`,
    p,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    attempts: r.attempts,
    firstAttempts: r.first_attempts,
    firstTimePassRate: num(r.rate),
    averageScore: num(r.score),
    rejects: r.rejects,
    lastAttemptAt: r.last_attempt_at,
  }));
}

/**
 * docs/03 section 8.2: people whose first-time pass rate is under 60% over their last five
 * submissions (all time, whatever the filter), with the three rules that failed most in them.
 */
export async function trainingFlags(db: pg.ClientBase): Promise<TrainingFlag[]> {
  const { rows } = await db.query(
    `with firsts as (
       select r.run_by, r.submission_id, r.outcome,
              row_number() over (partition by r.run_by order by r.started_at desc) as n
         from dq_runs r where r.attempt_no = 1),
     recent as (select * from firsts where n <= $1),
     flagged as (
       select run_by, count(*) filter (where outcome = 'pass')::int as passes
         from recent group by run_by
        having count(*) = $1 and 100.0 * count(*) filter (where outcome = 'pass') / count(*) < $2),
     rules as (
       select r.run_by, f.rule_id, count(*) as failures,
              row_number() over (partition by r.run_by order by count(*) desc, f.rule_id) as rank
         from dq_findings f join dq_runs r using (dq_run_id)
        where f.severity = 'error' and r.submission_id in (select submission_id from recent where recent.run_by = r.run_by)
        group by r.run_by, f.rule_id)
     select fl.run_by as user_id, fl.passes,
            coalesce((select array_agg(rule_id order by rank) from rules where rules.run_by = fl.run_by and rank <= 3), '{}') as top_rules,
            (select max(n.sent_at)::text from notification_log n join app_users u on u.person_id = n.person_id
              where u.user_id = fl.run_by and n.kind = 'training_suggested') as last_notice_at
       from flagged fl`,
    [TRAINING_WINDOW, TRAINING_PASS_PCT],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    passes: r.passes,
    topRules: r.top_rules,
    lastNoticeAt: r.last_notice_at,
  }));
}

/** Error findings by rule and month, the top ten each month (docs/03 section 7). */
async function failingRules(db: pg.ClientBase, p: unknown[]): Promise<RuleRow[]> {
  const { rows } = await db.query(
    `with ${RUNS},
     months as (select r.*, to_char(r.started_at at time zone 'Africa/Kinshasa', 'YYYY-MM') as month from runs r),
     active as (select month, count(distinct run_by) as users from months group by month),
     fails as (
       select m.month, f.rule_id, f.tier, count(*)::int as failures, count(distinct m.run_by)::int as users_affected,
              (array_agg(f.message_en order by m.started_at desc))[1] as example_en,
              (array_agg(f.message_fr order by m.started_at desc))[1] as example_fr,
              row_number() over (partition by m.month order by count(*) desc, f.rule_id) as rank
         from dq_findings f join months m using (dq_run_id)
        where f.severity = 'error' group by m.month, f.rule_id, f.tier)
     select fails.month, fails.rule_id, fails.tier, fails.failures, fails.users_affected, fails.example_en, fails.example_fr,
            round(100.0 * fails.users_affected / nullif(active.users, 0), 1) as pct
       from fails join active using (month)
      where fails.rank <= 10
      order by fails.month desc, fails.failures desc, fails.rule_id`,
    p,
  );
  return rows.map((r) => ({
    month: r.month,
    ruleId: r.rule_id,
    tier: r.tier,
    failures: r.failures,
    usersAffected: r.users_affected,
    pctOfActiveUsers: num(r.pct),
    exampleEn: r.example_en,
    exampleFr: r.example_fr,
  }));
}

/** Chains that started in the filter: how many were fixed, how fast, in how many attempts. */
async function timeToFix(db: pg.ClientBase, p: unknown[]): Promise<TimeToFix> {
  const { rows } = await db.query(
    `with ${RUNS},
     chains as (select t.* from v_dq_time_to_fix t join runs r on r.dq_run_id = t.root_id where r.previous_run_id is null)
     select count(*)::int as chains,
            count(*) filter (where attempts > 1 and passed_at is not null)::int as fixed,
            count(*) filter (where passed_at is null)::int as not_yet_fixed,
            round((percentile_cont(0.5) within group (order by hours_to_fix) filter (where attempts > 1 and passed_at is not null))::numeric, 2) as median_hours,
            round(avg(attempts), 1) as average_attempts
       from chains`,
    p,
  );
  const r = rows[0]!;
  return {
    chains: r.chains,
    fixed: r.fixed,
    notYetFixed: r.not_yet_fixed,
    medianHours: num(r.median_hours),
    averageAttempts: num(r.average_attempts),
  };
}

/** Twelve months of average score and first-time pass rate; route, reform and person filters apply. */
async function trend(db: pg.ClientBase, filter: Filter, now: Date): Promise<TrendPoint[]> {
  const { rows } = await db.query(
    `with ${RUNS}
     select to_char(started_at at time zone 'Africa/Kinshasa', 'YYYY-MM') || '-01' as month,
            round(avg(quality_score), 1) as score, count(*)::int as runs,
            round(100.0 * count(*) filter (where attempt_no = 1 and outcome = 'pass') / nullif(count(*) filter (where attempt_no = 1), 0), 1) as rate
       from runs where quality_score is not null
      group by 1 order by 1`,
    params({ ...filter, period: 'last12' }, now),
  );
  return rows.map((r) => ({
    month: r.month,
    score: Number(r.score),
    runs: r.runs,
    passRate: num(r.rate),
  }));
}

/** Active items not confirmed in 30 days, by owner (docs/03 section 7). */
async function staleByOwner(db: pg.ClientBase, reform: string | null): Promise<StaleOwner[]> {
  const { rows } = await db.query(
    `select f.owner_person_id, p.full_name, count(*)::int as items, max(f.days_since_update)::int as oldest
       from v_delivery_flags f left join people p on p.person_id = f.owner_person_id
      where f.is_stale and f.status not in ('complete', 'cancelled') and ($1::text is null or f.reform_id = $1)
      group by 1, 2 order by items desc, lower(p.full_name) nulls first`,
    [reform],
  );
  return rows.map((r) => ({
    personId: r.owner_person_id,
    name: r.full_name,
    items: r.items,
    oldestDays: r.oldest,
  }));
}

async function attempts(db: pg.ClientBase, p: unknown[], page: number): Promise<{ rows: Attempt[]; total: number }> {
  const { rows } = await db.query(
    `with ${RUNS}
     select r.dq_run_id, r.submission_id, r.started_at::text, coalesce(pp.full_name, u.email) as name, r.route, r.attempt_no,
            r.quality_score, r.outcome, r.reject_reason, r.batch_id is not null as is_upload, count(*) over ()::int as total
       from runs r join app_users u on u.user_id = r.run_by left join people pp on pp.person_id = u.person_id
      order by r.started_at desc, r.attempt_no desc
      limit ${PAGE_SIZE} offset $6`,
    [...p, (page - 1) * PAGE_SIZE],
  );
  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((r) => ({
      dqRunId: r.dq_run_id,
      submissionId: r.submission_id,
      startedAt: r.started_at,
      name: r.name,
      route: r.route,
      attemptNo: r.attempt_no,
      score: num(r.quality_score),
      outcome: r.outcome,
      rejectReason: r.reject_reason,
      isUpload: r.is_upload,
    })),
  };
}

export type Report = {
  headline: Headline;
  people: PersonRow[];
  training: TrainingFlag[];
  rules: RuleRow[];
  timeToFix: TimeToFix;
  trend: TrendPoint[];
  stale: StaleOwner[];
  attempts: { rows: Attempt[]; total: number };
};

/** Every figure on the admin page, on an open connection (the tests run it inside their transaction). */
export async function buildReport(db: pg.ClientBase, filter: Filter, page: number, now = new Date()): Promise<Report> {
  const p = params(filter, now);
  return {
    headline: await headline(db, p),
    people: await people(db, p),
    training: await trainingFlags(db),
    rules: await failingRules(db, p),
    timeToFix: await timeToFix(db, p),
    trend: await trend(db, filter, now),
    stale: await staleByOwner(db, filter.reform),
    attempts: await attempts(db, p, page),
  };
}

/** The admin page: everything, for everyone row-level security lets the viewer see. */
export async function adminReport(claims: AuthClaims, filter: Filter, page: number, now = new Date()): Promise<Report> {
  return asUser(claims, (db) => buildReport(db, filter, page, now));
}

export type OwnReport = Pick<Report, 'headline' | 'rules' | 'trend' | 'attempts'> & { training: TrainingFlag | null };

/** A person's own figures: only their runs, whatever their role. */
export async function buildOwnReport(db: pg.ClientBase, userId: string, filter: Filter, page: number, now = new Date()): Promise<OwnReport> {
  const own = { ...filter, userId };
  const p = params(own, now);
  return {
    headline: await headline(db, p),
    rules: await failingRules(db, p),
    trend: await trend(db, own, now),
    attempts: await attempts(db, p, page),
    training: (await trainingFlags(db)).find((f) => f.userId === userId) ?? null,
  };
}

export async function ownReport(claims: AuthClaims, userId: string, filter: Filter, page: number, now = new Date()): Promise<OwnReport> {
  return asUser(claims, (db) => buildOwnReport(db, userId, filter, page, now));
}

/** Admins send a training notice naming the person's top rules (decision 43). False if already sent today. */
export async function sendTrainingNotice(claims: AuthClaims, userId: string, rules: string[]): Promise<boolean> {
  return asUser(claims, async (db) => {
    const { rows } = await db.query<{ sent: boolean }>('select send_training_notice($1, $2) as sent', [userId, rules]);
    return rows[0]?.sent === true;
  });
}
