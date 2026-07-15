// manager/public/app.js
// AdBrain Manager web app — served by manager/server.js at /.
// All communication with the manager goes through /public/api.js.

import { api, getToken, setToken, fetchBatchKeywordStats, generateSetupCode } from '/public/api.js';
// SheetJS is loaded via <script> tag in index.html — window.XLSX is
// the UMD global. Using the UMD build (not the .mjs ES module) avoids
// the 28k-line mixed-export module blocking app.js from executing.
const XLSX = window.XLSX;

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
  seenWorkerIds: new Set(),  // for new-worker-connect toast
  timelineTimer: null,        // dashboard throughput refresh
  workerFilter: '',            // activity-log scope: '' = all workers, else worker_id
  // Batch display names — user-editable labels overlaid on batch IDs.
  // Map<batchId, {display_name, updated_at}>. Populated on refresh.
  batchNames: new Map(),
  // Diff-based event detection — remembers the previous refresh's snapshot
  // so we can toast on transitions (SKU done, worker offline, batch complete).
  eventSnap: {
    initialised: false,
    batches: new Map(),      // batch_id -> { done, failed, total, pending, claimed }
    workers: new Map(),      // worker_id -> { lastHb, wasOnline }
  },
};

// ─────────── Persistent UI state ───────────
// Small helper — keeps tab/batch/interval/filters across page reloads
// so users don't lose context on refresh. Namespaced key so it doesn't
// collide with anything else on localStorage.
const UI_STATE_KEY = 'adbrainManagerUIv1';
function loadUI() {
  try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveUI(patch) {
  const cur = loadUI();
  const next = { ...cur, ...patch };
  try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(next)); } catch {}
}

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

// ─────────── Toast notifications ───────────
// Non-blocking pop-ups in the top-right corner. Auto-dismiss after 4s
// unless kind==='err' (7s so users can read the error). Click × to close.
function toast(msg, kind = 'info', opts = {}) {
  const stack = $('toastStack');
  if (!stack) return;
  const icon = kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : kind === 'err' ? '×' : 'ℹ';
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const titleHtml = opts.title ? `<div class="toast-title">${esc(opts.title)}</div>` : '';
  el.innerHTML = `<span class="toast-icon">${icon}</span>
    <div class="toast-body">${titleHtml}${esc(msg)}</div>
    <button class="toast-close" title="Dismiss">×</button>`;
  stack.appendChild(el);
  const ttl = kind === 'err' ? 7000 : 4000;
  const close = () => {
    if (el._closed) return;
    el._closed = true;
    el.classList.add('closing');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', close);
  if (!opts.sticky) setTimeout(close, ttl);
  return { close };
}

// ═══════════════════════════════════════════════════════════════
//  COMMAND PALETTE — Ctrl/Cmd+K
// ═══════════════════════════════════════════════════════════════
const cmdk = { open: false, query: '', activeIdx: 0, results: [] };

function cmdkClose() {
  cmdk.open = false;
  $('cmdkRoot').style.display = 'none';
  $('cmdkRoot').innerHTML = '';
}

function cmdkOpen() {
  cmdk.open = true;
  cmdk.query = '';
  cmdk.activeIdx = 0;
  const root = $('cmdkRoot');
  root.style.display = '';
  root.innerHTML = `
    <div class="cmdk-backdrop" id="cmdkBackdrop">
      <div class="cmdk-panel" onclick="event.stopPropagation()">
        <input class="cmdk-input" id="cmdkInput" placeholder="Search batches, workers, actions…" autocomplete="off" />
        <div class="cmdk-list" id="cmdkList"></div>
        <div class="cmdk-hint">
          <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
          <span><kbd>enter</kbd> to select</span>
          <span><kbd>esc</kbd> to close</span>
        </div>
      </div>
    </div>`;
  $('cmdkBackdrop').addEventListener('click', cmdkClose);
  const input = $('cmdkInput');
  input.focus();
  input.addEventListener('input', () => { cmdk.query = input.value; cmdk.activeIdx = 0; cmdkRender(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cmdkClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cmdk.activeIdx = Math.min(cmdk.results.length - 1, cmdk.activeIdx + 1); cmdkRender(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); cmdk.activeIdx = Math.max(0, cmdk.activeIdx - 1); cmdkRender(); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = cmdk.results[cmdk.activeIdx]; if (r) { cmdkClose(); r.action(); } }
  });
  cmdkRender();
}

function cmdkRender() {
  const list = $('cmdkList');
  if (!list) return;
  const q = cmdk.query.trim().toLowerCase();

  // Build the full command set: static (tabs, actions) + dynamic (batches, workers).
  const items = [];
  const tabs = [
    { key: '1', tab: 'upload',    icon: '📤', label: 'Go to Upload' },
    { key: '2', tab: 'dashboard', icon: '📊', label: 'Go to Dashboard' },
    { key: '3', tab: 'analytics', icon: '📈', label: 'Go to Analytics' },
    { key: '4', tab: 'config',    icon: '⚙',  label: 'Go to Config' },
    { key: '5', tab: 'workers',   icon: '🔗', label: 'Go to Workers' },
    { key: '6', tab: 'downloads', icon: '📦', label: 'Go to Downloads' },
  ];
  for (const t of tabs) items.push({
    icon: t.icon, label: t.label, meta: t.key,
    action: () => document.querySelector(`.tab[data-tab="${t.tab}"]`).click(),
  });
  const actions = [
    { icon: '📢', label: 'Wake all workers',     meta: 'broadcast', action: async () => { try { await api.commandsSend(null, 'wake'); toast('Wake sent to all workers', 'ok'); } catch (e) { toast(e.message, 'err'); } } },
    { icon: '▶',  label: 'Resume all workers',    meta: 'broadcast', action: async () => { try { await api.commandsSend(null, 'resume'); toast('Resume sent', 'ok'); } catch (e) { toast(e.message, 'err'); } } },
    { icon: '⏸', label: 'Pause all workers',    meta: 'broadcast', action: async () => { try { await api.commandsSend(null, 'pause'); toast('Pause sent', 'ok'); } catch (e) { toast(e.message, 'err'); } } },
    { icon: '↻',  label: 'Re-queue all failed jobs', meta: 'action', action: async () => { if (!confirm('Re-queue every failed job across all batches?')) return; try { const r = await api.requeueAllFailed(''); toast(`${r.updated} job(s) back to pending`, 'ok'); } catch (e) { toast(e.message, 'err'); } } },
    { icon: '🧹', label: 'Cleanup old activity + commands', meta: 'action', action: () => { document.querySelector('.tab[data-tab="config"]').click(); setTimeout(() => $('cleanupBtn')?.scrollIntoView({behavior:'smooth', block:'center'}), 60); } },
    { icon: '🗑', label: 'Delete a batch',    meta: 'danger', action: () => { document.querySelector('.tab[data-tab="config"]').click(); setTimeout(() => $('deleteBatchSelect')?.scrollIntoView({behavior:'smooth', block:'center'}), 60); } },
    { icon: '💥', label: 'Reset everything', meta: 'danger', action: () => { document.querySelector('.tab[data-tab="config"]').click(); setTimeout(() => $('resetAllBtn')?.scrollIntoView({behavior:'smooth', block:'center'}), 60); } },
  ];
  items.push(...actions);

  // Dynamic: batches
  for (const b of state.batches) {
    items.push({
      icon: '📋',
      label: `Focus batch ${b.batch_id}`,
      meta: `${b.done}/${b.total} done`,
      action: () => {
        document.querySelector('.tab[data-tab="dashboard"]').click();
        setTimeout(() => {
          const sel = $('dashBatchSelect');
          if (sel && Array.from(sel.options).some(o => o.value === b.batch_id)) {
            sel.value = b.batch_id;
            sel.dispatchEvent(new Event('change'));
          }
        }, 80);
      },
    });
  }
  // Dynamic: workers
  for (const w of state.workers) {
    items.push({
      icon: '🖥️',
      label: `Worker ${w.worker_id}`,
      meta: `${w.in_flight || 0} in flight · ${w.done || 0} done`,
      action: () => { document.querySelector('.tab[data-tab="dashboard"]').click(); },
    });
  }

  // Simple substring filter (case-insensitive) across label + meta.
  cmdk.results = q ? items.filter(it => (it.label + ' ' + (it.meta || '')).toLowerCase().includes(q)) : items;
  if (cmdk.activeIdx >= cmdk.results.length) cmdk.activeIdx = Math.max(0, cmdk.results.length - 1);

  if (cmdk.results.length === 0) {
    list.innerHTML = `<div class="cmdk-empty">No results for "${esc(q)}"</div>`;
    return;
  }
  list.innerHTML = cmdk.results.slice(0, 50).map((it, i) => `
    <div class="cmdk-item ${i === cmdk.activeIdx ? 'active' : ''}" data-idx="${i}">
      <span class="icon">${it.icon}</span>
      <span class="label">${esc(it.label)}</span>
      <span class="meta">${esc(it.meta || '')}</span>
    </div>`).join('');
  list.querySelectorAll('.cmdk-item').forEach(el => {
    el.addEventListener('mouseover', () => { cmdk.activeIdx = parseInt(el.dataset.idx, 10); cmdkRender(); });
    el.addEventListener('click', () => { const r = cmdk.results[parseInt(el.dataset.idx, 10)]; if (r) { cmdkClose(); r.action(); } });
  });
}

// ═══════════════════════════════════════════════════════════════
//  PASSIVE EVENT DETECTION — toast when things change in the background
// ═══════════════════════════════════════════════════════════════
// Called on every dashboard refresh. Diffs the current snapshot against
// the last one (state.eventSnap) and emits toasts for interesting
// transitions:
//   - N SKUs newly done (throttled: batches across all workers)
//   - N SKUs newly failed
//   - Batch reached 100% (all done, no pending, no claimed)
//   - Worker went silent for > 3 min (was online, now heartbeat old)
//   - Worker back online after silence
//   - Worker went stopped-by-user (activity log message pattern)
// First refresh only populates the baseline — no toasts.
function detectAndToastEvents(batches, workers, events) {
  const snap = state.eventSnap;
  const nowMs = Date.now();
  // Build current snapshot
  const curBatches = new Map();
  let totalDoneAll = 0, totalFailedAll = 0;
  for (const b of batches) {
    curBatches.set(b.batch_id, {
      done: b.done || 0, failed: b.failed || 0, total: b.total || 0,
      pending: b.pending || 0, claimed: b.claimed || 0,
    });
    totalDoneAll += b.done || 0;
    totalFailedAll += b.failed || 0;
  }
  const curWorkers = new Map();
  for (const w of workers) {
    const hb = Number(w.last_heartbeat || 0);
    curWorkers.set(w.worker_id, {
      lastHb: hb,
      online: hb > 0 && (nowMs - hb) < 3 * 60 * 1000,   // 3-min threshold
    });
  }

  if (!snap.initialised) {
    snap.initialised = true;
    snap.batches = curBatches;
    snap.workers = curWorkers;
    return;
  }

  // ── SKU-done + SKU-failed deltas (aggregated across batches) ──
  let doneDelta = 0, failedDelta = 0;
  const completedBatches = [];
  for (const [id, cur] of curBatches) {
    const prev = snap.batches.get(id);
    if (!prev) continue;   // brand-new batch, no delta yet
    doneDelta   += Math.max(0, cur.done   - prev.done);
    failedDelta += Math.max(0, cur.failed - prev.failed);
    // Batch just crossed the finish line: was incomplete, now no pending + no claimed.
    const prevComplete = prev.pending === 0 && prev.claimed === 0 && prev.total > 0;
    const nowComplete  = cur.pending  === 0 && cur.claimed  === 0 && cur.total  > 0;
    if (!prevComplete && nowComplete) completedBatches.push({ id, total: cur.total, done: cur.done, failed: cur.failed });
  }
  if (doneDelta > 0) {
    toast(`${doneDelta} SKU${doneDelta > 1 ? 's' : ''} completed`, 'ok', { title: 'Progress' });
  }
  if (failedDelta > 0) {
    toast(`${failedDelta} SKU${failedDelta > 1 ? 's' : ''} failed — check Errors card`, 'warn', { title: 'Failure' });
  }
  for (const b of completedBatches) {
    toast(`Batch ${b.id} finished: ${b.done} done, ${b.failed} failed`, 'ok', { title: '✓ Batch complete' });
  }

  // ── Worker online/offline transitions ──
  for (const [wid, cur] of curWorkers) {
    const prev = snap.workers.get(wid);
    if (!prev) continue;   // brand-new worker — new-worker-connect toast handles that
    if (prev.online && !cur.online) {
      toast(`Worker ${wid} silent > 3 min`, 'warn', { title: '⚠ Worker offline' });
    } else if (!prev.online && cur.online) {
      toast(`Worker ${wid} back online`, 'ok', { title: 'Reconnected' });
    }
  }

  // ── Detect 'stopped-by-user' via activity log ──
  // Look at events since the last snapshot's newest event timestamp.
  const lastEventTs = snap._lastEventTs || 0;
  let newestTs = lastEventTs;
  for (const e of events) {
    const ts = Number(e.ts);
    if (ts > newestTs) newestTs = ts;
    if (ts <= lastEventTs) continue;
    const msg = String(e.message || '').toLowerCase();
    // These specific engine log lines are worth surfacing:
    if (msg.includes('wake ignored') && msg.includes('stopped by')) {
      toast(`${e.worker_id}: stopped by user — use Force reconnect`, 'warn', { title: '⚠ Worker stopped' });
    } else if (msg.includes('captcha') && msg.includes('paused')) {
      toast(`${e.worker_id}: Google served a CAPTCHA — engine paused`, 'warn', { title: '⚠ CAPTCHA' });
    }
  }
  snap._lastEventTs = newestTs;

  // Save current snapshot for next diff
  snap.batches = curBatches;
  snap.workers = curWorkers;
}

// ─────────── Keyboard shortcuts ───────────
// 1-6 jump to a tab. Ctrl+K focuses the analytics search (if on that tab).
// Ignored while typing in a form field.
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+K = command palette. Works even when a form field is focused.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (cmdk.open) cmdkClose(); else cmdkOpen();
    return;
  }
  if (cmdk.open) return;  // palette handles its own keys
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const map = { '1': 'upload', '2': 'dashboard', '3': 'analytics', '4': 'config', '5': 'workers', '6': 'downloads' };
  const tab = map[e.key];
  if (tab) {
    e.preventDefault();
    document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
  }
});

// ─────────── Global stats bar ───────────
// Refreshed every 15s, and immediately after any state-changing action
// (upload / delete / reset). Provides at-a-glance context on every tab.
async function refreshStatsBar() {
  try {
    const [sum, workers, act] = await Promise.all([
      api.jobsSummary(),
      api.jobsWorkerStats(),
      api.activityGet('', 1),
    ]);
    const batches = sum.batches || [];
    const totals = batches.reduce((a, b) => {
      a.total += b.total || 0;
      a.done += b.done || 0;
      a.claimed += b.claimed || 0;
      a.failed += b.failed || 0;
      return a;
    }, { total: 0, done: 0, claimed: 0, failed: 0 });
    // Online worker = last heartbeat within 5 minutes.
    const now = Date.now();
    const online = (workers.workers || []).filter(w => {
      const hb = Number(w.last_heartbeat || 0);
      return hb && (now - hb) < 5 * 60 * 1000;
    }).length;
    const kwTotal = batches.reduce((a, _) => a, 0); // computed below via a separate endpoint if needed
    // Sum keywords across batches — cheap here since summary doesn't include it.
    let kwSum = 0;
    try {
      const tl = await api.keywordsTimeline('');
      // /api/keywords/timeline is only 24h. Use a batch-level total instead
      // by summing fetchBatchKeywordStats — expensive if many batches, so we
      // just show the 24h sum here (labelled as "keywords today" via title).
      kwSum = (tl.buckets || []).reduce((a, b) => a + Number(b.n || 0), 0);
    } catch {}
    $('sbBatches').textContent   = batches.length.toLocaleString();
    $('sbWorkers').textContent   = online.toLocaleString();
    $('sbKeywords').textContent  = kwSum.toLocaleString();
    $('sbKeywords').parentElement.title = 'Keyword rows landed in the last 24h';
    $('sbInFlight').textContent  = totals.claimed.toLocaleString();
    $('sbDone').textContent      = totals.done.toLocaleString();
    $('sbFailed').textContent    = totals.failed.toLocaleString();
    const lastEv = (act.events || [])[0];
    $('sbLastActivity').textContent = lastEv ? fmtAgo(lastEv.ts) : '—';
  } catch (e) {
    // Silent — health pill shows connection state.
  }
}
setInterval(refreshStatsBar, 15000);

// ─────────── Collapsible cards ───────────
// Delegated click handler — any .card.collapsible .card-head toggles.
document.addEventListener('click', (e) => {
  const head = e.target.closest('.card.collapsible .card-head');
  if (head && !e.target.closest('button, input, select, a')) {
    head.parentElement.classList.toggle('collapsed');
  }
});

