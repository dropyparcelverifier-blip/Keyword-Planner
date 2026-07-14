// manager/server.js
//
// AdBrain Discovery — self-hosted MANAGER, backed by SQLite, served over
// Tailscale. Owns the job queue + atomic claim + stale-release + activity
// log + command bus + worker config + discovered-keyword storage. The
// extension's modules/discovery-jobs.js is the HTTP client for this API.
//
// Dependency-free: Node built-ins only, SQLite via the built-in `node:sqlite`
// (Node 22+/24). Run on ONE always-on machine on your tailnet:
//   node manager/server.js
//   PORT=8787 MANAGER_TOKEN=secret DB=manager/adbrain.db node manager/server.js
//
// Workers/dashboard reach it at http://<manager-tailscale-name>:8787.
//
// Concurrency: node:sqlite is synchronous and Node is single-threaded, so each
// HTTP handler (incl. the atomic claim) runs to completion before the next —
// no interleaving, no double-claims. WAL mode keeps readers non-blocking.

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT  = parseInt(process.env.PORT || '8787', 10);
const HOST  = process.env.HOST || '0.0.0.0';
const TOKEN = (process.env.MANAGER_TOKEN || '').trim();
const DB_PATH = process.env.DB || path.join(__dirname, 'adbrain.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------- DB ----------------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL,
  sku          TEXT,
  product_url  TEXT NOT NULL,
  product_name TEXT,
  priority     INTEGER DEFAULT 100,
  handles      TEXT,
  brands       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|done|failed
  claimed_by   TEXT,
  claimed_at   INTEGER,     -- epoch ms
  heartbeat_at INTEGER,
  done_at      INTEGER,
  failed_reason TEXT,
  attempts     INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE (batch_id, product_url)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS jobs_batch_idx  ON jobs (batch_id);

CREATE TABLE IF NOT EXISTS keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT,
  sku          TEXT,
  keyword      TEXT,
  product_url  TEXT,
  data         TEXT,        -- full JSON row (all export columns)
  created_at   INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE (batch_id, product_url, keyword)
);
CREATE INDEX IF NOT EXISTS keywords_batch_idx ON keywords (batch_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT, worker_id TEXT, level TEXT DEFAULT 'info', source TEXT,
  message     TEXT NOT NULL, product_url TEXT, sku TEXT,
  ts          INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS activity_batch_ts_idx ON activity_log (batch_id, ts DESC);

CREATE TABLE IF NOT EXISTS worker_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id   TEXT,               -- null = broadcast
  command     TEXT NOT NULL, payload TEXT,
  created_at  INTEGER DEFAULT (strftime('%s','now')*1000),
  created_by  TEXT, acknowledged_at INTEGER, acknowledged_by TEXT
);
CREATE INDEX IF NOT EXISTS commands_pending_idx ON worker_commands (worker_id, acknowledged_at);

