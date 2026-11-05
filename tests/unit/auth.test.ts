import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/lib/db';
import { parseScope } from '../../scripts/lib/users';
import { isAllowedBeforeMfa, isPublicPath, needsMfa, signInPath } from '../../src/lib/auth/access';
import { signInEmailHtml, signInEmailSubject, SIGN_IN_TEMPLATE_PATH } from '../../src/lib/email/sign-in-template';
import { hasSessionCookie } from '../../src/lib/platform/supabase-auth';

describe('which pages need sign-in', () => {
  it.each(['/', '/sign-in', '/auth/confirm', '/auth/sent', '/auth/sign-out', '/api/lang', '/sign-in/'])('%s is open to everyone', (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each(['/account', '/auth/mfa', '/approvals', '/sign-in-later'])('%s needs sign-in', (path) => {
    expect(isPublicPath(path)).toBe(false);
  });

  it('keeps the page asked for, except the home page', () => {
    expect(signInPath('/account?tab=2')).toBe('/sign-in?next=%2Faccount%3Ftab%3D2');
    expect(signInPath('/')).toBe('/sign-in');
  });
});

describe('MFA', () => {
  it('is needed only by accounts that require it, until the session reaches aal2', () => {
    expect(needsMfa({ mfaRequired: true, aal: 'aal1' })).toBe(true);
    expect(needsMfa({ mfaRequired: true, aal: 'aal2' })).toBe(false);
    expect(needsMfa({ mfaRequired: false, aal: 'aal1' })).toBe(false);
  });

  it('lets an admin reach only the sign-in pages and the language switch before MFA', () => {
    expect(isAllowedBeforeMfa('/auth/mfa')).toBe(true);
    expect(isAllowedBeforeMfa('/auth/sign-out')).toBe(true);
    expect(isAllowedBeforeMfa('/api/lang')).toBe(true);
    expect(isAllowedBeforeMfa('/account')).toBe(false);
    expect(isAllowedBeforeMfa('/')).toBe(false);
  });
});

describe('session cookie detection', () => {
  it('spots Supabase session cookies, including split ones', () => {
    expect(hasSessionCookie('lang=fr; sb-127-auth-token=abc')).toBe(true);
    expect(hasSessionCookie('sb-127-auth-token.0=abc; sb-127-auth-token.1=def')).toBe(true);
    expect(hasSessionCookie('lang=fr')).toBe(false);
    expect(hasSessionCookie(null)).toBe(false);
  });
});

describe('sign-in email', () => {
  it('the template file is up to date with the catalogues (run npm run build:email-templates)', () => {
    expect(readFileSync(join(ROOT, SIGN_IN_TEMPLATE_PATH), 'utf8')).toBe(signInEmailHtml());
  });

  it('carries both languages and the one-time link', () => {
    const html = signInEmailHtml();
    expect(html).toContain('lang="en"');
    expect(html).toContain('lang="fr"');
    expect(html).toContain('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email');
  });

  it('has the subject from the catalogues in supabase/config.toml', () => {
    const config = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
    const subjects = [...config.matchAll(/^subject = "(.*)"$/gm)].map((m) => m[1]);
    expect(subjects).toEqual([signInEmailSubject(), signInEmailSubject()]);
  });
});

describe('users:add scope', () => {
  it('reads a reform, with or without approval rights', () => {
    expect(parseScope('RA1')).toEqual({ reformId: 'RA1', canApprove: false });
    expect(parseScope('RA2:approve')).toEqual({ reformId: 'RA2', canApprove: true });
    expect(() => parseScope('RA1:admin')).toThrow(/not valid/);
  });
});
