// npm run hosted:email (decision 93): the settings it sends to Supabase Auth and to Vercel.
import { describe, expect, it } from 'vitest';
import {
  appEmailEnv,
  authEmailProblems,
  checkDomain,
  checkSettings,
  DMARC_VALUE,
  dnsRecordsFor,
  domainOf,
  emailFrom,
  isTestSender,
  planDns,
  RESEND_TEST_SENDER,
  supabaseAuthEmailConfig,
  type EmailSettings,
  type ResendRecord,
} from '../../scripts/lib/hosted-email';

const settings: EmailSettings = {
  apiKey: 're_test_1234567890abcdef',
  senderName: 'Green Growth Programme',
  senderAddress: RESEND_TEST_SENDER,
  siteUrl: 'https://my-dashboard.vercel.app',
  emailsPerHour: 100,
};

describe('Supabase Auth email settings', () => {
  const config = supabaseAuthEmailConfig(settings);

  it('send through Resend from the chosen sender, with the chosen hourly limit', () => {
    expect(config).toMatchObject({
      smtp_host: 'smtp.resend.com',
      smtp_port: '465',
      smtp_user: 'resend',
      smtp_pass: settings.apiKey,
      smtp_admin_email: 'onboarding@resend.dev',
      smtp_sender_name: 'Green Growth Programme',
      rate_limit_email_sent: 100,
      mailer_otp_exp: 3600,
      site_url: 'https://my-dashboard.vercel.app',
    });
  });

  it("use the app's own sign-in link for new and returning people, never Supabase's link that signs in on open", () => {
    for (const key of ['mailer_templates_magic_link_content', 'mailer_templates_confirmation_content']) {
      const html = String(config[key]);
      expect(html).toContain('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email');
      expect(html).not.toContain('ConfirmationURL');
      expect(html).toContain('lang="fr"');
    }
    expect(config['mailer_subjects_magic_link']).toBe('Your sign-in link | Votre lien de connexion');
  });

  it('are checked once read back: a default Supabase template or old limit is reported', () => {
    expect(authEmailProblems(config, settings)).toEqual([]);
    const reverted = { ...config, mailer_templates_magic_link_content: '<a href="{{ .ConfirmationURL }}">Log in</a>', rate_limit_email_sent: 2 };
    expect(authEmailProblems(reverted, settings)).toEqual([
      'The hourly email limit did not change.',
      'Supabase still uses its own sign-in link, which email scanners can use up.',
    ]);
  });
});

describe('the settings are refused when', () => {
  it.each([
    ['the key is not a Resend key', { apiKey: 'sk_live_abc' }, 'starts with re_'],
    ['the sender is not an address', { senderAddress: 'dashboard' }, 'Not an email address'],
    ['the name could break the header', { senderName: 'GGP <x@y.z>' }, 'plain text'],
    ['the site is not https', { siteUrl: 'http://ggp.example.org' }, 'https'],
    ['the limit is not a sensible number', { emailsPerHour: Number.NaN }, 'between 1 and 1000'],
  ])('%s', (_label, change, message) => {
    expect(() => checkSettings({ ...settings, ...change })).toThrow(message);
  });
});

describe("the app's own email settings", () => {
  it('use the same Resend server and sender; only SMTP_PASS is the key', () => {
    expect(appEmailEnv(settings)).toEqual({
      SMTP_HOST: 'smtp.resend.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'resend',
      SMTP_PASS: settings.apiKey,
      EMAIL_FROM: 'Green Growth Programme <onboarding@resend.dev>',
    });
    expect(emailFrom({ senderName: ' GGP ', senderAddress: 'dashboard@example.org' })).toBe('GGP <dashboard@example.org>');
  });
});

describe('a programme domain on Vercel DNS', () => {
  // The shape Resend returns for a new domain: sending records, and a receiving one we skip.
  const resend: ResendRecord[] = [
    { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
    { record: 'SPF', name: 'send', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"' },
    { record: 'DKIM', name: 'resend._domainkey.example-programme.org', type: 'TXT', value: 'p=MIGfMA0GCSqGSIb3' },
    { record: 'Receiving', name: '@', type: 'MX', value: 'inbound-smtp.eu-west-1.amazonaws.com', priority: 10 },
  ];
  const wanted = dnsRecordsFor('example-programme.org', resend);

  it('gets SPF, DKIM and DMARC, with names relative to the domain and no quotes, and never a receiving record', () => {
    expect(wanted).toEqual([
      { name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', mxPriority: 10 },
      { name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
      { name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0GCSqGSIb3' },
      { name: '_dmarc', type: 'TXT', value: DMARC_VALUE },
    ]);
    expect(DMARC_VALUE).toContain('p=quarantine');
  });

  it('adds only what is missing, so running again adds nothing', () => {
    expect(planDns(wanted, [])).toEqual({ add: wanted, conflicts: [] });
    const there = wanted.map((r) => ({ name: r.name, type: r.type, value: r.type === 'TXT' ? `"${r.value}"` : r.value }));
    expect(planDns(wanted, there)).toEqual({ add: [], conflicts: [] });
  });

  it('never adds a second SPF or DMARC record, or a second DKIM key: it reports the clash instead', () => {
    const plan = planDns(wanted, [
      { name: 'send', type: 'TXT', value: 'v=spf1 include:_spf.google.com ~all' },
      { name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none' },
      { name: 'resend._domainkey', type: 'TXT', value: 'p=OLDKEY' },
      { name: '', type: 'TXT', value: 'google-site-verification=abc' },
    ]);
    expect(plan.add).toEqual([wanted[0]]);
    expect(plan.conflicts).toHaveLength(3);
  });

  it('refuses a domain that is not ours, or Resend records it cannot set', () => {
    expect(() => checkDomain('onboarding.resend.dev')).toThrow('not yours');
    expect(() => checkDomain('my-dashboard.vercel.app')).toThrow('not yours');
    expect(() => checkDomain('not a domain')).toThrow('Not a domain name');
    expect(() => dnsRecordsFor('example-programme.org', [...resend, { record: 'DKIM', name: 'x', type: 'A', value: '1.2.3.4' }])).toThrow('A record');
    expect(() => dnsRecordsFor('example-programme.org', resend.slice(2, 3))).toThrow('no SPF');
  });

  it('knows the test sender and the domain of an address', () => {
    expect(domainOf('dashboard@Example-Programme.org')).toBe('example-programme.org');
    expect(isTestSender('Onboarding@resend.dev')).toBe(true);
    expect(isTestSender('dashboard@example-programme.org')).toBe(false);
  });
});

describe('DKIM by CNAME (what Resend asked for on 5 Nov 2026)', () => {
  const resend: ResendRecord[] = [
    { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
    { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
    { record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', value: 'resend._domainkey.example.dkim.resend.com.' },
  ];

  it('is written as a CNAME without the trailing dot, and found again on a second run', () => {
    const wanted = dnsRecordsFor('example-programme.org', resend);
    expect(wanted[2]).toEqual({ name: 'resend._domainkey', type: 'CNAME', value: 'resend._domainkey.example.dkim.resend.com' });
    const there = wanted.map((r) => ({ name: r.name, type: r.type, value: r.type === 'CNAME' ? `${r.value}.` : r.value }));
    expect(planDns(wanted, there).add).toEqual([]);
  });

  it('is never added where the name is already taken', () => {
    const wanted = dnsRecordsFor('example-programme.org', resend);
    const plan = planDns(wanted, [{ name: 'resend._domainkey', type: 'TXT', value: 'p=OLD' }]);
    expect(plan.conflicts).toEqual(['TXT resend._domainkey already has "p=OLD"']);
  });
});