CREATE TABLE IF NOT EXISTS worker_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT,               -- JSON blob of pushed run options
  active_batch_id TEXT
);
INSERT OR IGNORE INTO worker_config (id, config, active_batch_id) VALUES (1, '{}', NULL);
`);

const now = () => Date.now();

// ---------------- HTTP helpers ----------------
function send(res, code, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Manager-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }, headers || {}));
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 60 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function tokenOk(req, url) {
  if (!TOKEN) return true;
  const h = req.headers['x-manager-token'];
  if (typeof h === 'string' && h === TOKEN) return true;
  try { if (url.searchParams.get('token') === TOKEN) return true; } catch {}
  return false;
}
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' || ext === '.mjs' ? 'text/javascript'
      : ext === '.css' ? 'text/css'
      : 'application/octet-stream';
    // no-cache so users don't have to hard-refresh after each fix. The
    // manager typically serves a handful of small files locally over
    // Tailscale — cache benefit is negligible, cache pain is real.
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

// ---------------- Prepared statements ----------------
const Q = {
  insertJob: db.prepare(`INSERT INTO jobs (batch_id, sku, product_url, product_name, priority, handles, brands)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, product_url) DO UPDATE SET
      sku=excluded.sku, product_name=excluded.product_name, priority=excluded.priority,
      handles=excluded.handles, brands=excluded.brands`),
  pendingForClaim: db.prepare(`SELECT id FROM jobs WHERE status='pending' AND batch_id=? ORDER BY priority DESC, id ASC LIMIT ?`),
  claimById: db.prepare(`UPDATE jobs SET status='claimed', claimed_by=?, claimed_at=?, heartbeat_at=?, attempts=attempts+1 WHERE id=? AND status='pending'`),
  jobById: db.prepare(`SELECT * FROM jobs WHERE id=?`),
  heartbeatById: db.prepare(`UPDATE jobs SET heartbeat_at=? WHERE id=? AND claimed_by=? AND status='claimed'`),
  markDone: db.prepare(`UPDATE jobs SET status='done', done_at=? WHERE batch_id=? AND product_url=?`),
  markFailed: db.prepare(`UPDATE jobs SET status='failed', failed_reason=?, done_at=? WHERE batch_id=? AND product_url=?`),
  releaseStale: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL WHERE status='claimed' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`),
  summary: db.prepare(`SELECT batch_id,
      COUNT(*) total,
      SUM(status='pending') pending, SUM(status='claimed') claimed,
      SUM(status='done') done, SUM(status='failed') failed,
      COUNT(DISTINCT CASE WHEN status='claimed' THEN claimed_by END) active_workers,
      MAX(done_at) last_done_at
    FROM jobs GROUP BY batch_id ORDER BY batch_id DESC LIMIT 20`),
  workerStats: db.prepare(`SELECT claimed_by worker_id, batch_id,
      COUNT(*) total_touched, SUM(status='done') done_count, SUM(status='failed') failed_count,
      SUM(status='claimed') in_flight, MAX(heartbeat_at) last_heartbeat
    FROM jobs WHERE claimed_by IS NOT NULL GROUP BY claimed_by, batch_id`),
  perProduct: db.prepare(`SELECT id, batch_id, sku, product_url, product_name, status, claimed_by, claimed_at, heartbeat_at, done_at, failed_reason, attempts FROM jobs WHERE batch_id=? ORDER BY priority DESC, id ASC`),
  activeWorkers: db.prepare(`SELECT DISTINCT claimed_by worker_id, MAX(heartbeat_at) last_heartbeat FROM jobs WHERE batch_id=? AND claimed_by IS NOT NULL GROUP BY claimed_by`),
  insertKeyword: db.prepare(`INSERT INTO keywords (batch_id, sku, keyword, product_url, data) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, product_url, keyword) DO UPDATE SET data=excluded.data, sku=excluded.sku`),
  keywordsByBatch: db.prepare(`SELECT data FROM keywords WHERE batch_id=? ORDER BY id ASC`),
  insertActivity: db.prepare(`INSERT INTO activity_log (batch_id, worker_id, level, source, message, product_url, sku) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  recentActivity: db.prepare(`SELECT * FROM activity_log WHERE (?1 IS NULL OR batch_id=?1) ORDER BY ts DESC LIMIT ?2`),
  insertCommand: db.prepare(`INSERT INTO worker_commands (worker_id, command, payload, created_by) VALUES (?, ?, ?, ?)`),
  pendingCommands: db.prepare(`SELECT * FROM worker_commands WHERE acknowledged_at IS NULL AND (worker_id IS NULL OR worker_id=?) ORDER BY id ASC`),
  ackCommand: db.prepare(`UPDATE worker_commands SET acknowledged_at=?, acknowledged_by=? WHERE id=?`),
  getConfig: db.prepare(`SELECT config, active_batch_id FROM worker_config WHERE id=1`),
  setConfig: db.prepare(`UPDATE worker_config SET config=? WHERE id=1`),
  setActiveBatch: db.prepare(`UPDATE worker_config SET active_batch_id=? WHERE id=1`),
  requeue: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL WHERE id=?`),
  cleanupActivity: db.prepare(`DELETE FROM activity_log WHERE ts < ?`),
  cleanupCommands: db.prepare(`DELETE FROM worker_commands WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?`),
  newestPendingBatch: db.prepare(`SELECT batch_id FROM jobs WHERE status='pending' GROUP BY batch_id ORDER BY MAX(created_at) DESC LIMIT 1`),
  batchHasPending: db.prepare(`SELECT 1 FROM jobs WHERE batch_id=? AND status='pending' LIMIT 1`),
  existsActiveUrl: db.prepare(`SELECT 1 FROM jobs WHERE product_url=? AND batch_id<>? AND status IN ('pending','claimed','done') LIMIT 1`),
};

