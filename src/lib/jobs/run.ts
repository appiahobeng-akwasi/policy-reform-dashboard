// Runs a scheduled job (build step 12): logs it in job_runs, runs the job's database function in
// one transaction under a lock (so two copies never run together), then sends the emails. Called
// by `npm run jobs`, by POST /api/jobs/<name> and by Run now on the Jobs page. Running a job
// twice for the same day sends nothing twice.
import type pg from 'pg';
import type { Lang } from '../../i18n';
import { trainingFlags } from '../admin/data-quality';
import { logError } from '../errors';
import type { Mailer } from '../email/mailer';
import { env } from '../env';
import { inServerTransaction } from '../server-db';
import { dailyEmail, digestEmail, REMINDER_KINDS, type DigestItem, type FollowUp, type Portfolio, type Reminder } from './messages';

export const JOBS = ['nightly', 'daily', 'weekly', 'month_end'] as const;
export type JobName = (typeof JOBS)[number];
export const isJob = (value: unknown): value is JobName => typeof value === 'string' && (JOBS as readonly string[]).includes(value);

const KINSHASA_OFFSET_MS = 60 * 60 * 1000;
const DIGEST_ITEMS = 20;

/** The day a job runs for: today in Kinshasa, or for month_end the last day of last month. */
export function defaultRunDate(job: JobName, now = new Date()): string {
  const local = new Date(now.getTime() + KINSHASA_OFFSET_MS);
  if (job === 'month_end') return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 0)).toISOString().slice(0, 10);
  return local.toISOString().slice(0, 10);
}

export function isRunDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export type JobResult = { jobRunId: string; job: JobName; runFor: string; status: 'succeeded' | 'partial' | 'failed' | 'skipped'; counts: Record<string, number>; error?: string };

/** Tries an email gets in all, one per run, before it is left as failed (decision 92). */
export const MAX_EMAIL_ATTEMPTS = 3;

type Options = { date?: string | undefined; triggeredBy: 'schedule' | 'admin'; userId?: string | null; mailer: Mailer | null };

export async function runJob(job: JobName, options: Options): Promise<JobResult> {
  const runFor = options.date ?? defaultRunDate(job);
  const jobRunId = await inServerTransaction(async (db) => {
    const { rows } = await db.query<{ job_run_id: string }>(
      'insert into job_runs (job, run_for, triggered_by, triggered_by_user) values ($1, $2, $3, $4) returning job_run_id',
      [job, runFor, options.triggeredBy, options.userId ?? null],
    );
    return rows[0]!.job_run_id;
  });
  const finish = (status: JobResult['status'], counts: Record<string, number>, error?: string) =>
    inServerTransaction((db) =>
      db.query('update job_runs set status = $2, counts = $3, error = $4, finished_at = now() where job_run_id = $1', [jobRunId, status, counts, error ?? null]),
    );

  try {
    const counts = await inServerTransaction(async (db) => {
      const lock = await db.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext('job:' || $1)) as ok", [job]);
      if (!lock.rows[0]?.ok) return null;
      const { rows } = await db.query<{ counts: Record<string, number> }>(`select job_${job}($1::date) as counts`, [runFor]);
      return rows[0]!.counts;
    });
    if (counts === null) {
      await finish('skipped', {}, 'another run of this job was in progress');
      return { jobRunId, job, runFor, status: 'skipped', counts: {} };
    }
    const sent = job === 'daily' ? await sendDailyEmails(runFor, options.mailer) : job === 'weekly' ? await sendDigests(runFor, options.mailer) : {};
    // Each daily run also tries again the emails that failed on the last two days (decision 92).
    const retried = job === 'daily' ? await retryFailedEmails(runFor, options.mailer) : {};
    const all: Record<string, number> = { ...counts, ...sent, ...retried };
    // Decision 92: the job's own work is done, but if some emails were not sent it says so.
    const status = (all['emails_failed'] ?? 0) + (all['emails_retry_failed'] ?? 0) > 0 ? 'partial' : 'succeeded';
    await finish(status, all);
    return { jobRunId, job, runFor, status, counts: all };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish('failed', {}, message.slice(0, 1000));
    // A failed job always alerts the super administrators (docs/04 section 6).
    await logError({ source: 'job', error, detail: { job, runFor } }, options.mailer);
    return { jobRunId, job, runFor, status: 'failed', counts: {}, error: message };
  }
}

