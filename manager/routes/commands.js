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
  const rows = Q.pendingCommands.all(url.searchParams.get('workerId') || '').map(c => ({
    ...c,
    payload: c.payload ? JSON.parse(c.payload) : null,
  }));
  return send(res, 200, { ok: true, commands: rows });
}

async function ackCommands({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  for (const id of (Array.isArray(b.ids) ? b.ids : [])) {
    Q.ackCommand.run(now(), b.workerId || null, id);
  }
  return send(res, 200, { ok: true });
}

function register(router) {
  router.post('/api/commands',     insertCommand);
  router.get ('/api/commands',     listPending);
  router.post('/api/commands/ack', ackCommands);
}

module.exports = { register };
