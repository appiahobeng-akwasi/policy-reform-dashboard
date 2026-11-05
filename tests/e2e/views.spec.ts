// Build step 10 acceptance: the Executive and Pathway views, the sample RA1 structure (spec 13.2
// when real data is missing), counterparts' limited view, and the Slow 3G budget (spec 13.3,
// decision 41).
import { expect, test } from '@playwright/test';
import { createAccount, sampleData, signIn } from './helpers';

test('the Executive view: a card per reform, programme-wide milestones apart, data as of, the trend', async ({ page }) => {
  const viewer = await createAccount('exviewer', { role: 'viewer_internal' });
  await signIn(page, viewer);
  await expect(page).toHaveURL(/\/executive$/);
  for (const reform of ['RA1', 'RA2', 'RA3']) await expect(page.locator(`[data-reform="${reform}"]`)).toBeVisible();
  await expect(page.locator('[data-reform="RA1"]')).toContainText('Open high risks');
  await expect(page.getByTestId('as-of')).toContainText('items have not been confirmed for over 30 days');
  await expect(page.getByRole('heading', { name: 'Programme-wide milestones' })).toBeVisible();
  await expect(page.getByRole('heading', { name: "Escalations at level 3 (Programme Director's list)" })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quality score of updates, by month' })).toBeVisible();
  await page.locator('[data-reform="RA2"]').getByRole('link', { name: 'See the pathway' }).click();
  await expect(page).toHaveURL(/\/pathway\?reform=RA2$/);
});

test('the Pathway view: the board, a stepper per reform, a stage in the side panel, and filters (decision 89)', async ({ page }) => {
  const viewer = await createAccount('pwviewer', { role: 'viewer_internal' });
  await signIn(page, viewer);
  await page.goto('/pathway?reform=RA1');
  // The board always shows every reform; the sections below only the one chosen.
  await expect(page.locator('[data-board-reform]')).toHaveCount(3);
  await expect(page.locator('[data-board-reform="RA1"] td[data-stage]')).toHaveCount(8);
  await expect(page.locator('[data-reform="RA1"] .stepper [data-stage]')).toHaveCount(8);
  await expect(page.locator('[data-reform="RA2"]')).toHaveCount(0);
  await expect(page.locator('[data-reform="programme"]')).toHaveCount(0);
  await expect(page.locator('[data-reform="RA1"]').getByTestId('position')).toHaveText(/^(Stages? [\d, and]+ of 8|All 8 stages complete|Not started)$/);
  // Every dot and step says in words which reform, which stage and its status.
  for (const link of await page.locator('[data-board-reform="RA1"] td[data-stage] a').all()) {
    await expect(link).toHaveAccessibleName(/^RA1, .+: (Complete|In progress|Not started|Blocked)/);
  }

  // A stage opens in the side panel and closes back to the same filters.
  await page.locator('[data-reform="RA1"] .stepper [data-stage]').nth(4).getByRole('link').click();
  await expect(page).toHaveURL(/\/pathway\?reform=RA1&stage=[\w-]+$/);
  const panel = page.getByTestId('side-panel');
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^RA1: /);
  await expect(panel.getByTestId('stage-facts')).toContainText('Stage 5 of 8');
  await expect(panel.getByTestId('stage-status')).toHaveText(/^(Complete|In progress|Not started|Blocked)$/);
  await panel.getByRole('link', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/pathway\?reform=RA1$/);

  // An unknown stage says so instead of failing.
  await page.goto('/pathway?stage=PT-999');
  await expect(page.getByTestId('side-panel')).toContainText('That stage was not found.');

  await page.goto('/pathway');
  await expect(page.locator('[data-reform="programme"]')).toBeVisible();
  await page.getByRole('navigation', { name: 'Reform' }).getByRole('link', { name: 'RA3', exact: true }).click();
  await expect(page).toHaveURL(/\/pathway\?reform=RA3$/);
  await page.getByLabel('Status', { exact: true }).selectOption('complete');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/reform=RA3/);
  await expect(page).toHaveURL(/status=complete/);
  const items = page.locator('[data-reform="RA3"] [data-item]');
  const count = await items.count();
  for (let i = 0; i < count; i++) await expect(items.nth(i).locator('.rag')).toHaveText('Blue');
});

