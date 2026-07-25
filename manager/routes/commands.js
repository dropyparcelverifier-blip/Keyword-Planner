// Manager -> worker command bus. Workers poll GET /api/commands on a
// 30s alarm, execute anything targeted at them (or broadcast — worker_id
// NULL), then POST /api/commands/ack with the ids they consumed.
// Commands live in a small table; ack sets ack_ts + ack_worker_id so the
// same command isn't handed out again.
'use strict';

async function insertCommand({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  Q.insertCommand.run(
    b.workerId || null,
    String(b.command || ''),
    b.payload ? JSON.stringify(b.payload) : null,
    b.createdBy || null,
  );
  return send(res, 200, { ok: true });
}

function listPending({ res, url, ctx }) {
  const { Q, send } = ctx;
  // Two args to pendingCommands: worker_id and broadcast-TTL cutoff.
  // Broadcast commands (worker_id NULL) stay pending for all workers
  // within a 10-min window from created_at. Fixes the bug where the
  // first worker to ack consumed the broadcast for everyone else.
  const workerId = url.searchParams.get('workerId') || '';
  const broadcastTtlCutoff = Date.now() - 10 * 60 * 1000;
  const rows = Q.pendingCommands.all(workerId, broadcastTtlCutoff).map(c => ({
    ...c,
    payload: c.payload ? JSON.parse(c.payload) : null,
  }));
  return send(res, 200, { ok: true, commands: rows });
}

async function ackCommands({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const workerId = b.workerId || null;
  for (const id of (Array.isArray(b.ids) ? b.ids : [])) {
    // Legacy ack (only fires if global acknowledged_at was still NULL —
    // preserved for backward compat + first-worker-to-ack telemetry).
    Q.ackCommand.run(now(), workerId, id);
    // Per-worker ack — this is the authoritative record now. Prevents
    // the same broadcast being handed to the same worker twice.
    if (workerId) Q.ackCommandPerWorker.run(id, workerId, now());
  }
  return send(res, 200, { ok: true });
}

function register(router) {
  router.post('/api/commands',     insertCommand);
  router.get ('/api/commands',     listPending);
  router.post('/api/commands/ack', ackCommands);
}

module.exports = { register };
