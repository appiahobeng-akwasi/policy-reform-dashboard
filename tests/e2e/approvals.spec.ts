// Build step 9 acceptance (spec 01 sections 7 and 13.4): an owner sends an update; the approver
// sees it in the queue, reads current and proposed side by side with the score and the evidence,
// and approves; the owner is told and the item has changed. Plus return, confirmations together,
// a refused approval, and approving without JavaScript.
// These tests use RA2 and RA3 milestones; the update card tests use RA1's, so the two never meet.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { pdf } from '../support/files';
import { createAccount, prepareMilestone, query, RUN, signIn } from './helpers';

async function signedIn(browser: Browser, email: string, javaScriptEnabled = true): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  if (javaScriptEnabled) return page;
  const cookies = await context.cookies();
  const plain = await browser.newContext({ javaScriptEnabled: false });
  await plain.addCookies(cookies);
  return plain.newPage();
}

async function sendCatchUp(page: Page, milestone: string, withEvidence = false): Promise<void> {
  await page.goto(`/items/milestone/${milestone}`);
  await page.getByLabel('Status').selectOption('delayed');
  await page.getByLabel('New expected date').fill('2027-01-15');
  await page.getByLabel('What is blocking or delaying it').fill('Waiting for the minister to sign');
  await page.getByLabel('Next action').fill('Send the decree to the minister');
  if (withEvidence) {
    await page.locator('#evidence-file').setInputFiles({ name: 'cover-letter.pdf', mimeType: 'application/pdf', buffer: pdf(`approvals ${RUN} ${milestone}`) });
    await expect(page.locator('#pending-uploads')).toContainText('is ready');
    await page.getByLabel('Type of evidence').selectOption('letter');
    await page.getByLabel('Date of the document').fill('2026-11-02');
    await page.getByLabel('Source institution').fill('Ministry of Agriculture');
  }
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
}

const latestSubmission = async (milestone: string, email: string) =>
  (
    await query<{ submission_id: string }>(
      `select s.submission_id from submissions s join app_users u on u.user_id = s.submitted_by
        where u.email = $2 and s.payload -> 'rows' @> jsonb_build_array(jsonb_build_object('entity', 'milestone', 'id', $1::text))
        order by s.created_at desc limit 1`,
      [milestone, email],
    )
  )[0]!.submission_id;

test('the approver reads current and proposed side by side, opens the evidence, approves; the owner is told', async ({ browser }) => {
  const owner = await createAccount('apowner', { role: 'contributor', scope: [{ reformId: 'RA2', canApprove: false }] });
  const lead = await createAccount('aplead', { role: 'reform_lead', scope: [{ reformId: 'RA2', canApprove: true }] });
  await prepareMilestone('MS-010', owner);
  const ownerPage = await signedIn(browser, owner);
  await sendCatchUp(ownerPage, 'MS-010', true);
  const id = await latestSubmission('MS-010', owner);

  const leadPage = await signedIn(browser, lead);
  await expect(leadPage.getByTestId('nav-approvals')).toContainText(/Approvals\s*\d+/);
  await leadPage.getByTestId('nav-approvals').click();
  await leadPage.locator(`[data-submission="${id}"] a`).click();

  const status = leadPage.locator('.diff tr[data-field="status"]');
  await expect(status.locator('th')).toHaveText('Status');
  await expect(status.locator('.current')).toHaveText('On track');
  await expect(status.locator('.proposed')).toHaveText('Delayed');
  await expect(leadPage.locator('.diff tr[data-field="forecast_date"] .proposed')).toHaveText('15 Jan 2027');
  // Evidence attached without "confidence in the evidence" costs a scored point: the approver sees it.
  await expect(leadPage.getByTestId('quality')).toContainText('Quality score 94.4 (pass mark 80)');
  await leadPage.getByText('Points the checks raised').click();
  await expect(leadPage.locator('.checks details')).toContainText('Rate how confident you are in the evidence.');

  const fileLink = leadPage.getByRole('link', { name: 'cover-letter' });
  const file = await leadPage.request.get((await fileLink.getAttribute('href'))!, { maxRedirects: 0 });
  expect(file.status()).toBe(302);
  expect(file.headers()['location']).toContain('X-Amz-Expires=60');

  await leadPage.getByRole('button', { name: 'Approve' }).click();
  await expect(leadPage.getByTestId('done')).toContainText('Approved and applied');

  await ownerPage.goto('/my-items');
  await expect(ownerPage.getByTestId('nav-notices')).toHaveAccessibleName('Notices (1)');
  await ownerPage.getByTestId('nav-notices').click();
  await expect(ownerPage.locator('[data-kind="submission_approved"]')).toContainText('Your update was approved and applied.');
  await ownerPage.goto('/items/milestone/MS-010');
  await expect(ownerPage.getByLabel('Status')).toHaveValue('delayed');
  await expect(ownerPage.getByTestId('last-update')).toContainText('entered by E2E apowner');
  const evidence = await query<{ n: number }>("select count(*)::int as n from evidence_links where object_type = 'milestone' and object_id = 'MS-010'");
  expect(evidence[0]!.n).toBeGreaterThan(0);
});

