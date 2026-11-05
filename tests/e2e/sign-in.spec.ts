// Build step 3 acceptance: sign-in by magic link, the allowlist, MFA for admins, the language
// preference saved per user, and sign-out.
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { countEmailsTo, createAccount, freshTotp, signIn, signInLinkFor, unlistedEmail } from './helpers';

test('a listed person signs in with a magic link and lands on the page they asked for', async ({ page }) => {
  const email = await createAccount('contributor', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });

  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/);

  const before = await countEmailsTo(email);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  await expect(page.getByText(`If ${email} is registered`)).toBeVisible();

  await page.goto(await signInLinkFor(email, before));
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId('role')).toHaveText('Contributor');
  await expect(page.getByTestId('reforms')).toHaveText('RA1');
});

test('an unlisted email gets the same message and no email', async ({ page }) => {
  const email = unlistedEmail('stranger');
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  await expect(page.getByText(`If ${email} is registered`)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await countEmailsTo(email)).toBe(0);
});

test('a sign-in link works once', async ({ page, browser }) => {
  const email = await createAccount('once', { role: 'viewer_internal' });
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  const link = await signInLinkFor(email);
  await page.goto(link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('account-menu')).toBeVisible();

  const other = await browser.newPage();
  await other.goto(link);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByRole('alert')).toHaveText(/expired or has already been used/);
  await other.close();
});

test('pressing the sign-in button twice never shows an error (decision 94)', async ({ page }) => {
  const email = await createAccount('twice', { role: 'viewer_internal' });
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  const link = await signInLinkFor(email);

  // A double-click sends the form once.
  await page.goto(link);
  await page.getByRole('button', { name: 'Sign in' }).dblclick();
  await expect(page.getByTestId('account-menu')).toBeVisible();

  // The same link again in the same, signed-in browser carries on instead of failing.
  await page.goto(link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('account-menu')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the language choice is saved to the profile and follows the person to a new device', async ({ page, browser }) => {
  const email = await createAccount('language', { role: 'reform_lead', scope: [{ reformId: 'RA2', canApprove: true }] });
  await signIn(page, email);
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  const laptop = await browser.newContext({ locale: 'en-GB' });
  const second = await laptop.newPage();
  await signIn(second, email);
  await expect(second.locator('html')).toHaveAttribute('lang', 'fr');
  await second.goto('/account');
  await expect(second.getByTestId('role')).toHaveText('Responsable de réforme');
  await laptop.close();
});

test('an admin must set up and then use an authenticator app', async ({ page }) => {
  // The second sign-in may wait up to 30 s for the next code, as a person would.
  test.setTimeout(90_000);
  const email = await createAccount('admin', { role: 'programme_admin' });
  await signIn(page, email);

  await expect(page).toHaveURL(/\/auth\/mfa/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/auth\/mfa\?next=%2Faccount$/);

  await page.getByRole('button', { name: 'Start set-up' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('alert')).toHaveText(/That code is not right/);

  const first = await freshTotp(secret);
  await page.getByLabel('6-digit code').fill(first);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId('role')).toHaveText('Programme administrator');

  await page.getByTestId('account-menu').locator('summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await page.getByLabel('6-digit code').fill(await freshTotp(secret, first));
  await page.getByRole('button', { name: 'Confirm' }).click();
  // Signed-in people land on the Executive view (decision 40).
  await expect(page).toHaveURL(/\/executive$/);
  await expect(page.getByTestId('account-menu')).toBeVisible();
});

test('signing out ends the session', async ({ page }) => {
  const email = await createAccount('signout', { role: 'viewer_internal' });
  await signIn(page, email);
  await page.getByTestId('account-menu').locator('summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('going round the app to Supabase directly does not get an unlisted email a link', async () => {
  const email = unlistedEmail('direct');
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ email, create_user: true }),
  });
  expect(response.ok).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(await countEmailsTo(email)).toBe(0);
});

