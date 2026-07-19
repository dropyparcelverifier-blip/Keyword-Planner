// Activity log endpoints. Every worker append-writes events here; the
// dashboard polls the GET endpoint on a 2s tick and renders them into
// the Activity + Errors cards.
//
// Filters on GET (all optional, ANDed): batchId, workerId, level.
// Bulk-clear on /api/activity/clear supports the same filters plus
// olderThanMs — used by the dashboard's per-card 'clear' buttons.
'use strict';

async function insertActivity({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  for (const e of (Array.isArray(b.events) ? b.events : [b])) {
    if (!e || !e.message) continue;
    Q.insertActivity.run(
      e.batch_id || b.batchId || null,
      e.worker_id || b.workerId || null,
      e.level || 'info',
      e.source || null,
      String(e.message),
      e.product_url || null,
      e.sku || null,
    );
  }
  return send(res, 200, { ok: true });
}

function listActivity({ res, url, ctx }) {
  const { Q, send } = ctx;
  const batchId  = url.searchParams.get('batchId') || null;
  const workerId = (url.searchParams.get('workerId') || '').trim();
  const level    = (url.searchParams.get('level') || '').trim();
  const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '120', 10));
  const rows = workerId
    ? Q.recentActivityWorker.all(batchId, workerId, limit)
    : level
    ? Q.recentActivityLevel.all(batchId, level, limit)
    : Q.recentActivity.all(batchId, limit);
  return send(res, 200, { ok: true, events: rows });
}

async function clearActivity({ req, res, ctx }) {
  const { db, send, readJson, now } = ctx;
  // Empty body allowed = 'nuke every activity row'. Silently swallow
  // parse errors so a curl'd '{}' with wrong content-type still works.
  const b = await readJson(req).catch(() => ({}));
  const conds = [], args = [];
  if (b.level)       { conds.push('level = ?');       args.push(String(b.level)); }
  if (b.workerId)    { conds.push('worker_id = ?');   args.push(String(b.workerId)); }
  if (b.batchId)     { conds.push('batch_id = ?');    args.push(String(b.batchId)); }
  if (Number.isFinite(b.olderThanMs)) { conds.push('ts < ?'); args.push(now() - Number(b.olderThanMs)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const stmt = db.prepare(`DELETE FROM activity_log ${where}`);
  const info = stmt.run(...args);
  return send(res, 200, { ok: true, deleted: info.changes });
}

function register(router) {
  router.post('/api/activity',       insertActivity);
  router.get ('/api/activity',       listActivity);
  router.post('/api/activity/clear', clearActivity);
}

module.exports = { register };
