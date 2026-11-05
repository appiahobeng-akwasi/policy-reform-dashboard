// Error logging (spec 01 section 11, docs/04 section 6, decision 64). Each server error gets a
// reference the person sees on the error page; one JSON line goes to the server's output (for the
// host's log collector) and a row to error_log (for the Errors page). A failed scheduled job, or
// five errors in ten minutes, alerts the super administrators, at most once an hour each.
// Nothing personal is kept: no request bodies, cookies or query strings, and emails, tokens and
// keys are removed from messages.
import { randomBytes } from 'node:crypto';
import type { Mailer } from './email/mailer';
import { env } from './env';
import { inServerTransaction } from './server-db';
import { t, type Lang } from '../i18n';

const BURST = { errors: 5, minutes: 10 };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short reference such as E-7K2Q9X, easy to read out on the phone. */
export function newReference(): string {
  return `E-${[...randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

/** Removes emails, bearer tokens, JWTs, long keys and connection strings from a message. */
export function clean(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s'"]+/gi, (url) => url.replace(/\/\/[^@/\s]*@/, '//[credentials]@').replace(/\?.*$/, ''))
    .replace(/Bearer\s+[\w.~+/-]+=*/gi, 'Bearer [token]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/\b(sb_(?:secret|publishable)_[\w-]+)/g, '[key]')
    // Long keys and tokens; not file paths, which contain slashes.
    .replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[long value]')
    .slice(0, 2000);
}

export type ErrorReport = {
  source: 'request' | 'job' | 'email';
  error: unknown;
  method?: string;
  path?: string;
  status?: number;
  userId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
};

/** Logs an error and returns its reference. Never throws: logging must not cause a second error. */
export async function logError(report: ErrorReport, mailer: Mailer | null = null): Promise<string> {
  const reference = newReference();
  const err = report.error instanceof Error ? report.error : new Error(String(report.error));
  const entry = {
    level: 'error',
    reference,
    at: new Date().toISOString(),
    source: report.source,
    method: report.method ?? null,
    path: report.path ?? null,
    status: report.status ?? null,
    userId: report.userId ?? null,
    name: err.name,
    message: clean(err.message),
    stack: err.stack ? clean(err.stack).split('\n').slice(0, 8).join('\n') : null,
    detail: report.detail ?? null,
  };
  console.error(JSON.stringify(entry));
  try {
    await inServerTransaction((db) =>
      db.query(
        `insert into error_log (reference, source, method, path, status, user_id, error_name, message, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [reference, entry.source, entry.method, entry.path, entry.status, entry.userId, entry.name, entry.message, { ...(report.detail ?? {}), stack: entry.stack }],
      ),
    );
    await maybeAlert(report.source === 'job', mailer);
  } catch (logFailure) {
    console.error(JSON.stringify({ level: 'error', reference, message: 'could not save to error_log', cause: clean(String(logFailure)) }));
  }
  return reference;
}

/** Alerts super administrators about a failed job, or a burst of errors; once an hour each. */
async function maybeAlert(always: boolean, mailer: Mailer | null): Promise<void> {
  const recipients = await inServerTransaction(async (db) => {
    if (!always) {
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from error_log where at > now() - make_interval(mins => $1)`, [BURST.minutes]);
      if ((rows[0]?.n ?? 0) < BURST.errors) return [];
    }
    const hour = new Date().toISOString().slice(0, 13);
    const { rows } = await db.query<{ email: string; lang: Lang; n: number }>(
      `with alerted as (
         insert into notification_log (kind, person_id, channel, object_type, object_id, status)
         select 'error_alert', u.person_id, 'in_app', 'hour', $1, 'queued' from app_users u
          where u.is_active and u.app_role = 'super_admin'
         on conflict do nothing
         returning person_id)
       select u.email, p.preferred_language as lang,
              (select count(*)::int from error_log where at > now() - interval '1 hour') as n
         from alerted a join app_users u on u.person_id = a.person_id join people p on p.person_id = a.person_id`,
      [hour],
    );
    return rows;
  });
  if (!mailer) return;
  for (const r of recipients) {
    const link = `${env.appBaseUrl}/admin/errors`;
    const text = `${t(r.lang, 'errors.alert_body', { n: r.n })}\n\n${link}`;
    await mailer.send({ to: r.email, subject: t(r.lang, 'errors.alert_subject'), text, html: `<p>${t(r.lang, 'errors.alert_body', { n: r.n })}</p><p><a href="${link}">${link}</a></p>` }).catch(() => undefined);
  }
}

/** A plain page for a server error or a refused request, in the person's language. */
export function plainPage(lang: Lang, status: number, title: string, message: string): Response {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">${esc(t(lang, 'errors.back_home'))}</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' },
  });
}
