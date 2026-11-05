// The public copy ships fictional demo data, and sample data must be labelled as sample in the UI
// (CLAUDE.md rule 11). DEMO_DATA=true turns on the notice on every page (decision 95).
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../src/i18n';
import { env } from '../../src/lib/env';

describe('the demo-data notice', () => {
  const before = process.env['DEMO_DATA'];
  afterEach(() => {
    if (before === undefined) delete process.env['DEMO_DATA'];
    else process.env['DEMO_DATA'] = before;
  });

  it('is on only when DEMO_DATA is exactly true', () => {
    delete process.env['DEMO_DATA'];
    expect(env.demoData).toBe(false);
    process.env['DEMO_DATA'] = 'yes';
    expect(env.demoData).toBe(false);
    process.env['DEMO_DATA'] = 'true';
    expect(env.demoData).toBe(true);
  });

  it('says so in both languages', () => {
    expect(t('en', 'app.demo_notice')).toContain('fictional');
    expect(t('fr', 'app.demo_notice')).toContain('fictif');
  });
});