export type Recipient = { personId: string; name: string; email: string; lang: Lang };

/** Sends one email and logs it, once per person per day and kind (the unique index holds it). */
/**
 * Sends one person's email for one day, at most once. A failed send is claimed again by a later
 * run (each run is one more try) until MAX_EMAIL_ATTEMPTS; a sent one never is (decision 92).
 */
export async function sendOnce(recipient: Recipient, kind: 'daily' | 'weekly', runFor: string, build: () => { subject: string; text: string; html: string }, mailer: Mailer): Promise<'sent' | 'failed' | 'already'> {
  const claimed = await inServerTransaction(async (db) => {
    const { rowCount } = await db.query(
      `insert into notification_log (kind, person_id, channel, object_type, object_id, status, for_date)
       values ('email_sent', $1, 'email', $2, $3, 'queued', $4::date)
       on conflict (kind, person_id, object_type, object_id, coalesce(for_date, (sent_at at time zone 'UTC')::date))
       do update set status = 'queued', attempts = notification_log.attempts + 1
        where notification_log.status = 'failed' and notification_log.attempts < $5`,
      [recipient.personId, kind, runFor, runFor, MAX_EMAIL_ATTEMPTS],
    );
    return (rowCount ?? 0) > 0;
  });
  if (!claimed) return 'already';
  try {
    const id = await mailer.send({ to: recipient.email, ...build() });
    await inServerTransaction((db) =>
      db.query(
        "update notification_log set status = 'sent', provider_message_id = $4, sent_at = now() where kind = 'email_sent' and person_id = $1 and object_type = $2 and object_id = $3",
        [recipient.personId, kind, runFor, id],
      ),
    );
    return 'sent';
  } catch {
    await inServerTransaction((db) =>
      db.query("update notification_log set status = 'failed' where kind = 'email_sent' and person_id = $1 and object_type = $2 and object_id = $3", [recipient.personId, kind, runFor]),
    );
    return 'failed';
  }
}

// Names for what a notice is about: delivery items, risks and pathway stages.
const OBJECT_NAME = `coalesce(
  (select i.name from v_delivery_items i where i.object_type = n.object_type and i.object_id = n.object_id),
  (select k.description from risks k where n.object_type = 'risk' and k.risk_id = n.object_id),
  (select ps.label_en from reform_stages s join pathway_stages ps on ps.code = s.stage where n.object_type = 'reform_stage' and s.stage_record_id = n.object_id)) as name,
  (select ps.label_fr from reform_stages s join pathway_stages ps on ps.code = s.stage where n.object_type = 'reform_stage' and s.stage_record_id = n.object_id) as name_fr`;

type ReminderRow = {
  person_id: string;
  full_name: string;
  email: string;
  lang: Lang;
  kind: string;
  object_type: string;
  object_id: string;
  detail: Record<string, unknown> | null;
  name: string | null;
  name_fr: string | null;
};
const toReminder = (r: Pick<ReminderRow, 'kind' | 'object_type' | 'object_id' | 'detail' | 'name' | 'name_fr'>): Reminder => ({
  kind: r.kind,
  objectType: r.object_type,
  objectId: r.object_id,
  detail: r.detail,
  name: r.name,
  nameFr: r.name_fr,
});

