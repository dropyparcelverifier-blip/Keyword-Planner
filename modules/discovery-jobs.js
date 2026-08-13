// modules/discovery-jobs.js
// Distributed work queue — HTTP client for the self-hosted SQLite manager
// (manager/server.js) served over Tailscale. Manager URL + optional token
// come from chrome.storage ('adbrainManagerUrl', 'adbrainManagerToken').

// Storage keys for the manager connection.
export const STORAGE_KEY_MANAGER_URL   = 'adbrainManagerUrl';
export const STORAGE_KEY_MANAGER_TOKEN = 'adbrainManagerToken';

// Kept for back-compat with any imports elsewhere.
export const JOBS_TABLE = 'jobs';

async function _manager() {
  const d = await chrome.storage.local.get([STORAGE_KEY_MANAGER_URL, STORAGE_KEY_MANAGER_TOKEN]);
  const base = String(d[STORAGE_KEY_MANAGER_URL] || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Manager URL not set (Settings → Manager). e.g. http://manager-pc.tailnet.ts.net:8787');
  const token = String(d[STORAGE_KEY_MANAGER_TOKEN] || '').trim();
  return { base, token };
}
async function _mfetch(pathname, { method = 'GET', body } = {}) {
  const { base, token } = await _manager();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Manager-Token'] = token;
  const resp = await fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Manager ${method} ${pathname} failed (HTTP ${resp.status}): ${t.slice(0, 200)}`);
  }
  return resp.json();
}
const _get  = (p) => _mfetch(p);
const _post = (p, body) => _mfetch(p, { method: 'POST', body });

// MANAGER: upload products to the queue (manager dedups within-batch + skips
// URLs already active in another batch). Idempotent per (batch, url).
export async function uploadJobsToManager(products, batchId) {
  if (!Array.isArray(products) || products.length === 0) throw new Error('No products to upload.');
  if (!batchId) batchId = String(Date.now());
  const payload = products.map(p => ({
    url: String(p.url || '').trim(),
    sku: p.sku || null,
    product_name: p.productName || p.name || null,
    priority: typeof p.priority === 'number' ? p.priority : 100,
    handles: Array.isArray(p.handles) ? p.handles.join('|') : (p.handles || null),
    brands:  Array.isArray(p.brands)  ? p.brands.join('|')  : (p.brands  || null),
  })).filter(r => r.url);
  if (payload.length === 0) throw new Error('No valid product URLs in upload.');
  const r = await _post('/api/jobs/upload', { batchId, products: payload });
  return {
    uploaded: r.uploaded || 0,
    total: r.total || payload.length,
    batchId,
    errors: [],
    duplicatesDropped: r.duplicatesDropped || 0,
    skippedActive: r.skippedActive || 0,
    skippedSkus: r.skippedSkus || [],
  };
}

// WORKER: atomically claim up to `limit` pending jobs. Returns array of job rows.
export async function claimJobs({ workerId, batchId, limit = 5 }) {
  if (!workerId) throw new Error('Worker ID required.');
  if (!batchId)  throw new Error('Batch ID required (pick one in the Manager tab).');
  const r = await _post('/api/jobs/claim', { workerId, batchId, limit });
  return Array.isArray(r.jobs) ? r.jobs : [];
}

// WORKER: heartbeat in-flight claims (by job id).
// Manager response now also echoes `active_batch_id` — the caller can compare
// it against its cached queueBatchId to detect drift (e.g. after a manager
// Reset re-pinned a new batch). Prevents orphan-batch keyword writes.
export async function heartbeatClaims(workerId, jobIds) {
  if (!workerId || !Array.isArray(jobIds) || jobIds.length === 0) return { updated: 0, activeBatchId: null };
  try {
    const r = await _post('/api/jobs/heartbeat', { workerId, jobIds: jobIds.map(Number).filter(Number.isFinite) });
    return { updated: r.updated || 0, activeBatchId: r.active_batch_id || null };
  } catch (e) { return { updated: 0, activeBatchId: null, error: e.message }; }
}

export async function markJobDone({ workerId, batchId, productUrl }) {
  if (!workerId || !batchId || !productUrl) return { updated: 0 };
  try { const r = await _post('/api/jobs/done', { workerId, batchId, productUrl }); return { updated: r.ok ? 1 : 0 }; }
  catch (e) { return { updated: 0, error: e.message }; }
}

export async function markJobFailed({ workerId, batchId, productUrl, reason }) {
  if (!workerId || !batchId || !productUrl) return { updated: 0 };
  try { const r = await _post('/api/jobs/failed', { workerId, batchId, productUrl, reason }); return { updated: r.ok ? 1 : 0 }; }
  catch (e) { return { updated: 0, error: e.message }; }
}

export async function releaseStaleJobs(staleMinutes = 10) {
  try { const r = await _post('/api/jobs/release-stale', { staleMinutes }); return { released: r.released || 0 }; }
  catch (e) { return { released: 0, error: e.message }; }
}

// Release ALL claims held by a specific worker id — no staleness check.
// Called on cold-start / fresh-connect so a SW-reloaded worker doesn't leave
// ghost claims in the DB (they'd show as in-flight forever because there's
// no live process heartbeating them and no heartbeat-timeout would trigger
// release-stale on the next cycle since fresh heartbeats keep coming from
// the NEW claims). Fixes the "10 in-flight for one worker" reconciliation
// gap where /api/jobs/worker-stats showed old + new claims summed.
export async function releaseByWorker(workerId) {
  if (!workerId) return { released: 0, error: 'workerId required' };
  try {
    const r = await _post('/api/jobs/release-by-worker', { workerId });
    return { released: r.released || 0, workerId };
  } catch (e) { return { released: 0, error: e.message }; }
}

// MANAGER UI: per-batch summary (counts by status). SQLite returns integers.
export async function getJobSummary() {
  const r = await _get('/api/jobs/summary');
  return (r.batches || []).map(b => ({
    batch_id: b.batch_id, total: b.total || 0, pending: b.pending || 0,
    claimed: b.claimed || 0, done: b.done || 0, failed: b.failed || 0,
    active_workers: b.active_workers || 0, last_done_at: b.last_done_at || null,
  }));
}

// MANAGER UI: pull every discovered-keyword row for a batch back from the
// manager, converting snake_case export columns to the camelCase shape the
// export layer expects (inverse of pushToAdBrain's mapping).
// Manager row (snake_case, as stored) -> engine/report row (camelCase).
//
// The two shapes are NOT interchangeable and the boundary is easy to miss:
// the manager stores batch_id / product_url, while the engine and the export
// layer read batchId / productUrl. Feeding a stored row straight into the
// report gives it neither, and the next push is rejected with `no_batch_id`
// for product "(unknown)" -- 13,003 rows thrown away in three hours, all of
// them work that had already been done.
// Helper: convert a "url [conf]" joined string back into `{ url, conf }`
// objects. pushToAdBrain stores matched thumbnails as "url [conf] | url
// [conf]" (see discovery-export.js pairMatched), so the reverse needs to
// split BOTH the pipe-joined entries AND the "[conf]" suffix.
function _splitMatchedThumbs(v) {
  const out = [];
  if (typeof v === 'string') {
    for (const part of v.split(' | ')) {
      if (!part) continue;
      const m = part.match(/^(.*?)\s*\[(\d+)\]$/);
      if (m) out.push({ url: m[1], conf: Number(m[2]) || 0 });
      else out.push({ url: part, conf: 0 });
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string') out.push({ url: item, conf: 0 });
      else if (item && typeof item.url === 'string') out.push({ url: item.url, conf: Number(item.conf) || 0 });
    }
  }
  return out;
}
// Helper to convert a pipe-joined string into an array of plain strings.
function _splitList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(' | ').filter(Boolean);
  return [];
}

export function managerRowToReportRow(x) {
  if (!x || typeof x !== 'object') return {};
  // matched_thumbnails is stored as "url [conf] | url [conf]" — split into
  // {url, conf} pairs so the export layer's pairMatched() can rebuild the
  // matchedThumbnails / matchedConfidences / matchedSellers / matchedPrices
  // arrays from them. WITHOUT this, rows restored from the manager lose all
  // image-match data on the next export (matchedThumbnails ends up empty).
  const paired = _splitMatchedThumbs(x.matched_thumbnails);
  const matchedThumbnails = paired.map(p => p.url);
  const matchedConfidences = paired.map(p => p.conf);
  // matched_sellers / matched_prices align 1:1 with matched_thumbnails.
  const matchedSellers = _splitList(x.matched_sellers);
  const matchedPrices  = _splitList(x.matched_prices);
  const matchedQualities = _splitList(x.matched_qualities);
  return ({
    batchId: x.batch_id, sku: x.sku, keyword: x.keyword, source: x.source,
    parentKeyword: x.parent_keyword, productName: x.product_name, productUrl: x.product_url,
    productImage: x.product_image, priority: x.priority, adRating: x.ad_rating, frequency: x.frequency,
    intent: x.intent, topic: x.topic, funnel: x.funnel,
    keywordRelevance: x.keyword_relevance, buyingIntent: x.buying_intent, isFaq: x.faq, kpCompetition: x.competition || x.kp_competition,
    imageCount: x.image_count, imageCountUnverified: x.image_count_unverified, totalThumbs: x.total_thumbs,
    visibilityPct: x.visibility_pct, foundZoneCounts: x.serp_zone_counts, matchSources: x.match_sources, thumbsCaptured: x.thumbs_captured,
    linkCheckedCount: x.link_checked_count, linkVerifiedCount: x.link_verified_count,
    match_confidence_avg: x.match_confidence_avg, match_confidence_max: x.match_confidence_max, match_confidence_min: x.match_confidence_min,
    totalSellers: x.total_sellers, seller_type: x.seller_type, dropyIsSeller: x.dropy_is_seller, dropyOnSerp: x.dropy_on_serp,
    adsOnSerp: x.ads_on_serp, sellers_on_serp: x.sellers_on_serp, seller_titles: x.seller_titles, serp_url: x.serp_url,
    kpMonthlySearches: x.kp_monthly_searches, kpBidLow: x.kp_bid_low, kpBidHigh: x.kp_bid_high,
    autosuggestCount: x.autosuggest_count,
    // Split back into an array, the way matchedLinks/verifiedLinks below do.
    // pushToAdBrain stores this as `(r.autosuggestions || []).join(' | ')`,
    // so it comes back as TEXT. Handing that straight to a restored row made
    // the NEXT incremental push call .join on a string -- "(r.autosuggestions
    // || []).join is not a function" -- and the whole push failed, taking
    // every other row in that batch with it. Latent until resume started
    // working, because nothing else ever read rows back from the manager.
    autosuggestions: typeof x.autosuggestions === 'string'
      ? x.autosuggestions.split(' | ').filter(Boolean)
      : (Array.isArray(x.autosuggestions) ? x.autosuggestions : []),
    amazonSuggestCount: x.amazon_suggest_count, amazonRank: x.amazon_rank, amazonPrice: x.amazon_price,
    amazonRating: x.amazon_rating, amazonReviews: x.amazon_reviews, amazonTitle: x.amazon_title,
    amazonCompetitors: x.amazon_competitors, amazonTotalResults: x.amazon_total_results,
    topMatchSeller: x.top_match_seller, topMatchPrice: x.top_match_price, topMatchThumbnail: x.top_match_thumbnail,
    // Rebuild the engine-shaped arrays (camelCase) the export layer reads:
    // matchedThumbnails (urls), matchedConfidences (numbers),
    // matchedSellers, matchedPrices, matchedQualities. Previously these were
    // stored under snake_case keys with STRING values, so restored rows lost
    // all match data on the next export.
    matchedThumbnails,
    matchedConfidences,
    matchedSellers,
    matchedPrices,
    matchedQualities,
    matchedLinks: _splitList(x.matched_links), verifiedLinks: _splitList(x.verified_links),
    // sellers/unmatched sellers can't be round-tripped from the joined
    // strings alone — leave them as empty arrays rather than undefined.
    sellers: [],
  });
}

export async function fetchBatchReportFromManager(batchId, onProgress) {
  if (!batchId) throw new Error('Batch ID required.');
  const r = await _get(`/api/keywords?batchId=${encodeURIComponent(batchId)}`);
  const rows = Array.isArray(r.rows) ? r.rows : [];
  onProgress?.({ fetched: rows.length });
  return rows.map(managerRowToReportRow);
}

// MANAGER UI: per-worker breakdown for a batch (inFlight / done / failed).
export async function getActiveWorkers(batchId) {
  if (!batchId) return [];
  const r = await _get(`/api/jobs/per-product?batchId=${encodeURIComponent(batchId)}`);
  const byWorker = new Map();
  for (const row of (r.rows || [])) {
    if (!row.claimed_by && row.status !== 'done' && row.status !== 'failed') continue;
    const w = row.claimed_by || '(unknown)';
    const cur = byWorker.get(w) || { worker: w, inFlight: 0, doneCount: 0, failedCount: 0, lastHeartbeat: null };
    if (row.status === 'claimed') { cur.inFlight++; if (row.heartbeat_at && (!cur.lastHeartbeat || row.heartbeat_at > cur.lastHeartbeat)) cur.lastHeartbeat = row.heartbeat_at; }
    else if (row.status === 'done') cur.doneCount++;
    else if (row.status === 'failed') cur.failedCount++;
    byWorker.set(w, cur);
  }
  return Array.from(byWorker.values()).sort((a, b) => (b.inFlight + b.doneCount) - (a.inFlight + a.doneCount));
}

// WORKER UI: pick which batch to claim from (manager-pinned, else newest pending).
export async function getActiveBatchId() {
  try { const r = await _get('/api/jobs/active-batch'); return r.batchId || null; }
  catch { return null; }
}

// MANAGER UI: failed jobs for a batch.
export async function getFailedJobs(batchId, limit = 50) {
  if (!batchId) return [];
  const r = await _get(`/api/jobs/per-product?batchId=${encodeURIComponent(batchId)}`);
  return (r.rows || []).filter(x => x.status === 'failed').slice(0, limit)
    .map(x => ({ id: x.id, sku: x.sku, product_name: x.product_name, product_url: x.product_url, claimed_by: x.claimed_by, failed_reason: x.failed_reason, attempts: x.attempts, claimed_at: x.claimed_at }));
}

// ---- Dashboard: activity log + commands + stats ----
export async function pushActivityLog(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { inserted: 0 };
  try { await _post('/api/activity', { events: entries }); return { inserted: entries.length }; }
  catch (e) { return { inserted: 0, error: e.message }; }
}
export async function fetchActivityLog({ batchId, sinceTs, level, workerId, limit = 200 } = {}) {
  try {
    const qs = new URLSearchParams(); if (batchId) qs.set('batchId', batchId); qs.set('limit', String(limit));
    const r = await _get(`/api/activity?${qs.toString()}`);
    let events = r.events || [];
    if (workerId) events = events.filter(e => e.worker_id === workerId);
    if (level && level !== 'all') events = events.filter(e => e.level === level);
    if (sinceTs) { const t = Date.parse(sinceTs); if (Number.isFinite(t)) events = events.filter(e => (e.ts || 0) > t); }
    return events;
  } catch { return []; }
}
export async function fetchWorkerStats(batchId) {
  try { const r = await _get('/api/jobs/worker-stats'); let w = r.workers || []; if (batchId) w = w.filter(x => x.batch_id === batchId); return w; }
  catch { return []; }
}
export async function fetchPerProductStatus(batchId, limit = 500) {
  if (!batchId) return [];
  try { const r = await _get(`/api/jobs/per-product?batchId=${encodeURIComponent(batchId)}`); return (r.rows || []).slice(0, limit); }
  catch { return []; }
}
export async function sendWorkerCommand({ workerId, command, payload, managerId }) {
  if (!command) throw new Error('command required');
  await _post('/api/commands', { workerId: workerId || null, command, payload: payload || null, createdBy: managerId || null });
  return { command, worker_id: workerId || null };
}
export async function fetchPendingCommands(workerId) {
  if (!workerId) return [];
  try { const r = await _get(`/api/commands?workerId=${encodeURIComponent(workerId)}`); return r.commands || []; }
  catch { return []; }
}
export async function acknowledgeCommand(commandId, workerId) {
  if (!commandId) return { updated: 0 };
  try { await _post('/api/commands/ack', { ids: [Number(commandId)], workerId: workerId || null }); return { updated: 1 }; }
  catch { return { updated: 0 }; }
}

// ---- Cleanup ----
export async function cleanupOldData({ logDays = 7, commandsDays = 1 } = {}) {
  try { const r = await _post('/api/cleanup', { logDays, commandsDays }); return { activityLog: r.activityLog || 0, ackedCommands: r.ackedCommands || 0, errors: [] }; }
  catch (e) { return { activityLog: 0, ackedCommands: 0, errors: [e.message] }; }
}

// ---- Worker config (push-to-workers) ----
// Config is stored as a snake_case blob so workerConfigToRunOpts still works.
// Pass our workerId so the manager can resolve kp_url to THIS worker's
// Google Ads account when the fleet is configured with kp_accounts. Without
// it every worker gets the same URL, which is wrong the moment more than one
// Ads account is in play — see resolveKpForWorker in manager/routes/config.js.
export async function fetchWorkerConfig(workerId) {
  try {
    const q = workerId ? `?workerId=${encodeURIComponent(workerId)}` : '';
    const r = await _get(`/api/config${q}`);
    return { ...(r.config || {}), active_batch_id: r.active_batch_id || null };
  } catch { return null; }
}
export async function saveWorkerConfig(updates, _managerId) {
  if (!updates || typeof updates !== 'object') throw new Error('updates must be an object');
  const body = {};
  const patch = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (k === 'active_batch_id') body.activeBatchId = v || null;
    else patch[k] = v;
  }
  if (Object.keys(patch).length) body.configPatch = patch;
  await _post('/api/config', body);
  return await fetchWorkerConfig();
}
export function workerConfigToRunOpts(cfg) {
  if (!cfg) return {};
  const out = {};
  if (cfg.kp_url)                     out.kpUrl                 = cfg.kp_url;
  // Every configured Ads account, so a worker that cannot open the one it was
  // given can TRY THE OTHERS rather than failing. A KP url only works from a
  // Chrome profile signed into the Google login that owns its ocid, and which
  // login a given PC has is not knowable from here — so the worker probes.
  // Master switch for Keyword Planner.
  //
  // KP only returns search-volume data for an Ads account with billing or
  // active spend. Neither account on this fleet has either, so KP opens and
  // returns 0 ideas every time -- the pane loads, the seed submits, nothing
  // comes back. Every attempt is unwinnable work: navigations, retries and
  // minutes per SKU spent on a service that cannot answer. Turning it off
  // routes that time into PAA, autosuggest, related-search and Amazon, which
  // all work today. Flip it back the moment an account is funded.
  if (cfg.kp_enabled === false) { out.skipR1Kp = true; out.skipR2Kp = true; }
  if (Array.isArray(cfg.kp_accounts)) {
    out.kpAccountUrls = cfg.kp_accounts.map(a => a && a.url).filter(Boolean);
  }
  if (cfg.kp_max_per_product != null) out.kpMaxPerProduct       = cfg.kp_max_per_product;
  if (cfg.match_profile)              out.matchProfile          = cfg.match_profile;
  if (cfg.clip_threshold_override != null) out.clipThresholdOverride = Number(cfg.clip_threshold_override);
  if (cfg.max_image_match_rows != null) out.maxImageMatchRows   = cfg.max_image_match_rows;
  if (cfg.search_delay_min_ms != null) out.searchDelayMinMs     = cfg.search_delay_min_ms;
  if (cfg.search_delay_max_ms != null) out.searchDelayMaxMs     = cfg.search_delay_max_ms;
  if (cfg.product_delay_min_ms != null) out.productDelayMinMs   = cfg.product_delay_min_ms;
  if (cfg.product_delay_max_ms != null) out.productDelayMaxMs   = cfg.product_delay_max_ms;
  if (cfg.chunk_size != null)         out.chunkSize             = cfg.chunk_size;
  if (cfg.chunk_rest_min_ms != null)  out.chunkRestMinMs        = cfg.chunk_rest_min_ms;
  if (cfg.chunk_rest_max_ms != null)  out.chunkRestMaxMs        = cfg.chunk_rest_max_ms;
  if (cfg.cap != null)                out.cap                   = cfg.cap;
  if (cfg.auto_export != null)        out.autoExport            = cfg.auto_export;
  // 'system' lets the screen sleep while the CPU keeps working; 'display'
  // (default) keeps the screen on. See the keep-awake comment in background.js
  // — 'system' trades a dark screen for harder background-tab throttling.
  if (cfg.keep_awake_level)           out.keepAwakeLevel        = cfg.keep_awake_level;
  // Whether the KP manual-click fallback may pull its tab to the foreground.
  // Off by default: an unattended worker must never steal focus.
  if (cfg.allow_focus_steal != null)  out.allowFocusSteal       = !!cfg.allow_focus_steal;
  // How many leaf SERPs may run at once. Tunable from the manager without a
  // redeploy, because the right value depends on the machine and on how much
  // parallelism Google tolerates from a given IP -- and if it turns out to be
  // wrong, the fix should be a config change, not a code push to nine PCs.
  // 1 restores the old strictly-serial behaviour.
  // Hard per-product deadline in minutes. 0 disables it.
  if (cfg.product_deadline_min != null) out.productDeadlineMs = Math.max(0, Number(cfg.product_deadline_min) || 0) * 60000;
  if (cfg.serp_concurrency != null)   out.serpConcurrency       = Math.max(1, Math.min(8, Number(cfg.serp_concurrency) || 1));
  return out;
}

// MANAGER UI: live keyword-output stats per SKU for a batch.
// Lightweight worker roster ping. Called by the worker's 30s auto-poll
// alarm regardless of claim outcome so the manager can distinguish
// 'armed and alive but no work' from 'gone'. Silent on error — the
// manager will just miss a heartbeat, not the end of the world.
export async function sendWorkerHeartbeat(workerId, extras = {}) {
  if (!workerId) return { ok: false };
  try {
    const body = { workerId };
    if (extras.mac)         body.mac         = extras.mac;
    if (extras.hostname)    body.hostname    = extras.hostname;
    // Report the extension bundle hash this worker was installed with —
    // manager persists it so the Fleet UI can flag out-of-date workers
    // when the manager's current WORKER_FILES hash diverges from this
    // one (indicates the operator needs to re-run install-worker.ps1
    // on that PC to pick up server-side fixes).
    if (extras.versionHash) body.versionHash = extras.versionHash;
    return await _post('/api/workers/heartbeat', body);
  } catch { return { ok: false }; }
}

// Fetch the manager's current WORKER_FILES bundle hash. Called once on
// worker cold-start; the returned hash is what we then echo on every
// subsequent heartbeat so the manager can compare it against its live
// hash and flag mismatches.
// The MANAGER's current hash — what the fleet SHOULD be running.
export async function fetchWorkerBundleHash() {
  try {
    const r = await _get('/api/worker/version-hash');
    return r?.hash || '';
  } catch { return ''; }
}

// Resume state for one SKU: which rounds already succeeded, and the rows
// they produced. Lets a requeued SKU skip straight to the rounds that did
// not finish instead of repeating minutes of completed work.
export async function fetchResumeState(batchId, productUrl) {
  if (!batchId || !productUrl) return null;
  try {
    const r = await _get(`/api/jobs/resume-state?batchId=${encodeURIComponent(batchId)}&productUrl=${encodeURIComponent(productUrl)}`);
    // priorRows come back exactly as stored -- snake_case. Convert them, or
    // every restored row re-enters the report without a batchId and is
    // rejected on the next push.
    if (r && Array.isArray(r.priorRows)) r.priorRows = r.priorRows.map(managerRowToReportRow);
    return r;
  } catch { return null; }
}

// THIS extension's own hash — what this worker IS running.
//
// Computed from our own file contents, using the same recipe as the
// manager's currentWorkerBundleHash():
//   sha256( "<rel>:<sha256hex(bytes)>" joined by "|" ).slice(0, 16)
//
// Cached for the lifetime of the service worker, deliberately. The SW loaded
// its modules at startup, so a hash taken at startup is what is actually
// executing. If the watchdog downloads new files but the extension has not
// reloaded, we keep reporting the OLD hash and the manager correctly shows
// the worker as outdated — which is the entire point. Re-reading the files
// on a timer would report what is on disk, not what is running, and that is
// exactly the bug this replaces: workers echoed the manager's hash back and
// so could never appear outdated, no matter how stale their code was.
let _ownBundleHashPromise = null;
export function computeOwnBundleHash() {
  if (_ownBundleHashPromise) return _ownBundleHashPromise;
  _ownBundleHashPromise = (async () => {
    try {
      // The manager owns the canonical file list; asking keeps the two in
      // step when WORKER_FILES changes.
      const manifest = await _get('/worker-files.json');
      const files = Array.isArray(manifest?.files) ? manifest.files : [];
      if (!files.length) return '';
      const sha256Hex = async (buf) => {
        const d = await crypto.subtle.digest('SHA-256', buf);
        return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
      };
      const parts = [];
      for (const rel of files) {
        try {
          const resp = await fetch(chrome.runtime.getURL(rel));
          if (!resp.ok) { parts.push(`${rel}:MISSING`); continue; }
          parts.push(`${rel}:${await sha256Hex(await resp.arrayBuffer())}`);
        } catch { parts.push(`${rel}:MISSING`); }
      }
      const full = await sha256Hex(new TextEncoder().encode(parts.join('|')));
      return full.slice(0, 16);
    } catch { return ''; }
  })();
  return _ownBundleHashPromise;
}

export async function fetchBatchKeywordStats(batchId, limit = 50) {
  if (!batchId) return null;
  const [jobsR, kwR] = await Promise.all([
    _get(`/api/jobs/per-product?batchId=${encodeURIComponent(batchId)}`),
    _get(`/api/keywords?batchId=${encodeURIComponent(batchId)}`),
  ]);
  const jobs = jobsR.rows || [];
  const kwByUrl = new Map();
  let totalKeywords = 0, mostRecentDoneAt = null;
  for (const r of (kwR.rows || [])) {
    const u = r.product_url; if (!u) continue;
    const cur = kwByUrl.get(u) || { count: 0, withImages: 0 };
    cur.count++; if ((r.image_count || 0) > 0) cur.withImages++;
    kwByUrl.set(u, cur); totalKeywords++;
  }
  const perSku = jobs.map(j => {
    const s = kwByUrl.get(j.product_url) || { count: 0, withImages: 0 };
    if (j.done_at && (!mostRecentDoneAt || j.done_at > mostRecentDoneAt)) mostRecentDoneAt = j.done_at;
    return { sku: j.sku || '—', productName: j.product_name || '—', productUrl: j.product_url, status: j.status,
      claimedBy: j.claimed_by || null, failedReason: j.failed_reason || null, doneAt: j.done_at || null,
      kwCount: s.count, imageMatches: s.withImages };
  });
  perSku.sort((a, b) => b.kwCount - a.kwCount);
  const skusWithKw = perSku.filter(s => s.kwCount > 0).length;
  const skusZero = perSku.filter(s => s.kwCount === 0 && s.status !== 'pending' && s.status !== 'claimed');
  return {
    batchId, totalKeywords, totalSkus: jobs.length, skusWithKeywords: skusWithKw,
    skusDone: perSku.filter(s => s.status === 'done').length,
    skusFailed: perSku.filter(s => s.status === 'failed').length,
    skusPending: perSku.filter(s => s.status === 'pending').length,
    skusClaimed: perSku.filter(s => s.status === 'claimed').length,
    avgKwPerSku: skusWithKw > 0 ? Math.round(totalKeywords / skusWithKw) : 0,
    topSkus: perSku.slice(0, limit), skusWithZeroKw: skusZero.slice(0, limit),
    mostRecentDoneAt, schemaDowngraded: false, fetchedAt: new Date().toISOString(),
  };
}

// MANAGER UI: re-queue a failed job.
export async function requeueJob(jobId) {
  if (!jobId) return { updated: 0, error: 'job id required' };
  try { const r = await _post('/api/jobs/requeue', { jobId }); return { updated: r.updated || 0 }; }
  catch (e) { return { updated: 0, error: e.message }; }
}

// Dashboard "Re-queue zero-KW" button — resets every 'done' job in
// batchId (or across all batches when omitted) that has zero keyword rows
// in the manager back to pending. Mirrors manager/public/app.js's own
// jobsRequeueDoneEmpty call against the same manager endpoint.
export async function requeueDoneEmptyJobs(batchId) {
  try {
    const r = await _post('/api/jobs/requeue-done-empty', { batchId: batchId || null });
    return { count: r.updated || 0 };
  } catch (e) { return { count: 0, error: e.message }; }
}
