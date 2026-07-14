// manager/public/app.js
// AdBrain Manager web app — served by manager/server.js at /.
// All communication with the manager goes through /public/api.js.

import { api, getToken, setToken, fetchBatchKeywordStats, generateSetupCode } from '/public/api.js';
import * as XLSX from '/public/xlsx.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

const state = {
  parsedProducts: null,   // upload preview
  activeBatch: '',        // dashboard-selected batch
  dashTimer: null,
  dashIntervalMs: 10000,
  logs: [],
  workers: [],
  batches: [],
  activeBatchPinned: null,
  setupCode: '',
};

// ─────────── Utility ───────────
function fmtTime(v) {
  if (v == null || v === '') return '—';
  const d = new Date(typeof v === 'number' ? v : Number(v) || v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtAgo(v) {
  if (v == null) return '—';
  const t = typeof v === 'number' ? v : Number(v);
  if (isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function workerDotClass(lastHb) {
  if (!lastHb) return 'pending';
  const ms = Date.now() - Number(lastHb);
  if (ms < 90 * 1000) return 'done';        // green
  if (ms < 5 * 60 * 1000) return 'claimed';  // amber
  return 'pending';
}
function setResult(el, msg, kind = 'info') {
  if (!el) return;
  el.innerHTML = msg ? `<div class="banner ${kind}" style="margin-top:10px;">${esc(msg)}</div>` : '';
}

// ─────────── Tabs ───────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`panel-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') startDashPolling();
    else stopDashPolling();
    if (btn.dataset.tab === 'config') loadConfigForm();
    if (btn.dataset.tab === 'workers') refreshWorkersTab();
    if (btn.dataset.tab === 'downloads') refreshDownloadsTab();
  });
});

// ─────────── Token + health ───────────
$('tokenInput').value = getToken();
$('saveTokenBtn').addEventListener('click', () => {
  setToken($('tokenInput').value);
  healthPing();
});
async function healthPing() {
  const pill = $('healthPill');
  try {
    const t0 = performance.now();
    const r = await api.health();
    const ms = Math.round(performance.now() - t0);
    if (r?.ok) {
      pill.className = 'health ok';
      pill.textContent = `● ${ms}ms`;
      pill.title = `Manager reachable in ${ms}ms — click to recheck`;
    } else {
      pill.className = 'health warn';
      pill.textContent = '⚠ ok=false';
    }
  } catch (e) {
    pill.className = 'health err';
    pill.textContent = e.status === 401 ? '⚠ bad token' : '⚠ offline';
    pill.title = e.message;
  }
}
$('healthPill').addEventListener('click', healthPing);
healthPing();

