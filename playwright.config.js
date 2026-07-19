// Playwright config for AdBrain dashboard e2e tests.
//
// Each spec spins up its OWN manager instance on a random port with a
// temp DB (see e2e/helpers.js), so specs are hermetic and parallelizable.
// We deliberately do NOT declare a webServer in this config — global
// webServer would force every spec to share one instance, which
// contaminates DB state across tests. Per-spec setup gives isolation
// with the small extra cost of one server boot per spec (~200ms).

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Node's TCP+SQLite startup on Windows is ~200ms per spec. 30s ceiling
  // keeps flaky-network dashboard polls from silently timing out mid-test.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Serial in CI-style runs; parallel workers just to catch shared-state
  // regressions on developer machines. cap at 2 so slow SQLite boots
  // don't thrash the disk.
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['line']] : [['list']],
  use: {
    trace: 'retain-on-failure',
    // Dashboard has 2s polls; give handlers a beat to settle before assertions.
    actionTimeout: 5_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
