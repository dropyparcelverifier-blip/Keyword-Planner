// Regression test for the route-registry migration. All 16 endpoints
// that moved from server.js's if-ladder into routes/*.js modules must
// still respond correctly. Hits them via HTTP the same way the extension
// + dashboard do, so if any handler wiring broke on the way out, this
// catches it — string-match tests can't.

import { test, expect } from '@playwright/test';
import { startManager, get, post } from './helpers.js';

let mgr;
test.beforeAll(async () => { mgr = await startManager(); });
test.afterAll(async () => { await mgr?.stop(); });

test('health endpoint returns ok + timestamp', async () => {
  const r = await get(mgr.baseUrl, '/api/health');
  expect(r.ok).toBe(true);
  expect(typeof r.ts).toBe('number');
  expect(r.ts).toBeGreaterThan(Date.now() - 10_000);
});

test('manager/version returns a shape the topbar can render', async () => {
  const r = await get(mgr.baseUrl, '/api/manager/version');
  expect(r.ok).toBe(true);
  // Either real git info or the '(no git)' fallback — either way the
  // topbar expects a string commit field.
  expect(typeof r.commit).toBe('string');
  expect(r.commit.length).toBeGreaterThan(0);
});

test('activity roundtrip: insert then list, then filter by level', async () => {
  const marker = `router-mig-${Date.now()}`;
  await post(mgr.baseUrl, '/api/activity', {
    batchId: 'rmig', workerId: 'PC-Z', level: 'err', source: 'engine', message: marker,
  });
  const listed = await get(mgr.baseUrl, '/api/activity?limit=50');
  expect(listed.ok).toBe(true);
  expect(listed.events.some(e => e.message === marker)).toBe(true);

  const errsOnly = await get(mgr.baseUrl, '/api/activity?level=err&limit=50');
  expect(errsOnly.ok).toBe(true);
  expect(errsOnly.events.every(e => e.level === 'err')).toBe(true);
});

test('activity/clear with worker filter deletes only matching rows', async () => {
  // Two workers, two rows each.
  await post(mgr.baseUrl, '/api/activity', { batchId: 'clr', workerId: 'PC-DEL', level: 'info', message: 'x1' });
  await post(mgr.baseUrl, '/api/activity', { batchId: 'clr', workerId: 'PC-DEL', level: 'info', message: 'x2' });
  await post(mgr.baseUrl, '/api/activity', { batchId: 'clr', workerId: 'PC-KEEP', level: 'info', message: 'y1' });

  const cleared = await post(mgr.baseUrl, '/api/activity/clear', { workerId: 'PC-DEL' });
  expect(cleared.ok).toBe(true);
  expect(cleared.deleted).toBeGreaterThanOrEqual(2);

  const after = await get(mgr.baseUrl, '/api/activity?workerId=PC-KEEP&limit=50');
  // PC-KEEP row must survive.
  expect(after.events.some(e => e.message === 'y1')).toBe(true);
});

test('commands bus: insert, list, ack — all migrated together', async () => {
  const ins = await post(mgr.baseUrl, '/api/commands', {
    workerId: 'PC-Q', command: 'ping', payload: { note: 'e2e' }, createdBy: 'router-test',
  });
  expect(ins.ok).toBe(true);

  const listed = await get(mgr.baseUrl, '/api/commands?workerId=PC-Q');
  expect(listed.ok).toBe(true);
  const cmd = listed.commands.find(c => c.command === 'ping');
  expect(cmd).toBeTruthy();
  expect(cmd.payload).toEqual({ note: 'e2e' });

  const acked = await post(mgr.baseUrl, '/api/commands/ack', { workerId: 'PC-Q', ids: [cmd.id] });
  expect(acked.ok).toBe(true);
  const after = await get(mgr.baseUrl, '/api/commands?workerId=PC-Q');
  expect(after.commands.find(c => c.id === cmd.id)).toBeFalsy();
});

test('config GET/POST + configPatch merge semantics survive migration', async () => {
  await post(mgr.baseUrl, '/api/config', { config: { a: 1, b: 2 } });
  let cfg = await get(mgr.baseUrl, '/api/config');
  expect(cfg.config).toEqual({ a: 1, b: 2 });

  // Patch merges, and null deletes a key.
  await post(mgr.baseUrl, '/api/config', { configPatch: { c: 3, a: null } });
  cfg = await get(mgr.baseUrl, '/api/config');
  expect(cfg.config).toEqual({ b: 2, c: 3 });

  await post(mgr.baseUrl, '/api/config', { activeBatchId: 'test-batch' });
  cfg = await get(mgr.baseUrl, '/api/config');
  expect(cfg.active_batch_id).toBe('test-batch');
});

test('destructive endpoints refuse without confirm token', async () => {
  const noWipe  = await post(mgr.baseUrl, '/api/wipe-selective', { flags: { jobs: true } });
  const noReset = await post(mgr.baseUrl, '/api/reset-all', {});
  expect(noWipe.ok).toBe(false);
  expect(noReset.ok).toBe(false);
  expect(noWipe.error).toMatch(/confirm/i);
  expect(noReset.error).toMatch(/confirm/i);
});

test('backups list works even before any snapshots exist', async () => {
  const r = await get(mgr.baseUrl, '/api/backups/list');
  expect(r.ok).toBe(true);
  expect(Array.isArray(r.backups)).toBe(true);
  expect(typeof r.keepN).toBe('number');
});
