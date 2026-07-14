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
  // Today counters — refreshed by hitting the manager's /api/keywords/timeline
  // and per-product endpoints filtered to THIS worker + since-midnight.
  todayDone: 0,
  todayKw: 0,
  todayHourly: [],  // 12 buckets of {n} for sparkline
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
function renderToday() {
  $('todayDone').textContent = state.todayDone.toLocaleString();
  $('todayKw').textContent   = state.todayKw.toLocaleString();
  $('todayAvg').textContent  = state.todayDone > 0 ? Math.round(state.todayKw / state.todayDone).toLocaleString() : '—';
  // Sparkline — 12 buckets, most recent on the right.
  const el = $('workerSparkline');
  const bars = state.todayHourly.slice(-12);
  const max = Math.max(1, ...bars.map(b => b.n || 0));
  if (bars.length === 0) {
    el.innerHTML = `<div style="width:100%; text-align:center; color: var(--text-3); font-size: 10px;">no data yet</div>`;
    return;
  }
  el.innerHTML = bars.map(b => {
    const h = Math.max(2, Math.round((b.n / max) * 100));
    return `<div style="flex:1; background: var(--info); opacity: ${b.n ? 0.8 : 0.15}; height:${h}%; border-radius:1px;" title="${b.n} row(s)"></div>`;
  }).join('');
}

// Fetch today's counters + hourly sparkline from the manager. Runs less often
// than the local state refresh — every 30s while popup is open.
async function refreshToday() {
  if (!state.managerUrl) return;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  try {
    const headers = {};
    if (state.managerToken) headers['X-Manager-Token'] = state.managerToken;
    const r = await fetch(`${state.managerUrl}/api/keywords/timeline`, { headers });
    if (!r.ok) return;
    const j = await r.json();
    const buckets = (j.buckets || []).filter(b => b.bucket >= since);
    state.todayKw = buckets.reduce((s, b) => s + (b.n || 0), 0);
    // Build a 12-bucket sparkline (last 12 hours).
    const nowH = Math.floor(Date.now() / 3600000) * 3600000;
    const byBucket = new Map(buckets.map(b => [Number(b.bucket), Number(b.n)]));
    state.todayHourly = [];
    for (let i = 11; i >= 0; i--) {
      const b = nowH - i * 3600000;
      state.todayHourly.push({ bucket: b, n: byBucket.get(b) || 0 });
    }
  } catch {}
  renderToday();
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
// Persist today's baseline so a popup reopen doesn't reset the counter.
// Stored as {date: 'YYYY-MM-DD', baselineDone: <int>}.
async function readTodayBaseline() {
  return new Promise(r => chrome.storage.local.get(['adbrainTodayBaseline'], d => r(d.adbrainTodayBaseline || null)));
}
async function writeTodayBaseline(bl) {
  return new Promise(r => chrome.storage.local.set({ adbrainTodayBaseline: bl }, r));
}
function todayKey() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function refresh() {
  const [st, storage, baseline] = await Promise.all([
    rpc('getState'),
    new Promise(r => chrome.storage.local.get(
      ['adbrainManagerUrl', 'adbrainManagerToken', 'adbrainKpUrl', 'adbrainMatchProfile'],
      d => r(d)
    )),
    readTodayBaseline(),
  ]);
  state.managerUrl   = storage.adbrainManagerUrl || '';
  state.managerToken = storage.adbrainManagerToken || '';
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

  // Today baseline maintenance: on midnight rollover snapshot the current
  // doneProducts as the new day's baseline; todayDone = current - baseline.
  const today = todayKey();
  if (!baseline || baseline.date !== today) {
    const bl = { date: today, baselineDone: state.done };
    await writeTodayBaseline(bl);
    state.todayDone = 0;
  } else {
    state.todayDone = Math.max(0, state.done - baseline.baselineDone);
  }

  renderStatus();
  renderConfig();
  renderProgress();
  renderLog();
  renderToday();
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
refreshToday();
// Refresh local state every 3s while the popup is open. Today counters
// refresh less often (every 30s) — they hit the manager over HTTP.
setInterval(refresh,      3000);
setInterval(refreshToday, 30000);
