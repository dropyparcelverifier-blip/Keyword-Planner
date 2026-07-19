// Behavior test: the Fleet card's '📋 Copy install command' button
// actually copies the right one-liner to the clipboard. The string-match
// regression test only verified the button element + handler existed —
// this drives an actual click and reads what the browser wrote to the
// clipboard, which is what we care about.

import { test, expect } from '@playwright/test';
import { startManager, bootstrapDashboardAuth } from './helpers.js';

let mgr;
test.beforeAll(async () => { mgr = await startManager(); });
test.afterAll(async () => { await mgr?.stop(); });

test('Copy install command writes irm one-liner to clipboard', async ({ page, context }) => {
  // Grant clipboard permission BEFORE the page loads. Chromium blocks
  // navigator.clipboard.writeText() from an untrusted origin otherwise.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: mgr.baseUrl });
  await bootstrapDashboardAuth(page, mgr.token);

  await page.goto(mgr.baseUrl);
  // Dashboard boots on the Upload tab; Fleet card lives on the Dashboard
  // tab. Switch to it so the button becomes visible.
  await page.click('button.tab[data-tab="dashboard"]');
  const btn = page.locator('#copyInstallCmdBtn');
  await expect(btn).toBeVisible();

  await btn.click();

  // The button copies location.origin + install-worker.ps1 with 'irm |
  // iex' wrapping. Verify by reading the clipboard the browser now holds.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`irm ${mgr.baseUrl}/install-worker.ps1 | iex`);
});