test('the Pathway delivery table: overdue first, the first five, the rest behind Show more, in French too', async ({ page }) => {
  const viewer = await createAccount('pwtable', { role: 'viewer_internal' });
  await signIn(page, viewer);
  await page.goto('/pathway');
  const programme = page.locator('[data-reform="programme"]');
  const rows = programme.locator('[data-item]');
  const total = await rows.count();
  expect(total).toBeGreaterThan(6);
  await expect(programme.locator('table.dt').first().locator('[data-item]')).toHaveCount(5);
  const more = programme.locator('details.dt-more');
  await expect(more.locator('summary')).toHaveText(`Show ${total - 5} more`);
  await expect(more.locator('[data-item]').first()).toBeHidden();
  await more.locator('summary').click();
  await expect(more.locator('[data-item]').first()).toBeVisible();

  // Overdue rows come first, the most overdue at the top.
  const late = await rows.evaluateAll((all) => all.map((r) => Number(/\d+/.exec(r.querySelector('.dt-late')?.textContent ?? '')?.[0] ?? 0)));
  const firstOnTime = late.indexOf(0);
  const overdue = firstOnTime === -1 ? late : late.slice(0, firstOnTime);
  expect(overdue).toEqual([...overdue].sort((a, b) => b - a));
  if (firstOnTime !== -1) expect(late.slice(firstOnTime).every((d) => d === 0)).toBe(true);

  // The side panel in French, from a dot on the board.
  // (The open panel covers the header, so switch language first.)
  await page.getByRole('button', { name: 'FR', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.locator('[data-board-reform="RA2"] td[data-stage] a').nth(2).click();
  await expect(page.getByTestId('stage-facts')).toContainText('Étape 3 sur 8');
  await expect(page.getByTestId('side-panel').getByRole('heading', { level: 2 })).toHaveText(/^RA2 : /);
  await expect(page.getByTestId('pathway-board')).toContainText('Toutes les réformes');
});

test('the Pathway view on a phone: no sideways scrolling, the board as rows, the stepper as a list', async ({ browser }) => {
  const viewer = await createAccount('pwphone', { role: 'viewer_internal' });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await signIn(page, viewer);
  await page.goto('/pathway');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  // The board's stage dots give way to each reform's place in words.
  await expect(page.locator('[data-board-reform="RA1"] .pw-row-position')).toBeVisible();
  await expect(page.locator('[data-board-reform="RA1"] td[data-stage]').first()).toBeHidden();
  // The stepper stacks: each step sits below the one before it.
  const steps = page.locator('[data-reform="RA1"] .stepper [data-stage]');
  const first = await steps.nth(0).boundingBox();
  const second = await steps.nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  await context.close();
});

test('the sample RA1 structure shows end to end, labelled Sample everywhere, and is removed cleanly', async ({ page }) => {
  await sampleData('load');
  try {
    const viewer = await createAccount('smviewer', { role: 'viewer_internal' });
    await signIn(page, viewer);
    await page.goto('/pathway?reform=RA1');
    const ra1 = page.locator('[data-reform="RA1"]');
    await expect(ra1.locator('.notice')).toContainText('sample workstreams (placeholders)');
    await expect(ra1.locator('details.level > summary').filter({ hasText: 'Workstream' })).toHaveCount(2);
    for (const id of ['DL-RA1-001', 'AC-RA1-0001', 'MS-901']) await expect(ra1).toContainText(id);
    await expect(ra1.locator('[data-item="MS-901"]')).toContainText('Sample owner A');
    await expect(ra1.locator('[data-item="MS-901"] .sample')).toHaveText('Sample');
    await expect(page.locator('[data-reform="RA1"] .sample').first()).toBeVisible();
    await page.goto('/executive');
    await expect(page.locator('[data-reform="RA1"] .sample')).toHaveText('Sample');
    await page.goto('/items/milestone/MS-901');
    await expect(page.getByRole('heading', { level: 1 }).locator('.sample')).toHaveText('Sample');
  } finally {
    await sampleData('remove');
  }
  await page.goto('/pathway?reform=RA1');
  await expect(page.locator('[data-reform="RA1"]')).not.toContainText('MS-901');
});

test('a government counterpart sees their reform only, without risks or decisions', async ({ page }) => {
  const counterpart = await createAccount('excounterpart', { role: 'viewer_counterpart', scope: [{ reformId: 'RA1', canApprove: false }] });
  await signIn(page, counterpart);
  await page.goto('/executive');
  await expect(page.locator('[data-reform]')).toHaveCount(1);
  await expect(page.locator('[data-reform="RA1"]')).not.toContainText('Open high risks');
  await expect(page.locator('main')).toContainText('Risks and decisions are not shown to government counterparts.');
});

test.describe('on a phone over Slow 3G (decision 41)', () => {
  // My items as a reform lead's "My reforms": the hero ring and a full table (docs/08 v0.2).
  for (const path of ['/executive', '/pathway', '/portfolio', '/risks', '/merl', '/governance', '/my-items?tab=reforms']) {
    test(`${path} is usable within 8 seconds, under 150 KB, with only the shared shortcut script`, async ({ browser }) => {
      const viewer = path.startsWith('/my-items')
        ? await createAccount('3gmyitems', { role: 'reform_lead', scope: ['RA1', 'RA2', 'RA3'].map((reformId) => ({ reformId, canApprove: true })) })
        : await createAccount(`3g${path.slice(1, 4)}`, { role: 'viewer_internal' });
      const signInContext = await browser.newContext();
      await signIn(await signInContext.newPage(), viewer);
      const cookies = await signInContext.cookies();
      await signInContext.close();

      const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await context.addCookies(cookies);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      // Chrome DevTools' "Slow 3G": 2 s latency, 400 kbit/s each way.
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 });
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

      await page.goto(path, { waitUntil: 'load', timeout: 30_000 });
      const measured = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        return {
          loadMs: nav.loadEventEnd - nav.startTime,
          bytes: nav.transferSize + resources.reduce((sum, r) => sum + r.transferSize, 0),
          // The one shared script (decision 70): module scripts the page loads, and their size.
          scripts: [...document.scripts].filter((s) => s.type !== 'application/json').length,
          scriptBytes: resources.filter((r) => r.initiatorType === 'script').reduce((sum, r) => sum + r.transferSize, 0),
        };
      });
      console.log(`${path} on Slow 3G: ${Math.round(measured.loadMs)} ms, ${Math.round(measured.bytes / 1024)} KB, ${measured.scripts} script (${measured.scriptBytes} bytes)`);
      expect(measured.loadMs).toBeLessThan(8000);
      expect(measured.bytes).toBeLessThan(150 * 1024);
      expect(measured.scripts).toBeLessThanOrEqual(1);
      expect(measured.scriptBytes).toBeLessThan(2 * 1024);
      await context.close();
    });
  }
});
