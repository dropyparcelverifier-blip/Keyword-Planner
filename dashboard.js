// dashboard.js — Operations Dashboard for AdBrain Discovery
//
// Full-page view that polls Supabase via the background service worker
// (which holds the service_role key) and renders:
//   - Top: batch selector + status appbar (last refresh, controls)
//   - Left: batch progress + 4-tile stat grid + worker fleet grid
//   - Right: failed jobs (top 50) + live activity log with level filters
//
// All data comes through the same chrome.runtime.sendMessage handlers the
// side-panel popup uses. The dashboard is a separate Chrome tab opened
// from the popup's "Open Dashboard" button. Polling cadence: 5s while the
// tab is visible, paused when hidden (visibilitychange).

const $ = (id) => document.getElementById(id);

const state = {
  batchId: '',            // empty = aggregate across all batches
  level: 'all',           // log level filter
  workerFilter: '',       // empty = all workers
  lastLogTs: null,        // ISO ts of newest log entry we've already shown
  logs: [],               // in-memory log buffer (capped at 500)
  knownWorkers: new Set(),// populated from worker stats + log entries
  refreshTimer: null,
  refreshIntervalMs: 5000,
  isVisible: true,
  managerId: '',          // set from chrome.storage adbrainWorkerId or a fallback
};

const LOG_CAP = 500;

// ───────────── Util ─────────────
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}
function fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
function workerDotClass(lastHb) {
  if (!lastHb) return 'stale';
  const ms = Date.now() - new Date(lastHb).getTime();
  if (ms < 90 * 1000) return 'fresh';
  if (ms < 5 * 60 * 1000) return 'amber';
  return 'stale';
}
function rpc(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (resp) => resolve(resp || { ok: false, error: 'no response' }));
  });
}

// ───────────── Render: batch overview ─────────────
function renderBatchOverview(summary) {
  const wrap = $('batchOverview');
  if (!summary || summary.length === 0) {
    wrap.innerHTML = `<div class="empty">No batches yet.</div>`;
    $('batchSubLabel').textContent = '—';
    return;
  }
  // Pick the focused batch (or aggregate across all).
  let focus;
  if (state.batchId) {
    focus = summary.find(b => String(b.batch_id) === String(state.batchId));
    if (!focus) {
      wrap.innerHTML = `<div class="empty">Batch ${esc(state.batchId)} not found.</div>`;
      return;
    }
  } else {
    // Aggregate across all visible batches.
    focus = summary.reduce((acc, b) => ({
      batch_id: 'ALL',
      total: acc.total + (b.total || 0),
      pending: acc.pending + (b.pending || 0),
      claimed: acc.claimed + (b.claimed || 0),
      done: acc.done + (b.done || 0),
      failed: acc.failed + (b.failed || 0),
    }), { total: 0, pending: 0, claimed: 0, done: 0, failed: 0 });
  }
  const pct = focus.total > 0 ? Math.round((focus.done / focus.total) * 100) : 0;
  $('batchSubLabel').textContent = state.batchId
    ? `batch ${state.batchId}`
    : `${summary.length} batch${summary.length === 1 ? '' : 'es'}`;
  wrap.innerHTML = `
    <div class="batch-row">
      <div>
        <span class="batch-pct">${pct}%</span>
        <span class="batch-pct-label">complete</span>
      </div>
      <div class="batch-frac"><strong>${focus.done}</strong> / ${focus.total}</div>
    </div>
    <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    <div class="stat-grid">
      <div class="stat-tile pending"><div class="stat-tile-value">${focus.pending}</div><div class="stat-tile-label">pending</div></div>
      <div class="stat-tile claimed"><div class="stat-tile-value">${focus.claimed}</div><div class="stat-tile-label">in flight</div></div>
      <div class="stat-tile done"   ><div class="stat-tile-value">${focus.done}</div>   <div class="stat-tile-label">done</div></div>
      <div class="stat-tile failed" ><div class="stat-tile-value">${focus.failed}</div> <div class="stat-tile-label">failed</div></div>
    </div>
  `;
}

