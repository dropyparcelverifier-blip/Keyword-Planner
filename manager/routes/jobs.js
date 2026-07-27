// The work queue — the core of the distributed system.
//
// A job is one SKU in one batch, moving pending → claimed → done | failed.
// Workers claim, heartbeat while working, then mark done or failed. Nothing
// here trusts the worker: claim limits, staleness reaping and requeue policy
// are all decided server-side, because a worker that has crashed or had its
// service worker recycled cannot be relied on to clean up after itself.
//
// Two properties matter more than anything else in this file:
//   1. A claim must never be handed to two workers. claimJobs() runs one
//      synchronous BEGIN IMMEDIATE transaction; node:sqlite is synchronous
//      and Node is single-threaded, so no two claims can interleave.
//   2. Work must never be stranded. Every path that can leave a job claimed
//      by a worker that will never come back has a reaper: stale-heartbeat
//      release, max-attempts auto-fail, and stuck-claim force-fail.
//
// Bulk SKU import and Excel upload live in routes/jobs-upload.js — they pull
// in Shopify resolution and are a different concern from queue mechanics.
'use strict';

// ---------------- Claim / heartbeat / completion ----------------

async function claim({ req, res, ctx }) {
  const { db, send, readJson, claimJobs } = ctx;
  const b = await readJson(req);
  const workerId = String(b.workerId || '');
  // Streaming claim policy — a fresh worker gets up to 2 SKUs to build a
  // small buffer, then refills 1 at a time as it completes. Keeps in-flight
  // small so a worker crash loses <= 2 SKUs rather than 5-8, and lets the
  // pending queue drain evenly instead of one worker hoarding 5 while
  // others idle. Deliberately overrides the client's requested limit: the
  // server is authoritative on load balancing.
  const currentClaims = workerId
    ? db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status='claimed' AND claimed_by=?`).get(workerId).c
    : 0;
  const askedFor = Math.max(1, Math.min(50, b.limit || 5));
  const streamingLimit = currentClaims === 0 ? Math.min(askedFor, 2) : Math.min(askedFor, 1);
  return send(res, 200, { ok: true, jobs: claimJobs(workerId, String(b.batchId || ''), streamingLimit) });
}

// Resolve the batch a worker should be operating on: the manager's pin if it
// still has pending work, else the newest batch with pending jobs. Echoed
// back on heartbeat and on keyword push so a worker holding a stale cached
// batch_id can self-correct instead of writing orphan rows.
function resolveActiveBatch(Q) {
  const cfg = Q.getConfig.get();
  const pinned = (cfg?.active_batch_id || '').trim();
  if (pinned && Q.batchHasPending.get(pinned)) return pinned;
  return Q.newestPendingBatch.get()?.batch_id || null;
}

async function heartbeat({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const t = now();
  let n = 0;
  for (const id of (Array.isArray(b.jobIds) ? b.jobIds : [])) {
    n += Q.heartbeatById.run(t, Number(id), b.workerId).changes;
  }
  return send(res, 200, { ok: true, updated: n, active_batch_id: resolveActiveBatch(Q) });
}

function activeBatch({ res, ctx }) {
  const { Q, send } = ctx;
  return send(res, 200, { ok: true, batchId: resolveActiveBatch(Q) });
}

// Cross-batch dedup check: is this product_url already active elsewhere?
function urlActive({ res, url, ctx }) {
  const { Q, send } = ctx;
  const u = url.searchParams.get('url') || '';
  const b = url.searchParams.get('excludeBatch') || '';
  return send(res, 200, { ok: true, active: !!Q.existsActiveUrl.get(u, b) });
}

async function markDone({ req, res, ctx }) {
  const { db, Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  Q.markDone.run(now(), b.batchId, b.productUrl);
  // Phantom-done detection — a SKU marked done for which the manager holds
  // ZERO keyword rows. Almost always means the worker's pushes were being
  // rejected (see the orphan-batch guard in routes/keywords.js) while
  // markDone flipped the status regardless. Logging it here makes the
  // failure visible the instant it happens instead of surfacing later as an
  // inexplicably empty batch.
  if (b.batchId && b.productUrl) {
    try {
      const kwCount = db.prepare(`SELECT COUNT(*) AS n FROM keywords WHERE batch_id=? AND product_url=?`).get(b.batchId, b.productUrl);
      if (Number(kwCount?.n || 0) === 0) {
        Q.insertActivity.run(
          b.batchId, b.workerId || null, 'err', 'phantom_done',
          `⚠ PHANTOM DONE: SKU marked done but the manager has ZERO keyword rows for it. Common causes: (1) worker's cached batch_id doesn't match this batch (see 'ORPHAN-BATCH REJECT' events), (2) push failed after markDone. Requeue via 'Requeue empty' or the SHIP-badge low-yield action.`,
          b.productUrl, null,
        );
      }
    } catch {}
  }
  return send(res, 200, { ok: true });
}

async function markFailed({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  Q.markFailed.run(b.reason || null, now(), b.batchId, b.productUrl);
  return send(res, 200, { ok: true });
}

// ---------------- Reapers ----------------

// Order matters. Auto-fail the retry-loop jobs (attempts >= 3) BEFORE
// releasing stale claims: releasing first flips them to pending, at which
// point the auto-fail predicate no longer matches 'claimed' and never fires.
function reapStaleClaims(Q, now, cutoff) {
  const failed = Q.failMaxAttempts.run(now(), cutoff);
  // 15-min claim-age floor so fresh claims aren't yanked from a worker that
  // is still legitimately working — see the failStuckClaims comment.
  const stuck = Q.failStuckClaims.run(now(), now() - 5 * 60 * 1000, now() - 30 * 60 * 1000);
  const released = Q.releaseStale.run(cutoff);
  return { auto_failed: failed.changes, force_failed_stuck: stuck.changes, released: released.changes };
}

async function releaseStale({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const mins = Number.isFinite(b.staleMinutes) ? b.staleMinutes : 10;
  const r = reapStaleClaims(Q, now, now() - mins * 60000);
  return send(res, 200, { ok: true, ...r });
}

async function releaseByWorker({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const wid = String(b.workerId || '').trim();
  if (!wid) return send(res, 400, { ok: false, error: 'workerId required' });
  return send(res, 200, { ok: true, released: Q.releaseByWorker.run(wid).changes, workerId: wid });
}

// Read-only diagnostic: jobs stuck at attempts >= 3, for the Retry-loops panel.
function retryLoops({ res, ctx }) {
  const { Q, send, now } = ctx;
  const rows = Q.retryLoops.all();
  const nowMs = now();
  const enriched = rows.map(r => ({
    ...r,
    claimed_for_ms: r.claimed_at ? nowMs - r.claimed_at : null,
    heartbeat_stale_for_ms: r.heartbeat_at ? nowMs - r.heartbeat_at : null,
  }));
  return send(res, 200, { ok: true, count: rows.length, jobs: enriched });
}

// ---------------- Requeue ----------------

async function requeue({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  // Two lookup modes:
  //   { jobId }                  — canonical, from the Failed-jobs row click
  //   { batchId, productUrl }    — from the per-SKU 'Re-queue this SKU'
  //                                button on Analytics, which knows the URL
  //                                but not the job id
  let info, jobId, priorStatus = null;
  if (b.jobId) {
    jobId = Number(b.jobId);
    priorStatus = db.prepare(`SELECT status FROM jobs WHERE id=?`).get(jobId)?.status || null;
    info = Q.requeue.run(jobId);
  } else if (b.batchId && b.productUrl) {
    const row = db.prepare(`SELECT id, status FROM jobs WHERE batch_id=? AND product_url=? LIMIT 1`).get(String(b.batchId), String(b.productUrl));
    if (!row) return send(res, 404, { ok: false, error: 'no job found for that batchId + productUrl' });
    jobId = Number(row.id);   // guard against BigInt from newer node:sqlite
    priorStatus = row.status;
    info = Q.requeue.run(jobId);
  } else {
    return send(res, 400, { ok: false, error: 'send {jobId} or {batchId, productUrl}' });
  }
  // changes === 0 with a valid id shouldn't happen (UPDATE matches by WHERE
  // regardless of value delta). Report OK either way — the job is pending
  // now — but echo diagnostics so a future 0-changes surfaces with real
  // information rather than a guess.
  return send(res, 200, {
    ok: true,
    updated: Number(info.changes),
    job_id: jobId,
    prior_status: priorStatus,
    was_already_pending: priorStatus === 'pending',
  });
}

async function requeueAllFailed({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const bId = String(b.batchId || '').trim();
  const info = bId ? Q.requeueBatchFailed.run(bId) : Q.requeueAllFailed.run();
  return send(res, 200, { ok: true, updated: info.changes });
}

async function requeueDoneEmpty({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const bId = (b.batchId && String(b.batchId).trim()) || null;
  return send(res, 200, { ok: true, updated: Q.requeueDoneEmpty.run(bId, bId).changes });
}

// Requeue every done job in a batch whose keyword count is below the
// low-yield threshold. Complements requeue-done-empty, which handles the
// exact-zero case; this covers 'done but under-yielded' too.
async function requeueLowYield({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  const bId = (b.batchId && String(b.batchId).trim()) || null;
  if (!bId) return send(res, 400, { ok: false, error: 'batchId required' });
  const minRows = Math.max(1, Number(b.minRows || 30));
  // Identify, then wipe: find the low-yield done jobs (same query the
  // readiness endpoint uses), delete their existing keyword rows so the
  // re-run doesn't leave duplicates, then reset the jobs to pending.
  const targets = Q.lowYieldDoneJobs.all(bId, minRows);
  if (targets.length === 0) return send(res, 200, { ok: true, updated: 0, cleared_keyword_rows: 0 });
  let clearedKw = 0;
  db.exec('BEGIN');
  try {
    for (const t of targets) {
      clearedKw += Q.deleteKeywordsForProduct.run(bId, t.product_url).changes;
      Q.resetJobToPending.run(t.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return send(res, 200, {
    ok: true,
    updated: targets.length,
    cleared_keyword_rows: clearedKw,
    skus: targets.map(t => ({ id: t.id, sku: t.sku, row_count: t.row_count })),
  });
}

// ---------------- Per-job CRUD ----------------

function list({ res, url, ctx }) {
  const { Q, send } = ctx;
  const batchId = String(url.searchParams.get('batchId') || '').trim();
  if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
  return send(res, 200, { ok: true, rows: Q.jobsForBatch.all(batchId) });
}

// Priority changes are always safe. Field edits are refused for CLAIMED jobs
// unless force=true, because renaming a product mid-run desynchronises the
// worker's local state. product_url is NEVER updatable — it is part of the
// UNIQUE key and is the job's identity across the whole system.
async function update({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const id = Number(b.jobId || b.id || 0);
  if (!Number.isFinite(id) || id <= 0) return send(res, 400, { ok: false, error: 'jobId required' });
  const row = Q.getJob.get(id);
  if (!row) return send(res, 404, { ok: false, error: `no job with id ${id}` });
  if (b.priority != null && Object.keys(b).length <= 3) {
    Q.updateJobPriority.run(Number(b.priority), id);
    return send(res, 200, { ok: true, updated: 1, mode: 'priority-only' });
  }
  if (row.status === 'claimed' && !b.force) {
    return send(res, 409, { ok: false, error: `job ${id} is claimed by ${row.claimed_by}. Release the claim first, or pass force=true (worker's next heartbeat may fail).` });
  }
  Q.updateJobFields.run(
    b.sku          != null ? String(b.sku)          : row.sku,
    b.product_name != null ? String(b.product_name) : row.product_name,
    b.priority     != null ? Number(b.priority)     : row.priority,
    b.handles      != null ? String(b.handles)      : row.handles,
    b.brands       != null ? String(b.brands)       : row.brands,
    id,
  );
  return send(res, 200, { ok: true, updated: 1, mode: 'full-field' });
}

