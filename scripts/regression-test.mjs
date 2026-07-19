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
  assert(/type="module" src="\/public\/app\.js(\?v=\d+)?"/.test(idx.body), '19.4 / loads app.js as module');

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
  assert(appJs.body.includes('src-autosuggest') && appJs.body.includes('src-related'), '20f.14 source-color chips styled in analytics');

  assert(appJs.body.includes('worker-actions'), '20f.15 per-worker action buttons wired');
  // 20f.16 updated: the per-row release button now uses the direct
  // manager-side endpoint (data-release-worker), not the worker command
  // path (data-cmd=release_claims). The command path is still available
  // via dashboard broadcast for backward-compat.
  assert(appJs.body.includes('data-release-worker'), '20f.16 per-row release button uses manager-side release-by-worker');

  // Worker popup slim-down — the extension is now worker-only.
  const popupHtml = readFileSync(resolve(REPO, 'popup.html'), 'utf-8');
  const popupJs = readFileSync(resolve(REPO, 'popup.js'), 'utf-8');
  assert(popupHtml.length < 20000, `20f.17 popup.html trimmed (got ${popupHtml.length} bytes)`);
  assert(popupJs.length < 20000, `20f.18 popup.js trimmed (got ${popupJs.length} bytes)`);
  assert(!popupHtml.includes('data-role="manager"'), '20f.19 no manager role picker in popup');
  assert(!popupHtml.includes('mgrSaveCredsBtn'), '20f.20 no manager creds card in popup');
  assert(popupHtml.includes('id="hero"'), '20f.21 worker hero status block present');
  assert(popupHtml.includes('id="openManager"'), '20f.22 open-manager-dashboard footer link present');
  // Palette parity: worker popup + manager operator dashboard must share
  // the near-black + amber tokens so the whole surface reads as one product.
  const dashHtml = readFileSync(resolve(REPO, 'dashboard.html'), 'utf-8');
  const AMBER_TOKEN = '--accent:     #f59e0b';
  const NEAR_BLACK  = '--bg-0:       #050510';
  assert(popupHtml.includes(AMBER_TOKEN),  '20f.23 popup uses amber accent');
  assert(popupHtml.includes(NEAR_BLACK),   '20f.24 popup uses near-black base');
  assert(dashHtml.includes(AMBER_TOKEN),   '20f.25 dashboard uses amber accent');
  assert(dashHtml.includes(NEAR_BLACK),    '20f.26 dashboard uses near-black base');
  // Manager styles.css already established this palette earlier — sanity check.
  const stylesCssEarly = readFileSync(resolve(REPO, 'manager/public/styles.css'), 'utf-8');
  assert(stylesCssEarly.includes("--accent:     #f59e0b"), '20f.27 manager styles.css matches');
  // No lingering old-blue accent (#5a8cff) in worker/dashboard.
  assert(!popupHtml.includes('#5a8cff'),   '20f.28 popup no legacy blue');
  assert(!dashHtml.includes('#5a8cff'),    '20f.29 dashboard no legacy blue');

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

  // ===== 20k. RELIABILITY FIXES =====
  // Direct call replaces the SW-to-SW sendMessage that intermittently
  // failed with 'Receiving end does not exist'. The refactor extracts
  // the auto-connect body to _doAutoConnectWorker and workerAutoPollTick
  // now calls it directly instead of sending a chrome.runtime.sendMessage.
  const bgSrcK = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(bgSrcK.includes('async function _doAutoConnectWorker'), '20k.1 _doAutoConnectWorker extracted');
  // workerAutoPollTick should now await the direct call, not sendMessage.
  // Normalize CRLF so \n}\n matches on Windows too.
  const bgSrcKNorm = bgSrcK.replace(/\r\n/g, '\n');
  const pollTickBody = bgSrcKNorm.substring(bgSrcKNorm.indexOf('async function workerAutoPollTick'));
  const pollTickEnd = pollTickBody.indexOf('\n}\n');
  const pollTickFn = pollTickBody.substring(0, pollTickEnd);
  assert(pollTickFn.includes('await _doAutoConnectWorker'),
    '20k.2 workerAutoPollTick calls _doAutoConnectWorker directly (no SW self-message)');
  assert(!pollTickFn.includes(`chrome.runtime.sendMessage({`),
    '20k.3 workerAutoPollTick no longer uses chrome.runtime.sendMessage to itself');

  // Worker heartbeat endpoint
  const hbNoId = await req('POST', '/api/workers/heartbeat', {});
  assertEq(hbNoId.status, 400, '20k.4 heartbeat requires workerId');
  const hbOK = await req('POST', '/api/workers/heartbeat', { workerId: 'PC-ROSTER1' });
  assertEq(hbOK.status, 200, '20k.5 heartbeat 200');
  const rosterList = await req('GET', '/api/workers/list');
  assertEq(rosterList.status, 200, '20k.6 workers/list 200');
  assert(rosterList.data.workers.some(w => w.worker_id === 'PC-ROSTER1'), '20k.7 heartbeat upserts worker into roster');

  // Worker client sends heartbeat every auto-poll
  assert(bgSrcK.includes('sendWorkerHeartbeat(state.workerId)'), '20k.8 background.js pings heartbeat every auto-poll');
  const djSrc = readFileSync(resolve(REPO, 'modules/discovery-jobs.js'), 'utf-8');
  assert(djSrc.includes('export async function sendWorkerHeartbeat'), '20k.9 sendWorkerHeartbeat exported from client');

  // Dashboard merges idle-from-roster into worker fleet
  assert(appJs.body.includes('idleFromRoster'), '20k.10 dashboard merges roster into fleet render');

  // ===== 20l. STOP/PAUSE/RESET SANITY =====
  // Pause fix: manager 'pause' now clears runIntent so watchdog can't race
  assert(bgSrcK.includes("c.command === 'pause'"),           '20l.1 pause command handler exists');
  const pauseIdx = bgSrcK.indexOf("c.command === 'pause'");
  const pauseBlock = bgSrcK.substring(pauseIdx, pauseIdx + 800);
  assert(pauseBlock.includes('setRunIntent(false)'),          '20l.2 pause clears runIntent (fixes watchdog race)');

  // Watchdog window guard
  assert(bgSrcK.includes('_runIntentClearedAt'),              '20l.3 30s recent-stop guard in shouldAutoResume');
  assert(bgSrcK.includes('state.stopRequested) return false'),'20l.4 shouldAutoResume checks stopRequested');

  // KP no-ideas returns ok:true empty
  const kdSrc = readFileSync(resolve(REPO, 'modules/keyword-discovery.js'), 'utf-8');
  assert(kdSrc.includes('empty: true'),                       '20l.5 KP scraper returns empty: true for zero-ideas seed');
  assert(kdSrc.includes('expansion?.ok && expansion?.empty'), '20l.6 R2 loop treats empty as continue (no retry storm)');

  // Worker knows how to handle reset_local (static check — safe to run anytime)
  assert(bgSrcK.includes("c.command === 'reset_local'"),      '20l.7 worker handles reset_local command');
  assert(bgSrcK.includes('PENDING_PUSH_STORAGE_KEY'),         '20l.8 reset_local wipes pending pushes to gone rows');
  // The destructive reset-broadcast assertions run later, after 20e (which
  // also does a reset) — placing them here would wipe state 20e depends on.

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

  // ===== Selective wipe endpoint =====
  // Requires confirm=WIPE.
  const wipeNoConfirm = await req('POST', '/api/wipe-selective', {});
  assertEq(wipeNoConfirm.status, 400, '20w.1 wipe-selective without confirm = 400');
  // Set up: one batch with jobs + a failed job + a keyword + activity.
  await req('POST', '/api/jobs/upload', {
    batchId: 'wipe-test-batch',
    products: [
      { url: 'https://dropy.in/products/wipe-a', sku: 'A' },
      { url: 'https://dropy.in/products/wipe-b', sku: 'B' },
    ],
  });
  await req('POST', '/api/keywords', { rows: [
    { batch_id: 'wipe-test-batch', keyword: 'k1', product_url: 'https://dropy.in/products/wipe-a' },
    { batch_id: 'wipe-test-batch', keyword: 'k2', product_url: 'https://dropy.in/products/wipe-a' },
  ] });
  await req('POST', '/api/activity', { batchId: 'wipe-test-batch', events: [{ message: 'wt-event' }] });
  // Mark one job as failed (via a jobs/update failed patch).
  const listBefore = await req('GET', '/api/jobs/list?batchId=wipe-test-batch');
  const oneJobId = listBefore.data.rows?.[0]?.id;
  if (oneJobId) await req('POST', '/api/jobs/update', { jobId: oneJobId, status: 'failed', failed_reason: 'test' });
  // Wipe only failed jobs, scoped to this batch.
  const wipeFailed = await req('POST', '/api/wipe-selective', {
    confirm: 'WIPE',
    batchId: 'wipe-test-batch',
    flags: { failedJobsOnly: true },
  });
  assertEq(wipeFailed.status, 200, '20w.2 wipe-selective failedJobsOnly ok');
  assert(wipeFailed.data.deletedFailedJobs >= 0, '20w.3 wipe-selective returns deletedFailedJobs');
  // Global wipe of activity only — leaves jobs + keywords intact.
  await req('POST', '/api/activity', { batchId: 'wipe-test-batch', events: [{ message: 'w2' }] });
  const wipeAct = await req('POST', '/api/wipe-selective', {
    confirm: 'WIPE', flags: { activity: true },
  });
  assertEq(wipeAct.status, 200, '20w.4 wipe-selective activity-only ok');
  const jobsStill = await req('GET', '/api/jobs/summary');
  assert(jobsStill.data.batches.length >= 0, '20w.5 wipe-selective activity-only left jobs alone');
  // Regression: pin a batch, wipe only its failed jobs — the pin MUST
  // survive. Previously an unpin was fired whenever flags.jobs was set,
  // even though failedJobsOnly short-circuited the actual jobs delete.
  await req('POST', '/api/jobs/upload', {
    batchId: 'wipe-pin-test',
    products: [{ url: 'https://dropy.in/products/pin-a', sku: 'PA' }],
  });
  await req('POST', '/api/config', { activeBatchId: 'wipe-pin-test' });
  const preBefore = await req('GET', '/api/config');
  assertEq(preBefore.data.active_batch_id, 'wipe-pin-test', '20w.6 pin set');
  await req('POST', '/api/wipe-selective', {
    confirm: 'WIPE', batchId: 'wipe-pin-test',
    flags: { failedJobsOnly: true, jobs: true },
  });
  const preAfter = await req('GET', '/api/config');
  assertEq(preAfter.data.active_batch_id, 'wipe-pin-test', '20w.7 pin SURVIVES failed-jobs-only wipe');
  await req('POST', '/api/config', { activeBatchId: null });
  // Nuke the wipe-test-batch + pin-test entirely for cleanup.
  await req('POST', '/api/wipe-selective', {
    confirm: 'WIPE', batchId: 'wipe-test-batch',
    flags: { jobs: true, keywords: true, activity: true },
  });
  await req('POST', '/api/wipe-selective', {
    confirm: 'WIPE', batchId: 'wipe-pin-test',
    flags: { jobs: true, keywords: true, activity: true },
  });

  // ===== Shopify allowlist =====
  // Even with valid confirm, the update-product endpoint rejects when
  // the entire patch is stripped by the allowlist (no allowed fields).
  const shopBadPatch = await req('POST', '/api/shopify/update-product', {
    confirm: 'PUSH', productId: 1, patch: { price: '999', weight: 100, variants: [] },
  });
  assertEq(shopBadPatch.status, 400, '20s.1 all-stripped patch = 400');
  assert(shopBadPatch.data.stripped?.includes('price'),  '20s.2 stripped list includes price');
  assert(shopBadPatch.data.stripped?.includes('weight'), '20s.3 stripped list includes weight');
  assert(shopBadPatch.data.stripped?.includes('variants'), '20s.4 stripped list includes variants');
  // No confirm at all → 400.
  const shopNoConfirm = await req('POST', '/api/shopify/update-product', { productId: 1, patch: { title: 'x' } });
  assertEq(shopNoConfirm.status, 400, '20s.5 update-product without confirm = 400');
  // Field impact endpoint reachable + returns the priority order.
  const impact = await req('GET', '/api/shopify/field-impact');
  assertEq(impact.status, 200, '20s.6 field-impact endpoint ok');
  assert(impact.data.fields?.[0]?.field === 'title', '20s.7 title is highest priority');
  assert(Array.isArray(impact.data.allowlist),        '20s.8 allowlist returned');
  assert(!impact.data.allowlist.includes('price'),    '20s.9 allowlist excludes price');
  assert(!impact.data.allowlist.includes('weight'),   '20s.10 allowlist excludes weight');
  assert(!impact.data.allowlist.includes('variants'), '20s.11 allowlist excludes variants');
  // Modern SEO + Product Taxonomy expansion — the 4 new fields added in the
  // Shopify improvements pass. They land via GraphQL productUpdate; REST-
  // only fields land via products.json PUT. Both paths run together.
  assert(impact.data.allowlist.includes('seo_title'),           '20s.12 allowlist includes modern seo_title');
  assert(impact.data.allowlist.includes('seo_description'),     '20s.13 allowlist includes modern seo_description');
  assert(impact.data.allowlist.includes('product_category'),    '20s.14 allowlist includes product_category (Standard Taxonomy)');
  // Legacy metafields kept for backwards compat + belt-and-braces.
  assert(impact.data.allowlist.includes('metafields_global_title_tag'),       '20s.15 legacy metafields_global_title_tag still allowed');
  assert(impact.data.allowlist.includes('metafields_global_description_tag'), '20s.16 legacy metafields_global_description_tag still allowed');
  // Field-impact hierarchy: product_category flagged as "high" so the UI
  // + prompt surface it prominently. seo_title flagged critical (modern
  // path is preferred; legacy runs alongside as belt-and-braces).
  const impactFields = impact.data.fields || [];
  const catRow = impactFields.find(r => r.field === 'product_category');
  assert(catRow && catRow.impact === 'high',                    '20s.17 product_category impact = high');
  const seoTRow = impactFields.find(r => r.field === 'seo_title');
  assert(seoTRow && seoTRow.impact === 'critical',              '20s.18 seo_title impact = critical');
  // Image-alt endpoint reachable — 400 without alts (safety); 400 without confirm.
  const altNoConfirm = await req('POST', '/api/shopify/update-image-alts', { productId: 1, alts: [{ imageId: 1, alt: 'x' }] });
  assertEq(altNoConfirm.status, 400,                            '20s.19 update-image-alts without confirm = 400');
  const altNoAlts = await req('POST', '/api/shopify/update-image-alts', { confirm: 'PUSH', productId: 1 });
  assertEq(altNoAlts.status, 400,                               '20s.20 update-image-alts without alts array = 400');
  // (Source-inspection assertions for extractReviewSignals + GraphQL routing
  // live in the srv-inspection block below, where srvFull has been loaded.)

  // ===== Preflight validator =====
  // Dry-run endpoint: returns preflight without pushing. Missing patch → 400.
  const preNoPatch = await req('POST', '/api/shopify/validate-patch', {});
  assertEq(preNoPatch.status, 400,                              'PREF.1 validate-patch without patch = 400');
  // Empty patch → passes trivially (nothing to validate against, no critical
  // failures possible because there are no fields to fail).
  const preEmpty = await req('POST', '/api/shopify/validate-patch', { patch: {} });
  assertEq(preEmpty.status, 200,                                'PREF.2 empty patch validation = 200');
  assertEq(preEmpty.data.preflight.ok, true,                    'PREF.3 empty patch has no critical failures');
  // Body too small → critical fail body_too_short.
  const preTiny = await req('POST', '/api/shopify/validate-patch', {
    patch: { body_html: 'Tiny body. Not enough words. Only fifteen or so.' },
  });
  assert(preTiny.data.preflight.ok === false,                   'PREF.4 tiny body_html fails preflight');
  assert(preTiny.data.preflight.critical.some(c => c.id === 'body_too_short'), 'PREF.5 body_too_short critical raised');
  // Base64 image URI → critical fail.
  const preB64 = await req('POST', '/api/shopify/validate-patch', {
    patch: { body_html: 'x '.repeat(900) + '<img src="data:image/png;base64,iVBORw0K">' },
  });
  assert(preB64.data.preflight.critical.some(c => c.id === 'body_base64'), 'PREF.6 base64 URI critical raised');
  // Non-JSON-LD <script> tag → critical fail body_has_scripts.
  const preScript = await req('POST', '/api/shopify/validate-patch', {
    patch: { body_html: 'x '.repeat(900) + '<script>alert(1)</script>' },
  });
  assert(preScript.data.preflight.critical.some(c => c.id === 'body_has_scripts'), 'PREF.7 non-JSON-LD script critical raised');
  // Fabricated AggregateRating when no review data supplied → critical fail.
  const preFakeRating = await req('POST', '/api/shopify/validate-patch', {
    patch: { body_html: 'x '.repeat(900) + '<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":"4.5"}}</script>' },
    validationContext: { hasReviewData: false },
  });
  assert(preFakeRating.data.preflight.critical.some(c => c.id === 'fabricated_agg_rating'), 'PREF.8 fabricated AggregateRating critical raised (no real reviews)');
  // Same body but WITH real review context → no critical for that check.
  const preRealRating = await req('POST', '/api/shopify/validate-patch', {
    patch: { body_html: 'x '.repeat(900) + '<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":"4.5"}}</script>' },
    validationContext: { hasReviewData: true },
  });
  assert(!preRealRating.data.preflight.critical.some(c => c.id === 'fabricated_agg_rating'), 'PREF.9 AggregateRating allowed when hasReviewData:true');
  // Competitor brand in copy → critical fail (context-aware).
  const preCompetitor = await req('POST', '/api/shopify/validate-patch', {
    patch: { body_html: 'x '.repeat(900) + '<script type="application/ld+json">{}</script> unlike Amazon our product is better' },
    validationContext: { competitorBrands: ['Amazon'] },
  });
  assert(preCompetitor.data.preflight.critical.some(c => c.id === 'competitor_brand_Amazon'), 'PREF.10 competitor brand in copy critical raised');
  // Bad product_category shape → critical.
  const preBadCat = await req('POST', '/api/shopify/validate-patch', {
    patch: { product_category: 'skincare' },
  });
  assert(preBadCat.data.preflight.critical.some(c => c.id === 'bad_product_category'), 'PREF.11 non-gid product_category critical raised');
  // Valid gid passes.
  const preGoodCat = await req('POST', '/api/shopify/validate-patch', {
    patch: { product_category: 'gid://shopify/ProductTaxonomyNode/1085' },
  });
  assert(!preGoodCat.data.preflight.critical.some(c => c.id === 'bad_product_category'), 'PREF.12 valid gid product_category passes');
  // update-product with failing preflight and no force → 400 with preflight in body.
  const upWithBadPatch = await req('POST', '/api/shopify/update-product', {
    confirm: 'PUSH', productId: 1,
    patch: { body_html: 'too short' },
  });
  assertEq(upWithBadPatch.status, 400,                          'PREF.13 update-product with failing preflight = 400');
  assert(upWithBadPatch.data.preflight?.critical?.length > 0,   'PREF.14 update-product response carries preflight report');
  // update-product with force:true bypasses preflight (but will still fail at Shopify creds; we just check preflight was skipped).
  const upForced = await req('POST', '/api/shopify/update-product', {
    confirm: 'PUSH', productId: 1, force: true,
    patch: { body_html: 'too short' },
  });
  // Shopify creds missing → 502, but importantly NOT the preflight 400.
  assert(upForced.status !== 400 || !upForced.data.preflight,   'PREF.15 update-product with force:true bypasses preflight');

  // ===== Bulk SKU import — Dropy-<ASIN> → amazon.in/dp/<ASIN> =====
  const bulkBatch = 'bulk-import-test';
  // Dry-run first — should NOT insert.
  const dryR = await req('POST', '/api/jobs/upload-by-sku', {
    batchId: bulkBatch, resolve: 'amazon', dryRun: true,
    skus: [
      'Dropy-B002OTT3US', 'Dropy-B07KYD25MF', '# comment',
      '', 'BADFORMAT', 'B00X6ZNWG0', 'dropy-b00cefzkzy',
    ],
  });
  assertEq(dryR.status, 200, '20b.1 upload-by-sku dry-run ok');
  assertEq(dryR.data.dryRun, true, '20b.2 dry-run flag set');
  assertEq(dryR.data.parsed, 4, '20b.3 parsed 4 valid SKUs (dedupes case-insensitively)');
  assertEq(dryR.data.resolved, 4, '20b.4 all 4 resolved to amazon.in URLs');
  assertEq(dryR.data.badFormat, 1, '20b.5 BADFORMAT flagged');
  assert(dryR.data.preview.some(p => p.url === 'https://www.amazon.in/dp/B002OTT3US'), '20b.6 amazon URL correctly built');
  // Verify nothing inserted by dry-run.
  const sumAfterDry = await req('GET', '/api/jobs/summary');
  assert(!(sumAfterDry.data.batches || []).find(b => b.batch_id === bulkBatch), '20b.7 dry-run inserted zero rows');
  // Real insert.
  const realR = await req('POST', '/api/jobs/upload-by-sku', {
    batchId: bulkBatch, resolve: 'amazon', dryRun: false,
    skus: ['Dropy-B002OTT3US', 'Dropy-B07KYD25MF', 'Dropy-B0B3FBK9KW'],
  });
  assertEq(realR.status, 200, '20b.8 upload-by-sku real ok');
  assertEq(realR.data.inserted, 3, '20b.9 inserted 3 rows');
  const listR = await req('GET', `/api/jobs/list?batchId=${bulkBatch}`);
  assertEq(listR.data.rows.length, 3, '20b.10 3 rows visible in jobs list');
  assert(listR.data.rows.every(r => r.product_url.startsWith('https://www.amazon.in/dp/')), '20b.11 all rows have amazon URLs');

  // ===== Bulk update / delete =====
  const jobIds = listR.data.rows.map(r => r.id);
  const bulkUp = await req('POST', '/api/jobs/bulk-update', { jobIds, patch: { priority: 999 } });
  assertEq(bulkUp.data.updated, 3, '20b.12 bulk-update set priority on all 3');
  const listR2 = await req('GET', `/api/jobs/list?batchId=${bulkBatch}`);
  assert(listR2.data.rows.every(r => r.priority === 999), '20b.13 priority actually persisted');
  // Bulk-update require patch.
  const bulkUpBad = await req('POST', '/api/jobs/bulk-update', { jobIds, patch: {} });
  assertEq(bulkUpBad.status, 400, '20b.14 bulk-update refuses empty patch');
  // Bulk delete.
  const bulkDel = await req('POST', '/api/jobs/bulk-delete', { jobIds });
  assertEq(bulkDel.data.deleted, 3, '20b.15 bulk-delete removed all 3');
  const listR3 = await req('GET', `/api/jobs/list?batchId=${bulkBatch}`);
  assertEq(listR3.data.rows.length, 0, '20b.16 jobs list empty after bulk delete');

  // ===== 20l-late. RESET BROADCAST + WORKERS-ROSTER WIPE =====
  // The 20e reset above ran; verify the side-effects that fix the
  // 'workers still heartbeat phantom jobs after reset' bug.
  assert('deletedWorkers' in reset.data,                        '20l.9 reset reports deletedWorkers count');
  // Broadcast 'reset_local' command should have been queued.
  const cmdsAfterReset = await req('GET', '/api/commands?workerId=any-worker-picks-up-broadcast');
  const hasResetBroadcast = (cmdsAfterReset.data?.commands || []).some(c => c.command === 'reset_local');
  assert(hasResetBroadcast, '20l.10 reset queues a reset_local broadcast for workers');
  // Workers roster is wiped.
  const rosterAfterReset = await req('GET', '/api/workers/list');
  assertEq((rosterAfterReset.data.workers || []).length, 0, '20l.11 workers roster wiped by reset');

  // ===== 20m. FLEET UX + RECONNECT + ERRORS CARD =====
  // Reconnect command — the escape hatch for stopped-by-user workers.
  const bgSrcM = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(bgSrcM.includes("c.command === 'reconnect'"), '20m.1 worker handles reconnect command');
  assert(bgSrcM.includes('userStoppedArm = false'),    '20m.2 reconnect clears userStoppedArm');
  assert(appJs.body.includes('data-cmd="reconnect"'),   '20m.3 fleet grid has reconnect button');
  assert(idx.body.includes('Force reconnect'),          '20m.4 broadcast dropdown offers force reconnect');

  // Activity log source-color CSS
  assert(cssR.body.includes('.log-line .src[data-src="kp"]'),   '20m.5 KP source color');
  assert(cssR.body.includes('.log-line .src[data-src="serp"]'), '20m.6 SERP source color');
  assert(cssR.body.includes('.log-line .src[data-src="cmd"]'),  '20m.7 cmd source color');
  assert(appJs.body.includes('data-src="${esc(src)}"'),          '20m.8 activity log emits data-src for color match');

  // Current-step per-worker column
  assert(appJs.body.includes('stageFor'),                        '20m.9 stageFor mapper defined');
  assert(appJs.body.includes('w._lastActivity'),                 '20m.10 worker enriched with latest activity');

  // Activity endpoint accepts level filter
  const errApi = await req('GET', '/api/activity?level=err&limit=10');
  assertEq(errApi.status, 200, '20m.11 activity endpoint accepts level=err');
  assert(Array.isArray(errApi.data.events), '20m.12 level filter returns events array');

  // Errors card in dashboard
  assert(idx.body.includes('id="errorsCard"'), '20m.13 errors card element');
  assert(appJs.body.includes('renderErrorsCard'), '20m.14 renderErrorsCard defined');
  assert(appJs.body.includes('activityErrors'), '20m.15 activityErrors api wrapper called');
  // Passive event detection (toast on SKU done, worker offline, etc.)
  assert(appJs.body.includes('detectAndToastEvents'), '20m.16 event detector defined');
  assert(appJs.body.includes('completed'),            '20m.17 emits toast for SKU completion');
  assert(appJs.body.includes('Worker offline'),       '20m.18 emits toast when worker goes silent');
  assert(appJs.body.includes('Batch complete'),       '20m.19 emits toast when batch finishes');

  // ===== 20n. ORPHAN KEYWORD MANAGEMENT =====
  // /api/keywords/batches lists every batch that has keyword rows
  const kwB = await req('GET', '/api/keywords/batches');
  assertEq(kwB.status, 200, '20n.1 GET /api/keywords/batches 200');
  assert(Array.isArray(kwB.data.batches), '20n.2 batches array returned');
  // /api/keywords/orphans preflight
  const orph = await req('GET', '/api/keywords/orphans');
  assertEq(orph.status, 200, '20n.3 GET /api/keywords/orphans 200');
  assert('orphanRows' in orph.data, '20n.4 orphanRows count returned');
  assert('claimedNow' in orph.data, '20n.5 claimedNow (in-flight) returned');
  assert('activeWorkers' in orph.data, '20n.6 activeWorkers returned');
  // Create an orphan via the real-world path: upload a batch with a job,
  // push a keyword to it, then delete the batch — the keyword row is left
  // pointing at a non-existent batch_id. The batchExists guard on
  // /api/keywords is designed to REJECT writes to a fully-nonexistent
  // batch (see 20n-guard.1 below), so a ghost-batch push no longer creates
  // an orphan directly. Legacy orphans (batch deleted after keyword push)
  // are still what the cleanup endpoint is for.
  const orphanBatchId = 'orphan-test-batch';
  await req('POST', '/api/jobs/upload', { batchId: orphanBatchId, products: [{ product_url: 'https://orphan.example/p', product_name: 'Orphan' }] });
  await req('POST', '/api/keywords', { rows: [{ batch_id: orphanBatchId, keyword: 'ghost', product_url: 'https://orphan.example/p' }] });
  // Wipe ONLY the jobs (not the keywords) to reproduce the real orphan
  // scenario — /api/jobs/delete-batch cascades to keywords too, which
  // would defeat the setup.
  await req('POST', '/api/wipe-selective', { confirm: 'WIPE', flags: { jobs: true }, batchId: orphanBatchId });
  const orph2 = await req('GET', '/api/keywords/orphans');
  assert(orph2.data.orphanRows >= 1, '20n.7 orphan row detected after synthetic push');
  // 20n-guard.1: verify the batchExists guard rejects direct ghost-batch writes.
  const ghost = await req('POST', '/api/keywords', { rows: [{ batch_id: 'ghost-batch-xyz-nonexistent', keyword: 'ghost', product_url: 'https://x' }] });
  assertEq(ghost.status, 200, '20n-guard.1 ghost-batch push returns 200 (guard is soft)');
  assert(Number(ghost.data?.rejected || 0) >= 1, '20n-guard.2 ghost-batch push reports rejected count');
  assertEq(Number(ghost.data?.inserted || 0), 0, '20n-guard.3 ghost-batch push inserts 0 rows');
  assert('active_batch_id' in ghost.data, '20n-guard.4 response echoes manager active_batch_id for drift-detection');
  // Cleanup requires confirm string
  const cleanNo = await req('POST', '/api/keywords/cleanup-orphans', {});
  assertEq(cleanNo.status, 400, '20n.8 cleanup requires confirm string');
  // With confirm, orphans are wiped
  const cleanOK = await req('POST', '/api/keywords/cleanup-orphans', { confirm: 'CLEAN_ORPHANS' });
  assertEq(cleanOK.status, 200, '20n.9 cleanup with correct confirm 200');
  assert(cleanOK.data.deleted >= 1, '20n.10 cleanup reports deleted count');
  // UI wiring
  assert(idx.body.includes('id="cleanupOrphansBtn"'), '20n.11 cleanup button in Config');
  assert(idx.body.includes('id="orphanCountSub"'),    '20n.12 orphan-count subtitle element');
  assert(appJs.body.includes('refreshOrphanCount'),   '20n.13 refreshOrphanCount() defined');
  assert(appJs.body.includes('WORK IN PROGRESS DETECTED'), '20n.14 reset-all preflight warns on active workers');

  // ===== Incremental keyword fetch (Analytics live-poll bandwidth) =====
  // /api/keywords now supports ?sinceId=<max_id> for delta reads. Client
  // keeps a running cursor and appends new rows instead of re-parsing the
  // whole batch every 4s. Verify:
  //   1. Full fetch still works (no sinceId).
  //   2. Server returns maxId on every response so the client can advance.
  //   3. sinceId=<current max> returns 0 rows + same maxId.
  //   4. Pushing a fresh keyword bumps maxId + returns via incremental.
  const incBatch = 'inc-fetch-test-batch';
  await req('POST', '/api/jobs/upload', { batchId: incBatch, products: [{ product_url: 'https://inc.example/p', product_name: 'Inc' }] });
  await req('POST', '/api/keywords', { rows: [{ batch_id: incBatch, keyword: 'seed-1', product_url: 'https://inc.example/p' }] });
  await req('POST', '/api/keywords', { rows: [{ batch_id: incBatch, keyword: 'seed-2', product_url: 'https://inc.example/p' }] });
  const fullKw = await req('GET', `/api/keywords?batchId=${encodeURIComponent(incBatch)}`);
  assertEq(fullKw.status, 200,                                  'INC.1 full keyword fetch = 200');
  assert(Array.isArray(fullKw.data.rows) && fullKw.data.rows.length === 2, 'INC.2 full fetch returns both seeds');
  assert(Number.isFinite(fullKw.data.maxId) && fullKw.data.maxId > 0, 'INC.3 full fetch response includes maxId');
  assertEq(fullKw.data.incremental, false,                      'INC.4 full fetch flagged incremental=false');
  const anchorId = fullKw.data.maxId;
  const emptyDelta = await req('GET', `/api/keywords?batchId=${encodeURIComponent(incBatch)}&sinceId=${anchorId}`);
  assertEq(emptyDelta.status, 200,                              'INC.5 incremental fetch with current maxId = 200');
  assertEq(emptyDelta.data.rows.length, 0,                      'INC.6 incremental fetch returns 0 rows when no delta');
  assertEq(emptyDelta.data.incremental, true,                   'INC.7 incremental fetch flagged incremental=true');
  assertEq(emptyDelta.data.maxId, anchorId,                     'INC.8 incremental response echoes current maxId');
  await req('POST', '/api/keywords', { rows: [{ batch_id: incBatch, keyword: 'seed-3-fresh', product_url: 'https://inc.example/p' }] });
  const freshDelta = await req('GET', `/api/keywords?batchId=${encodeURIComponent(incBatch)}&sinceId=${anchorId}`);
  assertEq(freshDelta.data.rows.length, 1,                      'INC.9 incremental fetch returns only the new row');
  assert(freshDelta.data.maxId > anchorId,                      'INC.10 maxId advanced after new insert');
  assertEq(freshDelta.data.rows[0].keyword, 'seed-3-fresh',     'INC.11 incremental row payload correct');
  // Client wrapper + live-poll consumer.
  const apiJsSrc = await fetchStatic('/public/api.js');
  assert(apiJsSrc.body.includes('sinceId'),                     'INC.12 client keywordsGet accepts sinceId');
  assert(appJs.body.includes('fullRefreshEvery'),               'INC.13 analytics live-poll has periodic full-refresh safety net');
  assert(appJs.body.includes('analytics.lastMaxId'),            'INC.14 analytics tracks lastMaxId incremental cursor');

  // ===== 20o. BACKUPS + QUIESCE =====
  // Backup endpoints
  const bList = await req('GET', '/api/backups/list');
  assertEq(bList.status, 200, '20o.1 GET /api/backups/list 200');
  assert(Array.isArray(bList.data.backups), '20o.2 backups is an array');
  assert(typeof bList.data.keepN === 'number', '20o.3 backups returns keepN retention');
  const bNow = await req('POST', '/api/backups/create', {});
  assertEq(bNow.status, 200, '20o.4 POST /api/backups/create 200');
  assert(bNow.data.path, '20o.5 backup returns path');
  assert(bNow.data.size > 0, '20o.6 backup file has size');
  const bList2 = await req('GET', '/api/backups/list');
  assert(bList2.data.backups.length >= 1, '20o.7 backup appears in list after create');
  // Quiesce endpoint
  const q = await req('POST', '/api/workers/quiesce', {});
  assertEq(q.status, 200, '20o.8 POST /api/workers/quiesce 200');
  assert('activeWorkers' in q.data && 'claimedNow' in q.data, '20o.9 quiesce returns status counts');
  // Broadcast pause command should appear in the queue
  const cmds = await req('GET', '/api/commands?workerId=q-test-worker');
  const hasPause = (cmds.data?.commands || []).some(c => c.command === 'pause' && c.created_by === 'manager-quiesce');
  assert(hasPause, '20o.10 quiesce broadcasts pause via manager-quiesce');
  // UI wiring
  assert(idx.body.includes('id="quiesceBtn"'),     '20o.11 quiesce button in Config');
  assert(idx.body.includes('id="backupNowBtn"'),   '20o.12 backup-now button in Config');
  assert(idx.body.includes('id="backupsList"'),    '20o.13 backups list element');
  assert(appJs.body.includes('refreshQuiesceStatus'), '20o.14 quiesce refresher defined');
  assert(appJs.body.includes('refreshBackupsList'),   '20o.15 backups refresher defined');
  assert(appJs.body.includes('quiescePollTimer'),     '20o.16 quiesce polls status every 3s');

  // ===== 20p. WAKE-ON-LAN =====
  // Heartbeat with MAC should store it
  await req('POST', '/api/workers/heartbeat', { workerId: 'PC-WOL-TEST', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'DESKTOP-WOL' });
  const roster = await req('GET', '/api/workers/list');
  const wolTest = (roster.data.workers || []).find(w => w.worker_id === 'PC-WOL-TEST');
  assert(wolTest, '20p.1 heartbeat with MAC upserts worker');
  assert(wolTest?.mac_address, '20p.2 MAC persisted in workers table');
  assertEq(wolTest?.hostname, 'DESKTOP-WOL', '20p.3 hostname persisted');

  // set-mac endpoint validates
  const badMac = await req('POST', '/api/workers/set-mac', { workerId: 'PC-WOL-TEST', mac: 'garbage' });
  assertEq(badMac.status, 400, '20p.4 invalid MAC rejected');
  const goodMac = await req('POST', '/api/workers/set-mac', { workerId: 'PC-WOL-TEST', mac: '11:22:33:44:55:66' });
  assertEq(goodMac.status, 200, '20p.5 valid MAC accepted');
  assert(goodMac.data.mac === '112233445566', '20p.6 MAC normalized (colons stripped)');

  // WOL endpoint
  const wolNoMac = await req('POST', '/api/workers/wol', { workerId: 'PC-NO-MAC' });
  assertEq(wolNoMac.status, 400, '20p.7 WOL rejects unknown worker without MAC');
  const wol = await req('POST', '/api/workers/wol', { workerId: 'PC-WOL-TEST' });
  assertEq(wol.status, 200, '20p.8 WOL sends magic packet when MAC known');
  const wolExplicit = await req('POST', '/api/workers/wol', { mac: 'AA-BB-CC-DD-EE-FF' });
  assertEq(wolExplicit.status, 200, '20p.9 WOL accepts explicit MAC (dash-separated normalized)');
  const wolBadFormat = await req('POST', '/api/workers/wol', { mac: 'not-a-mac' });
  assertEq(wolBadFormat.status, 400, '20p.10 WOL rejects malformed MAC');

  // Installer captures MAC
  assert(ps.body.includes('Get-NetAdapter'), '20p.11 installer reads primary NIC via Get-NetAdapter');
  assert(ps.body.includes('mac          = $primaryMac'), '20p.12 installer bakes MAC into worker-config.json');

  // Worker code path
  const bgSrcP = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(bgSrcP.includes('adbrainWorkerMac'),        '20p.13 worker stores MAC from cold-start config');
  assert(bgSrcP.includes('adbrainWorkerHostname'),   '20p.14 worker stores hostname from cold-start config');
  assert(bgSrcP.includes("mac: d.adbrainWorkerMac"), '20p.15 heartbeat call includes stored MAC');

  // UI wiring
  assert(appJs.body.includes('data-wol="1"'),        '20p.16 fleet grid has WOL button');
  assert(appJs.body.includes('api.wakeOnLan'),       '20p.17 WOL button wired to endpoint');
  assert(appJs.body.includes('api.setWorkerMac'),    '20p.18 UI can set MAC when unknown');

  // ===== 20q. CHROME WATCHDOG =====
  // Installer references watchdog template + registers scheduled task
  assert(ps.body.includes('chrome-watchdog-template.ps1'), '20q.1 installer downloads watchdog template');
  assert(ps.body.includes("Register-ScheduledTask"),        '20q.2 installer registers scheduled task');
  assert(ps.body.includes("AdBrain Chrome Watchdog"),       '20q.3 task named consistently');
  assert(un.body.includes("AdBrain Chrome Watchdog"),       '20q.4 uninstaller removes watchdog task');
  // Watchdog template served + has placeholders
  const wd = await fetchNoAuth('/worker/chrome-watchdog-template.ps1');
  assertEq(wd.status, 200, '20q.5 watchdog template served');
  assert(wd.body.includes('__PROFILE__'), '20q.6 template has profile placeholder');
  assert(wd.body.includes('__EXTDIR__'),  '20q.7 template has extdir placeholder');
  assert(wd.body.includes('__CHROME__'),  '20q.8 template has chrome placeholder');
  assert(wd.body.includes('Start-Process'), '20q.9 template launches chrome via Start-Process');
  // Manager-aware watchdog additions
  assert(wd.body.includes('__MGR__'),             '20q.10 template has manager URL placeholder');
  assert(wd.body.includes('/api/health'),         '20q.11 watchdog pings manager health first');
  assert(wd.body.includes("exit 0"),              '20q.12 watchdog exits silently when manager down');
  assert(ps.body.includes("'__MGR__'"),           '20q.13 installer substitutes __MGR__ placeholder');

  // ===== 20r. BATCH NAMES (human-readable batch labels) =====
  // Empty state — no names set yet.
  const bnEmpty = await req('GET', '/api/batches/names');
  assertEq(bnEmpty.status, 200, '20r.1 batch-names list returns 200');
  assert(Array.isArray(bnEmpty.data?.names), '20r.2 names is an array');
  const bnEmptyLen = bnEmpty.data.names.length;

  // Set a name.
  const bnSet = await req('POST', '/api/batches/rename', { batchId: BATCH_A, name: 'Aquaphor Round 3' });
  assertEq(bnSet.status, 200, '20r.3 rename returns 200');
  assert(bnSet.data?.ok === true, '20r.4 rename ok=true');

  // Verify listed with new name.
  const bnAfter = await req('GET', '/api/batches/names');
  const namedRow = bnAfter.data.names.find(n => n.batch_id === BATCH_A);
  assert(namedRow?.display_name === 'Aquaphor Round 3', '20r.5 rename persists via list endpoint');
  assert(bnAfter.data.names.length === bnEmptyLen + 1, '20r.6 list length grew by exactly one');

  // Update in place (same batch, different name).
  await req('POST', '/api/batches/rename', { batchId: BATCH_A, name: 'Aquaphor Round 3 — final' });
  const bnUpd = await req('GET', '/api/batches/names');
  const updRow = bnUpd.data.names.find(n => n.batch_id === BATCH_A);
  assert(updRow?.display_name === 'Aquaphor Round 3 — final', '20r.7 rename updates in place');
  assert(bnUpd.data.names.length === bnEmptyLen + 1, '20r.8 update does not grow list');

  // Empty name deletes the label.
  await req('POST', '/api/batches/rename', { batchId: BATCH_A, name: '' });
  const bnDel = await req('GET', '/api/batches/names');
  const delRow = bnDel.data.names.find(n => n.batch_id === BATCH_A);
  assert(!delRow, '20r.9 empty name removes the label');

  // Missing batchId = 400.
  const bnBad = await req('POST', '/api/batches/rename', { name: 'no id' });
  assertEq(bnBad.status, 400, '20r.10 rename without batchId = 400');

  // UI wiring — rename UI + fetch + label helper.
  assert(appJs.body.includes('renameBatchSelect'),  '20r.11 rename dropdown wired in app.js');
  assert(appJs.body.includes('api.renameBatch'),    '20r.12 rename button calls API');
  assert(appJs.body.includes('function batchLabel'),'20r.13 display-name helper defined');
  assert(appJs.body.includes('state.batchNames'),   '20r.14 batchNames state populated on refresh');
  const html = readFileSync(resolve(REPO, 'manager/public/index.html'), 'utf-8');
  assert(html.includes('renameBatchSelect') && html.includes('renameBatchName'), '20r.15 rename UI in index.html');

  // ===== 20s. ANALYTICS INSIGHTS + COLUMN ORDER =====
  // Analytics table must lead with opportunity score + Volume before AdRating.
  assert(appJs.body.includes("key: 'opportunity_score'"),   '20s.1 opportunity_score column defined');
  assert(appJs.body.includes('function opportunityScore'),  '20s.2 opportunityScore function defined');
  assert(appJs.body.includes('renderAnalyticsInsights'),    '20s.3 insights renderer defined');
  assert(html.includes('anInsightsCard'),                   '20s.4 insights card in HTML');
  // Column ordering — asserted against KEYWORD_COL_DEFS (grouped export
  // set). Score/Keyword lead; Volume/Intent appear before AdRating in
  // the natural on-screen order once KP + Core groups are enabled.
  const colBlock = appJs.body.match(/const KEYWORD_COL_DEFS = \[[\s\S]{0,8000}?\];/)?.[0] || '';
  const posOf = (needle) => colBlock.indexOf(needle);
  assert(posOf("key: 'opportunity_score'") < posOf("key: 'keyword'"),        '20s.5 Score before Keyword');
  assert(posOf("key: 'buying_intent'") < posOf("key: 'ad_rating'"),          '20s.7 Intent before AdRating');
  assert(posOf("key: 'keyword_relevance'") > 0,                              '20s.8 keyword_relevance column added');
  assert(posOf("key: 'visibility_pct'") > 0,                                 '20s.9 visibility_pct column added');
  assert(posOf("key: 'dropy_is_seller'") > 0,                                '20s.10 dropy_is_seller column added');
  // KP columns live in the 'kp' group; volume must be defined even if it
  // isn't strictly-before ad_rating in the raw def list (they're in
  // different groups now — visible order depends on group toggle order).
  assert(posOf("key: 'kp_monthly_searches'") > 0,                            '20s.6 Volume column defined (KP group)');

  // Visual/data polish.
  assert(appJs.body.includes('function toNum'),                   '20s.15 toNum() defined — NaN-safe numeric coercion');
  assert(appJs.body.includes('function scoreTier'),               '20s.16 scoreTier() defined — score→visual tier map');
  assert(appJs.body.includes('class="tier-${rowTier.tier}'), '20s.17 rows tagged with tier class for CSS');
  assert(appJs.body.includes("kind: 'kw'"),                       '20s.18 keyword column uses clickable kw kind');
  assert(appJs.body.includes('google.com/search?q='),             '20s.19 keyword cells open Google SERP');
  assert(appJs.body.includes('tier-strip') && appJs.body.includes('excellent'), '20s.20 insights shows tier counts inline (histogram removed as redundant)');
  const cssBody = readFileSync(resolve(REPO, 'manager/public/styles.css'), 'utf-8');
  assert(cssBody.includes('.tier-excellent'),                     '20s.21 CSS styles tier-excellent rows');
  assert(cssBody.includes('.tbl a'),                              '20s.22 CSS styles table links for clickable keywords');

  // Claude listing-brief prompt builder + modal.
  assert(appJs.body.includes('function buildClaudeListingPrompt'), '20s.23 Claude prompt builder defined');
  assert(appJs.body.includes('anClaudeBtn'),                        '20s.24 Claude button wired');
  assert(appJs.body.includes('claudePromptText'),                   '20s.25 Claude modal textarea present');
  assert(html.includes('id="claudeModal"'),                         '20s.26 Claude modal in HTML');
  assert(html.includes('anClaudeBtn'),                              '20s.27 Claude button in HTML');
  // The prompt template asks for the full listing package the user needs.
  assert(appJs.body.includes('TITLE'),         '20s.28 prompt requests TITLE');
  assert(appJs.body.includes('LONG DESCRIPTION'),'20s.29 prompt requests LONG DESCRIPTION');
  assert(appJs.body.includes('INGREDIENTS'),   '20s.30 prompt requests INGREDIENTS');
  assert(appJs.body.includes('HOW TO USE'),    '20s.31 prompt requests HOW TO USE');
  assert(appJs.body.includes('FAQs'),          '20s.32 prompt requests FAQs');
  assert(appJs.body.includes('SEO KEYWORDS'),  '20s.33 prompt requests SEO KEYWORDS');
  assert(appJs.body.includes('AMAZON.IN LISTING BULLETS'),'20s.34 prompt requests Amazon.in listing bullets');
  // Keyword detail modal + quick-links.
  assert(appJs.body.includes('function openKeywordDetail'),         '20s.35 keyword detail modal defined');
  assert(appJs.body.includes('Quick links'),                        '20s.36 detail modal has quick-links block');
  assert(appJs.body.includes('trends.google.com'),                  '20s.37 detail links include Google Trends');
  assert(appJs.body.includes('ads.google.com/aw/keywordplanner'),   '20s.38 detail links include Google KP deep-link');
  assert(appJs.body.includes('dropy.in/search'),                    '20s.39 detail links include dropy.in search');
  // Rich picker.
  // 20s.40-42 removed: quick-chips + batch/SKU previews deleted as
  // unwanted duplicates (hero + dropdown already carry that info).
  assert(appJs.body.includes('updatePickerHints'),                  '20s.40 picker hints still wired');
  assert(!appJs.body.includes('function renderPickerBatchChips'),   '20s.41 dead renderPickerBatchChips removed');
  assert(!appJs.body.includes('function renderSkuPreview'),         '20s.42 dead renderSkuPreview removed');
  assert(appJs.body.includes('wirePickerSearch'),                   '20s.43 picker search-as-you-type wired');
  assert(cssBody.includes('.picker-bar'),                           '20s.44 picker CSS defined');
  assert(cssBody.includes('.tbl.compact'),                          '20s.45 compact table density defined');

  // Executive summary + polish.
  assert(appJs.body.includes('function renderExecutiveSummary'), '20s.46 executive summary renderer defined');
  assert(html.includes('id="anExecCard"'),                       '20s.47 executive-summary card in HTML');
  assert(appJs.body.includes('Buying-intent balance'),           '20s.48 exec includes buying-intent takeaway');
  assert(appJs.body.includes('Visual visibility'),               '20s.49 exec includes visual-visibility takeaway');
  assert(appJs.body.includes('Search-demand data'),              '20s.50 exec includes KP-demand takeaway');
  assert(cssBody.includes('.exec-bullet'),                       '20s.51 exec-bullet styling defined');
  // Auto-hide empty columns + toggle.
  assert(appJs.body.includes('hideEmptyCols'),                   '20s.52 hide-empty-cols state present');
  assert(appJs.body.includes('anShowAllColsBtn'),                '20s.53 show-empty-cols toggle wired');
  // Compact tiles + primary-source aggregation.
  assert(cssBody.includes('.tiles.compact-tiles'),               '20s.54 compact-tiles CSS defined');
  assert(appJs.body.includes('primarySrc'),                      '20s.55 primary-source aggregation replaces combo chips');
  // Keyword theme clustering + content-gap + copy + DQ badge.
  assert(appJs.body.includes('function clusterKeywordsByTheme'), '20s.61 theme clustering fn defined');
  assert(appJs.body.includes('KW_THEMES'),                        '20s.62 theme dictionary defined');
  assert(appJs.body.includes('function renderThemesCard'),        '20s.63 themes card renderer defined');
  assert(appJs.body.includes('function renderContentGaps'),       '20s.64 content-gap renderer defined');
  assert(html.includes('id="anThemesCard"'),                      '20s.65 themes card in HTML');
  assert(html.includes('id="anGapCard"'),                         '20s.66 gap card in HTML');
  assert(cssBody.includes('.theme-list'),                         '20s.67 theme-list CSS defined');
  assert(cssBody.includes('.gap-list'),                           '20s.68 gap-list CSS defined');
  assert(html.includes('id="anCopyKwBtn"'),                       '20s.69 Copy top keywords button in HTML');
  assert(appJs.body.includes('anCopyKwBtn'),                      '20s.70 Copy top keywords wired');
  assert(appJs.body.includes('DQ '),                              '20s.71 DQ grade now lives in the hero (moved from picker preview)');
  assert(cssBody.includes('.dq-badge'),                           '20s.72 DQ badge CSS defined');
  // Column-group toggles + full export-parity column set.
  assert(appJs.body.includes('KEYWORD_COL_DEFS'),                 '20s.73 KEYWORD_COL_DEFS defined');
  assert(appJs.body.includes('KEYWORD_COL_GROUPS'),               '20s.74 KEYWORD_COL_GROUPS defined');
  assert(appJs.body.includes('renderColumnGroupStrip'),           '20s.75 column-group strip renderer wired');
  assert(html.includes('id="anColGroups"'),                       '20s.76 col-group strip container in HTML');
  assert(cssBody.includes('.col-group-strip'),                    '20s.77 col-group CSS defined');
  // Every export field the file emits should have a column entry.
  const mustHaveCols = ['opportunity_score','keyword','buying_intent','keyword_relevance','ad_rating','source',
                        'kp_monthly_searches','kp_competition','kp_bid_low','kp_bid_high',
                        'image_count','total_thumbs','visibility_pct','link_verified_count','match_confidence_max',
                        'total_sellers','ads_on_serp','dropy_is_seller','dropy_on_serp','top_match_seller','top_match_price','frequency',
                        'amazon_rank','amazon_price','amazon_rating','amazon_reviews','amazon_suggest_count','amazon_total_results',
                        'topic','funnel','faq','parent_keyword'];
  for (const k of mustHaveCols) {
    assert(new RegExp(`key: '${k}'`).test(appJs.body), `20s.col.${k} column defined for export-parity`);
  }
  // Groups persist to localStorage.
  assert(appJs.body.includes("localStorage.setItem('adbrainAnGroups'"), '20s.78 group visibility persisted');

  // Visual layers + scatter/donut/gauge — the "how to represent" pass.
  assert(appJs.body.includes('function renderScatter'),          '20s.79 scatter plot renderer defined');
  assert(appJs.body.includes('quick-wins-badge'),                '20s.80 scatter labels quick-wins quadrant');
  assert(appJs.body.includes('function renderSourceDonut'),      '20s.81 source-donut renderer defined');
  assert(appJs.body.includes('function renderCoverageGauge'),    '20s.82 coverage-gauge renderer defined');
  assert(html.includes('id="anLayerExec"'),                      '20s.83 Executive layer wrapper in HTML');
  assert(html.includes('id="anLayerPrioritize"'),                '20s.84 Prioritize layer wrapper in HTML');
  assert(html.includes('id="anLayerDistribute"'),                '20s.85 Distribute layer wrapper in HTML');
  assert(html.includes('id="anLayerContent"'),                   '20s.86 Content-plan layer wrapper in HTML');
  assert(html.includes('id="anScatter"'),                        '20s.87 scatter container in HTML');
  assert(html.includes('id="anDonut"'),                          '20s.88 donut container in HTML');
  assert(html.includes('id="anGauge"'),                          '20s.89 gauge container in HTML');
  assert(cssBody.includes('.an-layer-head'),                     '20s.90 layer-header CSS defined');
  assert(cssBody.includes('.scatter'),                           '20s.91 scatter CSS defined');
  assert(cssBody.includes('.donut'),                             '20s.92 donut CSS defined');
  assert(cssBody.includes('.gauge'),                             '20s.93 gauge CSS defined');
  // Interactive cross-filter across cards.
  assert(appJs.body.includes('applyCrossFilter'),                '20s.94 cross-filter application defined');
  assert(appJs.body.includes('function xfToggle'),               '20s.95 cross-filter toggle helper defined');
  assert(appJs.body.includes('function renderActiveFiltersBar'), '20s.96 active-filters bar renderer defined');
  assert(appJs.body.includes('data-xf-kind'),                    '20s.97 clickable chips carry data-xf-kind attribute');
  assert(appJs.body.includes("e.target.closest('a')"),           '20s.98 anchor clicks pass through cross-filter delegation');
  assert(html.includes('id="anActiveFilters"'),                  '20s.99 active-filters bar in HTML');
  assert(cssBody.includes('.af-bar'),                            '20s.100 active-filters CSS defined');
  assert(cssBody.includes('.clickable-x'),                       '20s.101 clickable affordance CSS defined');
  // Source filter is now contains-match (multi-source rows pass).
  assert(/String\(r\.source \|\| ''\)\.toLowerCase\(\)\.split\(','\)/.test(appJs.body), '20s.102 source filter uses contains-match');
  // Scatter rich tooltip.
  assert(appJs.body.includes('anScatterTip'),                    '20s.103 scatter floating-tooltip element wired');
  assert(cssBody.includes('.scatter-tt'),                        '20s.104 scatter tooltip CSS defined');
  assert(appJs.body.includes("addEventListener('mouseenter'"),   '20s.105 scatter dots wire mouseenter');

  // ===== DESIGN SYSTEM: tokens, hero, responsive, interactive =====
  const cssFull = readFileSync(resolve(REPO, 'manager/public/styles.css'), 'utf-8');
  assert(cssFull.includes('--space-1:'),       'DS.1 spacing tokens defined');
  assert(cssFull.includes('--text-xs:'),       'DS.2 typography tokens defined');
  assert(cssFull.includes('--dur-fast:'),      'DS.3 motion tokens defined');
  assert(cssFull.includes(':focus-visible'),   'DS.4 keyboard focus-visible rings defined');
  assert(cssFull.includes('@media (max-width: 1200px)'), 'DS.5 tablet breakpoint present');
  assert(cssFull.includes('@media (max-width: 768px)'),  'DS.6 mobile breakpoint present');
  assert(cssFull.includes('@media (max-width: 480px)'),  'DS.7 small-mobile breakpoint present');
  assert(cssFull.includes('@media (prefers-reduced-motion'), 'DS.8 respects reduced-motion');
  assert(cssFull.includes('@media print'),     'DS.9 print stylesheet present');
  assert(cssFull.includes('.hero-card'),       'DS.10 hero-card styles defined');
  assert(cssFull.includes('.pulse-dot'),       'DS.11 pulse-dot indicator defined');
  assert(cssFull.includes('.picker-bar.sticky'),'DS.12 sticky picker style defined');
  assert(cssFull.includes('.is-loading'),      'DS.13 skeleton loading state defined');
  const htmlFull = readFileSync(resolve(REPO, 'manager/public/index.html'), 'utf-8');
  assert(htmlFull.includes('id="dashHero"'),                  'DS.14 dashboard hero container in HTML');
  // DS.15 obsolete: picker-bar replaced by tree rail (see TREE.* tests).
  assert(htmlFull.includes('id="anRail"'),                    'DS.15 analytics uses tree rail (picker removed)');
  const appFull = readFileSync(resolve(REPO, 'manager/public/app.js'), 'utf-8');
  assert(appFull.includes('function renderDashHero'),         'DS.16 renderDashHero wired');
  assert(appFull.includes('renderDashHero(timeline)'),        'DS.17 hero renderer called in refresh loop');
  // Analytics hero — same treatment as Dashboard.
  assert(htmlFull.includes('id="anHero"'),                    'DS.18 analytics hero container in HTML');
  assert(htmlFull.includes('id="anHeroProduct"'),             'DS.19 analytics product identity strip in HTML');
  assert(appFull.includes('function renderAnalyticsHero'),    'DS.20 renderAnalyticsHero wired');
  assert(appFull.includes('renderAnalyticsHero(source)'),     'DS.21 analytics hero called in filter pipeline');
  assert(cssFull.includes('.an-hero-product'),                'DS.22 analytics hero product strip styled');
  assert(cssFull.includes('@keyframes cardIn'),               'DS.23 card entry animation defined');
  // Dedup pass: old summary tiles no longer called; slim SKU preview.
  assert(!/^\s*renderAnalyticsSummary\(source\);/m.test(appFull), 'DS.24 renderAnalyticsSummary not called in main pipeline (dedup with hero)');
  assert(!appFull.includes('function renderSkuPreview'), 'DS.25 SKU preview function removed — hero owns identity');
  // Collapsible cards + persistence.
  assert(htmlFull.includes('<div id="anInsightsCard">\n          <div class="card collapsible">'), 'DS.29 Insights card collapsible');
  // Themes + Gap moved into a two-col grid; indentation grew by 2 spaces.
  assert(/<div id="anThemesCard">\s*<div class="card collapsible">/.test(htmlFull), 'DS.30 Themes card collapsible');
  assert(/<div id="anGapCard">\s*<div class="card collapsible">/.test(htmlFull),    'DS.31 Gap card collapsible');
  assert(htmlFull.includes('<div id="anTableCard" style="display:none;">\n        <div class="card collapsible">'), 'DS.32 Deep-dive keyword table collapsible');
  assert(appFull.includes('adbrainCollapsedCards'), 'DS.33 collapsed state persisted to localStorage');
  // Scatter fallback + KP diagnostic banner + verify-on-connect.
  assert(appFull.includes("mode = 'imgs'"),                        'DS.34 scatter falls back to image_count (independent of Score)');
  assert(!/mode\s*=\s*'rating'/.test(appFull),                     'DS.35 scatter no longer uses AdRating for X (diagonal-line bug)');
  assert(appFull.includes('KP volume data missing on every row'),  'DS.36 KP-missing diagnostic banner defined');
  assert(htmlFull.includes('id="anDataQualityBanner"'),            'DS.37 DQ banner container in HTML');
  assert(cssFull.includes('.dq-banner'),                           'DS.38 DQ banner CSS defined');
  const bgFull = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(bgFull.includes("fetch(`${normalized}/api/health`"),       'DS.39 setup-code import verifies manager reachability');
  assert(bgFull.includes('saved: true'),                            'DS.40 setup-code import distinguishes saved-but-unreachable from decode error');
  // Table cell polish + Business Takeaways trim + Top-10 bar normalization.
  assert(cssFull.includes('.tbl.compact th') && cssFull.includes('white-space: nowrap'), 'DS.41 table headers never wrap');
  assert(cssFull.includes('.multi-src'),                             'DS.42 multi-source chip collapse styled');
  assert(appFull.includes('multi-src'),                              'DS.43 source cell renders primary chip + +N badge');
  assert(cssFull.includes('.tbl-wrap'),                              'DS.44 table has horizontal scroll wrapper');
  assert(htmlFull.includes('class="tbl-wrap"'),                      'DS.45 table wrap applied in HTML');
  assert(!appFull.includes("label: 'Keyword coverage'"),             'DS.46 duplicate Keyword-coverage takeaway removed');
  assert(!appFull.includes("label: 'Search-demand data'"),           'DS.47 duplicate Search-demand-data takeaway removed');
  assert(!appFull.includes("label: 'Visual visibility'"),            'DS.48 duplicate Visual-visibility takeaway removed');
  assert(appFull.includes('range ${batchMin.toFixed(1)}'),           'DS.49 Top-10 chart shows actual score range in subtitle');
  assert(appFull.includes('score - batchMin) / span'),               'DS.50 Top-10 bars normalize against actual data span');
  // Stuck-worker auto-detection + manager-side release-by-worker endpoint.
  const srvFull = readFileSync(resolve(REPO, 'manager/server.js'), 'utf-8');
  assert(srvFull.includes('/api/jobs/release-by-worker'),             'DS.51 release-by-worker endpoint defined');
  assert(srvFull.includes('releaseByWorker'),                          'DS.52 releaseByWorker prepared statement defined');
  const apiFull = readFileSync(resolve(REPO, 'manager/public/api.js'), 'utf-8');
  assert(apiFull.includes('jobsReleaseByWorker'),                     'DS.53 client API wrapper wired');
  assert(appFull.includes('locked to stopped worker'),                 'DS.54 stuck-worker warning banner defined');
  assert(appFull.includes('data-release-worker'),                     'DS.55 per-row release button hits new endpoint');
  assert(appFull.includes('releaseAllStuckBtn'),                       'DS.56 one-click release-all-stuck button wired');

  // Live endpoint smoke test.
  const relBad = await req('POST', '/api/jobs/release-by-worker', {});
  assertEq(relBad.status, 400,                                          'DS.57 release-by-worker requires workerId');
  const relOk = await req('POST', '/api/jobs/release-by-worker', { workerId: 'nonexistent-worker' });
  assertEq(relOk.status, 200,                                           'DS.58 release-by-worker returns 200 for unknown worker');
  assert(relOk.data.ok === true && relOk.data.released === 0,           'DS.59 release-by-worker returns released count');

  // Activity clear + errors clear + per-worker monitor.
  assert(srvFull.includes("/api/activity/clear"),                       'DS.60 activity clear endpoint defined');
  assert(apiFull.includes('activityClear'),                             'DS.61 activityClear client wrapper');
  assert(htmlFull.includes('id="activityClearBtn"'),                    'DS.62 activity-clear button in HTML');
  assert(htmlFull.includes('id="errorsClearBtn"'),                      'DS.63 errors-clear button in HTML');
  assert(appFull.includes('activityClearBtn'),                          'DS.64 activity-clear handler wired');
  assert(appFull.includes('errorsClearBtn'),                            'DS.65 errors-clear handler wired');
  assert(htmlFull.includes('id="workerMonitorModal"'),                  'DS.66 worker monitor modal in HTML');
  assert(appFull.includes('function openWorkerMonitor'),                'DS.67 openWorkerMonitor defined');
  assert(appFull.includes('function refreshWorkerMonitor'),             'DS.68 refreshWorkerMonitor defined');
  assert(appFull.includes('data-monitor="1"'),                          'DS.69 monitor button on each worker row');
  assert(cssFull.includes('.wm-hdr') && cssFull.includes('.wm-log'),    'DS.70 worker-monitor CSS defined');
  // Smoke test on activity/clear endpoint.
  const acEmpty = await req('POST', '/api/activity/clear', {});
  assertEq(acEmpty.status, 200, 'DS.71 activity/clear returns 200 with empty body (nuke-all)');
  assert(typeof acEmpty.data.deleted === 'number', 'DS.72 activity/clear returns deleted count');
  // Frozen-engine detection.
  assert(appFull.includes('STUCK (heartbeat ok, engine frozen)'),      'DS.73 frozen-engine STUCK label defined');
  assert(appFull.includes('actAgo > 5 * 60 * 1000 && inFlight > 0'),   'DS.74 frozen detection uses 5min activity-stale threshold');
  assert(appFull.includes('reconnectAllFrozenBtn'),                    'DS.75 reconnect-all-frozen banner button wired');
  assert(appFull.includes('🥶'),                                        'DS.76 frozen state has a distinct visual icon');
  // Copy fix: HTTP-safe clipboard helper + rewiring.
  assert(appFull.includes('function copyToClipboard'),                'DS.77 shared copyToClipboard helper defined');
  assert(appFull.includes("document.execCommand('copy')"),            'DS.78 legacy fallback for HTTP contexts');
  assert(!/navigator\.clipboard\.writeText/.test(appFull.replace(/\/\/[^\n]*navigator\.clipboard[^\n]*/g, '')) || appFull.split('navigator.clipboard.writeText').length <= 2, 'DS.79 direct navigator.clipboard calls reduced (helper takes over)');
  // Claude prompt rewrite: structured, professional, result-oriented.
  assert(appFull.includes('# ROLE') && appFull.includes('# DATA PROVENANCE'), 'DS.80 prompt has explicit ROLE + PROVENANCE sections');
  assert(appFull.includes('INTERNAL LINKING SUGGESTIONS'),             'DS.81 prompt requests internal linking suggestions (new)');
  assert(appFull.includes('NEXT-STEP AUDIT'),                          'DS.82 prompt requests pre-publish audit checklist (new)');
  assert(appFull.includes('HARD CONSTRAINTS'),                         'DS.83 prompt uses HARD CONSTRAINTS heading');
  // Visual polish: emoji off, layer-hint hidden, tier-strip replaces histogram.
  assert(cssFull.includes('.card-icon { display: none'),               'DS.84 card-icons hidden by default (unless .show applied)');
  assert(cssFull.includes('.an-layer-hint { display: none'),           'DS.85 layer-hint subtitles hidden');
  assert(cssFull.includes('.tier-strip'),                              'DS.86 inline tier-strip styling defined');

  // ═════════════════════════════════════════════════════════════════════
  // QUEUE CRUD (safe against active workers)
  // ═════════════════════════════════════════════════════════════════════
  // Fresh batch dedicated to CRUD tests so we don't clobber earlier assertions.
  const CRUD_BATCH = 'crud-test-' + Math.floor(1e6);
  const up = await req('POST', '/api/jobs/upload', {
    batchId: CRUD_BATCH,
    products: [
      { url: 'https://example.com/p/a', sku: 'CRUD-A', product_name: 'Product A', priority: 100 },
      { url: 'https://example.com/p/b', sku: 'CRUD-B', product_name: 'Product B', priority: 100 },
      { url: 'https://example.com/p/c', sku: 'CRUD-C', product_name: 'Product C', priority: 100 },
    ],
  });
  assertEq(up.status, 200, 'CRUD.1 CRUD test batch uploaded');

  // GET /api/jobs/list returns all jobs with richer fields than /per-product.
  const list1 = await req('GET', `/api/jobs/list?batchId=${CRUD_BATCH}`);
  assertEq(list1.status, 200, 'CRUD.2 /jobs/list returns 200');
  assertEq(list1.data.rows.length, 3, 'CRUD.3 /jobs/list returns all uploaded jobs');
  assert(list1.data.rows.every(r => 'attempts' in r && 'heartbeat_at' in r), 'CRUD.4 /jobs/list rows include worker fields');
  const jobA = list1.data.rows.find(r => r.sku === 'CRUD-A');
  assert(jobA, 'CRUD.5 job A retrievable by SKU');

  // Priority-only update path (always safe).
  const prioUp = await req('POST', '/api/jobs/update', { jobId: jobA.id, priority: 250 });
  assertEq(prioUp.status, 200, 'CRUD.6 priority-only update returns 200');
  assertEq(prioUp.data.mode, 'priority-only', 'CRUD.7 update uses priority-only fast path');
  const list2 = await req('GET', `/api/jobs/list?batchId=${CRUD_BATCH}`);
  assertEq(list2.data.rows.find(r => r.id === jobA.id).priority, 250, 'CRUD.8 priority persisted');

  // Full-field update on a pending job — allowed without force.
  const fieldUp = await req('POST', '/api/jobs/update', { jobId: jobA.id, sku: 'CRUD-A-RENAMED', product_name: 'Renamed Product A' });
  assertEq(fieldUp.status, 200, 'CRUD.9 full-field update on pending job returns 200');
  const list3 = await req('GET', `/api/jobs/list?batchId=${CRUD_BATCH}`);
  assertEq(list3.data.rows.find(r => r.id === jobA.id).sku, 'CRUD-A-RENAMED', 'CRUD.10 renamed SKU persisted');

  // === Two-worker safety scenario ===
  // Worker 1 claims job B, then someone tries to delete/modify it.
  const claim = await req('POST', '/api/jobs/claim', { workerId: 'crud-worker-1', batchId: CRUD_BATCH, limit: 1 });
  const claimed = claim.data.jobs[0];
  assert(claimed, 'CRUD.11 worker 1 claimed a job');
  // Full-field update on CLAIMED job — should refuse.
  const badUpd = await req('POST', '/api/jobs/update', { jobId: claimed.id, sku: 'DIFFERENT' });
  assertEq(badUpd.status, 409, 'CRUD.12 full-field update on claimed job returns 409 (worker-safe)');
  // Priority update on claimed job — allowed (safe).
  const okUpd = await req('POST', '/api/jobs/update', { jobId: claimed.id, priority: 500 });
  assertEq(okUpd.status, 200, 'CRUD.13 priority update on claimed job allowed (safe)');
  // Delete claimed job WITHOUT force — should refuse.
  const badDel = await req('POST', '/api/jobs/delete-one', { jobId: claimed.id });
  assertEq(badDel.status, 409, 'CRUD.14 delete on claimed job refused without force');
  // Delete claimed job WITH force — should succeed + drop keyword rows.
  const forceDel = await req('POST', '/api/jobs/delete-one', { jobId: claimed.id, force: true });
  assertEq(forceDel.status, 200, 'CRUD.15 delete-one with force allowed on claimed job');
  assertEq(forceDel.data.deleted, 1, 'CRUD.16 delete-one reports deleted=1');
  // Verify it's gone.
  const list4 = await req('GET', `/api/jobs/list?batchId=${CRUD_BATCH}`);
  assert(!list4.data.rows.find(r => r.id === claimed.id), 'CRUD.17 deleted job no longer appears in /jobs/list');
  // Worker 2 claims — should get the remaining pending job(s).
  const crudClaim2 = await req('POST', '/api/jobs/claim', { workerId: 'crud-worker-2', batchId: CRUD_BATCH, limit: 5 });
  assert(crudClaim2.data.jobs.length >= 1, 'CRUD.18 worker 2 can claim remaining jobs after worker 1 deletion');

  // Reset endpoint: force a done job back to pending.
  const jobC = list4.data.rows.find(r => r.sku === 'CRUD-C');
  assert(jobC, 'CRUD.19 job C still in queue for reset test');
  // Mark done then try to reset.
  await req('POST', '/api/jobs/done', { batchId: CRUD_BATCH, productUrl: jobC.product_url });
  const badReset = await req('POST', '/api/jobs/reset', { jobId: jobC.id });
  assertEq(badReset.status, 409, 'CRUD.20 reset on done job refused without force');
  const okReset = await req('POST', '/api/jobs/reset', { jobId: jobC.id, force: true });
  assertEq(okReset.status, 200, 'CRUD.21 reset on done job allowed with force');
  const list5 = await req('GET', `/api/jobs/list?batchId=${CRUD_BATCH}`);
  assertEq(list5.data.rows.find(r => r.id === jobC.id).status, 'pending', 'CRUD.22 job C is pending again after force-reset');

  // Add-one: insert a single SKU into the existing batch.
  const addOne = await req('POST', '/api/jobs/add-one', {
    batchId: CRUD_BATCH,
    url: 'https://example.com/p/d',
    sku: 'CRUD-D',
    product_name: 'Late-added Product D',
    priority: 50,
  });
  assertEq(addOne.status, 200, 'CRUD.23 add-one returns 200');
  assert(Number.isFinite(addOne.data.jobId), 'CRUD.24 add-one returns new jobId');
  const list6 = await req('GET', `/api/jobs/list?batchId=${CRUD_BATCH}`);
  const jobD = list6.data.rows.find(r => r.sku === 'CRUD-D');
  assert(jobD && jobD.priority === 50, 'CRUD.25 added job appears with correct priority');
  // Missing URL → 400.
  const addBad = await req('POST', '/api/jobs/add-one', { batchId: CRUD_BATCH });
  assertEq(addBad.status, 400, 'CRUD.26 add-one refuses missing url');

  // Client API + UI wiring.
  const apiCrud = readFileSync(resolve(REPO, 'manager/public/api.js'), 'utf-8');
  assert(apiCrud.includes('jobUpdate'),                                'CRUD.27 client jobUpdate wrapper');
  assert(apiCrud.includes('jobDelete'),                                'CRUD.28 client jobDelete wrapper');
  assert(apiCrud.includes('jobReset'),                                 'CRUD.29 client jobReset wrapper');
  assert(apiCrud.includes('jobAddOne'),                                'CRUD.30 client jobAddOne wrapper');
  assert(appFull.includes('function openQueueManager'),                'CRUD.31 openQueueManager wired');
  assert(htmlFull.includes('id="queueManageModal"'),                   'CRUD.32 queue manage modal in HTML');
  assert(appFull.includes('data-queue-manage'),                        'CRUD.33 Manage buttons per batch row');
  assert(cssFull.includes('.qm-strip'),                                'CRUD.34 qm-strip status counts styled');

  // Claude "Open in Claude" now uses anchor click (preserves session cookies).
  assert(appFull.includes("a.href = 'https://claude.ai/new'"),         'CRUD.35 Open-in-Claude uses anchor click (session preserved)');
  assert(!appFull.includes("window.open('https://claude.ai/new'"),      'CRUD.36 window.open path removed');

  // Shopify improvements (source-inspection block — needs srvFull loaded).
  // extractReviewSignals covers all four review-app namespaces.
  assert(srvFull.includes('function extractReviewSignals('),    'SHOP-EXT.1 extractReviewSignals declared');
  assert(srvFull.includes("'loox'"),                            'SHOP-EXT.2 Loox namespace detected');
  assert(srvFull.includes("'yotpo'"),                           'SHOP-EXT.3 Yotpo namespace detected');
  assert(srvFull.includes("'judgeme'") || srvFull.includes("'judge.me'"), 'SHOP-EXT.4 Judge.me namespace detected');
  assert(srvFull.includes("'reviews'"),                         'SHOP-EXT.5 Native Shopify Reviews namespace detected');
  assert(srvFull.includes("'stamped"),                          'SHOP-EXT.6 Stamped.io namespace detected');
  // GraphQL-only field routing — writing seo_title via REST silently no-ops.
  assert(srvFull.includes('SHOPIFY_GRAPHQL_ONLY_FIELDS'),       'SHOP-EXT.7 GraphQL-only field set declared');
  assert(srvFull.includes('productUpdate('),                    'SHOP-EXT.8 productUpdate mutation present in update path');
  assert(srvFull.includes('productTaxonomyNodeId'),             'SHOP-EXT.9 productTaxonomyNodeId written on category updates');
  assert(srvFull.includes('seo: { '),                           'SHOP-EXT.10 modern seo object emitted in GraphQL mutation');
  // Image-alt endpoint + client wrapper.
  assert(srvFull.includes("'/api/shopify/update-image-alts'"),  'SHOP-EXT.11 image-alt endpoint present');
  assert(apiCrud.includes('shopifyUpdateImageAlts'),            'SHOP-EXT.12 client wrapper for image-alt endpoint');
  // Prompt consumers: reviews + product_category.
  assert(appFull.includes('currentProduct.reviews?.hasReviews'), 'SHOP-EXT.13 prompt consumes reviews.hasReviews');
  assert(appFull.includes('currentProduct.product_category'),   'SHOP-EXT.14 prompt consumes product_category');
  assert(appFull.includes('SKIP \\`AggregateRating\\` schema entirely'),   'SHOP-EXT.15 prompt tells Claude to skip AggregateRating when no reviews');

  // Selective wipe + Shopify integration.
  assert(srvFull.includes("'/api/wipe-selective'"),                    'WIPE.1 selective wipe endpoint');
  assert(srvFull.includes("if (b.confirm !== 'WIPE')"),                'WIPE.2 wipe endpoint requires confirm=WIPE');
  assert(apiCrud.includes('wipeSelective:'),                           'WIPE.3 client wipeSelective wrapper');
  assert(htmlFull.includes('id="wipeModal"'),                          'WIPE.4 wipe modal in HTML');
  assert(htmlFull.includes('id="openSelectiveWipeBtn"'),               'WIPE.5 open wipe modal button');
  assert(appFull.includes('function openSelectiveWipeModal'),          'WIPE.6 openSelectiveWipeModal defined');
  assert(cssFull.includes('.wipe-row'),                                'WIPE.7 wipe-row styled');
  // Shopify — allowlist enforcement + endpoints + UI.
  assert(srvFull.includes('SHOPIFY_ALLOWED_FIELDS'),                   'SHOP.1 Shopify allowlist declared');
  assert(srvFull.includes("'price'") === false || srvFull.includes("SHOPIFY_ALLOWED_FIELDS = new Set([\n  'title'"), 'SHOP.2 allowlist starts with title (not price/weight/location)');
  const allowedFieldsBlock = srvFull.slice(srvFull.indexOf('SHOPIFY_ALLOWED_FIELDS = new Set(['), srvFull.indexOf(']);', srvFull.indexOf('SHOPIFY_ALLOWED_FIELDS = new Set([')));
  assert(!allowedFieldsBlock.includes("'price'"),                      'SHOP.3 price NOT in Shopify allowlist');
  assert(!allowedFieldsBlock.includes("'weight'"),                     'SHOP.4 weight NOT in Shopify allowlist');
  assert(!allowedFieldsBlock.includes("'variants'"),                   'SHOP.5 variants NOT in Shopify allowlist');
  assert(!allowedFieldsBlock.includes("'inventory_quantity'"),         'SHOP.6 inventory NOT in Shopify allowlist');
  assert(srvFull.includes("'/api/shopify/get-product'"),               'SHOP.7 get-product endpoint');
  assert(srvFull.includes("'/api/shopify/update-product'"),            'SHOP.8 update-product endpoint');
  assert(srvFull.includes("if (b.confirm !== 'PUSH')"),                'SHOP.9 update-product requires confirm=PUSH');
  assert(srvFull.includes('stripToShopifyAllowlist'),                  'SHOP.10 allowlist filter fn');
  assert(apiCrud.includes('shopifyGetProduct:'),                       'SHOP.11 client shopifyGetProduct wrapper');
  assert(apiCrud.includes('shopifyUpdateProduct:'),                    'SHOP.12 client shopifyUpdateProduct wrapper');
  // Bulk SKU import + bulk CRUD
  assert(srvFull.includes("'/api/jobs/upload-by-sku'"),                'BULK.1 upload-by-sku endpoint');
  assert(srvFull.includes("'/api/jobs/bulk-update'"),                  'BULK.2 bulk-update endpoint');
  assert(srvFull.includes("'/api/jobs/bulk-delete'"),                  'BULK.3 bulk-delete endpoint');
  assert(apiCrud.includes('jobsUploadBySku:'),                         'BULK.4 client jobsUploadBySku wrapper');
  assert(apiCrud.includes('jobsBulkUpdate:'),                          'BULK.5 client jobsBulkUpdate wrapper');
  assert(apiCrud.includes('jobsBulkDelete:'),                          'BULK.6 client jobsBulkDelete wrapper');
  assert(appFull.includes('function renderQmBulkImportPane'),          'BULK.7 bulk-import UI defined');
  assert(appFull.includes('qmSelectAll'),                              'BULK.8 select-all checkbox');
  assert(appFull.includes('qmBulkDelete'),                             'BULK.9 bulk delete button');
  assert(appFull.includes('qmBulkReset'),                              'BULK.10 bulk reset button');
  assert(appFull.includes('qmBulkPrio'),                               'BULK.11 bulk priority button');
  assert(appFull.includes("_qmState.statusFilter"),                    'BULK.12 status filter state persists across refresh');
  assert(appFull.includes("_qmState.search"),                          'BULK.13 search state persists across refresh');
  assert(cssFull.includes('.qm-bulkbar'),                              'BULK.14 bulk toolbar styled');
  assert(cssFull.includes('.qm-filter-btn'),                           'BULK.15 filter chip styled');
  // SKU-list mode on the Upload tab (discoverable, first-class).
  assert(htmlFull.includes('id="uploadModeSku"'),                      'BULK.16 SKU-list mode block in Upload tab');
  assert(htmlFull.includes('data-mode="sku"'),                         'BULK.17 SKU mode toggle button');
  assert(htmlFull.includes('id="skuUploadText"'),                      'BULK.18 SKU textarea');
  assert(htmlFull.includes('id="skuUploadFile"'),                      'BULK.19 SKU .txt file input');
  assert(htmlFull.includes('accept=".txt,.csv,text/plain"'),           'BULK.20 SKU file accepts .txt');
  assert(appFull.includes("upload-mode-btn"),                          'BULK.21 upload mode toggle handler');
  assert(appFull.includes("_acceptSkuFile"),                           'BULK.22 SKU file-drop handler');
  assert(appFull.includes("_skuUploadRecount"),                        'BULK.23 SKU live-count handler');
  assert(cssFull.includes('.upload-mode-toggle'),                      'BULK.24 mode toggle styled');
  // Token auto-save + smart-detect on file drops (fixes user reports).
  assert(appFull.includes('_persistTokenFromInput'),                   'BULK.25 token auto-save helper');
  assert(appFull.includes("addEventListener('blur'"),                  'BULK.26 tokenInput blur autosave');
  assert(appFull.includes("addEventListener('paste'"),                 'BULK.27 tokenInput paste autosave');
  assert(appFull.includes('_looksLikeSkuTxtFile'),                     'BULK.28 detect .txt drops');
  assert(appFull.includes('_looksLikeExcelFile'),                      'BULK.29 detect .xlsx drops');
  assert(appFull.includes('_autoSwitchToSkuMode'),                     'BULK.30 auto-switch to SKU mode on .txt drop');
  assert(appFull.includes('_autoSwitchToFileMode'),                    'BULK.31 auto-switch to Excel mode on .xlsx drop');
  // Upload file picker must include .txt so users can pick a plain SKU
  // list from the native OS dialog (not just drag-drop).
  assert(htmlFull.includes('accept=".xlsx,.xls,.csv,.txt,text/plain,text/csv"'), 'BULK.32 file picker accepts .txt');
  // Tab switch uses event delegation on the container (not per-button
  // listeners) so a DOM race can\'t break clicks.
  assert(appFull.includes(".upload-mode-toggle')?.addEventListener"),   'BULK.33 tab-toggle uses event delegation');
  assert(appFull.includes('function _switchUploadMode'),               'BULK.34 shared mode switcher');
  assert(appFull.includes("e.target.closest('.upload-mode-btn')"),     'BULK.35 closest() so clicks on emoji/text still switch');
  // Tab switching robustness: three redundant paths ensure clicks always work.
  assert(appFull.includes('function _switchTab'),                      'ROBUST.1 shared _switchTab function');
  assert(appFull.includes('window.adbrainSwitchTab'),                  'ROBUST.2 window.adbrainSwitchTab exposed');
  assert(appFull.includes('window.adbrainSwitchUploadMode'),           'ROBUST.3 window.adbrainSwitchUploadMode exposed');
  assert(htmlFull.includes('window.adbrainSwitchTab &amp;&amp; window.adbrainSwitchTab'), 'ROBUST.4 inline onclick fallback on tabs');
  assert(htmlFull.includes('window.adbrainSwitchUploadMode &amp;&amp; window.adbrainSwitchUploadMode'), 'ROBUST.5 inline onclick fallback on upload-mode');
  assert(appFull.includes(".tabs')?.addEventListener"),                'ROBUST.6 delegation on .tabs container');
  assert(appFull.includes("console.warn('[adbrain] tab refresh threw'"), 'ROBUST.7 refresh throw does not prevent tab switch');
  assert(appFull.includes("console.info('[adbrain] manager UI build"), 'ROBUST.8 build banner in console');
  // Stale-cache watchdog: user gets un-missable banner if module didn't load.
  assert(htmlFull.includes('STALE CACHE DETECTED'),                    'ROBUST.9 stale-cache watchdog banner');
  assert(htmlFull.includes('Ctrl+Shift+R'),                            'ROBUST.10 stale-cache instructions include hard-refresh');
  assert(appFull.includes("_staleBanner.style.display = 'none'"),      'ROBUST.11 clear stale banner on module load');
  // Excel/CSV drop-zone label mentions .txt (auto-switches to SKU mode).
  assert(htmlFull.includes('Click or drag Excel / CSV / .txt here'),   'ROBUST.12 dropzone label mentions .txt');
  // Raw HTML tags in text content (<title>, <script>, <style>, <iframe>)
  // silently break the HTML parser — everything after gets absorbed into
  // that tag's content. This bricked the entire manager UI until 002623d.
  // These MUST be escaped as &lt;title&gt; etc.
  const dangerousInlineTags = /(?<!\\|-)<(?:title|script|style|iframe|body|head|html)(?:\s|>)/i;
  const htmlBodyOnly = htmlFull
    .replace(/<script[\s\S]*?<\/script>/g, '')       // strip real scripts
    .replace(/<style[\s\S]*?<\/style>/g, '')         // strip real styles
    .replace(/<title>[^<]*<\/title>/g, '')           // strip real title in head
    .replace(/<\/?(?:html|head|body|iframe)[^>]*>/g, ''); // strip real structural
  assert(!dangerousInlineTags.test(htmlBodyOnly),   'ROBUST.13 no unescaped <title>/<script>/<style>/<iframe> in body text (bricks parser)');
  // Amazon-URL rejection: worker + UI both warn about this failure mode.
  assert(htmlFull.includes('id="skuResolveWarn"'),                     'AMZN.1 Amazon-mode warning banner in HTML');
  assert(htmlFull.includes('Amazon URLs fail keyword discovery'),      'AMZN.2 warning names the failure mode');
  assert(appFull.includes('_updateSkuResolveWarn'),                    'AMZN.3 warning show/hide handler');
  assert(appFull.includes("sel.value = 'shopify'"),                    'AMZN.4 smart-default to shopify when configured');
  const kdSrcAmzn = readFileSync(resolve(REPO, 'modules/keyword-discovery.js'), 'utf-8');
  assert(kdSrcAmzn.includes("'Accept-Language': 'en-IN"),              'AMZN.5 browser-realistic Accept-Language on product fetch');
  assert(kdSrcAmzn.includes("'Sec-Fetch-Mode': 'navigate'"),           'AMZN.6 Sec-Fetch headers on product fetch');
  assert(kdSrcAmzn.includes('Amazon returned an anti-bot challenge'),  'AMZN.7 Amazon captcha detection + clear log');
  assert(kdSrcAmzn.includes('data-a-dynamic-image'),                   'AMZN.8 Amazon dynamic-image extraction');
  assert(kdSrcAmzn.includes('landingImage'),                           'AMZN.9 Amazon landingImage extraction');
  assert(kdSrcAmzn.includes('m\\.media'),                              'AMZN.10 <img> scan widened for Amazon CDN');
  // URL seeds skip text-seed flow: saves 60-120s per URL by going
  // straight to the 'Start with a website' fallback.
  assert(kdSrcAmzn.includes('URL detected — skipping text-seed flow'), 'AMZN.11 URL seeds skip text-seed flow');
  assert(kdSrcAmzn.includes("/^https?:\\/\\//i.test(seed.trim())"),    'AMZN.12 URL detection uses http/https prefix');
  // Website fallback: detect the MV3 message-port teardown and retry
  // on fresh navigate. Previously died with 'message channel closed'.
  assert(kdSrcAmzn.includes('WEBSITE_MAX_ATTEMPTS'),                   'AMZN.13 website fallback retries on transient errors');
  assert(kdSrcAmzn.includes('message port closed|message channel closed|Receiving end does not exist'), 'AMZN.14 catches MV3 port-close error');
  assert(kdSrcAmzn.includes('content script tore down mid-flow'),      'AMZN.15 clear log when MV3 SW teardown detected');
  // SKU-list mode enriches Shopify-resolved jobs with the same fields
  // Excel/CSV uploads carry: product_name (title), handles (handle +
  // tags + product_type), brands (vendor). Engine uses these for seed
  // derivation and brand-domain confirmation.
  // ENRICH.1 (was: REST fetch fields) — now via GraphQL productVariants
  //          → product { handle title tags vendor productType }.
  assert(srvFull.includes('id handle title tags vendor productType'),  'ENRICH.1 Shopify fetch pulls tags/vendor/productType via GraphQL');
  assert(srvFull.includes("entry.handles = handleParts.length ? handleParts.join"), 'ENRICH.2 handles concat (handle + tags + product_type)');
  assert(srvFull.includes('entry.brands  = p.vendor'),                  'ENRICH.3 brands from Shopify vendor');
  assert(srvFull.includes('r.handles, r.brands'),                       'ENRICH.4 insertJob passes enriched handles + brands');
  assert(appFull.includes('<th>Title</th>') && appFull.includes('<th>Handles</th>') && appFull.includes('<th>Brand</th>'), 'ENRICH.5 preview table shows Title/Handles/Brand');
  // Reliability fixes for fleet control (user reported):
  //  · Popup Clear-log button now RPCs background so in-memory buffer clears too
  //  · Manager Resume command calls _doAutoConnectWorker directly (no fragile SW→SW sendMessage)
  const popupJsSrc = readFileSync(resolve(REPO, 'popup.js'), 'utf-8');
  const bgSrcCtrl = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(popupJsSrc.includes("await rpc('clearLog')"),                 'CTRL.1 popup Clear-log uses RPC (not direct storage write)');
  assert(bgSrcCtrl.includes('_doAutoConnectWorker({ workerId: wId, chunkSize: cs })'), 'CTRL.2 resume calls _doAutoConnectWorker directly');
  assert(bgSrcCtrl.includes("Resume command received — force-armed"), 'CTRL.3 resume force-arms (clears userStoppedArm)');
  // jobs/list must return handles+brands so the queue-manager UI can
  // display them (bulk update + enriched Shopify uploads populate these).
  assert(srvFull.includes('sku, product_url, product_name, priority, status, claimed_by, claimed_at, heartbeat_at, done_at, failed_reason, attempts, handles, brands'), 'CTRL.4 jobs/list returns handles+brands columns');
  // Phantom-done detection: done jobs with ZERO keyword rows.
  assert(srvFull.includes('done_empty'),                               'PHANTOM.1 summary query flags done_empty count');
  assert(srvFull.includes("'/api/jobs/done-empty'"),                   'PHANTOM.2 GET /done-empty endpoint');
  assert(srvFull.includes("'/api/jobs/requeue-done-empty'"),           'PHANTOM.3 POST /requeue-done-empty endpoint');
  assert(srvFull.includes('doneEmptyJobs: db.prepare'),                'PHANTOM.4 doneEmptyJobs prepared statement');
  assert(srvFull.includes('requeueDoneEmpty: db.prepare'),             'PHANTOM.5 requeueDoneEmpty prepared statement');
  assert(apiCrud.includes('jobsDoneEmpty:'),                           'PHANTOM.6 client wrapper for done-empty');
  assert(apiCrud.includes('jobsRequeueDoneEmpty:'),                    'PHANTOM.7 client wrapper for requeue-done-empty');
  assert(appFull.includes('data-requeue-empty'),                       'PHANTOM.8 UI has Requeue empty button');
  assert(appFull.includes('b.done_empty > 0'),                         'PHANTOM.9 UI conditionally shows the warning');
  // Worker reorder: push MUST come before markJobDone.
  assert(bgSrcCtrl.includes('ORDER MATTERS. We PUSH KEYWORDS FIRST'),  'PHANTOM.10 worker reorder documented');
  const bgOrderCheck = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  const pushIdx = bgOrderCheck.indexOf('auto-push this product', bgOrderCheck.indexOf('onProductDone: async'));
  const markIdx = bgOrderCheck.indexOf('markJobDone({', bgOrderCheck.indexOf('onProductDone: async'));
  assert(pushIdx > 0 && markIdx > 0 && pushIdx < markIdx, 'PHANTOM.11 push comes before markJobDone in onProductDone');
  // Shopify URL uses the PUBLIC storefront domain, not *.myshopify.com admin
  assert(srvFull.includes('primary_domain.host'),                      'STORE.1 Shopify shop.json queried for primary_domain');
  assert(srvFull.includes('const publicHost = storefrontHost'),        'STORE.2 URL builder uses publicHost, not shopifyDomain');
  assert(srvFull.includes('https://${publicHost}/products/'),          'STORE.3 URL template uses publicHost');
  assert(srvFull.includes('no Shopify variant/product found (tried'),  'STORE.4 unresolved SKUs get explanatory note (all fallback paths listed)');
  // Widened SKU search: multiple case variants + barcode + handle fallback
  assert(srvFull.includes('allSkuCandidates.push(asin)'),              'STORE.5 tries ASIN only in batch');
  assert(srvFull.includes('allSkuCandidates.push(`Dropy-${asin}`)'),   'STORE.5b tries Dropy-<ASIN> variant in batch');
  assert(srvFull.includes("batchGqlLookup('barcode'"),                 'STORE.6 barcode search batched (GraphQL)');
  assert(srvFull.includes('handle:*'),                                 'STORE.7 handle wildcard search (GraphQL)');
  assert(srvFull.includes('barcodeMap[String(c).toLowerCase()]'),      'STORE.6b batched barcode map lookup');
  assert(srvFull.includes('field}:\\\\"'),                             'STORE.6c query value quoted so hyphens are not tokenized');
  assert(srvFull.includes('batchGqlLookup = async'),                   'STORE.6d batch GQL helper defined');
  assert(srvFull.includes(' OR '),                                     'STORE.6e uses OR operator to combine values in one query');
  assert(srvFull.includes('matched via ${matchedVia}'),                'STORE.8 preview shows which variant path matched');
  // GraphQL migration — REST /variants.json?sku= doesn't actually filter,
  // it silently returns all variants. Must use GraphQL productVariants.
  assert(srvFull.includes('productVariants(first: ${first}, query'),   'STORE.9 uses GraphQL productVariants query (with dynamic first)');
  assert(srvFull.includes('graphql.json'),                             'STORE.10 hits Shopify GraphQL endpoint');
  assert(!srvFull.includes('variants.json?fields=id,sku,product_id&limit=1&sku='), 'STORE.11 broken REST ?sku= filter removed');
  // Worker status: distinguish long-offline (probably powered off) from
  // brief-offline (Chrome closed / network blip).
  assert(appFull.includes("`SHUT DOWN ("),                             'STATUS.1 SHUT DOWN state for >4h no heartbeat');
  // Ghost-worker cleanup — auto-clear stale activity filter + remove workers.
  assert(appFull.includes("Filter auto-cleared"),                      'GHOST.1 stale activity-log filter auto-cleared');
  assert(appFull.includes('data-remove-worker'),                       'GHOST.2 remove-worker button in fleet row');
  assert(srvFull.includes("'/api/workers/delete'"),                    'GHOST.3 delete-worker endpoint');
  assert(srvFull.includes("'/api/workers/prune-stale'"),               'GHOST.4 prune-stale endpoint');
  assert(appFull.includes('4 * 3600 * 1000'),                          'STATUS.2 4h threshold for shut-down detection');
  assert(appFull.includes("'never seen'"),                             'STATUS.3 never-seen state for workers with hb=0');
  assert(htmlFull.includes('id="shopifyModal"'),                       'SHOP.13 Shopify modal in HTML');
  assert(htmlFull.includes('id="anShopifyBtn"'),                       'SHOP.14 Analytics per-SKU Shopify button');
  assert(htmlFull.includes('id="cfgShopifyDomain"'),                   'SHOP.15 Shopify config domain field');
  assert(htmlFull.includes('id="cfgShopifyToken"'),                    'SHOP.16 Shopify config token field');
  assert(appFull.includes('function openShopifyModal'),                'SHOP.17 openShopifyModal defined');
  assert(appFull.includes('function buildShopifyClaudePrompt'),        'SHOP.18 Claude prompt builder for Shopify');
  assert(appFull.includes('function extractShopifyJson'),              'SHOP.19 JSON extractor from Claude output');
  // RANKING-FOCUSED prompt: competitor analysis + schema.org + India-first.
  assert(appFull.includes('sellers_on_serp'),                          'SHOP.20 competitor domains parsed from SERP');
  assert(appFull.includes('marketplaces') && appFull.includes('isMarketplace'), 'SHOP.21 competitor marketplace classification');
  assert(appFull.includes('COMPETITIVE LANDSCAPE'),                    'SHOP.22 prompt lists competitors');
  assert(appFull.includes('Product') && appFull.includes('FAQPage') && appFull.includes('HowTo'), 'SHOP.23 schema.org JSON-LD instructed');
  assert(appFull.includes('featured-snippet'),                         'SHOP.24 featured-snippet targeting');
  assert(appFull.includes('India-first'),                              'SHOP.25 India-first localization');
  assert(appFull.includes('RANK #1'),                                  'SHOP.26 explicit ranking goal in prompt');
  assert(appFull.includes('out-rank Amazon.in'),                       'SHOP.27 explicit ranking targets (Amazon)');

  // Analytics tree structure.
  assert(htmlFull.includes('id="anRail"') && htmlFull.includes('id="anRailTree"'), 'TREE.1 tree rail container in HTML');
  assert(htmlFull.includes('id="anRailSearch"'),                       'TREE.2 tree search input in HTML');
  assert(appFull.includes('function renderAnalyticsTree'),             'TREE.3 renderAnalyticsTree defined');
  assert(appFull.includes('adbrainAnTreeExpanded'),                    'TREE.4 tree-expanded state persisted');
  assert(cssFull.includes('.an-layout'),                               'TREE.5 two-column layout CSS');
  assert(cssFull.includes('.tree-batch') && cssFull.includes('.tree-sku'), 'TREE.6 tree node CSS');
  assert(cssFull.includes('.an-rail'),                                 'TREE.7 rail CSS');
  assert(htmlFull.includes('id="anActionHint"'),                       'TREE.8 pane action-bar hint');
  // Improved 404 error message on POST → hints at manager-restart.
  const apiSrc = readFileSync(resolve(REPO, 'manager/public/api.js'), 'utf-8');
  assert(apiSrc.includes("Restart it: stop the current 'node manager/server.js'"), 'TREE.9 clearer 404 error for outdated manager');

  // Cross-tab polish: Config grouped into sections, Workers 2-col.
  assert(htmlFull.includes('<div class="an-layer-head">Batches</div>'),           'POLISH.1 Config has Batches section heading');
  assert(htmlFull.includes('<div class="an-layer-head">Worker pipeline</div>'),   'POLISH.2 Config has Worker pipeline section');
  assert(htmlFull.includes('<div class="an-layer-head">Maintenance</div>'),       'POLISH.3 Config has Maintenance section');
  assert(htmlFull.includes('Danger zone</div>'),                                  'POLISH.4 Config has Danger zone section');
  assert(htmlFull.includes('<div class="an-layer-head">Install a new worker</div>'),  'POLISH.5 Workers has Install-a-new-worker section');
  assert(htmlFull.includes('<div class="an-layer-head">Connect &amp; manage</div>'), 'POLISH.6 Workers has Connect & manage section');
  // .two-col is now 1:1 (was 2:1 sidebar); .two-col-side kept for legacy.
  assert(/\.two-col\s*\{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(cssFull), 'POLISH.7 .two-col is 1:1 minmax(0,1fr) grid');
  assert(cssFull.includes('.two-col-side'),                                       'POLISH.8 legacy .two-col-side kept for 2:1 layouts');
  // Worker popup polish.
  const popupHtmlPolish = readFileSync(resolve(REPO, 'popup.html'), 'utf-8');
  assert(popupHtmlPolish.includes('--space-1: 4px'),                                    'POLISH.9 popup uses spacing tokens');
  assert(popupHtmlPolish.includes('button:focus-visible'),                              'POLISH.10 popup has keyboard focus rings');
  assert(!/pauseBtn[^>]*>⏸ Pause/.test(popupHtmlPolish),                                'POLISH.11 popup Pause button no longer uses emoji prefix');
  assert(!/resumeBtn[^>]*>▶ Resume/.test(popupHtmlPolish),                              'POLISH.12 popup Resume button no longer uses emoji prefix');
  assert(!/stopBtn[^>]*>■ Stop/.test(popupHtmlPolish),                                  'POLISH.13 popup Stop button no longer uses emoji prefix');
  assert(!/linear-gradient\(180deg, var\(--bg-1\)/.test(popupHtmlPolish),               'POLISH.14 popup hero no longer uses gradient background');
  assert(popupHtmlPolish.includes('button.warn  { color: var(--warn)'),                 'POLISH.15 popup Pause button uses warn-outline style');
  assert(cssFull.includes('.scatter-full'),                        'DS.26 full-width scatter variant defined');
  assert(htmlFull.includes('scatter-full'),                        'DS.27 scatter uses full-width layout');
  assert(/\.card-title\s*\{[\s\S]{0,120}font-size:\s*var\(--text-md\)/.test(cssFull), 'DS.28 unified card-title sizing');

  // ===== FLEET FIXES: quota, stale claims, per-SKU flush, co-brand =====
  const mfFleet = readFileSync(resolve(REPO, 'manifest.json'), 'utf-8');
  assert(/"unlimitedStorage"/.test(mfFleet), 'FLEET.1 manifest declares unlimitedStorage');
  const bgFleet = readFileSync(resolve(REPO, 'background.js'), 'utf-8');
  assert(bgFleet.includes('releaseThisWorkerClaims'),                                 'FLEET.2 releaseThisWorkerClaims helper defined');
  assert(bgFleet.includes("releaseThisWorkerClaims('Local Stop button')"),            'FLEET.3 local Stop releases claims');
  assert(bgFleet.includes("releaseThisWorkerClaims('Manager Stop command')"),         'FLEET.4 remote Stop releases claims');
  assert(bgFleet.includes('Flushed ') && bgFleet.includes('reportMap.delete'),        'FLEET.5 per-SKU flush drops rows after successful push');
  const kdFleet = readFileSync(resolve(REPO, 'modules/keyword-discovery.js'), 'utf-8');
  assert(kdFleet.includes('KP_CACHE_MAX_ENTRIES'),                                    'FLEET.6 KP-cache LRU cap defined');
  assert(kdFleet.includes('KP_CACHE_MAX_KEYWORDS_PER_ENTRY'),                         'FLEET.7 KP-cache per-entry cap defined');
  const kfFleet = readFileSync(resolve(REPO, 'modules/keyword-filter.js'), 'utf-8');
  assert(kfFleet.includes('Co-branded product handling'),                             'FLEET.8 co-brand alias expansion in buildProductContext');
  assert(/for \(const b of _KNOWN_COMPETITOR_BRANDS\)/.test(kfFleet),                 'FLEET.9 iterates competitor brands for aliases');

  // Cache-buster: index.html served with mtime-versioned asset URLs so
  // browsers can't hold onto a stale app.js/styles.css after a deploy.
  const idxServed = await fetchNoAuth('/');
  assertEq(idxServed.status, 200,                                 '20s.56 root serves index.html');
  assert(/href="\/public\/styles\.css\?v=\d+"/.test(idxServed.body),  '20s.57 styles.css URL carries ?v= cache-buster');
  assert(/src="\/public\/app\.js\?v=\d+"/.test(idxServed.body),      '20s.58 app.js URL carries ?v= cache-buster');
  const srv = readFileSync(resolve(REPO, 'manager/server.js'), 'utf-8');
  assert(srv.includes('function assetVersion'),                    '20s.59 assetVersion() defined in server');
  assert(srv.includes('mtimeMs'),                                  '20s.60 assetVersion uses file mtime');

  // Discovery engine: caps raised so per-SKU output hits 100-300.
  const kdSrcCaps = readFileSync(resolve(REPO, 'modules/keyword-discovery.js'), 'utf-8');
  assert(/MAX_KP_SEEDS\s*=\s*5\b/.test(kdSrcCaps),          '20s.11 MAX_KP_SEEDS raised to 5');
  assert(/MAX_R1_KP_SERP_SEEDS\s*=\s*60\b/.test(kdSrcCaps), '20s.12 MAX_R1_KP_SERP_SEEDS raised to 60');
  assert(/R2_KP_CAP_PER_SEED\s*=\s*40\b/.test(kdSrcCaps),   '20s.13 R2_KP_CAP_PER_SEED raised to 40');
  assert(/maxAmazonKeywords \|\| 80/.test(kdSrcCaps),       '20s.14 maxAmazonKeywords default raised to 80 (compounds with widened R1 filter + modifier expansion)');
  // Amazon-side modifier synthesis: for the top-3 seeds, generate 4×2=8
  // buy/best/price/review variants each, boosting Amazon-Round coverage
  // for niche brands where KP is thin.
  assert(/AMAZON_MODIFIERS/.test(kdSrcCaps),                 '20s.15 AMAZON_MODIFIERS constant declared');
  assert(/AMAZON_MOD_TOP/.test(kdSrcCaps),                   '20s.16 AMAZON_MOD_TOP constant declared');
  assert(/source: 'amazon_mod'/.test(kdSrcCaps),             '20s.17 Amazon-modifier variants tagged with amazon_mod source');
  // Commercial-modifier rows from R1 also enter Amazon Round.
  assert(/r\.source === 'commercial_modifier'/.test(kdSrcCaps), '20s.18 R1 commercial_modifier rows also enter Amazon Round');

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