async function dailyRecipients(db: pg.ClientBase, runFor: string): Promise<Map<string, Recipient & { reminders: Reminder[]; followUp: boolean }>> {
  const { rows } = await db.query<ReminderRow>(
    `select n.person_id, p.full_name, u.email, p.preferred_language as lang, n.kind, n.object_type, n.object_id, n.detail, ${OBJECT_NAME}
       from notification_log n
       join people p on p.person_id = n.person_id
       join app_users u on u.person_id = n.person_id and u.is_active
      where n.for_date = $1 and n.channel = 'in_app' and n.kind = any ($2) and p.email_reminders
      order by n.person_id, n.kind, n.object_id`,
    [runFor, [...REMINDER_KINDS, 'follow_up_list']],
  );
  const byPerson = new Map<string, Recipient & { reminders: Reminder[]; followUp: boolean }>();
  for (const r of rows) {
    const entry = byPerson.get(r.person_id) ?? { personId: r.person_id, name: r.full_name, email: r.email, lang: r.lang, reminders: [], followUp: false };
    if (r.kind === 'follow_up_list') entry.followUp = true;
    else entry.reminders.push(toReminder(r));
    byPerson.set(r.person_id, entry);
  }
  return byPerson;
}

/** Daily: one email per person bundling the day's reminders; admins also get the follow-up list. */
/** The day's reminder email to each person; `only` limits it to some people (a retry). */
async function sendDailyEmails(runFor: string, mailer: Mailer | null, only?: Set<string>): Promise<Record<string, number>> {
  if (!mailer) return { emails_disabled: 1 };
  const { recipients, followUps } = await inServerTransaction(async (db) => {
    const recipients = await dailyRecipients(db, runFor);
    const { rows } = await db.query<ReminderRow & { owner: string }>(
      `select n.kind, n.object_type, n.object_id, n.detail, ${OBJECT_NAME}, p.full_name as owner
         from notification_log n join people p on p.person_id = n.person_id
        where n.for_date = $1 and n.channel = 'in_app' and n.kind = any ($2)
          and not exists (select 1 from app_users u where u.person_id = n.person_id and u.is_active)
        order by p.full_name, n.object_id`,
      [runFor, [...REMINDER_KINDS]],
    );
    return { recipients, followUps: rows.map((r): FollowUp => ({ ...toReminder(r), owner: r.owner })) };
  });
  const counts = { emails_sent: 0, emails_failed: 0 };
  for (const r of recipients.values()) {
    if (only && !only.has(r.personId)) continue;
    const followUpsForThem = r.followUp ? followUps : [];
    if (r.reminders.length === 0 && followUpsForThem.length === 0) continue;
    const result = await sendOnce(r, 'daily', runFor, () => dailyEmail(r.lang, { name: r.name, reminders: r.reminders, followUps: followUpsForThem, baseUrl: env.appBaseUrl }), mailer);
    if (result === 'sent') counts.emails_sent += 1;
    if (result === 'failed') counts.emails_failed += 1;
  }
  return counts;
}

/** Days back a daily run looks for failed emails to try again (decision 92). */
export const RETRY_DAYS = 2;

/**
 * Tries again the daily and weekly emails that failed on the last RETRY_DAYS days, rebuilt for
 * their own day. Only failed ones: an email that was sent, or never tried, is left alone.
 */
async function retryFailedEmails(runFor: string, mailer: Mailer | null): Promise<Record<string, number>> {
  if (!mailer) return {};
  const failed = await inServerTransaction(async (db) =>
    (
      await db.query<{ object_type: 'daily' | 'weekly'; for_date: string; people: string[] }>(
        `select object_type, for_date::text, array_agg(person_id::text) as people
           from notification_log
          where kind = 'email_sent' and status = 'failed' and attempts < $3
            and object_type in ('daily', 'weekly') and for_date >= $1::date - $2::int and for_date < $1::date
          group by object_type, for_date order by for_date`,
        [runFor, RETRY_DAYS, MAX_EMAIL_ATTEMPTS],
      )
    ).rows,
  );
  const counts = { emails_retried: 0, emails_retry_failed: 0 };
  for (const f of failed) {
    const people = new Set(f.people);
    const result = f.object_type === 'daily' ? await sendDailyEmails(f.for_date, mailer, people) : await sendDigests(f.for_date, mailer, people);
    counts.emails_retried += result['emails_sent'] ?? 0;
    counts.emails_retry_failed += result['emails_failed'] ?? 0;
  }
  return counts;
}

