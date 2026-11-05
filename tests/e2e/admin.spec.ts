// Build step 11 acceptance: the data quality page shows a rejected upload and its passing retry
// (spec 01 section 13, criterion 5); admins add, edit and turn off accounts; a super administrator
// resets an authenticator app; people see their own data quality; non-admins are kept out.
// Uses MS-105 (RA2), which no other browser test touches.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { workbook } from '../support/workbooks';
import { createAccount, prepareMilestone, query, RUN, signIn, signInAdmin, unlistedEmail } from './helpers';

async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

test('a rejected upload and its fixed retry both appear on the data quality page (criterion 5)', async ({ browser }) => {
  const lead = await createAccount('dqlead', { role: 'reform_lead', scope: [{ reformId: 'RA2', canApprove: true }] });
  await prepareMilestone('MS-105', lead);
  const file = workbook({
    sheets: {
      Milestones: [
        {
          milestone_id: 'MS-105',
          status: 'finished',
          forecast_date: new Date(Date.UTC(2026, 11, 20)),
          blocker: 'Waiting for the ministry to confirm the date',
          next_action: 'Hold the validation meeting',
          comments: `DQ run ${RUN}`,
        },
      ],
    },
  });
  const page = await newPage(browser);
  await signIn(page, lead);
  await page.goto('/uploads/new');
  await page.getByLabel('Excel file (.xlsx) or CSV, up to 5 MB').setInputFiles({ name: 'ra2.xlsx', mimeType: 'application/octet-stream', buffer: file });
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await expect(page.getByTestId('summary')).toContainText('has not passed yet');
  const id = /\/uploads\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await page.getByLabel('status Row 2').fill('delayed');
  await page.getByRole('button', { name: 'Save fixes and check again' }).click();
  await expect(page.getByTestId('summary')).toContainText('passed the checks');

  // The lead sees their own figures, and only those.
  await page.getByTestId('account-menu').locator('summary').click();
  await page.getByRole('link', { name: 'My data quality' }).click();
  await expect(page.getByTestId('attempts')).toHaveText('2');
  await expect(page.getByTestId('my-rules')).toContainText('B04 Value not in the list');
  await page.goto('/admin/data-quality');
  await expect(page.getByText('This page is for programme administrators.')).toBeVisible();

  const admin = await createAccount('dqadmin', { role: 'programme_admin' });
  const adminPage = await newPage(browser);
  await signInAdmin(adminPage, admin);
  await adminPage.getByTestId('nav-admin').getByRole('link', { name: 'Data quality' }).click();
  // By account, not name: earlier runs left other people called "E2E dqlead".
  const leadId = (await query<{ user_id: string }>('select user_id from app_users where email = $1', [lead]))[0]!.user_id;
  await adminPage.getByLabel('Person', { exact: true }).selectOption(leadId);
  await adminPage.getByRole('button', { name: 'Apply' }).click();
  // Decision 90: tiles and what needs attention on top, the detail one tab at a time.
  await expect(adminPage.getByTestId('attention')).toContainText('B04');
  const tabs = adminPage.getByRole('navigation', { name: 'Sections of the data quality page' });
  await tabs.getByRole('link', { name: /All attempts/ }).click();
  await expect(adminPage).toHaveURL(/user=/);
  const rows = adminPage.locator(`[data-testid="attempts-list"] tr[data-submission="${id}"]`);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Passed');
  await expect(rows.nth(1)).toContainText('Not passed');
  await expect(rows.nth(1)).toContainText('red problems');
  await tabs.getByRole('link', { name: /Checks/ }).click();
  await expect(adminPage.getByTestId('rules')).toContainText('B04');
  await expect(adminPage.getByTestId('pass-rate')).toHaveText('0%');
});