// ─────────── Tabs ───────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`panel-${btn.dataset.tab}`).classList.add('active');
    saveUI({ tab: btn.dataset.tab });
    if (btn.dataset.tab === 'dashboard') startDashPolling();
    else stopDashPolling();
    if (btn.dataset.tab === 'upload') refreshUploadSidebar();
    if (btn.dataset.tab === 'analytics') refreshAnalyticsTab();
    if (btn.dataset.tab === 'config') { loadConfigForm(); refreshOrphanCount(); refreshBackupsList(); refreshQuiesceStatus(); }
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
// Drop-zone wiring: click, drag-hover, drop.
(function wireDropZone() {
  const zone = $('uploadDropZone');
  const input = $('uploadFile');
  if (!zone || !input) return;
  zone.addEventListener('click', (e) => {
    if (e.target === input) return;
    input.click();
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('hover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('hover');
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change'));
    }
  });
})();
$('uploadFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // Visual feedback in the drop zone.
  const zone = $('uploadDropZone');
  zone?.classList.add('has-file');
  $('uploadDropPrimary').textContent = `📄 ${file.name}`;
  $('uploadDropSub').textContent = `${(file.size / 1024).toFixed(1)} KB · parsing…`;
  const buf = await file.arrayBuffer();
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch (err) { setResult($('uploadResult'), `Failed to parse: ${err.message}`, 'err'); return; }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  // Case-insensitive, whitespace-tolerant column matching — ported from
  // the extension's popup.js so any sheet that worked in the extension
  // also works here. Users write "Product URL" / "Product Name" /
  // "SKU Code" / etc.; we normalise column headers before matching.
  const products = [];
  let invalidUrl = 0, missingUrl = 0, sawSkuColumn = false;
  for (const row of rows) {
    let urlVal = '', nameVal = '', priVal = '', skuVal = '', handlesVal = '', brandVal = '';
    for (const k of Object.keys(row)) {
      const kl = String(k).toLowerCase().trim();
      const v = row[k] == null ? '' : String(row[k]).trim();
      if (!urlVal && (kl === 'product url' || kl === 'producturl' || kl === 'url' || kl === 'product_url' || kl === 'link')) urlVal = v;
      if (!nameVal && (kl === 'product name' || kl === 'productname' || kl === 'product_name' || kl === 'name' || kl === 'title')) nameVal = v;
      if (!priVal && (kl === 'priority' || kl === 'pri' || kl === 'priroty' || kl === 'prioty' || kl === 'priorty' || kl === 'rank' || kl === 'order')) priVal = v;
      if (!brandVal && (kl === 'brand' || kl === 'brands' || kl === 'brand name' || kl === 'brandname' || kl === 'manufacturer' || kl === 'maker')) brandVal = v;
      if (!skuVal) {
        const isSkuCol =
          kl === 'sku' || kl === 'product sku' || kl === 'productsku' || kl === 'item sku' ||
          kl === 'item number' || kl === 'itemnumber' || kl === 'item id' || kl === 'itemid' ||
          kl === 'product code' || kl === 'productcode' || kl === 'product id' || kl === 'productid' ||
          kl === 'product number' || kl === 'productnumber' || kl === 'item code' || kl === 'itemcode' ||
          /\bsku\b/.test(kl) || kl.endsWith('_sku') || kl.endsWith('-sku');
        if (isSkuCol) { skuVal = v; if (v) sawSkuColumn = true; }
      }
      if (!handlesVal && (kl === 'handles' || kl === 'handle' || kl === 'extra seeds' || kl === 'seeds' || kl === 'extra keywords' || kl === 'keywords')) handlesVal = v;
    }
    if (!urlVal) { missingUrl++; continue; }
    let isValid = false;
    try { const u = new URL(urlVal); isValid = u.protocol === 'http:' || u.protocol === 'https:'; } catch {}
    if (!isValid) { invalidUrl++; continue; }
    const priorityNum = parseInt(priVal, 10);
    products.push({
      url:          urlVal,
      sku:          skuVal || null,
      product_name: nameVal || null,
      priority:     (priorityNum === 1 || priorityNum === 2 || priorityNum === 3) ? priorityNum : 100,
      handles:      handlesVal || null,
      brands:       brandVal || null,
    });
  }
  state.parsedProducts = products;

  const dupes = products.length !== new Set(products.map(p => p.url)).size;
  // Diagnostic banner — tells user WHY rows were rejected instead of a
  // silent "0 parsed" that leaves them guessing.
  const notes = [];
  if (invalidUrl) notes.push(`${invalidUrl} row(s) rejected — value wasn't a valid http(s) URL`);
  if (missingUrl) notes.push(`${missingUrl} row(s) had no URL column value`);
  if (!sawSkuColumn && products.length > 0) notes.push('⚠ no SKU column detected — CSV export will use product-name slugs');
  // If NO products AND we saw rows, show the column headers we DID find
  // so the user can see exactly what got imported vs what we look for.
  let debugHeaders = '';
  if (products.length === 0 && rows.length > 0) {
    const headers = Object.keys(rows[0] || {});
    debugHeaders = `<br><small style="color:var(--text-3);">First-row columns seen in file: <code>${headers.map(h => esc(h)).join(', ') || '(none)'}</code>. Rename your URL column to <code>Product URL</code> or <code>url</code>.</small>`;
  }
  $('uploadPreview').innerHTML = `
    <div class="banner ${products.length > 0 ? 'ok' : 'warn'}" style="margin-top:10px;">
      Parsed <strong>${products.length}</strong> product URLs from ${esc(file.name)}
      ${notes.length ? `<br><small>${notes.map(esc).join(' • ')}</small>` : ''}
      ${dupes ? `<br><small>⚠ Duplicate URLs in file — manager will keep the last occurrence.</small>` : ''}
      ${debugHeaders}
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
  const zone = $('uploadDropZone');
  zone?.classList.remove('has-file');
  $('uploadDropPrimary').textContent = 'Click or drag Excel / CSV here';
  $('uploadDropSub').innerHTML = 'Required: <code>url</code> or <code>product_url</code>. Optional: <code>sku</code>, <code>product_name</code>, <code>priority</code>, <code>handles</code>, <code>brands</code>.';
});

// Upload tab sidebar — recent batches list. Refreshed on tab activation.
async function refreshUploadSidebar() {
  const body = $('uploadRecentBody');
  const sub = $('uploadRecentSub');
  if (!body) return;
  try {
    const s = await api.jobsSummary();
    const batches = (s.batches || []).slice(0, 10);
    sub.textContent = `${(s.batches || []).length} total`;
    if (batches.length === 0) {
      body.innerHTML = `<div class="empty" style="padding: 12px 6px;">No batches yet.</div>`;
      return;
    }
    body.innerHTML = batches.map(b => {
      const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
      const state = b.pending > 0 ? 'pending' : b.claimed > 0 ? 'claimed' : b.done === b.total ? 'done' : 'pending';
      return `
        <div style="padding: 6px 0; border-bottom: 1px solid var(--line-1);" title="${esc(b.batch_id)}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap: 6px;">
            <span class="mono" style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(b.batch_id)}</span>
            <span class="chip ${state}">${b.done}/${b.total}</span>
          </div>
          <div class="progress" style="margin-top: 4px;"><div class="progress-fill${pct === 100 ? ' done' : ''}" style="width: ${pct}%;"></div></div>
        </div>`;
    }).join('');
  } catch { /* stats bar surfaces errors */ }
}

$('uploadBtn').addEventListener('click', async () => {
  if (!state.parsedProducts?.length) return;
  const batchId = $('uploadBatchId').value.trim() || String(Date.now());
  $('uploadBtn').disabled = true;
  setResult($('uploadResult'), 'Uploading…', 'info');
  try {
    const r = await api.jobsUpload(batchId, state.parsedProducts);
    const msg = `Uploaded ${r.uploaded}/${r.total} to batch ${batchId}.`
      + (r.duplicatesDropped ? ` Dropped ${r.duplicatesDropped} in-file duplicates.` : '')
      + (r.skippedActive ? ` Skipped ${r.skippedActive} already-active in other batches.` : '');
    setResult($('uploadResult'), '✓ ' + msg, 'ok');
    toast(msg, 'ok', { title: 'Batch uploaded' });
    refreshStatsBar();
    refreshUploadSidebar();
  } catch (e) {
    setResult($('uploadResult'), `Upload failed: ${e.message}`, 'err');
    toast(e.message, 'err', { title: 'Upload failed' });
  } finally {
    $('uploadBtn').disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD TAB
// ═══════════════════════════════════════════════════════════════
$('dashBatchSelect').addEventListener('change', () => {
  state.activeBatch = $('dashBatchSelect').value;
  saveUI({ batch: state.activeBatch });
  refreshDashboard();
});
$('dashRefreshInterval').addEventListener('change', () => {
  state.dashIntervalMs = parseInt($('dashRefreshInterval').value, 10) || 0;
  saveUI({ interval: state.dashIntervalMs });
  startDashPolling();
});
$('dashRefreshBtn').addEventListener('click', refreshDashboard);
// Activity log worker filter — scoping the log to one worker is
// essential once you have 3+ workers all logging every 30s.
$('activityWorkerFilter')?.addEventListener('change', () => {
  state.workerFilter = $('activityWorkerFilter').value || '';
  saveUI({ workerFilter: state.workerFilter });
  const sub = $('activityLogSub');
  if (sub) sub.textContent = state.workerFilter ? `filtered to ${state.workerFilter}` : 'latest 120 events';
  refreshDashboard();
});
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
    const [summary, workers, roster, activity, failed, timeline, errors, kwBatches, names] = await Promise.all([
      api.jobsSummary(),
      api.jobsWorkerStats(),
      api.workersList().catch(() => ({ workers: [] })),
      api.activityGet(state.activeBatch, 120, state.workerFilter),
      api.failedJobs(state.activeBatch).catch(() => ({ rows: [] })),
      api.keywordsTimeline(state.activeBatch).catch(() => ({ buckets: [] })),
      api.activityErrors(state.activeBatch, 60).catch(() => ({ events: [] })),
      api.keywordsBatches().catch(() => ({ batches: [] })),
      api.batchNames().catch(() => ({ names: [] })),
    ]);
    state.keywordBatches = kwBatches.batches || [];
    state.batchNames = new Map((names.names || []).map(n => [n.batch_id, n]));
    // Merge fleet: workers with jobs history (workers.workers) + workers
    // that only heartbeat but haven't claimed yet (roster.workers). The
    // roster ensures armed-idle workers are visible in the fleet — they
    // used to show as '0 online' because the jobs-derived stats can't
    // see workers who've never touched a job.
    const jobsWorkerIds = new Set((workers.workers || []).map(w => w.worker_id));
    const idleFromRoster = (roster.workers || []).filter(w => !jobsWorkerIds.has(w.worker_id))
      .map(w => ({
        worker_id: w.worker_id,
        batch_id: null,
        total_touched: 0, done_count: 0, failed_count: 0, in_flight: 0,
        done: 0, failed: 0,
        last_heartbeat: w.last_seen,
      }));
    workers.workers = [...(workers.workers || []), ...idleFromRoster];
    state.batches = summary.batches || [];
    // Detect newly-connected workers (first time we see this worker_id)
    // and pop a friendly toast so the manager knows their install worked.
    const seenIds = state.seenWorkerIds;
    for (const w of (workers.workers || [])) {
      if (!seenIds.has(w.worker_id)) {
        if (seenIds.size > 0) toast(`Worker ${w.worker_id} online`, 'ok', { title: 'Worker connected' });
        seenIds.add(w.worker_id);
      }
    }
    state.workers = workers.workers || [];
    // Enrich each worker with their most recent activity line so the
    // fleet grid can show 'what step is this worker on right now'.
    // Uses the whole-log fetch (activity.events) rather than a separate
    // per-worker call — cheap because it's one API call already made.
    const lastByWorker = new Map();
    for (const ev of (activity.events || [])) {
      if (!ev.worker_id) continue;
      if (!lastByWorker.has(ev.worker_id)) lastByWorker.set(ev.worker_id, ev);
    }
    for (const w of state.workers) {
      w._lastActivity = lastByWorker.get(w.worker_id) || null;
    }
    // Emit toast notifications for passive events (SKU done, batch
    // complete, worker offline, etc.) that happened since the last
    // refresh. Skipped on the very first refresh so we don't blast the
    // user with "welcome, here are 47 things that already happened".
    detectAndToastEvents(state.batches, state.workers, activity.events || []);
    renderBatchOverview();
    renderWorkerFleet();
    // Keep the activity-log worker filter dropdown in sync with the fleet.
    // Every worker we've ever seen appears as an option; disappearing
    // workers stay listed so their history remains reachable.
    (() => {
      const sel = $('activityWorkerFilter'); if (!sel) return;
      const allIds = new Set([
        ...state.workers.map(w => w.worker_id).filter(Boolean),
        ...(state.workerFilter ? [state.workerFilter] : []),
      ]);
      const cur = sel.value;
      sel.innerHTML = `<option value="">All workers</option>` +
        Array.from(allIds).sort().map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      sel.value = state.workerFilter || cur || '';
    })();
    renderActivity(activity.events || []);
    renderFailedCard(failed.rows || []);
    renderErrorsCard(errors.events || []);
    renderTrendChart(timeline);
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

function batchLabel(batchId) {
  // Prefer user-friendly name if set; otherwise fall back to the raw id.
  const info = state.batchNames.get(batchId);
  if (info?.display_name) return `${info.display_name}  (${batchId.slice(-6)})`;
  return batchId;
}
function populateBatchSelects() {
  // Batches with jobs (from summary).
  const jobsBatchIds = new Set(state.batches.map(b => b.batch_id));
  const jobsOpts = state.batches.map(b => `<option value="${esc(b.batch_id)}">${esc(batchLabel(b.batch_id))} — ${b.total} SKUs</option>`).join('');
  // Batches that ONLY have keyword rows (orphans — jobs got wiped by reset
  // while workers were still pushing results from their local state). Users
  // still need to view/download these, so include them in the picker with
  // a clear label.
  const orphanOpts = (state.keywordBatches || [])
    .filter(b => !jobsBatchIds.has(b.batch_id))
    .map(b => `<option value="${esc(b.batch_id)}">${esc(batchLabel(b.batch_id))} — ${b.row_count} kw (orphan)</option>`)
    .join('');
  const allOpts = jobsOpts + orphanOpts;
  const renameSel = $('renameBatchSelect');
  if (renameSel) renameSel.innerHTML = `<option value="">— pick a batch —</option>` + allOpts;
  // The delete/pin selects are for BATCHES WITH JOBS ONLY (you can't
  // meaningfully pin an orphan batch — no work to hand to workers).
  for (const id of ['dashBatchSelect', 'downloadBatchSelect', 'anBatchSelect']) {
    const el = $(id);
    if (!el) continue;
    const cur = el.value;
    el.innerHTML = `<option value="">— none —</option>${allOpts}`;
    if (cur && Array.from(el.options).some(o => o.value === cur)) el.value = cur;
  }
  for (const id of ['pinBatchSelect', 'deleteBatchSelect']) {
    const el = $(id);
    if (!el) continue;
    const cur = el.value;
    el.innerHTML = `<option value="">— none —</option>${jobsOpts}`;
    if (cur && Array.from(el.options).some(o => o.value === cur)) el.value = cur;
  }
}

function renderBatchOverview() {
  const el = $('batchOverview');
  $('batchCountLabel').textContent = `${state.batches.length} batch(es)`;
  if (state.batches.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">📭</div>
      <strong>No batches yet</strong>
      <div style="margin-top: 6px;"><a href="#" onclick="document.querySelector('.tab[data-tab=upload]').click(); return false;" style="color: var(--accent); text-decoration: none;">📤 Upload some products →</a></div>
    </div>`;
    return;
  }
  el.innerHTML = `<table class="tbl">
    <thead><tr><th>Batch</th><th style="width: 30%;">Progress</th><th class="num">Total</th><th class="num">Done</th><th class="num">Failed</th></tr></thead>
    <tbody>${state.batches.map(b => {
      const done = b.done || 0, failed = b.failed || 0, claimed = b.claimed || 0, total = b.total || 0;
      const donePct = total ? (done / total) * 100 : 0;
      const claimedPct = total ? (claimed / total) * 100 : 0;
      const complete = done + failed === total && total > 0;
      const fillClass = complete ? 'done' : (claimed > 0 ? '' : (donePct > 0 ? '' : 'stuck'));
      // Stacked bar: done (green/gradient) + claimed (accent), pending is background.
      return `
        <tr style="cursor:pointer;" onclick="document.getElementById('dashBatchSelect').value='${esc(b.batch_id)}'; document.getElementById('dashBatchSelect').dispatchEvent(new Event('change'));">
          <td class="mono">${esc(b.batch_id)}</td>
          <td>
            <div class="progress">
              <div class="progress-fill ${fillClass}" style="width: ${donePct.toFixed(1)}%;"></div>
            </div>
            <div style="font-size: 10px; color: var(--text-3); margin-top: 2px;">
              ${done + failed}/${total} · ${donePct.toFixed(0)}%
              ${claimed > 0 ? ` · <span style="color: var(--warn);">${claimed} in flight</span>` : ''}
            </div>
          </td>
          <td class="num">${total}</td>
          <td class="num" style="color:var(--success);">${done}</td>
          <td class="num" style="color:${failed > 0 ? 'var(--danger)' : 'var(--text-3)'};">${failed}</td>
        </tr>`;
    }).join('')}
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
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">🖥️</div>
      <strong>No workers seen yet</strong>
      <div style="margin-top: 6px; color: var(--text-3);">Run the one-line installer on a worker PC.
      <br><a href="#" onclick="document.querySelector('.tab[data-tab=workers]').click(); return false;" style="color: var(--accent); text-decoration: none;">🔗 Get the install command →</a></div>
    </div>`;
    return;
  }
  // Friendly stage label mapper. Maps activity source + message pattern
  // into a compact "what is this worker doing" tag for the fleet grid.
  // Also called with the worker's row so we can differentiate 'truly
  // idle' from 'offline — no heartbeat in minutes'.
  const stageFor = (act, worker) => {
    // Heartbeat-based short-circuit: if we haven't heard from this
    // worker in > 3 minutes, they're not idle — they're gone. Don't
    // pretend last activity is current.
    if (worker) {
      const hb = Number(worker.last_heartbeat || 0);
      const ago = Date.now() - hb;
      if (!hb || ago > 5 * 60 * 1000) return { label: 'OFFLINE', color: 'var(--danger)' };
      if (ago > 3 * 60 * 1000)        return { label: 'stale (no heartbeat)', color: 'var(--warn)' };
    }
    if (!act) return { label: 'idle', color: 'var(--text-3)' };
    const src = (act.source || '').toLowerCase();
    const msg = (act.message || '').toLowerCase();
    if (msg.includes('stop pressed') || msg.includes('halting')) return { label: 'paused/stopping', color: 'var(--warn)' };
    if (msg.includes('wake ignored') || msg.includes('stopped by')) return { label: 'stopped by user', color: 'var(--danger)' };
    if (src === 'done') return { label: 'wrapping up SKU', color: 'var(--success)' };
    if (src === 'product') return { label: 'fetching product', color: 'var(--info)' };
    if (src === 'context') return { label: 'analyzing context', color: 'var(--info)' };
    if (msg.includes('clip model') || msg.includes('embedding')) return { label: 'CLIP embed', color: 'var(--info)' };
    if (src === 'kp' || src === 'kp expan') return { label: 'KP scrape', color: '#c4b5fd' };
    if (src === 'serp') return { label: 'SERP + image match', color: '#86efac' };
    if (src === 'verify') return { label: 'link verify', color: '#7dd3fc' };
    if (src === 'autosugg') return { label: 'autosuggest', color: '#fcd34d' };
    if (src === 'expand') return { label: 'expanding leaves', color: '#f9a8d4' };
    if (src === 'round2') return { label: 'Round 2', color: '#fdba74' };
    if (src === 'round1') return { label: 'Round 1', color: '#86efac' };
    if (src === 'autopoll') return { label: 'polling for work', color: 'var(--text-3)' };
    if (src === 'cmd') return { label: msg.slice(0, 30), color: 'var(--info)' };
    return { label: (act.message || '').slice(0, 30), color: 'var(--text-2)' };
  };

  el.innerHTML = `<table class="tbl">
    <thead><tr><th>Worker</th><th>Current step</th><th>Last hb</th><th class="num">In-flight</th><th class="num">Done</th><th class="num">Failed</th><th style="width: 1%;">Actions</th></tr></thead>
    <tbody>${state.workers.map(w => {
      const stage = stageFor(w._lastActivity, w);
      return `
      <tr>
        <td><span class="chip ${workerDotClass(w.last_heartbeat)}">●</span>
            <a href="#" class="mono" data-filter-worker="${esc(w.worker_id)}" style="color: var(--info); text-decoration: none;" title="Filter activity log to this worker">${esc(w.worker_id)}</a></td>
        <td><span style="color: ${stage.color}; font-size: 11px;" title="${esc(w._lastActivity?.message || '')}">${esc(stage.label)}</span>
            ${w._lastActivity ? `<div style="font-size: 10px; color: var(--text-3);">${fmtAgo(w._lastActivity.ts)}</div>` : ''}</td>
        <td>${fmtAgo(w.last_heartbeat)}</td>
        <td class="num">${w.in_flight || 0}</td>
        <td class="num" style="color:var(--success);">${w.done || 0}</td>
        <td class="num" style="color:${(w.failed||0) > 0 ? 'var(--danger)' : 'var(--text-3)'};">${w.failed || 0}</td>
        <td>
          <div class="worker-actions">
            <button data-worker="${esc(w.worker_id)}" data-cmd="wake"   title="Wake — start claiming (respects manual Stop on the worker PC)">▶</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="reconnect" title="Force reconnect — overrides Stop, use if Wake was ignored" style="color: var(--warn); border-color: var(--warn);">⟳</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="pause"  title="Pause after current SKU">⏸</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="release_claims" class="danger-btn" title="Release claims back to queue">↻</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="stop"   class="danger-btn" title="Stop and disarm">■</button>
            <button data-worker="${esc(w.worker_id)}" data-wol="1" title="Wake-on-LAN — send magic packet to this PC's NIC (only works if this manager PC is on the same physical LAN as the target)" style="color: var(--info); border-color: var(--info);">🔌</button>
          </div>
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
  // Click worker ID -> filter activity log to that worker.
  el.querySelectorAll('a[data-filter-worker]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const w = a.dataset.filterWorker;
      state.workerFilter = w;
      saveUI({ workerFilter: w });
      const sel = $('activityWorkerFilter'); if (sel) sel.value = w;
      const sub = $('activityLogSub'); if (sub) sub.textContent = `filtered to ${w}`;
      toast(`Activity log now scoped to ${w}`, 'info');
      refreshDashboard();
    });
  });
  // Wire per-worker action buttons.
  el.querySelectorAll('.worker-actions button[data-worker][data-cmd]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const workerId = btn.dataset.worker;
      const cmd = btn.dataset.cmd;
      const cmdLabel = { wake: 'Wake', reconnect: 'Force reconnect', pause: 'Pause', release_claims: 'Release claims from', stop: 'Stop' }[cmd] || cmd;
      if (cmd === 'stop' && !confirm(`Stop worker ${workerId} and disarm it? They will not claim more work until you send Wake.`)) return;
      try { await api.commandsSend(workerId, cmd); toast(`${cmdLabel} → ${workerId}`, 'ok'); }
      catch (e) { toast(e.message, 'err', { title: 'Command failed' }); }
    });
  });
  // Wire the Wake-on-LAN button — separate flow because it uses its
  // own endpoint (dgram UDP magic packet, not the worker_commands DB).
  el.querySelectorAll('.worker-actions button[data-wol]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const workerId = btn.dataset.worker;
      try {
        const r = await api.wakeOnLan(workerId);
        toast(`Magic packet sent to ${r.mac}. PC should wake in 10-30s if WOL enabled in BIOS.`, 'ok', { title: 'WOL sent' });
      } catch (e) {
        if (e.status === 400 && /no MAC available/.test(e.message)) {
          const mac = prompt(`No MAC stored for ${workerId}. Enter the MAC (e.g. AA:BB:CC:DD:EE:FF):\n\n(Find it on the worker PC with:  ipconfig /all)`);
          if (!mac) return;
          try {
            await api.setWorkerMac(workerId, mac);
            const r2 = await api.wakeOnLan(workerId);
            toast(`MAC saved + WOL sent (${r2.mac})`, 'ok', { title: 'WOL sent' });
          } catch (e2) { toast(e2.message, 'err', { title: 'WOL failed' }); }
        } else {
          toast(e.message, 'err', { title: 'WOL failed' });
        }
      }
    });
  });
}

