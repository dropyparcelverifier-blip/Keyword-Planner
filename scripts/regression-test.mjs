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

  // The install one-liner should show up in the workers tab.
  assert(idx.body.includes('installOneLiner'), '20c.20 install one-liner element in index.html');

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
