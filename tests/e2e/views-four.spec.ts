// The four remaining views (spec 01 section 8, decisions 58 to 60): Portfolio, Risk and
// bottleneck, MERL, and Governance and adaptation; what counterparts see; the regrouped menu.
import { expect, test } from '@playwright/test';
import { createAccount, signIn, signInAdmin } from './helpers';

test('Portfolio: readiness with the proposed score, stages and the distribution', async ({ page }) => {
  await signIn(page, await createAccount('pfviewer', { role: 'viewer_internal' }));
  await page.getByTestId('nav-views').getByRole('link', { name: 'Portfolio' }).click();
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeVisible();
  await expect(page.getByTestId('as-of')).toContainText('items have not been confirmed for over 30 days');
  await expect(page.locator('[data-testid="readiness"] tr[data-reform="RA1"]')).toContainText('78');
  await expect(page.locator('[data-testid="readiness"] tr[data-reform="RA1"]')).toContainText('Source: 72');
  await expect(page.getByTestId('score-method')).toContainText('Proposed method, not yet agreed');
  await expect(page.locator('.tracks > li')).toHaveCount(3);
  await expect(page.locator('.tracks > li[data-reform="RA1"] .step.current')).toHaveCount(1);
  await expect(page.getByText('No item waits for an item in another reform.')).toBeVisible();
  await page.getByLabel('Reform', { exact: true }).selectOption('RA3');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.tracks > li')).toHaveCount(1);
});

test('Risks: level tiles, the register with its side panel, one heatmap at a time, bottlenecks (decision 90)', async ({ page }) => {
  await signIn(page, await createAccount('rkviewer', { role: 'viewer_internal' }));
  await page.goto('/risks');
  for (const id of ['level-high', 'level-medium', 'level-low', 'reviews-overdue']) await expect(page.getByTestId(id)).toContainText(/\d+/);
  const rows = page.locator('[data-testid="risk-list"] tbody tr');
  const all = await rows.count();
  expect(all).toBeGreaterThan(5);

  // A risk opens in the side panel with the detail the register leaves out.
  await page.locator('tr[data-risk="RK-001"]').getByRole('link').click();
  await expect(page).toHaveURL(/risk=RK-001/);
  await expect(page.getByTestId('risk-facts')).toContainText('25 (likelihood 5 × impact 5)');
  await expect(page.getByTestId('risk-facts')).toContainText('Mitigation');
  await page.getByTestId('side-panel').getByRole('link', { name: 'Close' }).click();
  await expect(page).not.toHaveURL(/risk=/);

  // The heatmap tab shows one map at a time; a square lists its risks in the register.
  const tabs = page.getByRole('navigation', { name: 'Sections of the risk view' });
  await tabs.getByRole('link', { name: /Heatmap/ }).click();
  await expect(page.getByTestId('heatmap-inherent')).toBeVisible();
  await expect(page.getByTestId('heatmap-residual')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Which heatmap' }).getByRole('link', { name: 'Residual risk' }).click();
  await expect(page.getByTestId('heatmap-residual')).toBeVisible();
  await page.getByRole('navigation', { name: 'Which heatmap' }).getByRole('link', { name: 'Inherent risk' }).click();
  await page.getByTestId('heatmap-inherent').getByRole('link', { name: /likelihood 5 and impact 5/ }).click();
  await expect(page).toHaveURL(/tab=register/);
  await expect(page.locator('[data-testid="risk-list"] tbody tr[data-risk="RK-001"]')).toBeVisible();
  expect(await rows.count()).toBeLessThan(all);
  await page.getByRole('link', { name: 'Show all' }).click();

  // The overdue tile filters the register, and the filters keep the tab.
  await page.getByTestId('reviews-overdue').click();
  await expect(page.locator('[data-testid="risk-list"] tbody tr').first().getByTestId('review-overdue')).toBeVisible();
  await page.getByLabel('Status', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/tab=register/);

  await tabs.getByRole('link', { name: /Bottlenecks/ }).click();
  await expect(page.getByTestId('bottlenecks-owner')).toBeVisible();
  await expect(page.getByTestId('bottlenecks-institution')).toContainText('No institution recorded');
});

test('MERL: tiles, indicators by level, the unconfirmed life-of-programme target in the panel, breakdowns, learning (decision 90)', async ({ page }) => {
  await signIn(page, await createAccount('mlviewer', { role: 'viewer_internal' }));
  await page.goto('/merl');
  const rows = page.locator('[data-testid="indicators"] tbody tr');
  expect(await rows.count()).toBeGreaterThan(10);
  await expect(page.getByTestId('tile-indicators')).toContainText(String(await rows.count()));
  await expect(page.locator('[data-indicator="O1.2"]')).toContainText('Proxy');
  // Life-of-programme targets are unconfirmed, so the panel says so instead of a number.
  await page.locator('[data-indicator="O1.2"]').getByRole('link').click();
  await expect(page.getByTestId('lop')).toHaveText('Not confirmed');
  await expect(page.getByTestId('indicator-facts')).toContainText('Baseline');
  await page.getByTestId('side-panel').getByRole('link', { name: 'Close' }).click();

  const tabs = page.getByRole('navigation', { name: 'Sections of the MERL view' });
  await tabs.getByRole('link', { name: /Breakdowns/ }).click();
  await expect(page.locator('[data-dimension="gender"]')).toContainText('Procedures simplified');
  await tabs.getByRole('link', { name: /Learning log/ }).click();
  await expect(page.getByTestId('learning').getByRole('link')).toHaveCount(7);
  await page.getByTestId('learning').getByRole('link').first().click();
  await expect(page.getByTestId('learning-facts')).toContainText('What it means');

  await page.goto('/merl');
  await page.getByLabel('Result level').selectOption('output');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('[data-indicator="O1.1"]')).toHaveCount(0);
});