// Atomic claim — one synchronous transaction (node:sqlite is sync + Node is
// single-threaded → no concurrent claim can interleave, so no double-claims).
function claimJobs(workerId, batchId, limit) {
  const t = now();
  const claimed = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = Q.pendingForClaim.all(batchId, limit).map(r => r.id);
    for (const id of ids) {
      const info = Q.claimById.run(workerId, t, t, id);
      if (info.changes > 0) claimed.push(Q.jobById.get(id));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK'); throw e;
  }
  return claimed;
}

// ---------------- Worker installer ----------------
// Exhaustive allowlist of extension files the worker PC needs. Anything
// not on this list is refused by the /worker/ route, so an accidental
// commit of secrets can't leak via directory traversal. Keep in sync
// with manifest.json + its imports.
const WORKER_FILES = [
  'manifest.json',
  'background.js',
  'popup.html', 'popup.js',
  'dashboard.html', 'dashboard.js',
  'offscreen.html', 'offscreen.js',
  'sandbox.html', 'sandbox.js',
  'kp.js', 'serp-reader.js', 'amazon-reader.js',
  'modules/keyword-discovery.js',
  'modules/keyword-filter.js',
  'modules/discovery-jobs.js',
  'modules/discovery-export.js',
  'modules/image-matcher.js',
  'modules/attribute-families.js',
  'config/discovery-config.js',
  'lib/xlsx.mjs', 'lib/transformers.min.js',
];

