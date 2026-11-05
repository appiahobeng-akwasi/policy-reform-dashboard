// Pure helpers for npm run hosted:email (decision 93). No network, no files: tested in
// tests/unit/hosted-email.test.ts.
//
// One provider (Resend, over SMTP) sends every email: Supabase Auth sends the sign-in emails,
// the app sends reminders and digests. Using our own SMTP is what lets Supabase use the app's
// sign-in email, whose link opens the "Finish signing in" page instead of signing in on open,
// so email link scanners cannot use it up.
import { signInEmailHtml, signInEmailSubject } from '../../src/lib/email/sign-in-template';

export const RESEND_SMTP = { host: 'smtp.resend.com', port: 465, secure: true, user: 'resend' } as const;

/** Resend's shared test sender: works with no domain, but only delivers to the Resend account's own email. */
export const RESEND_TEST_SENDER = 'onboarding@resend.dev';

/** Sign-in links last one hour (spec 01, the sign-in page says so). */
export const SIGN_IN_LINK_SECONDS = 3600;

export type EmailSettings = {
  apiKey: string;
  senderName: string;
  senderAddress: string;
  siteUrl: string;
  emailsPerHour: number;
};

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function checkSettings(s: EmailSettings): void {
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(s.apiKey)) throw new Error('A Resend API key starts with re_.');
  if (!ADDRESS.test(s.senderAddress)) throw new Error(`Not an email address: ${s.senderAddress}`);
  if (!s.senderName.trim() || /[<>"\r\n]/.test(s.senderName)) throw new Error('The sender name must be plain text.');
  const site = new URL(s.siteUrl);
  if (site.protocol !== 'https:' || site.pathname !== '/') throw new Error('The site address must be https with no path.');
  if (!Number.isInteger(s.emailsPerHour) || s.emailsPerHour < 1 || s.emailsPerHour > 1000) throw new Error('Emails per hour must be between 1 and 1000.');
}

/** The From header the app uses for reminders and digests. */
export function emailFrom(s: Pick<EmailSettings, 'senderName' | 'senderAddress'>): string {
  return `${s.senderName.trim()} <${s.senderAddress}>`;
}

/**
 * The body of PATCH /v1/projects/{ref}/config/auth (Supabase Management API): our SMTP, the
 * app's bilingual sign-in email for both new and returning people, one-hour links and the
 * project-wide hourly email limit.
 */
export function supabaseAuthEmailConfig(s: EmailSettings): Record<string, string | number | boolean> {
  checkSettings(s);
  const subject = signInEmailSubject();
  const html = signInEmailHtml();
  return {
    site_url: s.siteUrl.replace(/\/$/, ''),
    external_email_enabled: true,
    smtp_host: RESEND_SMTP.host,
    smtp_port: String(RESEND_SMTP.port),
    smtp_user: RESEND_SMTP.user,
    smtp_pass: s.apiKey,
    smtp_admin_email: s.senderAddress,
    smtp_sender_name: s.senderName.trim(),
    rate_limit_email_sent: s.emailsPerHour,
    mailer_otp_exp: SIGN_IN_LINK_SECONDS,
    mailer_subjects_magic_link: subject,
    mailer_templates_magic_link_content: html,
    mailer_subjects_confirmation: subject,
    mailer_templates_confirmation_content: html,
  };
}

/** What to check in GET /config/auth after the update. Empty when all is as it should be. */
export function authEmailProblems(config: Record<string, unknown>, s: EmailSettings): string[] {
  const problems: string[] = [];
  if (config['smtp_host'] !== RESEND_SMTP.host) problems.push('Supabase is not sending through Resend.');
  if (config['smtp_admin_email'] !== s.senderAddress) problems.push('Supabase has a different sender address.');
  if (config['rate_limit_email_sent'] !== s.emailsPerHour) problems.push('The hourly email limit did not change.');
  if (Number(config['mailer_otp_exp']) !== SIGN_IN_LINK_SECONDS) problems.push('Sign-in links do not last one hour.');
  for (const key of ['mailer_templates_magic_link_content', 'mailer_templates_confirmation_content']) {
    const html = String(config[key] ?? '');
    if (!html.includes('/auth/confirm?token_hash={{ .TokenHash }}') || html.includes('ConfirmationURL')) {
      problems.push('Supabase still uses its own sign-in link, which email scanners can use up.');
      break;
    }
  }
  return problems;
}

/** The app's own email settings, for .env.hosted and Vercel. Only SMTP_PASS is secret. */
export function appEmailEnv(s: EmailSettings): Record<string, string> {
  return {
    SMTP_HOST: RESEND_SMTP.host,
    SMTP_PORT: String(RESEND_SMTP.port),
    SMTP_SECURE: String(RESEND_SMTP.secure),
    SMTP_USER: RESEND_SMTP.user,
    SMTP_PASS: s.apiKey,
    EMAIL_FROM: emailFrom(s),
  };
}

// --- A programme domain (decision 93): Resend sends as it; its DNS is on Vercel. ---

/** Resend region for a programme domain: Ireland, the closest to the app in London. */
export const RESEND_REGION = 'eu-west-1';

/** Name of the sending-only Resend key the app and Supabase use; the set-up key is not stored. */
export const SENDING_KEY_NAME = 'dashboard sending';

/** DMARC at quarantine (docs/04 section 6a): mail failing SPF and DKIM is not delivered as genuine. */
export const DMARC_VALUE = 'v=DMARC1; p=quarantine; adkim=r; aspf=r';

export type ResendRecord = { record?: string; name: string; type: string; value: string; priority?: number | null };
export type DnsRecord = { name: string; type: 'MX' | 'TXT' | 'CNAME'; value: string; mxPriority?: number };
export type ExistingDnsRecord = { name: string; type: string; value: string };

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1 || !ADDRESS.test(address)) throw new Error(`Not an email address: ${address}`);
  return address.slice(at + 1).toLowerCase();
}