function renderFailedCard(rows) {
  const card = $('failedCard');
  const list = $('failedList');
  const sub = $('failedSub');
  if (!rows || rows.length === 0) {
    if (card) card.style.display = 'none';
    return;
  }
  card.style.display = '';
  sub.textContent = `${rows.length} row(s)${state.activeBatch ? ` in ${state.activeBatch}` : ' across all batches'}`;
  list.innerHTML = `<table class="tbl">
    <thead><tr><th>SKU</th><th>Product</th><th>Reason</th><th>Worker</th><th class="num">Attempts</th></tr></thead>
    <tbody>${rows.slice(0, 100).map(f => `
      <tr>
        <td class="mono">${esc(f.sku || '—')}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(f.product_url || '')}">${esc(f.product_name || f.product_url || '—')}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--danger);" title="${esc(f.failed_reason || '')}">${esc((f.failed_reason || '').slice(0, 80) || '—')}</td>
        <td class="mono">${esc(f.claimed_by || '—')}</td>
        <td class="num">${f.attempts || 0}</td>
      </tr>`).join('')}</tbody></table>`;
}

// Errors card — surfaces every level='err' activity_log entry with
// worker + source + product context. Separate from the general
// activity feed so a manager can triage "which worker is throwing
// what" without scrolling through 500 lines of normal activity.
function renderErrorsCard(events) {
  const card = $('errorsCard');
  const list = $('errorsList');
  const sub = $('errorsSub');
  if (!events || events.length === 0) {
    if (card) card.style.display = 'none';
    return;
  }
  card.style.display = '';
  // Group by worker so the manager can spot "one PC is throwing all of them" fast.
  const byWorker = {};
  for (const e of events) {
    const k = e.worker_id || '—';
    if (!byWorker[k]) byWorker[k] = [];
    byWorker[k].push(e);
  }
  const workerCount = Object.keys(byWorker).length;
  sub.textContent = `${events.length} error(s) across ${workerCount} worker(s)`;
  list.innerHTML = events.slice(0, 60).map(e => {
    const src = (e.source || 'engine').toLowerCase();
    const ctx = [];
    if (e.sku) ctx.push(`SKU: <span class="mono">${esc(e.sku)}</span>`);
    if (e.product_url) ctx.push(`URL: <span class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom;" title="${esc(e.product_url)}">${esc(e.product_url.slice(0, 40))}${e.product_url.length > 40 ? '…' : ''}</span>`);
    return `
      <div style="padding: 6px 0; border-bottom: 1px solid var(--line-1); display: grid; grid-template-columns: 90px 100px 60px 1fr; gap: 8px; font-size: 11px;">
        <span style="color: var(--text-3); font-family: var(--mono);">${fmtTime(e.ts)}</span>
        <a href="#" class="mono" data-filter-worker="${esc(e.worker_id || '')}" style="color: var(--info); text-decoration: none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="Filter to this worker">${esc(e.worker_id || '—')}</a>
        <span class="src" data-src="${esc(src)}" style="align-self: start;">${esc(src)}</span>
        <div>
          <div style="color: var(--danger);">${esc(e.message || '')}</div>
          ${ctx.length > 0 ? `<div style="color: var(--text-3); font-size: 10px; margin-top: 2px;">${ctx.join(' &middot; ')}</div>` : ''}
        </div>
      </div>`;
  }).join('');
  // Wire worker-id links to filter (same as activity log click-through).
  list.querySelectorAll('a[data-filter-worker]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const w = a.dataset.filterWorker;
      if (!w) return;
      state.workerFilter = w;
      saveUI({ workerFilter: w });
      $('activityWorkerFilter').value = w;
      $('activityLogSub').textContent = `filtered to ${w}`;
      refreshDashboard();
    });
  });
}

function renderTrendChart(timeline) {
  const chart = $('trendChart');
  const sub = $('trendSub');
  if (!chart) return;
  const buckets = timeline?.buckets || [];
  // Build a 24-hour grid: for each of the last 24 hours, look up the row count.
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const counts = [];
  const byBucket = new Map(buckets.map(b => [Number(b.bucket), Number(b.n)]));
  let total = 0;
  for (let i = 23; i >= 0; i--) {
    const bucket = nowHour - i * 3600000;
    const n = byBucket.get(bucket) || 0;
    counts.push({ hour: bucket, n });
    total += n;
  }
  const max = Math.max(1, ...counts.map(c => c.n));
  sub.textContent = `${total.toLocaleString()} rows in the last 24h`;
  chart.innerHTML = counts.map(c => {
    const pct = Math.max(2, Math.round((c.n / max) * 100));
    const isNow = c.hour === nowHour;
    const label = new Date(c.hour).toLocaleTimeString([], { hour: '2-digit' });
    return `<div class="trend-bar ${isNow ? 'now' : ''}" style="height: ${pct}%;" title="${label}: ${c.n} rows"></div>`;
  }).join('');
}

// Wire bulk-requeue button (declared in HTML, so wire once at boot).
$('requeueAllFailedBtn')?.addEventListener('click', async () => {
  const scope = state.activeBatch ? `batch "${state.activeBatch}"` : 'ALL batches';
  if (!confirm(`Re-queue every failed job in ${scope}?`)) return;
  try {
    const r = await api.requeueAllFailed(state.activeBatch || '');
    toast(`${r.updated} job(s) back to pending`, 'ok', { title: 'Re-queued' });
    refreshDashboard();
  } catch (e) { toast(e.message, 'err', { title: 'Re-queue failed' }); }
});

function renderActivity(events) {
  const el = $('activityLog');
  if (!events || events.length === 0) {
    el.innerHTML = `<div class="empty">No activity yet.</div>`;
    return;
  }
  el.innerHTML = events.map(e => {
    const src = (e.source || 'engine').toLowerCase().slice(0, 8);
    return `
    <div class="log-line ${esc(e.level || 'info')}">
      <span class="ts">${fmtTime(e.ts)}</span>
      <span class="worker">${esc(e.worker_id || '—')}</span>
      <span class="src" data-src="${esc(src)}">${esc(src)}</span>
      <span class="msg">${esc(e.message || '')}</span>
    </div>`;
  }).join('');
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
  try {
    await api.configSet(cfg);
    setResult($('saveConfigResult'), '✓ Saved. Workers will pick this up within ~30s.', 'ok');
    toast('Workers will pick this up within ~30s', 'ok', { title: 'Config pushed' });
  } catch (e) {
    setResult($('saveConfigResult'), `Save failed: ${e.message}`, 'err');
    toast(e.message, 'err', { title: 'Config save failed' });
  }
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
// Prefill the name input when the user picks a batch — makes it obvious
// they're editing an existing label, not creating a fresh one.
$('renameBatchSelect')?.addEventListener('change', () => {
  const id = $('renameBatchSelect').value;
  const cur = id ? (state.batchNames.get(id)?.display_name || '') : '';
  $('renameBatchName').value = cur;
});
$('renameBatchBtn')?.addEventListener('click', async () => {
  const id = $('renameBatchSelect').value;
  const name = ($('renameBatchName').value || '').trim();
  if (!id) { setResult($('renameBatchResult'), 'Pick a batch first.', 'warn'); return; }
  try {
    const r = await api.renameBatch(id, name);
    if (name) {
      state.batchNames.set(id, { batch_id: id, display_name: name });
      setResult($('renameBatchResult'), `✓ Renamed to "${name}".`, 'ok');
      toast(`"${id.slice(-8)}" is now "${name}"`, 'ok', { title: 'Batch renamed' });
    } else {
      state.batchNames.delete(id);
      setResult($('renameBatchResult'), '✓ Name cleared — will show raw batch_id.', 'ok');
      toast('Name cleared', 'ok', { title: 'Batch label removed' });
    }
    populateBatchSelects();  // reflect immediately
  } catch (e) {
    setResult($('renameBatchResult'), `Failed: ${e.message}`, 'err');
    toast(e.message, 'err', { title: 'Rename failed' });
  }
});

$('deleteBatchBtn').addEventListener('click', async () => {
  const b = $('deleteBatchSelect').value;
  if (!b) { setResult($('deleteBatchResult'), 'Pick a batch to delete.', 'warn'); return; }
  if (!confirm(`Delete batch "${b}"? This wipes every job, keyword row, and activity entry for it. Cannot be undone.`)) return;
  try {
    const r = await api.deleteBatch(b);
    const msg = `${r.deletedJobs} job(s) + ${r.deletedKeywords} keyword(s) + ${r.deletedActivity} activity row(s) deleted.`;
    setResult($('deleteBatchResult'), `✓ ${msg}`, 'ok');
    toast(msg, 'ok', { title: `Batch "${b}" deleted` });
    await loadConfigForm();
  } catch (e) { setResult($('deleteBatchResult'), `Delete failed: ${e.message}`, 'err'); toast(e.message, 'err', { title: 'Delete failed' }); }
});
// Reset-everything guard: button only enables when user types RESET exactly.
$('resetConfirmInput').addEventListener('input', () => {
  $('resetAllBtn').disabled = $('resetConfirmInput').value !== 'RESET';
});
$('resetAllBtn').addEventListener('click', async () => {
  if ($('resetConfirmInput').value !== 'RESET') return;
  // Preflight: check for active workers and in-flight jobs. If either is
  // non-zero, we'll create orphan keyword rows (workers push results after
  // reset with old batch_ids). Warn explicitly with counts.
  let preflight = null;
  try { preflight = await api.keywordsOrphans(); } catch {}
  let msg = 'LAST WARNING — this wipes every batch, every keyword row, every activity entry, every command. Only worker config (KP URL, token, pacing) is preserved. Continue?';
  if (preflight && (preflight.activeWorkers > 0 || preflight.claimedNow > 0)) {
    msg = `⚠ WORK IN PROGRESS DETECTED\n\n`
        + `- Active workers (heartbeat < 3 min): ${preflight.activeWorkers}\n`
        + `- Jobs currently claimed (in-flight): ${preflight.claimedNow}\n\n`
        + `If you reset NOW, those workers will keep processing locally and push their `
        + `results with the old batch_id → creating orphan keyword rows.\n\n`
        + `RECOMMENDED: click 'Stop' or 'Release claims' on each worker in the Dashboard `
        + `first, wait 30-60s for them to quiesce, THEN reset.\n\n`
        + `Continue with the reset anyway?`;
  }
  if (!confirm(msg)) return;
  try {
    const r = await api.resetAll();
    const msg = `${r.deletedJobs} jobs, ${r.deletedKeywords} keywords, ${r.deletedActivity} activity, ${r.deletedCommands} commands.`;
    setResult($('resetAllResult'), `✓ ${msg}`, 'ok');
    toast(msg, 'ok', { title: 'Everything reset' });
    $('resetConfirmInput').value = '';
    $('resetAllBtn').disabled = true;
    await loadConfigForm();
  } catch (e) { setResult($('resetAllResult'), `Reset failed: ${e.message}`, 'err'); toast(e.message, 'err', { title: 'Reset failed' }); }
});
// Orphan-keywords cleanup — refreshes count on tab open + on button click.
async function refreshOrphanCount() {
  const sub = $('orphanCountSub');
  const btn = $('cleanupOrphansBtn');
  if (!sub || !btn) return;
  try {
    const r = await api.keywordsOrphans();
    if (r.orphanRows > 0) {
      sub.textContent = `${r.orphanRows.toLocaleString()} row(s) across ${r.orphanBatches} batch(es)`;
      sub.style.color = 'var(--warn)';
      btn.disabled = false;
    } else {
      sub.textContent = 'none — DB is clean';
      sub.style.color = 'var(--success)';
      btn.disabled = true;
    }
  } catch (e) { sub.textContent = 'error'; }
}
$('refreshOrphansBtn')?.addEventListener('click', refreshOrphanCount);
$('cleanupOrphansBtn')?.addEventListener('click', async () => {
  if (!confirm('Delete every orphan keyword row? This cannot be undone. Download them first from the Downloads tab if you need the data.')) return;
  try {
    const r = await api.cleanupOrphans();
    setResult($('cleanupOrphansResult'), `✓ Deleted ${r.deleted.toLocaleString()} orphan row(s).`, 'ok');
    toast(`${r.deleted} orphan keyword row(s) deleted`, 'ok', { title: 'Cleaned' });
    refreshOrphanCount();
  } catch (e) {
    setResult($('cleanupOrphansResult'), `Cleanup failed: ${e.message}`, 'err');
    toast(e.message, 'err', { title: 'Cleanup failed' });
  }
});
// ─────────── Quiesce workers ───────────
// Broadcasts pause + polls status every 3s while the poller is active.
// Poller auto-stops when active-workers + claimed-now both hit 0.
let quiescePollTimer = null;
async function refreshQuiesceStatus() {
  const sub = $('quiesceSub');
  const status = $('quiesceStatus');
  if (!sub || !status) return;
  try {
    // Reuses the /api/keywords/orphans endpoint which conveniently reports
    // activeWorkers + claimedNow — no separate endpoint needed.
    const r = await api.keywordsOrphans();
    const quiet = r.activeWorkers === 0 && r.claimedNow === 0;
    if (quiet) {
      sub.textContent = 'quiet — safe to reset';
      sub.style.color = 'var(--success)';
      status.innerHTML = `<div class="banner ok">✓ No active workers, no in-flight jobs. Safe to reset or shut down without creating orphan keyword rows.</div>`;
      if (quiescePollTimer) { clearInterval(quiescePollTimer); quiescePollTimer = null; }
    } else {
      sub.textContent = `${r.activeWorkers} worker(s), ${r.claimedNow} in-flight`;
      sub.style.color = 'var(--warn)';
      status.innerHTML = `<div class="banner warn">
        <strong>Not yet quiet:</strong> ${r.activeWorkers} worker(s) online, ${r.claimedNow} job(s) currently claimed.
        ${quiescePollTimer ? '<br><small>Waiting for workers to finish current SKU… (polling every 3s)</small>' : ''}
      </div>`;
    }
  } catch (e) { sub.textContent = 'error'; sub.style.color = 'var(--danger)'; }
}
$('quiesceRefreshBtn')?.addEventListener('click', refreshQuiesceStatus);
$('quiesceBtn')?.addEventListener('click', async () => {
  if (!confirm('Send Pause to all workers? Each worker will finish its current SKU, push results, and stop claiming. This is safe (no data loss).')) return;
  try {
    const r = await api.quiesceWorkers();
    toast(`Pause sent to workers. Active=${r.activeWorkers}, in-flight=${r.claimedNow}. Polling status every 3s.`, 'info', { title: 'Quiescing…' });
    if (quiescePollTimer) clearInterval(quiescePollTimer);
    quiescePollTimer = setInterval(refreshQuiesceStatus, 3000);
    refreshQuiesceStatus();
  } catch (e) { toast(e.message, 'err', { title: 'Quiesce failed' }); }
});

// ─────────── Backups ───────────
async function refreshBackupsList() {
  const list = $('backupsList');
  const sub = $('backupsSub');
  if (!list || !sub) return;
  try {
    const r = await api.backupsList();
    const backups = r.backups || [];
    const totalBytes = backups.reduce((a, b) => a + (b.size || 0), 0);
    sub.textContent = `${backups.length} backup(s) · ${(totalBytes / 1024 / 1024).toFixed(1)} MB · keeping ${r.keepN}`;
    if (backups.length === 0) {
      list.innerHTML = `<div class="empty" style="padding: 12px 8px;">No backups yet.</div>`;
      return;
    }
    list.innerHTML = `<table class="tbl">
      <thead><tr><th>File</th><th>When</th><th class="num">Size</th></tr></thead>
      <tbody>${backups.map(b => `
        <tr>
          <td class="mono" style="font-size: 11px;" title="${esc(b.path)}">${esc(b.name)}</td>
          <td>${fmtTime(b.mtime)} <span style="color: var(--text-3); font-size: 10px;">(${fmtAgo(b.mtime)})</span></td>
          <td class="num">${(b.size / 1024).toFixed(0)} KB</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="hint" style="margin-top: 8px;">Backups live at <code>${esc(r.dir)}</code> — copy them off-machine periodically for real disaster recovery.</div>`;
  } catch (e) { sub.textContent = 'error'; }
}
$('backupsRefreshBtn')?.addEventListener('click', refreshBackupsList);
$('backupNowBtn')?.addEventListener('click', async () => {
  setResult($('backupResult'), 'Creating backup…', 'info');
  try {
    const r = await api.backupNow();
    setResult($('backupResult'), `✓ Wrote ${r.path.split(/[\\/]/).pop()} (${(r.size / 1024).toFixed(0)} KB${r.pruned ? `, pruned ${r.pruned} older`  : ''})`, 'ok');
    toast(`Backup written (${(r.size / 1024).toFixed(0)} KB)`, 'ok', { title: 'Backup complete' });
    refreshBackupsList();
  } catch (e) {
    setResult($('backupResult'), `Backup failed: ${e.message}`, 'err');
    toast(e.message, 'err', { title: 'Backup failed' });
  }
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
  // Render the one-liner PowerShell installer with THIS manager URL baked in.
  const installer = $('installOneLiner');
  if (installer) installer.textContent = `irm ${window.location.origin}/install-worker.ps1 | iex`;
  const uninst = $('uninstallOneLiner');
  if (uninst) uninst.textContent = `irm ${window.location.origin}/uninstall-worker.ps1 | iex`;
  const uninstFull = $('uninstallFullOneLiner');
  if (uninstFull) uninstFull.textContent = `$s = irm ${window.location.origin}/uninstall-worker.ps1; iex "& { $s } -Full"`;
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
    <div class="hint">${kpUrl ? '✓ Includes your saved KP URL' : '⚠ No KP URL saved yet — workers cannot run KP. Save one in Config tab.'}</div>
  `;
  $('copySetupBtn').disabled = false;
  $('setupCodeWarn').style.display = managerToken ? '' : 'none';
});
$('copySetupBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.setupCode); $('copySetupBtn').textContent = '✓ Copied'; setTimeout(() => $('copySetupBtn').textContent = 'Copy', 1500); }
  catch { alert('Clipboard blocked. Select the code above and Ctrl+C.'); }
});
$('copyInstallBtn')?.addEventListener('click', async () => {
  const cmd = $('installOneLiner').textContent;
  try { await navigator.clipboard.writeText(cmd); $('copyInstallBtn').textContent = '✓ Copied'; setTimeout(() => $('copyInstallBtn').textContent = 'Copy', 1500); }
  catch { alert('Clipboard blocked. Select the command and Ctrl+C manually.'); }
});
$('copyUninstallBtn')?.addEventListener('click', async () => {
  const cmd = $('uninstallOneLiner').textContent;
  try { await navigator.clipboard.writeText(cmd); $('copyUninstallBtn').textContent = '✓ Copied'; setTimeout(() => $('copyUninstallBtn').textContent = 'Copy', 1500); }
  catch { alert('Clipboard blocked. Select the command and Ctrl+C manually.'); }
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
  const body = $('downloadListBody');
  const sub = $('downloadListSub');
  try {
    const [s, kwB] = await Promise.all([
      api.jobsSummary(),
      api.keywordsBatches().catch(() => ({ batches: [] })),
    ]);
    state.batches = s.batches || [];
    state.keywordBatches = kwB.batches || [];
    populateBatchSelects();
    // Auto-select the only batch when there's exactly one, same as Analytics.
    const dSel = $('downloadBatchSelect');
    if (dSel && !dSel.value && state.batches.length === 1) {
      dSel.value = state.batches[0].batch_id;
    }
    if (state.batches.length === 0) {
      sub.textContent = '0';
      body.innerHTML = `<div class="empty" style="padding: 20px 8px;">
        <div class="empty-icon">📭</div>
        <strong>No batches yet</strong>
        <div style="margin-top: 6px;"><a href="#" onclick="document.querySelector('.tab[data-tab=upload]').click(); return false;" style="color: var(--accent); text-decoration: none;">📤 Upload some products →</a></div>
      </div>`;
      return;
    }
    // Merge: batches with jobs + orphan batches (keywords only, no jobs).
    const jobsIds = new Set(state.batches.map(b => b.batch_id));
    const orphans = (state.keywordBatches || []).filter(b => !jobsIds.has(b.batch_id));
    const totalListed = state.batches.length + orphans.length;
    sub.textContent = `${totalListed}${orphans.length > 0 ? ` (${orphans.length} orphan)` : ''}`;
    const jobBatchRows = state.batches.map(b => {
      const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
      return `
        <div style="padding: 8px 0; border-bottom: 1px solid var(--line-1); display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center;">
          <div>
            <div class="mono" style="font-size: 11px; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(b.batch_id)}</div>
            <div class="progress"><div class="progress-fill${pct === 100 ? ' done' : ''}" style="width: ${pct}%;"></div></div>
            <div style="font-size: 10px; color: var(--text-3); margin-top: 2px;">${b.done}/${b.total} done · ${pct}%</div>
          </div>
          <div style="font-size: 11px; color: var(--text-2); font-family: var(--mono);" title="Total SKUs">${b.total} SKU</div>
          <button class="small" data-download-batch="${esc(b.batch_id)}" title="Download all CSVs for this batch">📥 Download</button>
        </div>`;
    }).join('');
    const orphanRows = orphans.map(b => `
        <div style="padding: 8px 0; border-bottom: 1px solid var(--line-1); display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center;" title="Orphan — keyword rows exist but the batch's jobs were wiped (usually by a reset while workers were still pushing).">
          <div>
            <div class="mono" style="font-size: 11px; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(b.batch_id)} <span style="color: var(--warn); font-size: 10px;">ORPHAN</span></div>
            <div style="font-size: 10px; color: var(--text-3); margin-top: 2px;">${b.row_count.toLocaleString()} keyword rows · no jobs</div>
          </div>
          <div style="font-size: 11px; color: var(--text-3); font-family: var(--mono);">—</div>
          <button class="small" data-download-batch="${esc(b.batch_id)}" title="Download the orphan keyword rows for this batch">📥 Download</button>
        </div>`).join('');
    body.innerHTML = jobBatchRows + orphanRows;
    body.querySelectorAll('button[data-download-batch]').forEach(btn => {
      btn.addEventListener('click', async () => {
        $('downloadBatchSelect').value = btn.dataset.downloadBatch;
        $('downloadCsvBtn').click();
      });
    });
  } catch (e) { sub.textContent = '⚠'; }
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

// ═══════════════════════════════════════════════════════════════
//  ANALYTICS TAB — per-SKU drill-down
// ═══════════════════════════════════════════════════════════════
const analytics = {
  batchId: '',
  sku: '',
  // Rows for the currently selected batch (fetched once, filtered client-side).
  allRows: [],
  // Rows for the currently selected SKU.
  skuRows: [],
  // Header column set (union across all rows) — used for CSV export.
  columnSet: new Set(),
  // Default to a computed opportunity score: rewards keywords with real KP
  // volume + high AdRating + image matches + not-too-crowded competition.
  // Users can click any column header to override.
  sortKey: 'opportunity_score',
  sortDir: 'desc',
  // Hide columns whose entire filtered set is null/0/empty. Cuts through
  // the "columns of nothing but em-dashes" visual noise. Toggleable.
  hideEmptyCols: true,
  // Which column groups (see KEYWORD_COL_DEFS) are visible. 'core' is
  // always on. Persisted to localStorage across reloads. Restored below.
  visibleGroups: new Set(['kp', 'image', 'sellers']),
};
// Restore group visibility from localStorage.
try {
  const saved = JSON.parse(localStorage.getItem('adbrainAnGroups') || 'null');
  if (Array.isArray(saved)) analytics.visibleGroups = new Set(saved);
} catch {}

// Full analytics-table column set — mirrors the CSV/XLSX export field list.
// Each entry lives in exactly one group; 'core' is always visible.
// Order here IS the on-screen order when multiple groups are enabled.
const KEYWORD_COL_DEFS = [
  // ─── Core (always on) ────────────────────────────────────────────
  { group: 'core', key: 'opportunity_score', label: 'Score',      kind: 'score', tip: 'Opportunity score — blends Volume, AdRating, image matches, Competition and buying-intent. Higher = better SEO/Ad target.' },
  { group: 'core', key: 'keyword',           label: 'Keyword',    kind: 'kw',    tip: 'Click to open the Google SERP for this keyword.' },
  { group: 'core', key: 'buying_intent',     label: 'Intent',     kind: 'chip' },
  { group: 'core', key: 'keyword_relevance', label: 'Relevance',  kind: 'chip',  tip: 'Semantic fit to the product (high / medium / low / sibling-brand).' },
  { group: 'core', key: 'ad_rating',         label: 'AdRating',   kind: 'rating',tip: 'Blended relevance signal across all sources.' },
  { group: 'core', key: 'source',            label: 'Source',     kind: 'chip' },
  // ─── KP metrics (Volume + Ads) ───────────────────────────────────
  { group: 'kp',   key: 'kp_monthly_searches', label: 'Volume',    kind: 'num',   tip: 'Google Keyword Planner monthly searches — real demand.' },
  { group: 'kp',   key: 'kp_competition',    label: 'Comp',       kind: 'comp',  tip: 'KP competition (Low/Medium/High).' },
  { group: 'kp',   key: 'kp_bid_low',        label: 'Bid low ₹',  kind: 'money', tip: 'KP low-end top-of-page bid.' },
  { group: 'kp',   key: 'kp_bid_high',       label: 'Bid high ₹', kind: 'money', tip: 'KP high-end top-of-page bid — useful for paid-ads budgeting.' },
  // ─── Image match ────────────────────────────────────────────────
  { group: 'image', key: 'image_count',           label: 'Imgs',     kind: 'imgs', tip: 'SERP images that matched our product visually (CLIP + dHash).' },
  { group: 'image', key: 'total_thumbs',          label: 'Thumbs',   kind: 'num',  tip: 'Total thumbnails captured on the SERP (denominator for Vis%).' },
  { group: 'image', key: 'visibility_pct',        label: 'Vis %',    kind: 'pct',  tip: 'image_count / total_thumbs — fraction of the SERP that is our product.' },
  { group: 'image', key: 'match_confidence_max', label: 'Match↑',   kind: 'num',  tip: 'Highest per-image match confidence on this keyword.' },
  { group: 'image', key: 'link_checked_count',   label: 'Chk',      kind: 'num',  tip: 'Matched destination pages we opened for re-verification.' },
  { group: 'image', key: 'link_verified_count',  label: 'Verified', kind: 'num',  tip: 'Matched destination pages that re-verified via CLIP.' },
  // ─── Sellers & SERP presence ────────────────────────────────────
  { group: 'sellers', key: 'total_sellers',   label: 'Sellers',    kind: 'num',   tip: 'Distinct sellers on this SERP.' },
  { group: 'sellers', key: 'ads_on_serp',     label: 'Ads',        kind: 'num',   tip: 'Paid ads count on this SERP.' },
  { group: 'sellers', key: 'dropy_is_seller', label: 'Us?',        kind: 'yesno', tip: 'Does dropy.in already list this product as a seller here?' },
  { group: 'sellers', key: 'dropy_on_serp',   label: 'On SERP',    kind: 'yesno', tip: 'Does dropy.in appear anywhere on this SERP (not necessarily as seller)?' },
  { group: 'sellers', key: 'top_match_seller',label: 'Top seller', kind: 'text',  tip: 'Seller domain behind the top-confidence image match.' },
  { group: 'sellers', key: 'top_match_price', label: 'Top price',  kind: 'text',  tip: 'Price on the top-match seller.' },
  { group: 'sellers', key: 'frequency',       label: 'Freq',       kind: 'num',   tip: 'How many discovery sources found this keyword — multi-source = stronger.' },
  // ─── Amazon (India Round 3) ─────────────────────────────────────
  { group: 'amazon', key: 'amazon_rank',           label: 'A.rank',   kind: 'num',   tip: 'Our position on the Amazon.in SERP for this keyword.' },
  { group: 'amazon', key: 'amazon_price',          label: 'A.price',  kind: 'text',  tip: 'Amazon.in observed price.' },
  { group: 'amazon', key: 'amazon_rating',         label: 'A.rating', kind: 'num',   tip: 'Amazon.in product rating (out of 5).' },
  { group: 'amazon', key: 'amazon_reviews',        label: 'A.reviews',kind: 'num',   tip: 'Amazon.in review count.' },
  { group: 'amazon', key: 'amazon_suggest_count',  label: 'A.suggest',kind: 'num',   tip: 'Amazon autosuggest occurrences for this seed.' },
  { group: 'amazon', key: 'amazon_total_results',  label: 'A.total',  kind: 'num',   tip: 'Amazon.in total results reported for this query.' },
  // ─── Meta / classification ──────────────────────────────────────
  { group: 'meta', key: 'topic',           label: 'Topic',   kind: 'text' },
  { group: 'meta', key: 'funnel',          label: 'Funnel',  kind: 'text' },
  { group: 'meta', key: 'faq',             label: 'FAQ?',    kind: 'yesno', tip: 'Marked as a question / FAQ-style query.' },
  { group: 'meta', key: 'parent_keyword',  label: 'Parent',  kind: 'text',  tip: 'The seed keyword that spawned this one (for autosuggest/related/PAA rows).' },
  // ─── Pinned actions (always on) ─────────────────────────────────
  { group: 'core', key: '__details',       label: '',        kind: 'details', tip: 'Open full details for this keyword.' },
];
// Human-facing labels + counts for the group toggle strip.
const KEYWORD_COL_GROUPS = [
  { key: 'core',    label: 'Core',              icon: '🎯', locked: true },
  { key: 'kp',      label: 'KP (volume + bids)', icon: '📊' },
  { key: 'image',   label: 'Image match',        icon: '📷' },
  { key: 'sellers', label: 'Sellers & SERP',     icon: '🛒' },
  { key: 'amazon',  label: 'Amazon.in',          icon: '📦' },
  { key: 'meta',    label: 'Meta',               icon: '🏷️' },
];

// Opportunity score — a single number that ranks a keyword by SEO/Ads value.
// Design goals:
//   - Reward real search demand (KP monthly searches) — this is what buyers
//     are actually typing. Log-scaled so a "70k vol" doesn't drown out a
//     more-relevant "3k vol" row.
//   - Reward relevance signal (AdRating already blends multi-source presence).
//   - Reward proven visual match (image_count > 0 means our product literally
//     appears on that keyword's SERP).
//   - Penalize brutal competition (KP High → -1.5).
//   - Bonus for high buying-intent — these are the money keywords.
// Weights tuned so the resulting number lives roughly in the 0..30 range,
// which reads better than a normalized 0..1 score.
function opportunityScore(r) {
  const volume = Math.max(0, Number(r.kp_monthly_searches) || 0);
  const rating = Math.max(0, Number(r.ad_rating) || 0);
  const imgs   = Math.max(0, Number(r.image_count) || 0);
  const comp   = String(r.kp_competition || '').toLowerCase();
  const intent = String(r.buying_intent   || '').toLowerCase();

  let s = 0;
  if (volume > 0) s += Math.log10(volume + 1) * 3;   // 100 → 6, 10k → 12
  s += rating * 0.6;                                  // AdRating 10 → 6
  s += Math.min(imgs, 5) * 0.8;                       // cap the image boost
  if (comp === 'low')    s += 1.0;
  if (comp === 'medium') s += 0.3;
  if (comp === 'high')   s -= 1.5;
  if (intent === 'high')     s += 1.5;
  else if (intent === 'medium') s += 0.5;
  return s;
}

async function refreshAnalyticsTab() {
  // Populate batch dropdown from current summary + orphan keyword batches.
  try {
    const [s, kwB, names] = await Promise.all([
      api.jobsSummary(),
      api.keywordsBatches().catch(() => ({ batches: [] })),
      api.batchNames().catch(() => ({ names: [] })),
    ]);
    state.batches = s.batches || [];
    state.keywordBatches = kwB.batches || [];
    state.batchNames = new Map((names.names || []).map(n => [n.batch_id, n]));
    populateBatchSelects();
    renderPickerBatchChips();
    if (analytics.batchId && $('anBatchSelect')) $('anBatchSelect').value = analytics.batchId;
    // Auto-select: if there's exactly one batch and none is chosen yet,
    // pick it. Removes the confusing "Waiting for input" empty state
    // when there's only one obvious batch to look at.
    if (!analytics.batchId && state.batches.length === 1) {
      analytics.batchId = state.batches[0].batch_id;
      if ($('anBatchSelect')) $('anBatchSelect').value = analytics.batchId;
    }
    renderBatchPreview();
  } catch {}
  if (analytics.batchId) await loadAnalyticsBatch(analytics.batchId);
}

// ─────────── Picker: batch chips (quick-jump to top-N recent batches) ───
function renderPickerBatchChips() {
  const el = $('anBatchChips');
  if (!el) return;
  // Batches WITH jobs, sorted by most recent (assumes batch_id contains
  // an epoch-ms timestamp; sorting the string suffix desc is close enough).
  const withJobs = [...state.batches].sort((a, b) => String(b.batch_id).localeCompare(String(a.batch_id))).slice(0, 6);
  el.innerHTML = withJobs.map(b => {
    const active = b.batch_id === analytics.batchId ? 'active' : '';
    const label = batchLabel(b.batch_id).split('  (')[0];  // strip the "(id-tail)" suffix
    return `<button class="quick-batch ${active}" data-batch="${esc(b.batch_id)}" title="${esc(b.batch_id)} — ${b.total} SKUs">${esc(label)} · ${b.total}</button>`;
  }).join('');
  el.querySelectorAll('button[data-batch]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.batch;
    analytics.batchId = id;
    analytics.sku = '';
    $('anBatchSelect').value = id;
    renderPickerBatchChips();
    renderBatchPreview();
    await loadAnalyticsBatch(id);
  }));
  updatePickerHints();
}