test('an admin adds a user who can then sign in, and turns them off', async ({ browser }) => {
  const admin = await createAccount('useradmin', { role: 'programme_admin' });
  const adminPage = await newPage(browser);
  await signInAdmin(adminPage, admin);
  await adminPage.getByRole('link', { name: 'Admin', exact: true }).click();
  await adminPage.getByRole('link', { name: 'Users and access', exact: true }).click();
  await adminPage.getByRole('link', { name: 'Add a user' }).click();
  // Programme admins are not offered the super administrator role.
  await expect(adminPage.getByLabel('Role').locator('option[value="super_admin"]')).toHaveCount(0);

  const email = unlistedEmail('added');
  await adminPage.getByLabel('Full name').fill('Added By Page');
  await adminPage.getByLabel('Email').fill(email.toUpperCase());
  await adminPage.getByLabel('Role').selectOption('contributor');
  await adminPage.getByLabel('Works on RA3').check();
  await adminPage.getByRole('button', { name: 'Add a user' }).click();
  await expect(adminPage.getByText('Account added. They can now sign in with their email.')).toBeVisible();
  const userUrl = adminPage.url();

  // The same email again is refused with a clear message.
  await adminPage.goto('/admin/users/new');
  await adminPage.getByLabel('Full name').fill('Someone Else');
  await adminPage.getByLabel('Email').fill(email);
  await adminPage.getByRole('button', { name: 'Add a user' }).click();
  await expect(adminPage.getByTestId('admin-error')).toContainText('already in use');

  const userPage = await newPage(browser);
  await signIn(userPage, email);
  await expect(userPage.getByTestId('account-menu')).toBeVisible();
  await expect(userPage.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);

  await adminPage.goto(userUrl);
  await adminPage.getByRole('button', { name: 'Turn off account' }).click();
  await expect(adminPage.getByTestId('admin-done')).toContainText('Account turned off');
  await expect(adminPage.getByTestId('history')).toContainText('Account (changed)');

  // Their next click finds them signed out.
  await userPage.goto('/my-items');
  await expect(userPage).toHaveURL(/\/sign-in/);

  // An admin cannot turn off their own account.
  const own = await query<{ user_id: string }>('select user_id from app_users where email = $1', [admin]);
  await adminPage.goto(`/admin/users/${own[0]!.user_id}`);
  await expect(adminPage.getByText('You cannot turn off your own account.')).toBeVisible();
});

test('people without accounts: add one, then give them access', async ({ browser }) => {
  const admin = await createAccount('peopleadmin', { role: 'programme_admin' });
  const page = await newPage(browser);
  await signInAdmin(page, admin);
  await page.goto('/admin/people/new');
  await page.getByLabel('Full name').fill(`Focal Point ${RUN}`);
  await page.getByRole('button', { name: 'Add a person' }).click();
  await expect(page.getByTestId('admin-done')).toContainText('Person added');
  await expect(page.getByText('Add an email address above first.')).toBeVisible();

  const email = unlistedEmail('focal');
  await page.getByLabel('Email (optional)').fill(email);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('admin-done')).toContainText('Changes saved');
  await page.getByLabel('Role').selectOption('viewer_internal');
  await page.getByRole('button', { name: 'Give access' }).click();
  await expect(page.getByText('Account added.')).toBeVisible();
  const rows = await query<{ app_role: string }>('select app_role from app_users where email = $1', [email]);
  expect(rows).toEqual([{ app_role: 'viewer_internal' }]);
});

test('a super administrator resets a lost authenticator app', async ({ browser }) => {
  const target = await createAccount('lostphone', { role: 'programme_admin' });
  const targetPage = await newPage(browser);
  await signInAdmin(targetPage, target);

  const superAdmin = await createAccount('resetter', { role: 'super_admin' });
  const page = await newPage(browser);
  await signInAdmin(page, superAdmin);
  await page.goto(`/admin/users?q=${encodeURIComponent(target)}`);
  await expect(page.locator(`tr[data-email="${target}"]`)).toContainText('Set up');
  await page.locator(`tr[data-email="${target}"] a`).click();
  await page.getByRole('button', { name: 'Reset authenticator app' }).click();
  await expect(page.getByTestId('admin-done')).toContainText('Authenticator app reset');
  await expect(page.getByTestId('history')).toContainText('Authenticator app reset');

  // Removing the app signs them out; at the next sign-in they set up a new one.
  const again = await newPage(browser);
  await signIn(again, target);
  await expect(again.getByRole('button', { name: 'Start set-up' })).toBeVisible();
});
