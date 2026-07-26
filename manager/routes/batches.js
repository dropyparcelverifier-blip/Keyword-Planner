// Batch-level rollups: "is this batch shippable?" and "when will it finish?"
//
// Both answer questions an operator would otherwise have to derive by eye
// from six separate counters, so the classification logic lives server-side
// where the dashboard, the CLI and any future consumer all get the same
// answer. Both degrade gracefully — they return a null result plus a
// human-readable `reason` rather than erroring, because "we can't tell yet"
// is a normal state early in a batch.
'use strict';

// Ship-readiness. Query params: batchId (required), minRows (default 30) =
// threshold below which a done SKU counts as low-yield, stuckMinutes
// (default 30) = silence after which an in-flight batch is considered stalled.
// status: 'READY' | 'REVIEW' | 'IN_PROGRESS' | 'STUCK' | 'EMPTY'
function readiness({ res, url, ctx }) {
  const { Q, send } = ctx;
  const batchId = url.searchParams.get('batchId') || '';
  if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
  const minRows      = Math.max(0, Number(url.searchParams.get('minRows') || 30));
  const stuckMinutes = Math.max(1, Number(url.searchParams.get('stuckMinutes') || 30));
  const r = Q.batchReadiness.get(batchId);
  if (!r) return send(res, 200, { ok: true, batchId, status: 'EMPTY', reason: 'no jobs found for this batch', metrics: { total: 0 }, low_yield_skus: [] });

  const total      = Number(r.total || 0);
  const pending    = Number(r.pending || 0);
  const claimed    = Number(r.claimed || 0);
  const done       = Number(r.done || 0);
  const failed     = Number(r.failed || 0);
  const done_empty = Number(r.done_empty || 0);
  const total_rows = Number(r.total_rows || 0);

  const lowYieldRows = Q.lowYieldDoneJobs.all(batchId, minRows);
  const low_yield = lowYieldRows.length;
  const avg_rows_per_done = done > 0 ? Math.round(total_rows / done) : 0;
  // Stall detection from activity_log.ts (ISO-8601 UTC). Never seen → Infinity.
  const lastActivityMs = r.last_activity_iso ? Date.parse(r.last_activity_iso) : 0;
  const stall_minutes = lastActivityMs > 0 ? Math.round((Date.now() - lastActivityMs) / 60000) : Infinity;

  let status, reason;
  if (total === 0) {
    status = 'EMPTY'; reason = 'no jobs in this batch';
  } else if (pending > 0 || claimed > 0) {
    if (stall_minutes > stuckMinutes && Number.isFinite(stall_minutes)) {
      status = 'STUCK';
      reason = `${claimed + pending} SKU(s) not done; no activity for ${stall_minutes} min. Workers may have died or KP session expired.`;
    } else {
      status = 'IN_PROGRESS';
      reason = `${claimed} in-flight, ${pending} pending${done > 0 ? `, ${done} done so far` : ''}`;
    }
  } else if (failed > 0 || done_empty > 0 || low_yield > 0) {
    const issues = [];
    if (failed > 0)     issues.push(`${failed} failed`);
    if (done_empty > 0) issues.push(`${done_empty} done-empty (0 rows)`);
    if (low_yield > 0)  issues.push(`${low_yield} low-yield (< ${minRows} rows)`);
    status = 'REVIEW';
    reason = `all SKUs settled but needs eyes: ${issues.join(', ')}. Requeue or accept as-is.`;
  } else {
    status = 'READY';
    reason = `${done}/${total} SKUs done · ${total_rows.toLocaleString()} rows (avg ${avg_rows_per_done}/SKU) · no failed / no low-yield · ready to ship`;
  }

  return send(res, 200, {
    ok: true, batchId, status, reason,
    metrics: {
      total, pending, claimed, done, failed, done_empty,
      total_rows, low_yield, avg_rows_per_done,
      stall_minutes: Number.isFinite(stall_minutes) ? stall_minutes : null,
    },
    low_yield_skus: lowYieldRows,
  });
}

// Projected finish time from the recent row-landing rate:
//   · rows in the last SHORT window (default 5 min)  → recent rate
//   · rows in the last LONG window  (default 30 min) → baseline rate
//   · the two compared                               → trend
//   · remaining jobs x avg rows/SKU-so-far           → rows remaining
//   · rows remaining / rate                          → ETA minutes
// Returns a null ETA plus a `reason` when it can't project.
function eta({ res, url, ctx }) {
  const { Q, send, now } = ctx;
  const batchId = url.searchParams.get('batchId') || '';
  if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
  const shortWinMin = Math.max(1, Number(url.searchParams.get('shortWindowMin') || 5));
  const longWinMin  = Math.max(shortWinMin, Number(url.searchParams.get('longWindowMin') || 30));
  const nowTs = now();
  const shortN = Number(Q.keywordsRateBatch.get(batchId, nowTs - shortWinMin * 60000)?.n || 0);
  const longN  = Number(Q.keywordsRateBatch.get(batchId, nowTs - longWinMin  * 60000)?.n || 0);
  const shortRate = shortN / shortWinMin;   // rows/min
  const longRate  = longN  / longWinMin;    // rows/min
  // Prefer the short rate (matches current pace); fall back to long if idle.
  const activeRate = shortRate > 0 ? shortRate : longRate;

  // Reuse the readiness aggregate rather than duplicating the job counters.
  const rd = Q.batchReadiness.get(batchId);
  if (!rd) return send(res, 200, { ok: true, batchId, eta_minutes: null, reason: 'no jobs found', metrics: {} });
  const total     = Number(rd.total || 0);
  const done      = Number(rd.done || 0);
  const pending   = Number(rd.pending || 0);
  const claimed   = Number(rd.claimed || 0);
  const totalRows = Number(rd.total_rows || 0);
  const remainingSkus  = pending + claimed;
  const avgRowsPerDone = done > 0 ? Math.round(totalRows / done) : null;

  let trend = 'unknown';
  if (longRate > 0) {
    const delta = (shortRate - longRate) / longRate;
    trend = delta > 0.20 ? 'accelerating' : delta < -0.20 ? 'decelerating' : 'stable';
  }

  let eta_minutes = null, reason = null;
  if (remainingSkus === 0) {
    eta_minutes = 0;
    reason = 'all SKUs settled';
  } else if (activeRate <= 0) {
    reason = shortN === 0 && longN === 0
      ? `no rows landed in the last ${longWinMin} min — workers may be running but haven't produced anything yet (or the extension hasn't been reloaded to pick up the batch_id fix)`
      : `throughput too low to project`;
  } else if (avgRowsPerDone == null || avgRowsPerDone === 0) {
    reason = 'no done SKUs yet, cannot estimate rows-per-SKU';
  } else {
    eta_minutes = Math.round((remainingSkus * avgRowsPerDone) / activeRate);
  }

  return send(res, 200, {
    ok: true, batchId, eta_minutes, reason,
    eta_at: eta_minutes != null ? nowTs + eta_minutes * 60000 : null,
    metrics: {
      total, done, pending, claimed, remaining_skus: remainingSkus,
      total_rows: totalRows,
      avg_rows_per_done_sku: avgRowsPerDone,
      short_window_min: shortWinMin,
      long_window_min:  longWinMin,
      rows_last_short_min: shortN,
      rows_last_long_min:  longN,
      short_rate_per_min: Math.round(shortRate * 10) / 10,
      long_rate_per_min:  Math.round(longRate  * 10) / 10,
      trend,
    },
  });
}

function register(router) {
  router.get('/api/batches/readiness', readiness);
  router.get('/api/batches/eta',       eta);
}

module.exports = { register };
