import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/en.json';
import fr from '../../src/i18n/fr.json';
import { formatDate, isLang, parseAcceptLanguage, resolveLanguage, t, type MessageKey } from '../../src/i18n';

function flatten(obj: object, prefix = ''): Record<string, unknown> {
  return Object.entries(obj).reduce<Record<string, unknown>>((acc, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) Object.assign(acc, flatten(value, path));
    else acc[path] = value;
    return acc;
  }, {});
}

describe('catalogues', () => {
  const enFlat = flatten(en);
  const frFlat = flatten(fr);

  it('EN and FR have exactly the same keys', () => {
    expect(Object.keys(frFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it.each(Object.entries({ en: enFlat, fr: frFlat }))('every %s message is a non-empty string', (_lang, flat) => {
    for (const [key, value] of Object.entries(flat)) {
      expect(typeof value, key).toBe('string');
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('uses the same {placeholders} in both languages', () => {
    for (const [key, value] of Object.entries(enFlat)) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(frFlat[key] as string), key).toEqual(names(value as string));
    }
  });

  it('contains no em dashes (house style)', () => {
    for (const [key, value] of Object.entries({ ...enFlat, ...frFlat })) {
      expect(value as string, key).not.toContain('—');
    }
  });
});

describe('t()', () => {
  it('returns the message in the chosen language', () => {
    expect(t('en', 'language.label')).toBe('Language');
    expect(t('fr', 'language.label')).toBe('Langue');
  });

  it('fills placeholders', () => {
    expect(t('en', 'language.switch_to', { name: 'Français' })).toBe('Show the site in Français');
  });
});

describe('language choice', () => {
  it('accepts only en and fr', () => {
    expect(isLang('en')).toBe(true);
    expect(isLang('fr')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });

  it('reads the browser language, honouring q values', () => {
    expect(parseAcceptLanguage('fr-CD,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(parseAcceptLanguage('de-DE,en;q=0.5,fr;q=0.7')).toBe('fr');
    expect(parseAcceptLanguage('en-GB')).toBe('en');
    expect(parseAcceptLanguage('ln,sw')).toBeNull();
    expect(parseAcceptLanguage('')).toBeNull();
  });

  it('profile wins over cookie, cookie over browser, then English', () => {
    expect(resolveLanguage({ profile: 'fr', cookie: 'en', acceptLanguage: 'en' })).toBe('fr');
    expect(resolveLanguage({ cookie: 'fr', acceptLanguage: 'en' })).toBe('fr');
    expect(resolveLanguage({ acceptLanguage: 'fr-FR' })).toBe('fr');
    expect(resolveLanguage({ acceptLanguage: 'ln' })).toBe('en');
    expect(resolveLanguage({})).toBe('en');
  });

  it('ignores an unknown cookie value', () => {
    expect(resolveLanguage({ cookie: 'xx', acceptLanguage: 'fr' })).toBe('fr');
  });
});

describe('formatDate()', () => {
  it('shows dates as 14 Nov 2026 (EN) and 14 nov. 2026 (FR)', () => {
    expect(formatDate('2026-11-14', 'en')).toBe('14 Nov 2026');
    expect(formatDate('2026-11-14', 'fr')).toBe('14 nov. 2026');
  });

  it('converts stored UTC timestamps to Kinshasa time (UTC+1)', () => {
    // 23:30 UTC on 13 Nov is 00:30 on 14 Nov in Kinshasa.
    expect(formatDate(new Date('2026-11-13T23:30:00Z'), 'en')).toBe('14 Nov 2026');
  });

  it('does not shift calendar dates', () => {
    expect(formatDate('2026-07-29', 'en')).toBe('29 Jul 2026');
  });
});

describe('field labels', () => {
  it('every field a submission can change has a plain label in both languages', async () => {
    const { ENTITY_SPECS } = await import('../../src/lib/gate/entities');
    const fields = new Set(Object.values(ENTITY_SPECS).flatMap((spec) => [...spec.writable, spec.idField]));
    for (const field of fields) {
      expect(() => t('en', `fields.${field}` as MessageKey), field).not.toThrow();
      expect(() => t('fr', `fields.${field}` as MessageKey), field).not.toThrow();
    }
  });
});
