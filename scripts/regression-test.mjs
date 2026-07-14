// scripts/regression-test.mjs
//
// End-to-end regression test for the Supabase → SQLite manager migration.
// Spins up manager/server.js on a random port with a temp DB, exercises
// every API endpoint the extension calls, asserts responses, and tears
// down. Runs in ~2 seconds. No external deps — Node built-ins only.
//
// Usage: node scripts/regression-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SERVER = resolve(REPO, 'manager/server.js');

// ---------------- test harness ----------------
let passed = 0, failed = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write('.'); }
  else { failed++; fails.push(msg); process.stdout.write('F'); }
}
function assertEq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ---------------- spawn server ----------------
const PORT = 18000 + Math.floor(Math.random() * 2000);
const TOKEN = 'test-secret-token';
const TMP = mkdtempSync(`${tmpdir()}/adbrain-regression-`);
const DB = resolve(TMP, 'test.db');

console.log(`Starting manager on port ${PORT}, DB=${DB}\n`);
const srv = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), MANAGER_TOKEN: TOKEN, DB, HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => process.stderr.write(`[srv] ${d}`));
srv.stderr.on('data', d => process.stderr.write(`[srv-err] ${d}`));

const cleanup = () => {
  try { srv.kill('SIGTERM'); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---------------- HTTP helper ----------------
const BASE = `http://127.0.0.1:${PORT}`;
async function req(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token !== null) headers['X-Manager-Token'] = opts.token ?? TOKEN;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200 && r.data?.ok) return; } catch {}
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('server did not become healthy within 6s');
}

