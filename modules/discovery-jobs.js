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
export async function fetchBatchReportFromManager(batchId, onProgress) {
  if (!batchId) throw new Error('Batch ID required.');
  const r = await _get(`/api/keywords?batchId=${encodeURIComponent(batchId)}`);
  const rows = Array.isArray(r.rows) ? r.rows : [];
  onProgress?.({ fetched: rows.length });
  return rows.map(x => ({
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
    autosuggestCount: x.autosuggest_count, autosuggestions: x.autosuggestions,
    amazonSuggestCount: x.amazon_suggest_count, amazonRank: x.amazon_rank, amazonPrice: x.amazon_price,
    amazonRating: x.amazon_rating, amazonReviews: x.amazon_reviews, amazonTitle: x.amazon_title,
    amazonCompetitors: x.amazon_competitors, amazonTotalResults: x.amazon_total_results,
    topMatchSeller: x.top_match_seller, topMatchPrice: x.top_match_price, topMatchThumbnail: x.top_match_thumbnail,
    matched_thumbnails: x.matched_thumbnails, matched_sellers: x.matched_sellers, matched_prices: x.matched_prices,
    matchedLinks: (x.matched_links || '').split(' | ').filter(Boolean), verifiedLinks: (x.verified_links || '').split(' | ').filter(Boolean),
  }));
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
export async function fetchWorkerConfig() {
  try {
    const r = await _get('/api/config');
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
export async function fetchWorkerBundleHash() {
  try {
    const r = await _get('/api/worker/version-hash');
    return r?.hash || '';
  } catch { return ''; }
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
