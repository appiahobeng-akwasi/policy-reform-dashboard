// Build step 6 acceptance: My items, the update card with live hints, the gate's answer next to
// each field, drafts on the device, "nothing changed", evidence upload, and the form without JavaScript.
import { expect, test } from '@playwright/test';
import { docx, pdf, png } from '../support/files';
import { createAccount, prepareMilestone, query, signIn, RUN } from './helpers';

const latestStatus = async (milestone: string, email: string) =>
  (
    await query<{ status: string }>(
      `select s.status from submissions s join app_users u on u.user_id = s.submitted_by
        where u.email = $2 and s.payload -> 'rows' @> jsonb_build_array(jsonb_build_object('entity', 'milestone', 'id', $1::text))
        order by s.created_at desc limit 1`,
      [milestone, email],
    )
  )[0]?.status;

test('an owner finds their item, is told what to fix next to each field, fixes it and sends it for approval', async ({ page }) => {
  const email = await createAccount('owner', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  const { name } = await prepareMilestone('MS-008', email);
  await signIn(page, email);

  await page.getByRole('link', { name: 'My items' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'MS-008' })).toContainText('days overdue');
  // The row opens the side panel; Update opens the full card (decision 69).
  await page.getByRole('link', { name }).click();
  await page.getByTestId('panel-update').click();

  // The seeded milestone is overdue but still says "on track": sending only a next action is refused.
  await page.getByLabel('Next action').fill('Send the draft decree to the minister');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.locator('#card-status')).toContainText('Not sent yet');
  await expect(page.locator('#card-status')).toContainText('Quality score: 50');
  await expect(page.locator('[data-hint-for="status"]')).toContainText('The due date has passed but the status says on track');
  expect(await latestStatus('MS-008', email)).toBe('rejected_by_gate');

  // Live hints, from the same engine, as the person fixes it.
  await page.getByLabel('Status').selectOption('delayed');
  await expect(page.locator('[data-hint-for="forecast_date"]')).toContainText('Give a new expected date');
  await page.getByLabel('New expected date').fill('2026-12-15');
  await page.getByLabel('What is blocking or delaying it').fill('Waiting for the minister to sign');
  await expect(page.locator('[data-hint-for="forecast_date"]')).toBeEmpty();
  await expect(page.locator('#card-status')).toContainText('Quality score so far: 100');

  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
  expect(await latestStatus('MS-008', email)).toBe('proposed');
  const attempts = await query<{ n: number }>(
    'select count(*)::int as n from dq_runs r join submissions s using (submission_id) join app_users u on u.user_id = s.submitted_by where u.email = $1',
    [email],
  );
  expect(attempts[0]!.n).toBe(2);
});