function updatePickerHints() {
  const bh = $('anBatchHint');
  if (bh) {
    const n = state.batches.length + (state.keywordBatches || []).filter(b => !state.batches.find(j => j.batch_id === b.batch_id)).length;
    bh.textContent = n === 0 ? 'no batches yet' : `${n} batch${n === 1 ? '' : 'es'} available`;
  }
}

function renderBatchPreview() {
  const el = $('anBatchPreview');
  if (!el) return;
  const id = analytics.batchId;
  if (!id) { el.innerHTML = `<span style="color:var(--text-3);">Pick a batch to see coverage stats here.</span>`; return; }
  const jobsBatch = state.batches.find(b => b.batch_id === id);
  const kwBatch   = (state.keywordBatches || []).find(b => b.batch_id === id);
  const name      = state.batchNames.get(id)?.display_name;
  const parts = [];
  if (name) parts.push(`<span class="stat">📛 <b>${esc(name)}</b></span>`);
  parts.push(`<span class="stat" title="${esc(id)}"><code style="font-size:10px;">${esc(id.slice(-10))}</code></span>`);
  if (jobsBatch) {
    parts.push(`<span class="stat">SKUs: <b>${jobsBatch.total}</b></span>`);
    if (jobsBatch.done != null)    parts.push(`<span class="stat" style="color:var(--success);">done: <b>${jobsBatch.done}</b></span>`);
    if (jobsBatch.claimed != null) parts.push(`<span class="stat" style="color:var(--accent);">in-flight: <b>${jobsBatch.claimed}</b></span>`);
    if (jobsBatch.pending != null) parts.push(`<span class="stat">pending: <b>${jobsBatch.pending}</b></span>`);
    if (jobsBatch.failed  != null && jobsBatch.failed > 0)  parts.push(`<span class="stat" style="color:var(--danger);">failed: <b>${jobsBatch.failed}</b></span>`);
  }
  if (kwBatch) parts.push(`<span class="stat">keywords: <b>${(kwBatch.row_count || 0).toLocaleString()}</b></span>`);
  el.innerHTML = `<div class="row-mini">${parts.join('')}</div>`;
}

