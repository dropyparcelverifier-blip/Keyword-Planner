// Worker roster + fleet control.
//
// The `workers` table is the roster of every extension that has ever
// checked in. It is deliberately separate from job claims: a worker that is
// armed but idle (heartbeating, never claimed) still has to show as online
// in the dashboard, and job-derived stats can't see it.
//
// Wake-on-LAN lives here too. It only works when manager and worker share a
// physical LAN — WOL is a Layer 2 broadcast and Tailscale does not tunnel
// it. Across subnets the packet is sent and silently goes nowhere.
'use strict';

// Heartbeat — every 30s from every worker, whether or not it holds work.
// This is the highest-frequency write in the system.
async function heartbeat({ req, res, ctx }) {
  const { Q, send, readJson, now, currentWorkerBundleHash } = ctx;
  const b = await readJson(req);
  const wid = String(b.workerId || '').trim();
  if (!wid) return send(res, 400, { ok: false, error: 'workerId required' });
  const t = now();
  // MAC + hostname arrive only from workers whose installer captured them
  // (post-WOL feature). Fall back to the bare upsert if absent so older
  // workers keep working.
  const mac  = String(b.mac || '').trim();
  const host = String(b.hostname || '').trim();
  if (mac || host) Q.upsertWorkerFull.run(wid, t, t, mac, host);
  else             Q.upsertWorker.run(wid, t, t);
  // Extension version reporting — the worker sends the hash it computed at
  // cold start from /api/worker/version-hash. Persisting it lets the Fleet
  // UI flag out-of-date installs when the manager's hash has moved on.
  const vhash = String(b.versionHash || '').trim();
  if (vhash) Q.setWorkerVersion.run(vhash, t, wid);
  // Echo the CURRENT bundle hash so the worker can notice it is stale
  // without a second round trip.
  return send(res, 200, { ok: true, current_bundle_hash: currentWorkerBundleHash() });
}

async function wol({ req, res, ctx }) {
  const { Q, send, readJson, sendWolPacket } = ctx;
  const b = await readJson(req);
  const wid = String(b.workerId || '').trim();
  let mac = String(b.mac || '').trim();
  if (!mac && wid) {
    const w = Q.getWorker.get(wid);
    if (w?.mac_address) mac = w.mac_address;
  }
  if (!mac) return send(res, 400, { ok: false, error: 'no MAC available for this worker — install the extension with the current installer so it captures the MAC, or POST {mac: "AA:BB:CC:DD:EE:FF"}' });
  const r = await sendWolPacket(mac);
  if (!r.ok) {
    // Invalid MAC = 400 (client error); anything else = 500 (our side).
    const code = /invalid MAC/i.test(r.error) ? 400 : 500;
    return send(res, code, r);
  }
  return send(res, 200, r);
}

// Manually store a MAC, for workers installed before auto-capture existed.
async function setMac({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const wid = String(b.workerId || '').trim();
  const mac = String(b.mac || '').trim();
  if (!wid || !mac) return send(res, 400, { ok: false, error: 'workerId + mac required' });
  const cleaned = mac.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length !== 12) return send(res, 400, { ok: false, error: 'MAC must be 12 hex chars' });
  // Preserve the existing hostname if we already have one.
  const cur = Q.getWorker.get(wid);
  Q.upsertWorkerFull.run(wid, cur?.first_seen || now(), cur?.last_seen || now(), cleaned, cur?.hostname || '');
  return send(res, 200, { ok: true, mac: cleaned });
}

function list({ res, ctx }) {
  const { Q, send, currentWorkerBundleHash } = ctx;
  const currentHash = currentWorkerBundleHash();
  // Grace window: a hash mismatch reported < 3 min ago is almost always the
  // manager having just pushed a new commit, with the worker not yet
  // through its 2-min refresh. Suppressing the badge during that window
  // avoids a false 'update me' call-to-action right after every deploy.
  // Real outdated workers (no fresh hash in > 3 min, still mismatched)
  // still show.
  const nowMs = Date.now();
  const GRACE_MS = 3 * 60 * 1000;
  const workers = Q.listWorkers.all().map(w => {
    const reportedAt   = Number(w.version_reported_at || 0);
    const hashMismatch = w.version_hash != null && w.version_hash !== currentHash;
    const withinGrace  = reportedAt > 0 && (nowMs - reportedAt) < GRACE_MS;
    // outdated → the user-visible badge (grace-suppressed).
    // hash_mismatch → the underlying truth, for tests and diagnostics.
    return { ...w, current_bundle_hash: currentHash, hash_mismatch: hashMismatch, outdated: hashMismatch && !withinGrace };
  });
  return send(res, 200, { ok: true, workers, current_bundle_hash: currentHash });
}

// Ghost-worker cleanup — a Chrome reload used to mint a new workerId,
// leaving the old one stuck in the fleet display.
async function remove({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  const wId = String(b.workerId || '').trim();
  if (!wId) return send(res, 400, { ok: false, error: 'workerId required' });
  return send(res, 200, { ok: true, deleted: Q.deleteWorker.run(wId).changes });
}

async function pruneStale({ req, res, ctx }) {
  const { Q, send, readJson, now } = ctx;
  const b = await readJson(req);
  const cutoff = now() - Math.max(60, Number(b.olderThanMinutes) || 240) * 60 * 1000;
  return send(res, 200, { ok: true, deleted: Q.deleteStaleWorkers.run(cutoff).changes });
}

// Quiesce — broadcast 'pause' to every worker and return the in-flight
// snapshot so the UI can poll until it reaches zero. Deletes nothing; this
// only tells workers to stop claiming.
function quiesce({ res, ctx }) {
  const { Q, send, now } = ctx;
  Q.insertCommand.run(null, 'pause', null, 'manager-quiesce');
  const claimed = Q.claimedNowCount.get();
  const nowT = now();
  const active = Q.listWorkers.all().filter(w => (nowT - Number(w.last_seen)) < 3 * 60 * 1000).length;
  return send(res, 200, { ok: true, activeWorkers: active, claimedNow: claimed?.n || 0 });
}

function register(router) {
  router.post('/api/workers/heartbeat',   heartbeat);
  router.post('/api/workers/wol',         wol);
  router.post('/api/workers/set-mac',     setMac);
  router.get ('/api/workers/list',        list);
  router.post('/api/workers/delete',      remove);
  router.post('/api/workers/prune-stale', pruneStale);
  router.post('/api/workers/quiesce',     quiesce);
}

module.exports = { register };
