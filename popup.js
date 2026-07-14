// popup.js — Worker extension popup (side panel).
//
// The worker's whole job is: cold-start → auto-arm from
// worker-config.json → 30s alarm claims work from the manager →
// engine processes it → results pushed to the manager over HTTP.
//
// This popup is a read-only status panel with a big hero + three
// emergency-override buttons. All configuration lives on the manager
// PC's web app; there is no config UI here on purpose.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

function fmtTime(t) {
  if (!t) return '—';
  const d = typeof t === 'number' ? new Date(t) : new Date(String(t));
  return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtAgo(t) {
  if (!t) return '';
  const ms = Date.now() - (typeof t === 'number' ? t : Number(t));
  if (isNaN(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function rpc(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (resp) => resolve(resp || { ok: false, error: 'no response' }));
  });
}

// The worker service-worker fires the auto-poll alarm every 30 seconds.
// Track the last known "known-good" refresh time so we can render a
// countdown to the next poll — gives users a visible cycle indicator.
const POLL_INTERVAL_MS = 30 * 1000;
let nextPollAt = Date.now() + POLL_INTERVAL_MS;

const state = {
  managerUrl: '',
  managerToken: '',
  kpUrl: '',
  matchProfile: 'normal',
  workerId: '',
  running: false,
  workerArmed: false,
  paused: false,
  batchId: '',
  lastStatus: '',
  done: 0,
  total: 0,
  doneProductsList: [],   // used for the recent-SKUs strip
  log: [],
  connectionHealth: null,
  todayDone: 0,
  todayKw: 0,
  todayHourly: [],
};

// ─────────── Hero status ───────────
function computeState() {
  if (!state.managerUrl) return { key: 'stopped', head: 'Not configured', sub: 'Run the installer on this PC' };
  if (state.connectionHealth && !state.connectionHealth.ok) return { key: 'stopped', head: 'Connection lost', sub: state.connectionHealth.error || 'Unable to reach manager' };
  if (state.running) {
    const action = (state.lastStatus || '').replace(/^\W+\s*/, '') || 'Processing';
    return { key: 'running', head: 'Running', sub: action };
  }
  if (state.paused) return { key: 'paused', head: 'Paused', sub: state.lastStatus || 'Waiting for resume' };
  if (state.workerArmed) return { key: 'armed', head: 'Ready — waiting for work', sub: 'Manager has no pending SKUs right now' };
  return { key: 'stopped', head: 'Stopped', sub: 'Click Resume to arm the worker' };
}

function renderHero() {
  const s = computeState();
  const hero = $('hero');
  hero.className = `hero state-${s.key}`;
  $('heroHeadline').textContent = s.head;
  $('heroSub').textContent = s.sub;
  $('workerIdTop').textContent = state.workerId ? `#${state.workerId}` : '—';
  // Batch pill: only when there's an active batch
  const bwrap = $('heroBatch');
  if (state.batchId) {
    bwrap.innerHTML = `<span class="hero-batch">batch ${esc(state.batchId)}</span>`;
  } else {
    bwrap.innerHTML = '';
  }
  // Batch progress bar
  const bp = $('batchProgress');
  if (state.total > 0) {
    const pct = Math.min(100, Math.round((state.done / state.total) * 100));
    bp.style.display = '';
    $('batchProgressFill').style.width = `${pct}%`;
    $('batchProgressPct').textContent = `${state.done}/${state.total} · ${pct}%`;
  } else {
    bp.style.display = 'none';
  }
}

// Countdown to next auto-poll — ticked every second. When it hits 0
// we re-arm to POLL_INTERVAL_MS and let the actual alarm handler drive
// state changes.
function renderCountdown() {
  const ms = Math.max(0, nextPollAt - Date.now());
  const s = Math.ceil(ms / 1000);
  const el = $('heroCountdown');
  if (state.running) {
    el.textContent = 'polling…';
    el.classList.remove('imminent');
    return;
  }
  el.textContent = `next in ${s}s`;
  el.classList.toggle('imminent', s <= 5);
  if (ms === 0) nextPollAt = Date.now() + POLL_INTERVAL_MS;
}

// ─────────── Error banner ───────────
function renderErrBanner() {
  const el = $('errBanner');
  const h = state.connectionHealth;
  if (!state.managerUrl) {
    el.classList.add('visible');
    $('errBannerMsg').textContent = 'Manager URL not configured. The installer should have set this — did you Load Unpacked from the right folder?';
    return;
  }
  if (h && !h.ok) {
    el.classList.add('visible');
    $('errBannerMsg').textContent = `Cannot reach manager: ${h.error || 'unknown error'}`;
    return;
  }
  el.classList.remove('visible');
}

// ─────────── Config panel ───────────
function renderConfig() {
  const setV = (id, val, empty = '—') => {
    const el = $(id); if (!el) return;
    const isEmpty = !val;
    el.textContent = isEmpty ? empty : val;
    el.title = isEmpty ? '' : val;
    el.classList.toggle('muted', isEmpty);
  };
  setV('managerUrl',   state.managerUrl,   'not configured');
  setV('kpUrl',        state.kpUrl,        'awaiting manager push');
  setV('matchProfile', state.matchProfile, 'normal');

  const h = state.connectionHealth;
  const hEl = $('healthStatus');
  if (!h) { hEl.textContent = '—'; hEl.classList.add('muted'); hEl.style.color = ''; }
  else if (h.ok)  { hEl.textContent = `✓ ${h.latencyMs}ms`; hEl.style.color = 'var(--success)'; hEl.classList.remove('muted'); }
  else            { hEl.textContent = `⚠ ${h.error || 'offline'}`; hEl.style.color = 'var(--danger)'; hEl.classList.remove('muted'); }
}

// ─────────── Recent SKUs strip ───────────
function renderRecent() {
  const card = $('recentCard');
  const list = $('recentList');
  const items = (state.doneProductsList || []).slice(-5).reverse();
  if (items.length === 0) { card.style.display = 'none'; return; }
  card.style.display = '';
  list.innerHTML = items.map(u => {
    // doneProductsList entries are product_urls; extract a compact identifier.
    const slug = String(u).replace(/^https?:\/\/[^/]+/, '').replace(/^\/products\//, '').slice(0, 40);
    return `<li>
      <span class="ok-icon">✓</span>
      <span class="name" title="${esc(u)}">${esc(slug || u)}</span>
    </li>`;
  }).join('');
}

// ─────────── Buttons + Log ───────────
function renderControls() {
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

// ─────────── Today counters + sparkline ───────────
function renderToday() {
  $('todayDone').textContent = state.todayDone.toLocaleString();
  $('todayKw').textContent   = state.todayKw.toLocaleString();
  $('todayAvg').textContent  = state.todayDone > 0 ? Math.round(state.todayKw / state.todayDone).toLocaleString() : '—';
  const el = $('workerSparkline');
  const bars = state.todayHourly.slice(-12);
  const max = Math.max(1, ...bars.map(b => b.n || 0));
  if (bars.length === 0) {
    el.innerHTML = `<div style="width:100%; text-align:center; color: var(--text-3); font-size: 9px;">no data yet</div>`;
    return;
  }
  const nowH = Math.floor(Date.now() / 3600000) * 3600000;
  el.innerHTML = bars.map(b => {
    const h = Math.max(2, Math.round((b.n / max) * 100));
    const isNow = b.bucket === nowH;
    const dim = b.n === 0 ? '0.15' : (isNow ? '1' : '0.75');
    return `<div class="bar ${isNow ? 'now' : ''}" style="height:${h}%; opacity: ${dim};" title="${b.n} row(s)"></div>`;
  }).join('');
}

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

// ─────────── Today baseline (midnight rollover) ───────────
async function readTodayBaseline() {
  return new Promise(r => chrome.storage.local.get(['adbrainTodayBaseline'], d => r(d.adbrainTodayBaseline || null)));
}
async function writeTodayBaseline(bl) {
  return new Promise(r => chrome.storage.local.set({ adbrainTodayBaseline: bl }, r));
}
function todayKey() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─────────── Main refresh ───────────
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
  state.doneProductsList = Array.isArray(st.doneProductsList) ? st.doneProductsList : [];
  state.log          = Array.isArray(st.log) ? st.log : [];
  state.connectionHealth = st.connectionHealth || null;

  // Today baseline maintenance.
  const today = todayKey();
  if (!baseline || baseline.date !== today) {
    await writeTodayBaseline({ date: today, baselineDone: state.done });
    state.todayDone = 0;
  } else {
    state.todayDone = Math.max(0, state.done - baseline.baselineDone);
  }

  renderHero();
  renderErrBanner();
  renderConfig();
  renderControls();
  renderRecent();
  renderLog();
  renderToday();
  $('lastRefresh').textContent = `refreshed ${fmtTime(Date.now())}`;
}

// ─────────── Controls ───────────
$('pauseBtn').addEventListener('click', async () => {
  if (!confirm('Pause after the current SKU finishes?')) return;
  await rpc('stopDiscovery');
  await new Promise(r => chrome.storage.local.set({
    adbrainWorkerArmed: true, adbrainUserStoppedArm: false,
  }, r));
  refresh();
});
$('resumeBtn').addEventListener('click', async () => {
  await new Promise(r => chrome.storage.local.set({
    adbrainWorkerArmed: true, adbrainUserStoppedArm: false,
  }, r));
  nextPollAt = Date.now() + 3000;  // nudge — poll almost immediately
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
// Local state every 3s, today counters every 30s (HTTP to manager),
// countdown every 1s (visual only).
setInterval(refresh,        3000);
setInterval(refreshToday,   30000);
setInterval(renderCountdown, 1000);
renderCountdown();