// ───────────── Render: worker grid ─────────────
function renderWorkerGrid(workers, perProduct) {
  const wrap = $('workerGrid');
  if (!workers || workers.length === 0) {
    wrap.innerHTML = `<div class="empty" style="grid-column: 1/-1;">
      <div class="empty-icon">🤖</div>
      <strong>No workers active</strong>
      Workers will appear here once they claim jobs from the queue.
    </div>`;
    $('workerCountLabel').textContent = '0 workers';
    return;
  }
  // Index per-product by worker for "currently processing" labels.
  const currentByWorker = new Map();
  if (Array.isArray(perProduct)) {
    for (const p of perProduct) {
      if (p.status !== 'claimed' || !p.claimed_by) continue;
      const cur = currentByWorker.get(p.claimed_by) || [];
      cur.push(p);
      currentByWorker.set(p.claimed_by, cur);
    }
  }
  const cards = workers.map(w => {
    const dotCls = workerDotClass(w.last_heartbeat || w.lastHeartbeat);
    const inFlight = w.in_flight ?? w.inFlight ?? 0;
    const done = w.done_count ?? w.doneCount ?? 0;
    const failed = w.failed_count ?? w.failedCount ?? 0;
    const avgS = w.avg_secs_per_product;
    const avgLabel = avgS ? `${Math.round(avgS)}s avg per product` : 'no completion data yet';
    const currentList = currentByWorker.get(w.worker_id) || currentByWorker.get(w.worker) || [];
    let currentHtml;
    if (currentList.length === 0) {
      currentHtml = `<div class="worker-current idle">▸ Idle</div>`;
    } else {
      const top = currentList[0];
      const name = top.product_name || top.sku || top.product_url || '(unnamed)';
      const more = currentList.length > 1 ? `  <span style="color:var(--text-3)">+${currentList.length - 1} more</span>` : '';
      currentHtml = `<div class="worker-current" title="${esc(name)}">▸ ${esc(name.slice(0, 60))}${more}</div>`;
    }
    return `
      <div class="worker-card ${dotCls}" data-worker-id="${esc(w.worker_id || w.worker)}">
        <div class="worker-head">
          <span class="worker-dot ${dotCls}"></span>
          <span class="worker-name">${esc(w.worker_id || w.worker)}</span>
          <span class="worker-hb">${fmtAgo(w.last_heartbeat || w.lastHeartbeat)}</span>
        </div>
        <div class="worker-stats">
          <div class="worker-stat"><div class="worker-stat-v done">${done}</div><div class="worker-stat-l">done</div></div>
          <div class="worker-stat"><div class="worker-stat-v flight">${inFlight}</div><div class="worker-stat-l">in flight</div></div>
          <div class="worker-stat"><div class="worker-stat-v failed">${failed}</div><div class="worker-stat-l">failed</div></div>
        </div>
        ${currentHtml}
        <div class="worker-meta">${avgLabel}</div>
        <div class="worker-controls">
          <button data-action="stop-worker"    data-worker="${esc(w.worker_id || w.worker)}" title="Halt after current product">⏹ Stop</button>
          <button data-action="resume-worker"  data-worker="${esc(w.worker_id || w.worker)}" title="Resume auto-claim loop">▶ Resume</button>
          <button data-action="release-worker" data-worker="${esc(w.worker_id || w.worker)}" title="Release this worker's claims back to queue">⏏ Release</button>
        </div>
      </div>
    `;
  }).join('');
  wrap.innerHTML = cards;
  $('workerCountLabel').textContent = `${workers.length} worker${workers.length === 1 ? '' : 's'}`;

  // Wire per-worker remote-control buttons.
  wrap.querySelectorAll('button[data-action="stop-worker"]').forEach(btn => {
    btn.addEventListener('click', () => sendCommand(btn.dataset.worker, 'stop'));
  });
  wrap.querySelectorAll('button[data-action="resume-worker"]').forEach(btn => {
    btn.addEventListener('click', () => sendCommand(btn.dataset.worker, 'resume'));
  });
  wrap.querySelectorAll('button[data-action="release-worker"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm(`Release ${btn.dataset.worker}'s in-flight claims back to the pending pool?`)) {
        sendCommand(btn.dataset.worker, 'release_claims');
      }
    });
  });
}

// ───────────── Render: live "Output uploaded to Supabase" ─────────────
// Shows TOTAL keyword rows in adbrain_discovered_keywords for the
// focused batch, plus a per-SKU breakdown so the user can see which
// SKUs produced rows and which completed with zero (a bug signal).
function renderOutputStats(stats, errMsg) {
  const wrap = $('outputStatsPanel');
  const head = $('outputStatsHeader');
  if (!wrap || !head) return;

  if (errMsg) {
    head.textContent = '⚠ error';
    wrap.innerHTML = `<div class="empty" style="padding: 12px 8px;">
      <div class="empty-icon" style="font-size: 22px;">⚠</div>
      <strong>Could not fetch output stats</strong>
      ${esc(errMsg)}
    </div>`;
    return;
  }
  if (!stats) {
    head.textContent = '—';
    wrap.innerHTML = `<div class="empty" style="padding: 16px 8px;">
      <div class="empty-icon" style="font-size: 24px;">📊</div>
      <strong>Pick a batch above</strong>
      Selecting a batch shows per-SKU keyword counts as they land.
    </div>`;
    return;
  }

  const { totalKeywords, totalSkus, skusWithKeywords, avgKwPerSku, topSkus, skusWithZeroKw } = stats;
  head.textContent = `${totalKeywords.toLocaleString()} rows · ${skusWithKeywords}/${totalSkus} SKUs producing`;

  // Top-line counter row.
  const counters = `
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px;">
      <div style="background: var(--success-soft); border: 1px solid var(--success); border-radius: 8px; padding: 8px 10px;">
        <div style="font-size: 11px; color: var(--success); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Total rows</div>
        <div style="font-size: 20px; font-weight: 700; color: var(--success);">${totalKeywords.toLocaleString()}</div>
      </div>
      <div style="background: var(--info-soft, #eef2ff); border: 1px solid var(--info, #6366f1); border-radius: 8px; padding: 8px 10px;">
        <div style="font-size: 11px; color: var(--info, #4f46e5); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">SKUs total</div>
        <div style="font-size: 20px; font-weight: 700; color: var(--info, #4f46e5);">${totalSkus}</div>
      </div>
      <div style="background: var(--success-soft); border: 1px solid var(--success); border-radius: 8px; padding: 8px 10px;">
        <div style="font-size: 11px; color: var(--success); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Producing</div>
        <div style="font-size: 20px; font-weight: 700; color: var(--success);">${skusWithKeywords}</div>
      </div>
      <div style="background: var(--bg-elev, #fafafa); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
        <div style="font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Avg / SKU</div>
        <div style="font-size: 20px; font-weight: 700;">${avgKwPerSku}</div>
      </div>
    </div>
  `;

  // Per-SKU table. Sorted desc by kw count so productive SKUs surface
  // first. Status badge shows lifecycle. Zero-kw + done = bug signal.
  const rows = (topSkus || []).map(s => {
    const statusClr = s.status === 'done'
      ? 'var(--success)'
      : s.status === 'failed'
      ? 'var(--danger)'
      : s.status === 'claimed'
      ? 'var(--warn)'
      : 'var(--muted)';
    const kwBadge = s.kwCount > 0
      ? `<span style="background: var(--success-soft); color: var(--success); padding: 2px 6px; border-radius: 4px; font-weight: 700;">${s.kwCount}</span>`
      : `<span style="background: var(--danger-soft); color: var(--danger); padding: 2px 6px; border-radius: 4px; font-weight: 700;">0</span>`;
    const doneAt = s.doneAt ? fmtTime(s.doneAt) : '—';
    const worker = s.claimedBy ? esc(s.claimedBy) : '—';
    const name = esc(s.productName || s.sku || '—');
    return `
      <tr>
        <td style="padding: 4px 6px; font-family: var(--mono); font-size: 11px;">${esc(s.sku)}</td>
        <td style="padding: 4px 6px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${name}">${name}</td>
        <td style="padding: 4px 6px;"><span style="color: ${statusClr}; font-weight: 600; font-size: 11px; text-transform: uppercase;">${esc(s.status)}</span></td>
        <td style="padding: 4px 6px; font-family: var(--mono); font-size: 11px;">${worker}</td>
        <td style="padding: 4px 6px; text-align: right;">${kwBadge}</td>
        <td style="padding: 4px 6px; font-size: 11px; color: var(--muted);">${doneAt}</td>
      </tr>
    `;
  }).join('');

  const zeroBanner = (skusWithZeroKw && skusWithZeroKw.length > 0) ? `
    <div style="margin: 8px 0; padding: 8px 10px; background: var(--danger-soft); border: 1px solid var(--danger); border-radius: 6px; font-size: 12px;">
      <strong style="color: var(--danger);">⚠ ${skusWithZeroKw.length} SKU(s) finished with zero keyword rows</strong> —
      likely KP failed silently or engine returned empty. Check the activity log for "KP FAILED" or "LOW YIELD" warnings.
    </div>
  ` : '';

  wrap.innerHTML = `
    ${counters}
    ${zeroBanner}
    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
      <thead style="background: var(--bg-elev, #fafafa); border-bottom: 1px solid var(--border);">
        <tr>
          <th style="text-align: left; padding: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--muted);">SKU</th>
          <th style="text-align: left; padding: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--muted);">Product</th>
          <th style="text-align: left; padding: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--muted);">Status</th>
          <th style="text-align: left; padding: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--muted);">Worker</th>
          <th style="text-align: right; padding: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--muted);">Rows</th>
          <th style="text-align: left; padding: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--muted);">Done</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="6" style="padding: 12px; text-align: center; color: var(--muted);">No SKUs in this batch yet</td></tr>'}</tbody>
    </table>
  `;
}

// ───────────── Render: failed jobs ─────────────
function renderFailed(failed) {
  const wrap = $('failedList');
  if (!failed || failed.length === 0) {
    wrap.innerHTML = `<div class="empty">
      <div class="empty-icon">✓</div>
      <strong>All clear</strong>
      No failed jobs to triage.
    </div>`;
    $('failedCountLabel').textContent = '0';
    return;
  }
  $('failedCountLabel').textContent = String(failed.length);
  wrap.innerHTML = failed.map(f => {
    const name = f.product_name || f.sku || f.product_url || '(unnamed)';
    const reason = f.failed_reason || 'no reason recorded';
    const worker = f.claimed_by || '(unknown)';
    return `
      <div class="failed-row">
        <div class="name">${esc(name)}</div>
        <div class="meta">
          worker: <strong>${esc(worker)}</strong>
          · attempts: <strong>${f.attempts || 0}</strong>
          · reason: <strong>${esc(reason)}</strong>
        </div>
        <div class="actions">
          <button data-action="requeue" data-job-id="${f.id}">↻ Re-queue</button>
        </div>
      </div>
    `;
  }).join('');
  wrap.querySelectorAll('button[data-action="requeue"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      const resp = await rpc('jobs:requeue', { jobId: btn.dataset.jobId });
      btn.textContent = resp?.ok ? '✓ Queued' : '× Failed';
      setTimeout(refreshAll, 600);
    });
  });
}

// ───────────── Render: activity log ─────────────
function renderLog() {
  const wrap = $('logList');
  let entries = state.logs;
  if (state.level !== 'all') {
    entries = entries.filter(e => e.level === state.level);
  }
  if (state.workerFilter) {
    entries = entries.filter(e => e.worker_id === state.workerFilter);
  }
  if (entries.length === 0) {
    wrap.innerHTML = `<div class="empty">
      <div class="empty-icon">📭</div>
      <strong>No activity</strong>
      Try a different filter or wait for workers to emit events.
    </div>`;
    $('logCountLabel').textContent = '0';
    return;
  }
  // Newest first; cap at 200 visible lines for perf.
  const slice = entries.slice(0, 200);
  $('logCountLabel').textContent = `${entries.length} line(s)`;
  wrap.innerHTML = slice.map(e => {
    const levelClass = `level-${e.level || 'info'}`;
    return `
      <div class="log-line ${levelClass}">
        <span class="ts">${fmtTime(e.ts)}</span>
        <span class="worker">${esc(e.worker_id || '—')}</span>
        <span class="src">${esc((e.source || 'engine').slice(0, 8))}</span>
        <span class="msg">${esc(e.message || '')}</span>
      </div>
    `;
  }).join('');
}

function mergeLogs(newEntries) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) return;
  // Newest first in the array as returned by PostgREST (order=ts.desc).
  // Prepend to in-memory buffer and dedupe by id.
  const seenIds = new Set(state.logs.map(e => e.id));
  for (const e of newEntries) {
    if (seenIds.has(e.id)) continue;
    state.logs.unshift(e);
    seenIds.add(e.id);
    // Track worker names for the filter dropdown.
    if (e.worker_id) state.knownWorkers.add(e.worker_id);
  }
  // Track newest ts so incremental polling fetches only new.
  if (newEntries.length > 0) {
    const newest = newEntries.reduce((a, b) => (a.ts > b.ts ? a : b));
    if (!state.lastLogTs || newest.ts > state.lastLogTs) {
      state.lastLogTs = newest.ts;
    }
  }
  // Cap.
  if (state.logs.length > LOG_CAP) state.logs.length = LOG_CAP;
}

// Refresh the worker filter dropdown (used by both the activity log
// filter and the per-batch summary's worker section). Keeps the
// currently-selected worker if it still exists in the set.
function refreshWorkerFilter() {
  const sel = $('logWorkerFilter');
  if (!sel) return;
  const cur = state.workerFilter;
  const sorted = Array.from(state.knownWorkers).sort();
  sel.innerHTML = `<option value="">all workers</option>`
    + sorted.map(w => `<option value="${esc(w)}" ${w === cur ? 'selected' : ''}>${esc(w)}</option>`).join('');
}

// ───────────── Batch select ─────────────
function renderBatchSelect(summary) {
  const sel = $('batchSelect');
  const cur = state.batchId;
  // Build option list. Keep the currently-selected even if it's not in
  // summary (just-uploaded etc.) so the user doesn't lose focus.
  const ids = new Set();
  summary?.forEach(b => ids.add(String(b.batch_id)));
  if (cur) ids.add(String(cur));
  const opts = [`<option value="">All batches</option>`]
    .concat(Array.from(ids).sort().reverse().map(id =>
      `<option value="${esc(id)}" ${String(id) === String(cur) ? 'selected' : ''}>${esc(id)}</option>`));
  sel.innerHTML = opts.join('');
}

// ───────────── Manager config panel ─────────────
// Show what's in adbrain_worker_config so the manager can see what
// settings every worker will pick up on its next claim. Pulls from
// the same fetchWorkerConfig endpoint workers use.
function renderConfigPanel(cfg) {
  const wrap = $('configPanel');
  const status = $('configStatus');
  if (!cfg || !cfg.updated_at) {
    if (status) status.textContent = '—';
    wrap.innerHTML = `<div class="empty" style="padding: 16px 8px;">
      <div class="empty-icon" style="font-size: 24px;">📦</div>
      <strong>No config pushed yet</strong>
      Workers will use their local Settings defaults until a manager pushes from the Settings tab.
    </div>`;
    return;
  }
  const ago = fmtAgo(cfg.updated_at);
  if (status) status.textContent = `last push ${ago}`;
  const pills = [];
  const addPill = (key, val) => {
    if (val === null || val === undefined || val === '') return;
    pills.push(`
      <div class="config-pill">
        <div class="config-pill-key">${esc(key)}</div>
        <div class="config-pill-val" title="${esc(String(val))}">${esc(String(val).slice(0, 40))}</div>
      </div>
    `);
  };
  addPill('KP URL',          cfg.kp_url ? cfg.kp_url.slice(0, 40) + '…' : null);
  addPill('Max KP/product',  cfg.kp_max_per_product);
  addPill('Match profile',   cfg.match_profile);
  addPill('CLIP override',   cfg.clip_threshold_override != null ? Number(cfg.clip_threshold_override).toFixed(2) : null);
  addPill('Max img-match rows', cfg.max_image_match_rows);
  addPill('Search delay',    (cfg.search_delay_min_ms != null && cfg.search_delay_max_ms != null) ? `${Math.round(cfg.search_delay_min_ms/1000)}–${Math.round(cfg.search_delay_max_ms/1000)}s` : null);
  addPill('Product delay',   (cfg.product_delay_min_ms != null && cfg.product_delay_max_ms != null) ? `${Math.round(cfg.product_delay_min_ms/1000)}–${Math.round(cfg.product_delay_max_ms/1000)}s` : null);
  addPill('Chunk size',      cfg.chunk_size);
  addPill('Chunk rest',      (cfg.chunk_rest_min_ms != null && cfg.chunk_rest_max_ms != null) ? `${Math.round(cfg.chunk_rest_min_ms/60000)}–${Math.round(cfg.chunk_rest_max_ms/60000)}min` : null);
  addPill('Keyword cap',     cfg.cap);
  addPill('Auto-export',     cfg.auto_export != null ? (cfg.auto_export ? 'on' : 'off') : null);
  if (pills.length === 0) {
    wrap.innerHTML = `<div class="empty" style="padding: 12px 8px;">
      Config row exists but all fields are empty. Push from Settings tab.
    </div>`;
    return;
  }
  // Show the pinned batch state + a button to change it. This is the
  // primary way to redirect workers from one batch to another mid-run.
  const pinnedBatch = (cfg.active_batch_id || '').trim();
  const allBatches = Array.from(new Set((state._summaryCache || []).map(b => b.batch_id))).filter(Boolean);
  let pinControlsHtml = '';
  if (pinnedBatch) {
    pinControlsHtml = `
      <div class="config-pill" style="grid-column: 1 / -1; border-color: var(--accent);">
        <div class="config-pill-key" style="color: var(--accent);">📌 PINNED BATCH (workers focus only on this)</div>
        <div class="config-pill-val" style="display:flex; align-items:center; gap:8px; justify-content:space-between;">
          <code>${esc(pinnedBatch)}</code>
          <button style="padding: 4px 10px; font-size: 10px;" id="unpinBatchBtn">Unpin (back to auto)</button>
        </div>
      </div>
    `;
  } else {
    pinControlsHtml = `
      <div class="config-pill" style="grid-column: 1 / -1;">
        <div class="config-pill-key">📌 ACTIVE BATCH</div>
        <div class="config-pill-val" style="display:flex; align-items:center; gap:8px; justify-content:space-between;">
          <span>Auto-pick newest pending</span>
          <select id="pinBatchSelect" style="min-width: 200px; padding: 4px 22px 4px 10px; font-size: 10px;">
            <option value="">Pin a batch…</option>
            ${allBatches.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
  }

  pills.push(pinControlsHtml);
  pills.push(`<div class="config-meta">Pushed ${ago} by <strong style="color:var(--text-1);">${esc(cfg.updated_by || 'unknown')}</strong></div>`);
  wrap.innerHTML = pills.join('');

  // Wire the pin/unpin controls.
  $('unpinBatchBtn')?.addEventListener('click', async () => {
    if (!confirm('Unpin this batch? Workers will revert to auto-picking the newest batch with pending work.')) return;
    const r = await rpc('jobs:setActiveBatch', { batchId: null });
    if (r?.ok) { alert('✓ Unpinned. Workers will switch within 30s.'); refreshAll(); }
    else alert(`Unpin failed: ${r?.error || 'unknown'}`);
  });
  $('pinBatchSelect')?.addEventListener('change', async (ev) => {
    const v = ev.target.value;
    if (!v) return;
    if (!confirm(`Pin all workers to batch "${v}"? Every armed worker will switch to this batch within 30s, regardless of which batch they're currently on.`)) {
      ev.target.value = '';
      return;
    }
    const r = await rpc('jobs:setActiveBatch', { batchId: v });
    if (r?.ok) { alert(`✓ Workers will switch to batch "${v}" within 30s.`); refreshAll(); }
    else alert(`Pin failed: ${r?.error || 'unknown'}`);
  });
}

// ───────────── Commands ─────────────
async function sendCommand(workerId, command, payload) {
  // workerId === null/undefined = broadcast.
  const resp = await rpc('dashboard:sendCommand', { workerId, command, payload });
  if (!resp?.ok) {
    const err = resp?.error || 'unknown';
    // Detect the most common cause: schema missing / PostgREST cache stale.
    if (/PGRST205|adbrain_worker_commands|adbrain_activity_log|adbrain_worker_config|not.*found.*schema cache/i.test(err)) {
      alert(
        `❌ Database schema not migrated.\n\n` +
        `The dashboard tables don't exist in your Supabase project yet (or PostgREST hasn't refreshed its cache).\n\n` +
        `FIX:\n` +
        `1. Open your Supabase project → SQL Editor\n` +
        `2. Open supabase_schema.sql from the extension's source folder\n` +
        `3. Copy + paste the WHOLE file → Run\n` +
        `4. Run: NOTIFY pgrst, 'reload schema';\n` +
        `5. Reload the dashboard.\n\n` +
        `Raw error: ${err.slice(0, 200)}`
      );
    } else {
      alert(`Command failed: ${err}`);
    }
    return;
  }
  refreshAll();
}

// ───────────── Refresh pipeline ─────────────
async function refreshAll() {
  $('lastRefresh').textContent = `refreshing…`;
  const summaryResp = await rpc('jobs:summary', { batchId: state.batchId });
  if (!summaryResp?.ok) {
    $('lastRefresh').textContent = '⚠ error';
    // Replace any existing error banner so they don't pile up.
    document.querySelectorAll('.err-banner').forEach(el => el.remove());
    document.body.insertAdjacentHTML('afterbegin', `
      <div class="err-banner">
        <span class="err-banner-icon">⚠</span>
        <div>
          <strong>Dashboard refresh failed:</strong> ${esc(summaryResp?.error || 'unknown')}<br>
          Check that the extension's Connection card (Queue tab → 🔌) has a valid Supabase URL + service_role key, and that <code>NOTIFY pgrst, 'reload schema';</code> has been run.
        </div>
      </div>
    `);
    return;
  }
  // Clear any previous error banner on a successful refresh.
  document.querySelectorAll('.err-banner').forEach(el => el.remove());
  // Cache the summary so render functions (e.g. config-panel pin
  // dropdown) can list all batches without a second round-trip.
  state._summaryCache = summaryResp.summary || [];
  renderBatchSelect(summaryResp.summary);
  renderBatchOverview(summaryResp.summary);

  // Worker stats: prefer the per-batch view if a batch is focused; else
  // fall back to the legacy workers list which includes done counts.
  let workers = [];
  if (state.batchId) {
    const ws = await rpc('dashboard:workerStats', { batchId: state.batchId });
    workers = (ws?.ok ? ws.stats : null) || summaryResp.workers || [];
  } else {
    workers = summaryResp.workers || [];
  }

  // Per-product status for the "current" indicator.
  let perProduct = [];
  if (state.batchId) {
    const pp = await rpc('dashboard:perProduct', { batchId: state.batchId });
    perProduct = pp?.ok ? pp.rows : [];
  }
  renderWorkerGrid(workers, perProduct);
  renderFailed(summaryResp.failed);

  // Live "Output uploaded to Supabase" card. Only runs when a batch is
  // focused — otherwise the panel shows a placeholder. Counts every row
  // in adbrain_discovered_keywords for the batch and groups by SKU so
  // we can see who produced what (and which SKUs ended with zero).
  if (state.batchId) {
    const ks = await rpc('dashboard:batchKeywordStats', { batchId: state.batchId, limit: 100 });
    renderOutputStats(ks?.ok ? ks.stats : null, ks?.error);
  } else {
    renderOutputStats(null, null);
  }
  // Activity log: incremental fetch since lastLogTs (or full if first load).
  const logResp = await rpc('dashboard:fetchLog', {
    batchId: state.batchId,
    sinceTs: state.lastLogTs,
    limit: 200,
  });
  if (logResp?.ok && Array.isArray(logResp.entries)) {
    mergeLogs(logResp.entries);
  }
  // Manager config panel — what's pushed to workers.
  const cfgResp = await rpc('jobs:fetchWorkerConfig');
  if (cfgResp?.ok) renderConfigPanel(cfgResp.config);
  // Add worker IDs from the stats so the filter dropdown has them
  // before activity logs arrive.
  for (const w of workers) {
    const name = w.worker_id || w.worker;
    if (name) state.knownWorkers.add(name);
  }
  refreshWorkerFilter();
  renderLog();
  $('lastRefresh').textContent = `refreshed ${fmtTime(new Date().toISOString())}`;
  // Connection-health pill — green if Supabase reachable, amber for
  // pending push backlog, red on auth/network failure. Click to recheck.
  rpc('jobs:checkConnection').then(hr => {
    const el = $('connHealth');
    if (!el) return;
    if (hr?.ok && hr.health?.ok) {
      const lat = hr.health.latencyMs ? `${hr.health.latencyMs}ms` : 'ok';
      const pending = hr.pendingPushCount > 0 ? ` · ${hr.pendingPushCount} queued` : '';
      el.textContent = `● ${lat}${pending}`;
      el.style.background = pending ? 'var(--warn-soft)' : 'var(--success-soft)';
      el.style.color = pending ? 'var(--warn)' : 'var(--success)';
      el.style.borderColor = pending ? 'var(--warn)' : 'var(--success)';
      el.title = pending ? `${hr.pendingPushCount} push(es) queued for retry — click to recheck` : `Supabase reachable in ${hr.health.latencyMs}ms — click to recheck`;
    } else {
      el.textContent = `⚠ ${hr?.health?.error || 'offline'}`;
      el.style.background = 'var(--danger-soft)';
      el.style.color = 'var(--danger)';
      el.style.borderColor = 'var(--danger)';
      el.title = `Connection problem: ${hr?.health?.error || 'unknown'} — click to recheck`;
    }
  });
}

// ───────────── Wire up controls ─────────────
$('batchSelect').addEventListener('change', () => {
  state.batchId = $('batchSelect').value;
  state.logs = [];           // reset log on batch change
  state.lastLogTs = null;
  refreshAll();
});
$('refreshBtn').addEventListener('click', refreshAll);
$('releaseStaleBtn').addEventListener('click', async () => {
  const resp = await rpc('jobs:releaseStale', { staleMinutes: 10 });
  if (resp?.ok) refreshAll();
  else alert(`Release failed: ${resp?.error || 'unknown'}`);
});
$('stopAllBtn').addEventListener('click', async () => {
  if (!confirm('Stop all worker PCs? Each worker will finish its current product, then halt.')) return;
  await sendCommand(null, 'stop');  // broadcast
});
// Cleanup — delete old activity log + acked worker commands. Manager
// data (jobs + keyword rows) is NEVER auto-deleted.
$('cleanupBtn').addEventListener('click', async () => {
  if (!confirm(
    'Delete:\n\n' +
    '• Activity log entries older than 7 days\n' +
    '• Worker commands acked more than 1 day ago\n\n' +
    'Keyword data + job rows are NEVER deleted.\n\n' +
    'Continue?'
  )) return;
  $('cleanupBtn').disabled = true;
  $('cleanupBtn').textContent = '🧹 Cleaning…';
  const r = await rpc('jobs:cleanup', { logDays: 7, commandsDays: 1 });
  $('cleanupBtn').disabled = false;
  $('cleanupBtn').textContent = '🧹 Cleanup';
  if (!r?.ok) {
    alert(`Cleanup failed: ${r?.error || 'unknown'}`);
    return;
  }
  const errs = (r.errors && r.errors.length > 0) ? `\n\nWith errors:\n${r.errors.join('\n')}` : '';
  alert(
    `✓ Cleaned up:\n\n` +
    `• ${r.activityLog} old activity log entries\n` +
    `• ${r.ackedCommands} acked commands` + errs
  );
  refreshAll();
});

// Wake all — broadcast an instant "check for work" command to every
// worker. Workers that are armed but idle (waiting for the next
// auto-poll tick) immediately claim and start. Useful right after the
// manager uploads a new batch — no need to wait 30s for the poll.
$('wakeAllBtn').addEventListener('click', async () => {
  const result = await rpc('dashboard:sendCommand', { workerId: null, command: 'wake' });
  if (!result?.ok) {
    // Use the same schema-detection logic as sendCommand. Don't call
    // sendCommand directly here because it already shows an alert; we
    // want to consolidate the success path too.
    const err = result?.error || 'unknown';
    if (/PGRST205|adbrain_worker_commands|not.*found.*schema cache/i.test(err)) {
      alert(
        `❌ Database schema not migrated.\n\n` +
        `The "adbrain_worker_commands" table doesn't exist in your Supabase project yet — that's why Wake all can't reach workers.\n\n` +
        `FIX:\n` +
        `1. Open Supabase → SQL Editor\n` +
        `2. Open supabase_schema.sql from the extension folder\n` +
        `3. Copy + paste the WHOLE file → Run\n` +
        `4. Then run: NOTIFY pgrst, 'reload schema';\n` +
        `5. Click Wake all workers again.`
      );
    } else {
      alert(`Wake failed: ${err}`);
    }
    return;
  }
  alert('✓ Wake signal sent. Armed workers will claim within ~30s.');
  refreshAll();
});

// Resume all — broadcast a resume command. Workers that received an
// earlier Stop / Pause will re-claim and continue. Workers that are
// already running ignore the command. Useful for "okay everybody go
// again now" after a coordinated pause.
$('resumeAllBtn').addEventListener('click', async () => {
  if (!confirm('Resume all worker PCs? Each idle worker will re-claim from the queue and start processing.')) return;
  await sendCommand(null, 'resume');
});

// Bulk re-queue every failed job in the current batch back to pending.
// Useful when a manager wants to retry all failures at once (e.g.,
// after fixing a network problem or sleeping through a CAPTCHA storm).
$('requeueAllBtn').addEventListener('click', async () => {
  // Pull the failed list from the most recent refresh's render. The
  // failed-rows DOM has the job IDs in data-job-id attributes.
  const btns = document.querySelectorAll('#failedList button[data-action="requeue"]');
  if (btns.length === 0) { alert('No failed jobs to re-queue.'); return; }
  if (!confirm(`Re-queue all ${btns.length} failed job(s) back to pending?`)) return;
  $('requeueAllBtn').disabled = true;
  $('requeueAllBtn').textContent = `↻ Re-queuing 0/${btns.length}…`;
  let done = 0;
  for (const btn of btns) {
    const resp = await rpc('jobs:requeue', { jobId: btn.dataset.jobId });
    done++;
    $('requeueAllBtn').textContent = `↻ Re-queuing ${done}/${btns.length}…`;
    if (!resp?.ok) console.warn('requeue failed:', btn.dataset.jobId, resp);
  }
  $('requeueAllBtn').disabled = false;
  $('requeueAllBtn').textContent = '↻ Re-queue all failed';
  refreshAll();
});

// Auto-refresh interval selector.
$('refreshIntervalSelect').addEventListener('change', () => {
  const ms = parseInt($('refreshIntervalSelect').value, 10) || 0;
  state.refreshIntervalMs = ms;
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
  if (ms > 0) {
    state.refreshTimer = setInterval(() => {
      if (state.isVisible) refreshAll();
    }, ms);
  }
  // Persist user preference.
  try { localStorage.setItem('adbrainDashRefreshMs', String(ms)); } catch {}
});

// Activity log: filter by worker.
$('logWorkerFilter').addEventListener('change', () => {
  state.workerFilter = $('logWorkerFilter').value;
  renderLog();
});

// Click the connection-health pill to force an immediate recheck.
$('connHealth').addEventListener('click', () => {
  $('connHealth').textContent = '⋯ checking';
  $('connHealth').style.background = '';
  $('connHealth').style.color = '';
  $('connHealth').style.borderColor = '';
  refreshAll();
});
document.querySelectorAll('.log-filter').forEach(f => {
  f.addEventListener('click', () => {
    document.querySelectorAll('.log-filter').forEach(x => x.classList.remove('active'));
    f.classList.add('active');
    state.level = f.dataset.level;
    renderLog();
  });
});

// Visibility-based polling: pause polling when the tab is hidden so we
// don't waste Supabase quota on backgrounded dashboards.
document.addEventListener('visibilitychange', () => {
  state.isVisible = !document.hidden;
  if (state.isVisible) refreshAll();
});

// Kick off.
function start() {
  // Restore user's saved refresh interval preference.
  try {
    const saved = parseInt(localStorage.getItem('adbrainDashRefreshMs'), 10);
    if (saved >= 0 && [0, 5000, 10000, 30000, 60000].includes(saved)) {
      state.refreshIntervalMs = saved;
      $('refreshIntervalSelect').value = String(saved);
    }
  } catch {}
  refreshAll();
  if (state.refreshIntervalMs > 0) {
    state.refreshTimer = setInterval(() => {
      if (state.isVisible) refreshAll();
    }, state.refreshIntervalMs);
  }
}
start();
