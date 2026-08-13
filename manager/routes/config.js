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

// ---- Multi-account Keyword Planner --------------------------------------
//
// One KP URL cannot serve a fleet using several Google Ads accounts: the URL
// pins an account via `authuser` and `ocid`, and pointing a worker at an
// account its Chrome profile isn't signed into produces Google's account
// chooser — on which kp.js cannot run at all (see explainKpLandingPage).
//
// So config may carry a LIST instead:
//   kp_accounts:    [{ id, label, url }, ...]
//   kp_assignments: { "PC-1A2B3C": "acct-id", ... }   // optional, explicit
//
// Resolution order for a worker: explicit assignment, else a stable
// distribution across the accounts. `kp_url` remains the single-account
// setting and is used whenever kp_accounts is absent, so existing installs
// are unaffected.
//
// Assignment MUST be sticky per worker. A Google Ads session lives in that
// worker's Chrome profile, so a worker that switched accounts between runs
// would hit the chooser every time it moved.
//
// Uses RENDEZVOUS hashing (highest random weight), not `hash(workerId) % n`.
// With modulo, adding a third account reshuffled 133 of 200 workers —
// measured — because every worker's index changes when n changes. Each move
// means a worker pointed at an Ads account its Chrome profile isn't signed
// into, i.e. an account chooser and a dead SKU. Rendezvous moves only the
// workers the new account actually wins: ~1/n, the minimum possible.
// FNV-1a plus a murmur3 finalizer. The finalizer is not optional: the keys
// here differ by a single character ("PC-x|acct-1" vs "PC-x|acct-2"), and
// raw FNV leaves that difference concentrated in the low bits. Comparing
// such values picked one account far more often than the others — measured
// 155/294/151 across three accounts, i.e. one Google Ads account taking
// double the load (and double the bot-detection risk) while another idled.
// The avalanche step spreads a one-bit input change across the whole word.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

function pickAccount(workerId, accounts) {
  let best = accounts[0], bestScore = -1;
  for (const a of accounts) {
    const score = hashStr(`${workerId}|${a.id || a.url}`);
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}

function resolveKpForWorker(cfg, workerId) {
  const accounts = Array.isArray(cfg?.kp_accounts)
    ? cfg.kp_accounts.filter(a => a && a.url)
    : [];
  if (accounts.length === 0) return { url: cfg?.kp_url || '', account: null, reason: 'single kp_url' };
  if (workerId) {
    const pinnedId = cfg?.kp_assignments?.[workerId];
    if (pinnedId) {
      const hit = accounts.find(a => a.id === pinnedId);
      if (hit) return { url: hit.url, account: hit, reason: 'explicit assignment' };
      // Pinned to an account that no longer exists. Do NOT silently pick a
      // different one — see below; fall through to the safe default.
    }
    // Auto-distribution is OPT-IN, and deliberately so.
    //
    // A KP URL is only usable by a worker whose Chrome profile is signed
    // into the Google login that owns that ocid. Observed directly: two
    // configured accounts (ocid 8431942470 and 8258883732) belong to
    // DIFFERENT Google logins, and a worker signed into the first was sent
    // to the second — Google answered with an account chooser, on which
    // kp.js cannot run, so the SKU died. Spreading accounts across the
    // fleet by hash would do that to most workers.
    //
    // Auto-assign is therefore only correct when every worker profile is
    // signed into every account (multi-login profiles, distinct authuser
    // per URL). Until an operator asserts that with kp_auto_assign, an
    // unpinned worker gets the single global kp_url, which is the setting
    // that was already known to work.
    if (cfg?.kp_auto_assign === true) {
      const pick = pickAccount(workerId, accounts);
      return { url: pick.url, account: pick, reason: 'auto-assignment (kp_auto_assign)' };
    }
    return {
      url: cfg?.kp_url || '',
      account: null,
      reason: 'unpinned worker — using global kp_url (set kp_assignments, or kp_auto_assign if every profile is signed into every account)',
    };
  }
  // No worker id (dashboard reading config): don't pretend to resolve.
  return { url: cfg?.kp_url || accounts[0].url, account: null, reason: 'no workerId supplied' };
}

function getConfig({ res, url, ctx }) {
  const { Q, send } = ctx;
  const row = Q.getConfig.get();
  const cfg = row?.config ? JSON.parse(row.config) : {};
  // A worker asks with ?workerId= and gets kp_url already resolved to ITS
  // account, so nothing downstream needs to know accounts exist.
  const workerId = (url?.searchParams?.get('workerId') || '').trim();
  const resolved = resolveKpForWorker(cfg, workerId);
  const outCfg = { ...cfg };
  if (workerId) {
    outCfg.kp_url = resolved.url;
    outCfg.kp_account_id    = resolved.account?.id    || null;
    outCfg.kp_account_label = resolved.account?.label || null;
    // kp_accounts feeds the OTHER thing that reads this config: the
    // fallback ladder in keyword-discovery.js (kpCandidates), which is
    // walked on ANY KP failure regardless of resolved.reason above. That
    // ladder had no idea an account was pinned to somebody else, so it
    // still handed every worker every account in the fleet -- including
    // ones explicitly pinned (kp_assignments) to a DIFFERENT worker's
    // Chrome profile. Trying such an account can only land on Google's
    // account chooser, which kp.js cannot get past; observed live, workers
    // with no claim on acct-8258883732 walked into it anyway through this
    // exact list and burned hours fleet-wide hitting the chooser. Strip
    // accounts pinned to someone else; keep this worker's own pin (if any)
    // and any account nobody has claimed, since those stay legitimate
    // auto-discovery candidates for an unassigned worker.
    if (Array.isArray(outCfg.kp_accounts)) {
      const pinnedElsewhere = new Set(
        Object.entries(cfg?.kp_assignments || {})
          .filter(([w, acctId]) => w !== workerId && acctId)
          .map(([, acctId]) => acctId)
      );
      outCfg.kp_accounts = outCfg.kp_accounts.filter(a => a && !pinnedElsewhere.has(a.id));
    }
  }
  return send(res, 200, {
    ok: true,
    config: outCfg,
    active_batch_id: row?.active_batch_id || null,
    kp_resolution: workerId ? resolved.reason : null,
  });
}

async function setConfig({ req, res, ctx }) {
  const { Q, send, readJson } = ctx;
  const b = await readJson(req);
  if (b.config !== undefined) Q.setConfig.run(JSON.stringify(b.config || {}));
  // Reject a body that carries no recognised shape.
  //
  // POSTing {kp_enabled:false} -- the obvious guess -- returned {ok:true} and
  // silently changed nothing, because only `config`, `configPatch` and
  // `activeBatchId` are read. Two settings were "applied" that way and were
  // never actually stored; the run carried on with defaults and looked fine.
  // A write that does nothing must not report success.
  if (!('config' in b) && !('configPatch' in b) && !('activeBatchId' in b)) {
    return send(res, 400, { ok: false,
      error: 'body must contain config, configPatch or activeBatchId — e.g. {"configPatch":{"kp_enabled":false}}' });
  }
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