function renderSkuPreview() {
  const el = $('anSkuPreview');
  if (!el) return;
  if (!analytics.sku) { el.innerHTML = `<span style="color:var(--text-3);">Pick a SKU (or leave blank for all-batch view).</span>`; return; }
  const rows = analytics.allRows.filter(r => (r.sku || r.product_url) === analytics.sku);
  if (rows.length === 0) { el.innerHTML = `<span style="color:var(--text-3);">No rows for this SKU yet.</span>`; return; }
  const ctx = rows.find(r => r.product_name) || rows[0];
  const scored = rows.map(r => ({ ...r, __s: opportunityScore(r) }));
  const topScore = Math.max(...scored.map(r => r.__s || 0), 0);
  const highIntent = rows.filter(r => String(r.buying_intent || '').toLowerCase() === 'high').length;
  const withImg = rows.filter(r => (toNum(r.image_count) || 0) > 0).length;
  const withVol = rows.filter(r => (toNum(r.kp_monthly_searches) || 0) > 0).length;
  const target = rows.length < 100 ? '<span style="color:var(--warn);">⚠ below 100</span>'
               : rows.length > 300 ? '<span style="color:var(--info);">above 300</span>'
               : '<span style="color:var(--success);">✓ in 100–300</span>';
  const productUrl = ctx.product_url || '';
  const productLink = productUrl
    ? `&nbsp;·&nbsp;<a href="${esc(productUrl)}" target="_blank" rel="noopener" style="color:var(--accent);">📦 open product</a>`
    : '';

  // Composite data-quality badge. Scores each dimension 0-2, gives an
  // overall grade so users know at-a-glance whether to trust the analytics
  // or fix data first (missing KP is the biggest degrader).
  let dq = 0;
  const volPct = Math.round((withVol / rows.length) * 100);
  const imgPct = Math.round((withImg / rows.length) * 100);
  const highPct = Math.round((highIntent / rows.length) * 100);
  if (rows.length >= 100)  dq += 2; else if (rows.length >= 50) dq += 1;
  if (volPct   >= 50) dq += 2; else if (volPct   >= 20) dq += 1;
  if (imgPct   >= 30) dq += 2; else if (imgPct   >= 10) dq += 1;
  if (highPct  >= 20) dq += 2; else if (highPct  >= 10) dq += 1;
  // dq is out of 8. Grade A/B/C/D.
  const grade = dq >= 7 ? { l: 'A', c: 'var(--success)', t: 'Trustworthy — full signal set' }
              : dq >= 5 ? { l: 'B', c: 'var(--accent)',  t: 'Solid — most signals present' }
              : dq >= 3 ? { l: 'C', c: 'var(--warn)',    t: 'Partial — some signals missing' }
              :           { l: 'D', c: 'var(--danger)',  t: 'Thin — analytics may mislead; enable KP backfill / broaden discovery' };
  const badge = `<span class="dq-badge" style="background:${grade.c}20; color:${grade.c}; border-color:${grade.c};" title="Data quality: ${esc(grade.t)}">DQ&nbsp;${grade.l}</span>`;

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom: 4px;">
      <div style="color:var(--text-1); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(ctx.product_name || '')}">${esc(ctx.product_name || analytics.sku)}</div>
      ${badge}
    </div>
    <div class="row-mini">
      <span class="stat">keywords: <b>${rows.length}</b> ${target}</span>
      <span class="stat">high-intent: <b style="color:var(--success);">${highIntent}</b></span>
      <span class="stat">img-match: <b>${withImg}</b></span>
      <span class="stat">KP vol: <b>${withVol}</b></span>
      <span class="stat">top score: <b style="color:var(--accent);">${topScore.toFixed(1)}</b></span>
      ${productLink}
    </div>`;
}

// Search-as-you-type filters both dropdowns without shuffling the DOM tree
// (browsers keep the selected option even when others are hidden).
function wirePickerSearch() {
  const bs = $('anBatchSearch');
  const ss = $('anSkuSearch');
  const filter = (input, select) => {
    if (!input || !select) return;
    const q = (input.value || '').toLowerCase().trim();
    let firstVisible = null;
    Array.from(select.options).forEach(opt => {
      const match = !q || opt.textContent.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q);
      opt.hidden = !match;
      if (match && !firstVisible) firstVisible = opt;
    });
    // When user types "aq" and the current selection is hidden, jump to
    // the first visible one so the preview reflects what they're searching.
    if (firstVisible && select.selectedOptions[0]?.hidden) {
      select.value = firstVisible.value;
      select.dispatchEvent(new Event('change'));
    }
  };
  bs?.addEventListener('input', () => filter(bs, $('anBatchSelect')));
  ss?.addEventListener('input', () => filter(ss, $('anSkuSelect')));
  // Global "/" hotkey focuses the batch search (skip when typing elsewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (!$('panel-analytics')?.classList.contains('active')) return;
    e.preventDefault();
    bs?.focus();
    bs?.select();
  });
}
wirePickerSearch();
$('anBatchSelect').addEventListener('change', async () => {
  analytics.batchId = $('anBatchSelect').value;
  analytics.sku = '';
  renderPickerBatchChips();
  renderBatchPreview();
  await loadAnalyticsBatch(analytics.batchId);
});
$('anSkuSelect').addEventListener('change', () => {
  analytics.sku = $('anSkuSelect').value;
  renderSkuPreview();
  filterAndRenderAnalytics();
});
['anSearch', 'anSource', 'anIntent', 'anMinRating', 'anOnlyImgMatches'].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(id === 'anSearch' ? 'input' : 'change', filterAndRenderAnalytics);
});
// ─────────── Claude listing-brief prompt builder ───────────
// Bundles everything the model needs to write a full Shopify listing +
// Amazon bullets + Google ad copy from the SKU's real research data.
function buildClaudeListingPrompt(skuRows) {
  if (!skuRows || skuRows.length === 0) return '';
  // Deterministic product context — take the first row that has it.
  const ctx = skuRows.find(r => r.product_name) || skuRows[0];
  const productName = ctx.product_name || ctx.sku || '(unknown)';
  const productUrl  = ctx.product_url || '';
  const productImg  = ctx.product_image || '';
  const sku         = ctx.sku || '';
  const batchId     = ctx.batch_id || '';

  // Score & rank keywords using the same opportunity_score users see in the table.
  const scored = skuRows.map(r => ({ ...r, __s: opportunityScore(r) }));
  scored.sort((a, b) => b.__s - a.__s);
  const topN = scored.slice(0, 25);

  // Buying-intent buckets — feeds the "which keywords to prioritize" note.
  const byIntent = {};
  for (const r of scored) {
    const k = String(r.buying_intent || 'unclassified').toLowerCase();
    byIntent[k] = (byIntent[k] || 0) + 1;
  }

  // Source mix — helps Claude reason about signal quality (KP-heavy vs
  // autosuggest-heavy changes the reliability of demand estimates).
  const bySource = {};
  for (const r of scored) {
    const primary = String(r.source || '—').split(',')[0].trim().toUpperCase();
    bySource[primary] = (bySource[primary] || 0) + 1;
  }

  // Competitor domains from sellers_on_serp — bare domain counts, ranked.
  const compCount = new Map();
  for (const r of scored) {
    const line = String(r.sellers_on_serp || '');
    if (!line) continue;
    for (const part of line.split('|')) {
      const m = part.trim().match(/^([a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) compCount.set(m[1].toLowerCase(), (compCount.get(m[1].toLowerCase()) || 0) + 1);
    }
  }
  const topCompetitors = Array.from(compCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Volume/price stats where available.
  const vols   = scored.map(r => toNum(r.kp_monthly_searches)).filter(v => v && v > 0);
  const bidHi  = scored.map(r => toNum(r.kp_bid_high)).filter(v => v && v > 0);
  const amazonPrices = scored
    .map(r => String(r.amazon_price || '').match(/([0-9]+(\.[0-9]+)?)/)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter(n => n > 0);
  const stat = arr => arr.length ? {
    min: Math.min(...arr).toFixed(0),
    max: Math.max(...arr).toFixed(0),
    med: arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)].toFixed(0),
    n: arr.length,
  } : null;
  const volStat   = stat(vols);
  const bidStat   = stat(bidHi);
  const priceStat = stat(amazonPrices);

  // FAQ candidates — question-shaped keywords or ones flagged as PAA/faq.
  const faqCandidates = scored.filter(r => {
    const kw = String(r.keyword || '').toLowerCase();
    return String(r.faq || '').toLowerCase() === 'yes'
      || /^(what|how|why|when|where|is|are|does|do|can|should|which)\b/.test(kw)
      || /\?$/.test(kw);
  }).slice(0, 15);

  // Format helpers.
  const kwLine = r => {
    const parts = [];
    parts.push(`"${r.keyword}"`);
    parts.push(`score=${r.__s.toFixed(1)}`);
    const vol = toNum(r.kp_monthly_searches);
    if (vol && vol > 0) parts.push(`vol=${vol.toLocaleString()}`);
    if (r.kp_competition) parts.push(`comp=${r.kp_competition}`);
    if (r.buying_intent)  parts.push(`intent=${r.buying_intent}`);
    if ((r.image_count || 0) > 0) parts.push(`imgs=${r.image_count}`);
    return parts.join(' | ');
  };

  const lines = [];
  lines.push('You are an expert e-commerce content strategist writing a Shopify product listing for Dropy.in (India, ₹).');
  lines.push('');
  lines.push('# PRODUCT');
  lines.push(`Name:        ${productName}`);
  if (sku)        lines.push(`SKU:         ${sku}`);
  if (productUrl) lines.push(`URL:         ${productUrl}`);
  if (productImg) lines.push(`Image:       ${productImg}`);
  if (batchId)    lines.push(`Research batch: ${batchId}`);
  lines.push('');
  lines.push('# RESEARCH SUMMARY');
  lines.push(`- ${scored.length} keywords collected across sources: ${Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  lines.push(`- Buying-intent mix: ${Object.entries(byIntent).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  if (volStat)   lines.push(`- KP monthly searches (n=${volStat.n}): min ${volStat.min}, median ${volStat.med}, max ${volStat.max}`);
  else           lines.push('- KP monthly-search data: not available for this SKU (rely on relative Score + Image-match signal for demand ranking)');
  if (bidStat)   lines.push(`- KP top-of-page bid ₹ (n=${bidStat.n}): min ${bidStat.min}, median ${bidStat.med}, max ${bidStat.max}  ← use for ads budgeting`);
  if (priceStat) lines.push(`- Amazon.in observed prices ₹ (n=${priceStat.n}): min ${priceStat.min}, median ${priceStat.med}, max ${priceStat.max}  ← competitive price benchmark`);
  if (topCompetitors.length) lines.push(`- Top competitor domains on SERPs: ${topCompetitors.map(([d, n]) => `${d}(${n})`).join(', ')}`);
  lines.push('');
  lines.push(`# TOP ${topN.length} OPPORTUNITY KEYWORDS (highest opportunity score first)`);
  topN.forEach((r, i) => lines.push(`${String(i + 1).padStart(2, ' ')}. ${kwLine(r)}`));
  lines.push('');
  if (faqCandidates.length) {
    lines.push('# QUESTION-SHAPED QUERIES (raw material for FAQ section)');
    faqCandidates.forEach(r => lines.push(`- ${r.keyword}`));
    lines.push('');
  }
  lines.push('# DELIVERABLES');
  lines.push('Produce a COMPLETE product-listing package in this exact order:');
  lines.push('');
  lines.push('1. **TITLE** — Shopify/Google-optimized, ≤70 characters. Include the primary keyword, brand, and category. No ALL CAPS.');
  lines.push('2. **SUB-TITLE / SHORT DESCRIPTION** — ≤160 characters. One-line hook that combines the biggest pain-point + core benefit. Suitable for meta description.');
  lines.push('3. **LONG DESCRIPTION** — 300–500 words. Structure: problem → solution → 4-6 benefit bullets → how it feels/looks/smells → who it\'s for → trust-cue closer. Use high-buying-intent keywords naturally (do not stuff).');
  lines.push('4. **INGREDIENTS** — Bulleted list. For each hero ingredient, add a one-sentence "why it matters" note. Group actives vs supporting cast. If ingredients are unknown from the research data, mark them as "confirm on packaging" instead of inventing.');
  lines.push('5. **HOW TO USE** — Numbered steps, morning/night if applicable. Include quantity, frequency, and one "pro tip".');
  lines.push('6. **FAQs** — 8–12 Q&A pairs. Draw from the question-shaped queries above where possible; each answer 2–3 sentences.');
  lines.push('7. **SEO KEYWORDS** — Comma-separated meta-keywords list. Longtail-first, India-first. Include the top 15 opportunity keywords verbatim.');
  lines.push('8. **GOOGLE SEARCH AD** — 3 headline variants (≤30 chars each) + 2 description variants (≤90 chars each). Reflect high-intent phrases.');
  lines.push('9. **AMAZON BULLETS** — 5 benefit-first bullets, keyword-rich, ≤200 chars each. Lead with the pay-off.');
  lines.push('10. **META TITLE + META DESCRIPTION** — for the Shopify page. Title ≤60 chars, description ≤155 chars.');
  lines.push('11. **HANDLE / URL SLUG** — Lowercase, kebab-case, ≤50 chars.');
  lines.push('');
  lines.push('# CONSTRAINTS');
  lines.push('- India-first tone. Currency ₹. Reference "delivered pan-India" style cues where natural.');
  lines.push('- Do NOT invent certifications, dermatologist claims, or "clinically proven" language unless the source data mentions them.');
  lines.push('- Do NOT copy competitor domains listed above into the copy — use them only for tonal reference.');
  lines.push('- Prefer high-buying-intent keywords in TITLE and Google Ad headlines. Reserve low-intent/informational keywords for the LONG DESCRIPTION and FAQs.');
  lines.push('- Return each section under a clear markdown `##` heading in the same order as the list above.');
  return lines.join('\n');
}
function openClaudePromptModal() {
  const rows = analytics.sku
    ? analytics.allRows.filter(r => (r.sku || r.product_url) === analytics.sku)
    : analytics.allRows;
  if (rows.length === 0) { toast('No keywords for this SKU yet.', 'warn'); return; }
  const text = buildClaudeListingPrompt(rows);
  $('claudePromptText').value = text;
  $('claudeModalSub').textContent = `${rows.length} keyword(s) · ${(text.length / 1024).toFixed(1)} KB prompt`;
  $('claudePromptStats').textContent = `${text.length.toLocaleString()} chars · ${Math.ceil(text.split(/\s+/).length)} words`;
  $('claudeModal').style.display = 'flex';
}
$('anClaudeBtn')?.addEventListener('click', openClaudePromptModal);
// Copy top-N keywords (scored, deduped, one per line). N = 25 by default —
// enough to seed an ad group or meta-keywords block without dumping the
// whole 480-row pool.
$('anCopyKwBtn')?.addEventListener('click', async () => {
  const rows = analytics.sku
    ? analytics.allRows.filter(r => (r.sku || r.product_url) === analytics.sku)
    : analytics.allRows;
  if (rows.length === 0) { toast('No keywords to copy.', 'warn'); return; }
  const N = 25;
  const scored = rows.map(r => ({ kw: r.keyword, s: opportunityScore(r) }))
    .filter(r => r.kw)
    .sort((a, b) => b.s - a.s)
    .slice(0, N);
  const text = scored.map(r => r.kw).join('\n');
  try { await navigator.clipboard.writeText(text); toast(`${scored.length} top keyword(s) copied.`, 'ok', { title: 'Copied' }); }
  catch { toast('Copy failed.', 'err'); }
});
$('claudeCopyBtn')?.addEventListener('click', async () => {
  const t = $('claudePromptText').value;
  try { await navigator.clipboard.writeText(t); toast('Prompt copied — paste into Claude.', 'ok', { title: 'Copied' }); }
  catch { $('claudePromptText').select(); toast('Copy failed — text is selected, press Ctrl+C.', 'warn'); }
});
$('claudeDownloadBtn')?.addEventListener('click', () => {
  const t = $('claudePromptText').value;
  const blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const skuSafe = String(analytics.sku || 'sku').replace(/[^\w.-]+/g, '_').slice(0, 60);
  a.download = `claude_brief_${skuSafe}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
});
$('claudeOpenBtn')?.addEventListener('click', async () => {
  const t = $('claudePromptText').value;
  try { await navigator.clipboard.writeText(t); } catch {}
  toast('Opening Claude — paste the prompt into the chat box.', 'info', { title: 'Prompt copied' });
  window.open('https://claude.ai/new', '_blank', 'noopener');
});

$('anExportBtn').addEventListener('click', () => {
  if (!analytics.skuRows.length) return;
  const csv = rowsToCsv(analytics.skuRows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = String(analytics.sku || 'sku').replace(/[^\w.-]+/g, '_').slice(0, 60);
  a.download = `adbrain_${safe}_${analytics.batchId}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
});

async function loadAnalyticsBatch(batchId) {
  const summary = $('anSummary');
  if (!batchId) {
    analytics.allRows = []; analytics.skuRows = [];
    summary.innerHTML = `<div class="empty"><div class="empty-icon">📈</div>Pick a batch + SKU to see analytics.</div>`;
    $('anSkuSelect').innerHTML = `<option value="">— pick a batch first —</option>`;
    $('anTopChartCard').style.display = 'none';
    $('anTableCard').style.display = 'none';
    $('anExportBtn').disabled = true;
    return;
  }
  summary.innerHTML = `<div class="empty">Loading batch data…</div>`;
  try {
    const r = await api.keywordsGet(batchId);
    analytics.allRows = r.rows || [];
    // Column set for the CSV export — union of keys across all rows.
    analytics.columnSet = new Set();
    for (const row of analytics.allRows) for (const k of Object.keys(row)) analytics.columnSet.add(k);
    // Group by SKU (fall back to product_url if SKU missing).
    const bySku = new Map();
    for (const row of analytics.allRows) {
      const key = row.sku || row.product_url || 'unknown';
      if (!bySku.has(key)) bySku.set(key, { key, productName: row.product_name || '', rows: [] });
      bySku.get(key).rows.push(row);
    }
    const skuList = Array.from(bySku.values()).sort((a, b) => b.rows.length - a.rows.length);
    $('anSkuSelect').innerHTML = `<option value="">— all SKUs in batch —</option>` + skuList.map(g =>
      `<option value="${esc(g.key)}">${esc(g.key)} — ${g.rows.length} kw${g.productName ? ` · ${esc(g.productName)}` : ''}</option>`
    ).join('');
    // If we previously had a SKU selected and it still exists, keep it.
    if (analytics.sku && bySku.has(analytics.sku)) $('anSkuSelect').value = analytics.sku;
    else {
      // Auto-pick the most-productive SKU (top of skuList, already sorted
      // desc by row count) so users see analytics immediately instead of
      // a placeholder telling them to pick a SKU.
      analytics.sku = skuList[0]?.key || '';
      if ($('anSkuSelect')) $('anSkuSelect').value = analytics.sku;
    }
    // Enable SKU search + update the SKU hint now that data has loaded.
    const ss = $('anSkuSearch'); if (ss) ss.disabled = false;
    const sh = $('anSkuHint'); if (sh) sh.textContent = `${skuList.length} SKU(s) in this batch`;
    renderSkuPreview();
  } catch (e) {
    summary.innerHTML = `<div class="banner err">Failed to load: ${esc(e.message)}</div>`;
    return;
  }
  filterAndRenderAnalytics();
}

function filterAndRenderAnalytics() {
  // Pick working set: selected SKU or all-in-batch.
  const source = analytics.sku
    ? analytics.allRows.filter(r => (r.sku || r.product_url) === analytics.sku)
    : analytics.allRows;

  // Apply filters.
  const q = ($('anSearch').value || '').trim().toLowerCase();
  const src = $('anSource').value;
  const intent = $('anIntent').value;
  const minRating = parseInt($('anMinRating').value, 10) || 0;
  const onlyImg = $('anOnlyImgMatches').checked;
  const filtered = source.filter(r => {
    if (q && !String(r.keyword || '').toLowerCase().includes(q)) return false;
    if (src && String(r.source || '').toLowerCase() !== src.toLowerCase()) return false;
    if (intent && String(r.buying_intent || '').toLowerCase() !== intent.toLowerCase()) return false;
    if ((r.ad_rating || 0) < minRating) return false;
    if (onlyImg && !((r.image_count || 0) > 0)) return false;
    return true;
  });

  // Attach the computed opportunity score once, so both sort + table share it.
  for (const r of filtered) r.opportunity_score = opportunityScore(r);

  // Sort — always by current key. opportunity_score is the default; users
  // can click any column header to switch.
  const dirMul = analytics.sortDir === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    const av = a[analytics.sortKey], bv = b[analytics.sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dirMul;
    return String(av).localeCompare(String(bv)) * dirMul;
  });

  analytics.skuRows = filtered;
  renderExecutiveSummary(source, filtered);
  renderAnalyticsSummary(source);
  renderAnalyticsInsights(source, filtered);
  renderScatter(source);
  renderSourceDonut(source);
  renderCoverageGauge(source);
  renderThemesCard(source);
  renderContentGaps(source);
  renderAnalyticsTopChart(filtered);
  renderAnalyticsTable(filtered);

  const show = source.length > 0 ? '' : 'none';
  ['anLayerExec', 'anLayerPrioritize', 'anLayerDistribute', 'anLayerContent', 'anLayerDeepDive',
   'anTableCard', 'anTopChartCard'].forEach(id => {
    const el = $(id); if (el) el.style.display = show;
  });
  $('anExportBtn').disabled = filtered.length === 0;
  const claudeBtn = $('anClaudeBtn');
  if (claudeBtn) claudeBtn.disabled = source.length === 0;
  const copyKwBtn = $('anCopyKwBtn');
  if (copyKwBtn) copyKwBtn.disabled = source.length === 0;
}

// ─────────── Score × demand scatter plot ───────────
// The canonical keyword-prioritization visual. X-axis is demand (KP volume
// preferred, AdRating as fallback when no volume data), Y-axis is our
// opportunity score, dot color = buying intent, dot size = image match
// count. Median lines split the plane into quadrants — top-right is the
// "quick wins" area (high demand + our best fit).
function renderScatter(rows) {
  const el = $('anScatter');
  const title = $('anScatterTitle');
  const sub = $('anScatterSub');
  if (!el) return;
  if (!rows || rows.length === 0) { el.innerHTML = ''; if (sub) sub.textContent = '—'; return; }

  const scored = rows.map(r => ({
    kw: r.keyword,
    score: opportunityScore(r),
    vol: toNum(r.kp_monthly_searches) || 0,
    rating: toNum(r.ad_rating) || 0,
    intent: String(r.buying_intent || '').toLowerCase(),
    imgs: toNum(r.image_count) || 0,
    href: r.serp_url || `https://www.google.com/search?q=${encodeURIComponent(r.keyword)}&gl=in`,
  })).filter(r => r.score > 0);

  if (scored.length === 0) { el.innerHTML = `<div class="hint">No scored keywords yet.</div>`; if (sub) sub.textContent = '—'; return; }

  // Prefer real KP volume if we have coverage; otherwise fall back to
  // AdRating so the chart is still useful when KP data is missing.
  const hasVol = scored.filter(r => r.vol > 0).length >= Math.min(5, scored.length * 0.1);
  const xVal = (r) => hasVol ? r.vol : r.rating;
  const xLabel = hasVol ? 'KP monthly searches (log scale)' : 'AdRating (KP volume unavailable — fallback)';
  if (title) title.textContent = hasVol ? 'Score × Volume — quick-wins quadrant' : 'Score × Relevance — quick-wins quadrant';
  if (sub) sub.textContent = hasVol ? `${scored.length} scored keyword(s) · ${scored.filter(r => r.vol > 0).length} with KP volume` : `${scored.length} scored · KP volume missing, using AdRating for X-axis`;

  // Log-scale for volume so a 3-keyword outlier at 500k doesn't crush the
  // interesting mid-band. Linear for AdRating fallback.
  const xScale = hasVol ? (v) => v > 0 ? Math.log10(v + 1) : 0 : (v) => v;
  const xs = scored.map(r => xScale(xVal(r)));
  const ys = scored.map(r => r.score);
  const xMin = 0, xMax = Math.max(...xs, 1);
  const yMin = 0, yMax = Math.max(...ys, 1);
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const xMed = median(xs);
  const yMed = median(ys);

  const W = 600, H = 300, pad = { l: 40, r: 20, t: 24, b: 30 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const sx = (x) => pad.l + (x / xMax) * plotW;
  const sy = (y) => H - pad.b - (y / yMax) * plotH;

  const intentColor = { high: '#22c55e', medium: '#f59e0b', low: '#64748b', informational: '#8b5cf6' };
  const colorFor = (r) => intentColor[r.intent] || '#3b82f6';
  const radiusFor = (r) => 3 + Math.min(6, Math.log2((r.imgs || 0) + 1) * 1.5);

  // Grid lines every 25% of Y-axis, subtle.
  const grid = [0.25, 0.5, 0.75].map(f => {
    const y = pad.t + f * plotH;
    return `<line class="grid-line" x1="${pad.l}" y1="${y}" x2="${pad.l + plotW}" y2="${y}"/>`;
  }).join('');

  // Points — click opens the SERP for that keyword.
  const points = scored.map(r => {
    const cx = sx(xScale(xVal(r)));
    const cy = sy(r.score);
    const rr = radiusFor(r);
    const c = colorFor(r);
    const title = `${r.kw}\nScore ${r.score.toFixed(1)}${r.vol ? ` · vol ${r.vol.toLocaleString()}` : ''}${r.imgs ? ` · ${r.imgs} imgs` : ''}${r.intent ? ` · ${r.intent} intent` : ''}`;
    return `<a xlink:href="${esc(r.href)}" target="_blank"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}" fill="${c}" fill-opacity="0.65" stroke="${c}" stroke-width="1"><title>${esc(title)}</title></circle></a>`;
  }).join('');

  // Quadrant lines + labels — median splits.
  const quadX = sx(xMed);
  const quadY = sy(yMed);
  const quadLines = `
    <line class="quad-line" x1="${quadX}" y1="${pad.t}" x2="${quadX}" y2="${H - pad.b}"/>
    <line class="quad-line" x1="${pad.l}" y1="${quadY}" x2="${pad.l + plotW}" y2="${quadY}"/>`;
  const quadLabels = `
    <text class="quick-wins-badge" x="${pad.l + plotW - 6}" y="${pad.t + 12}" text-anchor="end">★ QUICK WINS</text>
    <text class="quad-label" x="${pad.l + 6}" y="${pad.t + 12}">Low demand · High score</text>
    <text class="quad-label" x="${pad.l + plotW - 6}" y="${H - pad.b - 6}" text-anchor="end">High demand · Low score</text>
    <text class="quad-label" x="${pad.l + 6}" y="${H - pad.b - 6}">Low demand · Low score</text>`;
  const axisLabels = `
    <text class="axis-label" x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end">${yMax.toFixed(0)}</text>
    <text class="axis-label" x="${pad.l - 6}" y="${H - pad.b}" text-anchor="end">0</text>
    <text class="axis-label" x="${pad.l - 6}" y="${(pad.t + H - pad.b) / 2}" text-anchor="end" transform="rotate(-90 ${pad.l - 20} ${(pad.t + H - pad.b) / 2})">SCORE</text>
    <text class="axis-label" x="${pad.l + plotW / 2}" y="${H - 8}" text-anchor="middle">${esc(xLabel)}</text>`;

  el.innerHTML = `
    <div class="scatter">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${grid}
        ${quadLines}
        ${points}
        ${quadLabels}
        ${axisLabels}
      </svg>
    </div>
    <div class="scatter-legend">
      <span><strong>Intent:</strong></span>
      <span><span class="dot" style="background:${intentColor.high};"></span>high</span>
      <span><span class="dot" style="background:${intentColor.medium};"></span>medium</span>
      <span><span class="dot" style="background:${intentColor.low};"></span>low</span>
      <span><span class="dot" style="background:${intentColor.informational};"></span>informational</span>
      <span style="margin-left: 12px;"><strong>Dot size:</strong> image-match count · <strong>Click any point</strong> to open its SERP.</span>
    </div>`;
}

// ─────────── Source distribution donut chart ───────────
// Replaces the noisy chip row with a compact SVG donut + legend. Aggregates
// by PRIMARY source (first token before comma) so a keyword found via
// multiple channels doesn't get double-counted.
function renderSourceDonut(rows) {
  const el = $('anDonut');
  const sub = $('anDonutSub');
  if (!el) return;
  if (!rows || rows.length === 0) { el.innerHTML = ''; if (sub) sub.textContent = '—'; return; }

  const bySrc = {};
  for (const r of rows) {
    const k = String(r.source || '—').split(',')[0].trim().toUpperCase() || '—';
    bySrc[k] = (bySrc[k] || 0) + 1;
  }
  const total = rows.length;
  const entries = Object.entries(bySrc).sort((a, b) => b[1] - a[1]);
  // Color palette aligned with source-chip classes for visual consistency.
  const colorFor = (k) => {
    const s = String(k).toLowerCase();
    if (s.startsWith('kp')) return '#3b82f6';
    if (s.startsWith('autosuggest')) return '#f59e0b';
    if (s.startsWith('serp')) return '#06b6d4';
    if (s.startsWith('paa')) return '#8b5cf6';
    if (s.startsWith('related')) return '#ec4899';
    if (s.startsWith('amazon')) return '#f97316';
    return '#64748b';
  };

  const cx = 70, cy = 70, rOuter = 60, rInner = 40;
  let angle = -Math.PI / 2;   // start at top
  const arcs = entries.map(([k, v]) => {
    const frac = v / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + rOuter * Math.cos(a0);
    const y0 = cy + rOuter * Math.sin(a0);
    const x1 = cx + rOuter * Math.cos(a1);
    const y1 = cy + rOuter * Math.sin(a1);
    const x0i = cx + rInner * Math.cos(a1);
    const y0i = cy + rInner * Math.sin(a1);
    const x1i = cx + rInner * Math.cos(a0);
    const y1i = cy + rInner * Math.sin(a0);
    const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)}
               A ${rOuter} ${rOuter} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}
               L ${x0i.toFixed(2)} ${y0i.toFixed(2)}
               A ${rInner} ${rInner} 0 ${large} 0 ${x1i.toFixed(2)} ${y1i.toFixed(2)}
               Z`;
    return `<path d="${d}" fill="${colorFor(k)}"><title>${esc(k)}: ${v} (${Math.round(frac * 100)}%)</title></path>`;
  }).join('');

  const legend = entries.map(([k, v]) => {
    const pct = Math.round((v / total) * 100);
    return `<div class="lg-row">
      <span class="lg-swatch" style="background:${colorFor(k)};"></span>
      <span class="lg-name">${esc(k)}</span>
      <span class="lg-count">${v} · ${pct}%</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="donut" style="position:relative;">
      <div style="position:relative;">
        <svg viewBox="0 0 140 140">${arcs}</svg>
        <div class="donut-center">
          <div class="big">${entries.length}</div>
          <div class="lbl">sources</div>
        </div>
      </div>
      <div class="donut-legend">${legend}</div>
    </div>`;
  if (sub) sub.textContent = `${entries.length} distinct source(s) · ${total.toLocaleString()} keyword(s)`;
}

// ─────────── Coverage gauge (100-300 target) ───────────
function renderCoverageGauge(rows) {
  const el = $('anGauge');
  const sub = $('anGaugeSub');
  if (!el) return;
  if (!rows || rows.length === 0) { el.innerHTML = ''; if (sub) sub.textContent = '—'; return; }
  const n = rows.length;
  // Track spans 0 → 500 (anything above 500 stays pinned to 100%).
  const scaleMax = 500;
  const pct = Math.min(100, (n / scaleMax) * 100);
  const verdict = n < 100
    ? { text: `⚠ Below target (${n} of 100 minimum). Broaden autosuggest depth or add more KP seeds.`, tone: 'warn' }
    : n <= 300
    ? { text: `✓ In target range (${n} keywords) — this SKU has healthy coverage.`, tone: 'success' }
    : { text: `Above 300 (${n}). Consider tightening filters — you may be spending effort on low-relevance long tail.`, tone: 'info' };
  const toneClass = { warn: 'warn', success: 'ok', info: 'info' }[verdict.tone];
  el.innerHTML = `
    <div class="gauge">
      <div class="gauge-track">
        <div class="gauge-marker" style="left: ${pct.toFixed(1)}%;" data-val="${n}"></div>
      </div>
      <div class="gauge-labels">
        <span>0</span><span style="color:var(--warn);">100</span><span style="color:var(--success);">300</span><span>${scaleMax}+</span>
      </div>
      <div class="gauge-verdict banner ${toneClass}" style="margin-top: 14px;">${verdict.text}</div>
    </div>`;
  if (sub) sub.textContent = `${n.toLocaleString()} keyword(s) collected`;
}

// ─────────── Keyword theme clustering ───────────
// Each theme carries a match predicate + display metadata. Order matters —
// first-match wins so more-specific themes ("questions") beat generic ones
// ("informational") when a keyword fits both.
const KW_THEMES = [
  { key: 'questions',     icon: '❓', label: 'Questions',            color: '#f59e0b',
    test: (kw) => /^(what|how|why|when|where|is|are|does|do|can|should|which|will|has|have)\b/.test(kw) || /\?$/.test(kw) },
  { key: 'price',         icon: '💰', label: 'Price / cost / deals', color: '#22c55e',
    test: (kw) => /\b(price|cost|cheap|deal|offer|discount|buy|sale|₹|rs\.?|inr|amazon|flipkart|nykaa|myntra)\b/.test(kw) },
  { key: 'ingredients',   icon: '🧪', label: 'Ingredients / composition', color: '#8b5cf6',
    test: (kw) => /\b(ingredient|ingredients|composition|contains|made of|formula|active|toxic|safe|natural|organic|paraben|sulfate|vegan|gluten)\b/.test(kw) },
  { key: 'howto',         icon: '📖', label: 'How to use / instructions', color: '#06b6d4',
    test: (kw) => /\b(how to|how do|how does|use|apply|application|routine|steps|instruction|direction|dose|dosage|amount)\b/.test(kw) },
  { key: 'reviews',       icon: '⭐', label: 'Reviews / ratings',    color: '#f43f5e',
    test: (kw) => /\b(review|reviews|rating|ratings|feedback|testimonial|opinion|worth it|good|bad|best|top)\b/.test(kw) },
  { key: 'comparison',    icon: '⚖️', label: 'Comparison / vs / alternative', color: '#ec4899',
    test: (kw) => /\b(vs|versus|alternative|compare|comparison|dupe|substitute|similar)\b/.test(kw) },
  { key: 'variants',      icon: '📦', label: 'Variants / sizes / packs', color: '#3b82f6',
    test: (kw) => /\b(spf\s*\d+|\d+\s*(ml|g|gm|gram|oz|ounce|kg|pack|count|ct|tube|bottle|pcs|piece)|small|medium|large|xl|mini|big|jumbo|combo|refill)\b/.test(kw) },
  { key: 'benefits',      icon: '✨', label: 'Benefits / effects',  color: '#10b981',
    test: (kw) => /\b(for|benefit|effects|works|helps|treat|treatment|solve|reduce|remove|repair|heal|cure|prevent|glow|smooth|clear|dry|oily|sensitive)\b/.test(kw) },
  { key: 'brand',         icon: '🏷️', label: 'Brand / competitor',  color: '#a855f7',
    test: (kw, prodName) => {
      // Anything that looks brand-y and doesn't contain the product name tokens.
      const brand = /\b(cetaphil|aquaphor|listerine|neutrogena|olay|ponds|dove|nivea|lakme|maybelline|loreal|nykaa|mamaearth|plum|minimalist|dot ?& ?key|the derma co)\b/.test(kw);
      return brand;
    },
  },
  { key: 'location',      icon: '📍', label: 'India / location',   color: '#0ea5e9',
    test: (kw) => /\b(india|indian|mumbai|delhi|bangalore|bengaluru|chennai|kolkata|hyderabad|pune|near me)\b/.test(kw) },
];
function clusterKeywordsByTheme(rows, productName) {
  const buckets = new Map();
  const uncategorized = [];
  for (const r of rows) {
    const kw = String(r.keyword || '').toLowerCase();
    let hit = null;
    for (const th of KW_THEMES) {
      if (th.test(kw, productName)) { hit = th; break; }
    }
    if (hit) {
      if (!buckets.has(hit.key)) buckets.set(hit.key, { theme: hit, rows: [] });
      buckets.get(hit.key).rows.push(r);
    } else {
      uncategorized.push(r);
    }
  }
  const out = Array.from(buckets.values());
  if (uncategorized.length) out.push({ theme: { key: 'other', icon: '·', label: 'Uncategorized', color: '#64748b' }, rows: uncategorized });
  out.sort((a, b) => b.rows.length - a.rows.length);
  return out;
}
function renderThemesCard(rows) {
  const el = $('anThemes');
  const sub = $('anThemesSub');
  if (!el) return;
  if (!rows || rows.length === 0) { el.innerHTML = ''; if (sub) sub.textContent = '—'; return; }
  const ctx = rows.find(r => r.product_name) || rows[0];
  const productName = String(ctx.product_name || '').toLowerCase();
  const clusters = clusterKeywordsByTheme(rows, productName);
  const total = rows.length;

  // Distribution bar — one row per theme, sorted desc by count.
  const maxCount = Math.max(...clusters.map(c => c.rows.length), 1);
  const bars = clusters.map(c => {
    const pct = Math.round((c.rows.length / total) * 100);
    const width = Math.round((c.rows.length / maxCount) * 100);
    // Best kw per theme by opportunity score.
    const scored = c.rows.map(r => ({ ...r, __s: opportunityScore(r) })).sort((a, b) => b.__s - a.__s);
    const top = scored[0];
    const topKw = top ? top.keyword : '';
    const href = top ? (top.serp_url || `https://www.google.com/search?q=${encodeURIComponent(topKw)}&gl=in`) : '#';
    const avgImg = c.rows.reduce((s, r) => s + (toNum(r.image_count) || 0), 0) / c.rows.length;
    return `
      <div class="theme-row" data-theme="${c.theme.key}">
        <div class="theme-name" style="color:${c.theme.color};">
          <span style="font-size:14px;">${c.theme.icon}</span>&nbsp;<strong>${esc(c.theme.label)}</strong>
        </div>
        <div class="theme-bar-wrap">
          <div class="theme-bar" style="width:${width}%; background:${c.theme.color};"></div>
        </div>
        <div class="theme-count"><strong>${c.rows.length}</strong><span style="opacity:.6;"> · ${pct}%</span></div>
        <div class="theme-top" title="Best-scoring keyword in this theme">
          ${top ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(topKw)}</a>` : '—'}
          ${top ? `<span class="theme-top-score" style="color:${c.theme.color};">${top.__s.toFixed(1)}</span>` : ''}
        </div>
        <div class="theme-imgs" title="Average image matches in this theme">${avgImg > 0 ? '📷 ' + avgImg.toFixed(1) : '—'}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="theme-list">
      <div class="theme-row head">
        <div>Theme</div>
        <div>Share</div>
        <div>Rows</div>
        <div>Best keyword in theme</div>
        <div>Avg imgs</div>
      </div>
      ${bars}
    </div>`;
  if (sub) sub.textContent = `${clusters.length} theme(s) across ${total.toLocaleString()} keyword(s)`;
}

// ─────────── Content-gap card ───────────
// Question-shaped queries + faq-flagged rows are surfaced as "questions
// to answer on the product page". Deduped by lowercase form so PAA and
// autosuggest variants don't repeat the same question twice.
function renderContentGaps(rows) {
  const el = $('anGap');
  const sub = $('anGapSub');
  if (!el) return;
  if (!rows || rows.length === 0) { el.innerHTML = ''; if (sub) sub.textContent = '—'; return; }
  const seen = new Set();
  const gaps = [];
  const isQuestion = (kw) => /^(what|how|why|when|where|is|are|does|do|can|should|which|will|has|have)\b/.test(kw) || /\?$/.test(kw);
  for (const r of rows) {
    const raw = String(r.keyword || '').trim();
    if (!raw) continue;
    const kw = raw.toLowerCase();
    const flagged = String(r.faq || '').toLowerCase() === 'yes';
    if (!isQuestion(kw) && !flagged) continue;
    if (seen.has(kw)) continue;
    seen.add(kw);
    gaps.push({ ...r, __s: opportunityScore(r) });
  }
  gaps.sort((a, b) => b.__s - a.__s);
  const topGaps = gaps.slice(0, 20);
  if (topGaps.length === 0) {
    el.innerHTML = `<div class="hint">No question-shaped queries in this SKU's research — the keyword pool is entirely commercial. Nothing to add to the FAQ block from this data.</div>`;
    if (sub) sub.textContent = '0 gaps';
    return;
  }
  el.innerHTML = `
    <div class="hint" style="margin-bottom: 10px;">
      ${topGaps.length} question${topGaps.length === 1 ? '' : 's'} from real search data — ideal seed material for an on-page FAQ block. Sorted by opportunity score. Click any to open the SERP and see how competitors answer.
    </div>
    <ol class="gap-list">${topGaps.map(g => {
      const href = g.serp_url || `https://www.google.com/search?q=${encodeURIComponent(g.keyword)}&gl=in`;
      const vol = toNum(g.kp_monthly_searches);
      const tier = scoreTier(g.__s);
      return `<li>
        <a href="${esc(href)}" target="_blank" rel="noopener">${esc(g.keyword)}</a>
        <span class="gap-meta">
          <span style="color:${tier.color}; font-weight:600;">${g.__s.toFixed(1)}</span>
          ${vol && vol > 0 ? `· ${vol.toLocaleString()} vol` : ''}
          ${g.buying_intent ? `· ${esc(g.buying_intent)} intent` : ''}
          ${(g.image_count || 0) > 0 ? `· 📷 ${g.image_count}` : ''}
        </span>
      </li>`;
    }).join('')}</ol>
    <div class="row" style="margin-top: 10px;">
      <button id="anGapCopyBtn" class="small secondary" title="Copy all gap questions to clipboard, one per line. Paste into your Claude brief, FAQ builder, or content doc.">📋 Copy ${topGaps.length} question(s)</button>
    </div>`;
  $('anGapCopyBtn')?.addEventListener('click', async () => {
    const text = topGaps.map(g => g.keyword).join('\n');
    try { await navigator.clipboard.writeText(text); toast(`${topGaps.length} question(s) copied.`, 'ok'); }
    catch { toast('Copy failed.', 'err'); }
  });
  if (sub) sub.textContent = `${topGaps.length} gap(s) · top ${Math.min(20, topGaps.length)} shown`;
}

// ─────────── Executive summary ───────────
// Turns raw metrics into plain-English business takeaways. Deliberately
// short — 4-6 bullets max — so it reads like an exec briefing not a dump.
function renderExecutiveSummary(sourceRows, filteredRows) {
  const el = $('anExec');
  const sub = $('anExecSub');
  if (!el) return;
  const rows = sourceRows || [];
  if (rows.length === 0) { el.innerHTML = ''; if (sub) sub.textContent = '—'; return; }

  const ctx = rows.find(r => r.product_name) || rows[0];
  const scored = rows.map(r => ({ ...r, __s: opportunityScore(r) }));
  scored.sort((a, b) => b.__s - a.__s);

  // Primary source aggregation — collapses multi-source rows to their FIRST
  // source (the one that discovered the keyword). Much cleaner than the raw
  // combo chips that read like "KP_IDEA, AUTOSUGGEST, KP_REEXPAND, RELATED_SEARCH".
  const primarySrc = {};
  for (const r of scored) {
    const k = String(r.source || '—').split(',')[0].trim().toUpperCase() || '—';
    primarySrc[k] = (primarySrc[k] || 0) + 1;
  }
  const topSrc = Object.entries(primarySrc).sort((a, b) => b[1] - a[1])[0];

  const intents = { high: 0, medium: 0, low: 0, informational: 0, other: 0 };
  for (const r of scored) { const k = String(r.buying_intent || 'other').toLowerCase(); intents[k] != null ? intents[k]++ : intents.other++; }
  const highPct = Math.round((intents.high / scored.length) * 100);
  const lowPct  = Math.round((intents.low  / scored.length) * 100);

  const withImg = scored.filter(r => (toNum(r.image_count) || 0) > 0).length;
  const imgPct = Math.round((withImg / scored.length) * 100);
  const withVol = scored.filter(r => (toNum(r.kp_monthly_searches) || 0) > 0).length;
  const volPct = Math.round((withVol / scored.length) * 100);
  const dropySeller = scored.filter(r => String(r.dropy_is_seller || '').toLowerCase() === 'yes').length;
  const excellent = scored.filter(r => r.__s >= 12).length;
  const excPct = Math.round((excellent / scored.length) * 100);

  const topKw = scored[0];
  const productName = ctx.product_name || analytics.sku || 'this SKU';
  const targetStatus = scored.length < 100 ? { text: `⚠ below target (${scored.length} / 100 minimum)`, tone: 'warn' }
                    : scored.length > 300 ? { text: `beyond target (${scored.length} / 100–300)`, tone: 'info' }
                    : { text: `on target (${scored.length} / 100–300)`, tone: 'success' };

  // Assemble business-tone takeaways. Each is styled with a tone-colored
  // vertical bar on the left (banner-lite pattern) so the good/warn/danger
  // reads at a glance without extra icons.
  const takeaways = [];

  // Coverage takeaway.
  takeaways.push({
    tone: targetStatus.tone,
    label: 'Keyword coverage',
    body: `${scored.length.toLocaleString()} keywords collected for <strong>${esc(productName)}</strong> — ${targetStatus.text}. ${excellent > 0 ? `<strong>${excellent}</strong> (${excPct}%) rank <span style="color:var(--success);">Excellent</span> (score ≥ 12).` : 'None rank Excellent yet — consider expanding autosuggest depth.'}`,
  });

  // Demand-signal takeaway (KP volume).
  if (volPct >= 50) {
    takeaways.push({ tone: 'success', label: 'Search-demand data', body: `${volPct}% of rows carry Google KP monthly-search volume — confident demand ranking.` });
  } else if (volPct > 0) {
    takeaways.push({ tone: 'warn', label: 'Search-demand data', body: `Only ${volPct}% of rows (${withVol}/${scored.length}) have KP volume. Ranking leans on relevance + image-match signals; enable KP-metrics backfill for tighter demand estimates.` });
  } else {
    takeaways.push({ tone: 'warn', label: 'Search-demand data', body: `<strong>No KP volume data on any row.</strong> Ranking relies purely on relevance + image matches. Fix: ensure the Keyword Planner URL is set and <code>backfillKpMetrics</code> is enabled per worker.` });
  }

  // Visual-visibility takeaway.
  if (imgPct >= 30) {
    takeaways.push({ tone: 'success', label: 'Visual visibility', body: `Our product visually surfaces on <strong>${imgPct}%</strong> of these keyword SERPs (${withImg} of ${scored.length}). Strong organic footprint.` });
  } else if (imgPct > 0) {
    takeaways.push({ tone: 'info', label: 'Visual visibility', body: `Product surfaces visually on <strong>${imgPct}%</strong> of SERPs — decent but there's room to lift image visibility with better product photography and Merchant Center feeds.` });
  } else {
    takeaways.push({ tone: 'warn', label: 'Visual visibility', body: `Product doesn't surface visually on any SERP. Suggests product images may not be indexed or don't match SERP thumbnails — investigate.` });
  }

  // Intent balance takeaway.
  if (highPct >= 25) {
    takeaways.push({ tone: 'success', label: 'Buying-intent balance', body: `<strong>${highPct}%</strong> of keywords are high-buying-intent — a strong pool to drive paid ads and category pages against.` });
  } else if (highPct >= 10) {
    takeaways.push({ tone: 'info', label: 'Buying-intent balance', body: `${highPct}% high-intent, ${lowPct}% low-intent. Split marketing: high-intent for ads, low-intent for SEO content/blog.` });
  } else {
    takeaways.push({ tone: 'warn', label: 'Buying-intent balance', body: `Only ${highPct}% high-intent (${lowPct}% low). Expand around "buy", "price", "best", "review", and city-modified queries to lift commercial intent.` });
  }

  // Best channel takeaway (which source is doing the heavy lifting).
  if (topSrc) {
    const [srcName, srcCount] = topSrc;
    const srcPct = Math.round((srcCount / scored.length) * 100);
    takeaways.push({ tone: 'neutral', label: 'Discovery mix', body: `<strong>${srcPct}%</strong> of the pool came from <span class="chip src-${srcName.toLowerCase().split('_')[0]}" style="font-size:10px;">${esc(srcName)}</span>. Diversify by adding more KP seeds or a deeper autosuggest crawl if this is over-concentrated.` });
  }

  // Merchandising takeaway.
  if (dropySeller > 0) {
    takeaways.push({ tone: 'success', label: 'Merchandising', body: `dropy.in is already listed as a seller on <strong>${dropySeller}</strong> of these keyword SERPs — protect these positions.` });
  }

  // Top-opportunity spotlight.
  if (topKw) {
    const vol = toNum(topKw.kp_monthly_searches);
    const bits = [`score <strong>${topKw.__s.toFixed(1)}</strong>`];
    if (vol && vol > 0) bits.push(`${vol.toLocaleString()} monthly searches`);
    if (topKw.buying_intent) bits.push(`${topKw.buying_intent} intent`);
    if (topKw.kp_competition) bits.push(`${topKw.kp_competition} competition`);
    const href = topKw.serp_url || `https://www.google.com/search?q=${encodeURIComponent(topKw.keyword)}&gl=in`;
    takeaways.push({ tone: 'info', label: 'Top opportunity', body: `<a href="${esc(href)}" target="_blank" rel="noopener"><strong>${esc(topKw.keyword)}</strong></a> — ${bits.join(' · ')}. Anchor your product title + first Google ad headline around this phrase.` });
  }

  const toneColor = {
    success: 'var(--success)',
    info:    'var(--accent)',
    warn:    'var(--warn)',
    danger:  'var(--danger)',
    neutral: 'var(--text-3)',
  };

  el.innerHTML = takeaways.map(t => `
    <div class="exec-bullet" style="border-left: 3px solid ${toneColor[t.tone] || 'var(--text-3)'};">
      <div class="exec-label" style="color: ${toneColor[t.tone] || 'var(--text-2)'};">${esc(t.label)}</div>
      <div class="exec-body">${t.body}</div>
    </div>`).join('');
  if (sub) sub.textContent = `${scored.length.toLocaleString()} keyword(s) analysed`;
}