// ═══════════════════════════════════════════════════════════════
//  UPLOAD TAB — Excel/CSV → parse → POST /api/jobs/upload
// ═══════════════════════════════════════════════════════════════
$('uploadFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch (err) { setResult($('uploadResult'), `Failed to parse: ${err.message}`, 'err'); return; }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const products = rows.map(r => ({
    url:          String(r.url || r.product_url || r.URL || r.Url || r.link || '').trim(),
    sku:          r.sku != null ? String(r.sku).trim() : null,
    product_name: r.product_name || r.name || r.title || r.productName || null,
    priority:     Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
    handles:      r.handles || null,
    brands:       r.brands || null,
  })).filter(p => p.url);
  state.parsedProducts = products;
  const dupes = products.length !== new Set(products.map(p => p.url)).size;
  $('uploadPreview').innerHTML = `
    <div class="banner ${products.length > 0 ? 'ok' : 'warn'}" style="margin-top:10px;">
      Parsed <strong>${products.length}</strong> product URLs from ${file.name}
      ${dupes ? `<br><small>⚠ Duplicate URLs in file — manager will keep the last occurrence.</small>` : ''}
    </div>
    <div style="max-height: 180px; overflow: auto; margin-top: 8px;">
      <table class="tbl">
        <thead><tr><th>SKU</th><th>Product</th><th>URL</th></tr></thead>
        <tbody>${products.slice(0, 50).map(p => `
          <tr>
            <td class="mono">${esc(p.sku || '—')}</td>
            <td>${esc(p.product_name || '—')}</td>
            <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(p.url)}">${esc(p.url)}</td>
          </tr>`).join('')}
        ${products.length > 50 ? `<tr><td colspan="3" style="text-align:center;color:var(--text-3);">…and ${products.length - 50} more</td></tr>` : ''}
        </tbody>
      </table>
    </div>
  `;
  $('uploadBtn').disabled = products.length === 0;
});
$('clearUploadBtn').addEventListener('click', () => {
  $('uploadFile').value = '';
  $('uploadBatchId').value = '';
  $('uploadPreview').innerHTML = '';
  $('uploadResult').innerHTML = '';
  $('uploadBtn').disabled = true;
  state.parsedProducts = null;
});
$('uploadBtn').addEventListener('click', async () => {
  if (!state.parsedProducts?.length) return;
  const batchId = $('uploadBatchId').value.trim() || String(Date.now());
  $('uploadBtn').disabled = true;
  setResult($('uploadResult'), 'Uploading…', 'info');
  try {
    const r = await api.jobsUpload(batchId, state.parsedProducts);
    const msg = `✓ Uploaded ${r.uploaded}/${r.total} to batch ${batchId}.`
      + (r.duplicatesDropped ? ` Dropped ${r.duplicatesDropped} in-file duplicates.` : '')
      + (r.skippedActive ? ` Skipped ${r.skippedActive} already-active in other batches.` : '');
    setResult($('uploadResult'), msg, 'ok');
  } catch (e) {
    setResult($('uploadResult'), `Upload failed: ${e.message}`, 'err');
  } finally {
    $('uploadBtn').disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD TAB
// ═══════════════════════════════════════════════════════════════
$('dashBatchSelect').addEventListener('change', () => {
  state.activeBatch = $('dashBatchSelect').value;
  refreshDashboard();
});
$('dashRefreshInterval').addEventListener('change', () => {
  state.dashIntervalMs = parseInt($('dashRefreshInterval').value, 10) || 0;
  startDashPolling();
});
$('dashRefreshBtn').addEventListener('click', refreshDashboard);
$('wakeAllBtn').addEventListener('click', async () => {
  if (!confirm('Send wake signal to all workers?')) return;
  try { await api.commandsSend(null, 'wake'); alert('✓ Wake signal sent.'); refreshDashboard(); }
  catch (e) { alert(`Wake failed: ${e.message}`); }
});
$('resumeAllBtn').addEventListener('click', async () => {
  if (!confirm('Send resume signal to all paused workers?')) return;
  try { await api.commandsSend(null, 'resume'); alert('✓ Resume signal sent.'); refreshDashboard(); }
  catch (e) { alert(`Resume failed: ${e.message}`); }
});

function startDashPolling() {
  stopDashPolling();
  refreshDashboard();
  if (state.dashIntervalMs > 0) {
    state.dashTimer = setInterval(refreshDashboard, state.dashIntervalMs);
  }
}
function stopDashPolling() {
  if (state.dashTimer) { clearInterval(state.dashTimer); state.dashTimer = null; }
}

async function refreshDashboard() {
  try {
    const [summary, workers, activity] = await Promise.all([
      api.jobsSummary(),
      api.jobsWorkerStats(),
      api.activityGet(state.activeBatch, 120),
    ]);
    state.batches = summary.batches || [];
    state.workers = workers.workers || [];
    renderBatchOverview();
    renderWorkerFleet();
    renderActivity(activity.events || []);
    populateBatchSelects();
    // Output stats card only when a batch is selected.
    if (state.activeBatch) {
      const stats = await fetchBatchKeywordStats(state.activeBatch);
      renderOutputStats(stats);
    } else {
      renderOutputStats(null);
    }
  } catch (e) {
    // Health pill will show the failure — no double alert here.
    console.warn('dashboard refresh failed:', e.message);
  }
}

function populateBatchSelects() {
  // Populate dashboard + config + downloads selects with current batches.
  const opts = state.batches.map(b => `<option value="${esc(b.batch_id)}">${esc(b.batch_id)} — ${b.total} SKUs</option>`).join('');
  for (const id of ['dashBatchSelect', 'pinBatchSelect', 'downloadBatchSelect']) {
    const el = $(id);
    if (!el) continue;
    const cur = el.value;
    el.innerHTML = `<option value="">— none —</option>${opts}`;
    if (cur && Array.from(el.options).some(o => o.value === cur)) el.value = cur;
  }
}

function renderBatchOverview() {
  const el = $('batchOverview');
  $('batchCountLabel').textContent = `${state.batches.length} batch(es)`;
  if (state.batches.length === 0) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📭</div>No batches yet.</div>`;
    return;
  }
  el.innerHTML = `<table class="tbl">
    <thead><tr><th>Batch</th><th class="num">Total</th><th class="num">Pending</th><th class="num">Claimed</th><th class="num">Done</th><th class="num">Failed</th></tr></thead>
    <tbody>${state.batches.map(b => `
      <tr>
        <td class="mono">${esc(b.batch_id)}</td>
        <td class="num">${b.total}</td>
        <td class="num">${b.pending}</td>
        <td class="num">${b.claimed}</td>
        <td class="num" style="color:var(--success);">${b.done}</td>
        <td class="num" style="color:${b.failed > 0 ? 'var(--danger)' : 'var(--text-3)'};">${b.failed}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderWorkerFleet() {
  const el = $('workerGrid');
  $('workerCountLabel').textContent = `${state.workers.length} worker(s)`;
  // Populate the command Worker select too.
  const workerSel = $('cmdWorker');
  if (workerSel) {
    const cur = workerSel.value;
    workerSel.innerHTML = `<option value="">All workers (broadcast)</option>` +
      state.workers.map(w => `<option value="${esc(w.worker_id)}">${esc(w.worker_id)}</option>`).join('');
    if (cur) workerSel.value = cur;
  }
  if (state.workers.length === 0) {
    el.innerHTML = `<div class="empty">No workers seen yet — start the extension on a worker PC and apply a setup code.</div>`;
    return;
  }
  el.innerHTML = `<table class="tbl">
    <thead><tr><th>Worker</th><th>Last heartbeat</th><th class="num">In-flight</th><th class="num">Done</th><th class="num">Failed</th></tr></thead>
    <tbody>${state.workers.map(w => `
      <tr>
        <td><span class="chip ${workerDotClass(w.last_heartbeat)}">●</span> <span class="mono">${esc(w.worker_id)}</span></td>
        <td>${fmtAgo(w.last_heartbeat)}</td>
        <td class="num">${w.in_flight || 0}</td>
        <td class="num" style="color:var(--success);">${w.done || 0}</td>
        <td class="num" style="color:${(w.failed||0) > 0 ? 'var(--danger)' : 'var(--text-3)'};">${w.failed || 0}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderActivity(events) {
  const el = $('activityLog');
  if (!events || events.length === 0) {
    el.innerHTML = `<div class="empty">No activity yet.</div>`;
    return;
  }
  el.innerHTML = events.map(e => `
    <div class="log-line ${esc(e.level || 'info')}">
      <span class="ts">${fmtTime(e.ts)}</span>
      <span class="worker">${esc(e.worker_id || '—')}</span>
      <span class="src">${esc((e.source || 'engine').slice(0, 8))}</span>
      <span class="msg">${esc(e.message || '')}</span>
    </div>`).join('');
}

function renderOutputStats(stats) {
  const wrap = $('outputStatsPanel');
  const head = $('outputStatsHeader');
  if (!stats) {
    head.textContent = '—';
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">📊</div>Pick a batch above.</div>`;
    return;
  }
  if (stats.totalSkus === 0) {
    head.textContent = 'empty batch';
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">📭</div>Batch has no SKUs yet.</div>`;
    return;
  }
  const { totalKeywords, totalSkus, skusWithKeywords, avgKwPerSku, topSkus, skusWithZeroKw, skusDone, skusFailed, skusPending, skusClaimed, mostRecentDoneAt } = stats;
  head.textContent = `${totalKeywords.toLocaleString()} rows · ${skusWithKeywords}/${totalSkus} producing · last ${mostRecentDoneAt ? fmtTime(mostRecentDoneAt) : '—'}`;
  const tiles = `
    <div class="tiles">
      <div class="tile success"><div class="lbl">Total rows</div><div class="val">${totalKeywords.toLocaleString()}</div></div>
      <div class="tile info"><div class="lbl">SKUs total</div><div class="val">${totalSkus}</div></div>
      <div class="tile success"><div class="lbl">Producing</div><div class="val">${skusWithKeywords}</div></div>
      <div class="tile"><div class="lbl">Avg / SKU</div><div class="val">${avgKwPerSku}</div></div>
    </div>
    <div class="row tight" style="margin-bottom:10px;">
      <span class="chip done">✓ ${skusDone} done</span>
      <span class="chip claimed">⚙ ${skusClaimed} in-flight</span>
      <span class="chip pending">⋯ ${skusPending} pending</span>
      ${skusFailed > 0 ? `<span class="chip failed">✗ ${skusFailed} failed</span>` : ''}
    </div>`;
  const zeroBanner = skusWithZeroKw.length > 0
    ? `<div class="banner err">⚠ ${skusWithZeroKw.length} SKU(s) finished with zero keyword rows — check activity log for "KP FAILED" or "LOW YIELD".</div>`
    : '';
  const rows = topSkus.map(s => `
    <tr title="${esc(s.failedReason || '')}">
      <td class="mono">${esc(s.sku)}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.productName)}</td>
      <td><span class="chip ${esc(s.status)}">${esc(s.status)}</span></td>
      <td class="mono">${esc(s.claimedBy || '—')}</td>
      <td class="num">${
        s.kwCount > 0
          ? `<span class="chip done">${s.kwCount}</span>`
          : (s.status === 'pending' || s.status === 'claimed')
            ? `<span style="color:var(--text-3);">—</span>`
            : `<span class="chip failed">0</span>`
      }</td>
      <td>${s.doneAt ? fmtTime(s.doneAt) : '—'}</td>
    </tr>`).join('');
  wrap.innerHTML = `${tiles}${zeroBanner}
    <table class="tbl"><thead><tr>
      <th>SKU</th><th>Product</th><th>Status</th><th>Worker</th><th class="num">Rows</th><th>Done</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

// ═══════════════════════════════════════════════════════════════
//  CONFIG TAB
// ═══════════════════════════════════════════════════════════════
async function loadConfigForm() {
  try {
    const r = await api.configGet();
    const cfg = r.config || {};
    if (cfg.kp_url) $('cfgKpUrl').value = cfg.kp_url;
    if (Number.isFinite(cfg.kp_max_per_product)) $('cfgKpMax').value = cfg.kp_max_per_product;
    if (cfg.match_profile) $('cfgMatchProfile').value = cfg.match_profile;
    if (Number.isFinite(cfg.chunk_size)) $('cfgChunkSize').value = cfg.chunk_size;
    if (Number.isFinite(cfg.clip_threshold)) $('cfgClipThreshold').value = cfg.clip_threshold;
    state.activeBatchPinned = r.active_batch_id || null;
    if (state.activeBatchPinned) $('pinBatchSelect').value = state.activeBatchPinned;
  } catch (e) {
    setResult($('saveConfigResult'), `Failed to load: ${e.message}`, 'err');
  }
  // Re-populate batch selects.
  try {
    const s = await api.jobsSummary();
    state.batches = s.batches || [];
    populateBatchSelects();
    if (state.activeBatchPinned) $('pinBatchSelect').value = state.activeBatchPinned;
  } catch {}
}
$('saveConfigBtn').addEventListener('click', async () => {
  const cfg = {
    kp_url:              $('cfgKpUrl').value.trim(),
    kp_max_per_product:  parseInt($('cfgKpMax').value, 10) || 5000,
    match_profile:       $('cfgMatchProfile').value,
    chunk_size:          parseInt($('cfgChunkSize').value, 10) || 8,
    clip_threshold:      parseInt($('cfgClipThreshold').value, 10) || 72,
  };
  setResult($('saveConfigResult'), 'Saving…', 'info');
  try { await api.configSet(cfg); setResult($('saveConfigResult'), '✓ Saved. Workers will pick this up within ~30s.', 'ok'); }
  catch (e) { setResult($('saveConfigResult'), `Save failed: ${e.message}`, 'err'); }
});
$('pinBatchBtn').addEventListener('click', async () => {
  const v = $('pinBatchSelect').value;
  if (!v) { setResult($('pinBatchResult'), 'Pick a batch to pin.', 'warn'); return; }
  try { await api.activeBatchPin(v); setResult($('pinBatchResult'), `✓ Workers will switch to "${v}" within ~30s.`, 'ok'); state.activeBatchPinned = v; }
  catch (e) { setResult($('pinBatchResult'), `Pin failed: ${e.message}`, 'err'); }
});
$('unpinBatchBtn').addEventListener('click', async () => {
  try { await api.activeBatchPin(null); setResult($('pinBatchResult'), '✓ Unpinned. Workers pick newest pending batch.', 'ok'); state.activeBatchPinned = null; $('pinBatchSelect').value = ''; }
  catch (e) { setResult($('pinBatchResult'), `Unpin failed: ${e.message}`, 'err'); }
});
$('cleanupBtn').addEventListener('click', async () => {
  const logDays = parseInt($('cleanupLogDays').value, 10) || 0;
  const cmdDays = parseInt($('cleanupCommandsDays').value, 10) || 0;
  if (!confirm(`Purge activity log older than ${logDays} day(s) and acked commands older than ${cmdDays} day(s)?`)) return;
  try {
    const r = await api.cleanup(logDays, cmdDays);
    setResult($('cleanupResult'), `✓ Cleaned ${r.activityLog} activity row(s) + ${r.ackedCommands} command(s).`, 'ok');
  } catch (e) { setResult($('cleanupResult'), `Cleanup failed: ${e.message}`, 'err'); }
});

// ═══════════════════════════════════════════════════════════════
//  WORKERS TAB
// ═══════════════════════════════════════════════════════════════
async function refreshWorkersTab() {
  // Default the "Manager URL" input to this window's origin.
  if (!$('workerManagerUrl').value) $('workerManagerUrl').value = window.location.origin;
  // Re-populate command Worker dropdown.
  try {
    const w = await api.jobsWorkerStats();
    state.workers = w.workers || [];
    renderWorkerFleet();
  } catch {}
}
$('genSetupBtn').addEventListener('click', async () => {
  const managerUrl = $('workerManagerUrl').value.trim();
  const managerToken = getToken();
  let kpUrl = '';
  try { const r = await api.configGet(); kpUrl = r.config?.kp_url || ''; } catch {}
  state.setupCode = generateSetupCode({ managerUrl, managerToken, kpUrl });
  $('setupCodeWrap').innerHTML = `
    <div class="setup-code">${esc(state.setupCode)}</div>
    <div class="hint">${kpUrl ? '✓ Includes your saved KP URL' : '⚠ No KP URL saved yet — workers won\\'t be able to run KP. Save one in Config tab.'}</div>
  `;
  $('copySetupBtn').disabled = false;
  $('setupCodeWarn').style.display = managerToken ? '' : 'none';
});
$('copySetupBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.setupCode); $('copySetupBtn').textContent = '✓ Copied'; setTimeout(() => $('copySetupBtn').textContent = 'Copy', 1500); }
  catch { alert('Clipboard blocked. Select the code above and Ctrl+C.'); }
});
$('sendCmdBtn').addEventListener('click', async () => {
  const workerId = $('cmdWorker').value || null;
  const command  = $('cmdName').value;
  const label = workerId ? `worker ${workerId}` : 'ALL workers';
  if (!confirm(`Send "${command}" to ${label}?`)) return;
  try { await api.commandsSend(workerId, command); setResult($('sendCmdResult'), `✓ Sent "${command}" to ${label}.`, 'ok'); }
  catch (e) { setResult($('sendCmdResult'), `Send failed: ${e.message}`, 'err'); }
});

// ═══════════════════════════════════════════════════════════════
//  DOWNLOADS TAB — client-side CSV assembly
// ═══════════════════════════════════════════════════════════════
async function refreshDownloadsTab() {
  try {
    const s = await api.jobsSummary();
    state.batches = s.batches || [];
    populateBatchSelects();
  } catch {}
}
$('downloadCsvBtn').addEventListener('click', async () => {
  const batchId = $('downloadBatchSelect').value;
  if (!batchId) { setResult($('downloadResult'), 'Pick a batch first.', 'warn'); return; }
  setResult($('downloadResult'), 'Fetching…', 'info');
  try {
    const r = await api.keywordsGet(batchId);
    const rows = r.rows || [];
    if (rows.length === 0) { setResult($('downloadResult'), 'No rows for this batch yet.', 'warn'); return; }
    // Group by SKU (fall back to product_url if SKU missing).
    const groups = new Map();
    for (const row of rows) {
      const key = row.sku || row.product_url || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    // Build one CSV per group.
    for (const [key, groupRows] of groups) {
      const csv = rowsToCsv(groupRows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const safeName = String(key).replace(/[^\w.-]+/g, '_').slice(0, 60);
      a.download = `adbrain_${safeName}_${batchId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      await new Promise(res => setTimeout(res, 100)); // stagger so browser doesn't block
    }
    setResult($('downloadResult'), `✓ Downloaded ${groups.size} CSV file(s) — ${rows.length} rows total.`, 'ok');
  } catch (e) { setResult($('downloadResult'), `Download failed: ${e.message}`, 'err'); }
});

function rowsToCsv(rows) {
  if (!rows.length) return '';
  // Collect the union of keys (some rows may lack columns).
  const keys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const cols = Array.from(keys);
  const escapeCell = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') v = JSON.stringify(v);
    v = String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const header = cols.map(escapeCell).join(',');
  const body = rows.map(r => cols.map(c => escapeCell(r[c])).join(',')).join('\r\n');
  return header + '\r\n' + body + '\r\n';
}

// ─────────── Boot ───────────
// Start on dashboard tab if URL has #dashboard, else stay on Upload.
if (location.hash === '#dashboard') {
  document.querySelector('.tab[data-tab="dashboard"]').click();
}
