// The open-source notice (decision 97): MIT licence with the configured holder, a public About
// page, and credits for the main open-source parts.
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../src/i18n';
import { APP_VERSION, CREDITS, licenceParagraphs, mitLicence } from '../../src/lib/about';
import { isPublicPath } from '../../src/lib/auth/access';
import { env } from '../../src/lib/env';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['COPYRIGHT_HOLDER', 'SOURCE_CODE_URL', 'VERCEL_GIT_COMMIT_SHA', 'GIT_COMMIT']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the open-source notice', () => {
  it('is the MIT licence with the copyright holder, the same text as the published LICENSE', () => {
    const text = mitLicence('Green Growth Programme');
    expect(text.startsWith('MIT License\n\nCopyright (c) 2026 Green Growth Programme\n')).toBe(true);
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    const paragraphs = licenceParagraphs('Green Growth Programme');
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs.join('\n\n').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '));
  });

  it('defaults to the Green Growth Programme and the public repository; adopters set their own', () => {
    delete process.env['COPYRIGHT_HOLDER'];
    delete process.env['SOURCE_CODE_URL'];
    expect(env.copyrightHolder).toBe('Green Growth Programme');
    expect(env.sourceCodeUrl).toBe('https://github.com/appiahobeng-akwasi/policy-reform-dashboard');
    process.env['COPYRIGHT_HOLDER'] = 'Ministry of Planning';
    process.env['SOURCE_CODE_URL'] = 'https://git.example.org/dashboard';
    expect(env.copyrightHolder).toBe('Ministry of Planning');
    expect(env.sourceCodeUrl).toBe('https://git.example.org/dashboard');
    process.env['SOURCE_CODE_URL'] = 'javascript:alert(1)';
    expect(env.sourceCodeUrl).toBe('https://github.com/appiahobeng-akwasi/policy-reform-dashboard');
  });

  it('shows the build when the host gives one, and only a commit hash', () => {
    process.env['VERCEL_GIT_COMMIT_SHA'] = '8d6d9a6f1c2b3a4d5e6f7a8b9c0d1e2f3a4b5c6d';
    expect(env.gitCommit).toBe('8d6d9a6');
    process.env['VERCEL_GIT_COMMIT_SHA'] = '<script>';
    delete process.env['GIT_COMMIT'];
    expect(env.gitCommit).toBeUndefined();
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has a public About page and a footer line in both languages', () => {
    expect(isPublicPath('/about')).toBe(true);
    expect(t('en', 'about.footer', { year: 2026, holder: 'GGP' })).toBe('Open-source software · MIT licence · © 2026 GGP');
    expect(t('fr', 'about.footer', { year: 2026, holder: 'GGP' })).toBe('Logiciel libre · Licence MIT · © 2026 GGP');
  });

  it('credits each main open-source part with its licence', () => {
    expect(CREDITS.map((c) => c.name)).toEqual(expect.arrayContaining(['Astro', 'React', 'PostgreSQL', 'Supabase']));
    for (const c of CREDITS) expect(c.url).toMatch(/^https:\/\//);
  });
});
