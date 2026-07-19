// Worker config storage. Single-row config table; extension push/pulls
// this to keep Shopify creds, KP URL, engine flags synced across all
// worker PCs. Also stores the 'active batch id' (which batch new claims
// pull from) so operators can pin work.
//
// POST is dual-mode:
//   - {config: {...}}       — replace whole blob
//   - {configPatch: {...}}  — merge into current (null values delete)
// {activeBatchId: '...' | null} works alongside either shape.
'use strict';

function getConfig({ res, ctx }) {
  const { Q, send } = ctx;
  const row = Q.getConfig.get();
  return send(res, 200, {
    ok: true,
    config: row?.config ? JSON.parse(row.config) : {},
    active_batch_id: row?.active_batch_id || null,
  });
}

async function setConfig({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  if (b.config !== undefined) Q.setConfig.run(JSON.stringify(b.config || {}));
  if (b.configPatch && typeof b.configPatch === 'object') {
    const cur = Q.getConfig.get();
    const merged = { ...(cur?.config ? JSON.parse(cur.config) : {}) };
    for (const [k, v] of Object.entries(b.configPatch)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    Q.setConfig.run(JSON.stringify(merged));
  }
  if ('activeBatchId' in b) Q.setActiveBatch.run(b.activeBatchId || null);
  return send(res, 200, { ok: true });
}

function register(router) {
  router.get ('/api/config', getConfig);
  router.post('/api/config', setConfig);
}

module.exports = { register };
