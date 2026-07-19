// Behavior test: renderActivity() must keep the newest event visible
// when the user is at the top of the log, AND must NOT yank the viewport
// back to the top when the user has scrolled down to read history.
//
// String-match tests can confirm the 40px sample-then-snap code exists;
// only a real DOM can verify the interaction is correct end-to-end.

import { test, expect } from '@playwright/test';
import { startManager, post, bootstrapDashboardAuth } from './helpers.js';

let mgr;
test.beforeAll(async () => {
  mgr = await startManager();
  // Seed enough events that the log scrolls. The dashboard polls every
  // 2s so the initial render will include these on first load.
  const events = Array.from({ length: 80 }, (_, i) => ({
    batchId: 'e2e', workerId: 'PC-A', level: 'info', source: 'engine',
    message: `seed-${String(i).padStart(3, '0')}`,
  }));
  await post(mgr.baseUrl, '/api/activity', { events });
});
test.afterAll(async () => { await mgr?.stop(); });

test('newest event stays visible when user is at top of log', async ({ page }) => {
  await bootstrapDashboardAuth(page, mgr.token);
  await page.goto(mgr.baseUrl);
  await page.click('button.tab[data-tab="dashboard"]');

  const log = page.locator('#activityLog');
  await expect(log).toBeVisible();
  // Wait until the seed events land — at least one log-line must exist.
  await expect(log.locator('.log-line').first()).toBeVisible();

  // Confirm we start at the top.
  await log.evaluate(el => { el.scrollTop = 0; });
  expect(await log.evaluate(el => el.scrollTop)).toBe(0);

  // Push a distinguishable new event, then wait for the 2s dashboard poll
  // to fetch it. The new event should appear at the top of the DOM and
  // the viewport should have stayed pinned there.
  const marker = `TOPMARKER-${Date.now()}`;
  await post(mgr.baseUrl, '/api/activity', {
    batchId: 'e2e', workerId: 'PC-A', level: 'info', source: 'engine', message: marker,
  });

  await expect(log.locator('.log-line').first().locator('.msg')).toHaveText(marker, { timeout: 5_000 });
  expect(await log.evaluate(el => el.scrollTop)).toBeLessThanOrEqual(40);
});

test('scrolled-down reader is not yanked back to top on refresh', async ({ page }) => {
  await bootstrapDashboardAuth(page, mgr.token);
  await page.goto(mgr.baseUrl);
  await page.click('button.tab[data-tab="dashboard"]');

  const log = page.locator('#activityLog');
  await expect(log.locator('.log-line').first()).toBeVisible();

  // Scroll well past the 40px slack.
  await log.evaluate(el => { el.scrollTop = 500; });
  const before = await log.evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(40);

  // New event arrives; wait for it to render, then verify our scroll
  // position was NOT reset.
  const marker = `DEEPMARKER-${Date.now()}`;
  await post(mgr.baseUrl, '/api/activity', {
    batchId: 'e2e', workerId: 'PC-A', level: 'info', source: 'engine', message: marker,
  });
  await expect(log.locator('.log-line').first().locator('.msg')).toHaveText(marker, { timeout: 5_000 });
  const after = await log.evaluate(el => el.scrollTop);
  // Same scroll position (within a few px of tolerance for browser
  // reflow rounding). Critically, NOT zero.
  expect(after).toBeGreaterThan(40);
  expect(Math.abs(after - before)).toBeLessThan(50);
});