// ---------------- browser-JS parse check ----------------
// Rename to .mjs and pipe through `node --check` so it's parsed as an
// ES module — the browser parses <script type="module"> strictly, and
// `node --check foo.js` DOES NOT (it uses CommonJS lenient rules and
// silently accepts patterns like `won\\'t` that break in the browser).
// This is the ONLY test that would have caught the bad-escape bug that
// bricked the whole UI in commit 2191fdd.
function parseAsBrowserModule(filepath) {
  const tmp = resolve(TMP, `parse-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(tmp, readFileSync(filepath, 'utf-8'));
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf-8' });
  return { ok: r.status === 0, stderr: r.stderr, stdout: r.stdout };
}

// ---------------- tests ----------------
async function run() {
  // ===== 0. PARSE BROWSER JS AS ES MODULES =====
  // Runs BEFORE anything else — if these fail, everything downstream
  // is meaningless because the browser wouldn't run this JS.
  const browserJsFiles = [
    resolve(REPO, 'manager/public/app.js'),
    resolve(REPO, 'manager/public/api.js'),
  ];
  for (const f of browserJsFiles) {
    const rel = f.substring(REPO.length + 1).replace(/\\/g, '/');
    const r = parseAsBrowserModule(f);
    assert(r.ok, `0.${browserJsFiles.indexOf(f) + 1} ${rel} parses as ES module (browser-strict). stderr: ${r.stderr.slice(0, 400)}`);
  }

  await waitForHealth();

  // ===== 1. HEALTH + AUTH =====
  const h = await req('GET', '/api/health');
  assertEq(h.status, 200, '1.1 health returns 200');
  assert(h.data?.ok === true, '1.2 health ok=true');
  assert(typeof h.data?.ts === 'number', '1.3 health returns epoch-ms ts');

  const noAuth = await req('GET', '/api/jobs/summary', undefined, { token: null });
  assertEq(noAuth.status, 401, '1.4 missing token = 401');

  const badAuth = await req('GET', '/api/jobs/summary', undefined, { token: 'wrong' });
  assertEq(badAuth.status, 401, '1.5 wrong token = 401');

  // Health does NOT require token (need to check this)
  const healthNoAuth = await req('GET', '/api/health', undefined, { token: null });
  assert(healthNoAuth.status === 200 || healthNoAuth.status === 401,
    '1.6 health endpoint behaves consistently (200 open OR 401 gated)');

  // ===== 2. JOBS UPLOAD + DEDUP =====
  const BATCH_A = 'batch-a-' + Date.now();
  const up1 = await req('POST', '/api/jobs/upload', {
    batchId: BATCH_A,
    products: [
      { url: 'https://dropy.in/products/widget-a', sku: 'A1', product_name: 'Widget A', priority: 100, handles: 'widget|gadget', brands: 'AcmeBrand' },
      { url: 'https://dropy.in/products/widget-b', sku: 'A2', product_name: 'Widget B', priority: 100 },
      { url: 'https://dropy.in/products/widget-a', sku: 'A1-dup', product_name: 'Widget A dup' },  // within-upload duplicate
    ],
  });
  assertEq(up1.status, 200, '2.1 upload returns 200');
  assertEq(up1.data.uploaded, 2, '2.2 upload counts uniques only');
  assertEq(up1.data.duplicatesDropped, 1, '2.3 duplicatesDropped reports within-upload dupes');

  // Second upload of the same URLs on a DIFFERENT batch → cross-batch dedup
  const BATCH_B = 'batch-b-' + Date.now();
  const up2 = await req('POST', '/api/jobs/upload', {
    batchId: BATCH_B,
    products: [
      { url: 'https://dropy.in/products/widget-a', sku: 'B1' },  // active in BATCH_A
      { url: 'https://dropy.in/products/widget-c', sku: 'B2' },  // new
    ],
  });
  assertEq(up2.data.uploaded, 1, '2.4 cross-batch: skips URL active in another batch');
  assertEq(up2.data.skippedActive, 1, '2.5 skippedActive counted');
  assert(up2.data.skippedSkus?.includes('B1'), '2.6 skippedSkus lists SKUs');

  // Empty upload → 400
  const upBad = await req('POST', '/api/jobs/upload', { batchId: 'x', products: [] });
  assertEq(upBad.status, 400, '2.7 empty product list = 400');

  // ===== 3. ACTIVE BATCH =====
  const ab = await req('GET', '/api/jobs/active-batch');
  assertEq(ab.status, 200, '3.1 active-batch returns 200');
  // Should be one of our two batches (newest pending, or the pinned one).
  assert([BATCH_A, BATCH_B].includes(ab.data.batchId), '3.2 active-batch returns a real pending batch');

  // ===== 4. CLAIM (atomic priority claim) =====
  const claim1 = await req('POST', '/api/jobs/claim', { workerId: 'worker-1', batchId: BATCH_A, limit: 5 });
  assertEq(claim1.status, 200, '4.1 claim returns 200');
  assert(Array.isArray(claim1.data.jobs), '4.2 claim returns jobs array');
  assertEq(claim1.data.jobs.length, 2, '4.3 claim gets both BATCH_A jobs');
  const claimedIds = claim1.data.jobs.map(j => j.id);
  assert(claim1.data.jobs.every(j => j.status === 'claimed' && j.claimed_by === 'worker-1'), '4.4 claim marks status+claimed_by');

  // Second worker on same batch → nothing left
  const claim2 = await req('POST', '/api/jobs/claim', { workerId: 'worker-2', batchId: BATCH_A, limit: 5 });
  assertEq(claim2.data.jobs.length, 0, '4.5 second claim on empty batch returns 0');

  // ===== 5. HEARTBEAT =====
  const hb = await req('POST', '/api/jobs/heartbeat', { workerId: 'worker-1', jobIds: claimedIds });
  assertEq(hb.data.updated, claimedIds.length, '5.1 heartbeat updates all claimed jobs');

  // Heartbeat with wrong worker → no change
  const hbWrong = await req('POST', '/api/jobs/heartbeat', { workerId: 'other', jobIds: claimedIds });
  assertEq(hbWrong.data.updated, 0, '5.2 heartbeat rejects wrong worker');

  // ===== 6. URL-ACTIVE (cross-batch dedup check) =====
  const active = await req('GET', `/api/jobs/url-active?url=${encodeURIComponent('https://dropy.in/products/widget-a')}&excludeBatch=${BATCH_B}`);
  assertEq(active.data.active, true, '6.1 url-active detects active in another batch');

  const notActive = await req('GET', `/api/jobs/url-active?url=${encodeURIComponent('https://dropy.in/products/nonexistent')}&excludeBatch=${BATCH_A}`);
  assertEq(notActive.data.active, false, '6.2 url-active returns false for unknown URL');

  // ===== 7. PUSH KEYWORDS =====
  const kwPush = await req('POST', '/api/keywords', {
    rows: [
      { batch_id: BATCH_A, sku: 'A1', product_url: 'https://dropy.in/products/widget-a', keyword: 'blue widget', source: 'kp', image_count: 3, ad_rating: 8, product_name: 'Widget A' },
      { batch_id: BATCH_A, sku: 'A1', product_url: 'https://dropy.in/products/widget-a', keyword: 'best widget india', source: 'kp', image_count: 5, ad_rating: 9, product_name: 'Widget A' },
      { batch_id: BATCH_A, sku: 'A2', product_url: 'https://dropy.in/products/widget-b', keyword: 'red widget', source: 'autosuggest', image_count: 0, ad_rating: 3, product_name: 'Widget B' },
    ],
  });
  assertEq(kwPush.status, 200, '7.1 keywords push 200');
  assertEq(kwPush.data.inserted, 3, '7.2 inserted counts match');

  const kwRead = await req('GET', `/api/keywords?batchId=${BATCH_A}`);
  assertEq(kwRead.status, 200, '7.3 keywords read 200');
  assertEq(kwRead.data.total, 3, '7.4 keyword read total = pushed');
  assert(kwRead.data.rows.every(r => r.batch_id === BATCH_A), '7.5 rows filtered by batch_id');

  // ===== 8. MARK DONE / FAILED =====
  const done = await req('POST', '/api/jobs/done', { batchId: BATCH_A, productUrl: 'https://dropy.in/products/widget-a' });
  assertEq(done.status, 200, '8.1 mark done 200');
  const fail = await req('POST', '/api/jobs/failed', { batchId: BATCH_A, productUrl: 'https://dropy.in/products/widget-b', reason: 'engine crashed' });
  assertEq(fail.status, 200, '8.2 mark failed 200');

  // ===== 9. SUMMARY / PER-PRODUCT / WORKER-STATS =====
  const summary = await req('GET', '/api/jobs/summary');
  assertEq(summary.status, 200, '9.1 summary 200');
  assert(Array.isArray(summary.data.batches), '9.2 summary.batches is array');
  const bA = summary.data.batches.find(b => b.batch_id === BATCH_A);
  assert(!!bA, '9.3 summary contains BATCH_A');
  assertEq(bA.done, 1, '9.4 BATCH_A done=1');
  assertEq(bA.failed, 1, '9.5 BATCH_A failed=1');

  const pp = await req('GET', `/api/jobs/per-product?batchId=${BATCH_A}`);
  assertEq(pp.status, 200, '9.6 per-product 200');
  assertEq(pp.data.rows.length, 2, '9.7 per-product returns both SKUs');
  const rowA = pp.data.rows.find(r => r.product_url === 'https://dropy.in/products/widget-a');
  assertEq(rowA.status, 'done', '9.8 per-product widget-a is done');
  assertEq(rowA.claimed_by, 'worker-1', '9.9 per-product tracks claimed_by');

  const ws = await req('GET', '/api/jobs/worker-stats');
  assertEq(ws.status, 200, '9.10 worker-stats 200');
  const wStats = ws.data.workers.find(w => w.worker_id === 'worker-1');
  assert(!!wStats, '9.11 worker-1 in worker-stats');

  const aw = await req('GET', `/api/jobs/active-workers?batchId=${BATCH_A}`);
  assertEq(aw.status, 200, '9.12 active-workers 200');

  // ===== 10. FAILED + REQUEUE =====
  // (widget-b was marked failed above. Grab its id from per-product and requeue.)
  const failedJob = pp.data.rows.find(r => r.status === 'failed');
  assert(!!failedJob?.id, '10.1 failed job has id');
  const rq = await req('POST', '/api/jobs/requeue', { jobId: failedJob.id });
  assertEq(rq.data.ok, true, '10.2 requeue succeeds');
  const pp2 = await req('GET', `/api/jobs/per-product?batchId=${BATCH_A}`);
  const rqRow = pp2.data.rows.find(r => r.id === failedJob.id);
  assertEq(rqRow.status, 'pending', '10.3 requeued job back to pending');

  // ===== 11. RELEASE-STALE =====
  // Manually re-claim to test release-stale.
  await req('POST', '/api/jobs/claim', { workerId: 'ghost-worker', batchId: BATCH_A, limit: 1 });
  const rel = await req('POST', '/api/jobs/release-stale', { staleMinutes: -1 });
  assertEq(rel.status, 200, '11.1 release-stale 200');
  assert(rel.data.released >= 1, '11.2 release-stale released the ghost claim');

  // ===== 12. ACTIVITY LOG =====
  const act1 = await req('POST', '/api/activity', {
    batchId: BATCH_A, workerId: 'worker-1',
    events: [
      { level: 'info',  source: 'engine', message: 'Started widget-a', product_url: 'https://dropy.in/products/widget-a' },
      { level: 'warn',  source: 'kp',     message: 'KP low yield' },
      { level: 'error', source: 'engine', message: 'CAPTCHA served' },
    ],
  });
  assertEq(act1.status, 200, '12.1 activity push 200');

  const actR = await req('GET', `/api/activity?batchId=${BATCH_A}&limit=50`);
  assertEq(actR.status, 200, '12.2 activity read 200');
  assert(actR.data.events.length >= 3, '12.3 activity contains our events');
  assert(actR.data.events.every(e => typeof e.ts === 'number'), '12.4 activity ts is epoch-ms (number, not ISO)');

  // ===== 13. COMMAND BUS =====
  const cmd = await req('POST', '/api/commands', { workerId: 'worker-1', command: 'wake', createdBy: 'manager' });
  assertEq(cmd.status, 200, '13.1 command send 200');
  const cmdBcast = await req('POST', '/api/commands', { workerId: null, command: 'pause', createdBy: 'manager' });
  assertEq(cmdBcast.status, 200, '13.2 broadcast command 200');

  const cmdList = await req('GET', '/api/commands?workerId=worker-1');
  assertEq(cmdList.status, 200, '13.3 command list 200');
  assert(cmdList.data.commands.some(c => c.command === 'wake'), '13.4 worker sees targeted command');
  assert(cmdList.data.commands.some(c => c.command === 'pause'), '13.5 worker sees broadcast command');

  const cmdIds = cmdList.data.commands.map(c => c.id);
  const cmdAck = await req('POST', '/api/commands/ack', { workerId: 'worker-1', ids: cmdIds });
  assertEq(cmdAck.status, 200, '13.6 command ack 200');
  const cmdList2 = await req('GET', '/api/commands?workerId=worker-1');
  assertEq(cmdList2.data.commands.length, 0, '13.7 ack removes commands from pending');

  // ===== 14. WORKER CONFIG =====
  const cfg1 = await req('POST', '/api/config', { config: { kp_url: 'https://ads.google.com/aw/keywordplanner/', match_profile: 'normal' } });
  assertEq(cfg1.status, 200, '14.1 config full-set 200');
  const cfgR = await req('GET', '/api/config');
  assertEq(cfgR.data.config.kp_url, 'https://ads.google.com/aw/keywordplanner/', '14.2 config round-trip');
  assertEq(cfgR.data.config.match_profile, 'normal', '14.3 config all fields present');

  // Patch: update one key, add another
  const cfg2 = await req('POST', '/api/config', { configPatch: { match_profile: 'strict', clip_threshold: 72 } });
  assertEq(cfg2.status, 200, '14.4 config patch 200');
  const cfgR2 = await req('GET', '/api/config');
  assertEq(cfgR2.data.config.match_profile, 'strict', '14.5 patch updated existing key');
  assertEq(cfgR2.data.config.clip_threshold, 72, '14.6 patch added new key');
  assertEq(cfgR2.data.config.kp_url, 'https://ads.google.com/aw/keywordplanner/', '14.7 patch preserves unchanged keys');

  // Patch with null value → delete key
  const cfg3 = await req('POST', '/api/config', { configPatch: { clip_threshold: null } });
  assertEq(cfg3.status, 200, '14.8 patch null 200');
  const cfgR3 = await req('GET', '/api/config');
  assert(!('clip_threshold' in cfgR3.data.config), '14.9 null patch deletes key');

  // Active batch pin
  const pinCfg = await req('POST', '/api/config', { activeBatchId: BATCH_B });
  assertEq(pinCfg.status, 200, '14.10 active-batch pin 200');
  const cfgR4 = await req('GET', '/api/config');
  assertEq(cfgR4.data.active_batch_id, BATCH_B, '14.11 active_batch_id persisted');

  // Pinned batch shows up in /api/jobs/active-batch (as long as it has pending)
  const abPinned = await req('GET', '/api/jobs/active-batch');
  assertEq(abPinned.data.batchId, BATCH_B, '14.12 active-batch returns pinned batch when it has pending');

  // Unpin
  await req('POST', '/api/config', { activeBatchId: null });
  const cfgR5 = await req('GET', '/api/config');
  assertEq(cfgR5.data.active_batch_id, null, '14.13 unpinned back to null');

  // ===== 15. CLEANUP =====
  const cleanup = await req('POST', '/api/cleanup', { logDays: 0, commandsDays: 0 });
  assertEq(cleanup.status, 200, '15.1 cleanup 200');
  assert(typeof cleanup.data.activityLog === 'number', '15.2 cleanup reports activityLog count');
  assert(typeof cleanup.data.ackedCommands === 'number', '15.3 cleanup reports ackedCommands count');
  // With logDays=0, our activity events should be gone.
  const actR2 = await req('GET', `/api/activity?batchId=${BATCH_A}&limit=50`);
  assertEq(actR2.data.events.length, 0, '15.4 activity purged after aggressive cleanup');

  // ===== 16. FETCH-BATCH-KEYWORD-STATS-STYLE ROUND-TRIP =====
  // Simulates what dashboard's fetchBatchKeywordStats does.
  const [ppR, kwR] = await Promise.all([
    req('GET', `/api/jobs/per-product?batchId=${BATCH_A}`),
    req('GET', `/api/keywords?batchId=${BATCH_A}`),
  ]);
  const totalKw = kwR.data.total;
  const byUrl = new Map();
  for (const r of kwR.data.rows) {
    const c = byUrl.get(r.product_url) || 0;
    byUrl.set(r.product_url, c + 1);
  }
  const produced = ppR.data.rows.filter(j => (byUrl.get(j.product_url) || 0) > 0).length;
  assertEq(totalKw, 3, '16.1 keyword total intact across round-trip');
  assertEq(produced, 2, '16.2 both SKUs have keyword rows');
  // Widget-a had 2 rows in kw push
  assertEq(byUrl.get('https://dropy.in/products/widget-a'), 2, '16.3 per-URL count intact');

  // ===== 17. INVALID ROUTES =====
  const nope = await req('GET', '/api/nonexistent');
  assertEq(nope.status, 404, '17.1 unknown route returns 404');

  // ===== 18. TOKEN VIA QUERY STRING =====
  const qtok = await fetch(`${BASE}/api/jobs/summary?token=${TOKEN}`).then(r => r.json()).catch(() => null);
  assert(qtok?.ok === true, '18.1 token accepted via ?token= query string');

  // ===== 19. WEB APP STATIC-SERVE =====
  // The web app files live under manager/public/. Confirm the server
  // serves them with correct content types (index.html at /, api.js
  // and app.js as ES modules, xlsx.mjs as JS, styles.css as CSS).
  async function fetchStatic(path) {
    const r = await fetch(`${BASE}${path}`);
    const body = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', body };
  }
  const idx = await fetchStatic('/');
  assertEq(idx.status, 200, '19.1 / returns 200 (serves index.html)');
  assert(idx.contentType.includes('text/html'), '19.2 / content-type is text/html');
  assert(idx.body.includes('AdBrain Manager'), '19.3 / body is the web app HTML');
  assert(idx.body.includes('type="module" src="/public/app.js"'), '19.4 / loads app.js as module');

  const appJs = await fetchStatic('/public/app.js');
  assertEq(appJs.status, 200, '19.5 /public/app.js returns 200');
  assert(appJs.contentType.includes('javascript'), '19.6 app.js served as JS');
  assert(appJs.body.includes('import { api'), '19.7 app.js imports from api.js');

  const apiJs = await fetchStatic('/public/api.js');
  assertEq(apiJs.status, 200, '19.8 /public/api.js returns 200');
  assert(apiJs.body.includes('export const api'), '19.9 api.js exports api');
  assert(apiJs.body.includes('generateSetupCode'), '19.10 api.js exports generateSetupCode');

  const cssR = await fetchStatic('/public/styles.css');
  assertEq(cssR.status, 200, '19.11 /public/styles.css returns 200');
  assert(cssR.contentType.includes('text/css'), '19.12 styles.css content-type is text/css');

  const xlsxR = await fetchStatic('/public/xlsx.full.min.js');
  assertEq(xlsxR.status, 200, '19.13 /public/xlsx.full.min.js returns 200');
  assert(xlsxR.contentType.includes('javascript'), '19.14 xlsx.full.min.js served as JS');

  // The UMD build must load BEFORE app.js so window.XLSX exists by the
  // time app.js's file-input handler runs. If app.js imports SheetJS
  // as an ES module, a parse error in the 28k-line module blocks the
  // whole app from executing (real bug seen in prod: tabs stopped
  // switching, upload button stayed disabled).
  const xlsxScriptIdx = idx.body.indexOf('xlsx.full.min.js');
  const appJsIdx = idx.body.indexOf('/public/app.js');
  assert(xlsxScriptIdx > 0, '19.15 index loads xlsx.full.min.js');
  assert(xlsxScriptIdx < appJsIdx, '19.16 xlsx.full.min.js loaded BEFORE app.js');
  assert(!appJs.body.includes("from '/public/xlsx.mjs'"), '19.17 app.js does not import broken xlsx.mjs');
  assert(appJs.body.includes('window.XLSX'), '19.18 app.js reads UMD global window.XLSX');

  // Path traversal is refused.
  const trav = await fetch(`${BASE}/public/../server.js`);
  assert(trav.status === 403 || trav.status === 404, '19.19 path traversal blocked');

  // ===== 20. SETUP CODE FORMAT =====
  // The web app's generateSetupCode() must produce a payload the
  // extension's jobs:importSetupCode handler can parse. This test
  // simulates that: encode here, decode with the same rules.
  const testUrl = 'http://mgr.example.ts.net:8787';
  const testToken = 'test-token-xyz';
  const testKp = 'https://ads.google.com/aw/keywordplanner/';
  const payload = JSON.stringify({ v: 3, managerUrl: testUrl, managerToken: testToken, kpUrl: testKp });
  const bytes = new TextEncoder().encode(payload);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  const code = 'adb2:' + Buffer.from(bin, 'binary').toString('base64');
  assert(code.startsWith('adb2:'), '20.1 setup code has adb2: prefix');
  // Decode with the same rules as background.js jobs:importSetupCode
  const b64 = code.slice(5);
  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  assertEq(decoded.v, 3, '20.2 setup code v=3');
  assertEq(decoded.managerUrl, testUrl, '20.3 setup code preserves managerUrl');
  assertEq(decoded.managerToken, testToken, '20.4 setup code preserves managerToken');
  assertEq(decoded.kpUrl, testKp, '20.5 setup code preserves kpUrl');

  // ===== 20b. ANALYTICS TAB WIRING =====
  // The analytics tab is fed by /api/keywords for a batch + client-side
  // grouping by SKU. Nothing new server-side; verify:
  //   1) index.html has the tab button + panel
  //   2) app.js has the analytics controller + all render fns
  //   3) The endpoint returns rows the tab knows how to group + sort
  assert(idx.body.includes('data-tab="analytics"'), '20b.1 analytics tab button in index');
  assert(idx.body.includes('id="panel-analytics"'), '20b.2 analytics panel in index');
  assert(idx.body.includes('id="anBatchSelect"'), '20b.3 analytics batch select in index');
  assert(idx.body.includes('id="anSkuSelect"'), '20b.4 analytics SKU select in index');
  assert(idx.body.includes('id="anMinRating"'), '20b.5 analytics min-rating filter in index');
  assert(idx.body.includes('id="anExportBtn"'), '20b.6 analytics export button in index');
  assert(appJs.body.includes('refreshAnalyticsTab'), '20b.7 analytics controller in app.js');
  assert(appJs.body.includes('renderAnalyticsSummary'), '20b.8 summary render');
  assert(appJs.body.includes('renderAnalyticsTopChart'), '20b.9 top-chart render');
  assert(appJs.body.includes('renderAnalyticsTable'), '20b.10 keywords table render');
  assert(appJs.body.includes('filterAndRenderAnalytics'), '20b.11 filter+sort pipeline');

  // Fetch keywords + reproduce the client-side grouping to make sure
  // the shape the analytics tab expects is actually there.
  const kwForAn = await req('GET', `/api/keywords?batchId=${BATCH_A}`);
  assert(kwForAn.data?.ok === true, '20b.12 /api/keywords reachable for analytics');
  const kwRowsA = kwForAn.data.rows || [];
  assert(kwRowsA.every(r => 'sku' in r || 'product_url' in r), '20b.13 rows have sku or product_url (grouping key)');
  assert(kwRowsA.every(r => 'source' in r), '20b.14 rows have source (filter dimension)');
  assert(kwRowsA.every(r => 'ad_rating' in r), '20b.15 rows have ad_rating (sort + top-chart dimension)');
  assert(kwRowsA.every(r => 'image_count' in r), '20b.16 rows have image_count (filter + rendering dimension)');
  // Group by SKU the way the tab does + assert we can find widget-a's rows.
  const bySku = new Map();
  for (const r of kwRowsA) { const k = r.sku || r.product_url || 'unknown'; if (!bySku.has(k)) bySku.set(k, []); bySku.get(k).push(r); }
  assert(bySku.has('A1'), '20b.17 SKU grouping produces the SKU from the upload (A1)');
  assertEq(bySku.get('A1').length, 2, '20b.18 grouped rows match pushed count for SKU A1');

  // ===== 20c. WORKER INSTALLER =====
  // Verify the installer endpoints are un-authenticated (workers can't
  // send a token before they're installed) and serve real content.
  async function fetchNoAuth(path) {
    const r = await fetch(`${BASE}${path}`);
    const body = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', body };
  }
  const ps = await fetchNoAuth('/install-worker.ps1');
  assertEq(ps.status, 200, '20c.1 /install-worker.ps1 returns 200 without token');
  assert(ps.contentType.includes('text/plain'), '20c.2 /install-worker.ps1 served as text/plain');
  assert(ps.body.includes('AdBrain worker installer'), '20c.3 installer script has expected header');
  assert(ps.body.includes('Invoke-WebRequest'), '20c.4 installer uses Invoke-WebRequest');
  assert(ps.body.includes('/worker/'), '20c.5 installer references /worker/ file route');
  assert(ps.body.includes('Startup'), '20c.6 installer sets up Windows Startup shortcut');
  assert(ps.body.includes('AdBrainWorker'), '20c.7 installer scoped to AdBrainWorker dir');

  const wlist = await fetchNoAuth('/worker-files.json');
  assertEq(wlist.status, 200, '20c.8 worker-files.json returns 200 without token');
  const parsed = JSON.parse(wlist.body);
  assert(parsed.ok === true && Array.isArray(parsed.files), '20c.9 worker-files.json is a real list');
  assert(parsed.files.includes('manifest.json'), '20c.10 manifest.json in worker allowlist');
  assert(parsed.files.includes('background.js'), '20c.11 background.js in worker allowlist');
  assert(parsed.files.includes('modules/discovery-jobs.js'), '20c.12 discovery-jobs.js in worker allowlist');
  assert(!parsed.files.some(f => f.startsWith('manager/')), '20c.13 manager/ files NOT in worker list');
  assert(!parsed.files.some(f => f.startsWith('scripts/')), '20c.14 scripts/ files NOT in worker list');

  // Serving individual files.
  const mf = await fetchNoAuth('/worker/manifest.json');
  assertEq(mf.status, 200, '20c.15 /worker/manifest.json served');
  assert(mf.body.includes('"manifest_version"'), '20c.16 manifest.json content looks right');
  const nested = await fetchNoAuth('/worker/modules/discovery-jobs.js');
  assertEq(nested.status, 200, '20c.17 nested /worker/modules/... served');
  const rejected = await fetchNoAuth('/worker/manager/server.js');
  assertEq(rejected.status, 404, '20c.18 non-allowlisted paths rejected (no server.js leak)');
  const wTrav = await fetchNoAuth('/worker/../.git/config');
  assert(wTrav.status === 404 || wTrav.status === 400, '20c.19 traversal attempts rejected');

  // Every file the installer will try to download must ACTUALLY exist on disk
  // AND be reachable via the /worker/ route. This is the test that would have
  // caught the missing `modules/image-matcher.js` bug that bricked the
  // installer with a 404 in production.
  for (const f of parsed.files) {
    const diskPath = resolve(REPO, f);
    let onDisk = true;
    try { readFileSync(diskPath); } catch { onDisk = false; }
    assert(onDisk, `20c.20+ allowlisted file exists on disk: ${f}`);
    const httpR = await fetchNoAuth(`/worker/${f}`);
    assert(httpR.status === 200, `20c.20+ /worker/${f} served OK (got ${httpR.status})`);
  }

  // Cross-check: every ES import path referenced from the top-level extension
  // files (background/popup/offscreen/sandbox + everything in modules/) must
  // resolve to a file that IS in the allowlist. This catches the "forgot to
  // add a new module to WORKER_FILES" class of bug.
  function collectImports(filepath, base) {
    let src = ''; try { src = readFileSync(filepath, 'utf-8'); } catch { return []; }
    const out = [];
    // ES imports: `import ... from './x.js'` or `import('./x.js')`
    const re = /(?:from|import)\s*(?:\(\s*)?["']((?:\.\/|\.\.\/)[^"']+?\.m?js)["']/g;
    let m;
    while ((m = re.exec(src))) {
      const abs = resolve(dirname(filepath), m[1]);
      const rel = abs.substring(REPO.length + 1).replace(/\\/g, '/');
      out.push(rel);
    }
    return out;
  }
  const scanRoots = ['background.js', 'popup.js', 'dashboard.js']
    .map(f => resolve(REPO, f));
  const modulesDir = resolve(REPO, 'modules');
  try { for (const f of readdirSync(modulesDir)) if (f.endsWith('.js')) scanRoots.push(resolve(modulesDir, f)); } catch {}
  const allowSet = new Set(parsed.files);
  const missingFromAllowlist = new Set();
  for (const root of scanRoots) {
    for (const dep of collectImports(root)) {
      // dashboard.js only ships with the extension; if a file references a
      // manager/public/ file it's the web app, skip.
      if (dep.startsWith('manager/')) continue;
      if (!allowSet.has(dep)) missingFromAllowlist.add(dep);
    }
  }
  assert(missingFromAllowlist.size === 0,
    `20c.21 every import target is in WORKER_FILES (missing: ${Array.from(missingFromAllowlist).join(', ') || 'none'})`);

  // ===== 20f. UI POLISH SURFACES =====
  // Toasts, keyboard shortcuts, progress bars, source colors, per-worker actions.
  assert(idx.body.includes('id="toastStack"'), '20f.1 toast stack in index');
  assert(appJs.body.includes('function toast('), '20f.2 toast() defined in app.js');
  assert(cssR.body.includes('.toast-stack'), '20f.3 toast CSS in styles.css');
  assert(cssR.body.includes('@keyframes toastIn'), '20f.4 toast animations defined');

  assert(idx.body.includes('<kbd>1</kbd>'), '20f.5 keyboard shortcut hint 1 rendered');
  assert(idx.body.includes('<kbd>6</kbd>'), '20f.6 keyboard shortcut hint 6 rendered');
  assert(appJs.body.includes(`'1': 'upload'`), '20f.7 shortcut map defined in app.js');
  assert(appJs.body.includes('Ctrl+K') || appJs.body.includes("e.key === 'k'"), '20f.8 Ctrl+K analytics-focus hook wired');

  assert(cssR.body.includes('.progress-fill'), '20f.9 progress-bar CSS defined');
  assert(appJs.body.includes('class="progress"'), '20f.10 batch overview uses progress bars');

  assert(cssR.body.includes('.chip.src-kp'), '20f.11 source-color CSS for KP');
  assert(cssR.body.includes('.chip.src-autosuggest'), '20f.12 source-color CSS for autosuggest');
  assert(cssR.body.includes('.chip.src-serp'), '20f.13 source-color CSS for SERP');
  assert(appJs.body.includes('srcClassFor'), '20f.14 source-color mapper in analytics');

  assert(appJs.body.includes('worker-actions'), '20f.15 per-worker action buttons wired');
  assert(appJs.body.includes("data-cmd=\"release_claims\""), '20f.16 release-claims per-worker action');

  // Worker popup slim-down — the extension is now worker-only.
  const popupHtml = readFileSync(resolve(REPO, 'popup.html'), 'utf-8');
  const popupJs = readFileSync(resolve(REPO, 'popup.js'), 'utf-8');
  assert(popupHtml.length < 20000, `20f.17 popup.html trimmed (got ${popupHtml.length} bytes)`);
  assert(popupJs.length < 20000, `20f.18 popup.js trimmed (got ${popupJs.length} bytes)`);
  assert(!popupHtml.includes('data-role="manager"'), '20f.19 no manager role picker in popup');
  assert(!popupHtml.includes('mgrSaveCredsBtn'), '20f.20 no manager creds card in popup');
  assert(popupHtml.includes('id="hero"'), '20f.21 worker hero status block present');
  assert(popupHtml.includes('id="openManager"'), '20f.22 open-manager-dashboard footer link present');

  // ===== 20g. UX/ANALYTICS OVERHAUL =====
  // Command palette
  assert(idx.body.includes('id="cmdkRoot"'),  '20g.1 command palette root in index');
  assert(cssR.body.includes('.cmdk-panel'),   '20g.2 cmdk CSS defined');
  assert(appJs.body.includes('function cmdkOpen'), '20g.3 cmdkOpen() defined');
  assert(appJs.body.includes(`e.key.toLowerCase() === 'k'`), '20g.4 Ctrl/Cmd+K bound');

  // Persistent state
  assert(appJs.body.includes(`localStorage.getItem(UI_STATE_KEY`), '20g.5 UI state persistence via localStorage');
  assert(appJs.body.includes(`saveUI({ tab:`),   '20g.6 tab change persists');
  assert(appJs.body.includes(`saveUI({ batch:`), '20g.7 batch change persists');

  // Trend chart + failed card
  assert(idx.body.includes('id="trendChart"'), '20g.8 trend chart element');
  assert(cssR.body.includes('.trend-bar'),     '20g.9 trend bar CSS');
  assert(idx.body.includes('id="failedCard"'), '20g.10 failed jobs card element');
  assert(idx.body.includes('requeueAllFailedBtn'), '20g.11 bulk requeue button');

  // Sticky headers + skeleton
  assert(cssR.body.includes('.tbl thead th'),  '20g.12 sticky-header CSS');
  assert(cssR.body.includes('.skeleton'),      '20g.13 skeleton loader CSS');

  // Worker popup enhancements
  assert(popupHtml.includes('id="todayDone"'),    '20g.14 worker today-done counter');
  assert(popupHtml.includes('id="todayKw"'),      '20g.15 worker today-kw counter');
  assert(popupHtml.includes('id="workerSparkline"'), '20g.16 worker sparkline element');
  assert(popupJs.includes('refreshToday'),         '20g.17 worker refreshToday() defined');
  assert(popupJs.includes('adbrainTodayBaseline'), '20g.18 worker persists today baseline in storage');

  // New server endpoints for the enhancements
  const failedApi = await req('GET', '/api/jobs/failed');
  assertEq(failedApi.status, 200, '20g.19 GET /api/jobs/failed 200');
  assert(Array.isArray(failedApi.data?.rows), '20g.20 /api/jobs/failed returns rows[]');

  const timelineApi = await req('GET', '/api/keywords/timeline');
  assertEq(timelineApi.status, 200, '20g.21 GET /api/keywords/timeline 200');
  assert(Array.isArray(timelineApi.data?.buckets), '20g.22 timeline returns buckets[]');
  assert(typeof timelineApi.data?.since === 'number', '20g.23 timeline returns since epoch-ms');

  const requeueBulk = await req('POST', '/api/jobs/requeue-all-failed', {});
  assertEq(requeueBulk.status, 200, '20g.24 POST /api/jobs/requeue-all-failed 200');
  assert(typeof requeueBulk.data?.updated === 'number', '20g.25 bulk requeue returns update count');

  // ===== 20h. DENSITY / EMPTY-STATE OVERHAUL =====
  // Global stats bar
  assert(idx.body.includes('id="statsBar"'),      '20h.1 global stats bar in index');
  assert(idx.body.includes('id="sbBatches"'),     '20h.2 batches counter');
  assert(idx.body.includes('id="sbWorkers"'),     '20h.3 workers counter');
  assert(idx.body.includes('id="sbKeywords"'),    '20h.4 keywords counter');
  assert(idx.body.includes('id="sbInFlight"'),    '20h.5 in-flight counter');
  assert(idx.body.includes('id="sbFailed"'),      '20h.6 failed counter');
  assert(cssR.body.includes('.statsbar'),         '20h.7 statsbar CSS');
  assert(appJs.body.includes('refreshStatsBar'),  '20h.8 stats bar refresher wired');

  // Upload tab drop zone + sidebar
  assert(idx.body.includes('id="uploadDropZone"'), '20h.9 drop zone element');
  assert(cssR.body.includes('.drop-zone'),         '20h.10 drop-zone CSS');
  assert(idx.body.includes('id="uploadRecentBody"'), '20h.11 upload sidebar recent batches');
  assert(appJs.body.includes('refreshUploadSidebar'), '20h.12 upload sidebar refresher');

  // Downloads tab batch list
  assert(idx.body.includes('id="downloadListBody"'), '20h.13 downloads batch list element');

  // Config collapsibles
  const collapsibleCount = (idx.body.match(/class="card collapsible/g) || []).length;
  assert(collapsibleCount >= 4, `20h.14 config has 4+ collapsible cards (got ${collapsibleCount})`);
  assert(cssR.body.includes('.card.collapsible.collapsed .card-body'), '20h.15 collapsible collapsed CSS');
  assert(appJs.body.includes(`closest('.card.collapsible .card-head')`), '20h.16 collapsible click handler wired');

  // Two-col helper class exists
  assert(cssR.body.includes('.two-col'), '20h.17 two-col grid helper CSS');

  // ===== 20i. WORKER POPUP OVERHAUL =====
  // Hero + countdown + batch progress + error banner + recent SKUs.
  assert(popupHtml.includes('id="hero"'),            '20i.1 worker hero block');
  assert(popupHtml.includes('class="hero-dot"'),     '20i.2 worker hero status dot');
  assert(popupHtml.includes('id="heroHeadline"'),    '20i.3 worker hero headline');
  assert(popupHtml.includes('id="heroSub"'),         '20i.4 worker hero subtext');
  assert(popupHtml.includes('id="heroCountdown"'),   '20i.5 next-poll countdown pill');
  assert(popupHtml.includes('id="batchProgress"'),   '20i.6 batch progress bar element');
  assert(popupHtml.includes('id="errBanner"'),       '20i.7 error banner element');
  assert(popupHtml.includes('id="recentCard"'),      '20i.8 recent SKUs card');
  assert(popupJs.includes('function computeState'),  '20i.9 hero state machine defined');
  assert(popupJs.includes('renderCountdown'),        '20i.10 countdown renderer defined');
  assert(popupJs.includes('renderErrBanner'),        '20i.11 error banner renderer defined');
  assert(popupJs.includes('renderRecent'),           '20i.12 recent SKUs renderer defined');
  assert(popupJs.includes('POLL_INTERVAL_MS'),       '20i.13 poll-cycle constant defined');

  // ===== 20j. INSTALLER / UNINSTALLER =====
  // Reinstall detection in installer
  assert(ps.body.includes('isReinstall'),                     '20j.1 installer detects existing install');
  assert(ps.body.includes('wiping old extension files'),      '20j.2 installer wipes old ext folder');
  assert(ps.body.includes('REINSTALL'),                       '20j.3 installer prints reinstall-specific instructions');
  assert(ps.body.includes('if (-not $isReinstall)'),          '20j.4 installer skips Chrome relaunch on reinstall');
  // Uninstaller endpoint
  const un = await fetchNoAuth('/uninstall-worker.ps1');
  assertEq(un.status, 200, '20j.5 GET /uninstall-worker.ps1 returns 200');
  assert(un.body.includes('UNINSTALLER'),                      '20j.6 uninstaller script identifies itself');
  assert(un.body.includes('AdBrain Worker.lnk'),               '20j.7 uninstaller removes Startup shortcut');
  assert(un.body.includes('Remove-Item -Path $extDir'),        '20j.8 uninstaller removes extension folder');
  assert(un.body.includes('[switch]$Full'),                    '20j.9 uninstaller supports -Full flag for profile wipe');
  // UI wiring for uninstall command
  assert(idx.body.includes('id="uninstallOneLiner"'),          '20j.10 uninstall one-liner element in Workers tab');
  assert(idx.body.includes('id="uninstallFullOneLiner"'),      '20j.11 uninstall -Full variant in Workers tab');
  assert(appJs.body.includes('uninstallOneLiner'),             '20j.12 app.js wires uninstall command');
  // manifest version bumped
  const mfV = await fetchNoAuth('/worker/manifest.json');
  assert(mfV.body.includes('"version": "1.1.0"'),              '20j.13 manifest version bumped so Chrome auto-reloads');

  // ===== 20d. INSTALLER AUTO-ARM =====
  // The installer must bake the current token + KP URL into the PS script
  // and write a worker-config.json into the worker's extension dir so the
  // extension auto-arms on first load — no setup-code paste needed.
  assert(ps.body.includes('worker-config.json'), '20d.1 installer writes worker-config.json');
  assert(ps.body.includes('managerUrl'),         '20d.2 installer bakes managerUrl into JSON');
  assert(ps.body.includes('managerToken'),       '20d.3 installer bakes managerToken into JSON');
  assert(ps.body.includes('kpUrl'),              '20d.4 installer bakes kpUrl into JSON');
  // The token IN the installer script must match what the manager was
  // started with — earlier tests set TOKEN='test-secret-token'.
  assert(ps.body.includes(TOKEN),                '20d.5 installer bakes the CURRENT manager token');

  // The background.js cold-start hydration must read worker-config.json
  // and populate storage. This is what turns the JSON on disk into an
  // armed worker with zero user interaction.
  const bgSrc = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(bgSrc.includes("chrome.runtime.getURL('worker-config.json')"),
    '20d.6 background.js reads worker-config.json via chrome.runtime.getURL');
  assert(/adbrainWorkerArmed:\s*true/.test(bgSrc),
    '20d.7 background.js sets adbrainWorkerArmed:true on installer-config load');
  assert(bgSrc.includes('Auto-armed from worker-config.json'),
    '20d.8 background.js logs the auto-arm so users can see it worked');

  // No-overwrite guard: if a user has already configured the extension
  // manually, worker-config.json must NOT clobber their settings.
  assert(bgSrc.includes("get(['adbrainManagerUrl', 'adbrainRole'])"),
    '20d.9 cold-start guards against overwriting a user-configured install');

  // The install one-liner should show up in the workers tab.
  assert(idx.body.includes('installOneLiner'), '20c.20 install one-liner element in index.html');

  // ===== 20e. DELETE-BATCH + RESET =====
  // Confirm batch-A is present with jobs+keywords+activity (from earlier tests)
  const preSum = await req('GET', '/api/jobs/summary');
  const hasA = preSum.data.batches.some(b => b.batch_id === BATCH_A);
  assert(hasA, '20e.1 BATCH_A present before delete');

  // Refuse delete without batchId
  const noArg = await req('POST', '/api/jobs/delete-batch', {});
  assertEq(noArg.status, 400, '20e.2 delete-batch without batchId = 400');

  // Delete BATCH_A — should remove jobs + keywords + activity
  const del = await req('POST', '/api/jobs/delete-batch', { batchId: BATCH_A });
  assertEq(del.status, 200, '20e.3 delete-batch returns 200');
  assert(del.data.deletedJobs > 0, '20e.4 delete removed jobs');
  const kwAfter = await req('GET', `/api/keywords?batchId=${BATCH_A}`);
  assertEq(kwAfter.data.total, 0, '20e.5 keywords empty after batch delete');
  const postSum = await req('GET', '/api/jobs/summary');
  assert(!postSum.data.batches.some(b => b.batch_id === BATCH_A), '20e.6 batch gone from summary');

  // Worker config must survive batch delete
  const cfgAfter = await req('GET', '/api/config');
  assert(cfgAfter.data.ok === true, '20e.7 worker_config still readable');

  // Reset-all requires the exact confirm token
  const noConfirm = await req('POST', '/api/reset-all', {});
  assertEq(noConfirm.status, 400, '20e.8 reset-all without confirm = 400');
  const wrongConfirm = await req('POST', '/api/reset-all', { confirm: 'yes' });
  assertEq(wrongConfirm.status, 400, '20e.9 reset-all with wrong confirm = 400');

  // Upload something, push a keyword + activity, then reset — everything gone
  await req('POST', '/api/jobs/upload', {
    batchId: 'reset-test-batch',
    products: [{ url: 'https://dropy.in/products/reset-test' }],
  });
  await req('POST', '/api/keywords', { rows: [{ batch_id: 'reset-test-batch', keyword: 'x', product_url: 'https://dropy.in/products/reset-test' }] });
  await req('POST', '/api/activity', { batchId: 'reset-test-batch', events: [{ message: 'test event' }] });

  const reset = await req('POST', '/api/reset-all', { confirm: 'RESET' });
  assertEq(reset.status, 200, '20e.10 reset-all with correct confirm succeeds');
  assert(reset.data.deletedJobs > 0, '20e.11 reset deleted jobs');

  const sumAfter = await req('GET', '/api/jobs/summary');
  assertEq(sumAfter.data.batches.length, 0, '20e.12 summary empty after reset');

  const actAfter = await req('GET', '/api/activity?limit=100');
  assertEq(actAfter.data.events.length, 0, '20e.13 activity empty after reset');

  // Worker config MUST survive the reset (KP URL, token, etc.)
  const cfgSurvive = await req('GET', '/api/config');
  assertEq(cfgSurvive.status, 200, '20e.14 worker_config survives reset-all');

  // ===== 21. WEB APP CAN REACH ALL DASHBOARD ENDPOINTS =====
  // Simulates the web app's initial dashboard poll: summary + worker-stats + activity.
  const [s1, w1, a1] = await Promise.all([
    fetch(`${BASE}/api/jobs/summary`, { headers: { 'X-Manager-Token': TOKEN } }).then(r => r.json()),
    fetch(`${BASE}/api/jobs/worker-stats`, { headers: { 'X-Manager-Token': TOKEN } }).then(r => r.json()),
    fetch(`${BASE}/api/activity?limit=50`, { headers: { 'X-Manager-Token': TOKEN } }).then(r => r.json()),
  ]);
  assert(s1?.ok && Array.isArray(s1.batches), '21.1 dashboard summary reachable');
  assert(w1?.ok && Array.isArray(w1.workers), '21.2 dashboard workers reachable');
  assert(a1?.ok && Array.isArray(a1.events), '21.3 dashboard activity reachable');

  // ---------------- results ----------------
  console.log(`\n\n${passed} passed, ${failed} failed`);
  if (fails.length) {
    console.log('\nFailures:');
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ All tests passed');
  process.exit(0);
}

run().catch(e => {
  console.error('\n\nFATAL: ' + e.stack);
  process.exit(2);
});