// PowerShell one-liner installer. Bootstraps the extension on a worker PC:
// downloads every file in WORKER_FILES, creates a dedicated Chrome
// profile + user-data-dir under %LOCALAPPDATA%, drops a startup shortcut
// so Chrome auto-launches with the extension pre-loaded on next login.
// The user still has to enable Developer Mode + Load Unpacked ONCE on
// first run — Chrome doesn't allow unattended install of an unpacked
// extension without an enterprise policy.
function serveWorkerInstaller(req, res, url) {
  const managerBase = `${url.protocol}//${req.headers.host}`;
  const script = `# AdBrain worker installer — generated by manager at ${managerBase}
# Usage (from PowerShell on the worker PC):
#   irm ${managerBase}/install-worker.ps1 | iex
#
# What it does:
#   1) Downloads the extension into %LOCALAPPDATA%\\AdBrainWorker\\extension
#   2) Creates a dedicated Chrome user-data-dir so the extension doesn't touch
#      the user's normal Chrome profile
#   3) Drops a Startup shortcut so Chrome auto-launches on login with the
#      extension loaded + the manager dashboard open in a tab
#   4) Fires Chrome once so you can enable Developer Mode + Load Unpacked
#
# After first run: connect the extension to this manager via the popup's
# 'Apply setup code' box (copy the code from the manager's Workers tab).

$ErrorActionPreference = 'Continue'
$mgr    = '${managerBase}'
$root   = Join-Path $env:LOCALAPPDATA 'AdBrainWorker'
$extDir = Join-Path $root 'extension'
$prof   = Join-Path $root 'profile'
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
New-Item -ItemType Directory -Force -Path $prof   | Out-Null

Write-Host '[AdBrain] Downloading extension files from' $mgr '...' -ForegroundColor Cyan
try {
  $list = (Invoke-RestMethod "$mgr/worker-files.json").files
} catch {
  Write-Host ("[AdBrain] Cannot reach manager: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host "  Check that the manager server is running at $mgr" -ForegroundColor Yellow
  exit 1
}
$total = $list.Count; $i = 0; $failed = @()
foreach ($f in $list) {
  $i++
  $out = Join-Path $extDir ($f -replace '/', '\\')
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$mgr/worker/$f" -OutFile $out -ErrorAction Stop
  } catch {
    $failed += $f
    Write-Host ("  [!] {0} - {1}" -f $f, $_.Exception.Message) -ForegroundColor Red
  }
  Write-Progress -Activity 'Downloading extension' -Status "$f" -PercentComplete ([int](100 * $i / $total))
}
Write-Progress -Activity 'Downloading extension' -Completed
$got = $total - $failed.Count
if ($failed.Count -eq 0) {
  Write-Host ("[AdBrain] Downloaded {0}/{0} file(s) to {1}" -f $total, $extDir) -ForegroundColor Green
} else {
  Write-Host ("[AdBrain] Downloaded {0}/{1} file(s). {2} failed:" -f $got, $total, $failed.Count) -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host ("  - {0}" -f $_) -ForegroundColor Yellow }
  Write-Host "The extension may still work if the failed files aren't runtime-critical, but Load Unpacked may show errors. Ask the manager to update the WORKER_FILES allowlist." -ForegroundColor Yellow
}

# Locate chrome.exe
$chrome = $null
foreach ($p in @(
  "$env:PROGRAMFILES\\Google\\Chrome\\Application\\chrome.exe",
  "$\{env:PROGRAMFILES(X86)\}\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe"
)) { if (Test-Path $p) { $chrome = $p; break } }
if (-not $chrome) { throw '[AdBrain] Chrome not found in the usual locations. Install Chrome first.' }

# Startup shortcut — Chrome auto-launches on user login with the extension
# loaded + the manager dashboard open.
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'AdBrain Worker.lnk'
$args = ('--user-data-dir="{0}" --load-extension="{1}" --new-window "{2}/"' -f $prof, $extDir, $mgr)
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = $chrome
$lnk.Arguments  = $args
$lnk.WorkingDirectory = $extDir
$lnk.Description = 'AdBrain Discovery worker'
$lnk.Save()
Write-Host "[AdBrain] Startup shortcut placed: $lnkPath" -ForegroundColor Green

# Launch once so the user can enable Developer Mode + Load Unpacked
# (Chrome requires this once for unpacked extensions).
Start-Process -FilePath $chrome -ArgumentList $args
Write-Host ''
Write-Host '===================================================================' -ForegroundColor Yellow
Write-Host ' NEXT STEPS (do these ONCE on this worker PC):' -ForegroundColor Yellow
Write-Host '  1) In the Chrome that just opened, visit chrome://extensions' -ForegroundColor Yellow
Write-Host '  2) Toggle "Developer mode" on (top-right)' -ForegroundColor Yellow
Write-Host '  3) Click "Load unpacked" and select this folder:' -ForegroundColor Yellow
Write-Host ("     $extDir") -ForegroundColor Cyan
Write-Host '  4) Open the AdBrain popup, pick role = Worker' -ForegroundColor Yellow
Write-Host ("  5) On the manager tab ($mgr), open Workers -> Copy setup code") -ForegroundColor Yellow
Write-Host '  6) Paste it into the extension popup and click Apply' -ForegroundColor Yellow
Write-Host '===================================================================' -ForegroundColor Yellow
Write-Host 'After that, every future Windows login auto-launches Chrome with' -ForegroundColor Green
Write-Host 'the extension armed. The worker will claim work from the manager' -ForegroundColor Green
Write-Host 'without any further clicks.' -ForegroundColor Green
`;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(script);
}

