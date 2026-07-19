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
  liveTimer: null,        // fast-refresh (3s) for Activity + Output panels
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
// Shared clipboard write with HTTP fallback. navigator.clipboard is
// undefined in non-secure contexts (this manager runs on http://tailnet-
// IP:8787, not https), so relying on it silently broke every "Copy"
// button on the LAN. Falls back to a hidden-textarea + execCommand copy
// which works on HTTP. Returns true on success.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed; left:-9999px; top:0; opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

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
    { icon: '📢', label: 'Wake all workers',     meta: 'broadcast', action: async () => { try { await api.commandsSend(null, 'wake');   toast('Wake queued — workers act within 30s (poll cadence)', 'ok', { title: 'Wake all' }); } catch (e) { toast(e.message, 'err'); } } },
    { icon: '▶',  label: 'Resume all workers',    meta: 'broadcast', action: async () => { try { await api.commandsSend(null, 'resume'); toast('Resume queued — workers act within 30s (poll cadence)', 'ok', { title: 'Resume all' }); } catch (e) { toast(e.message, 'err'); } } },
    { icon: '⏸', label: 'Pause all workers',    meta: 'broadcast', action: async () => { try { await api.commandsSend(null, 'pause');  toast('Pause queued — workers finish current SKU then halt (≤30s poll + rest of SKU)', 'ok', { title: 'Pause all' }); } catch (e) { toast(e.message, 'err'); } } },
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
// State is persisted per-card-id under adbrainCollapsedCards so a
// user's "hide the noisy Content plan card" preference survives reloads.
const _COLLAPSED_KEY = 'adbrainCollapsedCards';
function _loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(_COLLAPSED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _saveCollapsed(set) {
  try { localStorage.setItem(_COLLAPSED_KEY, JSON.stringify(Array.from(set))); } catch {}
}
document.addEventListener('click', (e) => {
  const head = e.target.closest('.card.collapsible .card-head');
  if (head && !e.target.closest('button, input, select, a')) {
    const card = head.parentElement;
    card.classList.toggle('collapsed');
    // Persist by the nearest [id] ancestor (usually the card wrapper).
    const idHost = card.id ? card : card.closest('[id]');
    if (idHost?.id) {
      const set = _loadCollapsed();
      if (card.classList.contains('collapsed')) set.add(idHost.id);
      else set.delete(idHost.id);
      _saveCollapsed(set);
    }
  }
});
// Apply persisted collapsed state on page load — restore what the user
// left hidden last time they viewed this page.
document.addEventListener('DOMContentLoaded', () => {
  const set = _loadCollapsed();
  for (const id of set) {
    const el = document.getElementById(id);
    if (!el) continue;
    const card = el.classList?.contains('card') ? el : el.querySelector('.card.collapsible');
    if (card) card.classList.add('collapsed');
  }
});

// ─────────── Boot banner ───────────
// Logged to the console so users can verify which build is actually
// running when they refresh — 'my changes aren't showing' is almost
// always a cached JS problem. Bumped whenever wiring changes.
console.info('[adbrain] manager UI build 2026-07-18c (tabs + upload-mode + cache-warn)');
// Clear the stale-cache banner if it was shown (inline script pre-set it).
const _staleBanner = document.getElementById('globalErrorBanner');
if (_staleBanner && _staleBanner.textContent.includes('STALE CACHE')) {
  _staleBanner.style.display = 'none';
  _staleBanner.textContent = '';
}

// ─────────── Tabs ───────────
// Belt-and-suspenders: event delegation on the <nav.tabs> container so
// a per-button forEach race can't break tab switching. Any click that
// bubbles up from a .tab button hits the same handler.
function _switchTab(btn) {
  if (!btn || !btn.dataset.tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  const panel = $(`panel-${btn.dataset.tab}`);
  if (panel) panel.classList.add('active');
  try { saveUI({ tab: btn.dataset.tab }); } catch {}
  try {
    if (btn.dataset.tab === 'dashboard') startDashPolling();
    else stopDashPolling();
    if (btn.dataset.tab === 'upload') refreshUploadSidebar();
    if (btn.dataset.tab === 'analytics') refreshAnalyticsTab();
    if (btn.dataset.tab !== 'analytics') stopAnalyticsPolling();
    if (btn.dataset.tab === 'config') { loadConfigForm(); refreshOrphanCount(); refreshBackupsList(); refreshQuiesceStatus(); }
    if (btn.dataset.tab === 'workers') refreshWorkersTab();
    if (btn.dataset.tab === 'downloads') refreshDownloadsTab();
  } catch (e) {
    // A refresh function throwing MUST NOT prevent the tab from switching.
    // The visual .active swap already happened; just log the failure so
    // the tab is still usable.
    console.warn('[adbrain] tab refresh threw', e);
  }
}
document.querySelector('.tabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) _switchTab(btn);
});
// Also expose on window so a URL like #tab=analytics could route.
window.adbrainSwitchTab = (tabName) => {
  const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (btn) _switchTab(btn);
};
// Legacy per-button binding — same handler, doubled up. Safer than
// removing since existing code (cmdk, banner links) still calls .click().
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => _switchTab(btn));
});

// ─────────── Token + health ───────────
// Populate from localStorage on load. Also auto-save on blur / Enter /
// paste so a refresh never loses the token. The Save-token button
// remains for users who prefer the explicit click; both paths call
// the same setToken() -> healthPing() flow.
function _persistTokenFromInput({ silent = false } = {}) {
  const v = ($('tokenInput')?.value || '').trim();
  const prev = getToken();
  if (v === prev) return;
  setToken(v);
  healthPing();
  if (!silent) {
    // Green flash on the Save button so users see the auto-save fired.
    const btn = $('saveTokenBtn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Saved';
      btn.style.borderColor = 'var(--success)';
      btn.style.color = 'var(--success)';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 1200);
    }
  }
}
// Beat any password-manager autofill: read localStorage twice — once
// synchronously on script parse, once after a microtask so any autofill
// that ran BEFORE our handler is overwritten with the persisted value.
$('tokenInput').value = getToken();
Promise.resolve().then(() => {
  const stored = getToken();
  if (stored && !$('tokenInput').value) $('tokenInput').value = stored;
});
$('saveTokenBtn').addEventListener('click', () => _persistTokenFromInput({ silent: false }));
$('tokenInput').addEventListener('blur',  () => _persistTokenFromInput({ silent: false }));
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _persistTokenFromInput({ silent: false }); } });
$('tokenInput').addEventListener('paste', () => setTimeout(() => _persistTokenFromInput({ silent: false }), 20));
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
// Detect whether a File is a plain-text SKU list rather than Excel/CSV.
// Extension-based first (fast), MIME as fallback. .csv is ambiguous —
// treat it as Excel/CSV since that's the historical path (users who
// want SKU-list.csv still get the smart re-route on the SKU dropzone
// side, and the SKU parser strips commas).
function _looksLikeSkuTxtFile(f) {
  if (!f) return false;
  const n = String(f.name || '').toLowerCase();
  if (n.endsWith('.txt')) return true;
  if ((f.type || '').startsWith('text/plain')) return true;
  return false;
}
// Auto-switch to SKU-list mode and load a File into the textarea.
// Used by BOTH the Excel dropzone (smart auto-switch when a .txt lands)
// and any global drops on the Upload panel.
function _autoSwitchToSkuMode(file) {
  _switchUploadMode('sku');
  if (file) _acceptSkuFile(file);
  toast('Detected a .txt file — switched to SKU-list mode.', 'ok', { title: 'Auto-mode' });
}
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
    if (!f) return;
    // .txt on the Excel dropzone → auto-switch to SKU mode instead of
    // failing silently. Users don't know they need to click the tab first.
    if (_looksLikeSkuTxtFile(f)) { _autoSwitchToSkuMode(f); return; }
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event('change'));
  });
  // File-picker path: same detect for consistency.
  input.accept = '.xlsx,.xls,.csv,.txt';
})();
$('uploadFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // .txt via file picker on the Excel input → also auto-switch.
  if (_looksLikeSkuTxtFile(file)) { _autoSwitchToSkuMode(file); e.target.value = ''; return; }
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

// ─────────── Upload mode toggle: Excel/CSV ↔ SKU list ───────────
// Event delegation on the container, not per-button listeners. Robust
// against DOM race / re-render / addEventListener order. Anywhere the
// user clicks inside .upload-mode-toggle, we resolve which button and
// switch modes.
function _switchUploadMode(mode) {
  document.querySelectorAll('.upload-mode-btn').forEach(b => {
    const isActive = b.dataset.mode === mode;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  const fileEl = $('uploadModeFile');
  const skuEl  = $('uploadModeSku');
  if (fileEl) fileEl.style.display = mode === 'file' ? '' : 'none';
  if (skuEl)  skuEl.style.display  = mode === 'sku'  ? '' : 'none';
  const sub = $('uploadModeSub');
  if (sub) sub.textContent = mode === 'file' ? 'Excel · CSV · with URL columns' : 'SKU list — one Dropy-BXXX per line';
  setResult($('uploadResult'), '', 'info');
}
// Expose on window so the inline onclick fallback in index.html works
// even if the module JS is stale-cached or fails to load. Belt to the
// event-delegation suspenders below.
window.adbrainSwitchUploadMode = _switchUploadMode;
document.querySelector('.upload-mode-toggle')?.addEventListener('click', (e) => {
  // Find the clicked mode button — user may hit the emoji, code tag,
  // or the button itself. closest() walks up until it finds it.
  const btn = e.target.closest('.upload-mode-btn');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode) _switchUploadMode(mode);
});
// Keyboard accessibility — Space / Enter on a focused button toggles.
document.querySelector('.upload-mode-toggle')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const btn = e.target.closest('.upload-mode-btn');
  if (!btn) return;
  e.preventDefault();
  const mode = btn.dataset.mode;
  if (mode) _switchUploadMode(mode);
});
// Live count as user pastes/types SKUs — same regex as server-side parser.
function _skuUploadRecount() {
  const raw = $('skuUploadText').value;
  const lines = raw.split(/\r?\n/);
  const valid = lines.filter(l => {
    const s = String(l).trim();
    if (!s || s.startsWith('#')) return false;
    return /^(?:Dropy-)?[A-Z0-9]{10}$/i.test(s);
  }).length;
  const nonBlank = lines.filter(l => l.trim() && !l.trim().startsWith('#')).length;
  const invalid = nonBlank - valid;
  $('skuUploadCount').textContent = `${lines.length} line(s) · ${valid} valid SKU(s)` + (invalid ? ` · ${invalid} bad format` : '');
  // Preview button always enabled if there's ANY input; import button
  // wired by preview result.
}
$('skuUploadText')?.addEventListener('input', _skuUploadRecount);
// Warn hard when Amazon resolve mode is picked — Amazon URLs fail
// both the image-scrape (captcha) and KP seed (rejected). Users need
// dropy.in URLs, which come from Shopify resolve mode.
function _updateSkuResolveWarn() {
  const sel = $('skuUploadResolve');
  const warn = $('skuResolveWarn');
  if (!sel || !warn) return;
  warn.style.display = sel.value === 'amazon' ? '' : 'none';
}
$('skuUploadResolve')?.addEventListener('change', _updateSkuResolveWarn);
// Smart-default: when Shopify creds are configured, default to shopify.
// Fires once on module load.
(async () => {
  const sel = $('skuUploadResolve');
  if (!sel) return;
  try {
    const cfg = await api.configGet();
    const shop = cfg.config?.shopify || {};
    if (shop.shopDomain && shop.adminToken) {
      sel.value = 'shopify';
    } else {
      // No Shopify creds — try 'both' so if user later configures Shopify
      // they get resolution; today falls back to Amazon.
      sel.value = 'both';
    }
    _updateSkuResolveWarn();
  } catch {}
})();
// Textarea can also accept a .txt file drop directly.
function _acceptSkuFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('skuUploadText').value = String(reader.result || '');
    _skuUploadRecount();
    toast(`Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'ok');
  };
  reader.onerror = () => toast(`Failed to read ${file.name}`, 'err');
  reader.readAsText(file);
}
// Reverse smart-detect: if someone drops an .xlsx/.xls on the SKU
// dropzone, auto-switch to Excel/CSV mode + load. Prevents binary
// garbage from ending up in the SKU textarea.
function _autoSwitchToFileMode(file) {
  _switchUploadMode('file');
  if (file) {
    const excelInput = $('uploadFile');
    if (excelInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      excelInput.files = dt.files;
      excelInput.dispatchEvent(new Event('change'));
    }
  }
  toast(`Detected a spreadsheet — switched to Excel/CSV mode.`, 'ok', { title: 'Auto-mode' });
}
function _looksLikeExcelFile(f) {
  if (!f) return false;
  const n = String(f.name || '').toLowerCase();
  return n.endsWith('.xlsx') || n.endsWith('.xls');
}
$('skuUploadFile')?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (_looksLikeExcelFile(f)) { _autoSwitchToFileMode(f); e.target.value = ''; return; }
  _acceptSkuFile(f);
});
// SKU drop zone: also handle Excel drops smart.
(function wireSkuDropZone() {
  const zone = $('skuDropZone');
  const input = $('skuUploadFile');
  if (!zone || !input) return;
  zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('hover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('hover');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (_looksLikeExcelFile(f)) { _autoSwitchToFileMode(f); return; }
    _acceptSkuFile(f);
  });
})();
// Drag-drop on the textarea itself (in addition to the drop-zone box).
const _skuTextEl = $('skuUploadText');
if (_skuTextEl) {
  ['dragover', 'dragleave', 'drop'].forEach(ev => {
    _skuTextEl.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
  });
  _skuTextEl.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (_looksLikeExcelFile(f)) { _autoSwitchToFileMode(f); return; }
    _acceptSkuFile(f);
  });
}
// Preview button — hits upload-by-sku with dryRun=true.
$('skuPreviewBtn')?.addEventListener('click', async () => {
  const raw = $('skuUploadText').value;
  const skus = raw.split(/\r?\n/);
  const resolve = $('skuUploadResolve').value;
  const batchId = $('uploadBatchId').value.trim() || String(Date.now());
  const box = $('skuUploadPreview');
  const btn = $('skuUploadBtn');
  btn.disabled = true;
  box.innerHTML = '<div class="hint">Resolving…</div>';
  try {
    const r = await api.jobsUploadBySku(batchId, skus, resolve, true);
    const rows = (r.preview || []).slice(0, 40);
    // Preview table now shows the enriched Shopify metadata (title,
    // handles, brand) so users can see what the engine will use for
    // seed derivation + brand-domain confirmation — same info an
    // Excel/CSV upload would carry.
    const rowsHtml = rows.map(x => `
      <tr>
        <td class="mono" style="font-size:11px;">${esc(x.sku)}</td>
        <td style="max-width:260px; overflow:hidden; text-overflow:ellipsis;" title="${esc(x.product_name || '')}">${x.product_name ? esc(x.product_name) : '<span style="color:var(--text-3);">—</span>'}</td>
        <td class="mono" style="font-size:10px; color:var(--text-3); max-width:220px; overflow:hidden; text-overflow:ellipsis;" title="${esc(x.handles || '')}">${x.handles ? esc(x.handles.split('|').slice(0, 3).join(' · ')) + (x.handles.split('|').length > 3 ? '…' : '') : '<span>—</span>'}</td>
        <td class="mono" style="font-size:11px;">${x.brands ? esc(x.brands) : '<span style="color:var(--text-3);">—</span>'}</td>
        <td style="max-width:280px; overflow:hidden; text-overflow:ellipsis;">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" style="font-size:11px;">${esc(x.url.replace(/^https?:\/\//, ''))}</a>` : `<span style="color:var(--danger);" title="${esc(x.note || 'unresolved')}">unresolved${x.note ? ` <span style="color:var(--text-3); font-size:10px;">(${esc(x.note.slice(0, 40))}${x.note.length > 40 ? '…' : ''})</span>` : ''}</span>`}</td>
        <td class="mono" style="font-size:10px; color:${x.source === 'shopify' ? 'var(--success)' : x.source === 'amazon' ? 'var(--warn)' : 'var(--danger)'};">${esc(x.source || '—')}</td>
      </tr>`).join('');
    const shopifyMissing = resolve !== 'amazon' && !r.shopifyConfigured;
    box.innerHTML = `
      <div class="banner ${r.resolved > 0 ? 'ok' : 'warn'}" style="margin: var(--space-3) 0;">
        <strong>${r.resolved}</strong> resolved · <strong>${r.unresolved || 0}</strong> unresolved · <strong>${r.badFormat || 0}</strong> bad format
        ${r.badFormat > 0 ? ` · samples: ${(r.badFormatSamples || []).slice(0, 3).map(s => `<code>${esc(s)}</code>`).join(' ')}` : ''}
        ${shopifyMissing ? `
        <div style="margin-top: 10px; padding: 10px 12px; background: var(--danger-soft); border: 1px solid var(--danger); border-radius: var(--radius-sm);">
          <div style="color: var(--danger); font-weight: 700; margin-bottom: 6px;">⚠ Shopify not configured — that's why all ${r.unresolved} resolved to "unresolved"</div>
          <div class="hint">Shopify credentials are needed so the manager can look up each SKU's real dropy.in URL + title + tags + vendor. Two clicks to fix:</div>
          <div class="row" style="margin-top: 8px; gap: 8px;">
            <button id="skuGotoShopify" style="background: var(--accent); color: #0a0a15; font-weight: 700;">⚙ Configure Shopify now →</button>
            <button class="secondary" id="skuUseAmazon">Use Amazon.in instead (workers may fail)</button>
          </div>
        </div>` : ''}
        <div class="hint" style="margin-top: 6px;">When resolved via Shopify: <strong>title</strong>, <strong>handles</strong> (URL slug + tags + product type), and <strong>brand</strong> (vendor) auto-fill from your dropy.in listing — same columns Excel/CSV uploads carry.</div>
      </div>
      <div class="tbl-wrap" style="max-height: 340px; overflow-y: auto;">
        <table class="tbl compact">
          <thead><tr><th>SKU</th><th>Title</th><th>Handles</th><th>Brand</th><th>Resolved URL</th><th>Source</th></tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-3);">nothing to preview</td></tr>'}</tbody>
        </table>
        ${(r.preview?.length || 0) > 40 ? `<div class="hint" style="padding: 6px 0;">…and ${r.preview.length - 40} more.</div>` : ''}
      </div>`;
    btn.disabled = r.resolved === 0;
    btn.textContent = r.resolved > 0 ? `Import → queue (${r.resolved} SKU${r.resolved === 1 ? '' : 's'})` : 'Import → queue';
    // Wire the two rescue buttons in the 'Shopify not configured' box.
    box.querySelector('#skuGotoShopify')?.addEventListener('click', () => {
      // Jump straight to Config → Shopify integration + pre-fill dropy.in
      // as the default domain if the field is empty.
      _switchTab(document.querySelector('.tab[data-tab="config"]'));
      setTimeout(() => {
        const domain = $('cfgShopifyDomain');
        if (domain) {
          if (!domain.value) domain.value = 'dropy.in';
          // Expand the collapsible Shopify card if collapsed, then focus.
          domain.closest('.card')?.classList.remove('collapsed');
          domain.scrollIntoView({ behavior: 'smooth', block: 'center' });
          domain.focus();
          domain.select();
        }
      }, 200);
    });
    box.querySelector('#skuUseAmazon')?.addEventListener('click', () => {
      const sel = $('skuUploadResolve');
      if (sel) { sel.value = 'amazon'; _updateSkuResolveWarn?.(); }
      // Re-run the preview automatically so the user sees results immediately.
      $('skuPreviewBtn')?.click();
    });
  } catch (e) {
    box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
  }
});
$('skuClearBtn')?.addEventListener('click', () => {
  $('skuUploadText').value = '';
  $('skuUploadPreview').innerHTML = '';
  $('skuUploadBtn').disabled = true;
  $('skuUploadBtn').textContent = 'Import → queue';
  _skuUploadRecount();
  setResult($('uploadResult'), '', 'info');
});
$('skuUploadBtn')?.addEventListener('click', async () => {
  const raw = $('skuUploadText').value;
  const skus = raw.split(/\r?\n/);
  const resolve = $('skuUploadResolve').value;
  const batchId = $('uploadBatchId').value.trim() || String(Date.now());
  const btn = $('skuUploadBtn');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Importing…';
  setResult($('uploadResult'), 'Importing…', 'info');
  try {
    const r = await api.jobsUploadBySku(batchId, skus, resolve, false);
    const parts = [`${r.inserted} product page(s) added to batch ${batchId}`];
    if (r.linkedToExisting) parts.push(`${r.linkedToExisting} extra SKU(s) linked to same page (variants)`);
    if (r.skippedActive) parts.push(`${r.skippedActive} skipped (already in another batch)`);
    if (r.unresolved) parts.push(`${r.unresolved} unresolved`);
    if (r.badFormat) parts.push(`${r.badFormat} bad format`);
    const msg = parts.join(' · ');
    // If many SKUs got linked, explain WHY inline. Users need to see
    // that 25 SKUs → 1 job is NORMAL for a variant-heavy store — every
    // SKU is preserved on that single row's sku column.
    const heavyLink = r.linkedToExisting >= 5;
    if (heavyLink) {
      $('uploadResult').innerHTML = `<div class="banner warn" style="margin-top:10px;">
        ⚠ ${esc(msg)}
        <div style="margin-top: 6px; font-size: 12px;">Your Shopify store maps multiple SKUs to the same product page (variants). The engine scrapes each <strong>product page once</strong> — that's ${r.inserted} scrape job(s) covering all ${r.inserted + r.linkedToExisting} SKUs you provided. Every SKU is preserved on the job row's <code>sku</code> column (comma-separated), so downloaded CSVs + downstream Shopify updates still see them individually. Keyword data + rankings apply to <em>all variants</em> under each page.</div>
      </div>`;
    } else {
      setResult($('uploadResult'), '✓ ' + msg, 'ok');
    }
    toast(msg, heavyLink ? 'warn' : 'ok', { title: 'SKUs imported' });
    refreshStatsBar();
    refreshUploadSidebar();
    // Keep the batch ID visible; clear the textarea so a follow-up
    // paste doesn't accidentally include the same SKUs.
    $('skuUploadText').value = '';
    $('skuUploadPreview').innerHTML = '';
    _skuUploadRecount();
  } catch (e) {
    setResult($('uploadResult'), `Import failed: ${e.message}`, 'err');
    toast(e.message, 'err', { title: 'Import failed' });
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});

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

// Clear buttons on Activity log + Errors card. Activity clear respects
// the current worker filter (only clears rows for the filtered worker),
// so users can scope-clear without wiping everyone.
$('activityClearBtn')?.addEventListener('click', async () => {
  const scoped = state.workerFilter ? ` for worker ${state.workerFilter}` : '';
  if (!confirm(`Clear activity log${scoped}? This cannot be undone (but new events will start populating immediately as workers continue).`)) return;
  try {
    const filters = state.activeBatch ? { batchId: state.activeBatch } : {};
    if (state.workerFilter) filters.workerId = state.workerFilter;
    const r = await api.activityClear(filters);
    toast(`Cleared ${r.deleted.toLocaleString()} activity row(s)${scoped}.`, 'ok', { title: '🗑 Log cleared' });
    refreshDashboard();
  } catch (e) { toast(e.message, 'err', { title: 'Clear failed' }); }
});
$('errorsClearBtn')?.addEventListener('click', async () => {
  if (!confirm('Clear all error-level events? Info + warn events are kept.')) return;
  try {
    const filters = { level: 'err' };
    if (state.activeBatch) filters.batchId = state.activeBatch;
    const r = await api.activityClear(filters);
    toast(`Cleared ${r.deleted.toLocaleString()} error event(s).`, 'ok', { title: '🗑 Errors cleared' });
    refreshDashboard();
  } catch (e) { toast(e.message, 'err', { title: 'Clear failed' }); }
});
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
  // Manager commands are POLLED by workers every 30s. If a worker's SW
  // is dead (Chrome closed, PC asleep, extension crashed), Wake alone
  // never reaches it. This handler now escalates:
  //   1. Broadcast Wake to every worker (reaches all live SWs).
  //   2. For each worker that's been OFFLINE (heartbeat > 5 min),
  //      auto-send Wake-on-LAN to its NIC via the manager. Requires
  //      MAC captured (installer bakes it into worker-config.json;
  //      also settable via the fleet grid) + manager on same LAN as
  //      the worker + WoL enabled in the worker PC's BIOS.
  //   3. Show a summary toast: X wake commands sent, Y WoL packets
  //      dispatched, Z workers unreachable (no MAC + offline).
  if (!confirm('Send Wake to every worker?\n\nBroadcasts the Wake command to all live workers. Also auto-sends Wake-on-LAN packets to any offline worker whose MAC is registered — this is the only way to reach a PC whose Chrome is closed.')) return;
  const now = Date.now();
  const offline = (state.workers || []).filter(w => {
    const hb = Number(w.last_heartbeat || 0);
    return !hb || (now - hb) > 5 * 60 * 1000;
  });
  const summary = { wake: 0, wol: 0, noMac: [] };
  try {
    await api.commandsSend(null, 'wake');
    summary.wake = (state.workers || []).length;
  } catch (e) { toast(`Wake broadcast failed: ${e.message}`, 'err'); return; }
  for (const w of offline) {
    try {
      const r = await api.wakeOnLan(w.worker_id);
      if (r?.ok && r.sent) summary.wol++;
      else summary.noMac.push(w.worker_id);
    } catch { summary.noMac.push(w.worker_id); }
  }
  const parts = [`Wake broadcast: ${summary.wake} worker(s)`];
  if (summary.wol > 0) parts.push(`WoL packets: ${summary.wol}`);
  if (summary.noMac.length > 0) parts.push(`Unreachable (no MAC): ${summary.noMac.join(', ')}`);
  toast(parts.join(' · '), summary.noMac.length > 0 ? 'warn' : 'ok', {
    title: 'Wake sent',
    body: summary.noMac.length > 0
      ? `${summary.noMac.length} worker(s) can't be reached remotely — no MAC on file. Set a MAC (click 🔌 on their row) or start Chrome physically on that PC.`
      : undefined,
  });
  refreshDashboard();
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
  // Live-loop for the two panels that matter most while the worker is
  // producing keywords — Activity log + Output uploaded to manager.
  // Runs independently at 3s, so the manager reflects new events within
  // one worker flush cycle (also 3s after my SW-side patch), instead of
  // the full-dashboard 10s cadence which fires 6+ API calls.
  refreshLivePanels();
  state.liveTimer = setInterval(refreshLivePanels, 3000);
}
function stopDashPolling() {
  if (state.dashTimer) { clearInterval(state.dashTimer); state.dashTimer = null; }
  if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
}