function renderAnalyticsSummary(rows) {
  const el = $('anSummary');
  if (rows.length === 0) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📭</div>${analytics.sku ? 'No keywords for this SKU yet.' : 'No keywords in this batch yet.'}</div>`;
    return;
  }
  // Compact stat row — used to live above as 5 large tiles + a whole card
  // for sources + intent. Merged into a single dense strip so the Executive
  // Summary + Insights below get the vertical space instead. The multi-
  // source combo chips ("KP_IDEA, AUTOSUGGEST, RELATED_SEARCH") that
  // read as noise are gone; we aggregate by PRIMARY source instead.
  const withImg = rows.filter(r => (toNum(r.image_count) || 0) > 0).length;
  const totalImg = rows.reduce((s, r) => s + (toNum(r.image_count) || 0), 0);
  const withVol = rows.filter(r => (toNum(r.kp_monthly_searches) || 0) > 0).length;
  const avgScore = rows.reduce((s, r) => s + (Number(r.opportunity_score) || 0), 0) / rows.length;

  const primarySrc = {};
  for (const r of rows) {
    const k = String(r.source || '—').split(',')[0].trim().toUpperCase() || '—';
    primarySrc[k] = (primarySrc[k] || 0) + 1;
  }
  const srcClassFor = (k) => {
    const s = String(k).toLowerCase();
    if (s.startsWith('kp')) return 'src-kp';
    if (s.startsWith('autosuggest')) return 'src-autosuggest';
    if (s.startsWith('serp')) return 'src-serp';
    if (s.startsWith('paa')) return 'src-paa';
    if (s.startsWith('related')) return 'src-related';
    if (s.startsWith('amazon')) return 'src-amazon';
    return 'pending';
  };
  const srcIcon = (k) => {
    const s = String(k).toLowerCase();
    if (s.startsWith('kp')) return '📊';
    if (s.startsWith('autosuggest')) return '⌨️';
    if (s.startsWith('serp')) return '🔎';
    if (s.startsWith('paa')) return '❓';
    if (s.startsWith('related')) return '🔗';
    if (s.startsWith('amazon')) return '🛒';
    return '·';
  };
  const totalRows = rows.length;
  const srcChips = Object.entries(primarySrc).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const pct = Math.round((v / totalRows) * 100);
    return `<span class="chip ${srcClassFor(k)}" title="${esc(k)} — ${v} rows (${pct}% of pool)">${srcIcon(k)} <strong>${esc(k)}</strong> · ${v}<span style="opacity:.65;"> · ${pct}%</span></span>`;
  }).join(' ');

  const byIntent = { high: 0, medium: 0, low: 0, informational: 0 };
  for (const r of rows) { const k = String(r.buying_intent || '').toLowerCase(); if (byIntent[k] != null) byIntent[k]++; }
  const intentChips = ['high', 'medium', 'low', 'informational'].filter(k => byIntent[k] > 0).map(k => {
    const cls = k === 'high' ? 'done' : k === 'medium' ? 'claimed' : 'pending';
    const pct = Math.round((byIntent[k] / totalRows) * 100);
    return `<span class="chip ${cls}"><strong>${k}</strong>: ${byIntent[k]}<span style="opacity:.65;"> · ${pct}%</span></span>`;
  }).join(' ');

  el.innerHTML = `
    <div class="tiles compact-tiles">
      <div class="tile success"><div class="lbl">Keywords</div><div class="val">${totalRows.toLocaleString()}</div></div>
      <div class="tile info"><div class="lbl">Image matches</div><div class="val">${withImg}<span class="sub"> · ${totalImg} hits</span></div></div>
      <div class="tile ${avgScore >= 7 ? 'success' : ''}"><div class="lbl">Avg opportunity</div><div class="val">${avgScore.toFixed(1)}</div></div>
      <div class="tile ${withVol > 0 ? '' : 'warn'}"><div class="lbl">KP volume rows</div><div class="val">${withVol}<span class="sub"> / ${totalRows}</span></div></div>
    </div>
    <div class="row tight" style="margin: 6px 0;">${srcChips || ''}</div>
    ${intentChips ? `<div class="row tight" style="margin-bottom: 6px;">${intentChips}</div>` : ''}
  `;
}

// Auto-generated recommendations from the current batch/SKU. Users glance
// at this instead of scanning the whole table.
function renderAnalyticsInsights(sourceRows, filteredRows) {
  const el = $('anInsights');
  const sub = $('anInsightsSub');
  if (!el) return;
  if (!sourceRows || sourceRows.length === 0) {
    el.innerHTML = '';
    if (sub) sub.textContent = '—';
    return;
  }

  // Attach scores to every row up-front so the ranking here matches the table.
  const scored = sourceRows.map(r => ({ ...r, __s: opportunityScore(r) }));

  // ── Top 3 opportunities ─────────────────────────────────────────
  const top = [...scored].sort((a, b) => b.__s - a.__s).slice(0, 3);

  // ── Buying-intent breakdown ─────────────────────────────────────
  const byIntent = { high: 0, medium: 0, low: 0, informational: 0, other: 0 };
  for (const r of scored) {
    const k = String(r.buying_intent || 'other').toLowerCase();
    byIntent[k] != null ? byIntent[k]++ : byIntent.other++;
  }

  // ── Best-performing source (by average opportunity score) ───────
  const sourceStats = new Map();
  for (const r of scored) {
    const key = String(r.source || '—').split(',')[0].trim().toUpperCase();
    const cur = sourceStats.get(key) || { count: 0, scoreSum: 0, imgs: 0 };
    cur.count++;
    cur.scoreSum += r.__s;
    if ((r.image_count || 0) > 0) cur.imgs++;
    sourceStats.set(key, cur);
  }
  const bestSources = Array.from(sourceStats.entries())
    .filter(([, s]) => s.count >= 3)
    .map(([k, s]) => ({ source: k, avg: s.scoreSum / s.count, count: s.count, imgs: s.imgs }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);

  // ── Coverage checks ─────────────────────────────────────────────
  const total = scored.length;
  const kpMetric = scored.filter(r => (r.kp_monthly_searches || 0) > 0).length;
  const kpCoveragePct = total > 0 ? Math.round((kpMetric / total) * 100) : 0;
  const withImg = scored.filter(r => (r.image_count || 0) > 0).length;
  const imgCoveragePct = total > 0 ? Math.round((withImg / total) * 100) : 0;
  const dropySellerRows = scored.filter(r => String(r.dropy_is_seller || '').toLowerCase() === 'yes').length;
  const lowCompHighVol = scored.filter(r => String(r.kp_competition || '').toLowerCase() === 'low' && (r.kp_monthly_searches || 0) >= 500).length;

  // ── SKU coverage vs 100-300 kw target ───────────────────────────
  // Only informative when viewing "All SKUs" for a batch.
  let skuCoverageBlock = '';
  if (!analytics.sku) {
    const perSku = new Map();
    for (const r of scored) {
      const k = r.sku || r.product_url || '—';
      perSku.set(k, (perSku.get(k) || 0) + 1);
    }
    const counts = Array.from(perSku.values());
    const below100 = counts.filter(n => n < 100).length;
    const above300 = counts.filter(n => n > 300).length;
    const inRange = counts.filter(n => n >= 100 && n <= 300).length;
    const avg = counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0;
    skuCoverageBlock = `
      <div class="tile ${below100 > 0 ? 'warn' : 'success'}"><div class="lbl">Per-SKU kw coverage</div>
        <div class="val" style="font-size:14px;">avg ${avg}</div>
        <div style="font-size:10px; color:var(--text-2); margin-top:2px;">
          ${inRange} in 100–300 · <span style="color:${below100 ? 'var(--warn)' : 'var(--text-3)'};">${below100} &lt;100</span> · ${above300} &gt;300
        </div>
      </div>`;
  }

  // ── Score-tier histogram ────────────────────────────────────────
  // Groups every row by its opportunity-score tier so the user can see the
  // shape of the batch at a glance (mostly-low vs a fat middle vs a few gems).
  const tiers = { excellent: 0, good: 0, ok: 0, low: 0 };
  for (const r of scored) tiers[scoreTier(r.__s).tier]++;
  const tierMax = Math.max(tiers.excellent, tiers.good, tiers.ok, tiers.low, 1);
  const tierColor = { excellent: 'var(--success)', good: 'var(--accent)', ok: 'var(--warn)', low: 'var(--text-3)' };
  const tierLabel = { excellent: '≥12  ·  Excellent', good: '7–12  ·  Good', ok: '3–7  ·  OK', low: '<3  ·  Weak' };
  const histBars = ['excellent', 'good', 'ok', 'low'].map(t => {
    const n = tiers[t];
    const pct = Math.round((n / tierMax) * 100);
    return `
      <div style="display:grid; grid-template-columns: 120px 1fr 40px; gap:8px; align-items:center; padding: 3px 0;">
        <div style="font-size:11px; color:${tierColor[t]};">${tierLabel[t]}</div>
        <div style="background:var(--bg-input); border-radius:3px; height:10px; overflow:hidden;">
          <div style="height:100%; width:${pct}%; background:${tierColor[t]};"></div>
        </div>
        <div style="font-family:var(--mono); font-size:11px; text-align:right; color:${tierColor[t]}; font-weight:600;">${n}</div>
      </div>`;
  }).join('');

  // Render.
  el.innerHTML = `
    <div class="tiles" style="margin-bottom: 10px;">
      <div class="tile ${lowCompHighVol > 0 ? 'success' : ''}">
        <div class="lbl">Low-comp + ≥500 vol</div>
        <div class="val">${lowCompHighVol}</div>
        <div style="font-size:10px; color:var(--text-2); margin-top:2px;">easy targets to bid/rank</div>
      </div>
      <div class="tile ${dropySellerRows > 0 ? 'info' : ''}">
        <div class="lbl">We're already listed on</div>
        <div class="val">${dropySellerRows}</div>
        <div style="font-size:10px; color:var(--text-2); margin-top:2px;">dropy.in on SERP</div>
      </div>
      <div class="tile ${kpCoveragePct >= 60 ? 'success' : kpCoveragePct >= 30 ? 'warn' : ''}">
        <div class="lbl">KP metric coverage</div>
        <div class="val">${kpCoveragePct}%</div>
        <div style="font-size:10px; color:var(--text-2); margin-top:2px;">${kpMetric}/${total} rows have Volume</div>
      </div>
      <div class="tile ${imgCoveragePct >= 30 ? 'success' : ''}">
        <div class="lbl">Image-match coverage</div>
        <div class="val">${imgCoveragePct}%</div>
        <div style="font-size:10px; color:var(--text-2); margin-top:2px;">${withImg}/${total} rows have hits</div>
      </div>
      ${skuCoverageBlock}
    </div>

    <div class="card" style="margin-bottom: 10px; background: var(--bg-2);">
      <div class="card-body" style="padding: 10px 14px;">
        <div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">📊 Score distribution across ${total.toLocaleString()} keyword(s)</div>
        ${histBars}
      </div>
    </div>

    <div class="two-col" style="gap: 10px;">
      <div>
        <div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">🎯 Top 3 opportunities</div>
        ${top.length === 0 ? '<div class="hint">No scored rows yet.</div>' : top.map((r, i) => {
          const vol = toNum(r.kp_monthly_searches);
          const rating = toNum(r.ad_rating);
          const imgs = toNum(r.image_count) ?? 0;
          const kw = String(r.keyword || '—');
          const href = r.serp_url || `https://www.google.com/search?q=${encodeURIComponent(kw)}`;
          const tier = scoreTier(r.__s);
          return `
          <div style="padding: 8px 10px; border: 1px solid var(--line-1); border-left: 3px solid ${tier.color}; border-radius: 6px; margin-bottom: 6px; background: var(--bg-2);">
            <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
              <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;" title="${esc(kw)}">
                <span style="color:var(--accent);">#${i + 1}</span>&nbsp;
                <a href="${esc(href)}" target="_blank" rel="noopener">${esc(kw)}</a>
              </div>
              <div style="font-family: var(--mono); color:${tier.color}; font-weight:700; font-size:14px;">${r.__s.toFixed(1)}</div>
            </div>
            <div style="font-size:11px; color:var(--text-2); margin-top:4px;">
              ${vol != null && vol > 0 ? `📊 ${vol.toLocaleString()} vol` : '📊 —'}
              &nbsp;·&nbsp;
              ${r.kp_competition ? `🎯 ${esc(r.kp_competition)} comp` : '🎯 —'}
              &nbsp;·&nbsp;
              ⭐ ${rating != null ? rating.toFixed(1) : '—'}
              &nbsp;·&nbsp;
              ${imgs > 0 ? `📷 ${imgs}` : '📷 —'}
              ${r.buying_intent ? `&nbsp;·&nbsp;<span class="chip ${r.buying_intent === 'high' ? 'done' : r.buying_intent === 'medium' ? 'claimed' : 'pending'}" style="font-size:10px;">${esc(r.buying_intent)}</span>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>

      <div>
        <div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">🏆 Best-performing sources</div>
        ${bestSources.length === 0 ? '<div class="hint">Need more rows to compare sources.</div>' : `
          <table class="tbl" style="font-size: 12px;">
            <thead><tr><th>Source</th><th class="num">Avg score</th><th class="num">Rows</th><th class="num">With imgs</th></tr></thead>
            <tbody>${bestSources.map(s => `
              <tr>
                <td><span class="chip ${
                  s.source.includes('KP') ? 'src-kp' :
                  s.source.includes('AUTOSUGGEST') ? 'src-autosuggest' :
                  s.source.includes('SERP') ? 'src-serp' :
                  s.source.includes('PAA') ? 'src-paa' :
                  s.source.includes('RELATED') ? 'src-related' :
                  s.source.includes('AMAZON') ? 'src-amazon' : 'pending'
                }">${esc(s.source)}</span></td>
                <td class="num" style="color:var(--accent); font-weight:600;">${s.avg.toFixed(1)}</td>
                <td class="num">${s.count}</td>
                <td class="num" style="color: ${s.imgs > 0 ? 'var(--success)' : 'var(--text-3)'};">${s.imgs}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}

        <div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-top:12px; margin-bottom:6px;">🧭 Buying intent mix</div>
        <div class="row tight">
          ${byIntent.high        > 0 ? `<span class="chip done">high: ${byIntent.high}</span>` : ''}
          ${byIntent.medium      > 0 ? `<span class="chip claimed">medium: ${byIntent.medium}</span>` : ''}
          ${byIntent.low         > 0 ? `<span class="chip pending">low: ${byIntent.low}</span>` : ''}
          ${byIntent.informational > 0 ? `<span class="chip pending">informational: ${byIntent.informational}</span>` : ''}
          ${byIntent.other       > 0 ? `<span class="chip pending">unclassified: ${byIntent.other}</span>` : ''}
        </div>
      </div>
    </div>
  `;
  if (sub) sub.textContent = `${filteredRows.length.toLocaleString()} row(s) · scoring live`;
}

function renderAnalyticsTopChart(rows) {
  const el = $('anTopChart');
  if (rows.length === 0) { el.innerHTML = ''; return; }
  // Rank by opportunity score (already attached in filterAndRenderAnalytics).
  const top = [...rows]
    .filter(r => (r.opportunity_score || 0) > 0)
    .sort((a, b) => (b.opportunity_score || 0) - (a.opportunity_score || 0))
    .slice(0, 10);
  $('anTopChartSub').textContent = `top ${top.length} by opportunity score`;
  if (top.length === 0) { el.innerHTML = `<div class="hint">No scored keywords yet.</div>`; return; }
  const maxV = Math.max(...top.map(r => r.opportunity_score || 0), 1);
  el.innerHTML = top.map(r => {
    const kwRaw = String(r.keyword || '—');
    const kw    = esc(kwRaw);
    const score = toNum(r.opportunity_score) ?? 0;
    const pct   = Math.round((score / maxV) * 100);
    const img   = toNum(r.image_count) ?? 0;
    const vol   = toNum(r.kp_monthly_searches);
    const href  = r.serp_url || `https://www.google.com/search?q=${encodeURIComponent(kwRaw)}`;
    const tier  = scoreTier(score);
    return `
      <div style="display:grid; grid-template-columns: 220px 1fr 60px 80px 50px; gap: 8px; align-items:center; padding: 4px 0; border-bottom: 1px solid var(--line-1); font-size: 12px;">
        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${kw}"><a href="${esc(href)}" target="_blank" rel="noopener">${kw}</a></div>
        <div style="background: var(--bg-input); border-radius: 4px; height: 14px; overflow: hidden; position: relative;">
          <div style="background: ${tier.color}; height: 100%; width: ${pct}%; transition: width 200ms;"></div>
        </div>
        <div style="text-align:right; font-family: var(--mono); color: ${tier.color}; font-weight:600;">${score.toFixed(1)}</div>
        <div style="text-align:right; font-family: var(--mono); color: var(--text-2);">${vol != null && vol > 0 ? vol.toLocaleString() + ' v' : '—'}</div>
        <div style="text-align:right; font-family: var(--mono); color: ${img > 0 ? 'var(--success)' : 'var(--text-3)'};">${img > 0 ? `📷 ${img}` : '—'}</div>
      </div>
    `;
  }).join('');
}