export function isTestSender(address: string): boolean {
  return address.toLowerCase() === RESEND_TEST_SENDER;
}

export function checkDomain(domain: string): void {
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error(`Not a domain name: ${domain}`);
  if (domain.endsWith('resend.dev') || domain.endsWith('vercel.app')) throw new Error(`${domain} is not yours to send from.`);
}

/** A record name as Vercel wants it: relative to the domain, "" for the domain itself. */
function relativeName(name: string, domain: string): string {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (n === domain || n === '@' || n === '') return '';
  return n.endsWith(`.${domain}`) ? n.slice(0, -(domain.length + 1)) : n;
}

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
const normal = (value: string) => unquote(value).replace(/\.$/, '').toLowerCase();

/**
 * The DNS records to create on Vercel: Resend's sending records (SPF as MX and TXT, DKIM), never
 * its receiving records (we do not take mail in), plus DMARC.
 */
export function dnsRecordsFor(domain: string, resend: ResendRecord[]): DnsRecord[] {
  checkDomain(domain);
  const wanted: DnsRecord[] = [];
  for (const r of resend) {
    if (r.record && !['SPF', 'DKIM'].includes(r.record)) continue;
    const type = r.type.toUpperCase();
    if (type !== 'MX' && type !== 'TXT' && type !== 'CNAME') throw new Error(`Resend asked for a ${r.type} record, which this command does not set. Add it by hand in Vercel.`);
    const value = type === 'CNAME' ? unquote(r.value).replace(/\.$/, '') : unquote(r.value);
    const record: DnsRecord = { name: relativeName(r.name, domain), type, value };
    if (type === 'MX') record.mxPriority = r.priority ?? 10;
    wanted.push(record);
  }
  if (!wanted.some((r) => (r.type === 'TXT' && r.value.startsWith('v=spf1')) || r.type === 'MX')) throw new Error('Resend gave no SPF record.');
  if (!wanted.some((r) => r.name.includes('_domainkey'))) throw new Error('Resend gave no DKIM record.');
  wanted.push({ name: '_dmarc', type: 'TXT', value: DMARC_VALUE });
  return wanted;
}

const same = (a: ExistingDnsRecord, b: DnsRecord) => a.type.toUpperCase() === b.type && a.name.toLowerCase() === b.name && normal(a.value) === normal(b.value);

/**
 * What to add, and what is in the way: an SPF or DMARC record already there with another value
 * (two SPF records break SPF, so we never add a second one) or another DKIM key.
 */
export function planDns(wanted: DnsRecord[], existing: ExistingDnsRecord[]): { add: DnsRecord[]; conflicts: string[] } {
  const add: DnsRecord[] = [];
  const conflicts: string[] = [];
  for (const record of wanted) {
    if (existing.some((e) => same(e, record))) continue;
    // A CNAME cannot share its name with any other record.
    const taken = existing.find((e) => e.name.toLowerCase() === record.name && (record.type === 'CNAME' || e.type.toUpperCase() === 'CNAME'));
    if (taken) {
      conflicts.push(`${taken.type} ${record.name || '@'} already has "${unquote(taken.value).slice(0, 60)}"`);
      continue;
    }
    const kind = record.value.startsWith('v=spf1') ? 'v=spf1' : record.value.startsWith('v=DMARC1') ? 'v=DMARC1' : record.name.includes('_domainkey') ? '' : null;
    const clash =
      kind !== null &&
      existing.find((e) => e.type.toUpperCase() === record.type && e.name.toLowerCase() === record.name && unquote(e.value).startsWith(kind));
    if (clash) conflicts.push(`${record.type} ${record.name || '@'} already has "${unquote(clash.value).slice(0, 60)}"`);
    else add.push(record);
  }
  return { add, conflicts };
}
