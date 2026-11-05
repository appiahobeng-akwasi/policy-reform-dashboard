// Build step 7 acceptance: upload the template, see red and amber cells, download the gap list,
// fix a cell in the preview, pass; file rules on real files; the same file twice; no JavaScript.
import { expect, test } from '@playwright/test';
import { csv, workbook } from '../support/workbooks';
import { createAccount, prepareMilestone, query, RUN, signIn } from './helpers';

const uploadIdFrom = (url: string) => /\/uploads\/([0-9a-f-]{36})/.exec(url)?.[1] ?? '';

test('upload, see what to fix, fix it in the preview, pass; the same file again is refused', async ({ page }) => {
  const email = await createAccount('bulklead', { role: 'reform_lead', scope: [{ reformId: 'RA1', canApprove: true }] });
  await prepareMilestone('MS-104', email);
  const file = workbook({
    sheets: {
      Milestones: [
        {
          milestone_id: 'MS-104',
          status: 'finished',
          forecast_date: new Date(Date.UTC(2026, 11, 20)),
          blocker: 'Waiting for the ministry to confirm the date',
          next_action: 'Hold the validation meeting',
          comments: `Test run ${RUN}`,
        },
      ],
    },
  });
  await signIn(page, email);
  await page.getByRole('link', { name: 'Bulk upload' }).click();
  await page.getByRole('link', { name: 'Upload and check' }).click();
  await page.getByLabel('Excel file (.xlsx) or CSV, up to 5 MB').setInputFiles({ name: 'ra1-update.xlsx', mimeType: 'application/octet-stream', buffer: file });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await page.waitForURL(/\/uploads\/[0-9a-f-]{36}$/);
  const id = uploadIdFrom(page.url());

  await expect(page.getByTestId('summary')).toContainText('has not passed yet');
  // Rows to fix are counted, with a link down to them, and each problem links to its rule.
  await expect(page.getByTestId('fix-rows')).toContainText('Rows to fix');
  await expect(page.locator('.rule-link').first()).toHaveAttribute('href', /\/rules\?open=/);
  await expect(page.locator('[data-cell="status2"]')).toHaveClass(/cell-red/);
  await expect(page.locator('.problems')).toContainText('"finished" is not an accepted value for status');
  const stored = await query<{ cell: string }>(
    "select f.cell from dq_findings f join dq_runs r using (dq_run_id) where r.submission_id = $1 and f.rule_id = 'B04'",
    [id],
  );
  expect(stored[0]!.cell).toBe('L2');

  const gaps = await page.request.get(`/uploads/${id}/gaps.csv`);
  expect(gaps.headers()['content-type']).toContain('text/csv');
  const text = await gaps.text();
  expect(text).toContain('"Milestones","2","L2","status","finished","B04"');

  await page.getByLabel('status Row 2').fill('delayed');
  await page.getByRole('button', { name: 'Save fixes and check again' }).click();
  await expect(page.getByTestId('summary')).toContainText('passed the checks');
  const state = await query<{ status: string; attempts: number }>(
    'select s.status, (select count(*)::int from dq_runs r where r.submission_id = s.submission_id) as attempts from submissions s where s.submission_id = $1',
    [id],
  );
  expect(state[0]).toEqual({ status: 'proposed', attempts: 2 });

  // The same file again: it was already accepted (F08).
  await page.goto('/uploads/new');
  await page.getByLabel('Excel file (.xlsx) or CSV, up to 5 MB').setInputFiles({ name: 'ra1-update.xlsx', mimeType: 'application/octet-stream', buffer: file });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await page.waitForURL((url) => uploadIdFrom(url.toString()) !== '' && uploadIdFrom(url.toString()) !== id);
  await expect(page.locator('.file-problems')).toContainText('This exact file was already accepted');
});

test('file rules on real files: a macro file and a renamed heading are refused before any row is read', async ({ page }) => {
  // MERL officers can upload and do not need MFA, which keeps this test short.
  const merl = await createAccount('bulkmerl', { role: 'merl_officer' });
  await signIn(page, merl);
  await page.goto('/uploads/new');
  await page.getByLabel('Excel file (.xlsx) or CSV, up to 5 MB').setInputFiles({
    name: 'values.xlsm',
    mimeType: 'application/octet-stream',
    buffer: workbook({ sheets: { Indicator_Values: [{ indicator_code: 'O1.1' }] }, macro: true }),
  });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await page.waitForURL(/\/uploads\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('summary')).toContainText('The file itself could not be accepted');
  await expect(page.locator('.file-problems')).toContainText('This file type is not accepted');

  await page.goto('/uploads/new');
  await page.getByLabel('Excel file (.xlsx) or CSV, up to 5 MB').setInputFiles({
    name: 'values.xlsx',
    mimeType: 'application/octet-stream',
    buffer: workbook({ sheets: { Indicator_Values: [{ indicator_code: 'O1.1' }] }, headers: { Indicator_Values: ['indicator', 'value'] } }),
  });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await page.waitForURL(/\/uploads\/[0-9a-f-]{36}$/);
  await expect(page.locator('.file-problems')).toContainText('The column headings on sheet Indicator_Values were changed');
});

test('MERL uploads indicator values as a CSV without JavaScript, and they pass', async ({ browser }) => {
  const email = await createAccount('bulknojs', { role: 'merl_officer' });
  const code = (await query<{ code: string }>('select indicator_code as code from indicators order by indicator_code limit 1'))[0]!.code;
  const withJs = await browser.newContext();
  await signIn(await withJs.newPage(), email);
  const cookies = await withJs.cookies();
  await withJs.close();

  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto('/uploads/new');
  const file = csv('Indicator_Values', [
    { indicator_code: code, reform_id: 'RA2', period_end: '2026-10-31', value: '7', confidence: 'medium', evidence_basis: 'Ministry register, October extract', comment: `Test run ${RUN}`, reported_by_email: 'focal.point@example.org' },
  ]);
  await page.getByLabel('Excel file (.xlsx) or CSV, up to 5 MB').setInputFiles({ name: 'indicator-values.csv', mimeType: 'text/csv', buffer: file });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await expect(page.getByTestId('summary')).toContainText('passed the checks');
  const batch = await query<{ reported_by_emails: string[]; sheets_found: string[] }>(
    'select b.reported_by_emails, b.sheets_found from upload_batches b join app_users u on u.user_id = b.uploaded_by where u.email = $1',
    [email],
  );
  expect(batch[0]).toEqual({ reported_by_emails: ['focal.point@example.org'], sheets_found: ['Indicator_Values'] });
  await context.close();
});

test('contributors use the update card, not bulk upload', async ({ page }) => {
  const email = await createAccount('bulkcontrib', { role: 'contributor', scope: [{ reformId: 'RA1', canApprove: false }] });
  await signIn(page, email);
  await expect(page.getByRole('link', { name: 'Bulk upload' })).toHaveCount(0);
  await page.goto('/uploads');
  await expect(page.locator('main')).toContainText('Bulk upload is for programme administrators');
});