test('"nothing changed" confirms an item that is still accurate', async ({ page }) => {
  const email = await createAccount('confirm', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  const { name } = await prepareMilestone('MS-009', email, { planned_date: '2027-03-31', next_action: 'Hold the validation workshop' });
  await signIn(page, email);
  await page.goto('/my-items');
  await page.getByRole('link', { name }).click();
  await page.getByRole('button', { name: 'Nothing changed' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
  const rows = await query<{ fields: Record<string, unknown> }>(
    `select s.payload -> 'rows' -> 0 -> 'fields' as fields from submissions s join app_users u on u.user_id = s.submitted_by where u.email = $1 and s.status = 'proposed'`,
    [email],
  );
  expect(rows[0]!.fields).toEqual({});
});

test('unsent changes are kept on the device and come back after a reload', async ({ page }) => {
  const email = await createAccount('draft', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await prepareMilestone('MS-101', email);
  await signIn(page, email);
  await page.goto('/items/milestone/MS-101');
  await page.getByLabel('Next action').fill('Phone the director before Friday');
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByLabel('Next action')).toHaveValue('Phone the director before Friday');
  await expect(page.getByTestId('draft-restored')).toBeVisible();
});

// Decision 91: drafts belong to one person. Signing out clears them, and another account on
// the same browser never sees someone else's unsent words.
test('a draft is not shown to the next person on a shared browser, and sign-out clears it', async ({ page }) => {
  const first = await createAccount('draftfirst', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  const second = await createAccount('draftsecond', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await prepareMilestone('MS-103', first);
  await signIn(page, first);
  await page.goto('/items/milestone/MS-103');
  await page.getByLabel('Next action').fill('Private note for the director');
  await page.waitForTimeout(800);
  const keys = () =>
    page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const open = indexedDB.open('ggp-dashboard', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('drafts');
          open.onsuccess = () => {
            const request = open.result.transaction('drafts').objectStore('drafts').getAllKeys();
            request.onsuccess = () => {
              resolve(request.result.map(String));
              open.result.close();
            };
          };
        }),
    );
  // The draft is kept under the person's account, not just the item.
  const saved = await keys();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/^[0-9a-f-]{36}:milestone:MS-103$/);

  // The update card is a focus page (decision 84): sign out from the normal shell.
  await page.goto('/my-items');
  await page.getByTestId('account-menu').locator('summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/(sign-in)?(\?.*)?$/);
  await page.goto('/sign-in');
  expect(await keys()).toEqual([]);

  await signIn(page, second);
  await page.goto('/items/milestone/MS-103');
  await expect(page.getByLabel('Next action')).not.toHaveValue('Private note for the director');
  await expect(page.getByTestId('draft-restored')).toHaveCount(0);
});

test('a photo is made smaller, sent with a resumable upload, and attached as evidence', async ({ page }) => {
  const email = await createAccount('photo', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await prepareMilestone('MS-102', email);
  await signIn(page, email);
  await page.goto('/items/milestone/MS-102');

  const photo = png(3200, 2400);
  await page.locator('#evidence-file').setInputFiles({ name: 'site-visit-photo.png', mimeType: 'image/png', buffer: photo });
  await expect(page.locator('#pending-uploads')).toContainText('is ready', { timeout: 30_000 });
  const uploads = await query<{ file_mime: string; file_bytes: string; file_path: string }>(
    'select e.file_mime, e.file_bytes, e.file_path from evidence_uploads e join app_users u on u.user_id = e.uploaded_by where u.email = $1',
    [email],
  );
  expect(uploads[0]).toMatchObject({ file_mime: 'image/jpeg' });
  expect(Number(uploads[0]!.file_bytes)).toBeLessThan(photo.length);
  expect(uploads[0]!.file_path).toMatch(/^evidence\/\d{4}\/[0-9a-f]{64}\.jpg$/);

  await page.getByLabel('Type of evidence').selectOption('screenshot');
  await page.getByLabel('Date of the document').fill('2026-11-02');
  await page.getByLabel('Source institution').fill('Ministry of Agriculture');
  await page.getByLabel('Status').selectOption('complete');
  await page.getByLabel('Date completed').fill('2026-11-02');
  await page.getByLabel('Confidence in the evidence').selectOption('high');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
});

test('uploads resume after a break, and files are checked by their contents', async ({ page }) => {
  const email = await createAccount('resume', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await signIn(page, email);
  const file = Buffer.concat([pdf(), Buffer.alloc(2_500_000, 0x20)]);
  const tus = { 'tus-resumable': '1.0.0' };

  const created = await page.request.post('/api/uploads', { headers: { ...tus, 'upload-length': String(file.length) } });
  expect(created.status()).toBe(201);
  const url = created.headers()['location']!;

  // The connection drops after the first megabyte...
  const first = await page.request.patch(url, { headers: { ...tus, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, data: file.subarray(0, 1_048_576) });
  expect(first.status()).toBe(204);
  // ...and later the client asks where to carry on from.
  const head = await page.request.head(url, { headers: tus });
  expect(head.headers()['upload-offset']).toBe('1048576');
  const rest = await page.request.patch(url, { headers: { ...tus, 'upload-offset': '1048576', 'content-type': 'application/offset+octet-stream' }, data: file.subarray(1_048_576) });
  expect(rest.status()).toBe(204);
  const received = await page.request.post('/api/evidence/receive', { data: { uploadUrl: url, fileName: 'report.pdf' } });
  expect(await received.json()).toMatchObject({ ok: true, mime: 'application/pdf', bytes: file.length });

  // A Word file with macros is refused, whatever it is called.
  const macro = docx(true);
  const createdMacro = await page.request.post('/api/uploads', { headers: { ...tus, 'upload-length': String(macro.length) } });
  const macroUrl = createdMacro.headers()['location']!;
  await page.request.patch(macroUrl, { headers: { ...tus, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, data: macro });
  const refused = await page.request.post('/api/evidence/receive', { data: { uploadUrl: macroUrl, fileName: 'minutes.docx' } });
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toEqual({ ok: false, reason: 'macro' });
});

test('someone else cannot carry on or claim your upload', async ({ page, browser }) => {
  const owner = await createAccount('upowner', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  const other = await createAccount('uother', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await signIn(page, owner);
  const tus = { 'tus-resumable': '1.0.0' };
  const created = await page.request.post('/api/uploads', { headers: { ...tus, 'upload-length': '10' } });
  const url = created.headers()['location']!;

  const context = await browser.newContext();
  const intruder = await context.newPage();
  await signIn(intruder, other);
  expect((await intruder.request.head(url, { headers: tus })).status()).toBe(403);
  expect((await intruder.request.post('/api/evidence/receive', { data: { uploadUrl: url, fileName: 'x.pdf' } })).status()).toBe(404);
  await context.close();
});

test('the update card works with JavaScript switched off', async ({ browser }) => {
  const email = await createAccount('nojs', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await prepareMilestone('MS-103', email);
  const withJs = await browser.newContext();
  const signInPage = await withJs.newPage();
  await signIn(signInPage, email);
  const cookies = await withJs.cookies();
  await withJs.close();

  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto('/items/milestone/MS-103');
  await page.getByLabel('Status').selectOption('delayed');
  await page.getByLabel('New expected date').fill('2027-01-31');
  await page.getByLabel('What is blocking or delaying it').fill('Budget line not yet released');
  await page.getByLabel('Next action').fill('Ask the finance director for the release date');
  await page.locator('#evidence-file').setInputFiles({ name: 'letter.pdf', mimeType: 'application/pdf', buffer: pdf(`${RUN} ${test.info().title}`) });
  await page.getByRole('button', { name: 'Send for approval' }).click();

  // The file is attached, but its details could not be filled in yet: the gate says what is missing.
  await expect(page.locator('#card-status')).toContainText('Not sent yet');
  await expect(page.getByText('Add the source institution, date and type of this evidence.')).toBeVisible();
  await page.getByLabel('Title').fill('Letter from the finance director');
  await page.getByLabel('Type of evidence').selectOption('letter');
  await page.getByLabel('Date of the document').fill('2026-11-01');
  await page.getByLabel('Source institution').fill('Ministry of Finance');
  await page.getByLabel('Confidence in the evidence').selectOption('medium');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByTestId('sent')).toBeVisible();
  const rows = await query<{ n: number }>(
    `select jsonb_array_length(s.payload -> 'rows')::int as n from submissions s join app_users u on u.user_id = s.submitted_by where u.email = $1 and s.status = 'proposed'`,
    [email],
  );
  expect(rows[0]!.n).toBe(2);
  await context.close();
});

test('a reform lead sees items with no owner and can assign one', async ({ page }) => {
  const lead = await createAccount('lead', { role: 'reform_lead', scope: [{ reformId: 'RA1', canApprove: true }] });
  await prepareMilestone('MS-104', null);
  await signIn(page, lead);
  await page.goto('/my-items?tab=reforms&no_owner=1');
  await expect(page.getByRole('row').filter({ hasText: 'MS-104' })).toContainText('No owner');
  await page.goto('/items/milestone/MS-104');
  await expect(page.getByLabel('Owner')).toBeVisible();
});