test('an approver returns an update with a note; the owner sees the note, fixes it and sends again', async ({ browser }) => {
  const owner = await createAccount('rtowner', { role: 'contributor', scope: [{ reformId: 'RA2', canApprove: false }] });
  const lead = await createAccount('rtlead', { role: 'reform_lead', scope: [{ reformId: 'RA2', canApprove: true }] });
  await prepareMilestone('MS-106', owner);
  const ownerPage = await signedIn(browser, owner);
  await sendCatchUp(ownerPage, 'MS-106');
  const id = await latestSubmission('MS-106', owner);

  const leadPage = await signedIn(browser, lead);
  await leadPage.goto(`/approvals/${id}`);
  await leadPage.getByTestId('decide-bar').getByText('Return for changes').click();
  await leadPage.getByLabel('What needs fixing (required)').fill('Attach the letter from the minister');
  await leadPage.getByRole('button', { name: 'Return with this note' }).click();
  await expect(leadPage.getByTestId('done')).toContainText('Returned');

  await ownerPage.goto('/notices');
  await expect(ownerPage.locator('[data-kind="submission_returned"]')).toContainText('Attach the letter from the minister');
  await ownerPage.goto('/items/milestone/MS-106');
  await expect(ownerPage.getByRole('alert')).toContainText('Returned for changes: Attach the letter from the minister');
  await ownerPage.getByRole('button', { name: 'Send for approval' }).click();
  await expect(ownerPage.getByTestId('sent')).toBeVisible();
  const rows = await query<{ status: string }>('select status from submissions where submission_id = $1', [id]);
  expect(rows[0]!.status).toBe('proposed');
});

test('several "nothing changed" confirmations are approved together', async ({ browser }) => {
  const owner = await createAccount('cfowner', { role: 'contributor', scope: [{ reformId: 'RA2', canApprove: false }] });
  const lead = await createAccount('cflead', { role: 'reform_lead', scope: [{ reformId: 'RA2', canApprove: true }] });
  const ownerPage = await signedIn(browser, owner);
  for (const milestone of ['MS-107', 'MS-108']) {
    await prepareMilestone(milestone, owner, { planned_date: '2027-03-31', next_action: 'Hold the validation workshop' });
    await ownerPage.goto(`/items/milestone/${milestone}`);
    await ownerPage.getByRole('button', { name: 'Nothing changed' }).click();
    await expect(ownerPage.getByTestId('sent')).toBeVisible();
  }
  const leadPage = await signedIn(browser, lead);
  await leadPage.goto('/approvals?show=confirmations');
  const mine = await query<{ submission_id: string }>(
    "select s.submission_id from submissions s join app_users u on u.user_id = s.submitted_by where u.email = $1 and s.status = 'proposed'",
    [owner],
  );
  // Leave only this test's confirmations ticked.
  for (const box of await leadPage.locator('input[name="submission_id"]').all()) {
    const value = await box.getAttribute('value');
    if (!mine.some((m) => m.submission_id === value)) await box.uncheck();
  }
  await leadPage.getByRole('button', { name: 'Approve the selected confirmations' }).click();
  await expect(leadPage.getByTestId('batch-done')).toContainText('2 approved. 0 could not');
  const fresh = await query<{ n: number }>("select count(*)::int as n from milestones where milestone_id in ('MS-107', 'MS-108') and last_confirmed_at > now() - interval '5 minutes'");
  expect(fresh[0]!.n).toBe(2);
});

test('an approval refused by the live checks says why, and changes nothing', async ({ browser }) => {
  const owner = await createAccount('w10owner', { role: 'contributor', scope: [{ reformId: 'RA3', canApprove: false }] });
  const lead = await createAccount('w10lead', { role: 'reform_lead', scope: [{ reformId: 'RA3', canApprove: true }] });
  await prepareMilestone('MS-011', owner);
  const ownerPage = await signedIn(browser, owner);
  await sendCatchUp(ownerPage, 'MS-011');
  const id = await latestSubmission('MS-011', owner);
  // Someone else's change to the same item lands first.
  await query("update milestones set comments = 'Changed elsewhere' where milestone_id = 'MS-011'");

  const leadPage = await signedIn(browser, lead, false);
  await leadPage.goto(`/approvals/${id}`);
  await leadPage.getByRole('button', { name: 'Approve' }).click();
  await expect(leadPage.getByTestId('approval-error')).toContainText("Someone else's change to one of these items was approved after this was sent");
  const rows = await query<{ status: string }>('select status from submissions where submission_id = $1', [id]);
  expect(rows[0]!.status).toBe('proposed');
});

test('approving works without JavaScript', async ({ browser }) => {
  const owner = await createAccount('njowner', { role: 'contributor', scope: [{ reformId: 'RA3', canApprove: false }] });
  const lead = await createAccount('njlead', { role: 'reform_lead', scope: [{ reformId: 'RA3', canApprove: true }] });
  await prepareMilestone('MS-110', owner);
  const ownerPage = await signedIn(browser, owner);
  await sendCatchUp(ownerPage, 'MS-110');
  const id = await latestSubmission('MS-110', owner);
  const leadPage = await signedIn(browser, lead, false);
  await leadPage.goto(`/approvals/${id}`);
  await leadPage.getByText('Add a note').click();
  await leadPage.getByLabel('Note for the person who sent it (optional)').fill('Thank you');
  await leadPage.getByRole('button', { name: 'Approve' }).click();
  await expect(leadPage.getByTestId('done')).toContainText('Approved and applied');
});