/** Monday: each person's open items, and for admins the portfolio. */
async function sendDigests(runFor: string, mailer: Mailer | null, only?: Set<string>): Promise<Record<string, number>> {
  if (!mailer) return { emails_disabled: 1 };
  const data = await inServerTransaction(async (db) => {
    const recipients = await db.query<{ person_id: string; full_name: string; email: string; lang: Lang; is_admin: boolean }>(
      `select n.person_id, p.full_name, u.email, p.preferred_language as lang, u.app_role in ('super_admin', 'programme_admin') as is_admin
         from notification_log n join people p on p.person_id = n.person_id join app_users u on u.person_id = n.person_id and u.is_active
        where n.for_date = $1 and n.kind = 'weekly_digest' and n.channel = 'in_app'`,
      [runFor],
    );
    const items = await db.query<{ owner_person_id: string; object_type: string; object_id: string; name: string; due_date: string | null; days_overdue: number; days_since_update: number }>(
      `select owner_person_id, object_type, object_id, name, due_date, days_overdue, days_since_update from job_open_items($1::date)
        where owner_person_id = any ($2)
        order by days_overdue desc, days_since_update > 30 desc, due_date nulls last`,
      [runFor, recipients.rows.map((r) => r.person_id)],
    );
    const hasAdmin = recipients.rows.some((r) => r.is_admin);
    let portfolio: Portfolio | null = null;
    if (hasAdmin) {
      const reforms = await db.query<{ reform_id: string; items_overdue: number; items_stale: number; rag: string }>(
        'select reform_id, items_overdue::int, items_stale::int, rag from v_reform_summary order by reform_id',
      );
      const extra = await db.query<{ escalations: number; waiting: number }>(
        `select (select count(*)::int from escalations where raised_at > $1::date - 7 and resolved_at is null) as escalations,
                (select count(*)::int from submissions where status = 'proposed') as waiting`,
        [runFor],
      );
      portfolio = {
        reforms: reforms.rows.map((r) => ({ reformId: r.reform_id, overdue: r.items_overdue, stale: r.items_stale, rag: r.rag })),
        newEscalations: extra.rows[0]!.escalations,
        waitingApproval: extra.rows[0]!.waiting,
        trainingSuggested: (await trainingFlags(db)).length,
      };
    }
    return { recipients: recipients.rows, items: items.rows, portfolio };
  });
  const counts = { emails_sent: 0, emails_failed: 0 };
  for (const r of data.recipients) {
    if (only && !only.has(r.person_id)) continue;
    const theirs: DigestItem[] = data.items
      .filter((i) => i.owner_person_id === r.person_id)
      .map((i) => ({ objectType: i.object_type, objectId: i.object_id, name: i.name, dueDate: i.due_date, daysOverdue: i.days_overdue, daysSinceUpdate: i.days_since_update }));
    const recipient = { personId: r.person_id, name: r.full_name, email: r.email, lang: r.lang };
    const result = await sendOnce(
      recipient,
      'weekly',
      runFor,
      () => digestEmail(r.lang, { name: r.full_name, items: theirs.slice(0, DIGEST_ITEMS), totalItems: theirs.length, portfolio: r.is_admin ? data.portfolio : null, baseUrl: env.appBaseUrl }),
      mailer,
    );
    if (result === 'sent') counts.emails_sent += 1;
    if (result === 'failed') counts.emails_failed += 1;
  }
  return counts;
}