// ---------------- Router ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const m = req.method;
  if (m === 'OPTIONS') return send(res, 204, '');

  // Static dashboard.
  if (m === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/public/') || p === '/favicon.ico')) {
    if (p === '/favicon.ico') return send(res, 204, '');
    return serveStatic(res, p.startsWith('/public') ? p.replace(/^\/public/, '') : p);
  }

  // Worker installer + extension file serving. Un-authenticated so PowerShell
  // one-liners can bootstrap without token gymnastics; anyone who can reach
  // the manager URL over the tailnet can install the extension. Content is
  // strictly limited to a static allowlist (WORKER_FILES) below — no arbitrary
  // path access even if the request contains ../ escapes.
  if (m === 'GET' && p === '/install-worker.ps1') return serveWorkerInstaller(req, res, url);
  if (m === 'GET' && p === '/worker-files.json') return send(res, 200, { ok: true, files: WORKER_FILES });
  if (m === 'GET' && p.startsWith('/worker/')) {
    const rel = p.replace(/^\/worker\//, '');
    if (!WORKER_FILES.includes(rel)) return send(res, 404, { ok: false, error: 'not in worker file allowlist' });
    const file = path.join(__dirname, '..', rel);
    return fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { ok: false, error: 'file missing' });
      const ext = path.extname(file).toLowerCase();
      const type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' || ext === '.mjs' ? 'text/javascript'
        : ext === '.css' ? 'text/css'
        : ext === '.json' ? 'application/json'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  if (p.startsWith('/api/') && !tokenOk(req, url)) return send(res, 401, { ok: false, error: 'bad or missing token' });

  try {
    // ----- Health -----
    // Cheap connectivity + token check. GET only; returns quickly so the
    // extension's health-ping alarm can flag a red pill within one round-trip.
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, ts: now() });

    // ----- Jobs / queue -----
    if (m === 'POST' && p === '/api/jobs/upload') {
      const b = await readJson(req);
      const batchId = String(b.batchId || b.batch_id || '');
      const products = Array.isArray(b.products) ? b.products : [];
      if (!batchId || products.length === 0) return send(res, 400, { ok: false, error: 'batchId + products required' });
      // Dedup within this upload (last occurrence wins).
      const seen = new Map();
      for (const pr of products) { const u = String(pr.url || pr.product_url || '').trim(); if (u) seen.set(u, pr); }
      const dupDropped = products.filter(p => (p.url || p.product_url || '').trim()).length - seen.size;
      let n = 0, skippedActive = 0; const skippedSkus = [];
      db.exec('BEGIN');
      try {
        for (const [urlv, pr] of seen) {
          // Cross-batch dedup: skip URLs already pending/claimed/done in ANOTHER batch.
          if (Q.existsActiveUrl.get(urlv, batchId)) { skippedActive++; if (pr.sku) skippedSkus.push(pr.sku); continue; }
          Q.insertJob.run(batchId, pr.sku || null, urlv, pr.product_name || pr.name || null,
            Number.isFinite(pr.priority) ? pr.priority : 100,
            Array.isArray(pr.handles) ? pr.handles.join('|') : (pr.handles || null),
            Array.isArray(pr.brands) ? pr.brands.join('|') : (pr.brands || null));
          n++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, uploaded: n, total: seen.size, batchId, duplicatesDropped: dupDropped, skippedActive, skippedSkus: skippedSkus.slice(0, 10) });
    }
    if (m === 'POST' && p === '/api/jobs/claim') {
      const b = await readJson(req);
      const claimed = claimJobs(String(b.workerId || ''), String(b.batchId || ''), Math.max(1, Math.min(50, b.limit || 5)));
      return send(res, 200, { ok: true, jobs: claimed });
    }
    if (m === 'POST' && p === '/api/jobs/heartbeat') {
      const b = await readJson(req); const t = now();
      let n = 0;
      for (const id of (Array.isArray(b.jobIds) ? b.jobIds : [])) { const info = Q.heartbeatById.run(t, Number(id), b.workerId); n += info.changes; }
      return send(res, 200, { ok: true, updated: n });
    }
    if (m === 'POST' && p === '/api/jobs/requeue') {
      const b = await readJson(req); const info = Q.requeue.run(Number(b.jobId));
      return send(res, 200, { ok: info.changes > 0, updated: info.changes });
    }
    if (m === 'GET' && p === '/api/jobs/active-batch') {
      // Manager-pinned batch (if it still has pending work), else newest pending batch.
      const cfg = Q.getConfig.get();
      const pinned = (cfg?.active_batch_id || '').trim();
      if (pinned && Q.batchHasPending.get(pinned)) return send(res, 200, { ok: true, batchId: pinned });
      const row = Q.newestPendingBatch.get();
      return send(res, 200, { ok: true, batchId: row?.batch_id || null });
    }
    if (m === 'GET' && p === '/api/jobs/url-active') {
      // Cross-batch dedup check: is this product_url already active in another batch?
      const u = url.searchParams.get('url') || '';
      const b = url.searchParams.get('excludeBatch') || '';
      return send(res, 200, { ok: true, active: !!Q.existsActiveUrl.get(u, b) });
    }
    if (m === 'POST' && p === '/api/jobs/done')   { const b = await readJson(req); Q.markDone.run(now(), b.batchId, b.productUrl); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/jobs/failed') { const b = await readJson(req); Q.markFailed.run(b.reason || null, now(), b.batchId, b.productUrl); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/jobs/release-stale') {
      const b = await readJson(req); const mins = Number.isFinite(b.staleMinutes) ? b.staleMinutes : 10;
      const info = Q.releaseStale.run(now() - mins * 60000);
      return send(res, 200, { ok: true, released: info.changes });
    }
    if (m === 'GET' && p === '/api/jobs/summary')      return send(res, 200, { ok: true, batches: Q.summary.all() });
    if (m === 'GET' && p === '/api/jobs/worker-stats') return send(res, 200, { ok: true, workers: Q.workerStats.all() });
    if (m === 'GET' && p === '/api/jobs/per-product')  return send(res, 200, { ok: true, rows: Q.perProduct.all(url.searchParams.get('batchId') || '') });
    if (m === 'GET' && p === '/api/jobs/active-workers') return send(res, 200, { ok: true, workers: Q.activeWorkers.all(url.searchParams.get('batchId') || '') });

    // ----- Discovered keywords (results) -----
    if (m === 'POST' && p === '/api/keywords') {
      const b = await readJson(req);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      let n = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          Q.insertKeyword.run(r.batch_id || b.batchId || null, r.sku || null, r.keyword || '', r.product_url || '', JSON.stringify(r));
          n++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, inserted: n });
    }
    if (m === 'GET' && p === '/api/keywords') {
      const rows = Q.keywordsByBatch.all(url.searchParams.get('batchId') || '').map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
      return send(res, 200, { ok: true, total: rows.length, rows });
    }

    // ----- Activity log -----
    if (m === 'POST' && p === '/api/activity') {
      const b = await readJson(req);
      for (const e of (Array.isArray(b.events) ? b.events : [b])) {
        if (!e || !e.message) continue;
        Q.insertActivity.run(e.batch_id || b.batchId || null, e.worker_id || b.workerId || null, e.level || 'info', e.source || null, String(e.message), e.product_url || null, e.sku || null);
      }
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/activity') {
      const batchId = url.searchParams.get('batchId') || null;
      const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '120', 10));
      return send(res, 200, { ok: true, events: Q.recentActivity.all(batchId, limit) });
    }

    // ----- Command bus -----
    if (m === 'POST' && p === '/api/commands') {
      const b = await readJson(req);
      Q.insertCommand.run(b.workerId || null, String(b.command || ''), b.payload ? JSON.stringify(b.payload) : null, b.createdBy || null);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/commands') {
      const rows = Q.pendingCommands.all(url.searchParams.get('workerId') || '').map(c => ({ ...c, payload: c.payload ? JSON.parse(c.payload) : null }));
      return send(res, 200, { ok: true, commands: rows });
    }
    if (m === 'POST' && p === '/api/commands/ack') {
      const b = await readJson(req);
      for (const id of (Array.isArray(b.ids) ? b.ids : [])) Q.ackCommand.run(now(), b.workerId || null, id);
      return send(res, 200, { ok: true });
    }

    // ----- Worker config (push-to-workers + active batch) -----
    if (m === 'GET' && p === '/api/config') {
      const row = Q.getConfig.get();
      return send(res, 200, { ok: true, config: row?.config ? JSON.parse(row.config) : {}, active_batch_id: row?.active_batch_id || null });
    }
    if (m === 'POST' && p === '/api/config') {
      const b = await readJson(req);
      if (b.config !== undefined) Q.setConfig.run(JSON.stringify(b.config || {}));
      if (b.configPatch && typeof b.configPatch === 'object') {
        const cur = Q.getConfig.get();
        const merged = { ...(cur?.config ? JSON.parse(cur.config) : {}) };
        for (const [k, v] of Object.entries(b.configPatch)) { if (v === null) delete merged[k]; else merged[k] = v; }
        Q.setConfig.run(JSON.stringify(merged));
      }
      if ('activeBatchId' in b) Q.setActiveBatch.run(b.activeBatchId || null);
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/cleanup') {
      const b = await readJson(req);
      const a = Q.cleanupActivity.run(now() - (b.logDays ?? 7) * 86400000);
      const c = Q.cleanupCommands.run(now() - (b.commandsDays ?? 1) * 86400000);
      return send(res, 200, { ok: true, activityLog: a.changes, ackedCommands: c.changes });
    }

    return send(res, 404, { ok: false, error: 'no such route' });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[manager] AdBrain SQLite manager on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
  console.log(`[manager] Dashboard: http://<this-tailscale-name>:${PORT}/`);
  console.log(TOKEN ? '[manager] MANAGER_TOKEN set — clients must send X-Manager-Token.' : '[manager] No token — relying on Tailscale for access control.');
});
