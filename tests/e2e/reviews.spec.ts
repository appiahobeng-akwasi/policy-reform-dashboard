// Build step 13 acceptance: an admin prepares a monthly review pack; it is saved as a version; an
// internal viewer reads it, prints it and downloads it; a government counterpart cannot.
import { expect, test } from '@playwright/test';
import { createAccount, signIn, signInAdmin } from './helpers';

test('prepare a review pack, read it, print it and download it', async ({ browser }) => {
  const admin = await createAccount('packadmin', { role: 'programme_admin' });
  const page = await (await browser.newContext()).newPage();
  await signInAdmin(page, admin);
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await page.getByLabel('Review', { exact: true }).selectOption('monthly_pillar_review');
  await page.getByLabel('Review date').fill('2026-11-14');
  await page.getByRole('button', { name: 'Prepare the pack' }).click();
  await expect(page.getByTestId('prepared')).toContainText('Pack prepared and saved as version');
  for (const heading of ['1. Prepare', '2. Review', '3. Decide', '4. Track']) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Escalations on the agenda (levels 2 and 3)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Programme-wide milestones' })).toBeVisible();
  const packUrl = page.url().replace(/\?.*$/, '');

  const viewer = await createAccount('packviewer', { role: 'viewer_internal' });
  const viewerPage = await (await browser.newContext()).newPage();
  await signIn(viewerPage, viewer);
  await viewerPage.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(viewerPage.getByTestId('prepare')).toHaveCount(0);
  await viewerPage.goto(packUrl);
  await expect(viewerPage.getByRole('heading', { name: '3. Decide' })).toBeVisible();

  const download = await viewerPage.request.get(`${packUrl}/download`);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-disposition']).toMatch(/attachment; filename="pillar1-monthly-review-2026-11-14-v\d+-en\.html"/);
  const file = await download.text();
  expect(file.startsWith('<!doctype html>')).toBe(true);
  expect(file).not.toContain('<script');

  await viewerPage.goto(`${packUrl}/print`);
  await expect(viewerPage.getByText("To save as PDF, use your browser's Print command")).toBeVisible();
  await expect(viewerPage.getByRole('heading', { name: '4. Track' })).toBeVisible();

  // In French, the same saved pack.
  await viewerPage.goto(packUrl);
  await viewerPage.getByRole('button', { name: 'FR' }).click();
  await expect(viewerPage.getByRole('heading', { name: '1. Préparer' })).toBeVisible();

  const counterpart = await createAccount('packcp', { role: 'viewer_counterpart', scope: [{ reformId: 'RA1', canApprove: false }] });
  const cpPage = await (await browser.newContext()).newPage();
  await signIn(cpPage, counterpart);
  await expect(cpPage.getByRole('link', { name: 'Reviews', exact: true })).toHaveCount(0);
  await cpPage.goto('/reviews');
  await expect(cpPage.getByText('Review packs are for programme staff only.')).toBeVisible();
  expect((await cpPage.goto(packUrl))?.status()).toBe(404);
  expect((await cpPage.request.get(`${packUrl}/download`)).status()).toBe(404);
});
