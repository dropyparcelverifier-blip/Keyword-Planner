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

// Fleet update = graceful_reload now, hard_reset shortly after.
//
// The escalation used to be a setTimeout in the dashboard page, which meant
// it was lost whenever the operator closed the tab, navigated away, or
// Chrome throttled the backgrounded tab. Step 1 alone is not enough: a
// worker with a SKU in flight DEFERS a graceful reload until that SKU
// finishes, and a SKU stuck in a KP retry loop can run for ten minutes or
// more. So clicking the button repeatedly appeared to do nothing — every
// click queued another deferral, and the one command that would actually
// force the issue depended on a browser timer surviving.
//
// Running the escalation here means once the request is accepted, the
// hard_reset WILL be sent, whatever the operator's browser does next.
const ESCALATE_AFTER_MS = 30 * 1000;

async function updateAll({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const workerId = b.workerId || null;              // null = broadcast
  const by = b.createdBy || 'fleet-update';
  Q.insertCommand.run(workerId, 'graceful_reload', null, by);
  const timer = setTimeout(() => {
    try { Q.insertCommand.run(workerId, 'hard_reset', null, `${by}-escalation`); }
    catch (e) { console.error('[manager] fleet-update escalation failed:', e.message); }
  }, ESCALATE_AFTER_MS);
  // Don't hold the event loop open on shutdown for a pending escalation.
  if (typeof timer.unref === 'function') timer.unref();
  return send(res, 200, {
    ok: true,
    step1: 'graceful_reload',
    step2: 'hard_reset',
    escalates_in_ms: ESCALATE_AFTER_MS,
    target: workerId || 'all workers',
  });
}

function register(router) {
  router.post('/api/commands',            insertCommand);
  router.get ('/api/commands',            listPending);
  router.post('/api/commands/ack',        ackCommands);
  router.post('/api/commands/update-all', updateAll);
}

module.exports = { register };
