// What reminders and digests say, in the reader's language (spec 01 section 10). Pure: the job
// runner and the notices page pass in what they found. Emails are plain text plus simple HTML,
// small enough for a slow connection.
import { formatDate, t, type Lang, type MessageKey } from '../../i18n';

export const REMINDER_KINDS = ['due_soon', 'overdue', 'escalation', 'stale_item', 'risk_review', 'pathway_stalled'] as const;

export type Reminder = {
  kind: string;
  objectType: string;
  objectId: string;
  name: string | null;
  /** French name where it differs (pathway stages). */
  nameFr?: string | null;
  detail: Record<string, unknown> | null;
};
export type FollowUp = Reminder & { owner: string };
export type Email = { subject: string; text: string; html: string };

function typeLabel(lang: Lang, objectType: string): string {
  try {
    return t(lang, `items.type_${objectType}` as MessageKey);
  } catch {
    try {
      return t(lang, `jobs.type_${objectType}` as MessageKey);
    } catch {
      return objectType;
    }
  }
}

/** "Milestone MS-104: Validation workshop held", "Jalon MS-104 : ..." */
export function itemLabel(lang: Lang, r: Pick<Reminder, 'objectType' | 'objectId' | 'name' | 'nameFr'>): string {
  const name = lang === 'fr' && r.nameFr ? r.nameFr : r.name;
  // French puts a space before a colon.
  return `${typeLabel(lang, r.objectType)} ${r.objectId}${name ? `${lang === 'fr' ? ' :' : ':'} ${name}` : ''}`;
}

/** Where the reader acts on it: the item's page, or the Pathway view for a stage. Null for risks. */
export function itemPath(r: Pick<Reminder, 'objectType' | 'objectId'>, reformId?: string | null): string | null {
  if (['workstream', 'deliverable', 'activity', 'milestone'].includes(r.objectType)) return `/items/${r.objectType}/${r.objectId}`;
  if (r.objectType === 'reform_stage') return reformId ? `/pathway?reform=${reformId}` : '/pathway';
  return null;
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const day = (value: unknown, lang: Lang): string => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value.slice(0, 10), lang) : str(value));

