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
    if (btn.dataset.tab === 'config') { loadConfigForm(); refreshOrphanCount(); }
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
    const [summary, workers, roster, activity, failed, timeline, errors, kwBatches] = await Promise.all([
      api.jobsSummary(),
      api.jobsWorkerStats(),
      api.workersList().catch(() => ({ workers: [] })),
      api.activityGet(state.activeBatch, 120, state.workerFilter),
      api.failedJobs(state.activeBatch).catch(() => ({ rows: [] })),
      api.keywordsTimeline(state.activeBatch).catch(() => ({ buckets: [] })),
      api.activityErrors(state.activeBatch, 60).catch(() => ({ events: [] })),
      api.keywordsBatches().catch(() => ({ batches: [] })),
    ]);
    state.keywordBatches = kwBatches.batches || [];
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

function populateBatchSelects() {
  // Batches with jobs (from summary).
  const jobsBatchIds = new Set(state.batches.map(b => b.batch_id));
  const jobsOpts = state.batches.map(b => `<option value="${esc(b.batch_id)}">${esc(b.batch_id)} — ${b.total} SKUs</option>`).join('');
  // Batches that ONLY have keyword rows (orphans — jobs got wiped by reset
  // while workers were still pushing results from their local state). Users
  // still need to view/download these, so include them in the picker with
  // a clear label.
  const orphanOpts = (state.keywordBatches || [])
    .filter(b => !jobsBatchIds.has(b.batch_id))
    .map(b => `<option value="${esc(b.batch_id)}">${esc(b.batch_id)} — ${b.row_count} kw (orphan)</option>`)
    .join('');
  const allOpts = jobsOpts + orphanOpts;
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
  const stageFor = (act) => {
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
      const stage = stageFor(w._lastActivity);
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
  el.querySelectorAll('.worker-actions button[data-worker]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const workerId = btn.dataset.worker;
      const cmd = btn.dataset.cmd;
      const cmdLabel = { wake: 'Wake', reconnect: 'Force reconnect', pause: 'Pause', release_claims: 'Release claims from', stop: 'Stop' }[cmd] || cmd;
      if (cmd === 'stop' && !confirm(`Stop worker ${workerId} and disarm it? They will not claim more work until you send Wake.`)) return;
      try { await api.commandsSend(workerId, cmd); toast(`${cmdLabel} → ${workerId}`, 'ok'); }
      catch (e) { toast(e.message, 'err', { title: 'Command failed' }); }
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
  sortKey: 'ad_rating',
  sortDir: 'desc',
};

async function refreshAnalyticsTab() {
  // Populate batch dropdown from current summary + orphan keyword batches.
  try {
    const [s, kwB] = await Promise.all([
      api.jobsSummary(),
      api.keywordsBatches().catch(() => ({ batches: [] })),
    ]);
    state.batches = s.batches || [];
    state.keywordBatches = kwB.batches || [];
    populateBatchSelects();
    if (analytics.batchId && $('anBatchSelect')) $('anBatchSelect').value = analytics.batchId;
    // Auto-select: if there's exactly one batch and none is chosen yet,
    // pick it. Removes the confusing "Waiting for input" empty state
    // when there's only one obvious batch to look at.
    if (!analytics.batchId && state.batches.length === 1) {
      analytics.batchId = state.batches[0].batch_id;
      if ($('anBatchSelect')) $('anBatchSelect').value = analytics.batchId;
    }
  } catch {}
  if (analytics.batchId) await loadAnalyticsBatch(analytics.batchId);
}
$('anBatchSelect').addEventListener('change', async () => {
  analytics.batchId = $('anBatchSelect').value;
  analytics.sku = '';
  await loadAnalyticsBatch(analytics.batchId);
});
$('anSkuSelect').addEventListener('change', () => {
  analytics.sku = $('anSkuSelect').value;
  filterAndRenderAnalytics();
});
['anSearch', 'anSource', 'anIntent', 'anMinRating', 'anOnlyImgMatches'].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(id === 'anSearch' ? 'input' : 'change', filterAndRenderAnalytics);
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

  // Sort — always by current key.
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
  renderAnalyticsSummary(source);
  renderAnalyticsTopChart(source);
  renderAnalyticsTable(filtered);

  $('anTableCard').style.display = source.length > 0 ? '' : 'none';
  $('anTopChartCard').style.display = source.length > 0 ? '' : 'none';
  $('anExportBtn').disabled = filtered.length === 0;
}

function renderAnalyticsSummary(rows) {
  const el = $('anSummary');
  if (rows.length === 0) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📭</div>${analytics.sku ? 'No keywords for this SKU yet.' : 'No keywords in this batch yet.'}</div>`;
    return;
  }
  const withImg = rows.filter(r => (r.image_count || 0) > 0).length;
  const totalImg = rows.reduce((s, r) => s + (r.image_count || 0), 0);
  const avgRating = rows.reduce((s, r) => s + (r.ad_rating || 0), 0) / rows.length;
  const bySrc = {}; for (const r of rows) { const k = String(r.source || '—'); bySrc[k] = (bySrc[k] || 0) + 1; }
  const byIntent = {}; for (const r of rows) { const k = String(r.buying_intent || '—'); byIntent[k] = (byIntent[k] || 0) + 1; }
  const totalKp = rows.filter(r => (r.kp_monthly_searches || 0) > 0).length;

  // Sources chip row. Each source gets its own color so users can skim
  // the mix at a glance (KP blue, autosuggest amber, SERP teal, etc.).
  const srcClassFor = (k) => {
    const s = String(k).toLowerCase();
    if (s.includes('kp')) return 'src-kp';
    if (s.includes('autosuggest')) return 'src-autosuggest';
    if (s.includes('serp')) return 'src-serp';
    if (s.includes('paa')) return 'src-paa';
    if (s.includes('related')) return 'src-related';
    if (s.includes('amazon')) return 'src-amazon';
    return 'pending';
  };
  const srcChips = Object.entries(bySrc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) =>
    `<span class="chip ${srcClassFor(k)}"><strong>${esc(k)}</strong>: ${v}</span>`
  ).join(' ');
  const intentChips = Object.entries(byIntent).filter(([k]) => k && k !== '—').sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const cls = k === 'high' ? 'done' : k === 'medium' ? 'claimed' : k === 'low' ? 'pending' : 'pending';
    return `<span class="chip ${cls}"><strong>${esc(k)}</strong>: ${v}</span>`;
  }).join(' ');

  el.innerHTML = `
    <div class="tiles">
      <div class="tile success"><div class="lbl">Keywords</div><div class="val">${rows.length.toLocaleString()}</div></div>
      <div class="tile info"><div class="lbl">With image matches</div><div class="val">${withImg}</div></div>
      <div class="tile"><div class="lbl">Total img hits</div><div class="val">${totalImg.toLocaleString()}</div></div>
      <div class="tile"><div class="lbl">Avg AdRating</div><div class="val">${avgRating.toFixed(1)}</div></div>
      <div class="tile"><div class="lbl">KP-metric rows</div><div class="val">${totalKp}</div></div>
    </div>
    <div class="card" style="margin-top: -4px;">
      <div class="card-body" style="padding: 10px 14px;">
        <div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">Sources</div>
        <div class="row tight" style="margin-bottom: 8px;">${srcChips || '<span class="hint">—</span>'}</div>
        ${intentChips ? `<div style="font-size:11px; color:var(--text-2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">Buying intent</div>
        <div class="row tight">${intentChips}</div>` : ''}
      </div>
    </div>
  `;
}

function renderAnalyticsTopChart(rows) {
  const el = $('anTopChart');
  if (rows.length === 0) { el.innerHTML = ''; return; }
  const top = [...rows]
    .filter(r => (r.ad_rating || 0) > 0)
    .sort((a, b) => (b.ad_rating || 0) - (a.ad_rating || 0))
    .slice(0, 10);
  $('anTopChartSub').textContent = `top ${top.length}`;
  if (top.length === 0) { el.innerHTML = `<div class="hint">No keywords have an AdRating yet.</div>`; return; }
  const maxV = Math.max(...top.map(r => r.ad_rating || 0), 1);
  el.innerHTML = top.map(r => {
    const kw = esc(r.keyword || '—');
    const rating = r.ad_rating || 0;
    const pct = Math.round((rating / maxV) * 100);
    const img = r.image_count || 0;
    return `
      <div style="display:grid; grid-template-columns: 220px 1fr 60px 60px; gap: 8px; align-items:center; padding: 4px 0; border-bottom: 1px solid var(--line-1); font-size: 12px;">
        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${kw}">${kw}</div>
        <div style="background: var(--bg-input); border-radius: 4px; height: 14px; overflow: hidden; position: relative;">
          <div style="background: linear-gradient(90deg, var(--accent) 0%, var(--info) 100%); height: 100%; width: ${pct}%; transition: width 200ms;"></div>
        </div>
        <div style="text-align:right; font-family: var(--mono); color: var(--accent);">${rating.toFixed(1)}</div>
        <div style="text-align:right; font-family: var(--mono); color: ${img > 0 ? 'var(--success)' : 'var(--text-3)'};">${img > 0 ? `📷 ${img}` : '—'}</div>
      </div>
    `;
  }).join('');
}

function renderAnalyticsTable(rows) {
  const el = $('anTable');
  $('anTableCount').textContent = `${rows.length.toLocaleString()} row(s)`;
  if (rows.length === 0) {
    el.innerHTML = `<tr><td style="padding:16px; text-align:center; color:var(--text-3);">No keywords match the current filters.</td></tr>`;
    return;
  }
  const cols = [
    { key: 'keyword', label: 'Keyword', kind: 'text' },
    { key: 'source', label: 'Source', kind: 'chip' },
    { key: 'buying_intent', label: 'Intent', kind: 'chip' },
    { key: 'kp_monthly_searches', label: 'Volume', kind: 'num' },
    { key: 'kp_competition', label: 'Comp', kind: 'text' },
    { key: 'image_count', label: 'Imgs', kind: 'imgs' },
    { key: 'ad_rating', label: 'AdRating', kind: 'rating' },
    { key: 'match_confidence_max', label: 'MaxConf', kind: 'num' },
    { key: 'total_sellers', label: 'Sellers', kind: 'num' },
  ];
  const thead = `<thead><tr>${cols.map(c => `
    <th data-sort-key="${c.key}" style="cursor:pointer;" title="Click to sort">
      ${esc(c.label)}${analytics.sortKey === c.key ? (analytics.sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.slice(0, 500).map(r => `
    <tr>${cols.map(c => {
      const v = r[c.key];
      if (c.kind === 'chip' && v) {
        // Source column uses source-specific colors; intent column uses done/claimed/pending.
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
        } else {
          cls = String(v) === 'high' ? 'done' : String(v) === 'medium' ? 'claimed' : 'pending';
        }
        return `<td><span class="chip ${cls}">${esc(v)}</span></td>`;
      }
      if (c.kind === 'imgs') return `<td class="num" style="color:${(v||0) > 0 ? 'var(--success)' : 'var(--text-3)'};">${v || 0}</td>`;
      if (c.kind === 'rating') return `<td class="num" style="color:${(v||0) >= 7 ? 'var(--success)' : (v||0) >= 4 ? 'var(--warn)' : 'var(--text-3)'};">${v != null ? Number(v).toFixed(1) : '—'}</td>`;
      if (c.kind === 'num') return `<td class="num">${v != null ? Number(v).toLocaleString() : '—'}</td>`;
      return `<td style="max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(v)}">${esc(v == null ? '—' : v)}</td>`;
    }).join('')}</tr>
  `).join('')}${rows.length > 500 ? `<tr><td colspan="${cols.length}" style="text-align:center; color:var(--text-3);">…and ${rows.length - 500} more — narrow the filters to see them.</td></tr>` : ''}</tbody>`;
  el.innerHTML = thead + tbody;
  // Wire header click → sort toggle.
  el.querySelectorAll('th[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sortKey;
      if (analytics.sortKey === k) analytics.sortDir = analytics.sortDir === 'desc' ? 'asc' : 'desc';
      else { analytics.sortKey = k; analytics.sortDir = 'desc'; }
      filterAndRenderAnalytics();
    });
  });
}

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
