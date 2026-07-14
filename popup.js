// popup.js — Worker extension popup (side panel).
//
// The worker's whole job is: cold-start → auto-arm from
// worker-config.json → 30s alarm claims work from the manager →
// engine processes it → results pushed to the manager over HTTP.
//
// This popup is a read-only status panel with three emergency-override
// buttons. All configuration lives on the manager PC's web app; there
// is no config UI here on purpose.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

function fmtTime(t) {
  if (!t) return '—';
  const d = typeof t === 'number' ? new Date(t) : new Date(String(t));
  return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─────────── Message helper ───────────
function rpc(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (resp) => resolve(resp || { ok: false, error: 'no response' }));
  });
}

// ─────────── State snapshot ───────────
const state = {
  managerUrl: '',
  managerToken: '',
  kpUrl: '',
  matchProfile: 'normal',
  workerId: '',
  running: false,
  workerArmed: false,
  paused: false,   // pausedByCaptcha OR user-Stop
  batchId: '',
  lastStatus: '',
  done: 0,
  total: 0,
  log: [],
  connectionHealth: null,
};

// ─────────── Status pill logic ───────────
function computeStatus() {
  if (state.running) return { key: 'running', text: 'running' };
  if (state.paused)  return { key: 'paused',  text: 'paused' };
  if (state.workerArmed) return { key: 'armed', text: 'armed · waiting for work' };
  return { key: 'stopped', text: 'stopped' };
}
function renderStatus() {
  const s = computeStatus();
  const pill = $('statusPill');
  pill.className = `pill ${s.key}`;
  $('statusText').textContent = s.text;
}

// ─────────── Render ───────────
function renderConfig() {
  const setV = (id, val, opts = {}) => {
    const el = $(id);
    if (!el) return;
    const empty = !val;
    el.textContent = empty ? (opts.emptyLabel || '—') : val;
    el.title = empty ? '' : val;
    el.classList.toggle('muted', empty);
  };
  setV('managerUrl',   state.managerUrl,   { emptyLabel: 'not configured — run installer' });
  setV('workerId',     state.workerId,     { emptyLabel: 'not assigned' });
  setV('kpUrl',        state.kpUrl,        { emptyLabel: 'not pushed by manager yet' });
  setV('matchProfile', state.matchProfile, {});
  setV('currentBatch', state.batchId,      { emptyLabel: 'no active batch' });

  // Health details from connectionHealth
  const h = state.connectionHealth;
  const hEl = $('healthStatus');
  if (!h) {
    hEl.textContent = '—'; hEl.classList.add('muted');
  } else if (h.ok) {
    hEl.textContent = `✓ ${h.latencyMs}ms`;
    hEl.style.color = 'var(--success)';
    hEl.classList.remove('muted');
  } else {
    hEl.textContent = `⚠ ${h.error || 'offline'}`;
    hEl.style.color = 'var(--danger)';
    hEl.classList.remove('muted');
  }
}
function renderProgress() {
  $('lastStatus').textContent = state.lastStatus || '—';
  $('lastStatus').classList.toggle('muted', !state.lastStatus);
  if (state.total > 0) {
    $('progressText').textContent = `${state.done}/${state.total}`;
  } else {
    $('progressText').textContent = '—';
  }
  // Button availability
  $('pauseBtn').disabled  = !state.running;
  $('resumeBtn').disabled = state.running || (state.workerArmed && !state.paused);
  $('stopBtn').disabled   = !state.running && !state.workerArmed;
}
function renderLog() {
  const el = $('workerLog');
  const lines = state.log.slice(-50).reverse();
  if (lines.length === 0) {
    el.innerHTML = `<div class="log-empty">No activity yet.</div>`;
    return;
  }
  el.innerHTML = lines.map(l => {
    const kind = l.kind === 'err' || l.kind === 'error' ? 'err'
      : l.kind === 'warn' ? 'warn'
      : l.kind === 'ok' ? 'ok' : '';
    return `<div class="log-line ${kind}"><span class="ts">${fmtTime(l.ts)}</span>${esc(l.text || '')}</div>`;
  }).join('');
}

// ─────────── Refresh loop ───────────
async function refresh() {
  const [st, storage] = await Promise.all([
    rpc('getState'),
    new Promise(r => chrome.storage.local.get(
      ['adbrainManagerUrl', 'adbrainKpUrl', 'adbrainMatchProfile'],
      d => r(d)
    )),
  ]);
  state.managerUrl   = storage.adbrainManagerUrl || '';
  state.kpUrl        = storage.adbrainKpUrl || '';
  state.matchProfile = storage.adbrainMatchProfile || 'normal';

  state.workerId     = st.workerId || '';
  state.running      = !!st.running;
  state.workerArmed  = !!st.workerArmed;
  state.paused       = !!st.pausedByCaptcha || String(st.lastStatus || '').toLowerCase().includes('paused');
  state.batchId      = st.batchId || st.queueBatchId || '';
  state.lastStatus   = st.lastStatus || '';
  state.done         = st.doneProducts || 0;
  state.total        = st.totalProducts || 0;
  state.log          = Array.isArray(st.log) ? st.log : [];
  state.connectionHealth = st.connectionHealth || null;

  renderStatus();
  renderConfig();
  renderProgress();
  renderLog();
  $('lastRefresh').textContent = `refreshed ${fmtTime(Date.now())}`;
}

// ─────────── Controls ───────────
$('pauseBtn').addEventListener('click', async () => {
  // "Pause" = stop after current SKU. We use stopDiscovery with a follow-up
  // that keeps workerArmed=true so the 30s auto-poll re-claims once the
  // user clicks Resume. Simplest reliable pause is: stopDiscovery (which
  // disarms) + immediately re-arm without a manual claim.
  if (!confirm('Pause after the current SKU finishes?')) return;
  await rpc('stopDiscovery');
  // Re-arm so future Resume + auto-poll picks up work.
  await new Promise(r => chrome.storage.local.set({
    adbrainWorkerArmed: true, adbrainUserStoppedArm: false,
  }, r));
  refresh();
});
$('resumeBtn').addEventListener('click', async () => {
  // Clear the stop-arm flag and let the auto-poll claim on its next tick.
  await new Promise(r => chrome.storage.local.set({
    adbrainWorkerArmed: true, adbrainUserStoppedArm: false,
  }, r));
  // Give the alarm a nudge — try to resume an in-progress run first.
  await rpc('resumeDiscovery');
  refresh();
});
$('stopBtn').addEventListener('click', async () => {
  if (!confirm('Stop the worker and disarm? It will not claim more work until you click Resume.')) return;
  await rpc('stopDiscovery');
  refresh();
});
$('clearLogBtn').addEventListener('click', async () => {
  if (!confirm('Clear the local log on this worker PC?')) return;
  await new Promise(r => chrome.storage.local.set({ adbrainLog: [] }, r));
  state.log = [];
  renderLog();
});
$('openManager').addEventListener('click', (e) => {
  e.preventDefault();
  if (!state.managerUrl) { alert('Manager URL not configured yet — check the installer output.'); return; }
  chrome.tabs.create({ url: state.managerUrl });
});

// ─────────── Boot ───────────
refresh();
// Refresh every 3s while the popup is open. Chrome kills this on close.
setInterval(refresh, 3000);
