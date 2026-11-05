// Build step 14: security headers, rate-limit rules, and what the error log keeps.
import { afterEach, describe, expect, it } from 'vitest';
import { clean, newReference, plainPage } from '../../src/lib/errors';
import { documentPolicy, withSecurityHeaders } from '../../src/lib/security/headers';
import { clientIp, LIMITS, ruleFor } from '../../src/lib/security/rate-limit';

describe('security headers (decision 62)', () => {
  it('every response gets them; HSTS only over HTTPS; signed-in pages are never cached', () => {
    const plain = withSecurityHeaders(new Response('x'), { https: false, personal: false });
    expect(plain.headers.get('x-content-type-options')).toBe('nosniff');
    expect(plain.headers.get('x-frame-options')).toBe('DENY');
    expect(plain.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(plain.headers.get('permissions-policy')).toContain('camera=()');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    expect(plain.headers.get('cache-control')).toBeNull();
    const secure = withSecurityHeaders(new Response('x'), { https: true, personal: true });
    expect(secure.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(secure.headers.get('cache-control')).toBe('private, no-store');
  });

  it('works on responses whose headers cannot change (redirects)', () => {
    const out = withSecurityHeaders(Response.redirect('http://localhost/x', 303), { https: false, personal: false });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('http://localhost/x');
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it('a standalone document may use only its own style, by hash', () => {
    const policy = documentPolicy('<html><style>body{color:red}</style><p>x</p></html>');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(policy).not.toContain('unsafe-inline');
    expect(documentPolicy('<p>no style</p>')).toContain("style-src 'none'");
  });
});

describe('rate limits (decision 63)', () => {
  afterEach(() => {
    delete process.env['TRUST_PROXY'];
  });

  it('only sending counts, never reading', () => {
    expect(ruleFor('POST', '/sign-in')?.limit).toBe(LIMITS.signInIp);
    expect(ruleFor('POST', '/auth/mfa')?.limit).toBe(LIMITS.verify);
    expect(ruleFor('POST', '/api/uploads')?.limit).toBe(LIMITS.upload);
    expect(ruleFor('PATCH', '/api/uploads/abc')).toBeNull();
    expect(ruleFor('POST', '/api/evidence/receive')?.by).toBe('user');
    expect(ruleFor('POST', '/items/milestone/MS-101')?.limit).toBe(LIMITS.submit);
    expect(ruleFor('POST', '/api/jobs/daily')?.by).toBe('ip');
    for (const path of ['/executive', '/items/milestone/MS-101', '/sign-in']) expect(ruleFor('GET', path)).toBeNull();
  });

  it('trusts a proxy address only when told to', () => {
    const request = new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(clientIp(request, '10.0.0.1')).toBe('10.0.0.1');
    process.env['TRUST_PROXY'] = 'true';
    expect(clientIp(request, '10.0.0.1')).toBe('203.0.113.7');
  });
});

describe('the error log keeps nothing personal (decision 64)', () => {
  it('removes emails, tokens, keys and passwords in connection strings', () => {
    const text = clean(
      'failed for alice@example.com with Bearer abc.def.ghi and eyJhbGciOi.eyJzdWIiOi.c2ln on postgresql://postgres:secret@db:5432/x?sslmode=require key sb_secret_AbCdEf123',
    );
    expect(text).not.toMatch(/alice|secret@|eyJ|sb_secret|abc\.def/);
    expect(text).toContain('[email]');
    expect(text).toContain('//[credentials]@db:5432/x');
  });

  it('references are short and easy to read out', () => {
    expect(newReference()).toMatch(/^E-[A-HJ-NP-Z2-9]{6}$/);
  });

  it('the error page escapes what it shows and sets its own tight policy', async () => {
    const page = plainPage('en', 500, 'Oops <b>', 'Ref <script>');
    expect(page.status).toBe(500);
    const html = await page.text();
    expect(html).toContain('Oops &lt;b&gt;');
    expect(html).not.toContain('<script>');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
