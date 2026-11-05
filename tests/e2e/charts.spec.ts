// The chart views (decision 87): each view leads with its charts, each chart says in words what
// it shows (a label, or the numbers beside it), and the exact numbers are one click away.
import { expect, test } from '@playwright/test';
import { createAccount, signIn, signInAdmin } from './helpers';

test('Executive: a ring of open items by state, a stage track and a ratings bar per reform', async ({ page }) => {
  await signIn(page, await createAccount('chartexec', { role: 'viewer_internal' }));
  await page.goto('/executive');
  const hero = page.getByTestId('exec-hero');
  await expect(hero.getByRole('img')).toHaveAttribute('aria-label', /Open items across the programme by state: \d+ overdue, \d+ stale, \d+ neither overdue nor stale, out of \d+\./);
  for (const reform of ['RA1', 'RA2', 'RA3']) {
    const card = page.locator(`[data-reform="${reform}"]`);
    await expect(card.locator('.stage-track li')).toHaveCount(8);
    await expect(card.getByRole('img', { name: /Ratings of open items/ })).toBeVisible();
  }
});

test('Portfolio, Risks and Governance lead with their charts', async ({ page }) => {
  await signIn(page, await createAccount('chartviews', { role: 'viewer_internal' }));
  await page.goto('/portfolio');
  // Readiness is shown as a proposed method until question 12 is settled.
  await expect(page.getByTestId('readiness-gauges')).toContainText('Proposed method, not confirmed');
  await expect(page.getByTestId('distribution').locator('li')).toHaveCount(8);

  await page.goto('/risks');
  await expect(page.getByTestId('risk-levels')).toHaveAttribute('aria-label', /Open risks by level: \d+ high, \d+ medium, \d+ low\./);
  await page.goto('/risks?tab=bottlenecks');
  // The bottleneck table is behind "Show the numbers" and opens on request.
  const numbers = page.getByTestId('bottlenecks-owner-numbers');
  await expect(numbers.getByRole('table')).toBeHidden();
  await numbers.getByText('Show the numbers').click();
  await expect(numbers.getByRole('table')).toBeVisible();

  await page.goto('/governance');
  await expect(page.getByTestId('follow-ups-overdue')).toContainText(/\d+/);
});

test('MERL shows progress to the Year 1 target only when it can be worked out', async ({ page }) => {
  await signIn(page, await createAccount('chartmerl', { role: 'viewer_internal' }));
  await page.goto('/merl');
  // Indicators with a numeric baseline, target and value get a bar; text such as "TBC" never shows as a number.
  await expect(page.getByTestId('progress').first()).toContainText('of the way to the Year 1 target');
  await expect(page.getByTestId('indicators')).not.toContainText('NaN');
});

test('the data quality pages show the score and pass rate as rings', async ({ page }) => {
  await signInAdmin(page, await createAccount('chartdq', { role: 'programme_admin' }));
  await page.goto('/admin/data-quality');
  await expect(page.getByTestId('figures').getByRole('img').first()).toHaveAttribute('aria-label', /.+/);
  await page.goto('/my-data-quality');
  await expect(page.getByTestId('pass-rate')).toBeVisible();
});
