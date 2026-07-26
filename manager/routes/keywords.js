// Discovered-keyword results: the actual output of the whole system.
// Workers POST rows here as they finish each product; the dashboard and the
// CSV/XLSX exporters read them back.
//
// Also hosts batch display names, which are a user-editable overlay on the
// opaque timestamp batch_ids — they live with keywords because every reader
// of a batch_id wants the friendly name alongside it.
//
// The orphan-batch guard on POST is load-bearing. A worker that still holds
// a cached queueBatchId after a Reset would otherwise keep writing rows
// whose batch has no jobs, producing "orphan" batches that show in the UI
// but belong to nothing. Rejecting the write forces the worker to resync.
'use strict';

function batches({ res, ctx }) {
  const { Q, send } = ctx;
  return send(res, 200, { ok: true, batches: Q.keywordsBatchList.all() });
}

function batchNames({ res, ctx }) {
  const { Q, send } = ctx;
  return send(res, 200, { ok: true, names: Q.listBatchNames.all() });
}

async function renameBatch({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const bid  = String(b.batchId || '').trim();
  const name = String(b.name || '').trim();
  if (!bid) return send(res, 400, { ok: false, error: 'batchId required' });
  // Empty name clears the overlay and falls back to the raw batch_id.
  if (!name) { Q.deleteBatchName.run(bid); return send(res, 200, { ok: true, cleared: true }); }
  if (name.length > 100) return send(res, 400, { ok: false, error: 'display_name max 100 chars' });
  Q.upsertBatchName.run(bid, name, now());
  return send(res, 200, { ok: true, batchId: bid, name });
}

// Orphan count — keyword rows whose batch_id no longer has any jobs. Cheap
// read, used by the Config-tab cleanup card and the reset preflight to warn
// about work in progress.
function orphans({ res, ctx }) {
  const { Q, send, now } = ctx;
  const r = Q.countOrphanKeywords.get();
  const claimed = Q.claimedNowCount.get();
  const nowT = now();
  const activeWorkerCount = Q.listWorkers.all()
    .filter(w => (nowT - Number(w.last_seen)) < 3 * 60 * 1000).length;
  return send(res, 200, {
    ok: true,
    orphanRows:    r?.n || 0,
    orphanBatches: r?.batches || 0,
    claimedNow:    claimed?.n || 0,
    activeWorkers: activeWorkerCount,
  });
}

// Requires an explicit confirm string so a stray fetch can't destroy data —
// same safety pattern as reset-all.
async function cleanupOrphans({ req, res, ctx }) {
  const { Q, send, readJson, reclaimSpace } = ctx;
  const b = await readJson(req);
  if (b.confirm !== 'CLEAN_ORPHANS') return send(res, 400, { ok: false, error: "safety: send {confirm:'CLEAN_ORPHANS'} to proceed" });
  const info = Q.deleteOrphanKeywords.run();
  if (info.changes > 0) reclaimSpace?.();
  return send(res, 200, { ok: true, deleted: info.changes });
}

// 24h throughput, bucketed per hour. Optional ?batchId= scope.
// NOTE: buckets carry a `n` column (COUNT(*) AS n) — not `count`.
function timeline({ res, url, ctx }) {
  const { Q, send, now } = ctx;
  const since = now() - 24 * 3600 * 1000;
  const bId = url.searchParams.get('batchId') || '';
  const rows = bId ? Q.keywordsPerHourBatch.all(since, bId) : Q.keywordsPerHourAll.all(since);
  return send(res, 200, { ok: true, since, buckets: rows });
}

async function push({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  // Orphan-batch guard — see the module header. batchExists is memoised per
  // request via seenBatches so a 300-row push does one lookup per batch,
  // not one per row.
  const seenBatches = new Set();
  const rejected = [];
  const accepted = [];
  for (const r of rows) {
    const bid = r.batch_id || b.batchId || null;
    if (!bid) { rejected.push({ row: r, reason: 'no_batch_id' }); continue; }
    if (!seenBatches.has(bid)) {
      if (!Q.batchExists.get(bid)) { rejected.push({ row: r, reason: 'orphan_batch' }); continue; }
      seenBatches.add(bid);
    }
    accepted.push(r);
  }
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of accepted) {
      Q.insertKeyword.run(r.batch_id || b.batchId || null, r.sku || null, r.keyword || '', r.product_url || '', JSON.stringify(r));
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // Tell the worker the current active batch so it can self-correct after a
  // rejection — same escape hatch as heartbeat.
  const cfgKw = Q.getConfig.get();
  const pinnedKw = (cfgKw?.active_batch_id || '').trim();
  let activeKw = pinnedKw && Q.batchHasPending.get(pinnedKw) ? pinnedKw : null;
  if (!activeKw) activeKw = Q.newestPendingBatch.get()?.batch_id || null;
  // Rejection alerting — turn silent orphan-batch rejections into visible
  // err-level activity events. Grouped by (reason, batch_id, product_url)
  // so a 339-row push produces one log line, not 339.
  if (rejected.length > 0) {
    const groups = new Map();
    for (const rj of rejected) {
      const b_id = rj.row?.batch_id || b.batchId || '(none)';
      const pu   = rj.row?.product_url || '(unknown)';
      const key  = `${rj.reason}|${b_id}|${pu}`;
      const cur  = groups.get(key) || { reason: rj.reason, batch_id: b_id, product_url: pu, sku: rj.row?.sku || null, count: 0 };
      cur.count++;
      groups.set(key, cur);
    }
    for (const g of groups.values()) {
      const msg = g.reason === 'orphan_batch'
        ? `⛔ ORPHAN-BATCH REJECT: ${g.count} row(s) rejected — worker sent batch_id "${g.batch_id}" which does not exist in this manager's jobs. Manager's active batch is "${activeKw || '(none)'}". Worker should resync via /api/jobs/active-batch.`
        : `⛔ ROW REJECT (${g.reason}): ${g.count} row(s) rejected for product ${g.product_url}`;
      try {
        Q.insertActivity.run(activeKw || g.batch_id || null, null, 'err', 'orphan_guard', msg, g.product_url, g.sku);
      } catch {}
    }
  }
  return send(res, 200, { ok: true, inserted: n, rejected: rejected.length, active_batch_id: activeKw });
}

function read({ res, url, ctx }) {
  const { Q, send } = ctx;
  const batchId = url.searchParams.get('batchId') || '';
  const sinceIdRaw = url.searchParams.get('sinceId');
  const sinceId = sinceIdRaw != null && sinceIdRaw !== '' ? Number(sinceIdRaw) : null;
  const raw = Number.isFinite(sinceId)
    ? Q.keywordsByBatchSince.all(batchId, sinceId)
    : Q.keywordsByBatch.all(batchId);
  const rows = raw.map(r => {
    try { const d = JSON.parse(r.data); if (d && typeof d === 'object') d._id = r.id; return d; }
    catch { return null; }
  }).filter(Boolean);
  // Always return the CURRENT max id for this batch, even when sinceId was
  // set — lets the client advance its cursor on an empty tick.
  const maxRow = Q.keywordsMaxIdByBatch.get(batchId);
  const maxId = Number.isFinite(maxRow?.mx) ? maxRow.mx : (rows.length > 0 ? rows[rows.length - 1]._id : 0);
  return send(res, 200, {
    ok: true,
    total: rows.length,
    rows,
    maxId,
    incremental: Number.isFinite(sinceId),
    sinceId: Number.isFinite(sinceId) ? sinceId : null,
  });
}

function register(router) {
  router.get ('/api/keywords',                 read);
  router.post('/api/keywords',                 push);
  router.get ('/api/keywords/batches',         batches);
  router.get ('/api/keywords/orphans',         orphans);
  router.post('/api/keywords/cleanup-orphans', cleanupOrphans);
  router.get ('/api/keywords/timeline',        timeline);
  router.get ('/api/batches/names',            batchNames);
  router.post('/api/batches/rename',           renameBatch);
}

module.exports = { register };