// Helper: robust numeric coercion — treats NaN/null/'' as null (renders as "—").
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Score→tier mapping — used for row-level left border + tile coloring.
function scoreTier(n) {
  if (n >= 12) return { tier: 'excellent', color: 'var(--success)' };
  if (n >= 7)  return { tier: 'good',      color: 'var(--accent)'  };
  if (n >= 3)  return { tier: 'ok',        color: 'var(--warn)'    };
  return          { tier: 'low',       color: 'var(--text-3)'  };
}
function renderColumnGroupStrip(rows) {
  const el = $('anColGroups');
  if (!el) return;
  // Per-group column count (visible + total) for the badge on each chip.
  const groupCounts = {};
  for (const c of KEYWORD_COL_DEFS) {
    if (c.key === '__details') continue;
    groupCounts[c.group] = (groupCounts[c.group] || 0) + 1;
  }
  el.innerHTML = KEYWORD_COL_GROUPS.map(g => {
    const on = g.locked || analytics.visibleGroups.has(g.key);
    const disabled = g.locked ? 'disabled' : '';
    const cls = `col-group ${on ? 'on' : ''} ${g.locked ? 'locked' : ''}`;
    return `<button class="${cls}" data-group="${g.key}" ${disabled} title="${g.locked ? 'Core columns are always visible.' : `Toggle ${g.label} columns (${groupCounts[g.key] || 0}).`}">
      ${g.icon} <strong>${esc(g.label)}</strong> <span class="col-group-count">${groupCounts[g.key] || 0}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('button[data-group]:not(.locked)').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.group;
      if (analytics.visibleGroups.has(key)) analytics.visibleGroups.delete(key);
      else analytics.visibleGroups.add(key);
      try { localStorage.setItem('adbrainAnGroups', JSON.stringify(Array.from(analytics.visibleGroups))); } catch {}
      filterAndRenderAnalytics();
    });
  });
}

function renderAnalyticsTable(rows) {
  const el = $('anTable');
  renderColumnGroupStrip(rows);
  // Note the hidden count is updated below (after we compute hiddenCols).
  if (rows.length === 0) {
    el.innerHTML = `<tr><td style="padding:16px; text-align:center; color:var(--text-3);">No keywords match the current filters.</td></tr>`;
    return;
  }
  // Max score across the current filtered set — used to normalize the inline
  // bar in the Score column so the top row always looks full.
  const maxScore = Math.max(...rows.map(r => Number(r.opportunity_score) || 0), 1);
  // Column definitions grouped to mirror the CSV/XLSX export layout —
  // analytics is meant to be feature-parity with the file, so every
  // export column is available here. Groups can be toggled on/off via
  // the button strip above the table; visibility state persists in
  // localStorage (see analytics.visibleGroups). Order matters — this
  // is the on-screen order when multiple groups are enabled.
  const cols = KEYWORD_COL_DEFS.filter(c => c.group === 'core' || analytics.visibleGroups.has(c.group));
  // Auto-hide any column whose entire filtered set is empty (all null / 0
  // / "" — the em-dash forest). Anchor + score + keyword + details are
  // pinned so they always show, and users can toggle via the button below.
  const alwaysShow = new Set(['opportunity_score', 'keyword', 'source', '__details']);
  const isEmptyForCol = (col) => rows.every(r => {
    const v = r[col.key];
    if (v == null || v === '' || v === '—') return true;
    if (col.kind === 'yesno') return !(String(v).toLowerCase() === 'yes' || v === true || v === 1);
    if (['num', 'money', 'pct', 'rating', 'imgs'].includes(col.kind)) {
      const n = Number(v);
      return !Number.isFinite(n) || n === 0;
    }
    return false;
  });
  const hiddenCols = new Set();
  if (analytics.hideEmptyCols) {
    for (const c of cols) if (!alwaysShow.has(c.key) && isEmptyForCol(c)) hiddenCols.add(c.key);
  }
  const visibleCols = cols.filter(c => !hiddenCols.has(c.key));
  // Header count + hidden-cols hint.
  const countEl = $('anTableCount');
  if (countEl) {
    const hiddenLabels = Array.from(hiddenCols).map(k => cols.find(c => c.key === k)?.label).filter(Boolean).join(', ');
    const hint = hiddenCols.size > 0
      ? ` · <button id="anShowAllColsBtn" class="tiny-link" title="Show every column even when all values are empty for the current filtered set.">show ${hiddenCols.size} empty col(s)</button><span class="hint" style="margin-left: 4px;">(${esc(hiddenLabels)})</span>`
      : (!analytics.hideEmptyCols
          ? ` · <button id="anHideEmptyColsBtn" class="tiny-link">hide empty cols</button>`
          : '');
    countEl.innerHTML = `${rows.length.toLocaleString()} row(s)${hint}`;
  }
  const thead = `<thead><tr>${visibleCols.map(c => `
    <th data-sort-key="${c.key}" style="cursor:pointer;" title="${esc(c.tip || 'Click to sort')}">
      ${esc(c.label)}${analytics.sortKey === c.key ? (analytics.sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.slice(0, 500).map((r, _idx) => {
    const rowScore = Number(r.opportunity_score) || 0;
    const rowTier  = scoreTier(rowScore);
    // Row's left border colored by tier — instantly conveys quality at a glance.
    const rowStyle = `border-left: 3px solid ${rowTier.color};`;
    return `
    <tr class="tier-${rowTier.tier}" style="${rowStyle}">${visibleCols.map(c => {
      const v = r[c.key];
      if (c.kind === 'chip' && v) {
        // Source column uses source-specific colors; intent/relevance columns
        // use done/claimed/pending green→yellow→grey.
        let cls;
        if (c.key === 'source') {
          const s = String(v).toLowerCase();
          cls = s.includes('kp') ? 'src-kp'
              : s.includes('autosuggest') ? 'src-autosuggest'
              : s.includes('serp') ? 'src-serp'
              : s.includes('paa') ? 'src-paa'
              : s.includes('related') ? 'src-related'
              : s.includes('amazon') ? 'src-amazon'
              : 'pending';
        } else if (c.key === 'keyword_relevance') {
          const s = String(v).toLowerCase();
          cls = s === 'high' ? 'done' : s === 'medium' ? 'claimed' : s.includes('sibling') ? 'src-paa' : 'pending';
        } else {
          cls = String(v) === 'high' ? 'done' : String(v) === 'medium' ? 'claimed' : 'pending';
        }
        return `<td><span class="chip ${cls}">${esc(v)}</span></td>`;
      }
      if (c.kind === 'imgs') {
        const n = toNum(v);
        return `<td class="num" style="color:${(n||0) > 0 ? 'var(--success)' : 'var(--text-3)'};">${n ?? 0}</td>`;
      }
      if (c.kind === 'rating') {
        const n = toNum(v);
        if (n == null) return `<td class="num" style="color:var(--text-3);">—</td>`;
        const color = n >= 7 ? 'var(--success)' : n >= 4 ? 'var(--warn)' : 'var(--text-3)';
        return `<td class="num" style="color:${color};">${n.toFixed(1)}</td>`;
      }
      if (c.kind === 'score') {
        const n = toNum(v) ?? 0;
        // Inline mini-bar makes the ranking visible at a glance without users
        // having to read the number — the top row is always full, others scale.
        const pct = Math.round((n / maxScore) * 100);
        return `<td class="num" style="min-width: 96px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <div style="flex:1; background: var(--bg-input); border-radius: 3px; height: 8px; overflow:hidden;">
              <div style="height:100%; width:${pct}%; background: ${rowTier.color}; transition: width 200ms;"></div>
            </div>
            <span style="color:${rowTier.color}; font-weight:600; min-width: 30px; text-align:right;">${n.toFixed(1)}</span>
          </div>
        </td>`;
      }
      if (c.kind === 'kw') {
        // Keyword cell: click to open Google SERP for that keyword — quick
        // spot-check when reviewing data. Uses stored serp_url if present.
        const kw = String(v || '—');
        const href = r.serp_url || `https://www.google.com/search?q=${encodeURIComponent(kw)}`;
        return `<td style="max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(kw)} — click to open SERP">
          <a href="${esc(href)}" target="_blank" rel="noopener" style="color: var(--text-1); text-decoration:none;">${esc(kw)}</a>
        </td>`;
      }
      if (c.kind === 'comp') {
        const s = String(v || '').toLowerCase();
        if (!s || s === '—') return `<td class="num" style="color:var(--text-3);">—</td>`;
        const color = s === 'high' ? 'var(--danger)' : s === 'medium' ? 'var(--warn)' : 'var(--success)';
        return `<td style="color:${color};">${esc(v)}</td>`;
      }
      if (c.kind === 'money') {
        const n = toNum(v);
        if (n == null || n === 0) return `<td class="num" style="color:var(--text-3);">—</td>`;
        return `<td class="num">₹${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>`;
      }
      if (c.kind === 'pct') {
        const n = toNum(v);
        if (n == null || n === 0) return `<td class="num" style="color:var(--text-3);">—</td>`;
        const color = n >= 50 ? 'var(--success)' : n >= 20 ? 'var(--warn)' : 'var(--text-2)';
        return `<td class="num" style="color:${color};">${n.toFixed(0)}%</td>`;
      }
      if (c.kind === 'yesno') {
        const yes = String(v || '').toLowerCase() === 'yes' || v === true || v === 1;
        return yes ? `<td class="num" style="color:var(--success);">✓</td>` : `<td class="num" style="color:var(--text-3);">·</td>`;
      }
      if (c.kind === 'num') {
        const n = toNum(v);
        return `<td class="num">${n != null ? n.toLocaleString() : '<span style="color:var(--text-3);">—</span>'}</td>`;
      }
      if (c.kind === 'details') {
        // Rendered as a button with data-row-idx so the row's full data is
        // recoverable from analytics.skuRows without stashing it in DOM.
        return `<td style="text-align:center; width: 30px;"><button class="row-detail-btn" data-kw-detail="${_idx}" title="Show every field for this keyword.">🔍</button></td>`;
      }
      return `<td style="max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(v)}">${esc(v == null ? '—' : v)}</td>`;
    }).join('')}</tr>`;
  }).join('')}${rows.length > 500 ? `<tr><td colspan="${visibleCols.length}" style="text-align:center; color:var(--text-3);">…and ${rows.length - 500} more — narrow the filters to see them.</td></tr>` : ''}</tbody>`;
  el.innerHTML = thead + tbody;
  // Wire header click → sort toggle (skips the pseudo-details column).
  el.querySelectorAll('th[data-sort-key]').forEach(th => {
    if (th.dataset.sortKey === '__details') return;
    th.addEventListener('click', () => {
      const k = th.dataset.sortKey;
      if (analytics.sortKey === k) analytics.sortDir = analytics.sortDir === 'desc' ? 'asc' : 'desc';
      else { analytics.sortKey = k; analytics.sortDir = 'desc'; }
      filterAndRenderAnalytics();
    });
  });
  // Wire row 🔍 button → detail modal.
  el.querySelectorAll('button[data-kw-detail]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.kwDetail, 10);
      const row = rows[idx];
      if (row) openKeywordDetail(row);
    });
  });
  // Wire empty-columns toggles (present in the count/sub label).
  $('anShowAllColsBtn')?.addEventListener('click', () => { analytics.hideEmptyCols = false; filterAndRenderAnalytics(); });
  $('anHideEmptyColsBtn')?.addEventListener('click', () => { analytics.hideEmptyCols = true;  filterAndRenderAnalytics(); });
}

// ─────────── Keyword detail modal ───────────
// Field ordering matches the export layout — most-useful signals first.
const KW_DETAIL_GROUPS = [
  ['🔑 Identity', ['keyword', 'source', 'parent_keyword', 'sku', 'product_name']],
  ['📊 Scoring', ['opportunity_score', 'ad_rating', 'frequency', 'buying_intent', 'keyword_relevance', 'topic', 'funnel', 'faq']],
  ['💰 KP metrics', ['kp_monthly_searches', 'kp_competition', 'kp_bid_low', 'kp_bid_high']],
  ['📷 Image match', ['image_count', 'total_thumbs', 'visibility_pct', 'image_count_unverified', 'match_sources', 'serp_zone_counts', 'match_confidence_max', 'match_confidence_avg', 'match_confidence_min', 'link_checked_count', 'link_verified_count']],
  ['🛒 Sellers & SERP', ['total_sellers', 'seller_type', 'dropy_is_seller', 'dropy_on_serp', 'ads_on_serp', 'sellers_on_serp', 'seller_titles', 'top_match_seller', 'top_match_price']],
  ['📦 Amazon (R3)', ['amazon_suggest_count', 'amazon_rank', 'amazon_price', 'amazon_rating', 'amazon_reviews', 'amazon_title', 'amazon_competitors', 'amazon_total_results']],
  ['🔗 Links', ['serp_url', 'matched_links', 'verified_links', 'product_url']],
];
function openKeywordDetail(row) {
  const modal = $('kwDetailModal');
  const title = $('kwDetailTitle');
  const body = $('kwDetailBody');
  if (!modal || !title || !body) return;
  title.textContent = row.keyword || 'Keyword details';

  // ── Quick-links row ─────────────────────────────────────────────
  // Anything a user might want to click through to for context, one place.
  const kw = String(row.keyword || '').trim();
  const enc = encodeURIComponent;
  const links = [];
  if (kw) {
    // Google SERP (india-focused via ?gl=in)
    const serpUrl = row.serp_url || `https://www.google.com/search?q=${enc(kw)}&gl=in`;
    links.push({ href: serpUrl,                                                 icon: '🔎', label: 'Google SERP' });
    // Google Keyword Planner is auth-walled but we can deep-link the sign-in.
    links.push({ href: `https://ads.google.com/aw/keywordplanner/ideas/new?keywords=${enc(kw)}`,
                 icon: '📊', label: 'Google KP',      title: 'Open Keyword Planner for this seed (Google Ads account required).' });
    // Google Trends — a decent free proxy for KP volume when no KP data.
    links.push({ href: `https://trends.google.com/trends/explore?geo=IN&q=${enc(kw)}`,
                 icon: '📈', label: 'Trends (IN)',   title: 'Google Trends for India — free demand proxy when KP metrics are missing.' });
    // Amazon.in search — mirrors the amazon_reader flow.
    links.push({ href: `https://www.amazon.in/s?k=${enc(kw)}`, icon: '🛒', label: 'Amazon.in' });
    // dropy.in search on the current keyword — verify our own listing.
    links.push({ href: `https://dropy.in/search?q=${enc(kw)}`, icon: '🏪', label: 'Search on dropy.in',
                 title: 'Check whether this keyword surfaces our own product on dropy.in.' });
  }
  // If our product URL is known, always offer a jump to our listing.
  if (row.product_url) links.push({ href: row.product_url, icon: '📦', label: 'Our product page' });
  // If dropy shows up as a seller on THIS keyword's SERP, flag it explicitly.
  const dropyIsSeller = String(row.dropy_is_seller || '').toLowerCase() === 'yes';
  const dropyOnSerp   = String(row.dropy_on_serp   || '').toLowerCase() === 'yes';
  const dropyBadge = (dropyIsSeller || dropyOnSerp)
    ? `<span class="chip done" style="margin-left: 8px;">${dropyIsSeller ? '✓ dropy.in listed as SELLER' : '✓ dropy.in appears on SERP'}</span>`
    : '';
  const quickLinks = `
    <div style="margin-bottom: 14px;">
      <div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">🔗 Quick links${dropyBadge}</div>
      <div class="row tight">
        ${links.map(l => `<a href="${esc(l.href)}" target="_blank" rel="noopener" class="chip" style="text-decoration:none; background:var(--bg-3); color:var(--text-1); border:1px solid var(--line-2);" ${l.title ? `title="${esc(l.title)}"` : ''}>${l.icon} ${esc(l.label)}</a>`).join('')}
      </div>
    </div>`;

  const shown = new Set();
  const groups = KW_DETAIL_GROUPS.map(([grpLabel, keys]) => {
    const fields = keys.filter(k => k in row).map(k => {
      shown.add(k);
      const raw = row[k];
      const empty = raw === null || raw === undefined || raw === '' || (typeof raw === 'number' && !Number.isFinite(raw));
      const val = empty ? '<span class="empty">—</span>' : esc(String(raw));
      const isMono = typeof raw === 'string' && raw.length > 40;
      return `<div class="k">${esc(k)}</div><div class="v ${isMono ? 'mono' : ''}">${val}</div>`;
    }).join('');
    return fields ? `<div style="margin-bottom: 14px;"><div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">${grpLabel}</div><div class="kw-fields">${fields}</div></div>` : '';
  }).join('');
  // Anything left over (custom columns) — dump at the end so we never hide data.
  const extra = Object.keys(row).filter(k => !shown.has(k) && !k.startsWith('__')).map(k => {
    const raw = row[k];
    const empty = raw === null || raw === undefined || raw === '' || (typeof raw === 'number' && !Number.isFinite(raw));
    const val = empty ? '<span class="empty">—</span>' : esc(String(raw));
    return `<div class="k">${esc(k)}</div><div class="v mono">${val}</div>`;
  }).join('');
  const extraBlock = extra ? `<div style="margin-bottom: 14px;"><div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">Other fields</div><div class="kw-fields">${extra}</div></div>` : '';
  body.innerHTML = quickLinks + groups + extraBlock;
  modal.style.display = 'flex';
}
// Backdrop / Close-button close both modals.
document.addEventListener('click', (e) => {
  if (e.target?.dataset?.closeModal) {
    document.querySelectorAll('.modal-root').forEach(m => m.style.display = 'none');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-root').forEach(m => m.style.display = 'none');
});

// ─────────── Boot ───────────
// Kick the stats bar + Upload sidebar right away so the first paint
// already shows real numbers, not em-dashes.
refreshStatsBar();
refreshUploadSidebar();

// Restore last-viewed tab + selected batch + refresh interval from
// localStorage so a browser reload doesn't lose the user's context.
(function bootRestoreUI() {
  const saved = loadUI();
  if (saved.interval != null) {
    state.dashIntervalMs = saved.interval;
    const iv = $('dashRefreshInterval');
    if (iv) iv.value = String(saved.interval);
  }
  if (saved.batch) {
    state.activeBatch = saved.batch;
    // dashBatchSelect is populated later, but restore analytics batch too
    analytics.batchId = saved.batch;
  }
  if (saved.workerFilter) {
    state.workerFilter = saved.workerFilter;
    const sub = $('activityLogSub');
    if (sub) sub.textContent = `filtered to ${saved.workerFilter}`;
  }
  // Tab restore last — needs to happen AFTER dashBatchSelect exists so
  // dashboard init sees the saved batch.
  if (location.hash === '#dashboard') {
    document.querySelector('.tab[data-tab="dashboard"]').click();
  } else if (saved.tab && document.querySelector(`.tab[data-tab="${saved.tab}"]`)) {
    document.querySelector(`.tab[data-tab="${saved.tab}"]`).click();
  }
})();
