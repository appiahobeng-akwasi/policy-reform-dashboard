// Build step 14 acceptance: security headers and a content policy that no page breaks; a server
// error shows a reference and is logged without personal data; sign-in links are rate limited;
// the health check answers.
import { expect, test, type Page } from '@playwright/test';
import { createAccount, prepareMilestone, signInAdmin, unlistedEmail } from './helpers';

/** Collects content policy violations reported by the browser. */
function watchPolicy(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(m.text())) violations.push(m.text());
  });
  return violations;
}

test('pages carry the security headers and break no content policy, scripts and all', async ({ page }) => {
  const violations = watchPolicy(page);
  const signIn = await page.goto('/sign-in');
  const headers = signIn!.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).toContain("object-src 'none'");
  expect(headers['content-security-policy']).not.toContain('unsafe-inline');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');

  const admin = await createAccount('cspadmin', { role: 'programme_admin', scope: [{ reformId: 'RA3', canApprove: false }] });
  // The MFA set-up shows its QR code as a data: image; the card and bulk upload run scripts.
  await signInAdmin(page, admin);
  await prepareMilestone('MS-112', admin);
  for (const path of ['/executive', '/portfolio', '/risks', '/merl', '/governance', '/items/milestone/MS-112', '/uploads/new', '/admin', '/reviews']) {
    const response = await page.goto(path);
    expect(response!.headers()['cache-control'], path).toBe('private, no-store');
  }
  // The update card's script ran (it shows the live checks) under the policy.
  await page.goto('/items/milestone/MS-112');
  await page.getByLabel('Next action').fill('Hold the meeting');
  // The live quality score only appears if the page's script is allowed to run.
  await expect(page.locator('#card-status')).toContainText(/\d/);
  expect(violations).toEqual([]);
});

test('a server error shows a reference, and the Errors page has it without personal data', async ({ page }) => {
  await signInAdmin(page, await createAccount('erradmin', { role: 'programme_admin' }));
  const response = await page.goto('/api/test/fail');
  expect(response!.status()).toBe(500);
  const body = await page.locator('main').textContent();
  const reference = /E-[A-Z2-9]{6}/.exec(body ?? '')?.[0];
  expect(reference).toBeTruthy();
  expect(body).not.toContain('alice@example.com');

  await page.goto('/executive');
  await page.getByTestId('nav-admin').getByRole('link', { name: 'Errors' }).click();
  await page.getByLabel('Reference').fill(reference!);
  await page.getByRole('button', { name: 'Apply' }).click();
  const row = page.locator(`tr[data-reference="${reference}"]`);
  await expect(row).toContainText('/api/test/fail');
  await expect(row).toContainText('[email]');
  await expect(row).not.toContainText('alice@example.com');
  await expect(row).not.toContainText('eyJ');
});

test('asking for sign-in links too often is refused for a while, whoever the address is', async ({ page }) => {
  const email = unlistedEmail('ratelimit');
  for (let i = 0; i < 5; i++) {
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  }
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  await expect(page.getByRole('alert')).toContainText('Too many sign-in links were asked for this address');
});

test('the health check says the database and storage answer, and nothing more', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', database: 'ok', storage: 'ok' });
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
});

// Decision 91: a form body larger than the server accepts is refused before it is read.
test('an oversized form post is refused with 413 before anything is parsed; a normal one works', async ({ request }) => {
  const big = await request.post('/api/lang', { form: { lang: 'fr', padding: 'x'.repeat(70 * 1024) } });
  expect(big.status()).toBe(413);
  expect(await big.text()).toContain('larger than the dashboard accepts');
  const normal = await request.post('/api/lang', { form: { lang: 'fr', return_to: '/sign-in' }, maxRedirects: 0 });
  expect([302, 303]).toContain(normal.status());
});