// npm run users:link (decision 88): a one-time link made by an admin, with no email sent.
test('an admin-made sign-in link signs the person in once, and nobody unlisted gets one', async ({ page, browser }) => {
  const email = await createAccount('link', { role: 'viewer_internal' });
  const run = (address: string) => spawnSync('npx', ['tsx', 'scripts/users-link.ts', '--email', address], { encoding: 'utf8' });

  const made = run(email);
  expect(made.status, made.stderr).toBe(0);
  const href = /https?:\/\/\S+\/auth\/confirm\?token_hash=[\w-]+&type=email/.exec(made.stdout)?.[0];
  expect(href).toBeTruthy();
  expect(await countEmailsTo(email)).toBe(0);

  const link = new URL(href!);
  await page.goto(link.pathname + link.search);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('account-menu')).toBeVisible();

  const other = await browser.newPage();
  await other.goto(link.pathname + link.search);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByRole('alert')).toHaveText(/expired or has already been used/);
  await other.close();

  const refused = run(unlistedEmail('link'));
  expect(refused.status).toBe(1);
  expect(refused.stderr).toMatch(/may not sign in/);
});

// Decision 90: the full-page sign-in tells you at once it is the Green Growth Programme.
test('the sign-in page shows the programme brand beside the form, in both languages and on a phone', async ({ page, browser }) => {
  await page.goto('/sign-in');
  const brand = page.locator('.auth-brand');
  await expect(brand).toContainText('Green Growth Programme');
  await expect(brand).toContainText('Democratic Republic of the Congo');
  await expect(brand).toContainText('Pillar 1 · Policy and institutional reform');
  await expect(brand.getByRole('list', { name: 'Reform areas' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
  // No partner names until they confirm how they want to be credited.
  await expect(page.locator('body')).not.toContainText('Funding Partner');

  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(brand).toContainText('Programme de croissance verte');
  await expect(page.getByRole('heading', { level: 1, name: 'Connexion' })).toBeVisible();
  await page.getByRole('button', { name: 'EN', exact: true }).click();

  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const small = await phone.newPage();
  await small.goto('/sign-in');
  expect(await small.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  // The brand band sits above the form, and the language switch does not cover it.
  const band = await small.locator('.auth-brand').boundingBox();
  const form = await small.getByRole('heading', { level: 1 }).boundingBox();
  expect(form!.y).toBeGreaterThan(band!.y + band!.height - 1);
  const lang = await small.getByRole('group', { name: /language|langue/i }).or(small.locator('.lang-switch')).first().boundingBox();
  expect(lang!.y).toBeGreaterThanOrEqual(band!.y + band!.height - 1);
  await phone.close();
});

test('the open-source notice: on sign-in, on signed-in pages in both languages, and the About page without signing in (decision 97)', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByTestId('oss-note')).toHaveText(/Open-source software · MIT licence · © 2026 Green Growth Programme/);

  await page.getByTestId('oss-note').getByRole('link', { name: 'About and source code' }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { name: 'About this dashboard', level: 1 })).toBeVisible();
  await expect(page.getByTestId('copyright')).toHaveText('© 2026 Green Growth Programme');
  await expect(page.getByTestId('licence')).toContainText('Permission is hereby granted, free of charge');
  await expect(page.getByTestId('source-link')).toHaveAttribute('href', 'https://github.com/appiahobeng-akwasi/policy-reform-dashboard');
  await expect(page.getByTestId('credits')).toContainText('PostgreSQL');

  await signIn(page, await createAccount('oss', { role: 'viewer_internal' }));
  await page.goto('/executive');
  await expect(page.getByTestId('oss-note')).toBeVisible();
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.getByTestId('oss-note')).toHaveText(/Logiciel libre · Licence MIT/);
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'À propos de ce tableau de bord', level: 1 })).toBeVisible();
  await expect(page.getByText('Le texte de la licence ci-dessous est en anglais')).toBeVisible();
});
