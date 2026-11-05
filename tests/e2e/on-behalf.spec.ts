// Build step 8 acceptance: the Secretariat enters an update for someone who does not sign in,
// with how and when it was received and a photo of the instruction; once approved the item
// shows "entered by A for B" (acceptance 6).
import { expect, test } from '@playwright/test';
import { pdf, png } from '../support/files';
import { approveAsSecondAdmin, createAccount, createPerson, prepareMilestone, query, signIn, signInAdmin, RUN } from './helpers';

test('an admin enters an update for a focal point, with proof of the instruction, and it shows who entered it for whom', async ({ page }) => {
  // MFA set-up and a later code can take up to 30 seconds.
  test.setTimeout(90_000);
  const admin = await createAccount('obadmin', { role: 'programme_admin' });
  const focal = await createPerson('focal');
  const { name } = await prepareMilestone('MS-101', focal.email);
  await signInAdmin(page, admin);

  await page.getByRole('link', { name: 'For someone else' }).click();
  await page.getByLabel('Person').selectOption(focal.personId);
  await page.getByRole('button', { name: 'Show their items' }).click();
  await page.getByRole('link', { name }).click();
  await expect(page.locator('fieldset.on-behalf legend')).toContainText(`You are entering this update for ${focal.name}`);

  await page.getByLabel('Status').selectOption('delayed');
  await page.getByLabel('New expected date').fill('2027-01-31');
  await page.getByLabel('What is blocking or delaying it').fill('The director is travelling until January');
  await page.getByLabel('Next action').fill('Present the draft at the January meeting');

  // Not sent until it says how it was received.
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.locator('#card-status')).toContainText('Say how you received this update.');

  await page.getByLabel('How you received it').selectOption('whatsapp');
  await page.locator('#instruction-file').setInputFiles({ name: 'whatsapp-message.png', mimeType: 'image/png', buffer: png(900, 1600) });
  await expect(page.locator('#instruction-status')).toContainText('is attached as proof of the instruction', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByTestId('sent')).toContainText(`entered for ${focal.name}`);

  const submissions = await query<{ submission_id: string; route: string; on_behalf_channel: string; has_instruction: boolean }>(
    `select s.submission_id, s.route, s.on_behalf_channel, s.instruction_upload_id is not null as has_instruction
       from submissions s join people p on p.person_id = s.on_behalf_of_person_id where p.email = $1 and s.status = 'proposed'`,
    [focal.email],
  );
  expect(submissions[0]).toMatchObject({ route: 'on_behalf', on_behalf_channel: 'whatsapp', has_instruction: true });
  const notices = await query<{ n: number }>("select count(*)::int as n from notification_log n join people p using (person_id) where p.email = $1 and n.kind = 'entered_on_behalf'", [focal.email]);
  expect(notices[0]!.n).toBe(1);

  await approveAsSecondAdmin(submissions[0]!.submission_id);
  await page.goto('/items/milestone/MS-101');
  await expect(page.getByTestId('last-update')).toContainText(`entered by E2E obadmin for ${focal.name}`);
});

test('on-behalf entry works without JavaScript', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const admin = await createAccount('obnojs', { role: 'programme_admin' });
  const focal = await createPerson('focalnojs');
  await prepareMilestone('MS-102', focal.email);
  await signInAdmin(page, admin);
  const cookies = await page.context().cookies();

  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies(cookies);
  const plain = await context.newPage();
  await plain.goto(`/items/milestone/MS-102?for=${focal.personId}`);
  await plain.getByLabel('How you received it').selectOption('meeting');
  await plain.getByLabel('Status').selectOption('delayed');
  await plain.getByLabel('New expected date').fill('2027-02-28');
  await plain.getByLabel('What is blocking or delaying it').fill('Waiting for the provincial consultation');
  await plain.getByLabel('Next action').fill('Collect the provincial comments');
  await plain.locator('#instruction-file').setInputFiles({ name: 'minutes.pdf', mimeType: 'application/pdf', buffer: pdf(`${RUN} ${test.info().title}`) });
  await plain.getByRole('button', { name: 'Send for approval' }).click();
  await expect(plain.getByTestId('sent')).toContainText(`entered for ${focal.name}`);
  await context.close();
});

test('only programme admins enter for someone else', async ({ page }) => {
  const lead = await createAccount('oblead', { role: 'reform_lead', scope: [{ reformId: 'RA1', canApprove: true }] });
  const focal = await createPerson('focallead');
  await signIn(page, lead);
  await expect(page.getByRole('link', { name: 'For someone else' })).toHaveCount(0);
  await page.goto('/on-behalf');
  await expect(page.locator('main')).toContainText('Only programme administrators enter updates for someone else.');
  await page.goto(`/items/milestone/MS-104?for=${focal.personId}`);
  await expect(page.locator('fieldset.on-behalf')).toHaveCount(0);
});