// Flip a job back to pending regardless of state. Refuses a DONE job unless
// forced, since that silently re-runs work the operator may think is final.
async function reset({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const id = Number(b.jobId || b.id || 0);
  if (!Number.isFinite(id) || id <= 0) return send(res, 400, { ok: false, error: 'jobId required' });
  const row = Q.getJob.get(id);
  if (!row) return send(res, 404, { ok: false, error: `no job with id ${id}` });
  if (row.status === 'done' && !b.force) {
    return send(res, 409, { ok: false, error: `job ${id} is already done. Pass force=true to re-queue it (existing keyword rows stay in the DB).` });
  }
  Q.updateJobStatus.run('pending', id);
  return send(res, 200, { ok: true, updated: 1, previous: row.status });
}

// Refuses claimed jobs unless forced. Drops the job's keyword rows in the
// same transaction so Analytics isn't left showing rows for a job that no
// longer exists.
async function deleteOne({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  const id = Number(b.jobId || b.id || 0);
  if (!Number.isFinite(id) || id <= 0) return send(res, 400, { ok: false, error: 'jobId required' });
  const row = Q.getJob.get(id);
  if (!row) return send(res, 404, { ok: false, error: `no job with id ${id}` });
  if (row.status === 'claimed' && !b.force) {
    return send(res, 409, { ok: false, error: `job ${id} is claimed by ${row.claimed_by}. Release the claim first, or pass force=true.` });
  }
  // node:sqlite has no better-sqlite3-style db.transaction() helper — use
  // explicit BEGIN/COMMIT, the pattern used throughout this codebase.
  let kwDeleted = 0;
  db.exec('BEGIN');
  try {
    Q.deleteJob.run(id);
    kwDeleted = Q.deleteKeywordsForProduct.run(row.batch_id, row.product_url).changes;
    db.exec('COMMIT');
  } catch (txErr) { db.exec('ROLLBACK'); throw txErr; }
  return send(res, 200, { ok: true, deleted: 1, keywordsDeleted: kwDeleted, sku: row.sku, productUrl: row.product_url });
}

// Insert a single SKU into an existing batch — same upsert semantics as the
// bulk upload, bounded to one row.
async function addOne({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const batchId = String(b.batchId || '').trim();
  const productUrl = String(b.url || b.product_url || '').trim();
  if (!batchId)    return send(res, 400, { ok: false, error: 'batchId required' });
  if (!productUrl) return send(res, 400, { ok: false, error: 'product url required' });
  Q.insertJob.run(
    batchId,
    b.sku ? String(b.sku) : null,
    productUrl,
    b.product_name ? String(b.product_name) : (b.name ? String(b.name) : null),
    Number.isFinite(b.priority) ? Number(b.priority) : 100,
    Array.isArray(b.handles) ? b.handles.join('|') : (b.handles ? String(b.handles) : null),
    Array.isArray(b.brands)  ? b.brands.join('|')  : (b.brands  ? String(b.brands)  : null),
  );
  const row = Q.jobIdByBatchAndUrl.get(batchId, productUrl);
  return send(res, 200, { ok: true, jobId: row?.id, batchId, productUrl });
}

// ---------------- Reporting ----------------

function summary({ res, ctx }) {
  const { Q, send } = ctx;
  return send(res, 200, { ok: true, batches: Q.summary.all() });
}

// Runs the stale reaper before counting, so the dashboard never shows
// in-flight work held by a worker that is never coming back. Called on every
// 10s dashboard poll — cheap, one index-covered UPDATE — which is what makes
// ghost claims self-heal without anyone calling release-stale.
function workerStats({ res, ctx }) {
  const { Q, send, now } = ctx;
  reapStaleClaims(Q, now, now() - 5 * 60000);
  return send(res, 200, { ok: true, workers: Q.workerStats.all() });
}

function perProduct({ res, url, ctx }) {
  const { Q, send } = ctx;
  const batchId = url.searchParams.get('batchId') || '';
  const sinceRaw = url.searchParams.get('sinceChangedAt');
  const sinceChangedAt = sinceRaw != null && sinceRaw !== '' ? Number(sinceRaw) : null;
  const incremental = Number.isFinite(sinceChangedAt);
  const rows = incremental ? Q.perProductSince.all(batchId, sinceChangedAt) : Q.perProduct.all(batchId);
  const maxRow = Q.perProductMaxChanged.get(batchId);
  return send(res, 200, {
    ok: true, rows,
    maxChangedAt: Number.isFinite(maxRow?.mx) ? maxRow.mx : 0,
    incremental,
    sinceChangedAt: incremental ? sinceChangedAt : null,
  });
}

function activeWorkers({ res, url, ctx }) {
  const { Q, send } = ctx;
  return send(res, 200, { ok: true, workers: Q.activeWorkers.all(url.searchParams.get('batchId') || '') });
}

function failedJobs({ res, url, ctx }) {
  const { Q, send } = ctx;
  const bId = url.searchParams.get('batchId') || '';
  return send(res, 200, { ok: true, rows: bId ? Q.failedJobsByBatch.all(bId) : Q.failedJobsAll.all() });
}

// Jobs marked done for which the manager holds zero keyword rows — the
// worker died or its push failed after the done-flag write.
function doneEmpty({ res, url, ctx }) {
  const { Q, send } = ctx;
  const bId = url.searchParams.get('batchId') || '';
  const rows = Q.doneEmptyJobs.all(bId || null, bId || null);
  return send(res, 200, { ok: true, rows, count: rows.length });
}

// Per-SKU round progress: which rounds finished, which are outstanding, and
// what each one yielded.
//
// Derived from the ⟦ROUND⟧ markers the engine writes to the activity log
// rather than a new table — the markers ride the existing activity pipeline
// (buffering, retry, batch scoping), so this needed no schema change. The
// last marker per (product, round) wins, which is what you want when a SKU
// is requeued and re-run.
const ROUND_ORDER = ['kp', 'paa', 'round1', 'round2', 'related', 'amazon', 'rescue'];

function roundProgress({ res, url, ctx }) {
  const { db, send } = ctx;
  const batchId = String(url.searchParams.get('batchId') || '').trim();
  if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });

  const rows = db.prepare(`
    SELECT product_url, message, ts FROM activity_log
    WHERE batch_id = ? AND message LIKE '⟦ROUND⟧%'
    ORDER BY ts ASC
  `).all(batchId);

  const byProduct = new Map();
  for (const r of rows) {
    if (!r.product_url) continue;
    const get = (k) => (r.message.match(new RegExp(`${k}=([^\\s]+)`)) || [])[1];
    const round = get('round');
    if (!round) continue;
    if (!byProduct.has(r.product_url)) byProduct.set(r.product_url, {});
    byProduct.get(r.product_url)[round] = {
      status: get('status') || 'unknown',
      rows: Number(get('rows') || 0),
      at: r.ts,
    };
  }

  // Pair the markers with job state so a SKU that never started is
  // distinguishable from one whose rounds all came back empty.
  const jobs = db.prepare(`
    SELECT product_url, sku, product_name, status, attempts FROM jobs WHERE batch_id = ?
  `).all(batchId);

  const out = jobs.map(j => {
    const seen = byProduct.get(j.product_url) || {};
    const rounds = ROUND_ORDER.map(name => ({
      round: name,
      status: seen[name]?.status || 'pending',
      rows: seen[name]?.rows ?? null,
      at: seen[name]?.at ?? null,
    }));
    const done = rounds.filter(r => r.status === 'ok').length;
    const settled = rounds.filter(r => r.status !== 'pending').length;
    return {
      product_url: j.product_url, sku: j.sku, product_name: j.product_name,
      job_status: j.status, attempts: j.attempts,
      rounds,
      rounds_ok: done,
      rounds_settled: settled,
      rounds_total: ROUND_ORDER.length,
      total_rows: rounds.reduce((a, r) => a + (r.rows || 0), 0),
    };
  });

  return send(res, 200, { ok: true, batchId, order: ROUND_ORDER, products: out });
}

// Everything a worker needs to RESUME one SKU instead of restarting it.
//
// A requeued SKU used to redo every round from scratch, including the ones
// that already succeeded — so a product that failed only in Round 2 paid for
// KP, PAA and the whole Round 1 SERP cycle again. On a slow SKU that is tens
// of minutes of duplicated work, and it is why requeuing felt so expensive.
//
// Returns the rounds already marked ok, plus the rows that product has
// already landed. The worker seeds its in-memory report with those rows (so
// dedup and downstream seed selection behave as if the rounds had just run)
// and skips straight to the first unfinished round.
function resumeState({ res, url, ctx }) {
  const { db, Q, send } = ctx;
  const batchId    = String(url.searchParams.get('batchId') || '').trim();
  const productUrl = String(url.searchParams.get('productUrl') || '').trim();
  if (!batchId || !productUrl) return send(res, 400, { ok: false, error: 'batchId + productUrl required' });

  const markers = db.prepare(`
    SELECT message, ts FROM activity_log
    WHERE batch_id = ? AND product_url = ? AND message LIKE '⟦ROUND⟧%'
    ORDER BY ts ASC
  `).all(batchId, productUrl);

  // Last marker per round wins — a re-run's result supersedes the earlier one.
  const rounds = {};
  for (const m of markers) {
    const get = (k) => (m.message.match(new RegExp(`${k}=([^\\s]+)`)) || [])[1];
    const round = get('round');
    if (round) rounds[round] = { status: get('status') || 'unknown', rows: Number(get('rows') || 0), at: m.ts };
  }

  // Only 'ok' counts as done. empty/skipped/failed are all worth retrying:
  // 'empty' may have been a transient Google response, and 'skipped' means a
  // broken KP session that may since have recovered.
  const completed = Object.entries(rounds).filter(([, v]) => v.status === 'ok').map(([k]) => k);

  let rows = [];
  try {
    rows = Q.keywordsByProduct.all(batchId, productUrl)
      .map(r => { try { return JSON.parse(r.data); } catch { return null; } })
      .filter(Boolean);
  } catch { /* no rows yet is normal */ }

  return send(res, 200, {
    ok: true, batchId, productUrl,
    completedRounds: completed,
    rounds,
    priorRows: rows,
    priorRowCount: rows.length,
    resumable: completed.length > 0 && rows.length > 0,
  });
}

function register(router) {
  router.get ('/api/jobs/round-progress',     roundProgress);
  router.get ('/api/jobs/resume-state',       resumeState);
  router.post('/api/jobs/claim',              claim);
  router.post('/api/jobs/heartbeat',          heartbeat);
  router.post('/api/jobs/done',               markDone);
  router.post('/api/jobs/failed',             markFailed);
  router.get ('/api/jobs/active-batch',       activeBatch);
  router.get ('/api/jobs/url-active',         urlActive);

  router.post('/api/jobs/release-stale',      releaseStale);
  router.post('/api/jobs/release-by-worker',  releaseByWorker);
  router.get ('/api/jobs/retry-loops',        retryLoops);

  router.post('/api/jobs/requeue',            requeue);
  router.post('/api/jobs/requeue-all-failed', requeueAllFailed);
  router.post('/api/jobs/requeue-done-empty', requeueDoneEmpty);
  router.post('/api/jobs/requeue-low-yield',  requeueLowYield);

  router.get ('/api/jobs/list',               list);
  router.post('/api/jobs/update',             update);
  router.post('/api/jobs/reset',              reset);
  router.post('/api/jobs/delete-one',         deleteOne);
  router.post('/api/jobs/add-one',            addOne);

  router.get ('/api/jobs/summary',            summary);
  router.get ('/api/jobs/worker-stats',       workerStats);
  router.get ('/api/jobs/per-product',        perProduct);
  router.get ('/api/jobs/active-workers',     activeWorkers);
  router.get ('/api/jobs/failed',             failedJobs);
  router.get ('/api/jobs/done-empty',         doneEmpty);
}

module.exports = { register };