// Live refresh — 2 API calls only. Cheap enough for 3s cadence. Silently
// swallows errors (health pill on the top bar surfaces persistent trouble).
let _liveInflight = false;
async function refreshLivePanels() {
  if (_liveInflight) return; // skip if previous tick still running
  _liveInflight = true;
  try {
    const activity = await api.activityGet(state.activeBatch, 120, state.workerFilter).catch(() => null);
    if (activity) renderActivity(activity.events || []);
    if (state.activeBatch) {
      const stats = await fetchBatchKeywordStats(state.activeBatch).catch(() => null);
      if (stats) renderOutputStats(stats);
    } else {
      renderOutputStats(null); // shows the "Pick a batch above" prompt
    }
    // Pulse the LIVE dot so the user can SEE the panel just refreshed.
    // If someone unplugs the manager, the dots stop pulsing — instant tell.
    const pulse = (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    };
    pulse('activityLiveDot');
    pulse('outputLiveDot');
  } finally { _liveInflight = false; }
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
    // Lookup roster info (mac_address, hostname) so both jobs-derived and
    // roster-only workers carry those fields — the recovery-guide dialog
    // and the WoL button both read w.mac_address.
    const rosterByWid = new Map((roster.workers || []).map(w => [w.worker_id, w]));
    for (const w of (workers.workers || [])) {
      const r = rosterByWid.get(w.worker_id);
      if (r) { w.mac_address = r.mac_address; w.hostname = r.hostname; }
    }
    const idleFromRoster = (roster.workers || []).filter(w => !jobsWorkerIds.has(w.worker_id))
      .map(w => ({
        worker_id: w.worker_id,
        batch_id: null,
        total_touched: 0, done_count: 0, failed_count: 0, in_flight: 0,
        done: 0, failed: 0,
        last_heartbeat: w.last_seen,
        mac_address: w.mac_address, hostname: w.hostname,
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
    // Auto-clear the activity-log worker filter if the filtered worker
    // is stale/gone. Symptom (user reported): filter left set to a
    // dead worker ID (e.g. PC-568BF8) after that PC's Chrome regenerated
    // its worker ID → activity log shows 'No activity yet' even though
    // new events are streaming under a fresh ID. Clear the filter after
    // 4 min of no heartbeat so the log unblocks itself.
    if (state.workerFilter) {
      const w = state.workers.find(x => x.worker_id === state.workerFilter);
      const hb = Number(w?.last_heartbeat || 0);
      const stale = !w || !hb || (Date.now() - hb > 4 * 60 * 1000);
      if (stale) {
        toast(`Activity-log filter '${state.workerFilter}' is stale — showing all workers.`, 'warn', { title: 'Filter auto-cleared' });
        state.workerFilter = '';
        saveUI({ workerFilter: '' });
        const sel = $('activityWorkerFilter'); if (sel) sel.value = '';
        const sub = $('activityLogSub'); if (sub) sub.textContent = 'latest 120 events';
      }
    }
    // Enrich each worker with their most recent activity line so the
    // fleet grid can show 'what step is this worker on right now'.
    // Uses the whole-log fetch (activity.events) rather than a separate
    // per-worker call — cheap because it's one API call already made.
    const lastByWorker = new Map();
    const lastEngineByWorker = new Map();
    for (const ev of (activity.events || [])) {
      if (!ev.worker_id) continue;
      if (!lastByWorker.has(ev.worker_id)) lastByWorker.set(ev.worker_id, ev);
      // Also track the last ENGINE event (source != 'cmd') so the
      // frozen-detector can spot workers whose SW is still polling
      // for commands but whose engine loop hasn't produced anything.
      if (ev.source !== 'cmd' && !lastEngineByWorker.has(ev.worker_id)) {
        lastEngineByWorker.set(ev.worker_id, ev);
      }
    }
    for (const w of state.workers) {
      w._lastActivity = lastByWorker.get(w.worker_id) || null;
      w._lastEngineActivity = lastEngineByWorker.get(w.worker_id) || null;
    }
    // Emit toast notifications for passive events (SKU done, batch
    // complete, worker offline, etc.) that happened since the last
    // refresh. Skipped on the very first refresh so we don't blast the
    // user with "welcome, here are 47 things that already happened".
    detectAndToastEvents(state.batches, state.workers, activity.events || []);
    renderDashHero(timeline);
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
  // Auto-pick the active batch for the Dashboard tab so the Output +
  // Activity panels don't sit forever on "Batch has no SKUs yet" just
  // because the user never touched the dropdown. Priority:
  //   1. Existing selection wins.
  //   2. Manager's pinned active_batch_id (if it still has jobs).
  //   3. Only one batch exists → use it.
  //   4. Newest batch with pending / claimed / in-flight work.
  const dashSel = $('dashBatchSelect');
  if (dashSel && !dashSel.value) {
    const opts = Array.from(dashSel.options).filter(o => o.value);
    let pick = '';
    const pinned = (state.activeBatchPinned || '').trim();
    if (pinned && opts.some(o => o.value === pinned)) pick = pinned;
    else if (opts.length === 1) pick = opts[0].value;
    else {
      const withWork = state.batches.filter(b => (b.pending || 0) + (b.claimed || 0) > 0)
        .sort((a, b) => String(b.batch_id).localeCompare(String(a.batch_id)));
      if (withWork[0]) pick = withWork[0].batch_id;
    }
    if (pick) {
      dashSel.value = pick;
      state.activeBatch = pick;
      saveUI({ batch: pick });
      // Kick the live refresh immediately so the two panels populate
      // without waiting for the next 3s tick.
      refreshLivePanels();
    }
  }
  for (const id of ['pinBatchSelect', 'deleteBatchSelect']) {
    const el = $(id);
    if (!el) continue;
    const cur = el.value;
    el.innerHTML = `<option value="">— none —</option>${jobsOpts}`;
    if (cur && Array.from(el.options).some(o => o.value === cur)) el.value = cur;
  }
}

// Dashboard hero cards — the 30-second read at the top of the tab. Same
// data as the stats bar but larger, tone-colored, with a trend hint from
// the timeline buckets (comparing today vs yesterday's throughput).
function renderDashHero(timeline) {
  const el = $('dashHero');
  if (!el) return;
  const totals = state.batches.reduce((a, b) => ({
    total:   a.total   + (b.total   || 0),
    done:    a.done    + (b.done    || 0),
    claimed: a.claimed + (b.claimed || 0),
    failed:  a.failed  + (b.failed  || 0),
    pending: a.pending + (b.pending || 0),
  }), { total: 0, done: 0, claimed: 0, failed: 0, pending: 0 });
  const now = Date.now();
  const workersOnline = state.workers.filter(w => w.last_heartbeat && (now - w.last_heartbeat) < 3 * 60 * 1000).length;
  const workersTotal  = state.workers.length;
  const batches = state.batches.length;
  const donePct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
  // Throughput trend: sum of last-6-hour buckets vs the prior 6-hour window.
  const buckets = (timeline && timeline.buckets) || [];
  const last6 = buckets.slice(-6).reduce((s, b) => s + (b.count || 0), 0);
  const prev6 = buckets.slice(-12, -6).reduce((s, b) => s + (b.count || 0), 0);
  const trend = prev6 === 0 ? (last6 > 0 ? '↑' : '·')
              : last6 > prev6 * 1.1 ? '↑'
              : last6 < prev6 * 0.9 ? '↓'
              : '→';
  const trendCls = trend === '↑' ? 'hero-trend-up' : trend === '↓' ? 'hero-trend-down' : 'hero-trend-flat';
  const last24h = buckets.reduce((s, b) => s + (b.count || 0), 0);
  const workerDot = workersOnline > 0 ? '<span class="pulse-dot"></span>'
                  : workersTotal > 0  ? '<span class="pulse-dot idle"></span>'
                  : '<span class="pulse-dot danger"></span>';
  const cards = [
    { tone: batches > 0 ? 'info' : 'neutral', icon: '📦', label: 'Batches', value: batches, sub: `${totals.total.toLocaleString()} SKU(s) tracked` },
    { tone: workersOnline > 0 ? 'success' : workersTotal > 0 ? 'warn' : 'danger', icon: '🖥️', label: 'Workers online', value: `${workersOnline}<span style="font-size:14px; color:var(--text-3); font-weight:500;"> / ${workersTotal}</span>`, sub: `${workerDot} ${workersOnline > 0 ? 'processing' : workersTotal > 0 ? 'all idle' : 'no workers'}` },
    { tone: last24h > 0 ? 'success' : 'neutral', icon: '📈', label: 'Rows landed (24h)', value: last24h.toLocaleString(), sub: `<span class="${trendCls}">${trend}</span> vs prior 6h (${last6.toLocaleString()} → ${prev6.toLocaleString()})` },
    { tone: totals.claimed > 0 ? 'info' : 'neutral', icon: '⚙️', label: 'In flight', value: totals.claimed, sub: `${totals.pending.toLocaleString()} pending queue` },
    { tone: donePct >= 90 ? 'success' : donePct >= 30 ? 'info' : 'neutral', icon: '✓', label: 'Completed', value: `${totals.done}<span style="font-size:14px; color:var(--text-3); font-weight:500;"> · ${donePct}%</span>`, sub: totals.total ? `${totals.total - totals.done} remaining` : 'nothing queued' },
    { tone: totals.failed > 0 ? 'danger' : 'neutral', icon: '⚠', label: 'Failed', value: totals.failed, sub: totals.failed > 0 ? 'check the failed-jobs card' : 'no failures' },
  ];
  el.innerHTML = cards.map(c => `
    <div class="hero-card tone-${c.tone}">
      <div class="hero-icon">${c.icon}</div>
      <div class="hero-label">${esc(c.label)}</div>
      <div class="hero-value">${c.value}</div>
      <div class="hero-sub">${c.sub}</div>
    </div>`).join('');
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
    <thead><tr><th>Batch</th><th style="width:1%;">Ship</th><th style="width: 30%;">Progress</th><th class="num">Total</th><th class="num">Done</th><th class="num">Failed</th><th style="width:1%;">Manage</th></tr></thead>
    <tbody>${state.batches.map(b => {
      const done = b.done || 0, failed = b.failed || 0, claimed = b.claimed || 0, total = b.total || 0;
      const donePct = total ? (done / total) * 100 : 0;
      const complete = done + failed === total && total > 0;
      const fillClass = complete ? 'done' : (claimed > 0 ? '' : (donePct > 0 ? '' : 'stuck'));
      return `
        <tr>
          <td class="mono" style="cursor:pointer;" onclick="document.getElementById('dashBatchSelect').value='${esc(b.batch_id)}'; document.getElementById('dashBatchSelect').dispatchEvent(new Event('change'));">${esc(b.batch_id)}</td>
          <td><span class="ship-badge ship-loading" data-ship-badge="${esc(b.batch_id)}" data-batch-id="${esc(b.batch_id)}" title="Ship-readiness — loading…">…</span></td>
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
          <td class="num" style="color:var(--success);">
            ${done}
            ${b.done_empty > 0 ? `<div style="font-size:9px; color:var(--warn); font-weight:700; margin-top:2px;" title="Marked 'done' but the manager has ZERO keyword rows for these SKUs — worker died / push failed after marking done. Click the 'Requeue empty' button to reset them to pending so a worker retries.">⚠ ${b.done_empty} empty</div>` : ''}
          </td>
          <td class="num" style="color:${failed > 0 ? 'var(--danger)' : 'var(--text-3)'};">${failed}</td>
          <td>
            <button class="tiny secondary" data-queue-manage="${esc(b.batch_id)}" title="Open the queue manager for this batch — view every SKU, edit priority, re-queue failed, delete, add new.">Manage</button>
            ${b.done_empty > 0 ? `<button class="tiny secondary" data-requeue-empty="${esc(b.batch_id)}" style="color:var(--warn); border-color:var(--warn); margin-left:4px;" title="Reset the ${b.done_empty} phantom-done job(s) back to pending. A worker will re-claim and this time push keywords BEFORE marking done.">↺ Requeue ${b.done_empty} empty</button>` : ''}
          </td>
        </tr>`;
    }).join('')}
    </tbody></table>`;
  // Wire the Manage buttons.
  el.querySelectorAll('button[data-queue-manage]').forEach(btn =>
    btn.addEventListener('click', () => openQueueManager(btn.dataset.queueManage))
  );
  // Wire the Requeue-empty buttons — 1-click reset of phantom-done jobs.
  el.querySelectorAll('button[data-requeue-empty]').forEach(btn => btn.addEventListener('click', async () => {
    const bId = btn.dataset.requeueEmpty;
    if (!confirm(`Requeue every 'done' SKU in batch ${bId.slice(-8)} that has ZERO keyword rows in the manager? They'll go back to pending for a worker to reclaim.`)) return;
    try {
      const r = await api.jobsRequeueDoneEmpty(bId);
      toast(`${r.updated} phantom-done job(s) requeued`, 'ok', { title: 'Requeued' });
      refreshDashboard();
    } catch (e) { toast(e.message, 'err', { title: 'Requeue failed' }); }
  }));
  // Populate the ship-readiness badges in parallel — one HTTP call per
  // batch, but they're cheap (single SQL aggregate). Renders in place as
  // each responds; failures show a grey '?' rather than blocking the row.
  el.querySelectorAll('[data-ship-badge]').forEach(badge => {
    const bId = badge.dataset.shipBadge;
    api.batchReadiness(bId).then(r => renderShipBadge(badge, { ...r, batchId: bId })).catch(() => {
      badge.className = 'ship-badge ship-unknown';
      badge.textContent = '?';
      badge.title = 'Ship-readiness endpoint failed (server may need a restart to pick up /api/batches/readiness)';
    });
  });
}
// Compact ship-readiness badge renderer. Maps the server's status enum to
// color + label + hover tooltip. Clicking a REVIEW badge opens the queue
// manager filtered to the problem SKUs; other statuses just switch to the
// batch on the dashboard.
function renderShipBadge(badge, r) {
  const statusStyles = {
    READY:       { color: 'success', label: 'READY',   icon: '✓' },
    REVIEW:      { color: 'warn',    label: 'REVIEW',  icon: '⚠' },
    IN_PROGRESS: { color: 'info',    label: 'RUNNING', icon: '◐' },
    STUCK:       { color: 'danger',  label: 'STUCK',   icon: '⛔' },
    EMPTY:       { color: 'text-3',  label: 'EMPTY',   icon: '·' },
  };
  const s = statusStyles[r.status] || statusStyles.EMPTY;
  badge.className = `ship-badge ship-${r.status.toLowerCase()}`;
  badge.textContent = `${s.icon} ${s.label}`;
  // Tooltip: reason + a compact metrics line so hovering surfaces the
  // full story (avg rows, low-yield count, stall minutes if applicable).
  const m = r.metrics || {};
  const metricsLine = [
    `${m.done ?? 0}/${m.total ?? 0} done`,
    m.failed > 0 ? `${m.failed} failed` : null,
    m.low_yield > 0 ? `${m.low_yield} low-yield` : null,
    m.done_empty > 0 ? `${m.done_empty} done-empty` : null,
    (m.total_rows != null) ? `${m.total_rows.toLocaleString()} rows` : null,
    (m.avg_rows_per_done != null && m.avg_rows_per_done > 0) ? `avg ${m.avg_rows_per_done}/SKU` : null,
    (m.stall_minutes != null && m.stall_minutes > 5) ? `${m.stall_minutes}m since last activity` : null,
  ].filter(Boolean).join(' · ');
  badge.title = `${r.reason || r.status}\n${metricsLine}`;
  // REVIEW with low-yield SKUs → inject a compact 1-click requeue button
  // next to the badge. Uses the low_yield_skus list already in the
  // response — no extra HTTP call needed for the count.
  if (r.status === 'REVIEW' && (r.metrics?.low_yield || 0) > 0 && r.batchId) {
    const existingBtn = badge.parentElement?.querySelector('button[data-requeue-low-yield]');
    if (!existingBtn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tiny secondary';
      btn.dataset.requeueLowYield = r.batchId;
      btn.style.cssText = 'margin-left:6px; color:var(--warn); border-color:var(--warn); font-size:10px; padding:2px 6px;';
      btn.textContent = `↺ ${r.metrics.low_yield}`;
      const previewSkus = (r.low_yield_skus || []).slice(0, 6).map(s => `${s.sku || s.product_name || '(no sku)'} (${s.row_count} rows)`).join('\n');
      btn.title = `Requeue ${r.metrics.low_yield} low-yield SKU(s):\n${previewSkus}${r.low_yield_skus?.length > 6 ? `\n… + ${r.low_yield_skus.length - 6} more` : ''}\n\nExisting keyword rows for these SKUs are cleared so the re-run doesn't duplicate.`;
      btn.addEventListener('click', async () => {
        if (!confirm(`Requeue ${r.metrics.low_yield} low-yield SKU(s) in this batch?\n\nEach SKU's existing keyword rows are cleared first so the re-run doesn't leave duplicates. Workers will re-claim and reprocess.`)) return;
        try {
          const res = await api.jobsRequeueLowYield(r.batchId, 30);
          toast(`↺ Requeued ${res.updated} SKU(s), cleared ${res.cleared_keyword_rows} old row(s).`, 'ok', { title: 'Low-yield requeued' });
          refreshDashboard();
        } catch (e) { toast(e.message, 'err', { title: 'Requeue failed' }); }
      });
      badge.insertAdjacentElement('afterend', btn);
    }
  }
}

// ─────────── Queue manager modal ───────────
// Per-job CRUD for a batch — safe against active workers. Auto-refreshes
// every 5s while open so worker state stays live. Uses the same modal
// system as the worker monitor (backdrop click + Escape both close).
let _queueTimer = null;
async function openQueueManager(batchId) {
  const modal = $('queueManageModal');
  const body  = $('queueManageBody');
  const title = $('queueManageTitle');
  if (!modal || !body || !title || !batchId) return;
  title.innerHTML = `Queue · <span class="mono">${esc(batchLabel ? batchLabel(batchId) : batchId)}</span>`;
  body.innerHTML = `<div class="hint">Loading queue…</div>`;
  modal.style.display = 'flex';
  await refreshQueueManager(batchId);
  if (_queueTimer) clearInterval(_queueTimer);
  _queueTimer = setInterval(() => {
    if (modal.style.display === 'none') { clearInterval(_queueTimer); _queueTimer = null; return; }
    refreshQueueManager(batchId);
  }, 5000);
}

