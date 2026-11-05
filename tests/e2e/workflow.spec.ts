// The workflow restyle (decisions 78 to 82): the top bar menus, Getting started, and the approvals
// inbox (grouped list, checks box, previews on request, J and K, Ctrl + Enter, moving on to the
// next update). Uses the programme-wide milestones MS-007 and MS-012, which no other browser test
// touches, and approves everything it sends so other tests' queues are unchanged.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { png } from '../support/files';
import { createAccount, prepareMilestone, query, signIn, signInAdmin } from './helpers';

async function adminPage(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInAdmin(page, email);
  return page;
}

const pending = async (milestone: string, email: string) =>
  (
    await query<{ submission_id: string; status: string }>(
      `select s.submission_id, s.status from submissions s join app_users u on u.user_id = s.submitted_by
        where u.email = $2 and s.payload -> 'rows' @> jsonb_build_array(jsonb_build_object('entity', 'milestone', 'id', $1::text))
        order by s.created_at desc limit 1`,
      [milestone, email],
    )
  )[0]!;

test('the top bar: New lists what your role can start, Help explains approval, and Esc closes menus', async ({ page }) => {
  await signIn(page, await createAccount('wfcontrib', { role: 'contributor', scope: [{ reformId: 'RA3', canApprove: false }] }));
  await page.goto('/my-items');
  const menu = page.getByTestId('new-menu');
  await menu.locator('summary').click();
  await expect(menu.getByRole('link', { name: /Update an item/ })).toBeVisible();
  await expect(menu.getByRole('link', { name: /Upload a workbook/ })).toHaveCount(0);
  await expect(menu.getByRole('link', { name: /Enter for someone else/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu.getByRole('link', { name: /Update an item/ })).toBeHidden();

  await page.getByTestId('help-menu').locator('summary').click();
  await expect(page.getByTestId('help-menu')).toContainText('How an update is approved');
  // A click elsewhere closes it.
  await page.locator('h1').click();
  await expect(page.getByTestId('help-menu').getByText('How an update is approved')).toBeHidden();

  await page.getByTestId('account-menu').locator('summary').click();
  await expect(page.getByTestId('account-menu')).toContainText('Contributor');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Getting started: signed in is done; sending and evidence are next.
  await expect(page.getByTestId('getting-started')).toContainText('1 of 3 done');
  await expect(page.getByTestId('getting-started')).toContainText('Send your first update or confirmation');
});

test('viewers have nothing to start: no New menu and no Getting started', async ({ page }) => {
  await signIn(page, await createAccount('wfviewer', { role: 'viewer_internal' }));
  await page.goto('/executive');
  await expect(page.getByTestId('new-menu')).toHaveCount(0);
  await expect(page.getByTestId('getting-started')).toHaveCount(0);
});

test('the approvals inbox: grouped list, checks box, preview on request, J and K, Ctrl + Enter moves on', async ({ browser }) => {
  const sender = await createAccount('wfsender', { role: 'programme_admin' });
  const approver = await createAccount('wfapprover', { role: 'programme_admin' });
  // B08 needs a named owner on an open milestone.
  await prepareMilestone('MS-007', sender, { next_action: 'Share the dashboard with the Secretariat', planned_date: '2027-03-31' });
  await prepareMilestone('MS-012', sender, { planned_date: '2027-03-31' });

  const senderPage = await adminPage(browser, sender);
  await expect(senderPage.getByTestId('getting-started')).toContainText('1 of 4 done');
  // A catch-up with a photo as evidence on MS-012, and "nothing changed" on MS-007.
  await senderPage.goto('/items/milestone/MS-012');
  await senderPage.getByLabel('Status').selectOption('delayed');
  await senderPage.getByLabel('New expected date').fill('2027-02-15');
  await senderPage.getByLabel('What is blocking or delaying it').fill('Waiting for the Secretariat');
  await senderPage.getByLabel('Next action').fill('Agree the date with the Secretariat');
  await senderPage.locator('#evidence-file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png(64, 48) });
  await expect(senderPage.locator('#pending-uploads')).toContainText('is ready');
  await senderPage.getByLabel('Type of evidence').selectOption('screenshot');
  await senderPage.getByLabel('Date of the document').fill('2026-11-03');
  await senderPage.getByLabel('Source institution').fill('Secretariat');
  await senderPage.getByRole('button', { name: 'Send for approval' }).click();
  await expect(senderPage.getByTestId('sent')).toBeVisible();
  await senderPage.goto('/items/milestone/MS-007');
  await senderPage.getByRole('button', { name: 'Nothing changed' }).click();
  await expect(senderPage.getByTestId('sent')).toBeVisible();
  // The update card is a focused page with no sidebar; Getting started shows on My items.
  await senderPage.goto('/my-items');
  await expect(senderPage.getByTestId('getting-started')).toContainText('3 of 4 done');
  const update = (await pending('MS-012', sender)).submission_id;
  const confirmation = (await pending('MS-007', sender)).submission_id;

  const page = await adminPage(browser, approver);
  await page.goto('/approvals');
  await expect(page.getByTestId('approval-list')).toContainText('E2E wfsender');
  await expect(page.getByTestId('overview-confirmations')).toBeVisible();

  // The update: title, checks box, the change rows, the evidence with a preview on request.
  await page.goto(`/approvals/${update}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Update to Milestone MS-012');
  await expect(page.getByTestId('quality')).toContainText('Quality score');
  await expect(page.locator('.diff tr[data-field="status"] .proposed')).toHaveText('Delayed');
  await expect(page.locator('img.preview')).toHaveCount(0);
  await page.getByRole('link', { name: 'Show preview' }).click();
  const image = page.locator('img.preview');
  await expect(image).toBeVisible();
  const served = await page.request.get((await image.getAttribute('src'))!);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toMatch(/^image\//);

  // J and K move through the list; nothing is decided by them.
  await page.goto(`/approvals/${update}`);
  const before = page.url();
  const hasNext = (await page.locator('[data-key-next]').count()) > 0;
  await page.locator('body').press(hasNext ? 'j' : 'k');
  await expect(page).not.toHaveURL(before);
  await page.locator('body').press(hasNext ? 'k' : 'j');
  await expect(page).toHaveURL(before);
  expect((await pending('MS-012', sender)).status).toBe('proposed');

  // Ctrl + Enter approves the open update and moves on to the next one, with a confirmation.
  await page.locator('body').press('Control+Enter');
  await expect(page.getByTestId('done')).toContainText('Approved and applied');
  await expect(page).not.toHaveURL(before);
  await expect.poll(async () => (await pending('MS-012', sender)).status).toBe('applied');

  // Typing a return note and pressing Ctrl + Enter returns it; it never approves.
  await page.goto(`/approvals/${confirmation}`);
  await page.getByTestId('decide-bar').getByText('Return for changes').click();
  await page.getByLabel('What needs fixing (required)').fill('Please confirm with the Secretariat first');
  await page.getByLabel('What needs fixing (required)').press('Control+Enter');
  await expect(page.getByTestId('done')).toContainText('Returned');
  await expect.poll(async () => (await pending('MS-007', sender)).status).toBe('returned');
});

// Closed menus, hidden chart tables and long values once made pages wider than a phone, so the
// browser zoomed out and the tab bar and decision bar fell off the screen.
test('on a phone no page is wider than the screen', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await signInAdmin(page, await createAccount('wfwidth', { role: 'programme_admin' }));
  const update = (await query<{ id: string }>("select submission_id as id from submissions where status = 'proposed' order by created_at limit 1"))[0]?.id;
  const paths = ['/my-items', '/approvals', '/approvals?show=confirmations', '/uploads', '/uploads/new', '/executive', '/portfolio', '/pathway', '/risks', '/merl', '/governance', '/reviews', '/notices', '/account', '/my-data-quality', '/admin', '/admin/data-quality', '/admin/users', '/on-behalf', '/search?q=MS', '/items/milestone/MS-104'];
  if (update) paths.push(`/approvals/${update}`);
  for (const path of paths) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
  }
});

test('the item panel: Actions, a warning line, Activity; the update card is a focused page with live chips', async ({ browser }) => {
  const owner = await createAccount('wfowner', { role: 'programme_admin' });
  await prepareMilestone('MS-007', owner, { next_action: 'Share the dashboard with the Secretariat', planned_date: '2027-03-31' });
  const page = await adminPage(browser, owner);
  await page.goto('/my-items?open=milestone/MS-007');
  const panel = page.getByTestId('side-panel');
  // Seeded data was last confirmed on 29 Jul 2026, so the item is stale.
  await expect(panel.getByTestId('panel-warning')).toContainText('Not confirmed for over 30 days');
  await panel.getByTestId('panel-actions').locator('summary').click();
  await expect(panel.getByRole('link', { name: 'Open the full update card' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The owner may read the Activity tab.
  await panel.getByTestId('tab-activity').click();
  await expect(page).toHaveURL(/panel=activity/);

  // The update card is a focused page: no sidebar, a close button, and chips that follow the checks.
  await page.goto('/items/milestone/MS-007');
  await expect(page.getByTestId('nav-work')).toHaveCount(0);
  await page.getByLabel('Status').selectOption('delayed');
  await expect(page.locator('[data-chip-for="forecast_date"]')).toHaveAttribute('data-state', /error|warning/);
  await page.getByLabel('New expected date').fill('2027-04-30');
  await page.getByLabel('What is blocking or delaying it').fill('Waiting for the Secretariat');
  await expect(page.locator('[data-chip-for="forecast_date"]')).toHaveAttribute('data-state', 'ok');
  await page.locator('h1').click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/my-items\?open=milestone\/MS-007/);

  // Nothing changed from the panel, then the Activity tab shows who sent it.
  await page.getByTestId('side-panel').getByRole('button', { name: 'Nothing changed' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
  await page.goto('/my-items?open=milestone/MS-007&panel=activity');
  await expect(page.getByTestId('activity')).toContainText('Sent by E2E wfowner');
});

test('Needs your action on My items, and the rules reference', async ({ browser }) => {
  const approver = await createAccount('wfneeds', { role: 'programme_admin' });
  const page = await adminPage(browser, approver);
  await page.goto('/my-items');
  await expect(page.getByTestId('greeting')).toContainText('E2E');
  // The previous test left a programme-wide confirmation waiting; it shows here with one button.
  const confirmations = page.getByTestId('action-confirmations');
  await expect(confirmations).toContainText('Confirmations to approve');
  await confirmations.getByRole('link').click();
  await expect(page).toHaveURL(/\/approvals\?show=confirmations/);
  await page.getByRole('button', { name: 'Approve the selected confirmations' }).click();
  await expect(page.getByTestId('batch-done')).toBeVisible();

  // The rules reference: search, then one rule in the panel, in plain words.
  await page.goto('/rules?q=B08');
  await expect(page.locator('[data-rule="B08"]')).toBeVisible();
  await page.locator('[data-rule="B08"] a').click();
  await expect(page.getByTestId('rule-message')).not.toBeEmpty();
  await expect(page.getByTestId('side-panel')).toContainText('Must pass to send');
});