/** One sentence for a reminder, used in notices and in the daily email. */
export function reminderText(lang: Lang, r: Reminder): string {
  const item = itemLabel(lang, r);
  const d = r.detail ?? {};
  switch (r.kind) {
    case 'due_soon':
      return t(lang, 'jobs.due_soon', { item, date: day(d['due_date'], lang) });
    case 'overdue':
      return t(lang, 'jobs.overdue', { item, days: str(d['days']), level: str(d['level']) });
    case 'escalation':
      return t(lang, 'jobs.escalation', { item, days: str(d['days']), level: str(d['level']) });
    case 'stale_item':
      return t(lang, 'jobs.stale', { item, days: str(d['days']) });
    case 'risk_review':
      return t(lang, 'jobs.risk_review', { item, date: day(d['review_date'], lang) });
    case 'pathway_stalled':
      return t(lang, 'jobs.pathway_stalled', { item });
    case 'follow_up_list':
      return t(lang, 'jobs.follow_up_list', { n: str(d['reminders']) });
    default:
      return item;
  }
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(lang: Lang, heading: string, body: string): string {
  return `<!doctype html><html lang="${lang}"><body style="font-family:Arial,sans-serif;line-height:1.5;color:#1a1a1a;max-width:40rem">
<h1 style="font-size:1.25rem">${escape(heading)}</h1>${body}
<p style="color:#555;font-size:0.875rem">${escape(t(lang, 'jobs.email_footer'))}</p></body></html>`;
}

function list(items: { text: string; href: string | null }[]): string {
  return `<ul>${items.map((i) => `<li>${i.href ? `<a href="${escape(i.href)}">${escape(i.text)}</a>` : escape(i.text)}</li>`).join('')}</ul>`;
}

/** The one email a day that bundles a person's reminders (decision 48). */
export function dailyEmail(lang: Lang, input: { name: string; reminders: Reminder[]; followUps: FollowUp[]; baseUrl: string }): Email {
  const link = (r: Reminder) => {
    const path = itemPath(r);
    return path ? `${input.baseUrl}${path}` : null;
  };
  const mine = input.reminders.map((r) => ({ text: reminderText(lang, r), href: link(r) }));
  const others = input.followUps.map((r) => ({ text: t(lang, 'jobs.follow_up_item', { owner: r.owner, text: reminderText(lang, r) }), href: link(r) }));
  const subject = t(lang, 'jobs.daily_subject');
  const greeting = t(lang, 'jobs.greeting', { name: input.name });
  const myItems = `${input.baseUrl}/my-items`;
  const onBehalf = `${input.baseUrl}/on-behalf`;
  const textParts = [greeting, ''];
  let html = `<p>${escape(greeting)}</p>`;
  if (mine.length > 0) {
    textParts.push(t(lang, 'jobs.daily_yours'), ...mine.map((m) => `- ${m.text}${m.href ? ` ${m.href}` : ''}`), '', t(lang, 'jobs.open_my_items', { url: myItems }), '');
    html += `<p>${escape(t(lang, 'jobs.daily_yours'))}</p>${list(mine)}<p><a href="${escape(myItems)}">${escape(t(lang, 'nav.my_items'))}</a></p>`;
  }
  if (others.length > 0) {
    textParts.push(t(lang, 'jobs.daily_follow_up'), ...others.map((m) => `- ${m.text}${m.href ? ` ${m.href}` : ''}`), '', t(lang, 'jobs.open_on_behalf', { url: onBehalf }), '');
    html += `<p>${escape(t(lang, 'jobs.daily_follow_up'))}</p>${list(others)}<p><a href="${escape(onBehalf)}">${escape(t(lang, 'nav.on_behalf'))}</a></p>`;
  }
  textParts.push(t(lang, 'jobs.email_footer'));
  return { subject, text: textParts.join('\n'), html: page(lang, subject, html) };
}

export type DigestItem = { objectType: string; objectId: string; name: string; dueDate: string | null; daysOverdue: number; daysSinceUpdate: number };
export type Portfolio = {
  reforms: { reformId: string; overdue: number; stale: number; rag: string }[];
  newEscalations: number;
  waitingApproval: number;
  trainingSuggested: number;
};

function digestLine(lang: Lang, i: DigestItem): string {
  const label = itemLabel(lang, i);
  if (i.daysOverdue > 0) return t(lang, 'jobs.digest_overdue', { item: label, days: i.daysOverdue });
  if (i.daysSinceUpdate > 30) return t(lang, 'jobs.digest_stale', { item: label, days: i.daysSinceUpdate });
  return i.dueDate ? t(lang, 'jobs.digest_due', { item: label, date: formatDate(i.dueDate, lang) }) : label;
}

/** Monday digest: the person's open items, and for admins the portfolio (spec 01 section 10). */
export function digestEmail(lang: Lang, input: { name: string; items: DigestItem[]; totalItems: number; portfolio: Portfolio | null; baseUrl: string }): Email {
  const subject = t(lang, 'jobs.digest_subject');
  const greeting = t(lang, 'jobs.greeting', { name: input.name });
  const lines = input.items.map((i) => {
    const path = itemPath(i);
    return { text: digestLine(lang, i), href: path ? `${input.baseUrl}${path}` : null };
  });
  const textParts = [greeting, ''];
  let html = `<p>${escape(greeting)}</p>`;
  if (input.totalItems > 0) {
    const intro = t(lang, 'jobs.digest_items', { n: input.totalItems });
    textParts.push(intro, ...lines.map((l) => `- ${l.text}${l.href ? ` ${l.href}` : ''}`));
    html += `<p>${escape(intro)}</p>${list(lines)}`;
    if (input.totalItems > input.items.length) {
      const more = t(lang, 'jobs.digest_more', { n: input.totalItems - input.items.length });
      textParts.push(more);
      html += `<p>${escape(more)}</p>`;
    }
    textParts.push('', t(lang, 'jobs.open_my_items', { url: `${input.baseUrl}/my-items` }), '');
  }
  if (input.portfolio) {
    const p = input.portfolio;
    const heading = t(lang, 'jobs.digest_portfolio');
    const rows = p.reforms.map((r) => t(lang, 'jobs.digest_reform', { reform: r.reformId, overdue: r.overdue, stale: r.stale }));
    const extra = [
      t(lang, 'jobs.digest_escalations', { n: p.newEscalations }),
      t(lang, 'jobs.digest_approvals', { n: p.waitingApproval }),
      t(lang, 'jobs.digest_training', { n: p.trainingSuggested }),
    ];
    textParts.push(heading, ...rows.map((r) => `- ${r}`), ...extra.map((e) => `- ${e}`), '', t(lang, 'jobs.open_executive', { url: `${input.baseUrl}/executive` }), '');
    html += `<h2 style="font-size:1rem">${escape(heading)}</h2>${list([...rows, ...extra].map((text) => ({ text, href: null })))}<p><a href="${escape(`${input.baseUrl}/executive`)}">${escape(t(lang, 'nav.executive'))}</a></p>`;
  }
  textParts.push(t(lang, 'jobs.email_footer'));
  return { subject, text: textParts.join('\n'), html: page(lang, subject, html) };
}
