// manager/public/api.js
// Thin wrapper around the manager's HTTP API. Manager URL is always
// the current origin (the web app is served BY the manager). Token
// is optional — the manager may run un-authenticated on a tailnet.
//
// Token persists in localStorage; if the manager rejects a request
// with 401 we surface a token-entry banner instead of hard-failing.

const TOKEN_KEY = 'adbrainManagerToken';

export function getToken() {
  return (localStorage.getItem(TOKEN_KEY) || '').trim();
}
export function setToken(t) {
  const v = String(t || '').trim();
  if (v) localStorage.setItem(TOKEN_KEY, v);
  else   localStorage.removeItem(TOKEN_KEY);
}

async function _fetch(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers['X-Manager-Token'] = t;
  const resp = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${data?.error || 'request failed'}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health:            ()                => _fetch('/api/health'),
  jobsUpload:        (batchId, products) => _fetch('/api/jobs/upload', { method: 'POST', body: { batchId, products } }),
  jobsSummary:       ()                => _fetch('/api/jobs/summary'),
  jobsPerProduct:    (batchId)         => _fetch(`/api/jobs/per-product?batchId=${encodeURIComponent(batchId)}`),
  jobsWorkerStats:   ()                => _fetch('/api/jobs/worker-stats'),
  workersList:       ()                => _fetch('/api/workers/list'),
  jobsActiveWorkers: (batchId)         => _fetch(`/api/jobs/active-workers?batchId=${encodeURIComponent(batchId)}`),
  jobsActiveBatch:   ()                => _fetch('/api/jobs/active-batch'),
  jobsRequeue:       (jobId)           => _fetch('/api/jobs/requeue', { method: 'POST', body: { jobId } }),
  jobsReleaseStale:  (staleMinutes)    => _fetch('/api/jobs/release-stale', { method: 'POST', body: { staleMinutes } }),
  jobsReleaseByWorker: (workerId)      => _fetch('/api/jobs/release-by-worker', { method: 'POST', body: { workerId } }),
  keywordsGet:       (batchId)         => _fetch(`/api/keywords?batchId=${encodeURIComponent(batchId)}`),
  activityGet:       (batchId, limit, workerId) => _fetch(`/api/activity?batchId=${encodeURIComponent(batchId || '')}&limit=${limit || 120}${workerId ? `&workerId=${encodeURIComponent(workerId)}` : ''}`),
  activityErrors:    (batchId, limit) => _fetch(`/api/activity?batchId=${encodeURIComponent(batchId || '')}&limit=${limit || 60}&level=err`),
  commandsSend:      (workerId, command, payload) => _fetch('/api/commands', { method: 'POST', body: { workerId, command, payload, createdBy: 'web-manager' } }),
  configGet:         ()                => _fetch('/api/config'),
  configSet:         (config)          => _fetch('/api/config', { method: 'POST', body: { config } }),
  configPatch:       (configPatch)     => _fetch('/api/config', { method: 'POST', body: { configPatch } }),
  activeBatchPin:    (batchId)         => _fetch('/api/config', { method: 'POST', body: { activeBatchId: batchId } }),
  cleanup:           (logDays, commandsDays) => _fetch('/api/cleanup', { method: 'POST', body: { logDays, commandsDays } }),
  deleteBatch:       (batchId)         => _fetch('/api/jobs/delete-batch', { method: 'POST', body: { batchId } }),
  resetAll:          ()                => _fetch('/api/reset-all', { method: 'POST', body: { confirm: 'RESET' } }),
  failedJobs:        (batchId)         => _fetch(`/api/jobs/failed${batchId ? `?batchId=${encodeURIComponent(batchId)}` : ''}`),
  requeueAllFailed:  (batchId)         => _fetch('/api/jobs/requeue-all-failed', { method: 'POST', body: { batchId: batchId || '' } }),
  keywordsTimeline:  (batchId)         => _fetch(`/api/keywords/timeline${batchId ? `?batchId=${encodeURIComponent(batchId)}` : ''}`),
  keywordsBatches:   ()                => _fetch('/api/keywords/batches'),
  keywordsOrphans:   ()                => _fetch('/api/keywords/orphans'),
  cleanupOrphans:    ()                => _fetch('/api/keywords/cleanup-orphans', { method: 'POST', body: { confirm: 'CLEAN_ORPHANS' } }),
  quiesceWorkers:    ()                => _fetch('/api/workers/quiesce', { method: 'POST', body: {} }),
  backupsList:       ()                => _fetch('/api/backups/list'),
  backupNow:         ()                => _fetch('/api/backups/create', { method: 'POST', body: {} }),
  wakeOnLan:         (workerId, mac)   => _fetch('/api/workers/wol', { method: 'POST', body: { workerId, mac } }),
  setWorkerMac:      (workerId, mac)   => _fetch('/api/workers/set-mac', { method: 'POST', body: { workerId, mac } }),
  batchNames:        ()                => _fetch('/api/batches/names'),
  renameBatch:       (batchId, name)   => _fetch('/api/batches/rename', { method: 'POST', body: { batchId, name } }),
};

