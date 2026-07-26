// Loads the real dashboard and fails on ANY page exception or console error.
//
// app.js is ~15k lines and is edited far more often than it is exercised;
// the regression suite only string-matches it. A syntax-valid file can still
// throw on first render — a missing helper, a bad template literal, an
// undefined field on a row — and nothing else in the suite would notice.
// This is the cheapest guard against shipping a dashboard that renders blank.
import { test, expect } from '@playwright/test';
import { startManager, post } from './helpers.js';

let mgr;

test.beforeAll(async () => {
  mgr = await startManager();
  // Seed real data so the render paths that touch rows actually execute
  // instead of short-circuiting on an empty batch.
  await post(mgr.baseUrl, '/api/jobs/upload', {
    batchId: 'smoke-batch',
    products: [{ sku: 'SMOKE1', url: 'https://dropy.in/products/smoke-1' }],
  });
  await post(mgr.baseUrl, '/api/keywords', {
    batchId: 'smoke-batch',
    rows: [{ keyword: 'साड़ी smoke test', product_url: 'https://dropy.in/products/smoke-1', sku: 'SMOKE1' }],
  });
});

test.afterAll(async () => { await mgr?.stop(); });

// The dashboard reads its token from localStorage; without it every request
// 401s and we would be asserting against the logged-out banner rather than
// the real UI.
async function openDashboard(page) {
  await page.addInitScript(t => localStorage.setItem('adbrainManagerToken', t), mgr.token);
  await page.goto(mgr.baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);   // let the first refresh cycle finish
}

test('dashboard renders with no page exceptions or failed requests', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await openDashboard(page);

  // A blank page with no errors must not pass.
  await expect(page.locator('.tabs')).toBeVisible();
  expect(errors.join('\n')).toBe('');
});

test('every tab opens without throwing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await openDashboard(page);

  const tabs = page.locator('.tab');
  const n = await tabs.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(500);
  }
  expect(errors.join('\n')).toBe('');
});

test('output panel renders the per-SKU Rounds column', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await openDashboard(page);

  // The batch picker lives in #panel-dashboard, which is not the tab shown
  // on load — the select exists in the DOM but is hidden until that tab is
  // active, so it must be opened before anything below will work.
  await page.locator('.tab[data-tab="dashboard"]').click();
  await page.waitForTimeout(1500);

  // The output panel only renders once a batch is selected — on first load
  // it shows a "pick a batch" prompt, so selecting is required to exercise
  // the row template at all.
  const sel = page.locator('#dashBatchSelect');
  await expect(sel).toBeVisible();
  await sel.selectOption('smoke-batch');
  await page.waitForTimeout(2500);

  // The round strip is new; confirm the column reaches the DOM rather than
  // silently throwing inside the row template.
  await expect(page.locator('th', { hasText: 'Rounds' }).first()).toBeVisible();
  expect(errors.join('\n')).toBe('');
});
