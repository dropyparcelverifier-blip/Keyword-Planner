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

// ── Second migration wave: workers / keywords / batches ────────────────
// These 17 endpoints moved out of the if-ladder in the same pass that
// added routes/workers.js, routes/keywords.js and routes/batches.js.
// Behaviour, not string presence: the earlier string-match assertions for
// two of these broke on a pure file move even though the endpoints worked.

test('workers roster: heartbeat registers, list reports it', async () => {
  const wid = `PC-E2E-${Date.now().toString(16).slice(-6)}`;
  const hb = await post(mgr.baseUrl, '/api/workers/heartbeat', {
    workerId: wid, hostname: 'E2E-BOX', mac: 'AA:BB:CC:DD:EE:FF',
  });
  expect(hb.ok).toBe(true);
  expect(typeof hb.current_bundle_hash).toBe('string');

  const list = await get(mgr.baseUrl, '/api/workers/list');
  expect(list.ok).toBe(true);
  const mine = list.workers.find(w => w.worker_id === wid);
  expect(mine).toBeTruthy();
  expect(mine.hostname).toBe('E2E-BOX');
});

test('workers heartbeat rejects a missing workerId', async () => {
  const r = await post(mgr.baseUrl, '/api/workers/heartbeat', {});
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/workerId required/i);
});

test('workers set-mac validates the MAC before storing it', async () => {
  const wid = `PC-MAC-${Date.now().toString(16).slice(-6)}`;
  await post(mgr.baseUrl, '/api/workers/heartbeat', { workerId: wid });
  const bad = await post(mgr.baseUrl, '/api/workers/set-mac', { workerId: wid, mac: 'nope' });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/12 hex/i);
  const good = await post(mgr.baseUrl, '/api/workers/set-mac', { workerId: wid, mac: '11:22:33:44:55:66' });
  expect(good.ok).toBe(true);
  expect(good.mac).toBe('112233445566');
});

test('workers delete + prune-stale are routed and return counts', async () => {
  const wid = `PC-DEL-${Date.now().toString(16).slice(-6)}`;
  await post(mgr.baseUrl, '/api/workers/heartbeat', { workerId: wid });
  const del = await post(mgr.baseUrl, '/api/workers/delete', { workerId: wid });
  expect(del.ok).toBe(true);
  expect(del.deleted).toBe(1);

  const prune = await post(mgr.baseUrl, '/api/workers/prune-stale', { olderThanMinutes: 999999 });
  expect(prune.ok).toBe(true);
  expect(typeof prune.deleted).toBe('number');
});

test('workers quiesce broadcasts pause and reports in-flight', async () => {
  const r = await post(mgr.baseUrl, '/api/workers/quiesce', {});
  expect(r.ok).toBe(true);
  expect(typeof r.activeWorkers).toBe('number');
  expect(typeof r.claimedNow).toBe('number');
  const cmds = await get(mgr.baseUrl, '/api/commands?workerId=PC-ANY');
  expect(cmds.commands.some(c => c.command === 'pause')).toBe(true);
});

test('keywords push is rejected for a batch that has no jobs', async () => {
  // The orphan-batch guard is the reason this endpoint exists in this shape.
  const r = await post(mgr.baseUrl, '/api/keywords', {
    batchId: 'no-such-batch',
    rows: [{ keyword: 'x', product_url: 'https://dropy.in/p/1', sku: 'S1' }],
  });
  expect(r.ok).toBe(true);
  expect(r.inserted).toBe(0);
  expect(r.rejected).toBe(1);
});

test('keywords roundtrip: upload a job, push rows, read them back', async () => {
  const batchId = `kw-${Date.now()}`;
  const url = `https://dropy.in/products/e2e-${Date.now()}`;
  await post(mgr.baseUrl, '/api/jobs/upload', { batchId, products: [{ sku: 'E2E1', url }] });

  const push = await post(mgr.baseUrl, '/api/keywords', {
    batchId,
    // Non-ASCII on purpose: this is the payload shape that used to be
    // corrupted by string-concat body accumulation.
    rows: [{ keyword: 'साड़ी ऑनलाइन', product_url: url, sku: 'E2E1' }],
  });
  expect(push.ok).toBe(true);
  expect(push.inserted).toBe(1);

  const read = await get(mgr.baseUrl, `/api/keywords?batchId=${encodeURIComponent(batchId)}`);
  expect(read.ok).toBe(true);
  expect(read.total).toBe(1);
  expect(read.rows[0].keyword).toBe('साड़ी ऑनलाइन');
});

test('keywords timeline returns hourly buckets keyed by n', async () => {
  const r = await get(mgr.baseUrl, '/api/keywords/timeline');
  expect(r.ok).toBe(true);
  expect(Array.isArray(r.buckets)).toBe(true);
  // The dashboard hero reads b.n — it read b.count for a while and silently
  // rendered zero throughput.
  for (const b of r.buckets) expect(typeof b.n).toBe('number');
});

test('keywords cleanup-orphans refuses without the confirm string', async () => {
  const r = await post(mgr.baseUrl, '/api/keywords/cleanup-orphans', {});
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/confirm/i);
});

test('batch rename sets, renames and clears the display name', async () => {
  const batchId = `rn-${Date.now()}`;
  expect((await post(mgr.baseUrl, '/api/batches/rename', { batchId, name: 'Diwali drop' })).ok).toBe(true);
  let names = await get(mgr.baseUrl, '/api/batches/names');
  expect(names.names.find(n => n.batch_id === batchId)?.display_name).toBe('Diwali drop');

  // Empty name clears the overlay.
  expect((await post(mgr.baseUrl, '/api/batches/rename', { batchId, name: '' })).cleared).toBe(true);
  names = await get(mgr.baseUrl, '/api/batches/names');
  expect(names.names.find(n => n.batch_id === batchId)).toBeFalsy();

  const tooLong = await post(mgr.baseUrl, '/api/batches/rename', { batchId, name: 'x'.repeat(101) });
  expect(tooLong.ok).toBe(false);
});

test('batch readiness classifies an empty batch and a pending one', async () => {
  const missing = await get(mgr.baseUrl, '/api/batches/readiness?batchId=does-not-exist');
  expect(missing.ok).toBe(true);
  expect(missing.status).toBe('EMPTY');

  const batchId = `rd-${Date.now()}`;
  await post(mgr.baseUrl, '/api/jobs/upload', {
    batchId, products: [{ sku: 'R1', url: `https://dropy.in/products/rd-${Date.now()}` }],
  });
  const r = await get(mgr.baseUrl, `/api/batches/readiness?batchId=${encodeURIComponent(batchId)}`);
  expect(r.ok).toBe(true);
  expect(r.status).toBe('IN_PROGRESS');
  expect(r.metrics.pending).toBe(1);
});

test('batch eta degrades gracefully instead of erroring', async () => {
  expect((await get(mgr.baseUrl, '/api/batches/eta')).ok).toBe(false); // no batchId
  const r = await get(mgr.baseUrl, '/api/batches/eta?batchId=does-not-exist');
  expect(r.ok).toBe(true);
  expect(r.eta_minutes).toBe(null);
  expect(typeof r.reason).toBe('string');
});