// Live keyword stats — mirrors the extension's dashboard fetchBatchKeywordStats.
// Two round-trips: per-product jobs + all keyword rows for the batch. Groups
// by product_url so we can show per-SKU counts.
export async function fetchBatchKeywordStats(batchId, limit = 100) {
  if (!batchId) return null;
  const [ppR, kwR] = await Promise.all([
    api.jobsPerProduct(batchId),
    api.keywordsGet(batchId),
  ]);
  const jobs = ppR.rows || [];
  const kwRows = kwR.rows || [];
  const kwByUrl = new Map();
  let totalKeywords = 0;
  let mostRecentDoneAt = null;
  for (const r of kwRows) {
    const u = r.product_url; if (!u) continue;
    const cur = kwByUrl.get(u) || { count: 0, withImages: 0 };
    cur.count++;
    if ((r.image_count || 0) > 0) cur.withImages++;
    kwByUrl.set(u, cur);
    totalKeywords++;
  }
  const perSku = jobs.map(j => {
    const s = kwByUrl.get(j.product_url) || { count: 0, withImages: 0 };
    if (j.done_at && (!mostRecentDoneAt || j.done_at > mostRecentDoneAt)) mostRecentDoneAt = j.done_at;
    return {
      id: j.id,
      sku: j.sku || '—',
      productName: j.product_name || '—',
      productUrl: j.product_url,
      status: j.status,
      claimedBy: j.claimed_by || null,
      failedReason: j.failed_reason || null,
      doneAt: j.done_at || null,
      kwCount: s.count,
      imageMatches: s.withImages,
    };
  });
  perSku.sort((a, b) => b.kwCount - a.kwCount);
  const skusWithKw = perSku.filter(s => s.kwCount > 0).length;
  const skusZero = perSku.filter(s => s.kwCount === 0 && s.status !== 'pending' && s.status !== 'claimed');
  return {
    batchId,
    totalKeywords,
    totalSkus: jobs.length,
    skusWithKeywords: skusWithKw,
    skusDone:    perSku.filter(s => s.status === 'done').length,
    skusFailed:  perSku.filter(s => s.status === 'failed').length,
    skusPending: perSku.filter(s => s.status === 'pending').length,
    skusClaimed: perSku.filter(s => s.status === 'claimed').length,
    avgKwPerSku: skusWithKw > 0 ? Math.round(totalKeywords / skusWithKw) : 0,
    topSkus: perSku.slice(0, limit),
    skusWithZeroKw: skusZero.slice(0, limit),
    mostRecentDoneAt,
    fetchedAt: Date.now(),
  };
}

// Generate the same adb2:<b64> setup code the extension emits, so
// workers can paste it into their extension popup. Encodes managerUrl
// (this origin) + optional token + optional KP URL.
export function generateSetupCode({ managerUrl, managerToken, kpUrl }) {
  const payload = JSON.stringify({
    v: 3,
    managerUrl: String(managerUrl || '').trim(),
    managerToken: String(managerToken || '').trim(),
    kpUrl: String(kpUrl || '').trim(),
  });
  // btoa needs binary-safe input; use TextEncoder → base64.
  const bytes = new TextEncoder().encode(payload);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'adb2:' + btoa(bin);
}
