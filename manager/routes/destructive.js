// Destructive endpoints — deletes across jobs / keywords / activity / etc.
// All require an explicit confirm token in the body so accidental curl'ing
// doesn't wipe production state. Grouped here so the dangerous surface
// area is easy to find and audit in one place.
'use strict';

async function deleteBatch({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  const batchId = String(b.batchId || '').trim();
  if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
  let j = 0, k = 0, a = 0;
  db.exec('BEGIN');
  try {
    j = Q.deleteBatchJobs.run(batchId).changes;
    k = Q.deleteBatchKeywords.run(batchId).changes;
    a = Q.deleteBatchActivity.run(batchId).changes;
    // If the deleted batch was pinned, unpin so workers stop trying to claim it.
    const cfgRow = Q.getConfig.get();
    if (cfgRow?.active_batch_id === batchId) Q.setActiveBatch.run(null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return send(res, 200, { ok: true, batchId, deletedJobs: j, deletedKeywords: k, deletedActivity: a });
}

async function wipeSelective({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  if (b.confirm !== 'WIPE') return send(res, 400, { ok: false, error: "safety: send {confirm:'WIPE'} to proceed" });
  const flags = b.flags || {};
  const batchId = (b.batchId && String(b.batchId).trim()) || null;
  let dJobs = 0, dKw = 0, dAct = 0, dCmd = 0, dWrk = 0, dFail = 0, dOrph = 0;
  db.exec('BEGIN');
  try {
    // failedJobsOnly wins over the 'jobs' flag (it's a narrower delete).
    if (flags.failedJobsOnly) {
      const stmt = batchId
        ? db.prepare(`DELETE FROM jobs WHERE status='failed' AND batch_id=?`)
        : db.prepare(`DELETE FROM jobs WHERE status='failed'`);
      dFail = (batchId ? stmt.run(batchId) : stmt.run()).changes;
    } else if (flags.jobs) {
      dJobs = batchId ? Q.deleteBatchJobs.run(batchId).changes : Q.wipeJobs.run().changes;
    }
    if (flags.keywords) dKw  = batchId ? Q.deleteBatchKeywords.run(batchId).changes : Q.wipeKeywords.run().changes;
    if (flags.activity) dAct = batchId ? Q.deleteBatchActivity.run(batchId).changes : Q.wipeActivity.run().changes;
    // Global-only flags — batchId doesn't apply.
    if (flags.commands)     dCmd  = Q.wipeCommands.run().changes;
    if (flags.workers)      dWrk  = Q.wipeWorkersRoster.run().changes;
    if (flags.orphansOnly)  dOrph = Q.deleteOrphanKeywords.run().changes;
    // Unpin active batch ONLY if we actually deleted the pinned batch's
    // full job set. failedJobsOnly=true short-circuits above and leaves
    // pending/claimed/done intact — we must NOT unpin in that case
    // (workers would abandon the batch on next poll). Guard on dJobs.
    if (flags.jobs && !flags.failedJobsOnly && dJobs > 0) {
      const cfgRow = Q.getConfig.get();
      if (batchId && cfgRow?.active_batch_id === batchId) Q.setActiveBatch.run(null);
      if (!batchId) Q.setActiveBatch.run(null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return send(res, 200, {
    ok: true, batchId,
    deletedJobs: dJobs, deletedKeywords: dKw, deletedActivity: dAct,
    deletedCommands: dCmd, deletedWorkers: dWrk,
    deletedFailedJobs: dFail, deletedOrphans: dOrph,
  });
}

async function resetAll({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  if (b.confirm !== 'RESET') return send(res, 400, { ok: false, error: "safety: send {confirm:'RESET'} to proceed" });
  let j = 0, k = 0, a = 0, c = 0, w = 0;
  db.exec('BEGIN');
  try {
    j = Q.wipeJobs.run().changes;
    k = Q.wipeKeywords.run().changes;
    a = Q.wipeActivity.run().changes;
    c = Q.wipeCommands.run().changes;
    w = Q.wipeWorkersRoster.run().changes;
    // Unpin any pinned batch — it no longer exists.
    Q.setActiveBatch.run(null);
    // Broadcast a reset_local command so every worker clears its
    // chrome.storage (stale batch IDs, claimed job IDs, done-products
    // list, in-memory report). Without this, workers keep trying to
    // heartbeat non-existent jobs after a reset. Broadcast = worker_id
    // NULL; every worker sees it on its next 30s command poll.
    Q.insertCommand.run(null, 'reset_local', null, 'manager-reset-all');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return send(res, 200, { ok: true, deletedJobs: j, deletedKeywords: k, deletedActivity: a, deletedCommands: c, deletedWorkers: w });
}

async function cleanup({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const a = Q.cleanupActivity.run(now() - (b.logDays ?? 7) * 86400000);
  const c = Q.cleanupCommands.run(now() - (b.commandsDays ?? 1) * 86400000);
  return send(res, 200, { ok: true, activityLog: a.changes, ackedCommands: c.changes });
}

function register(router) {
  router.post('/api/jobs/delete-batch', deleteBatch);
  router.post('/api/wipe-selective',    wipeSelective);
  router.post('/api/reset-all',         resetAll);
  router.post('/api/cleanup',           cleanup);
}

module.exports = { register };
