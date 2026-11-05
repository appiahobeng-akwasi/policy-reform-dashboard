// Build step 11: the pure parts of the users and data quality pages.
import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/en.json';
import fr from '../../src/i18n/fr.json';
import { periodBounds, readFilter, recentMonths } from '../../src/lib/admin/data-quality';
import { accessError, readAccessForm, readPersonForm } from '../../src/lib/admin/users';
import { RULE_SET_V1 } from '../../src/lib/gate/rules';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

describe('rule names', () => {
  it('every rule in the rule set has a short name in English and French, and nothing extra', () => {
    const ids = RULE_SET_V1.rules.map((r) => r.id).sort();
    expect(Object.keys(en.rules).sort()).toEqual(ids);
    expect(Object.keys(fr.rules).sort()).toEqual(ids);
  });
});

describe('the add and edit user form', () => {
  it('reads name, email, role, language and reforms', () => {
    const { input, problems } = readAccessForm(
      form({ name: ' Marie Example ', email: ' Marie.K@Gmail.com ', role: 'reform_lead', language: 'fr', scope_RA1: 'on', approve_RA2: 'on' }),
      ['RA1', 'RA2', 'RA3'],
    );
    expect(problems).toEqual([]);
    expect(input).toEqual({
      name: 'Marie Example',
      email: 'marie.k@gmail.com',
      role: 'reform_lead',
      language: 'fr',
      scope: [
        { reformId: 'RA1', canApprove: false },
        { reformId: 'RA2', canApprove: true },
      ],
    });
  });

  it('flags a missing name, a bad email and an unknown role', () => {
    expect(readAccessForm(form({ name: '', email: 'not-an-email', role: 'owner' }), []).problems).toEqual(['name', 'email', 'role']);
  });

  it('ignores reforms that do not exist', () => {
    expect(readAccessForm(form({ name: 'A', email: 'a@b.cd', role: 'contributor', scope_RA9: 'on' }), ['RA1']).input.scope).toEqual([]);
  });
});

describe('the person form', () => {
  it('allows no email, and checks the institution against the list', () => {
    const ok = readPersonForm(form({ name: 'Jean', email: '', institution: '', language: 'fr' }), ['i1']);
    expect(ok.problems).toEqual([]);
    expect(ok.input).toMatchObject({ email: null, institutionId: null, language: 'fr' });
    expect(readPersonForm(form({ name: 'Jean', email: 'x', institution: 'other' }), ['i1']).problems).toEqual(['email', 'institution']);
  });
});

describe('database refusals', () => {
  it('map to a code with a message', () => {
    expect(accessError(new Error('U05: there must always be one active super administrator'))).toBe('U05');
    expect(accessError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe('U08');
    expect(accessError(Object.assign(new Error('new row violates row-level security policy'), { code: '42501' }))).toBe('forbidden');
    expect(accessError(new Error('connection lost'))).toBe('other');
  });

  it('every code has a message in both languages', () => {
    for (const code of ['U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'forbidden', 'other']) {
      expect(en.admin, code).toHaveProperty(`error_${code}`);
      expect(fr.admin, code).toHaveProperty(`error_${code}`);
    }
  });
});

describe('months on the data quality page are Kinshasa months (UTC+1)', () => {
  it('a month starts at 23:00 UTC the evening before', () => {
    const { from, to } = periodBounds('2026-11');
    expect(from.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(to?.toISOString()).toBe('2026-11-30T23:00:00.000Z');
  });

  it('just after midnight in Kinshasa on 1 December is already December', () => {
    const now = new Date('2026-11-30T23:30:00Z');
    expect(recentMonths(now, 2)).toEqual(['2026-12', '2026-11']);
    expect(periodBounds('last3', now).from.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(periodBounds('last12', now)).toEqual({ from: new Date('2025-12-31T23:00:00Z'), to: null });
  });

  it('an invalid period falls back to the last three months', () => {
    expect(readFilter(new URLSearchParams('period=2026-00'), []).period).toBe('last3');
  });
});
