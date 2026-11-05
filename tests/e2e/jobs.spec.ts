// Build step 12 acceptance: an admin runs the daily job from the Jobs page; the owner of an
// item due soon gets a notice and one email (caught by Mailpit); running it again sends nothing
// twice; the scheduler address needs the secret. Uses MS-111 (RA3), which no other test touches.
import { expect, test } from '@playwright/test';
import { countEmailsTo, createAccount, prepareMilestone, query, signIn, signInAdmin } from './helpers';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';
// Today in Kinshasa (UTC+1), plus n days.
const inDays = (n: number) => new Date(Date.now() + 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

test('Run now sends a due-soon reminder by notice and by one email', async ({ browser }) => {
  const owner = await createAccount('jobowner', { role: 'contributor', scope: [{ reformId: 'RA3', canApprove: false }] });
  await prepareMilestone('MS-111', owner, { planned_date: inDays(2), last_confirmed_at: new Date() });

  const admin = await createAccount('jobadmin', { role: 'programme_admin' });
  const adminPage = await (await browser.newContext()).newPage();
  await signInAdmin(adminPage, admin);
  await adminPage.getByRole('link', { name: 'Admin', exact: true }).click();
  await adminPage.getByRole('link', { name: 'Scheduled jobs', exact: true }).click();
  await expect(adminPage.getByTestId('email-status')).toContainText('Email is on');
  await adminPage.locator('button[data-job="daily"]').click();
  await expect(adminPage.getByTestId('ran')).toContainText('Daily reminders and escalations finished.');
  await expect(adminPage.getByTestId('job-runs').locator('tr').nth(1)).toContainText('Finished');

  await expect.poll(() => countEmailsTo(owner), { timeout: 15_000 }).toBe(1);
  const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${owner}"`)}`);
  const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] };
  expect(messages[0]!.Subject).toBe('Pillar 1 dashboard: items that need your attention');
  const message = (await (await fetch(`${MAILPIT}/api/v1/message/${messages[0]!.ID}`)).json()) as { Text: string };
  expect(message.Text).toContain('Milestone MS-111');
  expect(message.Text).toContain('/items/milestone/MS-111');

  // Again the same day: nothing new.
  await adminPage.locator('button[data-job="daily"]').click();
  await expect(adminPage.getByTestId('ran')).toContainText('finished');
  await adminPage.waitForTimeout(1000);
  expect(await countEmailsTo(owner)).toBe(1);

  const ownerPage = await (await browser.newContext()).newPage();
  await signIn(ownerPage, owner);
  await ownerPage.goto('/notices');
  await expect(ownerPage.locator('[data-kind="due_soon"]')).toContainText('MS-111');

  // The owner turns the daily email off.
  await ownerPage.goto('/account');
  await ownerPage.getByLabel('Send me a daily email when items need my attention').uncheck();
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage.getByText('Your email setting is saved.')).toBeVisible();
  const setting = await query<{ email_reminders: boolean }>('select email_reminders from people where email = $1', [owner]);
  expect(setting[0]!.email_reminders).toBe(false);

  // Non-admins cannot open the Jobs page.
  await ownerPage.goto('/admin/jobs');
  await expect(ownerPage.getByText('This page is for programme administrators.')).toBeVisible();
});

test('the scheduler address needs the secret', async ({ request }) => {
  expect((await request.post('/api/jobs/nightly')).status()).toBe(404);
  expect((await request.post('/api/jobs/nightly', { headers: { authorization: 'Bearer wrong' } })).status()).toBe(404);
  const secret = process.env.JOBS_SECRET;
  test.skip(!secret, 'JOBS_SECRET is not set');
  const ok = await request.post('/api/jobs/nightly', { headers: { authorization: `Bearer ${secret}` } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).status).toBe('succeeded');
  expect((await request.post('/api/jobs/nope', { headers: { authorization: `Bearer ${secret}` } })).status()).toBe(404);
});