// Queue-manager UI state — persists across the 5s auto-refresh so the
// user's search + status filter + selected checkboxes survive rebinds.
const _qmState = {
  search: '',
  statusFilter: 'all',
  selected: new Set(),
  paneOpen: null,    // 'add' | 'bulkImport' | null
};
async function refreshQueueManager(batchId) {
  const body = $('queueManageBody');
  if (!body) return;
  let rows = [];
  try { const r = await api.jobsList(batchId); rows = r.rows || []; } catch (e) {
    body.innerHTML = `<div class="banner err">Failed to load queue: ${esc(e.message)}</div>`;
    return;
  }
  const stat = { pending: 0, claimed: 0, done: 0, failed: 0 };
  for (const r of rows) stat[r.status] = (stat[r.status] || 0) + 1;
  // Apply client-side filters. Search hits SKU + product name + URL.
  const q = (_qmState.search || '').trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (_qmState.statusFilter !== 'all' && r.status !== _qmState.statusFilter) return false;
    if (!q) return true;
    return (r.sku && r.sku.toLowerCase().includes(q))
        || (r.product_name && r.product_name.toLowerCase().includes(q))
        || (r.product_url && r.product_url.toLowerCase().includes(q));
  });
  // Prune _qmState.selected to only IDs still in the filtered set (so
  // 'bulk delete selected' can't accidentally hit a hidden row).
  const visibleIds = new Set(filtered.map(r => r.id));
  for (const id of _qmState.selected) if (!visibleIds.has(id)) _qmState.selected.delete(id);
  const selCount = _qmState.selected.size;
  const statusColor = (s) => s === 'done' ? 'var(--success)'
                            : s === 'failed' ? 'var(--danger)'
                            : s === 'claimed' ? 'var(--accent)'
                            : 'var(--text-2)';
  body.innerHTML = `
    <div class="qm-strip">
      <span><strong>${rows.length}</strong> total</span>
      <button class="qm-filter-btn ${_qmState.statusFilter === 'pending' ? 'active' : ''}" data-status="pending" style="color:var(--text-2);"><strong>${stat.pending || 0}</strong> pending</button>
      <button class="qm-filter-btn ${_qmState.statusFilter === 'claimed' ? 'active' : ''}" data-status="claimed" style="color:var(--accent);"><strong>${stat.claimed || 0}</strong> claimed</button>
      <button class="qm-filter-btn ${_qmState.statusFilter === 'done' ? 'active' : ''}" data-status="done" style="color:var(--success);"><strong>${stat.done || 0}</strong> done</button>
      <button class="qm-filter-btn ${_qmState.statusFilter === 'failed' ? 'active' : ''}" data-status="failed" style="color:var(--danger);"><strong>${stat.failed || 0}</strong> failed</button>
      ${_qmState.statusFilter !== 'all' ? `<button class="qm-filter-btn" data-status="all" title="Clear filter" style="color:var(--text-3);">× clear</button>` : ''}
      <span class="spacer" style="flex:1;"></span>
      <input type="search" id="qmSearch" placeholder="Search SKU / name / URL" value="${esc(_qmState.search)}" style="min-width: 200px; padding: 4px 8px; font-size: 11px;" />
      <button class="small secondary" id="qmBulkImportBtn" title="Paste a list of SKUs (Dropy-BXXXXXXXXX, one per line) to add as jobs.">📋 Bulk import SKUs</button>
      <button class="small secondary" id="qmAddBtn">+ Add one</button>
    </div>
    ${selCount > 0 ? `
    <div class="qm-bulkbar">
      <strong>${selCount}</strong> selected
      <span class="spacer" style="flex:1;"></span>
      <button class="small secondary" id="qmBulkReset" title="Reset selected jobs back to pending — releases their claims. Refuses claimed jobs without force.">↺ Reset selected</button>
      <button class="small secondary" id="qmBulkPrio" title="Change priority for the selected jobs (higher = claimed first).">↑ Set priority</button>
      <button class="small danger" id="qmBulkDelete" title="Delete selected jobs and their keyword rows. Refuses claimed jobs without force.">✕ Delete selected</button>
      <button class="small secondary" id="qmBulkClear">Clear selection</button>
    </div>` : ''}
    <div id="qmSubPane" style="margin-bottom: var(--space-3);"></div>
    <div class="tbl-wrap" style="max-height: 460px; overflow-y: auto;">
      <table class="tbl compact">
        <thead>
          <tr>
            <th style="width:30px;"><input type="checkbox" id="qmSelectAll" title="Select all visible" ${filtered.length > 0 && filtered.every(r => _qmState.selected.has(r.id)) ? 'checked' : ''} /></th>
            <th style="width:60px;">ID</th>
            <th style="width:70px;" class="num">Prio</th>
            <th>SKU</th>
            <th>Product name</th>
            <th>URL</th>
            <th style="width:80px;">Status</th>
            <th>Worker</th>
            <th style="width:180px;">Actions</th>
          </tr>
        </thead>
        <tbody>${filtered.length === 0 ? `<tr><td colspan="9" style="text-align:center; padding: 20px; color:var(--text-3);">No jobs match this filter.</td></tr>` : filtered.map(r => `
          <tr data-job-id="${r.id}" class="${_qmState.selected.has(r.id) ? 'qm-row-sel' : ''}">
            <td><input type="checkbox" class="qm-select" data-job-id="${r.id}" ${_qmState.selected.has(r.id) ? 'checked' : ''} /></td>
            <td class="mono" style="color:var(--text-3);">${r.id}</td>
            <td class="num"><input type="number" class="qm-prio" data-job-id="${r.id}" value="${r.priority}" min="0" max="9999" step="10" style="width: 60px; padding: 2px 4px; font-size: 11px;" /></td>
            <td class="mono">${esc(r.sku || '—')}</td>
            <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis;" title="${esc(r.product_name || '')}">${esc(r.product_name || '—')}</td>
            <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis;"><a href="${esc(r.product_url)}" target="_blank" rel="noopener" title="${esc(r.product_url)}">${esc(r.product_url.replace(/^https?:\/\//, '').slice(0, 40))}</a></td>
            <td><span class="chip" style="background:transparent; color:${statusColor(r.status)}; border:1px solid ${statusColor(r.status)};">${r.status}</span></td>
            <td class="mono" style="color:var(--text-2); font-size:10px;">${esc(r.claimed_by || '—')}</td>
            <td>
              <button class="tiny secondary qm-reset" data-job-id="${r.id}" title="Reset to pending (re-queue).">↺</button>
              <button class="tiny danger qm-delete" data-job-id="${r.id}" title="Delete this SKU + its keyword rows.">✕</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top: var(--space-2);">
      ${filtered.length} of ${rows.length} shown · Auto-refreshes every 5s · Priority edits save on blur/Enter · Bulk import accepts <code>Dropy-BXXXXXXXXX</code> or raw <code>BXXXXXXXXX</code> ASINs, one per line.
    </div>`;

  // Restore sub-pane if it was open before the refresh.
  if (_qmState.paneOpen === 'add') renderQmAddPane(batchId);
  else if (_qmState.paneOpen === 'bulkImport') renderQmBulkImportPane(batchId);

  // ── Filter chips ──
  body.querySelectorAll('.qm-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _qmState.statusFilter = btn.dataset.status;
      refreshQueueManager(batchId);
    });
  });
  // ── Search — debounced 200ms; keep focus + caret position ──
  const searchInp = body.querySelector('#qmSearch');
  if (searchInp) {
    if (_qmState.search) {
      // Preserve caret at end of input after re-render.
      const v = searchInp.value;
      searchInp.setSelectionRange(v.length, v.length);
      searchInp.focus();
    }
    let searchDebounce = null;
    searchInp.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        _qmState.search = searchInp.value;
        refreshQueueManager(batchId);
      }, 200);
    });
  }
  // ── Select-all + per-row checkboxes ──
  body.querySelector('#qmSelectAll')?.addEventListener('change', (e) => {
    if (e.target.checked) filtered.forEach(r => _qmState.selected.add(r.id));
    else filtered.forEach(r => _qmState.selected.delete(r.id));
    refreshQueueManager(batchId);
  });
  body.querySelectorAll('input.qm-select').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = Number(cb.dataset.jobId);
      if (e.target.checked) _qmState.selected.add(id);
      else _qmState.selected.delete(id);
      refreshQueueManager(batchId);
    });
  });
  // ── Bulk actions ──
  body.querySelector('#qmBulkClear')?.addEventListener('click', () => {
    _qmState.selected.clear(); refreshQueueManager(batchId);
  });
  body.querySelector('#qmBulkReset')?.addEventListener('click', async () => {
    const ids = [..._qmState.selected];
    if (!confirm(`Reset ${ids.length} selected job(s) back to pending? Their claims will be released.`)) return;
    try {
      let r = await api.jobsBulkUpdate(ids, { status: 'pending' }, false);
      if (r.updated < ids.length && confirm(`${r.updated}/${ids.length} reset. ${ids.length - r.updated} were claimed. Force-reset those too?`)) {
        r = await api.jobsBulkUpdate(ids, { status: 'pending' }, true);
      }
      toast(`${r.updated} job(s) reset`, 'ok');
      _qmState.selected.clear(); refreshQueueManager(batchId);
    } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelector('#qmBulkPrio')?.addEventListener('click', async () => {
    const val = prompt(`Set priority for ${_qmState.selected.size} selected job(s):\n\n· 0 = never claim\n· 100 = default\n· 1000 = urgent (claimed first)`, '500');
    if (val === null) return;
    const num = Number(val);
    if (!Number.isFinite(num)) { toast('Priority must be a number', 'warn'); return; }
    try {
      const r = await api.jobsBulkUpdate([..._qmState.selected], { priority: num }, false);
      toast(`Priority → ${num} on ${r.updated} job(s)`, 'ok');
      _qmState.selected.clear(); refreshQueueManager(batchId);
    } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelector('#qmBulkDelete')?.addEventListener('click', async () => {
    const ids = [..._qmState.selected];
    if (!confirm(`Delete ${ids.length} selected job(s) + every keyword row collected for them? Cannot be undone.`)) return;
    try {
      let r = await api.jobsBulkDelete(ids, false);
      if (r.deleted < ids.length && confirm(`${r.deleted}/${ids.length} deleted. ${ids.length - r.deleted} were claimed. Force-delete those too?`)) {
        r = await api.jobsBulkDelete(ids, true);
      }
      toast(`${r.deleted} job(s) + ${r.keywordsDeleted} keyword row(s) deleted`, 'ok');
      _qmState.selected.clear(); refreshQueueManager(batchId);
    } catch (e) { toast(e.message, 'err'); }
  });
  // ── Sub-pane toggles ──
  body.querySelector('#qmAddBtn')?.addEventListener('click', () => {
    _qmState.paneOpen = _qmState.paneOpen === 'add' ? null : 'add';
    refreshQueueManager(batchId);
  });
  body.querySelector('#qmBulkImportBtn')?.addEventListener('click', () => {
    _qmState.paneOpen = _qmState.paneOpen === 'bulkImport' ? null : 'bulkImport';
    refreshQueueManager(batchId);
  });
  // ── Priority edits — save on blur / Enter ──
  body.querySelectorAll('input.qm-prio').forEach(inp => {
    const save = async () => {
      const id = Number(inp.dataset.jobId);
      const val = Number(inp.value);
      if (!Number.isFinite(id) || !Number.isFinite(val)) return;
      try { await api.jobUpdate(id, { priority: val }); toast(`Priority for job ${id} → ${val}`, 'ok'); }
      catch (e) { toast(`Update failed: ${e.message}`, 'err'); }
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
  // Wire reset buttons.
  body.querySelectorAll('button.qm-reset').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.jobId);
    try {
      await api.jobReset(id, false);
      toast(`Job ${id} reset to pending`, 'ok');
      refreshQueueManager(batchId);
    } catch (e) {
      if (e.status === 409 && confirm(`${e.message}\n\nForce reset anyway?`)) {
        try { await api.jobReset(id, true); toast(`Job ${id} force-reset`, 'ok'); refreshQueueManager(batchId); }
        catch (e2) { toast(e2.message, 'err'); }
      } else if (e.status !== 409) { toast(e.message, 'err'); }
    }
  }));
  // Wire delete buttons.
  body.querySelectorAll('button.qm-delete').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.jobId);
    if (!confirm(`Delete job ${id}? Also deletes any keyword rows collected for it in this batch.`)) return;
    try {
      const r = await api.jobDelete(id, false);
      toast(`Job ${id} deleted (${r.keywordsDeleted} keyword row(s) also removed)`, 'ok');
      refreshQueueManager(batchId);
    } catch (e) {
      if (e.status === 409 && confirm(`${e.message}\n\nForce delete anyway? (The worker's next heartbeat/mark-done will fail silently.)`)) {
        try { const r = await api.jobDelete(id, true); toast(`Job ${id} force-deleted (${r.keywordsDeleted} kw)`, 'ok'); refreshQueueManager(batchId); }
        catch (e2) { toast(e2.message, 'err'); }
      } else if (e.status !== 409) { toast(e.message, 'err'); }
    }
  }));
}
// Single-row add pane — used for one-off SKU additions.
function renderQmAddPane(batchId) {
  const pane = $('qmSubPane');
  if (!pane) return;
  pane.innerHTML = `
    <div style="padding: var(--space-3); background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius-sm);">
      <div class="hint" style="margin-bottom: var(--space-2);"><strong>Add one job</strong> — for a specific product URL you want in this batch.</div>
      <div style="display:grid; grid-template-columns: 1fr 1fr auto; gap: var(--space-2);">
        <input id="qmAddUrl" placeholder="Product URL (required)" style="grid-column: 1 / -1;" />
        <input id="qmAddSku" placeholder="SKU (optional)" />
        <input id="qmAddName" placeholder="Product name (optional)" />
        <button id="qmAddSubmit">Add</button>
      </div>
    </div>`;
  pane.querySelector('#qmAddSubmit')?.addEventListener('click', async () => {
    const url  = pane.querySelector('#qmAddUrl').value.trim();
    if (!url) { toast('URL required', 'warn'); return; }
    const sku  = pane.querySelector('#qmAddSku').value.trim();
    const name = pane.querySelector('#qmAddName').value.trim();
    try {
      const r = await api.jobAddOne(batchId, { url, sku: sku || null, product_name: name || null, priority: 100 });
      toast(`Added job ${r.jobId}`, 'ok');
      _qmState.paneOpen = null;
      refreshQueueManager(batchId);
    } catch (e) { toast(e.message, 'err'); }
  });
}
// Bulk SKU import pane — the main new feature. Paste a plaintext list
// (Dropy-BXXXXXXXXX or raw ASIN), pick a resolve mode (Amazon URL /
// Shopify handle / both), preview via dry-run, then commit.
function renderQmBulkImportPane(batchId) {
  const pane = $('qmSubPane');
  if (!pane) return;
  pane.innerHTML = `
    <div style="padding: var(--space-3); background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius-sm);">
      <div class="hint" style="margin-bottom: var(--space-2);">
        <strong>Bulk import SKUs</strong> — paste a list, one SKU per line. Accepts <code>Dropy-BXXXXXXXXX</code>, <code>bxxxxxxxxx</code>, or raw <code>BXXXXXXXXX</code> ASINs. Lines starting with <code>#</code> are comments; blank lines are skipped.
      </div>
      <textarea id="qmBulkText" spellcheck="false" placeholder="Dropy-B002OTT3US&#10;Dropy-B07KYD25MF&#10;Dropy-B0B3FBK9KW&#10;# comment lines start with hash&#10;B00X6ZNWG0" style="width:100%; min-height:180px; font-family:var(--mono); font-size:11px; padding:8px; background:var(--bg-input); border:1px solid var(--line-2); border-radius:6px; resize:vertical;"></textarea>
      <div class="row" style="margin-top: var(--space-2); align-items:center;">
        <label class="field" style="margin: 0; flex: 0 0 auto;">
          <span class="lbl" style="margin-bottom: 2px;">Resolve via</span>
          <select id="qmBulkResolve" style="width: 220px;">
            <option value="amazon">Amazon.in — build https://www.amazon.in/dp/&lt;ASIN&gt;</option>
            <option value="shopify">Shopify — look up handle by SKU (needs Shopify configured)</option>
            <option value="both">Both — try Shopify first, fall back to Amazon.in</option>
          </select>
        </label>
        <span class="spacer" style="flex:1;"></span>
        <button class="small secondary" id="qmBulkPreview">👁 Preview (dry run)</button>
        <button class="small" id="qmBulkCommit" disabled>Import → queue</button>
      </div>
      <div id="qmBulkResult" style="margin-top: var(--space-2);"></div>
    </div>`;
  pane.querySelector('#qmBulkPreview')?.addEventListener('click', async () => {
    const text = pane.querySelector('#qmBulkText').value;
    const skus = text.split(/\r?\n/);
    const resolve = pane.querySelector('#qmBulkResolve').value;
    const box = pane.querySelector('#qmBulkResult');
    box.innerHTML = '<div class="hint">Resolving…</div>';
    try {
      const r = await api.jobsUploadBySku(batchId, skus, resolve, true);
      // Preview shows the enriched Shopify metadata (title, handles,
      // brand) — same fields the engine uses for seed derivation +
      // brand-domain confirmation, matching what Excel/CSV uploads carry.
      const rowsHtml = (r.preview || []).slice(0, 50).map(x => `
        <tr>
          <td class="mono" style="font-size:11px;">${esc(x.sku)}</td>
          <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis;" title="${esc(x.product_name || '')}">${x.product_name ? esc(x.product_name) : '<span style="color:var(--text-3);">—</span>'}</td>
          <td class="mono" style="font-size:10px; color:var(--text-3); max-width:180px; overflow:hidden; text-overflow:ellipsis;" title="${esc(x.handles || '')}">${x.handles ? esc(x.handles.split('|').slice(0, 2).join(' · ')) + (x.handles.split('|').length > 2 ? '…' : '') : '<span>—</span>'}</td>
          <td class="mono" style="font-size:11px;">${x.brands ? esc(x.brands) : '<span style="color:var(--text-3);">—</span>'}</td>
          <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis;">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" style="font-size:11px;">${esc(x.url.replace(/^https?:\/\//, ''))}</a>` : '<span style="color:var(--danger);">unresolved</span>'}</td>
          <td class="mono" style="font-size:10px; color:${x.source === 'shopify' ? 'var(--success)' : x.source === 'amazon' ? 'var(--warn)' : 'var(--danger)'};">${esc(x.source || '—')}</td>
        </tr>`).join('');
      box.innerHTML = `
        <div class="banner ${r.resolved > 0 ? 'ok' : 'warn'}" style="margin-bottom: var(--space-2);">
          ${r.resolved} resolved · ${r.unresolved || 0} unresolved · ${r.badFormat || 0} bad format
          ${r.badFormat > 0 ? ` · samples: ${(r.badFormatSamples || []).slice(0, 3).map(s => `<code>${esc(s)}</code>`).join(' ')}` : ''}
          ${resolve !== 'amazon' && !r.shopifyConfigured ? ' · <strong>Shopify not configured</strong> — configure in Config → Shopify integration, or use resolve=amazon.' : ''}
        </div>
        <div class="tbl-wrap" style="max-height: 260px; overflow-y: auto;">
          <table class="tbl compact">
            <thead><tr><th>SKU</th><th>Title</th><th>Handles</th><th>Brand</th><th>URL</th><th>Source</th></tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-3);">nothing to preview</td></tr>'}</tbody>
          </table>
          ${(r.preview?.length || 0) > 50 ? `<div class="hint" style="padding: 6px 0;">…and ${r.preview.length - 50} more.</div>` : ''}
        </div>`;
      const commitBtn = pane.querySelector('#qmBulkCommit');
      commitBtn.disabled = r.resolved === 0;
      commitBtn.textContent = `Import → queue (${r.resolved} SKU${r.resolved === 1 ? '' : 's'})`;
    } catch (e) {
      box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
    }
  });
  pane.querySelector('#qmBulkCommit')?.addEventListener('click', async () => {
    const text = pane.querySelector('#qmBulkText').value;
    const skus = text.split(/\r?\n/);
    const resolve = pane.querySelector('#qmBulkResolve').value;
    const box = pane.querySelector('#qmBulkResult');
    box.innerHTML = '<div class="hint">Inserting…</div>';
    try {
      const r = await api.jobsUploadBySku(batchId, skus, resolve, false);
      box.innerHTML = `
        <div class="banner ok">
          ✓ ${r.inserted} job(s) inserted.
          ${r.skippedActive ? ` ${r.skippedActive} skipped (already active in another batch: ${(r.skippedSkus || []).slice(0, 5).map(s => `<code>${esc(s)}</code>`).join(' ')})` : ''}
          ${r.unresolved ? ` ${r.unresolved} unresolved.` : ''}
        </div>`;
      toast(`${r.inserted} SKU(s) added to queue`, 'ok');
      _qmState.paneOpen = null;
      setTimeout(() => refreshQueueManager(batchId), 800);
    } catch (e) {
      box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
    }
  });
}

// Per-worker monitor modal — click 🖥 on any worker row.
// Zooms into a full-screen card with everything about ONE worker:
// health chip, current step + heartbeat, big action buttons, and a
// live-filtered activity log scoped to this worker. Refreshes every
// 5s while the modal is open (a lightweight per-worker refresh loop
// that hits /api/activity?workerId=X + /api/workers/list — much
// cheaper than a full dashboard refresh).
let _workerMonitorTimer = null;
// Expose globally so the fleet row's <button onclick> fallback (inline
// attribute) can always call it, even if the delegated listener at
// document-level failed to attach for any reason (script order, error
// during boot, whatever). Belt to the delegation suspenders.
async function openWorkerMonitor(workerId) {
  const modal = $('workerMonitorModal');
  const title = $('workerMonitorTitle');
  const body  = $('workerMonitorBody');
  if (!modal || !title || !body || !workerId) return;
  title.innerHTML = `🖥 <span class="mono">${esc(workerId)}</span>`;
  body.innerHTML = `<div class="hint">Loading…</div>`;
  modal.style.display = 'flex';
  // Remember which worker this modal is bound to. The delegated click
  // handler reads it so the 5s auto-refresh (which rewrites innerHTML)
  // never breaks the buttons — same fix as the fleet-grid delegation.
  body.dataset.workerId = workerId;
  wireMonitorDelegation(body);
  await refreshWorkerMonitor(workerId);
  if (_workerMonitorTimer) clearInterval(_workerMonitorTimer);
  _workerMonitorTimer = setInterval(() => {
    if (modal.style.display === 'none') { clearInterval(_workerMonitorTimer); _workerMonitorTimer = null; return; }
    refreshWorkerMonitor(workerId);
  }, 5000);
}
// Monitor-modal delegated click handler — attached once, survives every
// 5-second refreshWorkerMonitor innerHTML replace.
let _monitorDelegationWired = false;
function wireMonitorDelegation(body) {
  if (_monitorDelegationWired) return;
  _monitorDelegationWired = true;
  body.addEventListener('click', async (e) => {
    const workerId = body.dataset.workerId;
    if (!workerId) return;
    const btn = e.target.closest?.('button');
    if (!btn) return;
    if (btn.dataset.cmd) {
      const cmd = btn.dataset.cmd;
      try {
        await api.commandsSend(workerId, cmd, {});
        toast(`${cmd} → ${workerId}`, 'ok');
        setTimeout(() => refreshWorkerMonitor(workerId), 500);
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.dataset.releaseWorker) {
      if (!confirm(`Release all claims held by ${workerId}?`)) return;
      try {
        const r = await api.jobsReleaseByWorker(workerId);
        toast(`Released ${r.released} SKU(s)`, 'ok');
        refreshWorkerMonitor(workerId);
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.dataset.wol) {
      try { await api.wakeOnLan(workerId); toast(`WoL sent to ${workerId}`, 'ok'); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (btn.id === 'wmClearBtn') {
      if (!confirm(`Clear activity log for ${workerId}?`)) return;
      try {
        const r = await api.activityClear({ workerId });
        toast(`Cleared ${r.deleted} row(s)`, 'ok');
        refreshWorkerMonitor(workerId);
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
  });
}
async function refreshWorkerMonitor(workerId) {
  const body = $('workerMonitorBody');
  if (!body) return;
  const w = state.workers.find(x => x.worker_id === workerId);
  const stage = w ? (function() {
    const now = Date.now();
    const hb  = Number(w.last_heartbeat || 0);
    const ago = now - hb;
    const hAgo = Math.round(ago / 3600000);
    if (!hb)                      return { label: 'never seen',                 color: 'var(--text-3)', dot: 'idle'   };
    if (ago > 4 * 3600 * 1000)    return { label: `SHUT DOWN (${hAgo}h ago)`,   color: 'var(--text-3)', dot: 'idle'   };
    if (ago > 5 * 60 * 1000)      return { label: 'OFFLINE',                    color: 'var(--danger)', dot: 'danger' };
    if (ago > 3 * 60 * 1000)      return { label: 'stale',                      color: 'var(--warn)',   dot: 'warn'   };
    if (w._lastActivity) {
      const msg = String(w._lastActivity.message || '').toLowerCase();
      if (msg.includes('stopped by')) return { label: 'stopped by user', color: 'var(--danger)', dot: 'danger' };
    }
    return { label: 'online',   color: 'var(--success)', dot: 'ok' };
  })() : { label: 'unknown', color: 'var(--text-3)', dot: 'idle' };
  let activity = { events: [] };
  try { activity = await api.activityGet(state.activeBatch, 200, workerId); } catch {}
  const events = activity.events || [];
  const errCount = events.filter(e => e.level === 'err').length;
  const rowColor = (lv) => lv === 'err' ? 'var(--danger)' : lv === 'warn' ? 'var(--warn)' : lv === 'ok' ? 'var(--success)' : 'var(--text-2)';
  body.innerHTML = `
    <div class="wm-hdr">
      <div class="wm-status">
        <span class="pulse-dot ${stage.dot}"></span>
        <div>
          <div class="wm-stage" style="color:${stage.color};">${esc(stage.label)}</div>
          <div class="wm-hb hint">last heartbeat ${w ? fmtAgo(w.last_heartbeat) : '—'}</div>
        </div>
      </div>
      <div class="wm-tiles">
        <div class="tile"><div class="lbl">In flight</div><div class="val">${w?.in_flight || 0}</div></div>
        <div class="tile"><div class="lbl">Done</div><div class="val" style="color:var(--success);">${w?.done || 0}</div></div>
        <div class="tile"><div class="lbl">Failed</div><div class="val" style="color:${(w?.failed||0) > 0 ? 'var(--danger)' : 'var(--text-3)'};">${w?.failed || 0}</div></div>
      </div>
    </div>
    <div class="wm-actions">
      <button data-worker="${esc(workerId)}" data-cmd="wake" title="Wake — start claiming. IGNORED if worker was stopped-by-user (use ⟳ Reconnect instead).">▶ Wake</button>
      <button data-worker="${esc(workerId)}" data-cmd="reconnect" style="background:var(--warn); color:#000;" title="Force reconnect — overrides Stop. Use this when Wake was ignored.">⟳ Force reconnect</button>
      <button data-worker="${esc(workerId)}" data-cmd="pause" class="secondary" title="Pause after current SKU. Worker finishes current job then stops claiming.">⏸ Pause</button>
      <button data-worker="${esc(workerId)}" data-release-worker="${esc(workerId)}" class="danger" title="Release all this worker's claims back to pending. Manager-side — works even if worker is offline.">↻ Release claims</button>
      <button data-worker="${esc(workerId)}" data-cmd="stop" class="danger" title="Stop and disarm — worker requires an explicit Connect to resume.">■ Stop</button>
      <button data-worker="${esc(workerId)}" data-wol="1" class="secondary" title="Wake-on-LAN — send magic packet (only works when manager is on the same physical LAN).">🔌 WoL</button>
    </div>
    <div class="wm-log-hdr">
      <span>📜 Activity (this worker, latest ${events.length}) · ${errCount > 0 ? `<span style="color:var(--danger);">${errCount} error(s)</span>` : 'no errors'}</span>
      <button class="small ghost" id="wmClearBtn" title="Clear this worker's activity rows (leaves other workers' rows intact).">🗑 Clear this worker's log</button>
    </div>
    <div class="wm-log">
      ${events.length === 0 ? '<div class="empty">No activity for this worker.</div>' : events.map(e => `
        <div class="wm-log-row" style="border-left: 3px solid ${rowColor(e.level)};">
          <span class="wm-log-ts">${fmtTime(e.ts)}</span>
          <span class="wm-log-src">${esc(e.source || 'engine')}</span>
          <span class="wm-log-msg">${esc(e.message)}</span>
        </div>`).join('')}
    </div>`;
  // Button handlers live in wireMonitorDelegation() — attached once when
  // the modal opens, survives every 5s innerHTML replace. Do NOT re-wire
  // here; that would double-fire clicks (delegated + direct).
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
    // Heartbeat age → four coarse states:
    //   >4h        SHUT DOWN (PC very likely powered off / suspended
    //              overnight / user closed laptop)
    //   5min-4h    OFFLINE   (Chrome closed, extension unloaded, or
    //              manager unreachable — PC is probably still on)
    //   3-5min     stale     (probably an intermittent network blip)
    //   <90s       online
    if (worker) {
      const hb = Number(worker.last_heartbeat || 0);
      const ago = Date.now() - hb;
      const hAgo = Math.round(ago / 3600000);
      if (!hb)                        return { label: 'never seen', color: 'var(--text-3)' };
      if (ago > 4 * 3600 * 1000)      return { label: `SHUT DOWN (${hAgo}h ago)`, color: 'var(--text-3)' };
      if (ago > 5 * 60 * 1000)        return { label: 'OFFLINE', color: 'var(--danger)' };
      if (ago > 3 * 60 * 1000)        return { label: 'stale (no heartbeat)', color: 'var(--warn)' };
      // Stuck-engine detection: heartbeat is fresh BUT no new ENGINE
      // activity for 5+ minutes AND the worker is holding claims.
      // Look at the last ENGINE-produced event, not just any event —
      // command acks (source='cmd') don't count because a stuck engine
      // still keeps polling for + acking commands via the SW alarm,
      // making the raw "last activity" reset every time reconnect fires.
      // We use the enriched _lastEngineActivity (fetched in
      // refreshDashboard) which is the newest non-cmd row for this
      // worker; fall back to _lastActivity if empty.
      const eAct = worker._lastEngineActivity || (act && act.source !== 'cmd' ? act : null);
      const lastActTs = eAct ? Number(new Date(eAct.ts).getTime() || 0) : 0;
      const inFlight = Number(worker.in_flight || 0);
      // Grace window: if we've NEVER seen an engine event for this
      // worker (activity_log empty / just Cleared / worker just started /
      // drift-resync just repointed the batch), we can't legitimately
      // call it stuck — the SW's 30s activity-flush alarm hasn't run yet.
      // Instead show WARMING UP while heartbeats prove the SW is alive.
      // Only escalate to STUCK once heartbeat has been fresh for >6 min
      // AND we still have zero engine events — a genuine hang.
      if (lastActTs === 0) {
        if (inFlight > 0 && ago > 6 * 60 * 1000) {
          return { label: 'STUCK (no engine activity ever)', color: 'var(--danger)', stuck: true };
        }
        if (inFlight > 0) {
          return { label: 'warming up', color: 'var(--info)' };
        }
      } else {
        const actAgo = Date.now() - lastActTs;
        if (actAgo > 5 * 60 * 1000 && inFlight > 0) {
          return { label: 'STUCK (heartbeat ok, engine frozen)', color: 'var(--danger)', stuck: true };
        }
      }
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

  // Detect stopped-by-user workers still holding in-flight claims —
  // this is the root cause of "only one worker is running" when the
  // other has been stopped mid-work. Those claims stay locked to the
  // dead worker for up to 10 min (the stale-release default) unless
  // we surface + fix it. Show a big warning banner + a one-click
  // "Release all locked SKUs" action that hits the new manager-side
  // /api/jobs/release-by-worker endpoint (works even if the worker
  // is truly offline — no command-poll dependency).
  const stuck = state.workers.filter(w => {
    const stage = stageFor(w._lastActivity, w);
    const isStopped = stage.label === 'stopped by user' || stage.label === 'OFFLINE';
    return isStopped && (w.in_flight || 0) > 0;
  });
  const stuckBanner = stuck.length > 0 ? `
    <div class="banner warn" style="margin-bottom: 10px; display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 18px;">⚠</span>
      <div style="flex: 1;">
        <strong>${stuck.reduce((s, w) => s + (w.in_flight || 0), 0)} SKU(s) locked to stopped worker${stuck.length > 1 ? 's' : ''}</strong>
        (${stuck.map(w => `${w.worker_id} · ${w.in_flight}`).join(', ')}) —
        other workers can't pick these up until released. Auto-release after 10 min OR click →
      </div>
      <button id="releaseAllStuckBtn" class="small danger">↻ Release all locked SKUs now</button>
    </div>` : '';

  // Frozen-engine detection: workers where heartbeat is fresh but no
  // activity has landed in 5+ minutes AND they hold claims. Different
  // from "stopped by user" — the worker THINKS it's running but the
  // engine loop is hung. Manual reset needed.
  const frozen = state.workers.filter(w => stageFor(w._lastActivity, w).stuck);
  const frozenBanner = frozen.length > 0 ? `
    <div class="banner err" style="margin-bottom: 10px; display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 18px;">🥶</span>
      <div style="flex: 1;">
        <strong>${frozen.length} worker${frozen.length > 1 ? 's' : ''} STUCK — heartbeat is fine, but the engine has stopped producing activity</strong>
        (${frozen.map(w => `${w.worker_id} · last activity ${fmtAgo(w._lastActivity?.ts)}`).join(', ')}).
        Most common cause: a SERP/KP tab hung, or a network stall in the push queue.
        Reconnect can't fix this — it doesn't abort a hung await. Hard-reset reloads the extension SW.
      </div>
      <button id="reconnectAllFrozenBtn" class="small danger">Hard reset all frozen</button>
    </div>` : '';

  el.innerHTML = frozenBanner + stuckBanner + `<table class="tbl">
    <thead><tr><th>Worker</th><th>Current step</th><th>Last hb</th><th class="num">In-flight</th><th class="num">Done</th><th class="num">Failed</th><th style="min-width: 300px; white-space: nowrap;">Actions</th></tr></thead>
    <tbody>${state.workers.map(w => {
      const stage = stageFor(w._lastActivity, w);
      const isStuck = stuck.includes(w);
      const isFrozen = stage.stuck === true;
      const inFlightCell = isStuck
        ? `<td class="num" style="color:var(--warn); font-weight:700;" title="Locked to a stopped worker — click ↻ to release">${w.in_flight || 0} ⚠</td>`
        : isFrozen
        ? `<td class="num" style="color:var(--danger); font-weight:700;" title="Worker is frozen — engine hasn't produced activity in 5+ min but still holds these claims">${w.in_flight || 0} 🥶</td>`
        : `<td class="num">${w.in_flight || 0}</td>`;
      const rowBg = isFrozen ? 'background: rgba(248, 113, 113, 0.08);'
                  : isStuck  ? 'background: rgba(251, 191, 36, 0.05);'
                  : '';
      return `
      <tr${rowBg ? ` style="${rowBg}"` : ''}>
        <td><span class="chip ${workerDotClass(w.last_heartbeat)}">●</span>
            <a href="#" class="mono" data-filter-worker="${esc(w.worker_id)}" style="color: var(--info); text-decoration: none;" title="Filter activity log to this worker">${esc(w.worker_id)}</a></td>
        <td><span style="color: ${stage.color}; font-size: 11px;" title="${esc(w._lastActivity?.message || '')}">${esc(stage.label)}</span>
            ${w._lastActivity ? `<div style="font-size: 10px; color: var(--text-3);">${fmtAgo(w._lastActivity.ts)}</div>` : ''}</td>
        <td>${fmtAgo(w.last_heartbeat)}</td>
        ${inFlightCell}
        <td class="num" style="color:var(--success);">${w.done || 0}</td>
        <td class="num" style="color:${(w.failed||0) > 0 ? 'var(--danger)' : 'var(--text-3)'};">${w.failed || 0}</td>
        <td style="white-space: nowrap; text-align: right;">
          <div class="worker-actions">
            <button data-worker="${esc(w.worker_id)}" data-monitor="1" class="wa wa-primary" title="Monitor — full status, controls, filtered log" onclick="window.openWorkerMonitor && window.openWorkerMonitor('${esc(w.worker_id)}')">🖥</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="wake"   class="wa wa-ok"      title="Wake — start claiming (respects Stop)">▶</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="reconnect" class="wa wa-warn"  title="Force reconnect — overrides Stop">⟳</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="pause"  class="wa"            title="Pause after current SKU">⏸</button>
            <span class="wa-sep"></span>
            <button data-worker="${esc(w.worker_id)}" data-release-worker="${esc(w.worker_id)}" class="wa wa-danger" title="Release claims back to queue">↻</button>
            <button data-worker="${esc(w.worker_id)}" data-cmd="stop"   class="wa wa-danger" title="Stop and disarm">■</button>
            <span class="wa-sep"></span>
            <button data-worker="${esc(w.worker_id)}" data-wol="1"       class="wa wa-primary" title="Wake-on-LAN — magic packet (same LAN only)">🔌</button>
            <button data-worker="${esc(w.worker_id)}" data-recover="1"   class="wa wa-mute"    title="Recovery guide">?</button>
            <button data-worker="${esc(w.worker_id)}" data-remove-worker="1" class="wa wa-mute" title="Remove from roster (ghost / decommissioned)">🗑</button>
          </div>
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;

  // Wire per-row buttons via SINGLE delegated listener on #workerGrid,
  // attached once and left in place across every re-render. The old model
  // re-attached individual handlers on every renderWorkerFleet call — if
  // the user clicked a button in the ~50-200ms between innerHTML replace
  // and the querySelectorAll wire-up, the click hit a DOM node whose new
  // handler hadn't been attached yet. Delegation makes the listener
  // survive every re-render, so the click always dispatches.
  wireFleetDelegation(el);
  // Wire the "release ALL locked SKUs" banner button — one click frees
  // every stuck worker at once.
  $('releaseAllStuckBtn')?.addEventListener('click', async () => {
    if (!confirm(`Release ${stuck.reduce((s, w) => s + (w.in_flight || 0), 0)} locked SKU(s) from ${stuck.length} stopped worker(s)?`)) return;
    let total = 0;
    for (const w of stuck) {
      try { const r = await api.jobsReleaseByWorker(w.worker_id); total += r.released || 0; } catch {}
    }
    toast(`Released ${total} SKU(s) — active workers will pick them up on the next claim cycle.`, 'ok', { title: '↻ All locked SKUs released' });
    refreshDashboard();
  });
  // Hard-reset all frozen — sends 'hard_reset' command which reloads
  // the extension SW on each worker via chrome.runtime.reload(). This
  // is the only way to abort a truly hung `await` inside the engine
  // loop (reconnect only clears flags — it can't break the deadlock).
  // Worker acks the command BEFORE reloading so the manager sees the
  // event land; then the SW dies and re-spawns with fresh state.
  $('reconnectAllFrozenBtn')?.addEventListener('click', async () => {
    if (!confirm(`Send HARD RESET to ${frozen.length} frozen worker(s)?\n\nThis reloads the extension service worker — the ONLY way to break a hung engine loop. Storage state (worker id, config, claimed jobs, pending pushes) is preserved. Reconnect alone can't fix this because it doesn't abort a hung await.`)) return;
    let sent = 0;
    for (const w of frozen) {
      try { await api.commandsSend(w.worker_id, 'hard_reset', {}); sent++; } catch {}
    }
    toast(`Hard-reset sent to ${sent} worker(s). Extension SWs will reload within ~30s (next command-poll tick).`, 'info', { title: 'Hard reset broadcast' });
    setTimeout(refreshDashboard, 5000);
  });
}

// Fleet delegation — attached to DOCUMENT, not #workerGrid. Absolutely
// bulletproof: even if a parent card gets recreated, or #workerGrid is
// re-rendered from scratch by some other code path, the listener still
// catches the click. Scoped to elements inside .worker-actions or the
// worker-id filter anchor so it doesn't intercept unrelated clicks.
let _fleetDelegationWired = false;
function wireFleetDelegation(_ignoredRoot) {
  if (_fleetDelegationWired) return;
  _fleetDelegationWired = true;
  document.addEventListener('click', async (e) => {
    // Only handle clicks INSIDE the fleet card. Cheap guard prevents any
    // interference with the rest of the page.
    if (!e.target.closest?.('#workerGrid')) return;
    // Worker-id filter link (clicking the worker id under the fleet).
    const filterA = e.target.closest?.('a[data-filter-worker]');
    if (filterA) {
      e.preventDefault();
      const w = filterA.dataset.filterWorker;
      state.workerFilter = w;
      saveUI({ workerFilter: w });
      const sel = $('activityWorkerFilter'); if (sel) sel.value = w;
      const sub = $('activityLogSub'); if (sub) sub.textContent = `filtered to ${w}`;
      toast(`Activity log now scoped to ${w}`, 'info');
      refreshDashboard();
      return;
    }
    const btn = e.target.closest?.('button');
    if (!btn) return;
    const workerId = btn.dataset.worker;
    if (!workerId) return;
    // Monitor 🖥 button
    if (btn.dataset.monitor) {
      openWorkerMonitor(workerId);
      return;
    }
    // Command buttons (wake / reconnect / pause / stop)
    if (btn.dataset.cmd) {
      const cmd = btn.dataset.cmd;
      const cmdLabel = { wake: 'Wake', reconnect: 'Force reconnect', pause: 'Pause', release_claims: 'Release claims from', stop: 'Stop' }[cmd] || cmd;
      if (cmd === 'stop' && !confirm(`Stop worker ${workerId} and disarm it? They will not claim more work until you send Wake.`)) return;
      try { await api.commandsSend(workerId, cmd); toast(`${cmdLabel} → ${workerId}`, 'ok'); }
      catch (err) { toast(err.message, 'err', { title: 'Command failed' }); }
      return;
    }
    // Release-claims ↻
    if (btn.dataset.releaseWorker) {
      const wid = btn.dataset.releaseWorker;
      if (!confirm(`Release all claims held by ${wid}? Those SKUs go back to pending immediately.`)) return;
      try {
        const r = await api.jobsReleaseByWorker(wid);
        toast(`Released ${r.released} SKU(s) from ${wid} — other workers can now claim them.`, 'ok', { title: '↻ Claims released' });
        refreshDashboard();
      } catch (err) { toast(err.message, 'err', { title: 'Release failed' }); }
      return;
    }
    // Remove-worker 🗑
    if (btn.dataset.removeWorker) {
      const w = state.workers.find(x => x.worker_id === workerId);
      const hbAgo = w?.last_heartbeat ? Math.round((Date.now() - Number(w.last_heartbeat)) / 60000) : null;
      const hbMsg = hbAgo == null ? 'never heartbeat' : `${hbAgo} min ago`;
      if (!confirm(`Remove worker "${workerId}" from the fleet roster?\n\nLast heartbeat: ${hbMsg}\n\nDoes NOT affect its jobs — if it's holding claims, release them first (↻ button).`)) return;
      try {
        const r = await api.deleteWorker(workerId);
        toast(`Removed ${workerId}${r.deleted ? '' : ' (was already gone)'}`, 'ok');
        refreshDashboard();
      } catch (err) { toast(err.message, 'err', { title: 'Remove failed' }); }
      return;
    }
    // Wake-on-LAN 🔌
    if (btn.dataset.wol) {
      try {
        const r = await api.wakeOnLan(workerId);
        toast(`Magic packet sent to ${r.mac}. PC should wake in 10-30s if WOL enabled in BIOS.`, 'ok', { title: 'WOL sent' });
      } catch (err) {
        if (err.status === 400 && /no MAC available/.test(err.message)) {
          const mac = prompt(`No MAC stored for ${workerId}. Enter the MAC (e.g. AA:BB:CC:DD:EE:FF):\n\n(Find it on the worker PC with:  ipconfig /all)`);
          if (!mac) return;
          try {
            await api.setWorkerMac(workerId, mac);
            const r2 = await api.wakeOnLan(workerId);
            toast(`MAC saved + WOL sent (${r2.mac})`, 'ok', { title: 'WOL sent' });
          } catch (e2) { toast(e2.message, 'err', { title: 'WOL failed' }); }
        } else {
          toast(err.message, 'err', { title: 'WOL failed' });
        }
      }
      return;
    }
    // Recovery guide ?
    if (btn.dataset.recover) {
      const w = state.workers.find(x => x.worker_id === workerId);
      const hb = Number(w?.last_heartbeat || 0);
      const ago = hb ? Math.round((Date.now() - hb) / 60000) : Infinity;
      const macKnown = !!(w?.mac_address);
      const online = ago < 3;
      const lines = [];
      lines.push(`▸ ${workerId}`);
      lines.push(hb ? `Last heartbeat: ${ago} min ago${online ? '' : ' — OFFLINE'}` : 'Never heartbeated');
      lines.push(`MAC on file: ${macKnown ? w.mac_address : 'NO'}`);
      lines.push('');
      lines.push('Manager commands (Wake / Reconnect / Pause / Stop /');
      lines.push('hard_reset) are POLLED by the worker every 30 s.');
      lines.push('If the SW is dead, no command can reach it.');
      lines.push('');
      lines.push('Recovery order (try in sequence):');
      lines.push('');
      if (online) {
        lines.push('  1. ⟳ Force reconnect — overrides user-Stopped flag');
        lines.push('  2. hard_reset (Frozen banner) — reloads the SW');
        lines.push('     if the engine loop is hung');
      } else {
        if (macKnown) {
          lines.push('  1. 🔌 WoL — sends magic packet. Requires WoL enabled');
          lines.push('     in BIOS + manager on same physical LAN + PC');
          lines.push('     asleep (not powered off from mains).');
        } else {
          lines.push('  1. Set MAC first (click 🔌 → enter MAC), then WoL.');
          lines.push('     Find MAC on the worker PC with: ipconfig /all');
        }
        lines.push('  2. Chrome watchdog task (installed by install-worker.ps1)');
        lines.push('     auto-launches Chrome every 5 min IF manager is');
        lines.push('     reachable. If never installed on this PC, you');
        lines.push('     need to re-run the install-worker one-liner.');
        lines.push('  3. Physical / RDP access — open Chrome with the');
        lines.push('     AdBrain profile. Extension auto-arms.');
      }
      lines.push('');
      lines.push('Once Chrome + SW are alive again, all manager commands');
      lines.push('start working within 30 s (next command-poll tick).');
      alert(lines.join('\n'));
      return;
    }
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
    // Shopify creds — token echoed back masked, domain visible. Default
    // shop domain to 'dropy.in' when nothing is stored yet, so users only
    // need to paste the admin API token to configure.
    const sh = cfg.shopify || {};
    if ($('cfgShopifyDomain')) $('cfgShopifyDomain').value = sh.shopDomain || 'dropy.in';
    if ($('cfgShopifyToken'))  $('cfgShopifyToken').value  = sh.adminToken ? '•'.repeat(Math.min(sh.adminToken.length, 32)) : '';
    if ($('cfgShopifyApiVersion')) $('cfgShopifyApiVersion').value = sh.apiVersion || '';
    const statusSub = $('shopifyStatusSub');
    if (statusSub) statusSub.textContent = (sh.shopDomain && sh.adminToken) ? `configured (${sh.shopDomain})` : 'not configured';
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
// Shopify config save/clear/test.
$('cfgShopifySaveBtn')?.addEventListener('click', async () => {
  const btn = $('cfgShopifySaveBtn');
  const domain = $('cfgShopifyDomain').value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const tokenRaw = $('cfgShopifyToken').value.trim();
  const apiVersion = $('cfgShopifyApiVersion').value.trim() || '2024-10';
  if (!domain) { setResult($('cfgShopifyResult'), 'Shop domain required.', 'warn'); return; }
  const preserveToken = /^•+$/.test(tokenRaw);
  const patch = { shopify: { shopDomain: domain, apiVersion } };
  if (!preserveToken) patch.shopify.adminToken = tokenRaw;
  else {
    const cur = await api.configGet().catch(() => ({ config: {} }));
    patch.shopify.adminToken = cur.config?.shopify?.adminToken || '';
  }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  setResult($('cfgShopifyResult'), 'Saving…', 'info');
  try {
    await api.configPatch(patch);
    setResult($('cfgShopifyResult'), `✓ Saved for ${domain}. Token ${preserveToken ? 'preserved' : 'updated'}. API version ${apiVersion}.`, 'ok');
    toast('Shopify config saved.', 'ok');
    $('shopifyStatusSub').textContent = `configured (${domain})`;
  } catch (e) {
    setResult($('cfgShopifyResult'), `Save failed: ${e.message}`, 'err');
    toast(e.message, 'err');
  } finally { btn.disabled = false; btn.textContent = orig; }
});
$('cfgShopifyClearBtn')?.addEventListener('click', async () => {
  if (!confirm('Clear Shopify credentials from the manager? The Analytics "Shopify update" flow will stop working until you re-enter them.')) return;
  try {
    await api.configPatch({ shopify: null });
    $('cfgShopifyDomain').value = '';
    $('cfgShopifyToken').value  = '';
    $('cfgShopifyApiVersion').value = '';
    $('shopifyStatusSub').textContent = 'not configured';
    setResult($('cfgShopifyResult'), '✓ Cleared.', 'ok');
  } catch (e) { setResult($('cfgShopifyResult'), `Clear failed: ${e.message}`, 'err'); }
});
$('cfgShopifyTestBtn')?.addEventListener('click', async () => {
  const el = $('cfgShopifyTestResult');
  const btn = $('cfgShopifyTestBtn');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Testing…';
  el.textContent = 'testing…';
  el.style.color = 'var(--text-2)';
  try {
    // Ping Shopify with a bogus handle. If creds are valid we get a 404
    // "no such handle" from OUR server (after Shopify replied 200 with
    // empty products list). If auth fails, we get a Shopify 401 error.
    await api.shopifyGetProduct('https://x/products/__connection_test__' + Date.now());
    el.textContent = '✓ connected (product also exists)';
    el.style.color = 'var(--success)';
    setResult($('cfgShopifyResult'), '✓ Shopify auth verified.', 'ok');
  } catch (e) {
    if (String(e.message).includes('no Shopify product with handle')) {
      el.textContent = '✓ connected — auth OK';
      el.style.color = 'var(--success)';
      setResult($('cfgShopifyResult'), '✓ Shopify auth verified. Try a real SKU from Analytics.', 'ok');
    } else {
      el.textContent = `✗ ${e.message.slice(0, 60)}`;
      el.style.color = 'var(--danger)';
      setResult($('cfgShopifyResult'), `✗ Connection failed: ${e.message}`, 'err');
    }
  } finally { btn.disabled = false; btn.textContent = orig; }
});

// SKU-lookup diagnostic — runs the same 3-round GraphQL search as the
// bulk upload for ONE SKU. Prettifies the raw Shopify response so the
// user can see exactly what came back.
$('cfgShopifyDiagBtn')?.addEventListener('click', async () => {
  const sku = ($('cfgShopifyDiagSku').value || '').trim();
  const box = $('cfgShopifyDiagResult');
  if (!sku) { box.innerHTML = `<div class="banner warn">Enter a SKU first, e.g. <code>Dropy-B002OTT3US</code></div>`; return; }
  const btn = $('cfgShopifyDiagBtn');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Running…';
  box.innerHTML = `<div class="hint">Querying Shopify…</div>`;
  try {
    const r = await api.shopifyDebugLookup(sku);
    const roundsHtml = (r.rounds || []).map(rd => `
      <div style="margin-top: 8px; padding: 8px; background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;">
        <div style="font-family: var(--mono); font-size: 11px; color: var(--text-1);"><strong>${esc(rd.label)}</strong> · <span style="color: var(--text-3);">${rd.elapsedMs}ms · HTTP ${rd.shopifyStatus} · returned ${rd.returnedCount}</span></div>
        ${rd.firstExactMatch ? `<div style="margin-top: 4px; color: var(--success); font-size: 12px;">✓ EXACT MATCH → <strong>${esc(rd.firstExactMatch.product.title || '(no title)')}</strong> <code style="font-size: 10px;">${esc(rd.firstExactMatch.product.handle)}</code></div>` : ''}
        ${rd.returned && rd.returned.length ? `<details style="margin-top: 4px;">
          <summary style="cursor: pointer; font-size: 11px; color: var(--text-3);">Returned ${rd.returned.length} variant(s)</summary>
          <table class="tbl compact" style="margin-top: 4px; font-size: 10px;">
            <thead><tr><th>Match?</th><th>SKU</th><th>Barcode</th><th>Product</th></tr></thead>
            <tbody>${rd.returned.map(v => `
              <tr>
                <td>${v.exactMatch ? '<span style="color:var(--success);">✓</span>' : '<span style="color:var(--danger);">✗</span>'}</td>
                <td class="mono">${esc(v.sku || '—')}</td>
                <td class="mono">${esc(v.barcode || '—')}</td>
                <td>${esc(v.product?.title || '')} <code style="font-size:9px; color:var(--text-3);">${esc(v.product?.handle || '')}</code></td>
              </tr>`).join('')}</tbody>
          </table>
        </details>` : ''}
        <details style="margin-top: 4px;"><summary style="cursor: pointer; font-size: 10px; color: var(--text-3);">GraphQL query sent</summary>
          <pre style="margin: 4px 0 0 0; padding: 6px; background: var(--bg-input); border: 1px solid var(--line-1); border-radius: 3px; font-size: 10px; color: var(--text-2); white-space: pre-wrap; word-break: break-all;">${esc(rd.graphqlQuery)}</pre>
        </details>
      </div>`).join('');
    box.innerHTML = `
      <div class="banner ${r.conclusion?.startsWith('MATCH') ? 'ok' : 'warn'}" style="margin-top: 0;">
        <strong>Input:</strong> <code>${esc(r.input)}</code> · <strong>ASIN:</strong> <code>${esc(r.parsedAsin || '(none)')}</code> · <strong>Shop:</strong> <code>${esc(r.shopifyDomain)}</code>
        <div style="margin-top: 6px;"><strong>Conclusion:</strong> ${esc(r.conclusion || '(none)')}</div>
      </div>
      ${roundsHtml}
      ${r.handleRound ? `<div style="margin-top: 8px; padding: 8px; background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;">
        <div style="font-family: var(--mono); font-size: 11px;"><strong>handle:*${esc(r.handleRound.asin)}*</strong> · <span style="color: var(--text-3);">returned ${r.handleRound.returned?.length || 0}</span></div>
        ${r.handleRound.returned?.length ? `<table class="tbl compact" style="margin-top: 4px; font-size: 10px;">
          <thead><tr><th>Match?</th><th>Handle</th><th>Title</th></tr></thead>
          <tbody>${r.handleRound.returned.map(v => `
            <tr>
              <td>${v.matchesAsin ? '<span style="color:var(--success);">✓</span>' : '<span style="color:var(--danger);">✗</span>'}</td>
              <td class="mono">${esc(v.handle)}</td>
              <td>${esc(v.title || '')}</td>
            </tr>`).join('')}</tbody>
        </table>` : ''}
      </div>` : ''}`;
  } catch (e) {
    box.innerHTML = `<div class="banner err">Diagnostic failed: ${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = orig; }
});

// ═══════════════════════════════════════════════════════════════
//  Selective wipe modal
// ═══════════════════════════════════════════════════════════════
async function openSelectiveWipeModal() {
  // Populate batch scope + live counts.
  const sel = $('wipeBatchScope');
  sel.innerHTML = '<option value="">— all batches (global) —</option>' +
    (state.batches || []).map(b => `<option value="${esc(b.batch_id)}">${esc(b.batch_id)} · ${b.total} SKU</option>`).join('');
  $('wipeConfirmInput').value = '';
  $('wipeGoBtn').disabled = true;
  $('wipeResult').innerHTML = '';
  document.querySelectorAll('#wipeChecklist input[type=checkbox]').forEach(cb => cb.checked = false);
  document.querySelectorAll('.wipe-count').forEach(sp => sp.textContent = '—');
  $('wipeModal').style.display = 'flex';
  await refreshWipeCounts();
  // Refresh counts on scope change.
  sel.onchange = refreshWipeCounts;
}
async function refreshWipeCounts() {
  const batchId = $('wipeBatchScope').value || null;
  try {
    const [summary, orphans, failed] = await Promise.all([
      api.jobsSummary().catch(() => ({ batches: [] })),
      api.keywordsOrphans().catch(() => ({ orphanCount: 0 })),
      api.failedJobs(batchId).catch(() => ({ rows: [] })),
    ]);
    // Jobs + keywords + activity: derive from summary if scoped, else sum.
    let jobs = 0, keywords = 0, activity = '?';
    if (batchId) {
      const b = (summary.batches || []).find(x => x.batch_id === batchId);
      if (b) { jobs = b.total || 0; }
      // Keyword count per batch requires the /api/keywords endpoint,
      // avoid it for perf — leave a hint.
      keywords = '?';
      activity = '?';
    } else {
      jobs = (summary.batches || []).reduce((a, b) => a + (b.total || 0), 0);
      keywords = '?';
      activity = '?';
    }
    setWipeCount('jobs', jobs);
    setWipeCount('keywords', keywords);
    setWipeCount('activity', activity);
    setWipeCount('failedJobsOnly', (failed.rows || []).length);
    setWipeCount('orphansOnly', orphans.orphanCount ?? '?');
    // Global-only rows: disable when a batch is selected.
    document.querySelectorAll('#wipeChecklist .wipe-global input[type=checkbox]').forEach(cb => {
      cb.disabled = !!batchId;
      if (batchId) cb.checked = false;
    });
    document.querySelectorAll('#wipeChecklist .wipe-global').forEach(row => {
      row.style.opacity = batchId ? '0.4' : '1';
    });
    setWipeCount('commands', '(global)');
    setWipeCount('workers', '(global)');
  } catch (e) { /* ignore */ }
}
function setWipeCount(flag, val) {
  const el = document.querySelector(`.wipe-count[data-count="${flag}"]`);
  if (el) el.textContent = typeof val === 'number' ? `~${val.toLocaleString()}` : String(val);
}
$('openSelectiveWipeBtn')?.addEventListener('click', openSelectiveWipeModal);
$('wipeConfirmInput')?.addEventListener('input', () => {
  const anyChecked = [...document.querySelectorAll('#wipeChecklist input[type=checkbox]:checked')].length > 0;
  $('wipeGoBtn').disabled = !(anyChecked && $('wipeConfirmInput').value === 'WIPE');
});
document.querySelectorAll('#wipeChecklist input[type=checkbox]').forEach(cb => {
  cb.addEventListener('change', () => {
    const anyChecked = [...document.querySelectorAll('#wipeChecklist input[type=checkbox]:checked')].length > 0;
    $('wipeGoBtn').disabled = !(anyChecked && $('wipeConfirmInput').value === 'WIPE');
  });
});
$('wipeGoBtn')?.addEventListener('click', async () => {
  const flags = {};
  document.querySelectorAll('#wipeChecklist input[type=checkbox]:checked').forEach(cb => {
    flags[cb.dataset.flag] = true;
  });
  const batchId = $('wipeBatchScope').value || null;
  const scopeLabel = batchId ? `batch ${batchId}` : 'ALL batches';
  const flagList = Object.keys(flags).join(', ');
  if (!confirm(`Wipe [${flagList}] from ${scopeLabel}? This cannot be undone.`)) return;
  try {
    const r = await api.wipeSelective(flags, batchId);
    const parts = [];
    if (r.deletedJobs)       parts.push(`${r.deletedJobs} jobs`);
    if (r.deletedKeywords)   parts.push(`${r.deletedKeywords} keywords`);
    if (r.deletedActivity)   parts.push(`${r.deletedActivity} activity`);
    if (r.deletedCommands)   parts.push(`${r.deletedCommands} commands`);
    if (r.deletedWorkers)    parts.push(`${r.deletedWorkers} workers`);
    if (r.deletedFailedJobs) parts.push(`${r.deletedFailedJobs} failed jobs`);
    if (r.deletedOrphans)    parts.push(`${r.deletedOrphans} orphans`);
    const msg = parts.length ? parts.join(' · ') : 'nothing matched — no rows deleted.';
    $('wipeResult').innerHTML = `<div class="hint" style="color: var(--success);">✓ ${msg}</div>`;
    toast(msg, 'ok', { title: 'Wiped' });
    $('wipeConfirmInput').value = '';
    $('wipeGoBtn').disabled = true;
    document.querySelectorAll('#wipeChecklist input[type=checkbox]').forEach(cb => cb.checked = false);
    await loadConfigForm();
  } catch (e) {
    $('wipeResult').innerHTML = `<div class="hint" style="color: var(--danger);">Wipe failed: ${e.message}</div>`;
    toast(e.message, 'err', { title: 'Wipe failed' });
  }
});
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
  if (await copyToClipboard(state.setupCode)) {
    $('copySetupBtn').textContent = '✓ Copied';
    setTimeout(() => $('copySetupBtn').textContent = 'Copy', 1500);
  } else {
    alert('Clipboard blocked. Select the code above and Ctrl+C.');
  }
});
$('copyInstallBtn')?.addEventListener('click', async () => {
  const cmd = $('installOneLiner').textContent;
  if (await copyToClipboard(cmd)) {
    $('copyInstallBtn').textContent = '✓ Copied';
    setTimeout(() => $('copyInstallBtn').textContent = 'Copy', 1500);
  } else {
    alert('Clipboard blocked. Select the command and Ctrl+C manually.');
  }
});
$('copyUninstallBtn')?.addEventListener('click', async () => {
  const cmd = $('uninstallOneLiner').textContent;
  if (await copyToClipboard(cmd)) {
    $('copyUninstallBtn').textContent = '✓ Copied';
    setTimeout(() => $('copyUninstallBtn').textContent = 'Copy', 1500);
  } else {
    alert('Clipboard blocked. Select the command and Ctrl+C manually.');
  }
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
  // Live-refresh loop — polls the currently selected batch every 4s so
  // Analytics reflects new SKUs the moment their keyword rows land at the
  // manager, instead of the user having to wait for the whole batch to
  // finish and click Refresh. Started when the tab activates + a batch is
  // loaded; stopped when the tab is left.
  liveTimer: null,
  liveIntervalMs: 4000,
  liveInFlight: false,
  // Fingerprint of the last-rendered dataset — used to skip the re-render
  // when nothing changed, so filters/scroll/sort don't reset every 4s.
  lastFingerprint: '',
  // Incremental fetch cursor — highest keyword row.id seen so far. Each
  // live-poll tick sends ?sinceId=<lastMaxId>, server returns only NEW
  // rows. Slashes bandwidth 20-100x on batches that have grown past a
  // few hundred rows. Reset to 0 on batch switch.
  lastMaxId: 0,
  // Same idea for the jobs-per-product tree — track the highest changed_at
  // timestamp seen so we can ask the server for only rows that have moved
  // since. Server-side query filters by MAX(done_at, heartbeat_at, claimed_at)
  // so this catches new claims / new dones / new heartbeats (which mark
  // active work) without re-sending the whole 5000-row tree every tick.
  lastPerProductChangedAt: 0,
  // Client-side cache of the full jobs list keyed by job id. Populated by
  // a full refresh at boot/batch-switch/every-5th-tick and updated in place
  // by incremental deltas.
  perProductById: new Map(),
  // Tick counter for the periodic full-refresh safety net. Every N ticks
  // we do a from-scratch fetch instead of incremental, so rare edits /
  // deletes / server-side dedupe merges eventually reconcile client-side.
  tickCount: 0,
  fullRefreshEvery: 5, // every 5th tick = 20s at the 4s cadence
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
  // Cross-filter state — any chip/slice/row click adds a filter here and
  // the whole dashboard re-renders against the narrowed set. Cleared via
  // the active-filters bar or the "Clear all" button.
  xFilter: {
    sources: new Set(),   // primary-source names (uppercase): {'KP_IDEA', 'AUTOSUGGEST', ...}
    intents: new Set(),   // 'high' | 'medium' | 'low' | 'informational'
    tiers:   new Set(),   // 'excellent' | 'good' | 'ok' | 'low'
    themes:  new Set(),   // theme keys from KW_THEMES
  },
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
  { group: 'kp',   key: 'kp_monthly_searches', label: 'Vol/mo',    kind: 'num',   tip: 'Google Keyword Planner monthly searches. Real search demand — the closer this is to reality, the more trustworthy the Score column.' },
  { group: 'kp',   key: 'kp_competition',    label: 'KP comp',    kind: 'comp',  tip: 'KP competition (Low / Medium / High). Low = cheap to rank & bid; High = crowded auction.' },
  { group: 'kp',   key: 'kp_bid_low',        label: 'Bid low',    kind: 'money', tip: 'Google KP low-range top-of-page bid (₹). Cheapest you can realistically show at the top of paid results.' },
  { group: 'kp',   key: 'kp_bid_high',       label: 'Bid high',   kind: 'money', tip: 'Google KP high-range top-of-page bid (₹). Upper end of what competitors are paying.' },
  // ─── Image match ────────────────────────────────────────────────
  { group: 'image', key: 'image_count',           label: 'Imgs',      kind: 'imgs', tip: 'Number of SERP images that matched our product visually (CLIP + dHash). Higher = more visual visibility on Google.' },
  { group: 'image', key: 'total_thumbs',          label: 'SERP imgs', kind: 'num',  tip: 'Total thumbnails captured on this keyword\'s SERP (matched + unmatched). Denominator for Vis%.' },
  { group: 'image', key: 'visibility_pct',        label: 'Vis %',     kind: 'pct',  tip: 'Visibility percentage = Imgs / SERP imgs. What fraction of the visual SERP is our product.' },
  { group: 'image', key: 'match_confidence_max', label: 'Match ↑',   kind: 'num',  tip: 'Highest per-image CLIP similarity score on this keyword (0-100). Above ~72 = confident match.' },
  { group: 'image', key: 'link_checked_count',   label: 'Links ✓',   kind: 'num',  tip: 'How many matched destination pages we opened to re-verify the product actually lives there.' },
  { group: 'image', key: 'link_verified_count',  label: 'Links ok',  kind: 'num',  tip: 'How many of those re-verifications confirmed our product on the destination page.' },
  // ─── Sellers & SERP presence ────────────────────────────────────
  { group: 'sellers', key: 'total_sellers',   label: 'Sellers',     kind: 'num',   tip: 'Distinct sellers listing this SKU (or a similar one) across the SERP. Higher = deeper marketplace supply.' },
  { group: 'sellers', key: 'ads_on_serp',     label: 'Ads seen',    kind: 'num',   tip: 'Number of paid ads on this keyword\'s SERP. 0 = no advertisers found value here (yet).' },
  { group: 'sellers', key: 'dropy_is_seller', label: 'Dropy sells', kind: 'yesno', tip: 'Does dropy.in list this exact product as a seller on the SERP\'s Shopping/organic block? ✓ = protected position.' },
  { group: 'sellers', key: 'dropy_on_serp',   label: 'Dropy shown', kind: 'yesno', tip: 'Does dropy.in appear anywhere on this SERP (not necessarily as the seller)?' },
  { group: 'sellers', key: 'top_match_seller',label: 'Top seller',  kind: 'text',  tip: 'Domain of the seller behind the highest-confidence image match.' },
  { group: 'sellers', key: 'top_match_price', label: 'Top price',   kind: 'text',  tip: 'Price shown by the top-match seller (raw, no currency normalization).' },
  { group: 'sellers', key: 'frequency',       label: 'Sources',     kind: 'num',   tip: 'How many discovery sources found this keyword (KP / autosuggest / SERP / PAA / related / amazon). Multi-source = stronger signal.' },
  // ─── Amazon (India Round 3) ─────────────────────────────────────
  { group: 'amazon', key: 'amazon_rank',           label: 'Amz rank',    kind: 'num',   tip: 'Our position on the Amazon.in search results for this keyword (1 = top).' },
  { group: 'amazon', key: 'amazon_price',          label: 'Amz price',   kind: 'text',  tip: 'Price observed on the Amazon.in listing (raw, no currency normalization).' },
  { group: 'amazon', key: 'amazon_rating',         label: 'Amz stars',   kind: 'num',   tip: 'Amazon.in product rating out of 5.' },
  { group: 'amazon', key: 'amazon_reviews',        label: 'Amz reviews', kind: 'num',   tip: 'Number of reviews on the Amazon.in listing.' },
  { group: 'amazon', key: 'amazon_suggest_count',  label: 'Amz suggest', kind: 'num',   tip: 'How many times this keyword appeared in Amazon.in autosuggest for related seeds.' },
  { group: 'amazon', key: 'amazon_total_results',  label: 'Amz total',   kind: 'num',   tip: 'Total matching results Amazon.in reports for this query — proxy for category size.' },
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

// ─────────── Analytics tree (left rail) ───────────
// Persists which batches are expanded across reloads. SKUs are lazy-
// loaded per batch — we cache the SKU list under state._treeSkuCache
// so re-expanding a batch doesn't re-fetch its keyword rows.
const _TREE_EXPANDED_KEY = 'adbrainAnTreeExpanded';
function _loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(_TREE_EXPANDED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _saveExpanded(set) {
  try { localStorage.setItem(_TREE_EXPANDED_KEY, JSON.stringify(Array.from(set))); } catch {}
}
async function renderAnalyticsTree() {
  const el = $('anRailTree');
  if (!el) return;
  const expanded = _loadExpanded();
  // Batches with jobs first, then orphan keyword-batches.
  const jobsBatchIds = new Set(state.batches.map(b => b.batch_id));
  const items = [
    ...state.batches.map(b => ({ id: b.batch_id, total: b.total || 0, done: b.done || 0, kind: 'jobs' })),
    ...(state.keywordBatches || []).filter(b => !jobsBatchIds.has(b.batch_id))
       .map(b => ({ id: b.batch_id, total: b.row_count || 0, kind: 'orphan' })),
  ];
  if (items.length === 0) {
    el.innerHTML = `<div class="tree-empty">No batches yet.<br>Upload some products to get started.</div>`;
    return;
  }
  // Apply search filter (case-insensitive, matches label + id).
  const q = ($('anRailSearch')?.value || '').toLowerCase().trim();
  const displayed = q ? items.filter(it => batchLabel(it.id).toLowerCase().includes(q) || it.id.toLowerCase().includes(q)) : items;
  el.innerHTML = displayed.map(it => {
    const isExp    = expanded.has(it.id);
    const isActive = it.id === analytics.batchId;
    const label    = batchLabel(it.id).split('  (')[0];  // strip "(id-tail)" if named
    const suffix   = it.kind === 'orphan' ? ' (orphan)' : '';
    return `
      <div class="tree-batch${isExp ? ' expanded' : ''}${isActive ? ' active' : ''}" data-batch="${esc(it.id)}">
        <span class="tree-caret">▶</span>
        <span class="tree-name" title="${esc(it.id)}">${esc(label)}${suffix}</span>
        <span class="tree-count">${it.total}</span>
      </div>
      <div class="tree-skus" data-skus-for="${esc(it.id)}">
        ${isExp ? _renderTreeSkusCached(it.id) : ''}
      </div>`;
  }).join('');
  // Wire batch clicks — toggle expand + select as active batch.
  el.querySelectorAll('.tree-batch').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const bid = btn.dataset.batch;
      const expNow = _loadExpanded();
      const clickedCaret = e.target.classList?.contains('tree-caret');
      // Caret click ALWAYS toggles expand (no side-effects on selection).
      // Anywhere else on the row selects the batch WITHOUT touching
      // expand state — users said batches shouldn't auto-expand.
      if (clickedCaret) {
        if (expNow.has(bid)) expNow.delete(bid); else expNow.add(bid);
        _saveExpanded(expNow);
        // Also load the batch if we're expanding an unloaded one — SKUs
        // come from analytics.allRows which requires loadAnalyticsBatch.
        if (expNow.has(bid) && analytics.batchId !== bid) {
          analytics.batchId = bid;
          analytics.sku = '';
          $('anBatchSelect').value = bid;
          await loadAnalyticsBatch(bid);
        }
        await renderAnalyticsTree();
        return;
      }
      // Row click (not caret): select only. Batch stays collapsed.
      if (bid !== analytics.batchId) {
        analytics.batchId = bid;
        analytics.sku = '';
        $('anBatchSelect').value = bid;
        await loadAnalyticsBatch(bid);
        await renderAnalyticsTree();
      }
    });
  });
  // Wire SKU clicks — select this SKU.
  el.querySelectorAll('.tree-sku').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sku = btn.dataset.sku;
      analytics.sku = sku;
      const sel = $('anSkuSelect'); if (sel) sel.value = sku;
      filterAndRenderAnalytics();
      renderAnalyticsTree();
    });
  });
}
// Per-batch job list cache — populated by loadAnalyticsBatch and reused
// by the tree renderer to show zero-kw SKUs alongside kw-rich ones.
const _treeJobCache = new Map();

function _renderTreeSkusCached(batchId) {
  // Only render SKUs if we've loaded them into analytics.allRows already.
  // Otherwise return a placeholder — loadAnalyticsBatch() populates it,
  // and the next renderAnalyticsTree() call picks it up.
  if (analytics.batchId !== batchId || !analytics.allRows.length) {
    return `<div class="tree-empty" style="padding: 6px 8px; font-size: 10px;">Select this batch to load its SKUs.</div>`;
  }
  // Group allRows by SKU key — these are SKUs that produced keywords.
  const bySku = new Map();
  for (const r of analytics.allRows) {
    const key = r.sku || r.product_url || 'unknown';
    if (!bySku.has(key)) bySku.set(key, { key, name: r.product_name || '', count: 0, status: 'done' });
    bySku.get(key).count++;
  }
  // Merge in ALL jobs from the batch — includes SKUs marked done/failed
  // that produced ZERO keyword rows. Without this, the "21 done" stat
  // vs "12 SKUs in tree" mismatch is invisible to users.
  const jobs = _treeJobCache.get(batchId) || [];
  for (const j of jobs) {
    const key = j.sku || j.product_url || 'unknown';
    if (!bySku.has(key)) {
      bySku.set(key, {
        key, name: j.product_name || '', count: 0, status: j.status || 'pending',
      });
    } else {
      // enrich with job status so we know done vs failed
      const rec = bySku.get(key);
      if (!rec.status || rec.status === 'done') rec.status = j.status || rec.status;
    }
  }
  const skus = Array.from(bySku.values()).sort((a, b) => b.count - a.count);
  if (skus.length === 0) return `<div class="tree-empty" style="padding:6px 8px; font-size:10px;">No SKUs.</div>`;
  return skus.map(s => {
    const isActive = s.key === analytics.sku;
    const display = s.name || s.key;
    const zeroKw = s.count === 0;
    // Zero-kw SKUs get a warn tint + status suffix so the user can see
    // exactly which SKUs completed but produced nothing.
    const statusTag = zeroKw
      ? `<span class="tree-sku-zero" title="This SKU completed with 0 keyword rows — usually KP failed or every candidate was filtered out.">${esc(s.status || 'done')} · 0</span>`
      : `<span class="tree-sku-count">${s.count}</span>`;
    return `
      <div class="tree-sku${isActive ? ' active' : ''}${zeroKw ? ' zero-kw' : ''}" data-sku="${esc(s.key)}" title="${esc(display)}${zeroKw ? ' (0 keyword rows produced)' : ''}">
        <span class="tree-sku-name">${esc(display)}</span>
        ${statusTag}
      </div>`;
  }).join('');
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
    updatePickerHints();
    if (analytics.batchId && $('anBatchSelect')) $('anBatchSelect').value = analytics.batchId;
    // Auto-select: if there's exactly one batch and none is chosen yet,
    // pick it. Removes the confusing "Waiting for input" empty state
    // when there's only one obvious batch to look at.
    if (!analytics.batchId && state.batches.length === 1) {
      analytics.batchId = state.batches[0].batch_id;
      if ($('anBatchSelect')) $('anBatchSelect').value = analytics.batchId;
    }
    await renderAnalyticsTree();
  } catch {}
  if (analytics.batchId) { await loadAnalyticsBatch(analytics.batchId); renderAnalyticsTree(); }
}
// Rail search — re-render tree on every keystroke.
document.addEventListener('DOMContentLoaded', () => {
  $('anRailSearch')?.addEventListener('input', renderAnalyticsTree);
});

// Picker hint updater — keeps the "N batches available" label live.
// Previously we had two more preview blocks here (batch-stats preview +
// SKU-preview) and a quick-batch chip row; all deleted as unwanted
// duplicates of what the hero + batch dropdown already show.
function updatePickerHints() {
  const bh = $('anBatchHint');
  if (bh) {
    const n = state.batches.length + (state.keywordBatches || []).filter(b => !state.batches.find(j => j.batch_id === b.batch_id)).length;
    bh.textContent = n === 0 ? 'no batches yet' : `${n} batch${n === 1 ? '' : 'es'} available`;
  }
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

// One-time repair: clear any stale rail-collapse flag from earlier
// versions that had a collapse toggle. Users who clicked collapse
// before we removed the feature would otherwise see a broken layout
// with rail fragments visible on the left edge on next visit.
try { localStorage.removeItem('adbrainAnRailCollapsed'); } catch {}
try { document.querySelector('.an-layout')?.classList.remove('rail-collapsed'); } catch {}
$('anBatchSelect').addEventListener('change', async () => {
  analytics.batchId = $('anBatchSelect').value;
  analytics.sku = '';
  updatePickerHints();
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

  // High-intent + question-shaped keyword pools — feeds specific sections
  // of the prompt so the model has raw material for TITLE (high-intent),
  // FAQs (questions), and SEO keywords (top-scored).
  const highIntentPool = scored.filter(r => String(r.buying_intent || '').toLowerCase() === 'high').slice(0, 15);
  const dropySellerRows = scored.filter(r => String(r.dropy_is_seller || '').toLowerCase() === 'yes').length;
  const imgMatchRows    = scored.filter(r => (toNum(r.image_count) || 0) > 0).length;

  const lines = [];

  // ── ROLE ─────────────────────────────────────────────────────────
  lines.push('# ROLE');
  lines.push('You are a senior e-commerce copywriter and SEO strategist for **Dropy.in**, a Shopify store selling to India (INR, pan-India shipping). You write conversion-optimized product listings that rank organically AND perform in Google Search Ads. You are precise about facts (never fabricated), disciplined about keyword usage (natural, not stuffed), and result-oriented (every section serves a measurable purpose: rank, CTR, conversion, AOV).');
  lines.push('');

  // ── PRODUCT ──────────────────────────────────────────────────────
  lines.push('# PRODUCT');
  lines.push(`- **Name**: ${productName}`);
  if (sku)        lines.push(`- **SKU**: \`${sku}\``);
  if (productUrl) lines.push(`- **Live URL**: ${productUrl}`);
  if (productImg) lines.push(`- **Hero image**: ${productImg}`);
  if (batchId)    lines.push(`- **Research batch**: \`${batchId}\``);
  lines.push('');

  // ── DATA PROVENANCE ──────────────────────────────────────────────
  lines.push('# DATA PROVENANCE');
  lines.push('This brief is built from real crawler data collected against Google.in SERPs, Google Keyword Planner (KP), Google autosuggest, People-Also-Ask, and Amazon.in search + autosuggest. Every number below is a measurement, not an estimate. Trust the data over your general knowledge of the product category.');
  lines.push('');
  lines.push(`| Signal | Coverage | Notes |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Keywords collected      | **${scored.length}** rows | Target range 100–300 per SKU. |`);
  lines.push(`| KP monthly-volume rows  | ${volStat ? `${volStat.n} / ${scored.length}` : '0 / ' + scored.length} | ${volStat ? `Range ${volStat.min}–${volStat.max}, median ${volStat.med}` : 'No KP volume data available. Weight relevance + image-match signals instead of demand estimates.'} |`);
  lines.push(`| KP top-of-page bid ₹    | ${bidStat ? `${bidStat.n} rows, range ₹${bidStat.min}–${bidStat.max}, median ₹${bidStat.med}` : 'not available'} | ${bidStat ? 'Use as ads-budget benchmark.' : 'Fall back to Amazon-price band for pricing signal.'} |`);
  lines.push(`| Image match (visual SERP presence) | ${imgMatchRows} / ${scored.length} rows | Our product image was visually detected on ${imgMatchRows} SERPs — proven organic visibility. |`);
  lines.push(`| dropy.in listed as seller | ${dropySellerRows} SERPs | Existing marketplace positions to defend. |`);
  lines.push(`| Amazon.in observed prices ₹ | ${priceStat ? `${priceStat.n} rows, range ₹${priceStat.min}–${priceStat.max}, median ₹${priceStat.med}` : 'not available'} | ${priceStat ? 'Anchor MRP + strike-through pricing within this band.' : ''} |`);
  lines.push('');
  lines.push('**Discovery mix** (which channels found the keywords):');
  Object.entries(bySource).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    const pct = Math.round((v / scored.length) * 100);
    lines.push(`- \`${k}\`: ${v} rows (${pct}%)`);
  });
  lines.push('');
  lines.push('**Buying-intent distribution**:');
  ['high', 'medium', 'low', 'informational', 'unclassified'].forEach(k => {
    if (byIntent[k]) {
      const pct = Math.round((byIntent[k] / scored.length) * 100);
      lines.push(`- **${k}**: ${byIntent[k]} rows (${pct}%)`);
    }
  });
  lines.push('');
  if (topCompetitors.length) {
    lines.push('**Top competitor domains on our SERPs** (reference only — do NOT name them in copy):');
    topCompetitors.forEach(([d, n]) => lines.push(`- \`${d}\` — ${n} appearances`));
    lines.push('');
  }

  // ── TOP OPPORTUNITY KEYWORDS ─────────────────────────────────────
  lines.push(`# TOP ${topN.length} OPPORTUNITY KEYWORDS`);
  lines.push('Ranked by opportunity score (blends volume, competition, relevance, image-match, buying intent). Use in this priority order for TITLE, meta, and headings.');
  lines.push('');
  lines.push('| # | Keyword | Score | Vol/mo | KP comp | Intent | Imgs |');
  lines.push('|---|---|---|---|---|---|---|');
  topN.forEach((r, i) => {
    const vol = toNum(r.kp_monthly_searches);
    lines.push(`| ${i + 1} | ${r.keyword} | **${r.__s.toFixed(1)}** | ${vol && vol > 0 ? vol.toLocaleString() : '—'} | ${r.kp_competition || '—'} | ${r.buying_intent || '—'} | ${r.image_count || 0} |`);
  });
  lines.push('');

  // ── HIGH-INTENT POOL ─────────────────────────────────────────────
  if (highIntentPool.length) {
    lines.push('# HIGH-INTENT KEYWORDS (commercial / transactional)');
    lines.push('Reserve these for TITLE, first H2, and Google Ads headlines — they convert.');
    lines.push('');
    highIntentPool.forEach((r, i) => lines.push(`${i + 1}. ${r.keyword}`));
    lines.push('');
  }

  // ── FAQ SEED MATERIAL ────────────────────────────────────────────
  if (faqCandidates.length) {
    lines.push('# QUESTION-SHAPED QUERIES (seed material for FAQ block)');
    lines.push('These are real questions users searched. Answer them in the FAQ section — 1:1 mapping where possible so the page ranks for the exact query.');
    lines.push('');
    faqCandidates.forEach((r, i) => lines.push(`${i + 1}. ${r.keyword}`));
    lines.push('');
  }

  // ── DELIVERABLES ─────────────────────────────────────────────────
  lines.push('# DELIVERABLES');
  lines.push('Produce all 13 sections below **in this exact order**, each under a level-2 markdown heading (`## 1. TITLE` etc.). Follow character limits strictly — they map to how Google, Shopify, and Amazon truncate.');
  lines.push('');

  lines.push('## 1. TITLE  *(≤70 chars, Shopify/Google-optimized)*');
  lines.push('- Include the **#1 opportunity keyword** verbatim (or its closest natural form).');
  lines.push('- Structure: `Brand · Product-Type · Key-Attribute · Pack/Size`.');
  lines.push('- No ALL-CAPS, no emoji, no manufacturer trademark symbols.');
  lines.push('');

  lines.push('## 2. SUB-TITLE / SHORT DESCRIPTION  *(≤160 chars — meta description)*');
  lines.push('- One sentence, hook + core benefit + soft CTA.');
  lines.push('- Include the #1 keyword or a near variant.');
  lines.push('- End with a period, not an ellipsis.');
  lines.push('');

  lines.push('## 3. LONG DESCRIPTION  *(300–500 words)*');
  lines.push('Structure exactly:');
  lines.push('1. **Hook** (2–3 sentences): name the pain-point users described in the keyword data.');
  lines.push('2. **Solution** (1 short paragraph): what the product does, in plain language.');
  lines.push('3. **Benefits** (4–6 bullets): each starts with a verb, ends with the specific outcome.');
  lines.push('4. **Sensory / usage feel** (1 paragraph): texture, smell, look, "how it feels to use it".');
  lines.push('5. **Who it\'s for** (1 short paragraph): explicit audience segments.');
  lines.push('6. **Trust closer** (1 line): shipping / returns / support cue.');
  lines.push('- Weave the **top 5** opportunity keywords in naturally. No stuffing (no phrase should appear more than 3× total).');
  lines.push('');

  lines.push('## 4. INGREDIENTS  *(bulleted list, grouped)*');
  lines.push('- **Actives**: hero ingredients + one-sentence "why it matters" per item.');
  lines.push('- **Supporting cast**: everything else.');
  lines.push('- If the research data does **not** name specific ingredients, list `To be confirmed on packaging.` in each group — **do not invent ingredients**.');
  lines.push('');

  lines.push('## 5. HOW TO USE  *(numbered steps)*');
  lines.push('- Steps 1–N (typical 3–5). Quantify: "a pea-sized amount", "twice daily", etc.');
  lines.push('- If morning + night differ, note both explicitly.');
  lines.push('- Close with **Pro tip:** one line.');
  lines.push('');

  lines.push('## 6. FAQs  *(8–12 Q&A pairs)*');
  lines.push('- Use the **QUESTION-SHAPED QUERIES** above verbatim where possible.');
  lines.push('- 2–3 sentence answers. First sentence = direct answer. Second/third = supporting context.');
  lines.push('- Mark answers you can\'t verify from provided data as `[Confirm before publishing.]` — do not guess.');
  lines.push('');

  lines.push('## 7. SEO KEYWORDS  *(meta keywords — comma-separated single line)*');
  lines.push('- Include the **top 15** opportunity keywords verbatim.');
  lines.push('- Longtail phrases first, single-word tokens last.');
  lines.push('- India-first modifiers (e.g. "in india", "india price") where natural.');
  lines.push('');

  lines.push('## 8. GOOGLE SEARCH ADS  *(3 headlines + 2 descriptions)*');
  lines.push('- **Headlines** (3 variants, each ≤30 chars): H1 leads with #1 keyword; H2 emphasizes offer/price; H3 emphasizes trust/quality.');
  lines.push('- **Descriptions** (2 variants, each ≤90 chars): one benefit-led, one urgency-led.');
  lines.push('- Include ₹ pricing if bid data suggests a reasonable price point.');
  lines.push('- Every headline must contain at least one high-intent keyword from the pool above.');
  lines.push('');

  lines.push('## 9. AMAZON.IN LISTING BULLETS  *(exactly 5 bullets, ≤200 chars each)*');
  lines.push('- Each bullet starts with a **BENEFIT IN CAPS** (2–4 words), then a colon, then the supporting detail.');
  lines.push('- Weave in `chapstick`, size/pack, and target-user cues.');
  lines.push('- Match Amazon.in style (spec-forward, keyword-rich, minimal fluff).');
  lines.push('');

  lines.push('## 10. META TITLE + META DESCRIPTION  *(for Shopify page \\<head\\>)*');
  lines.push('- **Meta title** ≤60 chars — sharper than the on-page title; put brand at the end.');
  lines.push('- **Meta description** ≤155 chars — different phrasing than the sub-title; include a CTA.');
  lines.push('');

  lines.push('## 11. HANDLE / URL SLUG  *(≤50 chars, kebab-case, all-lowercase)*');
  lines.push('- Just the product identity — no promotional words, no ₹, no year.');
  lines.push('');

  lines.push('## 12. INTERNAL LINKING SUGGESTIONS  *(3–5)*');
  lines.push('- For each: a **suggested anchor text** (from the keyword data) + a plausible **target-page slug** (blog / category / related-product).');
  lines.push('- Prefer anchors from the informational + medium-intent buckets — high-intent stays on the product page.');
  lines.push('');

  lines.push('## 13. NEXT-STEP AUDIT  *(numbered checklist for the human reviewer)*');
  lines.push('- Concrete pre-publish checks: ingredient verification, price competitiveness vs Amazon band, image alt-text alignment with title, Merchant Center feed sync, Google Ads geo-targeting.');
  lines.push('- Each item begins with a verb. Under 15 items total.');
  lines.push('');

  // ── HARD CONSTRAINTS ─────────────────────────────────────────────
  lines.push('# HARD CONSTRAINTS');
  lines.push('- **India-first tone**. Currency ₹. Assume pan-India shipping.');
  lines.push('- **No invented claims**. Do not add "clinically proven", "dermatologist tested", certifications, awards, or specific test results unless the research data mentions them. If a claim is category-standard but unverified for this SKU, wrap it: `[Confirm before publishing.]`');
  lines.push('- **No competitor names in copy**. The competitor-domain list is for tonal reference only; never mention those brands in the listing text.');
  lines.push('- **Keyword discipline**. High-intent keywords → TITLE + first paragraph + Ad headlines. Informational keywords → LONG DESCRIPTION + FAQs. No keyword should appear more than 3× total on the page.');
  lines.push('- **Truncation math**. All character counts include spaces and punctuation. Overshoot = truncation on Google/Shopify/Amazon → do not exceed.');
  lines.push('- **Return format**. Markdown only. Level-2 headings for each of the 13 sections, in numeric order. No preamble, no meta-commentary, no closing summary — jump straight into `## 1. TITLE`.');
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

// ================================================================
// Shopify sync — per-SKU flow
// ================================================================
// 1. Fetch the CURRENT product from Shopify by URL handle (needs
//    shop domain + admin token wired up in Config → Shopify).
// 2. Build a Claude prompt that includes:
//    - Field-impact hierarchy (what carries most rank/CTR weight)
//    - Current Shopify listing (title/desc/tags/vendor/type/handle)
//    - Read-only variants list (price/weight/inventory shown so
//      Claude sees them but is told NOT to touch — the manager
//      would strip them anyway, but avoiding wasted output tokens)
//    - Complete keyword research from this session
// 3. User runs the prompt in Claude → pastes Claude's JSON back.
// 4. Preview shows: which fields will be sent (allowlist-passing)
//    vs stripped (blocked by the server-side allowlist).
// 5. Push → server filters against SHOPIFY_ALLOWED_FIELDS again
//    (belt + suspenders) and PUTs to Shopify.
async function openShopifyModal() {
  if (!analytics.sku) { toast('Pick a SKU first.', 'warn'); return; }
  const rows = analytics.allRows.filter(r => (r.sku || r.product_url) === analytics.sku);
  if (rows.length === 0) { toast('No keywords for this SKU yet.', 'warn'); return; }
  const ctxRow = rows.find(r => r.product_name || r.product_url) || rows[0];
  const productUrl = ctxRow.product_url;
  if (!productUrl || !/\/products\//i.test(productUrl)) {
    toast(`This SKU's product URL doesn't look like a Shopify /products/<handle> URL: ${productUrl}`, 'err', { title: 'Not a Shopify URL' });
    return;
  }
  const body = $('shopifyModalBody');
  const sub = $('shopifyModalSub');
  sub.textContent = `${ctxRow.sku || analytics.sku} · fetching current listing…`;
  body.innerHTML = `<div class="empty">Loading current product from Shopify…<br><span class="hint" style="margin-top:8px; display:block;">${productUrl}</span></div>`;
  $('shopifyModal').style.display = 'flex';
  try {
    const [prodR, impactR] = await Promise.all([
      api.shopifyGetProduct(productUrl),
      api.shopifyFieldImpact(),
    ]);
    const cur = prodR.product;
    const impactRows = impactR.fields || [];
    const allowlist = impactR.allowlist || [];
    // Build the prompt.
    const prompt = buildShopifyClaudePrompt({
      keywordRows: rows,
      contextRow: ctxRow,
      currentProduct: cur,
      impactRows,
      allowlist,
    });
    sub.textContent = `${ctxRow.sku || analytics.sku} · id ${cur.id} · ${rows.length} keyword(s)`;
    body.innerHTML = renderShopifyModalBody({
      currentProduct: cur,
      productUrl,
      prompt,
      impactRows,
      allowlist,
    });
    // Build validationContext for the preflight checker. Same signals the
    // prompt builder used, extracted from the SKU's research rows:
    //   · primaryKeyword — highest opportunity_score keyword (if computed)
    //     or highest kp_monthly_searches if not
    //   · competitorBrands — domains that appeared most often in
    //     sellers_on_serp across rows, mapped to brand names
    //   · hasReviewData    — whether Shopify metafields carried a real rating
    const sortedByScore = [...rows].sort((a, b) => (b.opportunity_score || 0) - (a.opportunity_score || 0));
    const primaryKeyword = (sortedByScore[0]?.keyword || rows[0]?.keyword || '').trim();
    const competitorDomains = new Map();
    for (const r of rows) {
      const line = String(r.sellers_on_serp || '');
      if (!line) continue;
      for (const part of line.split('|')) {
        const dom = (part.trim().match(/^([a-z0-9.-]+\.[a-z]{2,})/i) || [])[1];
        if (!dom || dom === 'dropy.in') continue;
        competitorDomains.set(dom, (competitorDomains.get(dom) || 0) + 1);
      }
    }
    // Extract just the brand token from each domain (amazon.in → Amazon,
    // nykaa.com → Nykaa). The validator does a case-insensitive word-
    // boundary regex, so first-token is enough for common cases.
    const competitorBrands = [...competitorDomains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([d]) => d.split('.')[0].replace(/^www$/, ''))
      .filter(b => b && b.length >= 3);
    const validationContext = {
      primaryKeyword,
      competitorBrands,
      hasReviewData: !!(cur.reviews?.hasReviews),
    };
    wireShopifyModalHandlers(cur.id, allowlist, validationContext);
  } catch (e) {
    body.innerHTML = `<div class="hint" style="color: var(--danger); padding: 20px 0;">
      Failed to load: ${e.message}<br><br>
      <strong>Common causes:</strong><br>
      · Shopify not configured yet — go to <strong>Config → Shopify integration</strong> and add your shop domain + admin token.<br>
      · Domain wrong — must be either your custom domain (e.g. <code>dropy.in</code>) or the <code>*.myshopify.com</code> URL.<br>
      · Token missing <code>write_products</code> scope.<br>
      · The URL isn't a real Shopify product URL — needs to look like <code>https://your-shop/products/&lt;handle&gt;</code>.
    </div>`;
    sub.textContent = '— fetch failed';
  }
}
function buildShopifyClaudePrompt({ keywordRows, contextRow, currentProduct, impactRows, allowlist }) {
  const rows = keywordRows.slice();
  const scored = rows.map(r => ({ ...r, _score: opportunityScore(r) })).sort((a, b) => b._score - a._score);
  const top50 = scored.slice(0, 50);
  const highIntent = scored.filter(r => (r.buying_intent || '').toLowerCase() === 'high').slice(0, 20);
  const questions = scored.filter(r => /\b(how|what|why|when|where|which|is|are|do|does|can)\b/i.test(r.keyword || '')).slice(0, 15);
  const themes = new Map();
  for (const r of scored) {
    const toks = String(r.keyword || '').toLowerCase().split(/\s+/).filter(t => t.length > 3);
    for (const t of toks) themes.set(t, (themes.get(t) || 0) + 1);
  }
  const topThemes = [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t} (${n})`);
  // COMPETITOR ANALYSIS — parse sellers_on_serp across every keyword so
  // Claude sees WHO we're trying to out-rank. Ranking-focused prompt.
  const compCount = new Map();
  for (const r of scored) {
    const line = String(r.sellers_on_serp || '');
    if (!line) continue;
    for (const part of line.split('|')) {
      const m = part.trim().match(/^([a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) {
        const dom = m[1].toLowerCase().replace(/^www\./, '');
        if (dom === 'dropy.in') continue; // skip ourselves
        compCount.set(dom, (compCount.get(dom) || 0) + 1);
      }
    }
  }
  const topCompetitors = [...compCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  // Categorize competitors so Claude knows the ranking archetype we're
  // beating (marketplace vs brand vs D2C store).
  const isMarketplace = d => /amazon|flipkart|myntra|nykaa|1mg|meesho|snapdeal|jiomart|blinkit|zepto|shop101/i.test(d);
  const isBrand       = d => /\.com$|\.co$/.test(d) && !isMarketplace(d);
  const marketplaces  = topCompetitors.filter(([d]) => isMarketplace(d));
  const brands        = topCompetitors.filter(([d]) => isBrand(d));

  const L = [];
  L.push('# SHOPIFY LISTING — RANK #1 ON GOOGLE FOR THIS PRODUCT');
  L.push('');
  L.push('## PRIMARY GOAL — READ CAREFULLY');
  L.push('You are rewriting a **dropy.in** Shopify product page. The success criterion is **not** "good copy" — it is:');
  L.push('');
  L.push('> **For every keyword in the research pool, dropy.in\'s page must out-rank Amazon.in, the original brand\'s site, Flipkart, Nykaa, and every other seller listed as a competitor.**');
  L.push('');
  L.push('Every field you write is a lever to move that ranking. If a choice would produce prettier copy but lose to Amazon on relevance, choose the ranking one.');
  L.push('');
  L.push('## RANKING RUBRIC — the 4-tier framework this prompt is scored against');
  L.push('Use this as the mental model for every writing decision. Items marked **[ON-PAGE]** are your responsibility in the JSON you return. Items marked **[OFF-SCOPE]** cannot be delivered by this single Shopify update and are handled by separate systems — do NOT waste output tokens on them.');
  L.push('');
  L.push('### Tier 1 — Highest impact');
  L.push('- **[ON-PAGE]** Unique product copy — never copy manufacturer / Amazon / competitor text verbatim. Every sentence rewritten from the keyword research below.');
  L.push('- **[ON-PAGE, CONDITIONAL]** Genuine reviews — emit `AggregateRating` inside Product JSON-LD **only if** review data is supplied below. Never fabricate ratings or review counts.');
  L.push('- **[ON-PAGE]** Product FAQ answering real buyer questions — pulled from the question-shaped queries in the research pool.');
  L.push('- **[ON-PAGE]** Fast page speed — keep `body_html` lean (see HARD CONSTRAINTS: no base64 images, no external assets, ≤ 40 KB payload).');
  L.push('- **[ON-PAGE]** Complete Product schema — `name`, `description`, `sku`, `brand`, `image`, `offers` (with `price`, `priceCurrency: INR`, `availability`, `url`, `priceValidUntil`), `gtin` if research data has a barcode, `aggregateRating` conditional on real reviews.');
  L.push('- **[OFF-SCOPE]** Backlinks — outreach / PR / HARO track. Not this prompt.');
  L.push('- **[ON-PAGE]** Optimized title + meta description — see playbook items 1, 3, 4.');
  L.push('- **[OFF-SCOPE]** Original product images / video — media pipeline. Reference existing image URLs in schema; do not invent new ones.');
  L.push('');
  L.push('### Tier 2 — Very important');
  L.push('- **[ON-PAGE]** Buying guide — the `<h2>` "Buying guide" block inside body_html captures "best X for Y" queries directly.');
  L.push('- **[ON-PAGE]** Comparison — the `<h2>` "How it compares" table compares this product against its OWN variants and neutral category alternatives (concentration, size, use frequency, price band). Do NOT name competitor brands in prose.');
  L.push('- **[ON-PAGE]** Ingredient / key-actives explanations — dedicated `<h3>` per active ingredient with what it does, at what strength.');
  L.push('- **[ON-PAGE]** Internal linking — the `<h2>` "Related on dropy.in" block must link to `/collections/<category>`, `/collections/<brand>`, `/collections/<use-case>`, and `/collections/<ingredient>` (e.g. `/collections/benzoyl-peroxide-products`). Anchor text = keyword-rich, not "click here".');
  L.push('- **[OFF-SCOPE]** Standalone buying guides / comparison articles as separate blog pages — content pipeline track.');
  L.push('');
  L.push('### Tier 3 — Often overlooked');
  L.push('- **[ON-PAGE]** Medical references — cite AAD / DermNet NZ / PubMed by name when discussing ingredients or claims. Link only to `dermnetnz.org`, `aad.org`, `pubmed.ncbi.nlm.nih.gov` search URLs (`https://dermnetnz.org/search?q=<term>` is always valid) — never invent article paths.');
  L.push('- **[ON-PAGE]** Usage instructions — how to use, frequency, side effects, storage. All four required.');
  L.push('- **[ON-PAGE]** People-Also-Ask FAQ — 6-10 FAQ entries using the question-shaped queries from the research verbatim.');
  L.push('- **[OFF-SCOPE]** Video content — media pipeline. If the current product data has a video URL, reference it in schema; otherwise skip.');
  L.push('- **[ON-PAGE, CONDITIONAL]** UGC photos — reference existing image URLs from research. Do not invent.');
  L.push('- **[ON-PAGE]** Rich snippet triggers — Product + FAQPage + HowTo schemas, plus AggregateRating when real, plus `offers` for price+availability rich results.');
  L.push('- **[ON-PAGE]** Freshness — include a `<time datetime="…">` "Last updated" line + `dateModified` in Product schema.');
  L.push('');
  L.push('### Tier 4 — Advanced');
  L.push('- **[OFF-SCOPE]** Topical authority (dozens of category blog posts) — content pipeline track.');
  L.push('- **[OFF-SCOPE]** Brand authority (About page, editorial policy, expert-review process) — global site pages, not this product.');
  L.push('- **[OFF-SCOPE]** Core Web Vitals (LCP / INP / CLS) — theme optimization, not per-product. Your job is to not make it worse via bloat / external assets.');
  L.push('- **[ON-PAGE, CONDITIONAL]** Canonical URL — if a canonical field is in the allowlist below, emit it as the clean product URL (no query parameters).');
  L.push('- **[ON-PAGE]** Long-tail optimization — target the top-50 keywords BELOW verbatim; each becomes a section heading, a FAQ, an ingredient explanation, or a buying-guide scenario. Do not just rank for the brand token.');
  L.push('- **[ON-PAGE]** CTR — meta title + meta description are your CTR levers. Include a benefit + a trust signal + a CTA.');
  L.push('- **[ON-PAGE]** Bounce-rate reduction — above-the-fold clarity (opening `<p>` + featured-snippet block), then FAQ + comparison + related products so users have somewhere to go on-page.');
  L.push('- **[ON-PAGE]** E-E-A-T — link to `/policies/shipping-policy`, `/policies/refund-policy`, `/pages/contact`, `/pages/about-us` (Shopify defaults). Mention COD, GST invoice, secure checkout, customer service email in Shipping & returns.');
  L.push('');
  L.push('## COMPETITIVE LANDSCAPE (who we\'re beating)');
  L.push('Below are the domains that appeared MOST OFTEN in Google SERPs across our keyword research.');
  L.push('These are the pages our copy has to displace.');
  L.push('');
  if (marketplaces.length) {
    L.push('### Marketplaces (their weakness: generic titles, thin category-tag descriptions, low content depth)');
    marketplaces.forEach(([d, n]) => L.push(`  · **${d}** — appeared on ${n} SERPs`));
    L.push('');
  }
  if (brands.length) {
    L.push('### Brand / official sites (their weakness: assume brand awareness, weak on India-specific search intent, no comparison content)');
    brands.forEach(([d, n]) => L.push(`  · **${d}** — appeared on ${n} SERPs`));
    L.push('');
  }
  L.push('**How to beat them (concretely):**');
  L.push('- Amazon\'s page relies on brand-in-title + bullet points. You beat it with keyword-forward title + 800-1500 word structured content + FAQ schema.');
  L.push('- Brand sites focus on brand story. You beat them on **long-tail buying-intent queries** (e.g. "chapstick for dry lips winter india", "aquaphor 10g price in india") where they don\'t bother to optimize.');
  L.push('- Marketplaces skip **structured data**. You add `Product`, `FAQPage`, and `HowTo` JSON-LD in `body_html` to grab rich results.');
  L.push('- **India-first specifics** they miss: INR pricing hint, pan-India shipping, COD, GST-invoice mention, regional use cases (Delhi winter, Mumbai monsoon, Bengaluru AC skin).');
  L.push('- **Featured-snippet target**: include one 40-60 word paragraph directly under the first `<h2>` that answers the top question-shaped query verbatim. Google promotes that block to position zero.');
  L.push('');
  L.push('**DO NOT** mention competitor names in the copy itself. Above is competitive intelligence — never write "unlike Amazon" or "better than X" in the actual `body_html`.');
  L.push('');
  L.push('## RANKING PLAYBOOK (apply to every field)');
  L.push('1. **Title (highest signal)** — primary keyword literally in the first 3 words. Then descriptor + benefit. e.g. `Aquaphor Lip Repair Balm 10g — Cracked Lip Overnight Fix, Ships Pan-India`. 60-70 chars. NOT `Buy Aquaphor Balm` (weak, generic).');
  L.push('2. **Handle** — kebab-case slug MUST contain the primary keyword. If the current handle is generic (e.g. `product-1234`), replace it. If it already contains the primary keyword, KEEP IT (changing loses backlinks + existing SEO).');
  L.push('3. **Meta title** — 55-60 chars. Different phrasing than title. Include the #1 buying-intent keyword + one benefit hook + `| dropy.in` at the end for brand-trust CTR.');
  L.push('4. **Meta description** — 150-160 chars. Include primary keyword in first 60 chars. Include a CTA verb ("Shop", "Order", "Get"). Include a trust signal ("Pan-India delivery" / "COD available" / "Free shipping"). Never truncated — count chars.');
  L.push('5. **Body HTML** — 1200-2000 words, structured for scannability AND for Google. Required sections IN THIS ORDER:');
  L.push('   - `<p>` opening — 2-3 sentences, primary keyword in the first sentence, benefit in the second. This is the ranking anchor.');
  L.push('   - `<h2>` FEATURED-SNIPPET TARGET — 40-60 word direct answer to the highest-volume question-shaped query.');
  L.push('   - `<h2>` Why it works — bullet list of 4-6 benefits, each with a **bold benefit** + supporting sentence.');
  L.push('   - `<h2>` Ingredient / key-actives breakdown — for each key ingredient (or key spec, for non-cosmetic products), a `<h3>` with the ingredient name + one paragraph explaining what it does, at what strength, and what claims it supports. Cite dermatology sources by name in prose (AAD, DermNet NZ, PubMed) — link only to `dermnetnz.org`, `aad.org`, or `pubmed.ncbi.nlm.nih.gov` (do NOT invent URLs — use `https://dermnetnz.org/search?q=<term>` style search URLs which are always valid).');
  L.push('   - `<h2>` How to use — numbered `<ol>` with 3-5 steps + a `<p>` for frequency, side effects, storage. Feeds the HowTo schema below.');
  L.push('   - `<h2>` Specifications — a `<table>` with 4-8 rows (weight, dimensions, key claim, country of origin, etc). Structured data helps rank. Include `<td>` for any GTIN/UPC/EAN if the research data has it.');
  L.push('   - `<h2>` How it compares — a `<table>` comparing THIS product against 2-3 NEUTRAL alternatives in the same category (e.g. "4% vs 10% strength", "creamy vs foaming", "size options"). Compare **objective features** (concentration, price band, pack size, use frequency) — NOT competitor brand names. This IS a comparison article for on-page purposes; keeps users on the page and signals topical depth.');
  L.push('   - `<h2>` Buying guide — a `<h3>` "How to choose the right variant for your need" block with 3-5 short scenarios matching the buying-intent keywords from research. This is the mini-buying-guide that captures "best X for Y" queries directly on the PDP.');
  L.push('   - `<h2>` Who it\'s for — India-specific use cases (cold Delhi winter, Bengaluru AC skin, Mumbai humidity, Chennai heat). Rank on regional queries.');
  L.push('   - `<h2>` FAQs — 6-10 `<details><summary>Q</summary>A</details>` blocks. Use the question-shaped queries below verbatim (People-Also-Ask style), each answer 40-80 words. Include at least one "Can I use this every day?", one "How long does it take to work?", one price/availability question, one safety question, one usage-specifics question.');
  L.push('   - `<h2>` Related on dropy.in — 3-6 `<a>` INTERNAL LINKS with keyword-rich anchor text. Target patterns (dropy uses standard Shopify URLs): `/collections/<category-slug>` for category (e.g. `/collections/acne-face-wash`), `/collections/<brand-slug>` for brand siblings, `/collections/<use-case-slug>` for concern (e.g. `/collections/body-acne`). Pick collections from the top themes below. Only invent slugs if they clearly match a research theme — a dead link is worse than no link.');
  L.push('   - `<h2>` Shipping & returns — India-first: pan-India delivery, COD, GST invoice, return policy days, customer-support contact. Trust signals. Link to `/policies/shipping-policy`, `/policies/refund-policy`, `/pages/contact` (these paths exist on every Shopify store by default).');
  L.push('   - `<p class="hint">` Last updated: `<time datetime="YYYY-MM-DD">Month YYYY</time>` — freshness signal. Use today\'s date.');
  L.push('   - `<script type="application/ld+json">` block at the end. See SCHEMA REQUIREMENTS below — this must include richer Product schema than before.');
  L.push('6. **Tags** — 10-15 tags. Include: primary keyword, category, use-case terms, top 5 themes below. Drives on-site search + auto-collections.');
  L.push('7. **Product type** — the single most-searched category term (from the themes below).');
  L.push('8. **Vendor** — keep current unless clearly wrong. Amazon/brand ranking depends on brand consistency.');
  L.push('');
  L.push('## HARD CONSTRAINTS');
  L.push('- **NEVER produce**: `price`, `weight`, `weight_unit`, `location`, `inventory_quantity`, `variants`, `images`, `sku`. The manager strips them server-side; wasted output tokens.');
  L.push('- **ONLY produce keys** from this allowlist: ' + allowlist.map(f => `\`${f}\``).join(', ') + '.');
  L.push('- **Return format**: reasoning paragraph, then ONE fenced ```json``` block. No other JSON. No commentary after.');
  L.push('- **India-first**. Currency ₹ and `INR` in schema. Pan-India context. Every trust signal India-specific.');
  L.push('- **No invented claims** — do not add "clinically proven", "dermatologist tested", certifications, awards, specific test results unless they appear in the research data.');
  L.push('- **No invented URLs** — dropy internal collection slugs must be plausible (kebab-case of a research theme). External references only to `dermnetnz.org/search?q=…`, `aad.org/search?q=…`, `pubmed.ncbi.nlm.nih.gov/?term=…` — always-valid search URLs. Do NOT invent article paths.');
  L.push('- **No competitor brand names in copy** — no "unlike Amazon", "similar to X brand". Never. (Schema `brand` field is different — that\'s our own product\'s brand and is required.)');
  L.push('- **Schema.org JSON-LD is REQUIRED** and MUST include ALL of these three types in a single `<script type="application/ld+json">` block containing an array of objects:');
  L.push('  1. `Product` — with `name`, `description`, `sku` (echo from research context above), `brand` (as `{"@type":"Brand","name":"…"}` — use current vendor), `image` (from the READ-ONLY image URLs above; do NOT invent), `offers` (as `{"@type":"Offer","price":"…","priceCurrency":"INR","availability":"https://schema.org/InStock","url":"<product URL>","priceValidUntil":"<YYYY-12-31 of current year>"}` — use current price from variant data above; if multiple variants exist, use lowest), `mpn` if known, `gtin13`/`gtin14` if a barcode appears in the research context, `dateModified` = today, and `aggregateRating` **only if real review data is provided** (never fabricate).');
  L.push('  2. `FAQPage` — one `mainEntity` per FAQ, each with `Question` name and `Answer` text (exact match to the FAQ block in body_html).');
  L.push('  3. `HowTo` — with `name`, `step` array matching your How-to-use `<ol>`, plus `totalTime` in ISO-8601 (e.g. `PT2M`).');
  L.push('- **Page-speed guardrails** (protects Core Web Vitals):');
  L.push('  · `body_html` payload ≤ 40 KB (roughly ≤ 40,000 characters).');
  L.push('  · No `<script>` tags EXCEPT the one `application/ld+json` schema block. No inline JS.');
  L.push('  · No `<link rel="stylesheet">`, no `<style>` blocks over 500 chars, no `<iframe>`, no external `<link>` prefetch/preload.');
  L.push('  · No `data:` base64 image URIs — every image is one of the READ-ONLY URLs above or omitted.');
  L.push('  · No `@import` in any style. No `<video>` unless a real video URL is in the research context.');
  L.push('  · Prefer semantic HTML over deeply-nested `<div>` chains — max 4 levels of nesting.');
  L.push('');
  L.push('## FIELD ALLOWLIST + IMPACT HIERARCHY');
  L.push('| Priority | Field | Impact | Why it matters |');
  L.push('|---|---|---|---|');
  for (const r of impactRows) {
    L.push(`| ${r.impact} | \`${r.field}\` | ${r.impact.toUpperCase()} | ${r.why} |`);
  }
  L.push('');
  L.push('## CURRENT SHOPIFY LISTING (before your changes)');
  L.push(`- **Product ID**: ${currentProduct.id}`);
  L.push(`- **Title**: ${currentProduct.title || '(blank)'}`);
  L.push(`- **Handle**: \`${currentProduct.handle || '(blank)'}\` — keep IF it already contains the primary keyword; replace IF it\'s generic.`);
  L.push(`- **Vendor**: ${currentProduct.vendor || '(blank)'}`);
  L.push(`- **Product type**: ${currentProduct.product_type || '(blank)'}`);
  L.push(`- **Tags** (current): ${currentProduct.tags || '(none)'}`);
  L.push(`- **Status**: ${currentProduct.status || '(unknown)'}`);
  // Modern SEO fields, populated by the server via GraphQL productQuery. If
  // empty, that IS the gap Claude fills. If populated, Claude can decide
  // whether to overwrite (usually yes — the research is fresh).
  L.push(`- **Current SEO title** (\`seo.title\`): ${currentProduct.seo_title || '(unset — Claude fills this)'}`);
  L.push(`- **Current SEO description** (\`seo.description\`): ${currentProduct.seo_description || '(unset — Claude fills this)'}`);
  // Standard Product Taxonomy — the Shopify Admin "Product category" field
  // (distinct from Product type). Feeds Google Merchant Center / Meta Shop
  // categorization. If unset, Claude picks the best-fit node from Shopify's
  // taxonomy and outputs the gid://shopify/ProductTaxonomyNode/N id.
  if (currentProduct.product_category?.id) {
    L.push(`- **Current Product category** (Standard Taxonomy): \`${currentProduct.product_category.id}\` — ${currentProduct.product_category.fullName || currentProduct.product_category.name || ''}`);
  } else {
    L.push(`- **Current Product category** (Standard Taxonomy): (unset — **REAL SEO GAP**. Pick the best-fit node from Shopify's Standard Product Taxonomy and emit its \`gid://shopify/ProductTaxonomyNode/N\` id in \`product_category\`. E.g. skincare = \`gid://shopify/ProductTaxonomyNode/1085\` (Health & Beauty > Personal Care > Cosmetics > Skin Care). Guess conservatively — a wrong node ID is worse than none, so if unsure, omit the field.)`);
  }
  // Review data — feeds the conditional AggregateRating schema. If we have
  // real numbers, Claude MUST emit AggregateRating using them (nothing else).
  // If empty, Claude MUST skip AggregateRating entirely.
  if (currentProduct.reviews?.hasReviews) {
    L.push(`- **Reviews** (source: \`${currentProduct.reviews.source}\`): ${currentProduct.reviews.rating}★ · ${currentProduct.reviews.count} reviews — **USE THESE NUMBERS VERBATIM** in \`AggregateRating\` schema. Do NOT round, adjust, or invent additional metadata.`);
  } else if (currentProduct.metafield_namespaces?.length) {
    L.push(`- **Reviews**: no rating found in metafields (namespaces present: ${currentProduct.metafield_namespaces.join(', ')}). **SKIP \`AggregateRating\` schema entirely** — do not invent a rating.`);
  } else {
    L.push(`- **Reviews**: no review app detected on this product. **SKIP \`AggregateRating\` schema entirely** — do not invent a rating.`);
  }
  L.push('');
  L.push('**Current body_html** (may be blank / poor — this is what we\'re replacing):');
  L.push('```html');
  L.push((currentProduct.body_html || '(empty)').slice(0, 4000));
  L.push('```');
  L.push('');
  if (currentProduct.variants_readonly?.length) {
    L.push('**READ-ONLY variant data** (for context — DO NOT include; also useful for accurate pack-size mentions in body):');
    for (const v of currentProduct.variants_readonly.slice(0, 8)) {
      L.push(`  · variant \`${v.sku || v.id}\` — ${v.title || '(no title)'} · ₹${v.price} · ${v.weight || 0}${v.weight_unit || 'g'} · inv ${v.inventory_quantity ?? '—'}`);
    }
    L.push('');
  }
  if (currentProduct.images?.length) {
    L.push(`**Images** (${currentProduct.images.length} — READ-ONLY, do NOT include):`);
    for (const im of currentProduct.images.slice(0, 4)) L.push(`  · ${im.src}  ${im.alt ? '— alt: ' + im.alt : ''}`);
    L.push('');
  }
  L.push('## THIS SKU (research context)');
  L.push(`- **SKU / ASIN**: ${contextRow.sku || analytics.sku}`);
  L.push(`- **Product URL**: ${contextRow.product_url}`);
  L.push(`- **Product name (as scraped)**: ${contextRow.product_name || '(unknown)'}`);
  L.push('');
  L.push('## KEYWORD RESEARCH (fresh) — the terms we must rank for');
  L.push(`Total keywords collected: **${rows.length}**. Below are the top-50 by opportunity score (log-volume × rating × image-matches, adjusted for competition + buying intent).`);
  L.push('');
  L.push('### Top 50 opportunity keywords (rank for these)');
  L.push('| # | Keyword | Volume | Comp | Intent | Imgs | Score |');
  L.push('|---|---|---|---|---|---|---|');
  top50.forEach((r, i) => {
    L.push(`| ${i+1} | ${r.keyword || ''} | ${r.avg_monthly_searches ?? '—'} | ${r.competition || '—'} | ${r.buying_intent || '—'} | ${r.image_count ?? '—'} | ${r._score.toFixed(1)} |`);
  });
  L.push('');
  L.push(`### High buying-intent keywords (${highIntent.length}) — TITLE + first 100 words + meta title MUST include the top 3`);
  L.push(highIntent.map(r => `- ${r.keyword} (${r.avg_monthly_searches ?? '—'} vol)`).join('\n') || '(none marked high-intent)');
  L.push('');
  L.push(`### Question-shaped queries (${questions.length}) — feed the FAQ + featured-snippet block verbatim`);
  L.push(questions.map(r => `- ${r.keyword}`).join('\n') || '(none detected)');
  L.push('');
  L.push('### Top recurring themes / tokens (put these in tags + section headings)');
  L.push(topThemes.join(' · '));
  L.push('');
  L.push('## OUTPUT SPEC');
  L.push('Respond with:');
  L.push('1. A one-paragraph **ranking rationale**: which competitor page you\'re primarily targeting, why your title/body_html beats it, which long-tail queries you\'re dominating.');
  L.push('2. A single fenced ```json``` code block with ONLY these keys (all optional — omit anything you\'re not changing):');
  L.push('```json');
  L.push('{');
  L.push('  "title": "…",');
  L.push('  "body_html": "…full HTML with all sections + JSON-LD…",');
  L.push('  "tags": "tag1, tag2, tag3",');
  L.push('  "product_type": "…",');
  L.push('  "vendor": "…",');
  L.push('  "handle": "kebab-case-slug-with-primary-keyword",');
  L.push('  "seo_title": "SEO <title> (55-60 chars) | dropy.in",');
  L.push('  "seo_description": "SEO <meta description> (150-160 chars, with CTA)",');
  L.push('  "metafields_global_title_tag": "same as seo_title — legacy metafield for REST compatibility",');
  L.push('  "metafields_global_description_tag": "same as seo_description — legacy metafield for REST compatibility",');
  L.push('  "product_category": "gid://shopify/ProductTaxonomyNode/N — Standard Product Taxonomy node id, only if you can pick with high confidence; omit if unsure"');
  L.push('}');
  L.push('```');
  L.push('');
  L.push('**Field routing note**: the server writes REST fields via `products.json` PUT and GraphQL-only fields (`seo_title`, `seo_description`, `product_category`) via `productUpdate`. You always emit them as flat keys — the server routes correctly. Emit BOTH the modern `seo_*` AND the legacy `metafields_global_*_tag` with the SAME string values for maximum coverage across Shopify API versions.');
  L.push('');
  L.push('### Sanity checklist BEFORE returning — Tier 1-4 rubric self-check');
  L.push('**Tier 1**');
  L.push('- [ ] `title` contains the primary keyword in the first 3 words (Tier 1 · CTR + relevance).');
  L.push('- [ ] `handle` contains the primary keyword.');
  L.push('- [ ] `seo_title` AND `metafields_global_title_tag` are BOTH set to the same 55-60 char string (modern + legacy). Includes a benefit + `| dropy.in`.');
  L.push('- [ ] `seo_description` AND `metafields_global_description_tag` are BOTH set to the same 150-160 char string; primary keyword in first 60 chars, includes a CTA verb + a trust signal.');
  L.push('- [ ] `product_category` is set to a `gid://shopify/ProductTaxonomyNode/N` id IF you can pick a category with high confidence; omit the key entirely otherwise (a wrong id is worse than none — Shopify Google Merchant sync will fail).');
  L.push('- [ ] `AggregateRating` in Product JSON-LD: present ONLY if real review data was provided above; if none was provided, the key is absent from Product schema (never fabricate).');
  L.push('- [ ] `body_html` ≥ 1200 words. Zero copy-pasted sentences from research context; every sentence rewritten (Tier 1 · unique content).');
  L.push('- [ ] `body_html` payload ≤ 40 KB (Tier 1 · page speed).');
  L.push('- [ ] Product JSON-LD includes: name, description, sku, brand, image, offers {price, priceCurrency:INR, availability, url, priceValidUntil}, dateModified. GTIN if research data has one. AggregateRating ONLY if real review data provided.');
  L.push('**Tier 2**');
  L.push('- [ ] `<h2>` Ingredient / key-actives breakdown present with per-ingredient explanation.');
  L.push('- [ ] `<h2>` How it compares table present (concentration / size / use frequency / price band — never competitor brand names).');
  L.push('- [ ] `<h2>` Buying guide present with 3-5 scenario blocks matched to buying-intent keywords below.');
  L.push('- [ ] `<h2>` Related on dropy.in has 3-6 internal `<a href="/collections/…">` links with keyword-rich anchor text.');
  L.push('**Tier 3**');
  L.push('- [ ] Usage instructions section covers how / frequency / side effects / storage — all four.');
  L.push('- [ ] FAQPage schema present. 6-10 FAQ entries; each answer 40-80 words; uses question-shaped queries from research verbatim.');
  L.push('- [ ] At least one dermatology-source citation (AAD / DermNet NZ / PubMed) if any medical claim is made; link is to a search URL only.');
  L.push('- [ ] `<time datetime="…">` freshness line present. Product schema `dateModified` = today.');
  L.push('**Tier 4**');
  L.push('- [ ] Top 15 long-tail keywords from research each appear at least once in `body_html`, `tags`, or FAQ.');
  L.push('- [ ] Body opens with clear above-the-fold answer to primary query (bounce-rate lever).');
  L.push('- [ ] Shipping & returns section links to `/policies/shipping-policy`, `/policies/refund-policy`, `/pages/contact` (E-E-A-T).');
  L.push('**Hard rules**');
  L.push('- [ ] Zero competitor brand names in the actual `body_html` copy (schema `brand` for our own product is fine).');
  L.push('- [ ] Zero fabricated ratings / reviews / certifications / awards.');
  L.push('- [ ] Zero invented image URLs; only READ-ONLY URLs from context above.');
  L.push('- [ ] Zero `<script>` tags in `body_html` except the ONE `application/ld+json` block.');
  L.push('- [ ] Zero base64 `data:` URIs, zero `<iframe>`, zero external stylesheets.');
  L.push('- [ ] `tags` has 10-15 entries drawn from top research themes.');
  L.push('- [ ] Every non-schema field is a full rewrite; no copied sentences from current listing above.');
  L.push('');
  L.push('Begin. Ranking rationale first, then the single JSON block.');
  return L.join('\n');
}
function renderShopifyModalBody({ currentProduct, productUrl, prompt, impactRows, allowlist }) {
  const impactHtml = impactRows.map(r => {
    const color = r.impact === 'critical' ? 'var(--danger)' : r.impact === 'high' ? 'var(--warn)' : r.impact === 'medium' ? 'var(--accent)' : 'var(--text-3)';
    return `<div style="display:grid; grid-template-columns: 80px 220px 1fr; gap: 8px; padding: 4px 0; border-bottom: 1px dashed var(--line-1); font-size: 12px;">
      <span style="color: ${color}; font-weight: 700; text-transform: uppercase;">${r.impact}</span>
      <code>${r.field}</code>
      <span class="hint" style="color: var(--text-2);">${r.why}</span>
    </div>`;
  }).join('');
  const readOnlyVariants = (currentProduct.variants_readonly || []).slice(0, 6).map(v =>
    `<div class="hint" style="font-family: var(--mono); font-size: 11px; margin: 2px 0;">
      <span style="color: var(--text-3);">${v.sku || v.id}</span> · ${v.title || '(no title)'} · <span style="color: var(--danger);">₹${v.price}</span> · <span style="color: var(--danger);">${v.weight || 0}${v.weight_unit || 'g'}</span> · inv ${v.inventory_quantity ?? '—'}
    </div>`
  ).join('');
  return `
    <div class="hint" style="margin-bottom: 12px; padding: 10px; background: var(--warn-soft); border: 1px solid var(--warn); border-radius: 6px;">
      <strong style="color: var(--warn);">Safety guarantee:</strong>
      The manager only PUTs these ${allowlist.length} fields to Shopify: ${allowlist.map(f => `<code>${f}</code>`).join(', ')}.
      Anything else in Claude's JSON — including price, weight, location, inventory, variants — is stripped server-side before the request leaves this process.
      The read-only variant data below is shown only so you (and Claude) can SEE what's being excluded.
    </div>

    <details style="margin-bottom: 10px;">
      <summary style="cursor: pointer; padding: 8px; background: var(--bg-3); border-radius: 6px;"><strong>Current Shopify listing</strong> · id <code>${currentProduct.id}</code> · <a href="${productUrl}" target="_blank" rel="noopener">open in browser →</a></summary>
      <div style="padding: 10px; background: var(--bg-3); margin-top: 4px; border-radius: 6px;">
        <div class="hint"><strong>Title:</strong> ${currentProduct.title || '(blank)'}</div>
        <div class="hint"><strong>Handle:</strong> <code>${currentProduct.handle}</code></div>
        <div class="hint"><strong>Vendor:</strong> ${currentProduct.vendor || '(blank)'} · <strong>Type:</strong> ${currentProduct.product_type || '(blank)'}</div>
        <div class="hint"><strong>Tags:</strong> ${currentProduct.tags || '(none)'}</div>
        <div class="hint"><strong>Status:</strong> ${currentProduct.status}</div>
        <div class="hint" style="margin-top: 6px;"><strong>Read-only variants</strong> (price/weight/inventory — WILL NOT be updated):</div>
        ${readOnlyVariants || '<div class="hint">(no variants)</div>'}
      </div>
    </details>

    <details style="margin-bottom: 10px;">
      <summary style="cursor: pointer; padding: 8px; background: var(--bg-3); border-radius: 6px;"><strong>Field-impact hierarchy</strong> — Claude is told to prioritize the top items</summary>
      <div style="padding: 10px; background: var(--bg-3); margin-top: 4px; border-radius: 6px;">${impactHtml}</div>
    </details>

    <div class="hint" style="margin: 12px 0 6px 0;"><strong>Step 1 —</strong> Copy the prompt below and paste into Claude.</div>
    <textarea id="shopifyPromptText" spellcheck="false" style="width:100%; min-height: 240px; font-family: var(--mono); font-size: 11px; padding: 10px; background: var(--bg-input); color: var(--text-1); border: 1px solid var(--line-2); border-radius: 6px; resize: vertical;">${prompt.replace(/</g, '&lt;')}</textarea>
    <div class="row" style="margin-top: 8px;">
      <button id="shopifyCopyPromptBtn">📋 Copy prompt</button>
      <button class="secondary" id="shopifyOpenClaudeBtn">🚀 Open in Claude</button>
      <span class="spacer" style="flex:1;"></span>
      <span class="hint">${(prompt.length / 1024).toFixed(1)} KB</span>
    </div>

    <div class="hint" style="margin: 16px 0 6px 0;"><strong>Step 2 —</strong> Paste Claude's JSON response below. The manager will parse out the \`\`\`json block, filter against the allowlist, and show a preview of exactly what will be sent.</div>
    <textarea id="shopifyJsonInput" spellcheck="false" placeholder='Paste Claude&#39;s full response OR just the JSON block. Both work.' style="width:100%; min-height: 160px; font-family: var(--mono); font-size: 11px; padding: 10px; background: var(--bg-input); color: var(--text-1); border: 1px solid var(--line-2); border-radius: 6px; resize: vertical;"></textarea>
    <div class="row" style="margin-top: 8px;">
      <button id="shopifyPreviewBtn">👁 Preview what will be pushed</button>
      <span class="spacer" style="flex:1;"></span>
    </div>

    <div id="shopifyPreviewBox" style="margin-top: 12px;"></div>
  `;
}
function wireShopifyModalHandlers(productId, allowlist, validationContext = {}) {
  $('shopifyCopyPromptBtn')?.addEventListener('click', async () => {
    const t = $('shopifyPromptText').value;
    if (await copyToClipboard(t)) toast('Prompt copied — paste into Claude.', 'ok', { title: 'Copied' });
    else { $('shopifyPromptText').select(); toast('Copy failed — text is selected, press Ctrl+C.', 'warn'); }
  });
  $('shopifyOpenClaudeBtn')?.addEventListener('click', async () => {
    await copyToClipboard($('shopifyPromptText').value);
    toast('Prompt on clipboard — paste into Claude.', 'ok');
    // Anchor-click pattern (not window.open) so session cookies survive —
    // same reasoning as the Claude-brief modal.
    const a = document.createElement('a');
    a.href = 'https://claude.ai/new';
    a.target = '_blank';
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  $('shopifyPreviewBtn')?.addEventListener('click', () => {
    const raw = $('shopifyJsonInput').value;
    const parsed = extractShopifyJson(raw);
    const box = $('shopifyPreviewBox');
    if (!parsed.ok) {
      box.innerHTML = `<div class="hint" style="color: var(--danger); padding: 10px; background: var(--danger-soft); border-radius: 6px;">Could not parse JSON: ${parsed.error}</div>`;
      return;
    }
    const kept = {}, stripped = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (allowlist.includes(k)) kept[k] = v; else stripped[k] = v;
    }
    const keptEntries = Object.entries(kept);
    const stripEntries = Object.entries(stripped);
    const renderKeptField = ([k, v]) => {
      const preview = typeof v === 'string' ? v.slice(0, 500) : JSON.stringify(v);
      return `<div style="padding: 8px 0; border-bottom: 1px dashed var(--line-1);">
        <div style="display: flex; gap: 8px; align-items: baseline;">
          <code style="color: var(--success);">${k}</code>
          <span class="hint">(${typeof v === 'string' ? v.length + ' chars' : typeof v})</span>
        </div>
        <div class="hint" style="margin-top: 4px; white-space: pre-wrap; font-family: var(--mono); font-size: 11px;">${preview.replace(/</g, '&lt;')}${(typeof v === 'string' && v.length > 500) ? '…' : ''}</div>
      </div>`;
    };
    box.innerHTML = `
      <div style="padding: 10px; background: ${keptEntries.length > 0 ? 'var(--success-soft)' : 'var(--warn-soft)'}; border: 1px solid ${keptEntries.length > 0 ? 'var(--success)' : 'var(--warn)'}; border-radius: 6px;">
        <div style="display: flex; align-items: baseline; gap: 12px;">
          <strong style="color: ${keptEntries.length > 0 ? 'var(--success)' : 'var(--warn)'};">${keptEntries.length} field(s) will be pushed to Shopify</strong>
          ${stripEntries.length > 0 ? `<span class="hint" style="color: var(--danger);">${stripEntries.length} stripped by allowlist</span>` : ''}
        </div>
        <div style="margin-top: 8px;">${keptEntries.map(renderKeptField).join('') || '<div class="hint">nothing to send</div>'}</div>
        ${stripEntries.length > 0 ? `<div class="hint" style="margin-top: 8px; color: var(--danger);"><strong>Stripped:</strong> ${stripEntries.map(([k]) => `<code>${k}</code>`).join(', ')}</div>` : ''}
        <div id="shopifyPreflightBox" style="margin-top: 10px;">
          <div class="hint">Running preflight rubric check…</div>
        </div>
        <div class="row" style="margin-top: 12px; align-items: center; gap: 12px;">
          <button class="danger" id="shopifyPushBtn" ${keptEntries.length === 0 ? 'disabled' : ''}>Push to Shopify now</button>
          <label style="display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-3);">
            <input type="checkbox" id="shopifyForceOverride" />
            Force override (bypass preflight critical failures)
          </label>
        </div>
        <div id="shopifyPushResult" style="margin-top: 8px;"></div>
      </div>
    `;
    // Preflight — call the dry-run endpoint, render report, gate the button.
    let preflightCriticalCount = 0;
    if (keptEntries.length > 0) {
      (async () => {
        try {
          const pf = await api.shopifyValidatePatch(kept, validationContext);
          preflightCriticalCount = pf.preflight?.critical?.length || 0;
          renderShopifyPreflightReport(pf.preflight, validationContext);
        } catch (e) {
          $('shopifyPreflightBox').innerHTML = `<div class="hint" style="color: var(--text-3);">(preflight endpoint unavailable — server may be older: ${e.message})</div>`;
        }
        applyPreflightGate();
      })();
    }
    // Gate: disable Push when critical > 0 unless Force override is checked.
    const applyPreflightGate = () => {
      const btn = $('shopifyPushBtn');
      const force = $('shopifyForceOverride')?.checked;
      if (!btn) return;
      const blocked = preflightCriticalCount > 0 && !force;
      btn.disabled = keptEntries.length === 0 || blocked;
      btn.title = blocked
        ? `Preflight failed with ${preflightCriticalCount} critical issue(s). Fix Claude's output or check "Force override".`
        : '';
    };
    $('shopifyForceOverride')?.addEventListener('change', applyPreflightGate);
    $('shopifyPushBtn')?.addEventListener('click', async () => {
      const btn = $('shopifyPushBtn');
      const force = $('shopifyForceOverride')?.checked;
      btn.disabled = true; btn.textContent = 'Pushing…';
      try {
        const r = await api.shopifyUpdateProduct(productId, kept, { force, validationContext });
        $('shopifyPushResult').innerHTML = `<div class="hint" style="color: var(--success);">✓ Updated. Fields sent: ${Object.keys(r.sent || {}).map(k => `<code>${k}</code>`).join(', ') || '(none)'}${r.stripped?.length ? ` · Server also stripped: ${r.stripped.join(', ')}` : ''}</div>`;
        toast('Shopify listing updated.', 'ok', { title: 'Pushed' });
      } catch (e) {
        // If the server rejected on preflight AND we didn't force, surface the preflight report inline.
        const detail = e.data?.preflight
          ? `<br><small>${(e.data.preflight.critical || []).map(c => `<code>${c.id}</code>: ${c.msg}`).join('<br>')}</small>`
          : '';
        $('shopifyPushResult').innerHTML = `<div class="hint" style="color: var(--danger);">Push failed: ${e.message}${detail}</div>`;
        toast(e.message, 'err', { title: 'Push failed' });
      } finally { btn.disabled = false; btn.textContent = 'Push to Shopify now'; }
    });
  });
}
// Render the preflight rubric report inline in the Shopify modal. Called
// after the JSON is parsed + validated against /api/shopify/validate-patch.
// Three-tier visual: green (ok, no warnings), yellow (ok, warnings only),
// red (critical failures). Each critical + warning is listed with its
// stable id + human message.
function renderShopifyPreflightReport(preflight, ctx) {
  const box = $('shopifyPreflightBox');
  if (!box || !preflight) return;
  const critCount = preflight.critical?.length || 0;
  const warnCount = preflight.warn?.length || 0;
  const stats = preflight.stats || {};
  const isGreen = critCount === 0 && warnCount === 0;
  const isYellow = critCount === 0 && warnCount > 0;
  const bg     = critCount > 0 ? 'var(--danger-soft)' : isYellow ? 'var(--warn-soft)' : 'var(--success-soft)';
  const border = critCount > 0 ? 'var(--danger)'      : isYellow ? 'var(--warn)'      : 'var(--success)';
  const label  = critCount > 0 ? `⛔ PREFLIGHT FAILED — ${critCount} critical issue(s)` : isYellow ? `⚠ Preflight OK — ${warnCount} warning(s)` : `✓ Preflight OK — no issues`;
  const color  = critCount > 0 ? 'var(--danger)'      : isYellow ? 'var(--warn)'      : 'var(--success)';
  const contextLine = (ctx.primaryKeyword || ctx.competitorBrands?.length || ctx.hasReviewData !== undefined)
    ? `<div class="hint" style="margin-top:6px; font-size:11px;">Context: primary=${esc(ctx.primaryKeyword || '—')} · competitors=[${(ctx.competitorBrands || []).map(esc).join(', ')}] · reviews=${ctx.hasReviewData ? 'real' : 'none'}</div>`
    : '';
  const statsLine = Object.keys(stats).length > 0
    ? `<div class="hint" style="margin-top:6px; font-size:11px;">${Object.entries(stats).map(([k, v]) => `${esc(k)}=${v}`).join(' · ')}</div>`
    : '';
  const critList = critCount > 0
    ? `<div style="margin-top:8px;"><strong style="color: var(--danger);">Critical (block push):</strong><ul style="margin: 4px 0 0 16px; padding: 0; font-size: 12px;">${preflight.critical.map(c => `<li><code>${esc(c.id)}</code> — ${esc(c.msg)}</li>`).join('')}</ul></div>`
    : '';
  const warnList = warnCount > 0
    ? `<div style="margin-top:8px;"><strong style="color: var(--warn);">Warnings (don't block):</strong><ul style="margin: 4px 0 0 16px; padding: 0; font-size: 12px; color: var(--text-2);">${preflight.warn.map(w => `<li><code>${esc(w.id)}</code> — ${esc(w.msg)}</li>`).join('')}</ul></div>`
    : '';
  box.innerHTML = `
    <div style="padding: 10px; background: ${bg}; border: 1px solid ${border}; border-radius: 6px;">
      <div style="display:flex; align-items:baseline; gap:12px;">
        <strong style="color: ${color};">${label}</strong>
      </div>
      ${contextLine}
      ${statsLine}
      ${critList}
      ${warnList}
      ${isGreen ? '<div class="hint" style="margin-top:6px;">Every rubric check passed. Push away.</div>' : ''}
    </div>
  `;
}
// Extract a JSON object from either a bare JSON string OR a markdown
// response containing one or more ```json fenced blocks. If a fenced
// block exists, use the LAST one (Claude tends to put the final answer
// last). Otherwise try to parse the whole thing.
function extractShopifyJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'empty input' };
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  const fences = [...s.matchAll(fenceRe)].map(m => m[1].trim()).filter(Boolean);
  const candidates = fences.length ? [fences[fences.length - 1]] : [s];
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object' && !Array.isArray(j)) return { ok: true, data: j };
    } catch (e) { /* try next */ }
  }
  return { ok: false, error: 'no valid JSON object found (Claude should emit a ```json { … } ``` block)' };
}
$('anShopifyBtn')?.addEventListener('click', openShopifyModal);

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
  if (await copyToClipboard(text)) toast(`${scored.length} top keyword(s) copied.`, 'ok', { title: 'Copied' });
  else toast('Copy failed — select the text manually + Ctrl+C.', 'err');
});
$('claudeCopyBtn')?.addEventListener('click', async () => {
  const t = $('claudePromptText').value;
  if (await copyToClipboard(t)) {
    toast('Prompt copied — paste into Claude.', 'ok', { title: 'Copied' });
  } else {
    $('claudePromptText').select();
    toast('Copy failed — text is selected, press Ctrl+C.', 'warn');
  }
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
  await copyToClipboard(t);
  toast('Opening Claude — paste the prompt into the chat box.', 'info', { title: 'Prompt copied' });
  // Open via a real anchor click (not window.open with 'noopener').
  // Reason: this manager runs on HTTP; some Chrome profile + third-party-
  // cookie configurations treat the noopener-broken navigation as a fresh
  // session and prompt for login, even when claude.ai has a valid cookie
  // in that profile. A plain anchor click carries the browser's normal
  // top-level navigation semantics — session cookies flow correctly.
  const a = document.createElement('a');
  a.href = 'https://claude.ai/new';
  a.target = '_blank';
  a.rel = 'noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
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

// Start the live-refresh loop for the Analytics tab. Polls every 4s;
// only re-renders when the row set actually changed (checked via a cheap
// row-count + max-id fingerprint) so filters, sort, scroll position, and
// the selected SKU are preserved across ticks with no data churn.
function startAnalyticsPolling() {
  stopAnalyticsPolling();
  if (!analytics.batchId) return;
  analytics.liveTimer = setInterval(() => tickAnalyticsLive().catch(() => {}), analytics.liveIntervalMs);
}
function stopAnalyticsPolling() {
  if (analytics.liveTimer) { clearInterval(analytics.liveTimer); analytics.liveTimer = null; }
}
async function tickAnalyticsLive() {
  if (analytics.liveInFlight || !analytics.batchId) return;
  analytics.liveInFlight = true;
  try {
    analytics.tickCount++;
    // Every N ticks OR when we haven't seen any rows yet, do a full fetch
    // as a safety net for server-side row edits / deletes / dedupes that
    // incremental-fetch would miss (id-based delta only sees NEW rows).
    const doFullRefresh = analytics.tickCount % analytics.fullRefreshEvery === 0
                          || analytics.allRows.length === 0
                          || analytics.lastMaxId === 0;
    const sinceId = doFullRefresh ? null : analytics.lastMaxId;
    const sinceChangedAt = doFullRefresh ? null : analytics.lastPerProductChangedAt;
    const [r, jr] = await Promise.all([
      api.keywordsGet(analytics.batchId, sinceId),
      api.jobsPerProduct(analytics.batchId, sinceChangedAt).catch(() => ({ rows: [], incremental: false, maxChangedAt: 0 })),
    ]);
    // Merge jobs into the client-side by-id cache. Full refresh → replace
    // entire map; incremental → upsert changed rows in place. Then read
    // back a stable ordered array for the tree.
    if (!jr.incremental) {
      analytics.perProductById.clear();
      for (const row of (jr.rows || [])) analytics.perProductById.set(row.id, row);
    } else {
      for (const row of (jr.rows || [])) analytics.perProductById.set(row.id, row);
    }
    analytics.lastPerProductChangedAt = Number.isFinite(jr.maxChangedAt) ? jr.maxChangedAt : analytics.lastPerProductChangedAt;
    // Rebuild jr.rows from the cache so downstream code (tree render,
    // stats) sees the FULL merged list, not just the delta.
    jr.rows = Array.from(analytics.perProductById.values());
    const newRows = r.rows || [];
    // Server always returns maxId; use it as our next cursor. Falling back
    // to computing from returned rows lets us handle old-server responses.
    const serverMaxId = Number.isFinite(r.maxId) ? r.maxId
      : newRows.reduce((m, x) => Math.max(m, Number(x._id) || 0), analytics.lastMaxId);
    // If incremental, MERGE new rows into the existing set (append). If
    // full refresh, REPLACE — this reconciles any edits/deletes.
    let rows;
    if (r.incremental) {
      // Fast path: append newRows to analytics.allRows without re-fingerprinting the whole set.
      if (newRows.length === 0) {
        rows = analytics.allRows;
        // If nothing new landed AND jobs-done count hasn't moved, skip
        // full re-render — just update the tree hint + pulse.
      } else {
        rows = analytics.allRows.concat(newRows);
      }
    } else {
      rows = newRows;
    }
    // Fingerprint: row count + max id + jobs-done count.
    const jobs = jr.rows || [];
    const doneN = jobs.filter(j => j.status === 'done').length;
    const fp = `${rows.length}|${serverMaxId}|${doneN}`;
    if (fp === analytics.lastFingerprint) {
      pulseAnalyticsLiveDot();
      return;
    }
    analytics.lastFingerprint = fp;
    analytics.lastMaxId = serverMaxId;
    _treeJobCache.set(analytics.batchId, jobs);
    analytics.allRows = rows;
    analytics.columnSet = new Set();
    for (const row of rows) for (const k of Object.keys(row)) analytics.columnSet.add(k);
    // Re-populate the SKU dropdown so newly-completed SKUs appear as
    // options without waiting for a manual reload.
    const bySku = new Map();
    for (const row of rows) {
      const key = row.sku || row.product_url || 'unknown';
      if (!bySku.has(key)) bySku.set(key, { key, productName: row.product_name || '', rows: [] });
      bySku.get(key).rows.push(row);
    }
    const skuList = Array.from(bySku.values()).sort((a, b) => b.rows.length - a.rows.length);
    const skuSel = $('anSkuSelect');
    if (skuSel) {
      const cur = analytics.sku;
      skuSel.innerHTML = `<option value="">— all SKUs in batch —</option>` + skuList.map(g =>
        `<option value="${esc(g.key)}">${esc(g.key)} — ${g.rows.length} kw${g.productName ? ` · ${esc(g.productName)}` : ''}</option>`
      ).join('');
      if (cur && bySku.has(cur)) skuSel.value = cur;
      else if (!cur && skuList[0]) { analytics.sku = skuList[0].key; skuSel.value = analytics.sku; }
    }
    const sh = $('anSkuHint'); if (sh) sh.textContent = `${skuList.length} SKU(s) in this batch`;
    filterAndRenderAnalytics();
    // Also refresh the sidebar tree so new SKUs light up as they finish.
    await renderAnalyticsTree();
    pulseAnalyticsLiveDot();
  } finally { analytics.liveInFlight = false; }
}
function pulseAnalyticsLiveDot() {
  const el = document.getElementById('anLiveDot');
  if (!el) return;
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

async function loadAnalyticsBatch(batchId) {
  const summary = $('anSummary');
  if (!batchId) {
    analytics.allRows = []; analytics.skuRows = [];
    summary.innerHTML = `<div class="empty"><div class="empty-icon">📈</div>Pick a batch + SKU to see analytics.</div>`;
    $('anSkuSelect').innerHTML = `<option value="">— pick a batch first —</option>`;
    $('anTopChartCard').style.display = 'none';
    $('anTableCard').style.display = 'none';
    $('anExportBtn').disabled = true;
    stopAnalyticsPolling();
    return;
  }
  summary.innerHTML = `<div class="empty">Loading batch data…</div>`;
  try {
    // Fetch keywords AND job list in parallel — job list drives the
    // tree's zero-kw SKU display (SKUs marked done/failed but that
    // produced no keyword rows would otherwise be invisible).
    const [r, jr] = await Promise.all([
      api.keywordsGet(batchId),
      api.jobsPerProduct(batchId).catch(() => ({ rows: [] })),
    ]);
    _treeJobCache.set(batchId, jr.rows || []);
    analytics.allRows = r.rows || [];
    // Empty-batch guard: when a batch has zero keyword rows, the downstream
    // filterAndRenderAnalytics() shows the "empty" placeholder — but the
    // placeholder text was still "Loading batch data…" from the setup
    // above, so the tab looked hung forever. Rewrite the placeholder now
    // and diagnose the LIKELY cause from the job list so the user gets a
    // useful message instead of an infinite spinner.
    if (analytics.allRows.length === 0) {
      const jobs = jr.rows || [];
      const doneJobs   = jobs.filter(j => j.status === 'done').length;
      const failedJobs = jobs.filter(j => j.status === 'failed').length;
      const pendingJobs= jobs.filter(j => j.status === 'pending' || j.status === 'claimed').length;
      let diagnosis;
      if (doneJobs > 0 && pendingJobs === 0 && failedJobs === 0) {
        diagnosis = `${doneJobs} SKU(s) finished but produced <strong>zero keyword rows</strong>. Common causes: (1) KP session expired / KP FAILED for every seed, (2) all candidates rejected by the relevance filter, (3) worker pushed to an orphan batch — check <em>Config → orphan cleanup</em> and the Activity log for "orphan_batch" or "KP FAILED" lines.`;
      } else if (pendingJobs > 0) {
        diagnosis = `${pendingJobs} SKU(s) still in flight (pending/claimed). Keyword rows only land at the manager once a SKU completes and the worker's activity buffer flushes (~1-3s). Refresh in a moment.`;
      } else if (failedJobs === jobs.length && jobs.length > 0) {
        diagnosis = `All ${failedJobs} SKU(s) failed. Check the Dashboard's <em>Failed jobs</em> card for the reasons.`;
      } else {
        diagnosis = `No keyword rows for this batch yet. Confirm the worker is running and pointed at this batch id.`;
      }
      summary.innerHTML = `<div class="banner warn" style="margin: 8px 0;">
        <strong>No keyword data yet for this batch.</strong><br>
        ${diagnosis}<br>
        <span style="color: var(--text-3); font-size: 11px;">Batch <code>${esc(batchId)}</code> · ${jobs.length} SKU(s) total · ${doneJobs} done · ${pendingJobs} in-flight · ${failedJobs} failed.</span>
      </div>`;
    }
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
  } catch (e) {
    summary.innerHTML = `<div class="banner err">Failed to load: ${esc(e.message)}</div>`;
    return;
  }
  filterAndRenderAnalytics();
  // Reset fingerprint + incremental cursor + tick counter so the first
  // live tick doesn't skip render (fingerprint) and doesn't try to fetch
  // incrementally against a stale cursor (batch just changed). Then
  // start the 4s live loop for this batch. Tab-switch stops it.
  analytics.lastFingerprint = '';
  analytics.lastMaxId = 0;
  analytics.tickCount = 0;
  analytics.lastPerProductChangedAt = 0;
  analytics.perProductById.clear();
  startAnalyticsPolling();
}

// Global click delegation for cross-filter chips — one listener handles
// every clickable-x chip / slice / row on the analytics tab. Listens on
// the analytics panel so we don't fire on unrelated clicks.
document.addEventListener('click', (e) => {
  // Anchor tags inside a data-xf-kind element are pass-throughs — we
  // don't want clicking "listerine breath strips" (a SERP link) to
  // also trigger the row's theme filter.
  if (e.target.closest('a')) return;
  const target = e.target.closest('[data-xf-kind]');
  if (!target) return;
  const kind = target.dataset.xfKind;
  const v = target.dataset.xfV;
  if (!kind || v == null) return;
  e.preventDefault();
  xfToggle(kind, v);
});

// ─────────── Cross-filter helpers ───────────
// Every clickable chip / slice / row calls one of these. They toggle the
// selection (click again to remove) and trigger a full re-render — cards
// and table both react to the same filter set.
function xfToggle(kind, value) {
  const set = analytics.xFilter[kind];
  if (!set) return;
  const key = String(value);
  if (set.has(key)) set.delete(key); else set.add(key);
  filterAndRenderAnalytics();
  renderActiveFiltersBar();
}
function xfClear(kind, value) {
  if (kind === '*') {
    analytics.xFilter = { sources: new Set(), intents: new Set(), tiers: new Set(), themes: new Set() };
  } else if (analytics.xFilter[kind]) {
    if (value === undefined) analytics.xFilter[kind].clear();
    else analytics.xFilter[kind].delete(String(value));
  }
  filterAndRenderAnalytics();
  renderActiveFiltersBar();
}
function xfHas(kind, value) {
  return !!analytics.xFilter[kind]?.has(String(value));
}
function xfCount() {
  const x = analytics.xFilter;
  return x.sources.size + x.intents.size + x.tiers.size + x.themes.size;
}
// Applies the cross-filter set to a row list. Used inside
// filterAndRenderAnalytics before the search/dropdown filters run.
function applyCrossFilter(rows) {
  const x = analytics.xFilter;
  if (xfCount() === 0) return rows;
  return rows.filter(r => {
    if (x.sources.size > 0) {
      const primary = String(r.source || '').split(',')[0].trim().toUpperCase();
      if (!x.sources.has(primary)) return false;
    }
    if (x.intents.size > 0) {
      const intent = String(r.buying_intent || '').toLowerCase();
      if (!x.intents.has(intent)) return false;
    }
    if (x.tiers.size > 0) {
      const tier = scoreTier(opportunityScore(r)).tier;
      if (!x.tiers.has(tier)) return false;
    }
    if (x.themes.size > 0) {
      const kw = String(r.keyword || '').toLowerCase();
      const productName = String(r.product_name || '').toLowerCase();
      let hit = 'other';
      for (const th of KW_THEMES) { if (th.test(kw, productName)) { hit = th.key; break; } }
      if (!x.themes.has(hit)) return false;
    }
    return true;
  });
}
// Active-filters bar — chip per selection, X to remove, one "Clear all"
// button. Only visible when at least one filter is active.
function renderActiveFiltersBar() {
  const el = $('anActiveFilters');
  if (!el) return;
  const x = analytics.xFilter;
  if (xfCount() === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  const chips = [];
  for (const s of x.sources) chips.push({ kind: 'sources', v: s, icon: '📊', label: s });
  for (const s of x.intents) chips.push({ kind: 'intents', v: s, icon: '🎯', label: `${s} intent` });
  for (const s of x.tiers)   chips.push({ kind: 'tiers',   v: s, icon: '⭐', label: `${s} tier` });
  for (const s of x.themes) {
    const th = KW_THEMES.find(t => t.key === s);
    chips.push({ kind: 'themes', v: s, icon: th?.icon || '🎨', label: th?.label || s });
  }
  el.innerHTML = `
    <span class="af-lbl">Filtering by:</span>
    ${chips.map(c => `<button class="af-chip" data-kind="${c.kind}" data-v="${esc(c.v)}" title="Click to remove this filter.">${c.icon} ${esc(c.label)} <span class="af-x">×</span></button>`).join('')}
    <button class="af-clear" data-clear-all="1">Clear all</button>`;
  el.querySelectorAll('button.af-chip').forEach(btn =>
    btn.addEventListener('click', () => xfClear(btn.dataset.kind, btn.dataset.v))
  );
  el.querySelector('button.af-clear')?.addEventListener('click', () => xfClear('*'));
}

function filterAndRenderAnalytics() {
  // Pick working set: selected SKU or all-in-batch.
  const rawSource = analytics.sku
    ? analytics.allRows.filter(r => (r.sku || r.product_url) === analytics.sku)
    : analytics.allRows;

  // Cross-filter (clicks on chips/slices/rows). Applied to `source` before
  // downstream cards so every card reflects the same narrowed set.
  const source = applyCrossFilter(rawSource);

  // Apply UI-control filters (search box + dropdowns) on top of cross-filter.
  const q = ($('anSearch').value || '').trim().toLowerCase();
  const src = $('anSource').value;
  const intent = $('anIntent').value;
  const minRating = parseInt($('anMinRating').value, 10) || 0;
  const onlyImg = $('anOnlyImgMatches').checked;
  const filtered = source.filter(r => {
    if (q && !String(r.keyword || '').toLowerCase().includes(q)) return false;
    // Source match is CONTAINS not equals — multi-source rows like
    // "AUTOSUGGEST, RELATED_SEARCH" must pass when filtering by either.
    if (src) {
      const parts = String(r.source || '').toLowerCase().split(',').map(s => s.trim());
      if (!parts.some(p => p.includes(src.toLowerCase()))) return false;
    }
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
  renderActiveFiltersBar();
  renderAnalyticsHero(source);
  renderExecutiveSummary(source, filtered);
  // NOTE: renderAnalyticsSummary intentionally REMOVED — it duplicated
  // metrics that now live in the hero (keywords / image-match / avg
  // opportunity / KP-vol) plus source+intent chips that Insights already
  // shows via donut chart + intent-mix chips. Kept as a function for
  // any future consumers; not called on the main pipeline.
  renderAnalyticsInsights(source, filtered);
  renderScatter(source);
  renderSourceDonut(source);
  renderCoverageGauge(source);
  renderThemesCard(source);
  renderContentGaps(source);
  renderAnalyticsTopChart(filtered);
  renderAnalyticsTable(filtered);

  const show = source.length > 0 ? '' : 'none';
  ['anHeroWrap', 'anLayerExec', 'anLayerPrioritize', 'anLayerDistribute', 'anLayerContent', 'anLayerDeepDive',
   'anTableCard', 'anTopChartCard'].forEach(id => {
    const el = $(id); if (el) el.style.display = show;
  });
  // Hide the empty-state placeholder once data is on-screen.
  const emptyEl = $('anSummary'); if (emptyEl) emptyEl.style.display = source.length > 0 ? 'none' : '';
  $('anExportBtn').disabled = filtered.length === 0;
  const claudeBtn = $('anClaudeBtn');
  if (claudeBtn) claudeBtn.disabled = source.length === 0;
  const copyKwBtn = $('anCopyKwBtn');
  if (copyKwBtn) copyKwBtn.disabled = source.length === 0;
  // Shopify sync button only makes sense when we're focused on ONE SKU —
  // fetching from Shopify by handle needs a specific product URL.
  const shopBtn = $('anShopifyBtn');
  if (shopBtn) shopBtn.disabled = !(analytics.sku && source.length > 0);
  // Action-bar hint tracks selection state.
  const hint = $('anActionHint');
  if (hint) {
    if (source.length === 0) hint.textContent = 'Pick a batch to begin.';
    else if (analytics.sku) {
      const ctx = source.find(r => r.product_name) || source[0];
      hint.textContent = `${ctx.product_name || analytics.sku} · ${source.length} kw`;
    } else {
      hint.textContent = `All SKUs in batch · ${source.length} kw`;
    }
  }
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

  // Sanity gate: scatter is only meaningful with REAL KP volume on the
  // X-axis. Falling back to integer image_count produces vertical columns
  // of stacked dots — the user called this out as "useless, remove it".
  // Hide the whole card in that state; the Top-10 + Deep-dive still work.
  const volRows = scored.filter(r => r.vol > 0).length;
  if (volRows < 5) {
    // Hide the whole card so the layout doesn't leave an empty rectangle.
    const card = el.closest('.card');
    if (card) card.style.display = 'none';
    if (sub) sub.textContent = '';
    if (title) title.textContent = '';
    return;
  }
  // Restore card visibility for subsequent renders that DO have volume data.
  const card = el.closest('.card');
  if (card) card.style.display = '';

  // X-axis pick — MUST be independent of Score (which weights AdRating
  // heavily). Falling back to AdRating produced a useless diagonal line
  // (Score = 0.6·AdRating + …); dots landed on Score/0.6. Preference order:
  //   1. KP monthly searches (real demand signal) if we have ≥5 rows
  //   2. Image match count (visual SERP reach, capped in Score at ≤5 imgs
  //      so it's largely orthogonal to Score for the long tail)
  //   3. Total sellers (SERP crowding — orthogonal to Score entirely)
  const volCount = scored.filter(r => r.vol > 0).length;
  const imgCount = scored.filter(r => r.imgs > 0).length;
  const sellersOn = scored.filter(r => (Number(r.total_sellers) || 0) > 0).length;
  let mode;
  if (volCount >= Math.min(5, scored.length * 0.1)) mode = 'vol';
  else if (imgCount >= Math.min(5, scored.length * 0.1)) mode = 'imgs';
  else if (sellersOn >= Math.min(5, scored.length * 0.1)) mode = 'sellers';
  else mode = 'imgs'; // desperate fallback still shows *something*
  const xVal = (r) => mode === 'vol' ? r.vol
                    : mode === 'imgs' ? r.imgs
                    :                   (Number(r.total_sellers) || 0);
  const xLabel = mode === 'vol'     ? 'KP monthly searches (log scale)'
              : mode === 'imgs'     ? 'Image matches per SERP (KP volume unavailable)'
              :                       'Total sellers per SERP (KP + image data unavailable)';
  const titleTxt = mode === 'vol'  ? 'Score × Volume — quick-wins quadrant'
                : mode === 'imgs'  ? 'Score × Visual reach — quick-wins quadrant'
                :                    'Score × SERP crowding — quick-wins quadrant';
  if (title) title.textContent = titleTxt;
  if (sub) {
    sub.textContent = mode === 'vol'
      ? `${scored.length} scored · ${volCount} with KP volume`
      : mode === 'imgs'
      ? `${scored.length} scored · using image_count for X (${imgCount} rows with matches). Enable KP backfill for volume-based ranking.`
      : `${scored.length} scored · using total_sellers for X. Enable KP backfill + verify image matching for richer prioritization.`;
  }
  // Log-scale only for volume (spans orders of magnitude). Linear for
  // image_count / total_sellers (single-digit ranges).
  const xScale = mode === 'vol' ? (v) => v > 0 ? Math.log10(v + 1) : 0 : (v) => v;
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

  // Points — click opens the SERP for that keyword. Data attributes carry
  // everything the floating tooltip needs (no SVG <title> fallback since
  // it flashes and blocks the CSS hover UX we want).
  const points = scored.map((r, i) => {
    const cx = sx(xScale(xVal(r)));
    const cy = sy(r.score);
    const rr = radiusFor(r);
    const c = colorFor(r);
    return `<a xlink:href="${esc(r.href)}" target="_blank"><circle
      cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}"
      fill="${c}" fill-opacity="0.65" stroke="${c}" stroke-width="1"
      class="scatter-dot"
      data-idx="${i}"></circle></a>`;
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
    <div class="scatter" id="anScatterBox">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${grid}
        ${quadLines}
        ${points}
        ${quadLabels}
        ${axisLabels}
      </svg>
      <div class="scatter-tt" id="anScatterTip" style="display:none;"></div>
    </div>
    <div class="scatter-legend">
      <span><strong>Intent:</strong></span>
      <span><span class="dot" style="background:${intentColor.high};"></span>high</span>
      <span><span class="dot" style="background:${intentColor.medium};"></span>medium</span>
      <span><span class="dot" style="background:${intentColor.low};"></span>low</span>
      <span><span class="dot" style="background:${intentColor.informational};"></span>informational</span>
      <span style="margin-left: 12px;"><strong>Dot size:</strong> image-match count · <strong>Click any point</strong> to open its SERP · <strong>Hover</strong> for details.</span>
    </div>`;

  // Floating rich tooltip — activates on mouseenter of each dot, tracks
  // the cursor, disappears on mouseleave. Chose absolute-positioned div
  // over SVG <foreignObject> so we can style it with the existing CSS.
  const tip = $('anScatterTip');
  const box = $('anScatterBox');
  const dots = el.querySelectorAll('.scatter-dot');
  dots.forEach(dot => {
    dot.addEventListener('mouseenter', (e) => {
      const idx = parseInt(dot.dataset.idx, 10);
      const r = scored[idx];
      if (!r || !tip) return;
      const bits = [];
      bits.push(`<div class="tt-kw">${esc(r.kw)}</div>`);
      bits.push(`<div class="tt-score" style="color:${scoreTier(r.score).color};">Score ${r.score.toFixed(1)} <span style="opacity:.7;">·</span> ${scoreTier(r.score).tier.toUpperCase()}</div>`);
      const rowBits = [];
      if (r.vol > 0) rowBits.push(`📊 ${r.vol.toLocaleString()} vol`);
      if (r.rating) rowBits.push(`⭐ ${r.rating.toFixed(1)} AdRating`);
      if (r.imgs > 0) rowBits.push(`📷 ${r.imgs} imgs`);
      if (r.intent) rowBits.push(`🎯 ${r.intent} intent`);
      if (rowBits.length) bits.push(`<div class="tt-meta">${rowBits.join(' · ')}</div>`);
      bits.push(`<div class="tt-hint">Click to open the Google SERP →</div>`);
      tip.innerHTML = bits.join('');
      tip.style.display = 'block';
    });
    dot.addEventListener('mousemove', (e) => {
      if (!tip || !box) return;
      const rect = box.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Keep tooltip on-screen: flip to the left of cursor near right edge.
      const flip = x > rect.width - 240;
      tip.style.left = flip ? (x - 240) + 'px' : (x + 12) + 'px';
      tip.style.top  = Math.max(0, y - 60) + 'px';
    });
    dot.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });
  });
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
    const isSelected = xfHas('sources', k);
    const opacity = xfCount() > 0 && !isSelected ? '0.35' : '1';
    const stroke = isSelected ? 'stroke="#fff" stroke-width="2"' : '';
    return `<path d="${d}" fill="${colorFor(k)}" fill-opacity="${opacity}" style="cursor:pointer;" data-xf-kind="sources" data-xf-v="${esc(k)}" ${stroke}><title>Click to filter → ${esc(k)}: ${v} (${Math.round(frac * 100)}%)</title></path>`;
  }).join('');

  const legend = entries.map(([k, v]) => {
    const pct = Math.round((v / total) * 100);
    const sel = xfHas('sources', k) ? ' style="background:var(--info-soft);"' : '';
    return `<div class="lg-row clickable-x" data-xf-kind="sources" data-xf-v="${esc(k)}"${sel} title="Click to filter dashboard to ${esc(k)} only.">
      <span class="lg-swatch" style="background:${colorFor(k)};"></span>
      <span class="lg-name">${esc(k)}${xfHas('sources', k) ? ' ✓' : ''}</span>
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
    const sel = xfHas('themes', c.theme.key);
    return `
      <div class="theme-row clickable-x${sel ? ' selected' : ''}" data-xf-kind="themes" data-xf-v="${esc(c.theme.key)}" title="Click to filter dashboard to ${esc(c.theme.label)} keywords only." style="${sel ? 'background: var(--info-soft);' : ''}">
        <div class="theme-name" style="color:${c.theme.color};">
          <span style="font-size:14px;">${c.theme.icon}</span>&nbsp;<strong>${esc(c.theme.label)}</strong>${sel ? ' ✓' : ''}
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
    if (await copyToClipboard(text)) toast(`${topGaps.length} question(s) copied.`, 'ok');
    else toast('Copy failed — select the list and Ctrl+C manually.', 'err');
  });
  if (sub) sub.textContent = `${topGaps.length} gap(s) · top ${Math.min(20, topGaps.length)} shown`;
}

// ─────────── Analytics hero ───────────
// Top-of-tab identity block + 6 metric cards. Same visual grammar as the
// Dashboard hero (renderDashHero) but tuned to the per-SKU signals users
// scan: kw count vs 100-300 target, avg opportunity, image visibility,
// KP volume coverage, high-intent count, data-quality grade.
function renderAnalyticsHero(rows) {
  const wrap = $('anHeroWrap');
  const hero = $('anHero');
  const prod = $('anHeroProduct');
  if (!wrap || !hero || !prod) return;
  if (!rows || rows.length === 0) { wrap.style.display = 'none'; return; }

  const ctx = rows.find(r => r.product_name) || rows[0];
  const productName = ctx.product_name || analytics.sku || '(unnamed SKU)';
  const productUrl  = ctx.product_url || '';
  const sku         = analytics.sku || ctx.sku || '';

  // Data-quality composite grade — same logic as the SKU picker preview
  // but restated here so the hero is self-contained. 0-8 pts.
  const withVol   = rows.filter(r => (toNum(r.kp_monthly_searches) || 0) > 0).length;
  const withImg   = rows.filter(r => (toNum(r.image_count) || 0) > 0).length;
  const highIntent = rows.filter(r => String(r.buying_intent || '').toLowerCase() === 'high').length;
  const volPct  = Math.round((withVol   / rows.length) * 100);
  const imgPct  = Math.round((withImg   / rows.length) * 100);
  const highPct = Math.round((highIntent / rows.length) * 100);
  let dq = 0;
  if (rows.length >= 100) dq += 2; else if (rows.length >= 50) dq += 1;
  if (volPct   >= 50) dq += 2; else if (volPct   >= 20) dq += 1;
  if (imgPct   >= 30) dq += 2; else if (imgPct   >= 10) dq += 1;
  if (highPct  >= 20) dq += 2; else if (highPct  >= 10) dq += 1;
  const grade = dq >= 7 ? { l: 'A', c: 'var(--success)', t: 'Trustworthy — full signal set' }
              : dq >= 5 ? { l: 'B', c: 'var(--accent)',  t: 'Solid — most signals present' }
              : dq >= 3 ? { l: 'C', c: 'var(--warn)',    t: 'Partial — some signals missing' }
              :           { l: 'D', c: 'var(--danger)',  t: 'Thin — analytics may mislead' };

  // Product identity strip.
  prod.innerHTML = `
    <div class="an-hp-name" title="${esc(productName)}">${esc(productName)}</div>
    ${sku ? `<span class="an-hp-sku">${esc(sku)}</span>` : ''}
    <span class="an-hp-badge" style="background:${grade.c}20; color:${grade.c}; border-color:${grade.c};" title="Data quality: ${esc(grade.t)}">DQ ${grade.l}</span>
    ${productUrl ? `<a href="${esc(productUrl)}" target="_blank" rel="noopener" class="an-hp-link">Open product ↗</a>` : ''}
  `;

  // Data-quality banner — prominent, actionable warnings for the specific
  // issues we can diagnose from the data itself. Only one banner shows at
  // a time (most critical first) so users aren't drowned in warnings.
  const banner = document.getElementById('anDataQualityBanner');
  if (banner) {
    let msg = null;
    if (volPct === 0 && rows.length >= 20) {
      msg = {
        tone: 'warn',
        icon: '⚠',
        title: 'KP volume data missing on every row',
        body: `Ranking relies purely on relevance + image matches. To fix: (1) confirm the Keyword Planner URL is set in <a href="#" data-jump-tab="config" style="color:inherit; text-decoration:underline;">Config → Worker config</a>, (2) ensure the worker's Google Ads session is signed in, (3) verify <code>backfillKpMetrics</code> is enabled per worker. Once fixed, the Score × Volume scatter and Volume column populate automatically.`,
      };
    } else if (rows.length < 100) {
      msg = {
        tone: 'info',
        icon: '💡',
        title: `Only ${rows.length} keywords collected (target: 100–300)`,
        body: `Coverage is below the target range. To widen the net: (1) confirm autosuggest expansion is enabled, (2) check for competitor-brand filter over-rejection in the discovery logs, (3) consider raising <code>MAX_R1_KP_SERP_SEEDS</code> (currently 60) in <code>modules/keyword-discovery.js</code>.`,
      };
    } else if (imgPct === 0 && rows.length >= 20) {
      msg = {
        tone: 'warn',
        icon: '⚠',
        title: 'Product does not surface visually on any SERP',
        body: `0 image matches across ${rows.length} keywords. Investigate: (1) product images may not be indexed by Google Images, (2) Merchant Center feed missing, (3) CLIP threshold may be too strict (Config → Worker config). Without visual visibility our organic footprint is negligible.`,
      };
    }
    if (msg) {
      banner.innerHTML = `
        <div class="dq-banner tone-${msg.tone}">
          <div class="dq-icon">${msg.icon}</div>
          <div class="dq-content">
            <div class="dq-title">${esc(msg.title)}</div>
            <div class="dq-body">${msg.body}</div>
          </div>
          <button class="dq-close" title="Dismiss this warning for the session.">×</button>
        </div>`;
      banner.style.display = '';
      banner.querySelector('.dq-close')?.addEventListener('click', () => { banner.style.display = 'none'; });
      // Tab-jump link handler.
      banner.querySelector('[data-jump-tab]')?.addEventListener('click', (e) => {
        e.preventDefault();
        const t = e.target.dataset.jumpTab;
        document.querySelector(`.tab[data-tab="${t}"]`)?.click();
      });
    } else {
      banner.style.display = 'none';
    }
  }

  // Cards.
  const scored = rows.map(r => ({ ...r, __s: opportunityScore(r) }));
  const excellent = scored.filter(r => r.__s >= 12).length;
  const avgScore = scored.reduce((s, r) => s + r.__s, 0) / scored.length;
  const target = rows.length < 100 ? { tone: 'warn',    hint: `${100 - rows.length} short of 100 min` }
               : rows.length > 300 ? { tone: 'info',    hint: `${rows.length - 300} over 300 max` }
               :                     { tone: 'success', hint: `on target (100–300)` };
  const cards = [
    { tone: target.tone,                         icon: '🔍', label: 'Keywords',        value: rows.length.toLocaleString(),   sub: target.hint },
    { tone: excellent > 0 ? 'success' : 'neutral',icon: '⭐', label: 'Excellent tier',   value: excellent,                       sub: `avg score ${avgScore.toFixed(1)}` },
    { tone: imgPct >= 30 ? 'success' : imgPct > 0 ? 'info' : 'warn', icon: '📷', label: 'Image match', value: `${imgPct}%`, sub: `${withImg} of ${rows.length} rows` },
    { tone: volPct > 0 ? 'success' : 'warn',     icon: '📊', label: 'KP volume rows',  value: `${volPct}%`,                    sub: volPct === 0 ? 'no KP data yet' : `${withVol} of ${rows.length}` },
    { tone: highPct >= 20 ? 'success' : highPct >= 10 ? 'info' : 'neutral', icon: '🎯', label: 'High-intent', value: highIntent, sub: `${highPct}% of pool` },
    { tone: 'info',                              icon: '💎', label: 'Top score',       value: (scored[0]?.__s ?? 0).toFixed(1), sub: scored[0]?.keyword ? esc(String(scored[0].keyword).slice(0, 30)) : '—' },
  ];
  hero.innerHTML = cards.map(c => `
    <div class="hero-card tone-${c.tone}">
      <div class="hero-icon">${c.icon}</div>
      <div class="hero-label">${esc(c.label)}</div>
      <div class="hero-value">${c.value}</div>
      <div class="hero-sub">${c.sub}</div>
    </div>`).join('');
  wrap.style.display = '';
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

  // NOTE: The 3 takeaways that used to lead this section — "Keyword
  // coverage", "Search-demand data", "Visual visibility" — were removed
  // as unwanted duplicates. Keyword count + status already shows in the
  // KEYWORDS hero card + coverage gauge; KP-vol status shows in the KP
  // VOLUME ROWS hero card + the top-of-page diagnostic banner; image %
  // shows in the IMAGE MATCH hero card. Business Takeaways now carries
  // only what those don't: intent balance, discovery mix, merchandising
  // wins, and the top-opportunity spotlight.

  // Intent balance takeaway.
  if (highPct >= 25) {
    takeaways.push({ tone: 'success', label: 'Buying-intent balance', body: `<strong>${highPct}%</strong> of keywords are high-buying-intent — a strong pool to drive paid ads and category pages against.` });
  } else if (highPct >= 10) {
    takeaways.push({ tone: 'info', label: 'Buying-intent balance', body: `${highPct}% high-intent, ${lowPct}% low-intent. Split marketing: high-intent for ads, low-intent for SEO content/blog.` });
  } else {
    takeaways.push({ tone: 'warn', label: 'Buying-intent balance', body: `Only ${highPct}% high-intent (${lowPct}% low). Expand around "buy", "price", "best", "review", and city-modified queries to lift commercial intent.` });
  }

  // Best channel takeaway — inline text (used to embed an ugly chip
  // that fought the takeaway's own tone-border for attention).
  if (topSrc) {
    const [srcName, srcCount] = topSrc;
    const srcPct = Math.round((srcCount / scored.length) * 100);
    const overweight = srcPct >= 60;
    takeaways.push({
      tone: overweight ? 'info' : 'neutral',
      label: 'Discovery mix',
      body: overweight
        ? `<strong>${srcPct}%</strong> of the pool came from a single source (<code>${esc(srcName)}</code>). Diversify by adding more KP seeds or a deeper autosuggest crawl.`
        : `Top source: <code>${esc(srcName)}</code> (${srcPct}%). Discovery is well-distributed across ${Object.keys(primarySrc).length} sources.`,
    });
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

  // Attach scores so the histogram + actionable tiles are computed from
  // the same ordering the rest of the tab uses.
  const scored = sourceRows.map(r => ({ ...r, __s: opportunityScore(r) }));

  // Actionable tiles.
  const total = scored.length;
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

  // ── Score-tier counts ─────────────────────────────────────────
  // The prior version rendered a 4-bar histogram — but score-tier is
  // already color-coded on every row in the Deep-dive table (green/blue/
  // amber/grey left border), so a whole SVG chart was showing the same
  // information twice. Kept as inline counts in the .tier-strip below.
  const tiers = { excellent: 0, good: 0, ok: 0, low: 0 };
  for (const r of scored) tiers[scoreTier(r.__s).tier]++;

  // Render. The KP-coverage + image-match tiles that used to live here
  // are now in the hero — showing them again in Insights was pure
  // duplication. We keep the two ACTIONABLE tiles (low-comp+high-vol
  // opportunities + dropy-already-listed count) because those aren't
  // in the hero and drive concrete next actions.
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
      ${skuCoverageBlock}
    </div>

    <div class="tier-strip">
      <span style="color:var(--success);"><strong>${tiers.excellent}</strong> excellent</span>
      <span style="color:var(--accent);"><strong>${tiers.good}</strong> good</span>
      <span style="color:var(--warn);"><strong>${tiers.ok}</strong> ok</span>
      <span style="color:var(--text-3);"><strong>${tiers.low}</strong> weak</span>
      <span class="hint" style="margin-left:auto;">${total.toLocaleString()} keywords · tier by opportunity score</span>
    </div>
  `;
  // Removed: Top-3 opportunities (Top-10 bar chart owns this in Prioritize),
  // Best-performing sources (Source donut owns this in Distribution),
  // Buying-intent mix (scatter color-encodes intent + Deep-dive Intent
  // column). Three duplicated views became one histogram.
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
  if (top.length === 0) { el.innerHTML = `<div class="hint">No scored keywords yet.</div>`; $('anTopChartSub').textContent = '—'; return; }
  // Normalize bars against the ACTUAL score span of the whole batch (min→max),
  // not top-N only. Previously bars normalized against max-of-top-10 → when
  // scores clustered (e.g. all top-10 in 60-65) every bar rendered near 100%
  // width and the chart discriminated nothing.
  const batchMax = Math.max(...rows.map(r => r.opportunity_score || 0), 1);
  const batchMin = Math.min(...rows.map(r => r.opportunity_score || 0), 0);
  const span = Math.max(batchMax - batchMin, 0.1);
  $('anTopChartSub').textContent = `range ${batchMin.toFixed(1)} → ${batchMax.toFixed(1)}`;
  el.innerHTML = top.map(r => {
    const kwRaw = String(r.keyword || '—');
    const kw    = esc(kwRaw);
    const score = toNum(r.opportunity_score) ?? 0;
    // Position within actual data span — a score at batchMax renders full,
    // a score at batchMin renders empty. Discriminates the actual differences.
    const pct   = Math.round(((score - batchMin) / span) * 100);
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
        // Source column: collapse multi-source strings to primary chip
        // + "+N" badge. Prior render stacked every source as its own chip,
        // making rows 3-4 lines tall on multi-source keywords. Full list
        // lives in the tooltip.
        if (c.key === 'source') {
          const parts = String(v).split(',').map(s => s.trim()).filter(Boolean);
          const primary = parts[0];
          const p = primary.toLowerCase();
          const cls = p.includes('kp') ? 'src-kp'
                    : p.includes('autosuggest') ? 'src-autosuggest'
                    : p.includes('serp') ? 'src-serp'
                    : p.includes('paa') ? 'src-paa'
                    : p.includes('related') ? 'src-related'
                    : p.includes('amazon') ? 'src-amazon'
                    : 'pending';
          const more = parts.length > 1
            ? `<span class="more-badge" title="Also from: ${esc(parts.slice(1).join(', '))}">+${parts.length - 1}</span>`
            : '';
          return `<td><span class="multi-src"><span class="chip ${cls}" title="${esc(v)}">${esc(primary)}</span>${more}</span></td>`;
        }
        let cls;
        if (c.key === 'keyword_relevance') {
          const s = String(v).toLowerCase();
          cls = s === 'high' ? 'done' : s === 'medium' ? 'claimed' : s.includes('sibling') ? 'src-paa' : 'pending';
        } else {
          cls = String(v) === 'high' ? 'done' : String(v) === 'medium' ? 'claimed' : 'pending';
        }
        return `<td><span class="chip ${cls}">${esc(v)}</span></td>`;
      }
      if (c.kind === 'imgs') {
        const n = toNum(v);
        const isZero = !n || n === 0;
        return `<td class="num" ${isZero ? 'data-zero="1"' : ''} style="color:${isZero ? 'var(--text-3)' : 'var(--success)'}; font-weight:${isZero ? '400' : '600'};">${n ?? 0}</td>`;
      }
      if (c.kind === 'rating') {
        const n = toNum(v);
        if (n == null) return `<td class="num" data-zero="1">—</td>`;
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
        if (!s || s === '—') return `<td class="num" data-zero="1">—</td>`;
        // Chip-style pill so KP competition reads instantly:
        // Low = green (easy target), Medium = amber (moderate),
        // High = red (crowded). Text-only rendering blended in with
        // all the other numeric columns.
        const cls = s === 'high' ? 'chip-high' : s === 'medium' ? 'chip-med' : 'chip-low';
        return `<td><span class="comp-chip ${cls}">${esc(v)}</span></td>`;
      }
      if (c.kind === 'money') {
        const n = toNum(v);
        if (n == null || n === 0) return `<td class="num" data-zero="1">—</td>`;
        return `<td class="num" style="color:var(--text-1); font-weight:600;">₹${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>`;
      }
      if (c.kind === 'pct') {
        const n = toNum(v);
        if (n == null || n === 0) return `<td class="num" data-zero="1">—</td>`;
        // Visibility % is one of the most actionable signals — make
        // high values pop visually with weight + color.
        const color = n >= 50 ? 'var(--success)' : n >= 20 ? 'var(--warn)' : 'var(--text-2)';
        const weight = n >= 50 ? 700 : n >= 20 ? 600 : 400;
        return `<td class="num" style="color:${color}; font-weight:${weight};">${n.toFixed(0)}%</td>`;
      }
      if (c.kind === 'yesno') {
        const yes = String(v || '').toLowerCase() === 'yes' || v === true || v === 1;
        return yes ? `<td class="num" style="color:var(--success); font-weight:700;">✓</td>` : `<td class="num" data-zero="1">·</td>`;
      }
      if (c.kind === 'num') {
        const n = toNum(v);
        if (n == null) return `<td class="num" data-zero="1">—</td>`;
        // Zero numbers are visible but dimmed so 0 vs non-zero reads at
        // a glance in a wide table of numeric columns.
        return `<td class="num" ${n === 0 ? 'data-zero="1"' : ''}>${n.toLocaleString()}</td>`;
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
// Wire fleet + monitor delegation EAGERLY at boot instead of lazily on
// first fleet render. Older lazy path had a race: user could click a
// button between initial render (before wire) and the moment wireFleetDelegation
// finally ran. Eager attach = zero race.
wireFleetDelegation(null);
// Expose openWorkerMonitor globally so any inline onclick fallback in
// the fleet row can always dispatch, even if the delegation somehow
// failed to attach.
window.openWorkerMonitor = openWorkerMonitor;
// Reparent every .modal-root to <body>. All 6 modals are currently
// declared inside <section id="panel-analytics"> in index.html, which
// means when the Dashboard (or any other) tab is active, that section
// has display:none → its DESCENDANTS are hidden regardless of their own
// display style. Setting modal.style.display='flex' had no visible effect
// because a display:none ancestor overrides child display. Users saw the
// "click Monitor on Dashboard → nothing → switch to Analytics → modal
// appears" flakiness. Moving modals to <body> escapes the panel and makes
// them always visible when opened, from any tab.
document.querySelectorAll('.modal-root').forEach(m => {
  if (m.parentElement !== document.body) document.body.appendChild(m);
});

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
