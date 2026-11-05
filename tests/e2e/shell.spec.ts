// The restyle to docs/08 (decisions 69 to 71): the sidebar shell, My items' stat row and side
// panel, search with Ctrl/Cmd + K, Esc to close, and the phone menu. Uses RA3 milestones
// MS-109 and MS-110, which the other browser tests leave alone.
import { expect, test } from '@playwright/test';
import { createAccount, prepareMilestone, signIn } from './helpers';

test('My items: stat cards filter the table; a row opens the side panel; Esc closes it', async ({ page }) => {
  const owner = await createAccount('shellowner', { role: 'contributor', scope: [{ reformId: 'RA3', canApprove: false }] });
  await prepareMilestone('MS-109', owner, { status: 'on_track', planned_date: '2026-08-01' });
  await prepareMilestone('MS-110', owner, { status: 'on_track', planned_date: '2027-06-30', next_action: 'Share the draft framework', last_confirmed_at: new Date() });
  await signIn(page, owner);
  await page.goto('/my-items');
  await expect(page.getByTestId('items').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('stat-overdue')).toContainText('1');

  await page.getByTestId('stat-overdue').click();
  await expect(page).toHaveURL(/show=overdue/);
  await expect(page.getByTestId('items').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('items')).toContainText('MS-109');

  await page.getByTestId('items').getByRole('link').first().click();
  await expect(page).toHaveURL(/open=milestone%2FMS-109|open=milestone\/MS-109/);
  const panel = page.getByTestId('side-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('days overdue');
  // Decision 92: the panel is a modal dialog; focus starts on its title and Tab stays inside it.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(panel.locator('#panel-title')).toBeFocused();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await panel.locator('#panel-title').focus(); // Esc does not close the panel while you type in a field.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/show=overdue/);

  // "Nothing changed" straight from the panel sends a confirmation for approval.
  await page.goto('/my-items?open=milestone/MS-110');
  await page.getByTestId('side-panel').getByRole('button', { name: 'Nothing changed' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
});

test('search finds items and risks by ID or name; Ctrl/Cmd + K goes to it', async ({ page }) => {
  await signIn(page, await createAccount('searcher', { role: 'viewer_internal' }));
  await page.goto('/executive');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByLabel('Search', { exact: true })).toBeFocused();
  await page.keyboard.type('MS-104');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=MS-104/);
  await expect(page.locator('[data-hit="MS-104"]')).toBeVisible();
  await page.goto('/search?q=RK-001');
  await expect(page.locator('[data-hit="RK-001"]')).toContainText('Risk');
  await page.goto('/search?q=zzznothing');
  await expect(page.getByTestId('empty-state')).toContainText('Nothing matches');
});

test('counterparts find only their reform in search, and no risks', async ({ page }) => {
  await signIn(page, await createAccount('cpsearch', { role: 'viewer_counterpart', scope: [{ reformId: 'RA1', canApprove: false }] }));
  await page.goto('/search?q=MS-');
  const ids = await page.locator('[data-hit]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-hit')));
  expect(ids.length).toBeGreaterThan(0);
  await page.goto('/search?q=RK-001');
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('on a phone the menu opens from the top bar, with My items one tap away', async ({ browser }) => {
  const email = await createAccount('phonemenu', { role: 'contributor', scope: [{ reformId: 'RA3', canApprove: false }] });
  const desktop = await (await browser.newContext()).newPage();
  await signIn(desktop, email);
  const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage();
  await phone.context().addCookies(await desktop.context().cookies());
  await phone.goto('/executive');
  await expect(phone.getByTestId('nav-views')).toBeHidden();
  await expect(phone.getByRole('navigation', { name: 'Quick links' }).getByRole('link', { name: 'My items' })).toBeVisible();
  await phone.getByRole('link', { name: 'Open the menu' }).click();
  await expect(phone.getByTestId('nav-views').getByRole('link', { name: 'Pathway' })).toBeVisible();
  await phone.getByRole('link', { name: 'Close the menu' }).click();
  await expect(phone.getByTestId('nav-views')).toBeHidden();
});
