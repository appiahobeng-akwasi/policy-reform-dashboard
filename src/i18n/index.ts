// i18n layer. Every user-facing string lives in en.json and fr.json; components
// call t(lang, key). Each user picks EN or FR; first visit follows the browser,
// falling back to English.
import en from './en.json';
import frJson from './fr.json';

export const LANGUAGES = ['en', 'fr'] as const;
export type Lang = (typeof LANGUAGES)[number];
export const DEFAULT_LANG: Lang = 'en';
export const LANG_COOKIE = 'lang';

type Catalogue = typeof en;
// Typed against the English catalogue so a missing French key fails the typecheck.
const fr: Catalogue = frJson;
const catalogues: Record<Lang, Catalogue> = { en, fr };

type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];
export type MessageKey = Paths<Catalogue>;

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  let node: unknown = catalogues[lang];
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`Missing ${lang} message: ${key}`);
  return node.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** First supported language in an Accept-Language header, honouring q values. */
export function parseAcceptLanguage(header: string | null | undefined): Lang | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { base: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((entry) => entry.q > 0 && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked.map((entry) => entry.base).find(isLang) ?? null;
}

/** Profile choice wins, then the saved cookie, then the browser, then English. */
export function resolveLanguage(sources: {
  profile?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Lang {
  if (isLang(sources.profile)) return sources.profile;
  if (isLang(sources.cookie)) return sources.cookie;
  return parseAcceptLanguage(sources.acceptLanguage) ?? DEFAULT_LANG;
}

const LOCALES: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR' };
// Kinshasa is UTC+1. Timestamps are stored in UTC and shown in local time.
export const DISPLAY_TIME_ZONE = 'Africa/Kinshasa';

/**
 * 14 Nov 2026 (EN) or 14 nov. 2026 (FR).
 * A 'YYYY-MM-DD' string is a calendar date and is shown as is; a Date or a
 * full timestamp is converted to Kinshasa time first.
 */
/** A number in the reader's style (72.5 or 72,5), at most one decimal. */
export function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: 1 }).format(value);
}

/** A date with the time, in Kinshasa time, for logs such as data quality attempts. */
export function formatDateTime(value: Date | string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(typeof value === 'string' ? new Date(value) : value);
}

/** A date such as "5 Aug 2026"; 'short' leaves out the year ("5 Aug"), for tight spaces. */
export function formatDate(value: Date | string, lang: Lang, style: 'full' | 'short' = 'full'): string {
  const isCalendarDate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = typeof value === 'string' ? new Date(isCalendarDate ? `${value}T00:00:00Z` : value) : value;
  return new Intl.DateTimeFormat(LOCALES[lang], {
    day: 'numeric',
    month: 'short',
    ...(style === 'full' ? { year: 'numeric' as const } : {}),
    timeZone: isCalendarDate ? 'UTC' : DISPLAY_TIME_ZONE,
  }).format(date);
}