test('Governance: tiles, one tab at a time, a decision and an adaptation in the side panel (decision 90)', async ({ page }) => {
  await signIn(page, await createAccount('gvviewer', { role: 'viewer_internal' }));
  await page.goto('/governance');
  const tabs = page.getByRole('navigation', { name: 'Sections of the governance view' });
  await expect(tabs.getByRole('link', { name: /Decisions/ })).toContainText('4');
  await expect(page.getByTestId('open-decisions')).toContainText('4');
  await expect(page.locator('tr[data-decision="DC-002"]')).toHaveCount(1);
  await expect(page.locator('tr[data-decision="DC-002"]').getByTestId('follow-up-overdue')).toBeVisible();

  // A decision opens with its reason and follow-up; the table keeps one line each.
  await page.locator('tr[data-decision="DC-005"]').getByRole('link').click();
  await expect(page.getByTestId('decision-facts')).toContainText('Because');
  await expect(page.getByTestId('decision-facts')).toContainText('Follow-up');
  await page.getByTestId('side-panel').getByRole('link', { name: 'Close' }).click();

  await page.getByLabel('Decision status').selectOption('all');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(tabs.getByRole('link', { name: /Decisions/ })).toContainText('6');

  await tabs.getByRole('link', { name: /Adaptations/ }).click();
  await expect(page.locator('[data-testid="adaptations"] tbody tr')).toHaveCount(4);
  await page.locator('tr[data-adaptation="AD-001"]').getByRole('link').click();
  await expect(page.getByTestId('adaptation-facts')).toContainText('Original plan');

  await page.goto('/governance?tab=raci');
  await expect(page.getByTestId('raci')).toContainText('Draft the coordination plan');
  await page.getByRole('navigation', { name: 'Which reform' }).getByRole('link', { name: 'RA2' }).click();
  await expect(page.getByTestId('raci')).toContainText('Draft the operating manual');

  await page.goto('/governance?tab=reviews');
  await expect(page.getByText('No review meeting is in the calendar yet.')).toBeVisible();
});

test('counterparts see Portfolio stages only; the other three views are closed to them', async ({ page }) => {
  await signIn(page, await createAccount('cpviews', { role: 'viewer_counterpart', scope: [{ reformId: 'RA1', canApprove: false }] }));
  const views = page.getByTestId('nav-views');
  for (const name of ['Executive', 'Portfolio', 'Pathway']) await expect(views.getByRole('link', { name })).toBeVisible();
  for (const name of ['Risks', 'MERL', 'Governance']) await expect(views.getByRole('link', { name })).toHaveCount(0);
  await page.goto('/portfolio');
  await expect(page.getByTestId('readiness')).toHaveCount(0);
  await expect(page.locator('.tracks > li')).toHaveCount(1);
  for (const [path, text] of [
    ['/risks', 'Risks are for programme staff only.'],
    ['/merl', 'Indicators and learning are for programme staff only.'],
    ['/governance', 'Decisions and adaptations are for programme staff only.'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByText(text)).toBeVisible();
  }
});

test('the sidebar: work, the six views, admin; Admin opens the hub', async ({ page }) => {
  await signInAdmin(page, await createAccount('navadmin', { role: 'programme_admin' }));
  await expect(page.getByTestId('nav-views').getByRole('link')).toHaveCount(6);
  for (const name of ['My items', 'Approvals', 'Bulk upload', 'For someone else', 'Reviews']) await expect(page.getByTestId('nav-work').getByRole('link', { name })).toBeVisible();
  for (const name of ['Data quality', 'People and access', 'Jobs', 'Errors']) await expect(page.getByTestId('nav-admin').getByRole('link', { name, exact: true })).toBeVisible();
  await page.getByTestId('nav-admin').getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible();
  for (const name of ['Users and access', 'People without accounts', 'Scheduled jobs']) await expect(page.getByRole('main').getByRole('link', { name, exact: true })).toBeVisible();
});

test('each view dates its own data (decision 92)', async ({ page }) => {
  await signIn(page, await createAccount('asofviewer', { role: 'viewer_internal' }));
  const expected: Array<[string, string, RegExp]> = [
    ['/executive', 'delivery', /confirmed|Never/i],
    ['/risks', 'risks', /Risk register last changed on|No open risk/],
    ['/merl', 'merl', /Latest approved indicator value|No indicator value has been approved/],
    ['/governance', 'governance', /Decision log last changed on|No decision or adaptation/],
    ['/portfolio', 'portfolio', /Readiness last assessed on|No readiness assessment/],
  ];
  for (const [path, kind, text] of expected) {
    await page.goto(path);
    const asOf = page.getByTestId('as-of');
    await expect(asOf).toHaveAttribute('data-kind', kind);
    await expect(asOf).toContainText(text);
  }
});
