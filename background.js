// background.js (module worker)
// Thin onMessage router with persistent accumulated state so a Stop mid-flow
// doesn't lose work, and completed products are skipped on the next Start.

import { runKeywordDiscovery, cleanProductUrl, CAPTCHA_PAUSE_ERROR } from './modules/keyword-discovery.js';
import { toCSV, toXLSX, pushToAdBrain, exportSingleProductCSV } from './modules/discovery-export.js';
import {
  uploadJobsToManager,
  claimJobs,
  heartbeatClaims,
  markJobDone,
  markJobFailed,
  releaseStaleJobs,
  releaseByWorker,
  getJobSummary,
  getActiveWorkers,
  getFailedJobs,
  requeueJob,
  fetchBatchReportFromManager,
  getActiveBatchId,
  pushActivityLog,
  fetchActivityLog,
  fetchWorkerStats,
  fetchPerProductStatus,
  sendWorkerCommand,
  fetchPendingCommands,
  acknowledgeCommand,
  fetchWorkerConfig,
  saveWorkerConfig,
  workerConfigToRunOpts,
  cleanupOldData,
  fetchBatchKeywordStats,
  sendWorkerHeartbeat,
} from './modules/discovery-jobs.js';
import {
  STORAGE_KEY_KP_URL,
} from './config/discovery-config.js';
import {
  STORAGE_KEY_MANAGER_URL,
  STORAGE_KEY_MANAGER_TOKEN,
} from './modules/discovery-jobs.js';
import {
  shouldKeepKeyword,
  categorizeKeyword,
  computeAdRating,
  mergeKeywordIntoReport,
  handlesToSeeds,
  seedsAreSimilar,
  selectKpSeeds,
  buildProductContext,
  isRelevantToProduct,
  isBrandOnlyMatch,
  detectCategory,
  extractFormFactor,
  getWrongFormReason,
  classifyKeyword,
  extractProductSpecs,
  hasConflictingSpec,
  checkProductIdentity,
  hasSpecConfirmation,
  checkProductLineModifier,
  checkCompetitorBrand,
  buildSiblingExclusions,
  checkSiblingProduct,
  checkVariantSlot,
  checkColorConflict,
  checkNameSwap,
  parseQty,
  baseKey,
  checkSiblingAmbiguity,
  extractDiscriminatorTokens,
  checkBrandMate,
  familiesFor,
  computeProductFamilyValues,
  checkAttributeFamily,
} from './modules/keyword-filter.js';
import {
  STORAGE_KEY_LAST_REPORT,
  STORAGE_KEY_LAST_BATCH,
  STORAGE_KEY_LAST_STATUS,
  STORAGE_KEY_DONE_PRODUCTS,
  STORAGE_KEY_LAST_PUSHED_COUNT,
  STORAGE_KEY_LOG,
  STORAGE_KEY_REST_UNTIL,
  STATUS_PAUSED_CAPTCHA,
  LOG_MAX,
} from './config/discovery-config.js';

// Persistent reference to the input list — needed so a Resume button can
// re-invoke runKeywordDiscovery without the user having to re-pick the file.
const STORAGE_KEY_LAST_PRODUCTS = 'adbrainLastProducts';
const STORAGE_KEY_LAST_RUN_OPTS = 'adbrainLastRunOpts';

// "Run intent" — persisted boolean that says "the user wants this run to
// continue if interrupted by a crash, power loss, or service-worker death."
// Set when a run starts/resumes; cleared when the run completes successfully,
// when the user explicitly Stops, or when progress is Reset.
//   - chrome.runtime.onStartup, .onInstalled, and the watchdog alarm all
//     check this flag and auto-resume only if it's true.
//   - Without this flag we'd risk re-launching a run the user intentionally
//     stopped (or never wanted, on a fresh install).
const STORAGE_KEY_RUN_INTENT = 'adbrainRunIntent';

// Distributed-mode persistence.
//   workerId   — this PC's identity ("PC-A" / "Office"); set in Settings.
//   queueBatchId — which batch_id this worker is currently pulling from.
//   claimedJobs — array of {id, productUrl} the engine is currently
//                 processing. Heartbeat alarm refreshes heartbeat_at on
//                 every entry; markJobDone removes the entry on completion.
const STORAGE_KEY_WORKER_ID      = 'adbrainWorkerId';
const STORAGE_KEY_QUEUE_BATCH_ID = 'adbrainQueueBatchId';
const STORAGE_KEY_CLAIMED_JOBS   = 'adbrainClaimedJobs';

// Watchdog alarm name. MV3 service workers can be torn down after ~30s idle
// even mid-run; an alarm wakes the worker back up so we can detect "we
// should be running but aren't" and re-enter handleStart().
const WATCHDOG_ALARM = 'adbrain-watchdog';
// Heartbeat alarm — every 60s while distributed mode is running, refresh
// heartbeat_at on this worker's claimed jobs. Without this, other PCs
// would treat the rows as stale (>10min) and steal them.
const HEARTBEAT_ALARM = 'adbrain-heartbeat';

const state = {
  running: false,
  stopRequested: false,
  report: [],
  batchId: null,
  lastStatus: 'Idle',
  doneProducts: [],
  lastPushedCount: 0,
  log: [],   // ring buffer of { ts, text, kind } — persists across SW shutdowns
  // Resume state — survives popup close, SW shutdown, browser restart.
  lastProducts: [],     // last input file's parsed products
  lastRunOpts: null,    // last run's options (cap, pacing, threshold, etc.)
  restUntil: 0,         // chunk-rest deadline (ms); 0 if not resting
  pausedByCaptcha: false, // last run hit a verification check
  runIntent: false,     // user wants this run to continue across restarts
  // Watchdog no-progress tracking — when a resume attempt doesn't advance
  // doneProducts.length, increment. After 3 consecutive failed attempts,
  // assume the engine is stuck (most commonly: global keyword cap reached
  // before all products processed) and stop auto-resuming. The user can
  // press Resume manually to override.
  lastResumeDoneCount: -1,
  consecutiveNoProgressResumes: 0,
  // Re-entry guards. `running` flips to true AFTER several awaits inside
  // handleStart — leaving a window where a second caller could pass the
  // initial guard and spawn a parallel engine. `starting` is set SYNC at
  // the entry to handleStart so the second caller bounces immediately.
  // `resumeInFlight` is a Promise that tryAutoResume sets while it owns a
  // resume cycle; concurrent tryAutoResume calls await/skip it.
  starting: false,
  resumeInFlight: null,
  // Distributed mode — this worker's identity, the batch it's pulling from,
  // and the list of claimed job rows (one entry per in-flight product).
  // Empty array / null = local mode (file-driven), no the manager coordination.
  workerId: '',
  queueBatchId: '',
  claimedJobs: [],
  // KP session-dead detection: after 2 consecutive per-product KP failures,
  // we conclude the KP tab / Google Ads session is dead for this worker.
  // Rather than burn through 25 more claims returning 0-row DONE products,
  // release the current chunk back to the queue and stop claiming for a
  // 5-minute cooldown. Reset on any successful KP fetch — a transient
  // outage (rate limit, brief network blip) doesn't trigger the block.
  consecutiveKpFailures: 0,
  kpDeadUntil: 0,
  // Continuous-claim mode: when true, after the engine finishes processing
  // a claimed chunk, the worker AUTOMATICALLY claims the next chunk from
  // the same batch (or the newest pending batch if queueBatchId is empty).
  // Loops until the queue is empty or the user clicks Stop. Set by the
  // worker UI's "Connect & start working" button.
  continuousClaim: false,
  continuousChunkSize: 5,
  // workerArmed: persistent flag set when the worker clicks "Connect &
  // start working" for the FIRST time on this PC. Once armed, the worker
  // keeps polling the queue every 30s — claiming and processing new
  // batches the moment the manager uploads them. No more "manager
  // uploaded but workers don't move until someone clicks Connect again."
  // Cleared by Stop (user explicitly opted out). Survives engine
  // completion, browser restart, and SW death.
  workerArmed: false,
  // userStoppedArm: set true when the user explicitly clicks Stop on
  // this PC. Honored by the Wake command — manager broadcast wake
  // doesn't re-arm a PC that the local user has explicitly stopped.
  // Cleared on autoConnect (user explicitly armed it again).
  userStoppedArm: false,
  // Connection-health snapshot. Populated by pingConnectionHealth (every
  // 60s alarm + on demand). The popup + dashboard show this so the user
  // knows whether the manager is reachable from THIS PC. ok=false = creds
  // wrong, network down, schema cache stale, etc. — anything that would
  // make the queue + auto-push fail silently.
  connectionHealth: {
    ok: null,           // null = never checked
    latencyMs: null,
    lastCheckedAt: null,
    error: null,
  },
};

// Side panel: clicking the extension icon opens the panel (Chrome 114+).
// Side panel stays open as you switch tabs, unlike a popup which closes on
// blur — this is what the user wants for a long-running discovery run.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch(() => {});
} catch {}

// MV3 service workers can shut down after ~30s idle. Reopening the popup wakes
// them up, but state-rehydration is async — we must NOT answer getState until
// it's finished or we'll send empty state to the popup and look "closed".
// We expose `coldStart` as a Promise every handler awaits.
const coldStart = (async () => {
  const data = await chrome.storage.local.get([
    STORAGE_KEY_LAST_REPORT,
    STORAGE_KEY_LAST_BATCH,
    STORAGE_KEY_LAST_STATUS,
    STORAGE_KEY_DONE_PRODUCTS,
    STORAGE_KEY_LAST_PUSHED_COUNT,
    STORAGE_KEY_LOG,
    STORAGE_KEY_REST_UNTIL,
    STORAGE_KEY_LAST_PRODUCTS,
    STORAGE_KEY_LAST_RUN_OPTS,
    STORAGE_KEY_RUN_INTENT,
    STORAGE_KEY_WORKER_ID,
    STORAGE_KEY_QUEUE_BATCH_ID,
    STORAGE_KEY_CLAIMED_JOBS,
    'adbrainContinuousClaim',
    'adbrainContinuousChunkSize',
    'adbrainActivityBuffer',
    'adbrainPendingPushes',
    'adbrainWorkerArmed',
    'adbrainUserStoppedArm',
  ]);
  // Restore activity buffer from before SW death so we don't lose recent
  // events that hadn't been pushed to the manager yet.
  if (Array.isArray(data.adbrainActivityBuffer)) {
    _activityBuffer.push(...data.adbrainActivityBuffer);
  }
  // Restore pending-push queue so SW death mid-push doesn't lose data.
  // Re-trying on cold start is essential for the "batch shows done but
  // no data in the manager" bug class.
  if (Array.isArray(data[PENDING_PUSH_STORAGE_KEY])) {
    _pendingPushes.push(...data[PENDING_PUSH_STORAGE_KEY]);
    if (_pendingPushes.length > 0) {
      pushLog(`Restored ${_pendingPushes.length} pending push(es) from previous session — will retry`, 'ok');
    }
  }
  if (typeof data[STORAGE_KEY_WORKER_ID] === 'string')      state.workerId = data[STORAGE_KEY_WORKER_ID];
  if (typeof data[STORAGE_KEY_QUEUE_BATCH_ID] === 'string') state.queueBatchId = data[STORAGE_KEY_QUEUE_BATCH_ID];
  if (Array.isArray(data[STORAGE_KEY_CLAIMED_JOBS]))         state.claimedJobs = data[STORAGE_KEY_CLAIMED_JOBS];
  if (typeof data.adbrainContinuousClaim === 'boolean')      state.continuousClaim = data.adbrainContinuousClaim;
  if (typeof data.adbrainContinuousChunkSize === 'number')   state.continuousChunkSize = data.adbrainContinuousChunkSize;
  if (typeof data.adbrainWorkerArmed === 'boolean')          state.workerArmed = data.adbrainWorkerArmed;
  if (typeof data.adbrainUserStoppedArm === 'boolean')       state.userStoppedArm = data.adbrainUserStoppedArm;
  if (Array.isArray(data[STORAGE_KEY_LAST_REPORT]))   state.report = data[STORAGE_KEY_LAST_REPORT];
  if (data[STORAGE_KEY_LAST_BATCH])                   state.batchId = data[STORAGE_KEY_LAST_BATCH];
  if (data[STORAGE_KEY_LAST_STATUS])                  state.lastStatus = data[STORAGE_KEY_LAST_STATUS];
  if (Array.isArray(data[STORAGE_KEY_DONE_PRODUCTS])) state.doneProducts = data[STORAGE_KEY_DONE_PRODUCTS];
  if (typeof data[STORAGE_KEY_LAST_PUSHED_COUNT] === 'number') state.lastPushedCount = data[STORAGE_KEY_LAST_PUSHED_COUNT];
  if (Array.isArray(data[STORAGE_KEY_LOG]))           state.log = data[STORAGE_KEY_LOG];
  if (typeof data[STORAGE_KEY_REST_UNTIL] === 'number') state.restUntil = data[STORAGE_KEY_REST_UNTIL];
  if (Array.isArray(data[STORAGE_KEY_LAST_PRODUCTS])) state.lastProducts = data[STORAGE_KEY_LAST_PRODUCTS];
  if (data[STORAGE_KEY_LAST_RUN_OPTS])                state.lastRunOpts = data[STORAGE_KEY_LAST_RUN_OPTS];
  state.runIntent = !!data[STORAGE_KEY_RUN_INTENT];
  // Detect paused-captcha from the last persisted status.
  state.pausedByCaptcha = (state.lastStatus || '').startsWith(STATUS_PAUSED_CAPTCHA);

  // Installer auto-arm: the manager's PowerShell installer drops a
  // worker-config.json next to the extension files. If we haven't been
  // configured yet (storage has no manager URL AND no user-picked role),
  // pull the values from that file and arm ourselves. Zero-touch worker
  // setup — no setup-code paste required.
  try {
    const already = await chrome.storage.local.get(['adbrainManagerUrl', 'adbrainRole']);
    if (!already.adbrainManagerUrl && !already.adbrainRole) {
      const cfgUrl = chrome.runtime.getURL('worker-config.json');
      const resp = await fetch(cfgUrl);
      if (resp.ok) {
        const cfg = await resp.json();
        if (cfg && cfg.managerUrl) {
          const workerId = 'PC-' + Math.random().toString(16).slice(2, 8).toUpperCase();
          const updates = {
            adbrainManagerUrl:   String(cfg.managerUrl).trim(),
            adbrainManagerToken: String(cfg.managerToken || '').trim(),
            adbrainKpUrl:        String(cfg.kpUrl || '').trim(),
            adbrainRole:         String(cfg.role || 'worker').trim(),
            adbrainWorkerArmed:  true,
            adbrainWorkerId:     workerId,
            adbrainUserStoppedArm: false,
            // MAC + hostname captured by the installer. Heartbeat carries
            // these to the manager so it can Wake-on-LAN this PC later.
            adbrainWorkerMac:      String(cfg.mac || '').trim(),
            adbrainWorkerHostname: String(cfg.hostname || '').trim(),
          };
          await chrome.storage.local.set(updates);
          state.workerArmed = true;
          state.workerId = workerId;
          state.userStoppedArm = false;
          pushLog(`Auto-armed from worker-config.json — manager=${cfg.managerUrl}, id=${workerId}`, 'ok');
        }
      }
    }
  } catch {
    // No worker-config.json (regular install), or malformed — silent no-op.
  }
})();

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Push to ring buffer + persist + broadcast. Debounced persistence so we don't
// hit chrome.storage on every keystroke of progress.
let logPersistTimer = null;
function pushLog(text, kind) {
  if (!text) return;
  const line = { ts: Date.now(), text: String(text), kind: kind || null };
  state.log.push(line);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  if (logPersistTimer) clearTimeout(logPersistTimer);
  logPersistTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY_LOG]: state.log }).catch(() => {});
  }, 400);
}

function emitProgress(payload) {
  if (payload?.currentAction) pushLog(payload.currentAction, payload.logKind);
  // KP session-dead accounting: track consecutive per-product KP failures
  // vs successes. See state.consecutiveKpFailures for context.
  if (payload?.currentSource === 'kp') {
    const msg = String(payload.currentAction || '');
    const isFail = payload.logKind === 'err' && /^⚠ KP FAILED/.test(msg);
    const isOk   = payload.logKind === 'ok'  && /^KP returned \d/.test(msg);
    if (isFail) {
      state.consecutiveKpFailures = (state.consecutiveKpFailures || 0) + 1;
      if (state.consecutiveKpFailures >= 2 && Date.now() >= (state.kpDeadUntil || 0)) {
        triggerKpSessionDead().catch(() => {});
      }
    } else if (isOk) {
      if (state.consecutiveKpFailures > 0) pushLog(`KP recovered after ${state.consecutiveKpFailures} failure(s) — counter reset.`, 'ok');
      state.consecutiveKpFailures = 0;
    }
  }
  // Also buffer the line for the operations dashboard. Only meaningful
  // when distributed mode is active (state.workerId set) — bufferActivity
  // bails on its own otherwise.
  if (payload?.currentAction) {
    bufferActivity({
      level:      payload.logKind || 'info',
      source:     payload.currentSource || 'engine',
      message:    payload.currentAction,
      productUrl: payload.currentProduct || null,
    });
  }
  // Always include batch totals in the broadcast even when the engine
  // didn't put them in this particular payload (e.g. "KP: waiting for
  // hydrate" only carries currentAction). The popup's batch-progress
  // label was sticking at "Product 0 of 0" between events that did
  // include them, because most events don't. Sourcing from state.* on
  // every emit keeps the label live across the full run regardless of
  // which onProgress call fired.
  const enriched = { ...payload };
  if (enriched.productsTotal === undefined && state.lastProducts.length > 0) {
    enriched.productsTotal = state.lastProducts.length;
  }
  if (enriched.productsDone === undefined) {
    enriched.productsDone = state.doneProducts.length;
  }
  broadcast({ action: 'discoveryProgress', payload: enriched });
}

// KP session-dead handler. Two consecutive per-product KP failures on this
// worker → we conclude the KP tab / Google Ads session is broken, release
// the current chunk back to pending so another worker (with a live session)
// can pick them up, and disarm continuousClaim for a 5-minute cooldown.
// After cooldown expires, the worker is free to retry (the user may have
// re-logged into Google Ads in the meantime). Emits a clear activity line
// AND a persistent notification-style pushLog so the manager surfaces it.
const KP_SESSION_COOLDOWN_MS = 5 * 60 * 1000;
async function triggerKpSessionDead() {
  const cooldownMin = Math.round(KP_SESSION_COOLDOWN_MS / 60000);
  state.kpDeadUntil = Date.now() + KP_SESSION_COOLDOWN_MS;
  state.consecutiveKpFailures = 0;  // reset so we don't re-fire mid-cooldown
  // Disarm continuous-claim so we don't immediately reclaim after release.
  state.continuousClaim = false;
  await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
  // Release remaining claimed jobs back to pending — other workers with a
  // live KP session can process them without waiting for our cooldown.
  const heldCount = state.claimedJobs.length;
  if (state.workerId && heldCount > 0) {
    try {
      const r = await releaseByWorker(state.workerId);
      pushLog(`⛔ KP SESSION DEAD: 2 consecutive KP failures → released ${r.released || heldCount} claimed SKU(s) back to queue. Cooling down ${cooldownMin} min before reclaiming. Fix: re-login to Google Ads in this Chrome profile + verify the KP URL in Settings.`, 'err');
    } catch (e) {
      pushLog(`⛔ KP SESSION DEAD: 2 consecutive KP failures. Release attempt failed (${e.message}) — manual release may be needed. Cooling down ${cooldownMin} min before reclaiming.`, 'err');
    }
    state.claimedJobs = [];
    await chrome.storage.local.set({ [STORAGE_KEY_CLAIMED_JOBS]: [] }).catch(() => {});
  } else {
    pushLog(`⛔ KP SESSION DEAD: 2 consecutive KP failures. No claimed SKUs to release. Cooling down ${cooldownMin} min before reclaiming.`, 'err');
  }
}
// Cooldown check before any claim attempt. Returns true if we're STILL in
// the KP-session-dead cooldown window — callers should abort the claim.
function isKpCooldownActive() {
  const until = Number(state.kpDeadUntil || 0);
  if (until <= 0 || Date.now() >= until) return false;
  const remainMin = Math.ceil((until - Date.now()) / 60000);
  pushLog(`KP session cooldown active — ${remainMin} min remaining before we retry claiming. (Set by 2 consecutive KP failures.)`, 'warn');
  return true;
}

// Strip internal `_*` fields (which may contain Float32Array embeddings used
// by the noise filter) before persisting. chrome.storage uses structured
// clone for validation but rejects values containing typed arrays at the JSON
// serialization layer with "Cannot serialize value to JSON".
function stripInternalFields(rows) {
  return rows.map(r => {
    const out = {};
    for (const k in r) {
      if (k.startsWith('_')) continue;
      out[k] = r[k];
    }
    return out;
  });
}

async function persistReport() {
  await chrome.storage.local.set({
    [STORAGE_KEY_LAST_REPORT]: stripInternalFields(state.report),
    [STORAGE_KEY_LAST_BATCH]:  state.batchId,
    [STORAGE_KEY_LAST_STATUS]: state.lastStatus,
  });
}
async function persistDone() {
  await chrome.storage.local.set({
    [STORAGE_KEY_DONE_PRODUCTS]: state.doneProducts,
  });
}
async function persistPushed() {
  await chrome.storage.local.set({
    [STORAGE_KEY_LAST_PUSHED_COUNT]: state.lastPushedCount,
  });
}

async function setRunIntent(value) {
  state.runIntent = !!value;
  if (state.runIntent) {
    await chrome.storage.local.set({ [STORAGE_KEY_RUN_INTENT]: true });
  } else {
    // Timestamp the intent-cleared moment. shouldAutoResume treats any
    // resume attempt within 30s of this as unwanted so a racy watchdog
    // alarm firing during Pause/Stop cleanup can't re-launch the engine.
    state._runIntentClearedAt = Date.now();
    await chrome.storage.local.remove([STORAGE_KEY_RUN_INTENT]).catch(() => {});
  }
}

// Returns true when there is unfinished work AND the user wants it to
// continue (didn't explicitly Stop or Reset). Used by every auto-resume
// trigger so each path applies the same eligibility check.
function shouldAutoResume() {
  if (state.running) return false;
  if (state.stopRequested) return false;      // engine still cleaning up from a Stop/Pause
  if (!state.runIntent) return false;
  // Belt-and-suspenders window — if runIntent was cleared in the last
  // 30s, block auto-resume even if something else flipped it back on.
  // This is what protected against a rapid Pause+watchdog race where
  // the watchdog fired 2s after Pause and re-launched the run.
  if (state._runIntentClearedAt && (Date.now() - state._runIntentClearedAt) < 30000) return false;
  if (state.lastProducts.length === 0) return false;
  if (state.doneProducts.length >= state.lastProducts.length) return false;
  return true;
}

async function tryAutoResume(triggerLabel) {
  // Race-guard: onStartup and the watchdog alarm can both fire within ~1s of
  // each other after a service-worker wake-up. Without this mutex BOTH would
  // pass `shouldAutoResume()` (state.running is still false because
  // handleStart hasn't yet set it past its awaits), call handleStart in
  // parallel, and run two engines on the same products — duplicating SERP
  // loads, KP scrapes, storage writes, and image_count rows in the report.
  // Hold a single in-flight Promise; concurrent calls return that promise
  // (so they observe completion without re-spawning).
  if (state.resumeInFlight) {
    pushLog(`Auto-resume (${triggerLabel}) skipped — another resume already in flight`, 'info');
    return state.resumeInFlight;
  }
  state.resumeInFlight = (async () => {
    // The cold-start hydration may not have finished if onStartup fires before
    // the IIFE resolves — await it explicitly.
    await coldStart;
    if (!shouldAutoResume()) return;
  // No-progress gate. If the previous resume didn't advance doneProducts,
  // increment a counter; after 3 consecutive failures, stop auto-resuming
  // to break the infinite loop that triggers when the global keyword cap
  // is reached but some products remain unprocessed. The user can still
  // manually click Resume to override.
  const currentDoneCount = state.doneProducts.length;
  if (state.lastResumeDoneCount === currentDoneCount && state.lastResumeDoneCount >= 0) {
    state.consecutiveNoProgressResumes++;
    if (state.consecutiveNoProgressResumes >= 3) {
      pushLog(`Auto-resume halted (${triggerLabel}): 3 consecutive resumes made no progress (still ${currentDoneCount}/${state.lastProducts.length} done). Engine likely hit the keyword cap; clearing runIntent. Press Resume to override.`, 'err');
      state.runIntent = false;
      await chrome.storage.local.set({ [STORAGE_KEY_RUN_INTENT]: false }).catch(() => {});
      return;
    }
  } else {
    state.consecutiveNoProgressResumes = 0;
  }
  state.lastResumeDoneCount = currentDoneCount;
  pushLog(`Auto-resume (${triggerLabel}): ${currentDoneCount}/${state.lastProducts.length} products done — resuming run`, 'ok');
  try {
    await handleStart({ products: null });
  } catch (e) {
    pushLog(`Auto-resume failed: ${e.message}`, 'err');
  }
  })();
  try {
    return await state.resumeInFlight;
  } finally {
    state.resumeInFlight = null;
  }
}

// Watchdog alarm — fires every minute. Two jobs:
//   1. Keeps the service worker awake long enough to detect "we should still
//      be running but state.running was reset by an SW restart".
//   2. Re-launches handleStart if the engine died mid-run (alarm wake +
//      shouldAutoResume() check).
try {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
} catch {}
// Heartbeat alarm — fires every minute, no delay. Only does work when
// distributed mode is active (workerId set + claimedJobs non-empty).
// Keeping the alarm always-on lets the SW wake even when state has been
// torn down so heartbeats don't lapse mid-product.
try {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
} catch {}
// Dashboard activity-log push alarm — fires every 30s (Chrome's minimum
// reliable period for production-mode alarms is 0.5 min). Drains the
// in-memory log buffer to the manager so the manager dashboard's activity
// feed stays within ~30s of live. Worker-side only; no-op when
// state.workerId is empty.
const DASHBOARD_PUSH_ALARM = 'adbrain-dashboard-push';
try {
  chrome.alarms.create(DASHBOARD_PUSH_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.05 });
} catch {}
// Worker command-poll alarm — fires every 30s, checks for unacked
// commands targeted at this worker (or broadcast). Stop/pause reach
// the worker within ~30s of the manager clicking the button.
const COMMAND_POLL_ALARM = 'adbrain-command-poll';
try {
  chrome.alarms.create(COMMAND_POLL_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
} catch {}
// Pending-push retry alarm — drains the persistent push queue. Catches
// auto-pushes that failed during a previous SW lifetime so data
// eventually reaches the manager even after browser crashes.
const PENDING_PUSH_ALARM = 'adbrain-pending-push';
try {
  chrome.alarms.create(PENDING_PUSH_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.2 });
} catch {}
// the manager connection-health ping — pings the manager every 60s and updates
// state.connectionHealth so the popup + dashboard can show whether we
// can actually reach the database. Catches stale credentials, network
// outage, schema-cache problems before the user notices via downstream
// errors. Result stored in state.connectionHealth = { ok, latencyMs,
// lastCheckedAt, error }.
const HEALTH_PING_ALARM = 'adbrain-health-ping';
try {
  chrome.alarms.create(HEALTH_PING_ALARM, { periodInMinutes: 1, delayInMinutes: 0.3 });
} catch {}
// Worker auto-poll alarm — fires every 30s. When the worker is "armed"
// (user clicked Connect at least once) AND not currently running AND
// has credentials, scans the queue for the newest batch with pending
// work. If found, auto-fires the autoConnectWorker flow so the worker
// starts processing without any user click. This is what makes the
// worker truly "set and forget": once armed, it picks up every new
// batch the manager uploads, automatically, until the user clicks Stop.
const WORKER_AUTOPOLL_ALARM = 'adbrain-worker-autopoll';
try {
  chrome.alarms.create(WORKER_AUTOPOLL_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.4 });
} catch {}

// Track repeated identical failure reasons so we don't spam the log
// every 30s with the same "no KP URL" message.
let _lastAutoPollErr = '';
let _lastAutoPollErrCount = 0;

// Shared implementation of "claim a chunk + start the engine". Called
// both from the message handler (popup / dashboard command) AND from
// workerAutoPollTick's 30s alarm. Returns { ok, claimed, batchId,
// error?, message? } — same shape either way. Never uses
// chrome.runtime.sendMessage cross-context — that was the source of
// intermittent 'Receiving end does not exist' errors when the SW was
// briefly idle.
async function _doAutoConnectWorker(msg = {}) {
  try {
    const workerId = (msg.workerId || state.workerId || '').trim();
    if (!workerId) return { ok: false, error: 'Set a Worker ID first.' };
    if (state.running || state.starting) {
      pushLog(`Auto-connect ignored: engine already running. Worker stays armed; will pick up next chunk when this one finishes.`, 'info');
      return { ok: true, claimed: 0, message: 'engine already running — already armed' };
    }
    const chunkSize = Math.max(1, Math.min(50, Number(msg.chunkSize) || 5));
    const explicitBatch = (msg.batchId || '').trim();
    const batchId = explicitBatch || (await getActiveBatchId());
    if (!batchId) return { ok: false, error: 'No batches with pending work found. Ask the manager to upload a batch first.' };
    state.continuousClaim = true;
    state.continuousChunkSize = chunkSize;
    state.workerId = workerId;
    state.workerArmed = true;
    state.userStoppedArm = false;
    await chrome.storage.local.set({
      [STORAGE_KEY_WORKER_ID]: workerId,
      adbrainContinuousClaim: true,
      adbrainContinuousChunkSize: chunkSize,
      adbrainWorkerArmed: true,
      adbrainUserStoppedArm: false,
    }).catch(() => {});
    await releaseStaleJobs(10).catch(() => null);
    // Ghost-claim reconciliation: on cold-start / auto-connect, release ALL
    // claims still tagged to THIS workerId that we don't have in memory. If
    // Chrome killed the SW mid-work (which the harness DOES routinely), the
    // old claims sit in the DB as `claimed by <us>` with fresh heartbeats
    // that never arrive — so release-stale never catches them but the
    // manager's worker-stats sums both old and new. Result was "10 in-flight
    // for a worker running one SERP" — the ghost claims. Only release when
    // in-memory claimedJobs is empty (fresh SW) or shorter than the DB view
    // would suggest — the safe cold-start case. Never yank live work.
    if (state.claimedJobs.length === 0) {
      try {
        const r = await releaseByWorker(workerId);
        if (r.released > 0) pushLog(`Cold-start: released ${r.released} ghost claim(s) previously held by this worker id (SW restart / Chrome reload). No live work interrupted.`, 'warn');
      } catch {}
    }
    let centralConfig = null;
    try { centralConfig = await fetchWorkerConfig(); } catch {}
    const centralRunOpts = centralConfig ? workerConfigToRunOpts(centralConfig) : {};
    if (centralRunOpts.kpUrl) {
      await chrome.storage.local.set({ [STORAGE_KEY_KP_URL]: centralRunOpts.kpUrl }).catch(() => {});
    }
    const localKpUrl = (await chrome.storage.local.get([STORAGE_KEY_KP_URL]))[STORAGE_KEY_KP_URL] || '';
    const effectiveKpUrl = (centralRunOpts.kpUrl || localKpUrl || '').trim();
    if (!effectiveKpUrl || !effectiveKpUrl.includes('ads.google.com')) {
      return { ok: false, error: 'No Keyword Planner URL configured. Set it in the manager Config tab (KP URL) and Save + push to all workers.' };
    }
    if (isKpCooldownActive()) {
      return { ok: false, error: 'KP session cooldown active — refusing to claim more SKUs until cooldown expires. Fix the Google Ads / KP session first, then use Force reconnect.' };
    }
    const jobs = await claimJobs({ workerId, batchId, limit: chunkSize });
    if (jobs.length === 0) {
      state.continuousClaim = false;
      await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
      return { ok: true, claimed: 0, batchId, message: 'No pending jobs in this batch right now.' };
    }
    state.queueBatchId = batchId;
    state.claimedJobs  = jobs.map(j => ({ id: j.id, productUrl: j.product_url }));
    await chrome.storage.local.set({
      [STORAGE_KEY_QUEUE_BATCH_ID]: batchId,
      [STORAGE_KEY_CLAIMED_JOBS]:   state.claimedJobs,
    }).catch(() => {});
    await setRunIntent(true);
    const centralKeys = Object.keys(centralRunOpts);
    const centralNote = centralKeys.length > 0
      ? ` · applied ${centralKeys.length} setting(s) from manager: ${centralKeys.slice(0, 6).join(', ')}`
      : '';
    pushLog(`Auto-connect: claimed ${jobs.length} job(s) from batch "${batchId}" — continuous mode ON${centralNote}`, 'ok');
    const products = jobs.map(j => ({
      url: j.product_url, sku: j.sku,
      productName: j.product_name, priority: j.priority,
      handles: j.handles ? String(j.handles).split('|').filter(Boolean) : [],
      brands:  j.brands  ? String(j.brands).split('|').filter(Boolean)  : [],
    }));
    const mergedRunOpts = { ...(msg.runOpts || {}), ...centralRunOpts };
    const startResult = await handleStart({ products, ...mergedRunOpts });
    return { ok: true, claimed: jobs.length, batchId, startResult, centralConfig: !!centralConfig };
  } catch (e) {
    const errStr = (e && e.message) || (e && e.toString && e.toString()) || 'unspecified exception in autoConnectWorker';
    return { ok: false, error: errStr, stack: e?.stack?.split('\n')?.[1]?.trim() };
  }
}

async function workerAutoPollTick() {
  try {
    await coldStart;
    // Only run if armed + has identity + not currently running.
    if (!state.workerArmed) return;
    if (!state.workerId) return;
    // Fire the worker roster heartbeat FIRST — before any of the early
    // returns below. Even armed-idle workers must show as online in the
    // manager fleet; without this, workers that never claim (empty
    // queue) appear as offline forever. MAC + hostname come along so
    // the manager can Wake-on-LAN this PC later.
    (async () => {
      try {
        const d = await chrome.storage.local.get(['adbrainWorkerMac', 'adbrainWorkerHostname']);
        sendWorkerHeartbeat(state.workerId, { mac: d.adbrainWorkerMac || '', hostname: d.adbrainWorkerHostname || '' }).catch(() => {});
      } catch { sendWorkerHeartbeat(state.workerId).catch(() => {}); }
    })();
    if (state.running) return;
    if (state.starting) return;
    if (state.resumeInFlight) return;
    // Check if there's a batch with pending work.
    const batchId = await getActiveBatchId();
    if (!batchId) return;  // nothing to do
    // Found work — fire autoConnectWorker. We DO await the response so
    // we can detect known failures (no KP URL, etc.) and log them once
    // instead of spamming the activity log every 30s.
    pushLog(`Worker auto-poll: found pending batch "${batchId}" — claiming`, 'ok');
    // Direct in-SW call — no chrome.runtime.sendMessage. That message
    // hop occasionally failed with 'Receiving end does not exist' when
    // MV3 GC'd the SW mid-send. Same code, no cross-context indirection.
    const resp = await _doAutoConnectWorker({
      workerId: state.workerId,
      chunkSize: state.continuousChunkSize || 5,
    });
    let err = null;
    if (!resp) {
      err = 'No response from _doAutoConnectWorker (unreachable — bug)';
    } else if (!resp.ok) {
      err = resp.error || resp.message || `response without ok/error fields: ${JSON.stringify(resp).slice(0, 200)}`;
    }
    if (err) {
      if (err === _lastAutoPollErr) {
        _lastAutoPollErrCount++;
        // Only surface to dashboard ONCE (at count=10 ≈ 5min stuck).
        // After that, keep silent — log spam helps no one.
        if (_lastAutoPollErrCount === 10) {
          bufferActivity({
            level: 'err',
            source: 'autopoll',
            message: `Worker "${state.workerId}" stuck for ~5 min: ${err.slice(0, 300)}`,
          });
        }
        return;
      }
      _lastAutoPollErr = err;
      _lastAutoPollErrCount = 1;
      pushLog(`Worker auto-poll: claim refused — ${err}`, 'err');
      bufferActivity({
        level: 'err',
        source: 'autopoll',
        message: `Worker "${state.workerId}" cannot start: ${err.slice(0, 300)}`,
      });
      return;
    }
    // Success or benign "already running" — reset the dedup tracker.
    _lastAutoPollErr = '';
    _lastAutoPollErrCount = 0;
  } catch (e) {
    pushLog(`Worker auto-poll error: ${e.message}`, 'err');
  }
}

// Pending-push queue for keyword rows that haven't reached the manager yet.
// Each entry: { productUrl, batchId, rows[], attempts, lastError, ts }.
// Persisted to chrome.storage so SW death + watchdog wake doesn't lose
// data mid-push. Drained by flushPendingPushes (called on alarm + on
// successful auto-push to catch retries). Prevents the entire class of
// "batch shows done but no data" bugs from the audit.
const _pendingPushes = [];
const PENDING_PUSH_CAP = 50;       // skip if queue blows up (avoids runaway)
const PENDING_PUSH_STORAGE_KEY = 'adbrainPendingPushes';
const PENDING_PUSH_MAX_ATTEMPTS = 5;
let _pendingPushPersistTimer = null;

function _persistPendingPushes() {
  if (_pendingPushPersistTimer) clearTimeout(_pendingPushPersistTimer);
  _pendingPushPersistTimer = setTimeout(() => {
    chrome.storage.local.set({ [PENDING_PUSH_STORAGE_KEY]: _pendingPushes.slice(-PENDING_PUSH_CAP) }).catch(() => {});
    _pendingPushPersistTimer = null;
  }, 1500);
}

function enqueuePendingPush(productUrl, rows, batchId) {
  if (!productUrl || !Array.isArray(rows) || rows.length === 0) return;
  // Dedupe — if the same product is already in the queue, replace its
  // rows (most recent state wins).
  const existingIdx = _pendingPushes.findIndex(p => p.productUrl === productUrl);
  const entry = {
    productUrl,
    batchId: batchId || state.batchId || null,
    rows: rows.slice(),
    attempts: existingIdx >= 0 ? _pendingPushes[existingIdx].attempts : 0,
    lastError: null,
    ts: new Date().toISOString(),
  };
  if (existingIdx >= 0) _pendingPushes[existingIdx] = entry;
  else _pendingPushes.push(entry);
  if (_pendingPushes.length > PENDING_PUSH_CAP) {
    _pendingPushes.splice(0, _pendingPushes.length - PENDING_PUSH_CAP);
  }
  _persistPendingPushes();
}

async function flushPendingPushes() {
  if (_pendingPushes.length === 0) return;
  // Skip retries when the connection is provably down — would just
  // spam the manager + log with no chance of success. Health-ping alarm
  // will mark it ok=true again the moment the manager comes back, and
  // this tick will resume normally.
  if (state.connectionHealth?.ok === false) {
    return;
  }
  // Process one entry per tick — if the manager is rate-limited we don't
  // want to hammer it 50 times in a row.
  const entry = _pendingPushes[0];
  if (entry.attempts >= PENDING_PUSH_MAX_ATTEMPTS) {
    const dropMsg = `Push retry exhausted for ${entry.productUrl} after ${entry.attempts} attempts — dropping ${entry.rows.length} row(s). Last error: ${entry.lastError || 'unknown'}`;
    pushLog(dropMsg, 'err');
    // Also surface the drop event to the dashboard activity log so the
    // manager sees this PC dropped data — otherwise this loss is
    // invisible outside this PC.
    bufferActivity({ level: 'err', source: 'push', message: dropMsg, productUrl: entry.productUrl });
    _pendingPushes.shift();
    _persistPendingPushes();
    return;
  }
  entry.attempts++;
  try {
    const r = await pushToAdBrain(entry.rows);
    if (r.failed > 0) {
      entry.lastError = `${r.failed}/${r.success + r.failed} rows failed: ${(r.errors || []).slice(0, 1).join('') || 'unknown'}`;
      // Detect unrecoverable errors (data shape problems, not network).
      // No point retrying these — fast-forward attempts so the next
      // tick drops the entry and surfaces the loss to dashboard.
      if (/constraint|violates|invalid input|type mismatch|22P02|23502|23505/i.test(entry.lastError)) {
        entry.attempts = PENDING_PUSH_MAX_ATTEMPTS;
        pushLog(`Push retry for ${entry.productUrl} hit unrecoverable error (${entry.lastError}) — fast-forwarding to drop`, 'err');
      } else {
        pushLog(`Push retry ${entry.attempts}/${PENDING_PUSH_MAX_ATTEMPTS} for ${entry.productUrl}: ${entry.lastError} — will retry`, 'err');
      }
      _persistPendingPushes();
      return;  // leave at head of queue for next tick
    }
    pushLog(`✓ Push retry succeeded: ${r.success} row(s) for ${entry.productUrl}`, 'ok');
    _pendingPushes.shift();
    _persistPendingPushes();
  } catch (e) {
    entry.lastError = e.message;
    pushLog(`Push retry ${entry.attempts}/${PENDING_PUSH_MAX_ATTEMPTS} for ${entry.productUrl} threw: ${e.message}`, 'err');
    _persistPendingPushes();
  }
}

// In-memory activity log buffer. Drained every 30s by the alarm AND
// immediately on high-impact events (errors, product done/failed). Capped
// to avoid runaway memory on long runs. Also periodically persisted to
// chrome.storage so SW death doesn't lose recent events that haven't
// hit the manager yet.
const _activityBuffer = [];
const ACTIVITY_BUFFER_CAP = 500;
const ACTIVITY_STORAGE_KEY = 'adbrainActivityBuffer';
let _activityPersistTimer = null;
let _activityFlushScheduled = false;
let _activityFlushTimer = null;
let _activityFlushDelay = 0;

function bufferActivity(entry) {
  if (!entry || !entry.message) return;
  if (!state.workerId) return;  // only push when running in distributed mode
  _activityBuffer.push({
    batch_id:    state.queueBatchId || null,
    worker_id:   state.workerId,
    level:       entry.level || 'info',
    source:      entry.source || 'engine',
    message:     String(entry.message).slice(0, 500),
    product_url: entry.productUrl || null,
    sku:         entry.sku || null,
    ts:          new Date().toISOString(),
  });
  if (_activityBuffer.length > ACTIVITY_BUFFER_CAP) {
    _activityBuffer.splice(0, _activityBuffer.length - ACTIVITY_BUFFER_CAP);
  }
  // Debounced persist to chrome.storage so SW kill doesn't lose data.
  if (_activityPersistTimer) clearTimeout(_activityPersistTimer);
  _activityPersistTimer = setTimeout(() => {
    chrome.storage.local.set({ [ACTIVITY_STORAGE_KEY]: _activityBuffer.slice(-200) }).catch(() => {});
    _activityPersistTimer = null;
  }, 2000);
  // Fast-flush window: ANY buffered event triggers a flush within
  // FAST_FLUSH_MS. Without this, normal info events (KP scrape, SERP,
  // autosuggest) sat for up to 30s waiting on DASHBOARD_PUSH_ALARM and
  // the manager painted the worker STUCK / "last activity —" during
  // that first-30-seconds gap. Urgent events (err/warn/product
  // complete/captcha) still flush in 1s; everything else flushes in 3s.
  // The 30s alarm remains as a backstop for the SW-suspended case.
  // If a flush is already scheduled at a longer delay, we tighten it
  // when an urgent event arrives so the manager doesn't wait.
  const isUrgent = entry.level === 'err' || entry.level === 'warn'
    || /product (complete|partial|failed)/i.test(entry.message)
    || /captcha/i.test(entry.message);
  const targetDelay = isUrgent ? 1000 : 3000;
  if (_activityFlushScheduled) {
    // Urgent event arriving after a normal-delay schedule: tighten.
    if (isUrgent && _activityFlushDelay > 1000) {
      clearTimeout(_activityFlushTimer);
      _activityFlushDelay = 1000;
      _activityFlushTimer = setTimeout(() => {
        _activityFlushScheduled = false; _activityFlushTimer = null;
        flushActivityBuffer();
      }, 1000);
    }
  } else {
    _activityFlushScheduled = true;
    _activityFlushDelay = targetDelay;
    _activityFlushTimer = setTimeout(() => {
      _activityFlushScheduled = false; _activityFlushTimer = null;
      flushActivityBuffer();
    }, targetDelay);
  }
}

async function flushActivityBuffer() {
  if (_activityBuffer.length === 0) return;
  const slice = _activityBuffer.splice(0, _activityBuffer.length);
  try {
    const r = await pushActivityLog(slice);
    if (r.error) {
      // On push failure, re-buffer the OLDEST entries (the buffer is
      // FIFO; oldest at index 0). Take up to ACTIVITY_BUFFER_CAP so
      // we don't drop everything to one transient network error.
      // Previously this only kept the first 100 of however-many we
      // had — for a 500-entry buffer we'd silently lose 400 entries.
      const keep = slice.slice(0, ACTIVITY_BUFFER_CAP);
      _activityBuffer.unshift(...keep);
    }
  } catch {
    const keep = slice.slice(0, ACTIVITY_BUFFER_CAP);
    _activityBuffer.unshift(...keep);
  }
}

// Auto-migration: when a manager PC has a locally-saved KP URL (from
// before auto-push existed) but the manager worker_config row has no
// kp_url set, push the local one up. Fires once on connection-health
// success when we detect this mismatch. Saves the user from having to
// click Save Settings just to migrate their existing config.
let _kpUrlMigrationDone = false;
async function maybeAutoMigrateKpUrl() {
  if (_kpUrlMigrationDone) return;
  try {
    const data = await chrome.storage.local.get(['adbrainKpUrl']);
    const localKpUrl = (data.adbrainKpUrl || '').trim();
    if (!localKpUrl || !/\/aw\/keywordplanner\b/.test(localKpUrl)) return;
    // Local has a valid KP URL. Check what the central config has.
    const cfg = await fetchWorkerConfig().catch(() => null);
    if (cfg && cfg.kp_url && /\/aw\/keywordplanner\b/.test(cfg.kp_url)) {
      // Central already has a valid KP URL — no migration needed.
      _kpUrlMigrationDone = true;
      return;
    }
    // Push the local KP URL to central. Other config fields untouched.
    await saveWorkerConfig({ kp_url: localKpUrl }, 'auto-migration');
    pushLog(`Auto-migrated local KP URL to central worker_config (workers will pick it up on next claim)`, 'ok');
    _kpUrlMigrationDone = true;
  } catch (e) {
    // Quiet failure — manager can still manually push via Save Settings.
  }
}

// Ping the self-hosted manager with a tiny GET /api/health to verify
// connectivity + auth. Updates state.connectionHealth. Cheap — should
// complete in 20-50ms on a healthy tailnet, up to 300ms cold.
async function pingConnectionHealth() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_MANAGER_URL, STORAGE_KEY_MANAGER_TOKEN]);
    const url = String(data[STORAGE_KEY_MANAGER_URL] || '').trim().replace(/\/+$/, '');
    const token = String(data[STORAGE_KEY_MANAGER_TOKEN] || '').trim();
    if (!url) {
      state.connectionHealth = {
        ok: false, latencyMs: null,
        lastCheckedAt: new Date().toISOString(),
        error: 'Manager URL not set',
      };
      return;
    }
    const t0 = Date.now();
    const headers = {};
    if (token) headers['X-Manager-Token'] = token;
    const resp = await fetch(`${url}/api/health`, { method: 'GET', headers });
    const latencyMs = Date.now() - t0;
    if (resp.ok) {
      state.connectionHealth = {
        ok: true, latencyMs,
        lastCheckedAt: new Date().toISOString(),
        error: null,
      };
      // Connection is healthy — opportunistically migrate any local
      // KP URL up to worker_config if it hasn't been pushed yet.
      maybeAutoMigrateKpUrl();
    } else {
      state.connectionHealth = {
        ok: false, latencyMs,
        lastCheckedAt: new Date().toISOString(),
        error: `HTTP ${resp.status}${resp.status === 401 ? ' — bad manager token' : resp.status === 404 ? ' — /api/health missing (old manager?)' : ''}`,
      };
    }
  } catch (e) {
    state.connectionHealth = {
      ok: false, latencyMs: null,
      lastCheckedAt: new Date().toISOString(),
      error: `Network: ${e.message}`,
    };
  }
}

async function pollWorkerCommands() {
  if (!state.workerId) return;
  try {
    const cmds = await fetchPendingCommands(state.workerId);
    if (!Array.isArray(cmds) || cmds.length === 0) return;
    for (const c of cmds) {
      try {
        if (c.command === 'stop') {
          // Treat as a remote Stop click.
          state.stopRequested = true;
          state.continuousClaim = false;
          await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
          await setRunIntent(false);
          // Release any not-yet-processed claims so other workers can pick
          // them up immediately (don't wait for the 10-min stale timer).
          await releaseThisWorkerClaims('Manager Stop command');
        } else if (c.command === 'pause') {
          // Graceful halt after the current SKU. Unlike stop, we keep
          // workerArmed=true and don't set userStoppedArm, so a Resume
          // brings the run back with minimal ceremony. Critically we
          // clear runIntent so the 60s watchdog can't auto-resume
          // in the ~30s window between the engine halting and the user
          // pressing Resume (that was the 'Auto-resume (watchdog) 2s
          // after Pause' bug).
          state.stopRequested = true;
          await setRunIntent(false);
          bufferActivity({ level: 'warn', source: 'cmd', message: `Pause command received — halting after current SKU. Send Resume to continue.` });
        } else if (c.command === 'reconnect') {
          // Manager force-reconnect. Overrides userStoppedArm so a
          // manager can revive a Stopped PC without physical access.
          // Different from 'wake': wake respects userStoppedArm on
          // purpose; reconnect is the explicit "I know it was stopped
          // and I want it back" escape hatch.
          state.workerArmed = true;
          state.userStoppedArm = false;
          state.stopRequested = false;
          state._runIntentClearedAt = 0;
          await chrome.storage.local.set({
            adbrainWorkerArmed: true,
            adbrainUserStoppedArm: false,
          }).catch(() => {});
          bufferActivity({ level: 'ok', source: 'cmd', message: `Reconnect command received — force-armed (userStoppedArm cleared). Will auto-claim next chunk.` });
          setTimeout(() => workerAutoPollTick().catch(() => {}), 200);
        } else if (c.command === 'hard_reset') {
          // NUCLEAR OPTION for stuck engines.
          //
          // Reconnect only clears flags — it can't abort a hung `await`
          // inside the engine loop (e.g., a SERP tab that never fires
          // ready, a fetch that never resolves). When the fleet-grid
          // frozen-engine detector fires, the manager sends this
          // command instead of reconnect. chrome.runtime.reload() kills
          // the current SW + all its pending microtasks and reloads
          // the entire extension. Storage state (workerId, config,
          // claimed jobs, pending pushes) survives; the frozen engine
          // loop does not.
          //
          // Ack the command BEFORE reloading, otherwise the ack never
          // sends and the manager will re-send this every poll cycle.
          try { await acknowledgeCommand(c.id, state.workerId); } catch {}
          bufferActivity({ level: 'warn', source: 'cmd', message: `Hard-reset command received — reloading extension to unstick frozen engine.` });
          // Flush the activity buffer so the manager sees the reload
          // event before the SW dies.
          try { await flushActivityBuffer(); } catch {}
          // Small delay so buffered writes settle to storage.
          setTimeout(() => { try { chrome.runtime.reload(); } catch {} }, 200);
          // Continue the loop; the reload will kill us shortly. Don't
          // fall through to the shared acknowledgeCommand below.
          continue;
        } else if (c.command === 'wake') {
          // Manager broadcast "wake up and check for work". Triggers an
          // immediate auto-poll tick — but does NOT override an
          // explicit user Stop. If state.userStoppedArm is true (set
          // by the Stop handler), the worker stays disarmed; user
          // must explicitly click Connect on the worker PC to re-arm.
          if (state.userStoppedArm) {
            bufferActivity({ level: 'warn', source: 'cmd', message: `Wake ignored — this PC was explicitly stopped by its user. Click Connect & start working on the worker PC to re-arm.` });
          } else {
            state.workerArmed = true;
            await chrome.storage.local.set({ adbrainWorkerArmed: true }).catch(() => {});
            bufferActivity({ level: 'ok', source: 'cmd', message: `Wake command received — armed; will auto-claim next chunk.` });
            setTimeout(() => workerAutoPollTick().catch(() => {}), 200);
          }
        } else if (c.command === 'resume') {
          // Re-enable continuous-claim + auto-arm + kick off autoConnect.
          // Previously used chrome.runtime.sendMessage to self, which is
          // fragile: the SW→SW message may not deliver if the SW is
          // about to suspend, and 'Receiving end does not exist' errors
          // silently ate the resume. Now calls _doAutoConnectWorker
          // directly so the entire arm+claim flow runs synchronously
          // inside the poll handler.
          if (state.running) {
            bufferActivity({ level: 'info', source: 'cmd', message: `Resume command received but engine is already running — ignoring.` });
          } else {
            // Clear the local-stop flags so autoConnectWorker doesn't
            // fight them. Same semantics as `reconnect` — the manager
            // is explicitly saying 'go run'.
            state.workerArmed = true;
            state.userStoppedArm = false;
            state.stopRequested = false;
            state.continuousClaim = true;
            state._runIntentClearedAt = 0;
            await chrome.storage.local.set({
              adbrainContinuousClaim: true,
              adbrainWorkerArmed: true,
              adbrainUserStoppedArm: false,
            }).catch(() => {});
            await setRunIntent(true);
            bufferActivity({ level: 'ok', source: 'cmd', message: `Resume command received — force-armed + claiming next chunk.` });
            // Fire async so we don't block command-ack (autoConnect can
            // take 5-10s claiming + fetching config).
            const wId = state.workerId;
            const cs  = state.continuousChunkSize || 5;
            setTimeout(() => { _doAutoConnectWorker({ workerId: wId, chunkSize: cs }).catch(() => {}); }, 200);
          }
        } else if (c.command === 'reset_local') {
          // Manager did a full reset. Purge our local state that
          // references now-deleted rows on the manager side — otherwise
          // we'd keep heartbeating stale job IDs, claiming a phantom
          // batch, and reporting bogus 'today' counters. What survives:
          //   - workerId, workerArmed, managerUrl, managerToken, kpUrl
          //     (all still valid — the manager didn't rotate those)
          // What gets cleared:
          //   - queueBatchId, claimedJobs (jobs table wiped)
          //   - doneProducts, lastReport, lastProducts, runIntent (run state)
          //   - todayBaseline (throughput chart baseline is now bogus)
          //   - pending pushes (destination rows are gone)
          state.stopRequested = true;
          state.queueBatchId = '';
          state.claimedJobs = [];
          state.doneProducts = [];
          state.lastProducts = [];
          state.lastRunOpts = null;
          state.report = [];
          state.lastPushedCount = 0;
          state.batchId = '';
          _pendingPushes.length = 0;
          await setRunIntent(false);
          await chrome.storage.local.remove([
            STORAGE_KEY_QUEUE_BATCH_ID, STORAGE_KEY_CLAIMED_JOBS,
            STORAGE_KEY_DONE_PRODUCTS, STORAGE_KEY_LAST_REPORT,
            STORAGE_KEY_LAST_PRODUCTS, STORAGE_KEY_LAST_RUN_OPTS,
            STORAGE_KEY_LAST_BATCH, STORAGE_KEY_LAST_PUSHED_COUNT,
            'adbrainTodayBaseline', PENDING_PUSH_STORAGE_KEY,
          ]).catch(() => {});
          bufferActivity({ level: 'warn', source: 'cmd', message: `reset_local: manager reset detected — cleared local job/run state (worker id + config kept).` });
          pushLog(`Manager reset detected — cleared local run state. Worker stays armed and will claim from the next batch you upload.`, 'ok');
        } else if (c.command === 'release_claims') {
          await releaseThisWorkerClaims('release-claims command');
        }
        await acknowledgeCommand(c.id, state.workerId);
      } catch {}
    }
  } catch {}
}

// Shared claim-release path — used by the 'release_claims' command AND by
// both Stop paths (local Stop button + remote 'stop' command). Before this
// helper existed, a user-stop cleared local state but left the claims held
// on the manager for up to 10 min (until the stale-release timer). That
// left 'stopped' workers showing '6 in-flight' on the dashboard and
// blocked those SKUs from being picked up by an active worker.
async function releaseThisWorkerClaims(reasonForLog) {
  await releaseStaleJobs(0).catch(() => {});
  state.claimedJobs = [];
  await chrome.storage.local.set({ [STORAGE_KEY_CLAIMED_JOBS]: [] }).catch(() => {});
  bufferActivity({ level: 'warn', source: 'cmd', message: `${reasonForLog} — released claims back to queue.` });
}

async function tickHeartbeat() {
  try {
    await coldStart;
    if (!state.workerId) return;
    const jobIds = state.claimedJobs.map(j => j.id).filter(Boolean);
    if (jobIds.length === 0) return;
    const r = await heartbeatClaims(state.workerId, jobIds);
    if (r.error) pushLog(`Heartbeat warning: ${r.error}`, 'err');
    // Piggyback: heartbeat is a natural sync point. If there's buffered
    // activity, drain it now so the manager's "last activity" field stays
    // within ~1 heartbeat of reality instead of trailing by up to 30s.
    if (_activityBuffer.length > 0) {
      if (_activityFlushTimer) { clearTimeout(_activityFlushTimer); _activityFlushTimer = null; }
      _activityFlushScheduled = false; _activityFlushDelay = 0;
      flushActivityBuffer().catch(() => {});
    }
    // Drift detection: if the manager's active batch has moved (Reset,
    // re-pin, etc.) and we have no in-flight work on the current cached
    // batch, resync. Never yank a running job — only self-correct when idle.
    if (r.activeBatchId && state.queueBatchId && r.activeBatchId !== state.queueBatchId) {
      const busy = state.claimedJobs.length > 0 || state.isRunning;
      if (!busy) {
        pushLog(`Batch drift detected: cached ${state.queueBatchId} → manager ${r.activeBatchId}. Resyncing.`, 'warn');
        state.queueBatchId = r.activeBatchId;
        try { await chrome.storage.local.set({ [STORAGE_KEY_QUEUE_BATCH_ID]: r.activeBatchId }); } catch {}
      } else {
        pushLog(`Batch drift noted (manager: ${r.activeBatchId}, worker: ${state.queueBatchId}); deferring resync until claims finish.`, 'warn');
      }
    }
  } catch (e) {
    pushLog(`Heartbeat failed: ${e.message}`, 'err');
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM)        return void tryAutoResume('watchdog');
  if (alarm.name === HEARTBEAT_ALARM)       return void tickHeartbeat();
  if (alarm.name === DASHBOARD_PUSH_ALARM)  return void flushActivityBuffer();
  if (alarm.name === COMMAND_POLL_ALARM)    return void pollWorkerCommands();
  if (alarm.name === PENDING_PUSH_ALARM)    return void flushPendingPushes();
  if (alarm.name === HEALTH_PING_ALARM)     return void pingConnectionHealth();
  if (alarm.name === WORKER_AUTOPOLL_ALARM) return void workerAutoPollTick();
});

// Chrome itself just started — wake immediately and resume if intent flag set.
chrome.runtime.onStartup?.addListener?.(() => {
  tryAutoResume('onStartup');
});

// Extension reloaded / updated. Skip on first install — a brand-new install
// has nothing to resume even if some leftover storage exists from another
// install (rare but possible).
chrome.runtime.onInstalled?.addListener?.((details) => {
  if (details?.reason === 'install') return;
  tryAutoResume(`onInstalled:${details?.reason || 'unknown'}`);
});

// Strip down a progress payload to a serialisable subset for storage/broadcast.
function pickRunOpts(msg) {
  return {
    cap:               msg.cap,
    kpUrl:             msg.kpUrl,
    kpMaxPerProduct:   msg.kpMaxPerProduct,
    matchProfile:      msg.matchProfile,
    clipThresholdOverride: msg.clipThresholdOverride,
    maxImageMatchRows: msg.maxImageMatchRows,
    autoExport:        msg.autoExport,
    searchDelayMinMs:  msg.searchDelayMinMs,
    searchDelayMaxMs:  msg.searchDelayMaxMs,
    productDelayMinMs: msg.productDelayMinMs,
    productDelayMaxMs: msg.productDelayMaxMs,
    chunkSize:         msg.chunkSize,
    chunkRestMinMs:    msg.chunkRestMinMs,
    chunkRestMaxMs:    msg.chunkRestMaxMs,
  };
}

async function handleStart(msg) {
  // Two-layer re-entry guard. `state.running` only flips to true AFTER
  // several awaits later in this function (storage.set, emitProgress, etc.),
  // which means a second caller can pass this check and start a parallel
  // engine before the first one has marked itself running. `state.starting`
  // is set SYNCHRONOUSLY here so the second caller bounces immediately.
  if (state.running || state.starting) return { ok: false, error: 'already running' };
  state.starting = true;
  try {
    return await _handleStartInner(msg);
  } finally {
    // Clear `starting` whether or not _handleStartInner threw — the inner
    // function sets state.running=true when it has fully entered the run
    // loop, after which a fresh handleStart call is correctly blocked by
    // the `state.running` half of the guard above.
    state.starting = false;
  }
}

async function _handleStartInner(msg) {
  // Determine the input list. If msg has products, this is a fresh Start (or
  // a re-Start with a new file). If not, this is a Resume: reuse the
  // previously persisted product list + run options.
  let products = msg.products;
  let runOpts;
  if (Array.isArray(products) && products.length > 0) {
    runOpts = pickRunOpts(msg);
    state.lastProducts = products;
    state.lastRunOpts = runOpts;
    await chrome.storage.local.set({
      [STORAGE_KEY_LAST_PRODUCTS]: products,
      [STORAGE_KEY_LAST_RUN_OPTS]: runOpts,
    });
  } else if (state.lastProducts.length > 0 && state.lastRunOpts) {
    products = state.lastProducts;
    // Strip stale `cap` from the saved runOpts so the engine falls back to
    // the current KEYWORD_CAP default. Without this, a run started when
    // KEYWORD_CAP was 500 keeps cap=500 forever in storage — even after a
    // code change raises the default to 50000 — and resumes wedge at the
    // old ceiling. Same protection for kpMaxPerProduct (was 200, now 5000).
    runOpts  = { ...state.lastRunOpts };
    if (typeof runOpts.cap === 'number' && runOpts.cap <= 1000) {
      emitProgress({ currentAction: `Dropping stale cap=${runOpts.cap} from saved run options — using current default`, logKind: 'ok' });
      delete runOpts.cap;
    }
    if (typeof runOpts.kpMaxPerProduct === 'number' && runOpts.kpMaxPerProduct < 1000) {
      delete runOpts.kpMaxPerProduct;
    }
    // Strip stale pacing values too — when the user had been running with
    // the previous defaults (5-12s / 15-35s / 5-10min chunk rest) and the
    // config got faster, resume should pick up the new defaults rather
    // than freeze at the old slow ones. Only strip values that EXACTLY
    // match the old defaults so users who explicitly customised in the
    // popup keep their settings.
    const STALE_PACING = {
      searchDelayMinMs:  5000,
      searchDelayMaxMs:  12000,
      productDelayMinMs: 15000,
      productDelayMaxMs: 35000,
      chunkSize:         8,
      chunkRestMinMs:    5 * 60 * 1000,
      chunkRestMaxMs:    10 * 60 * 1000,
    };
    let strippedPacing = false;
    for (const [k, oldDefault] of Object.entries(STALE_PACING)) {
      if (runOpts[k] === oldDefault) {
        delete runOpts[k];
        strippedPacing = true;
      }
    }
    if (strippedPacing) {
      emitProgress({ currentAction: `Dropped stale pacing from saved run options — using current (faster) defaults`, logKind: 'ok' });
    }
    state.lastRunOpts = runOpts;
    await chrome.storage.local.set({ [STORAGE_KEY_LAST_RUN_OPTS]: runOpts }).catch(() => {});
    emitProgress({ currentAction: `Resuming previous run (${products.length} input products; ${state.doneProducts.length} already done)`, logKind: 'ok' });
  } else {
    return { ok: false, error: 'no products to discover — pick a product file first' };
  }

  state.running = true;
  state.stopRequested = false;
  state.pausedByCaptcha = false;
  state._runStartedAt = Date.now();
  if (!state.batchId) state.batchId = String(Date.now());
  state.lastStatus = 'Running';
  // Keep the screen on for the duration of the run. A 30+ product run
  // takes several hours and the user typically walks away; if the display
  // sleeps the visibility-throttling of the SERP tabs starts dropping
  // image loads and the CLIP model's offscreen sandbox occasionally times
  // out. 'display' level keeps both the screen and the system awake.
  // Released in the finally block of the engine wrapper below.
  try { chrome.power?.requestKeepAwake?.('display'); } catch {}
  // Set the run-intent flag BEFORE the engine starts. If we crash between
  // here and the first persistReport, the watchdog / onStartup paths will
  // re-enter and resume from the saved doneProducts list.
  await setRunIntent(true);
  await persistReport();

  // Rebuild the report Map using COMPOSITE keys (productUrl|keyword) so the
  // engine can find existing per-product rows on resume. Previously this Map
  // was keyed by keyword alone — when two products discovered the same
  // keyword, the second product's row silently merged into the first one's,
  // and its image_count inherited the first product's SERP-match result.
  // Per-product accuracy now: each (product, keyword) pair gets its own row,
  // its own SERP load, and its own image-match computation.
  //
  // Backwards-compat: rows persisted before this fix lack productUrl on the
  // synthesized side cases (none currently — productUrl is set on every row
  // since the engine added it in 3125). Still defensive — fall back to the
  // keyword-only key if productUrl is missing so old saved reports load.
  const reportMap = new Map();
  for (const r of state.report) {
    const k = (r.keyword || '').toLowerCase().trim();
    if (!k) continue;
    const pu = (r.productUrl || '').trim();
    reportMap.set(pu ? `${pu}|${k}` : k, r);
  }
  const excludeUrls = new Set(state.doneProducts);

  // Snapshot doneProducts.length BEFORE the engine runs. If the engine
  // exits without advancing this count AND no other "graceful pause" reason
  // applies (stop / CAPTCHA / all-done), we know the engine is stuck in
  // a state where it can't make progress (most commonly: the global
  // keyword cap is hit but products remain). Clear runIntent so the
  // watchdog stops trying to resume the same wedge over and over.
  // This is more reliable than the state.consecutiveNoProgressResumes
  // counter because state resets on every MV3 SW idle, but
  // state.doneProducts persists in chrome.storage.
  const doneBeforeRun = state.doneProducts.length;

  (async () => {
    try {
      await runKeywordDiscovery(
        products,
        (p) => {
          if (typeof p?.restUntil === 'number') state.restUntil = p.restUntil;
          emitProgress(p);
        },
        {
          ...runOpts,
          shouldStop: () => state.stopRequested,
          report: reportMap,
          excludeUrls,
          // Row-level batch_id: use the MANAGER's queueBatchId when in
          // distributed mode (workers claiming from the manager) so the
          // pushed rows match the manager's jobs table and pass the
          // batchExists orphan guard. Fall back to state.batchId (local
          // Date.now() id) only when queueBatchId is empty (local-file mode).
          //
          // This was the #1 root cause of the 'SKU done with 0 rows' pattern
          // this whole session: engine tagged every row with the local
          // runtime id (1734567890123-style), pushed to manager, orphan
          // guard rejected all rows because that id doesn't match any
          // batch in jobs. Fixed now — every row lands in the correct
          // manager-side batch.
          batchId: state.queueBatchId || state.batchId,
          shouldKeepKeyword,
          categorizeKeyword,
          computeAdRating,
          mergeKeywordIntoReport,
          handlesToSeeds,
          seedsAreSimilar,
          selectKpSeeds,
          buildProductContext,
          isRelevantToProduct,
          isBrandOnlyMatch,
          detectCategory,
          extractFormFactor,
          getWrongFormReason,
          classifyKeyword,
          extractProductSpecs,
          hasConflictingSpec,
          checkProductIdentity,
          hasSpecConfirmation,
          checkProductLineModifier,
          checkCompetitorBrand,
          buildSiblingExclusions,
          checkSiblingProduct,
          checkVariantSlot,
          checkColorConflict,
          checkNameSwap,
          parseQty,
          baseKey,
          checkSiblingAmbiguity,
          extractDiscriminatorTokens,
          checkBrandMate,
          familiesFor,
          computeProductFamilyValues,
          checkAttributeFamily,
          onRowAdded: async () => {
            state.report = Array.from(reportMap.values());
            await persistReport();
          },
          onProductDone: async (cleanUrl) => {
            if (!state.doneProducts.includes(cleanUrl)) {
              state.doneProducts.push(cleanUrl);
              await persistDone();
            }
            // ORDER MATTERS. We PUSH KEYWORDS FIRST, then markJobDone.
            // Previous order (markDone first, push after) caused the
            // 'phantom done' bug: worker died between the two calls,
            // job stays 'done' with zero keyword rows forever. New
            // order guarantees the manager either has the data OR the
            // job is still 'claimed' (heartbeat keeps the lock, other
            // workers won't touch it, this worker retries on next
            // tick). Enqueued pending pushes retry via alarm.
            //
            // Distributed mode: mark this job done in the shared queue
            // and drop it from this worker's claim list — DEFERRED
            // until after keywords are pushed.
            if (runOpts.autoExport) {
              const productRows = state.report.filter(r => r.productUrl === cleanUrl);
              if (productRows.length > 0) {
                try {
                  const filename = await exportSingleProductCSV(productRows, state.batchId);
                  emitProgress({ currentAction: `Auto-exported ${filename}`, logKind: 'ok' });
                } catch (e) {
                  emitProgress({ currentAction: `Auto-export failed: ${e.message}`, logKind: 'err' });
                }
              }
            }
            // DISTRIBUTED MODE: auto-push this product's keyword rows to
            // the manager RIGHT AWAY. Otherwise the manager's centralized
            // "Download all CSVs from the manager" would find the queue row
            // marked 'done' but ZERO actual keyword data, because that
            // data only goes to the manager via the manual "Push to AdBrain"
            // button. In distributed mode, every worker must push as it
            // goes — that's how the centralized download works at all.
            //
            // Reliability: any rows that fail to land on the first try
            // (transient HTTP 5xx, network blip, SW death mid-push) get
            // queued into _pendingPushes, which a separate alarm retries
            // up to PENDING_PUSH_MAX_ATTEMPTS times — surviving SW kill
            // via chrome.storage persistence. Result: data eventually
            // reaches the manager OR the manager sees a clear "retry
            // exhausted" log line. Either way no silent loss.
            if (state.workerId) {
              const productRows = state.report.filter(r => r.productUrl === cleanUrl);
              if (productRows.length === 0) {
                // No rows generated for this product — log so the
                // manager isn't left wondering why the batch says
                // "done" but the manager has nothing for it. Common reasons:
                // KP returned 0 ideas, all candidates failed the
                // relevance filter, the page was non-product, etc.
                emitProgress({
                  currentAction: `Product ${cleanUrl} completed with 0 keyword rows generated — nothing to push. Check KP / relevance filter / SERP.`,
                  logKind: 'warn',
                });
              } else {
                try {
                  const r = await pushToAdBrain(productRows);
                  // Detect orphan-batch rejections FIRST — the response
                  // shape is {success:0, failed:0, rejectedOrphan:N} which
                  // the naive "success > 0 = ok" branch used to treat as
                  // a successful zero-row push, silently marking the SKU
                  // done with 0 rows and advancing the cursor. This is the
                  // 'SKU done with empty rows' bug the user has been hitting
                  // all session. Trigger a drift-resync + retry via the
                  // pending-push queue with the CURRENT (manager-authoritative)
                  // batch id so the rows can land instead of being lost.
                  if (r.rejectedOrphan > 0) {
                    const newBatch = r.managerActiveBatchId || '';
                    emitProgress({
                      currentAction: `⛔ ORPHAN-BATCH REJECTION: ${r.rejectedOrphan}/${productRows.length} row(s) rejected because our cached batch id is stale. Manager's active batch is "${newBatch || 'unknown'}"; ours is "${state.queueBatchId}". Resyncing + queueing for retry.`,
                      logKind: 'err',
                    });
                    if (newBatch && newBatch !== state.queueBatchId) {
                      state.queueBatchId = newBatch;
                      try { await chrome.storage.local.set({ [STORAGE_KEY_QUEUE_BATCH_ID]: newBatch }); } catch {}
                    }
                    enqueuePendingPush(cleanUrl, productRows, newBatch || state.queueBatchId);
                  } else if (r.failed > 0) {
                    // Don't advance lastPushedCount and DO queue the
                    // failed product for retry. Previously the success
                    // count was used to advance the cursor, silently
                    // discarding the failed rows.
                    emitProgress({
                      currentAction: `Auto-push partial for ${cleanUrl}: ${r.success}/${productRows.length} landed, ${r.failed} queued for retry`,
                      logKind: 'warn',
                    });
                    enqueuePendingPush(cleanUrl, productRows, state.queueBatchId);
                  } else if (r.success === 0) {
                    // Guard against 'silently pushed 0 of N rows' — this
                    // should never legitimately happen (productRows.length > 0
                    // by construction here), but if a future bug makes it
                    // possible, don't advance the cursor and log loudly.
                    emitProgress({
                      currentAction: `⛔ AUTO-PUSH ZERO-SUCCESS: had ${productRows.length} row(s) to push but manager reported 0 inserted. Queueing for retry. Errors: ${(r.errors || []).slice(0, 2).join(' | ') || 'none reported'}`,
                      logKind: 'err',
                    });
                    enqueuePendingPush(cleanUrl, productRows, state.queueBatchId);
                  } else {
                    emitProgress({
                      currentAction: `✓ Auto-pushed ${r.success} row(s) for ${cleanUrl} to the manager`,
                      logKind: 'ok',
                    });
                    // Advance lastPushedCount ONLY on full success.
                    state.lastPushedCount = Math.max(
                      state.lastPushedCount,
                      state.report.length
                    );
                    await persistPushed();
                    // FLUSH this SKU's rows from local memory + storage now
                    // that the manager has the authoritative copy. Without
                    // this the local report grows unbounded across the batch
                    // and blows chrome.storage.local's quota (each row has
                    // matched_thumbnails / seller lists / etc. — a 20-SKU
                    // batch @ 300 kw/SKU × ~5 KB/row ≈ 30 MB local footprint).
                    // Reliability: only flush AFTER a fully-successful push
                    // (r.failed === 0 branch); on partial or exception we
                    // keep the rows locally so retries still have data.
                    for (const row of productRows) {
                      const kw = String(row.keyword || '').toLowerCase().trim();
                      const pu = String(row.productUrl || '').trim();
                      if (!kw) continue;
                      reportMap.delete(pu ? `${pu}|${kw}` : kw);
                    }
                    state.report = Array.from(reportMap.values());
                    await persistReport();
                    emitProgress({
                      currentAction: `Flushed ${productRows.length} row(s) from local memory — local report now ${state.report.length} row(s).`,
                      logKind: 'ok',
                    });
                  }
                } catch (e) {
                  // Network/auth failure on the whole push. Queue for
                  // retry — pendingPushAlarm will pick it up.
                  emitProgress({
                    currentAction: `Auto-push failed for ${cleanUrl} (${e.message}) — queued for retry. Dashboard will receive the data once the manager is reachable.`,
                    logKind: 'err',
                  });
                  enqueuePendingPush(cleanUrl, productRows, state.queueBatchId);
                }
              }
            }
            // NOW mark the job done in the shared queue (after the
            // push attempt above landed OR was queued to pending).
            // Same PATCH-then-drop-from-claim semantics as before.
            if (state.workerId && state.queueBatchId) {
              try {
                const r = await markJobDone({
                  workerId: state.workerId,
                  batchId:  state.queueBatchId,
                  productUrl: cleanUrl,
                });
                if (r && !r.error) {
                  const idx = state.claimedJobs.findIndex(j => j.productUrl === cleanUrl);
                  if (idx >= 0) {
                    state.claimedJobs.splice(idx, 1);
                    await chrome.storage.local.set({ [STORAGE_KEY_CLAIMED_JOBS]: state.claimedJobs }).catch(() => {});
                  }
                } else if (r && r.error) {
                  pushLog(`jobs:markDone retry-needed: ${r.error} — keeping in claim list so heartbeat keeps it locked`, 'err');
                }
              } catch (e) {
                pushLog(`jobs:markDone failed (will retry on heartbeat): ${e.message}`, 'err');
              }
            }
          },
          // Engine calls this when a product genuinely cannot be processed
          // (no product image, repeated KP failure, etc.). Distributed mode
          // marks the job as 'failed' with the reason so the manager
          // dashboard's failed-jobs panel populates with real entries +
          // worker attribution. Local mode just records it in doneProducts
          // to prevent infinite retry.
          onProductFailed: async (cleanUrl, reason) => {
            if (!state.doneProducts.includes(cleanUrl)) {
              state.doneProducts.push(cleanUrl);
              await persistDone();
            }
            // Push ANY partial rows the engine accumulated before the
            // failure. Without this, the rows sit orphaned in state.report
            // — the dashboard's centralized download misses them and
            // they're invisible until the user notices and clicks the
            // manual Push button. Pushing partials gives the manager
            // visibility into what was discovered before the abort.
            if (state.workerId) {
              const partialRows = state.report.filter(r => r.productUrl === cleanUrl);
              if (partialRows.length > 0) {
                try {
                  const r = await pushToAdBrain(partialRows);
                  if (r.failed > 0) {
                    enqueuePendingPush(cleanUrl, partialRows, state.queueBatchId);
                  }
                  emitProgress({
                    currentAction: `Pushed ${r.success}/${partialRows.length} partial row(s) for failed product ${cleanUrl}`,
                    logKind: 'warn',
                  });
                } catch (e) {
                  enqueuePendingPush(cleanUrl, partialRows, state.queueBatchId);
                  emitProgress({
                    currentAction: `Queued ${partialRows.length} partial row(s) for failed product ${cleanUrl} (push threw: ${e.message})`,
                    logKind: 'err',
                  });
                }
              }
            }
            if (state.workerId && state.queueBatchId) {
              try {
                await markJobFailed({
                  workerId:  state.workerId,
                  batchId:   state.queueBatchId,
                  productUrl: cleanUrl,
                  reason:    reason || 'unknown',
                });
              } catch (e) {
                pushLog(`jobs:markFailed warning: ${e.message}`, 'err');
              }
              const idx = state.claimedJobs.findIndex(j => j.productUrl === cleanUrl);
              if (idx >= 0) {
                state.claimedJobs.splice(idx, 1);
                await chrome.storage.local.set({ [STORAGE_KEY_CLAIMED_JOBS]: state.claimedJobs }).catch(() => {});
              }
            }
            bufferActivity({
              level: 'err',
              source: 'engine',
              message: `Product failed: ${cleanUrl} — ${reason || 'unknown'}`,
              productUrl: cleanUrl,
            });
          },
        }
      );
      state.report = Array.from(reportMap.values());
      state.restUntil = 0;
      await chrome.storage.local.remove([STORAGE_KEY_REST_UNTIL]).catch(() => {});
      const stopped = state.stopRequested;
      state.lastStatus = stopped
        ? `Stopped — ${state.report.length} keywords, ${state.doneProducts.length} products done`
        : `Done — ${state.report.length} keywords, ${state.doneProducts.length} products done`;
      // Clear run-intent on natural completion (every product processed).
      // User-initiated Stop ALSO clears it (in the stopDiscovery handler) so
      // the watchdog doesn't reverse the user's decision. CAPTCHA-paused runs
      // keep intent set so resumption is still automatic when the user
      // unblocks the SERP. Engine errors keep intent set so the watchdog can
      // retry — see the catch block below.
      const allProductsDone = state.lastProducts.length > 0 &&
        state.doneProducts.length >= state.lastProducts.length;
      if (allProductsDone && !stopped) {
        await setRunIntent(false);
      } else if (
        !stopped &&
        !allProductsDone &&
        !state.pausedByCaptcha &&
        state.doneProducts.length === doneBeforeRun
      ) {
        // Engine returned cleanly but made zero forward progress (no new
        // product marked done). Most common cause: global keyword cap
        // was already at/past ceiling on entry, so every product's
        // outer-loop check broke immediately. Clear runIntent so the
        // watchdog stops auto-resuming a wedge that can't unwedge
        // itself. Surface a clear instruction to the user.
        pushLog(
          `Engine returned without progress (${state.doneProducts.length}/${state.lastProducts.length} done, ${state.report.length} keywords). Most likely the global keyword cap is at ceiling — reload the extension (chrome://extensions → reload AdBrain) and click Resume. Clearing runIntent to stop the auto-resume loop.`,
          'err'
        );
        await setRunIntent(false);
      }
      await persistReport();
      // Honest summary at the end so the user can immediately tell if
      // the engine actually did the work. Previously the engine could
      // finish in 2-3 min with 0 keywords and no clear signal — looked
      // like "success" when it was really "skipped everything".
      const elapsedMin = Math.max(1, Math.round((Date.now() - (state._runStartedAt || Date.now())) / 60000));
      const kwPerProduct = state.doneProducts.length > 0
        ? Math.round(state.report.length / state.doneProducts.length)
        : 0;
      const healthLine = kwPerProduct < 20
        ? `⚠ Average ${kwPerProduct} keywords/product — likely KP URL missing or all keywords filtered. Expected 50-200+ per product.`
        : `✓ Average ${kwPerProduct} keywords/product over ${elapsedMin} min`;
      pushLog(`Run summary: ${state.report.length} total keywords across ${state.doneProducts.length} product(s) · ${elapsedMin} min · ${healthLine}`, kwPerProduct < 20 ? 'warn' : 'ok');
      broadcast({ action: 'discoveryDone', totalKeywords: state.report.length, stopped, doneProducts: state.doneProducts.length });
      // CONTINUOUS-CLAIM AUTO-LOOP — when the worker is in continuous
      // mode and the engine finishes without the user stopping it, claim
      // the next chunk from the same batch (or the newest pending batch
      // if queueBatchId is empty) and start the engine on it. Loops until
      // the queue is empty. Adds a small cooldown so workers don't
      // hammer the manager if the queue churns rapidly.
      if (state.continuousClaim && state.workerId && !stopped) {
        try {
          // Pick batch: prefer the one we were just working on; fall back
          // to whatever batch is newest with pending jobs (the manager
          // may have uploaded a new batch while we were processing the
          // previous one).
          let nextBatch = state.queueBatchId;
          if (!nextBatch) {
            nextBatch = await getActiveBatchId();
          }
          if (nextBatch) {
            if (isKpCooldownActive()) {
              pushLog('Continuous mode: KP cooldown active — skipping this claim cycle.', 'warn');
              break;
            }
            pushLog(`Continuous mode: claiming next chunk from batch ${nextBatch}…`, 'ok');
            // Small cooldown so we don't immediately re-fire if the manager
            // is briefly inconsistent.
            await new Promise(r => setTimeout(r, 3000));
            const jobs = await claimJobs({
              workerId: state.workerId,
              batchId:  nextBatch,
              limit:    state.continuousChunkSize || 5,
            }).catch(() => []);
            if (jobs.length > 0) {
              state.queueBatchId = nextBatch;
              state.claimedJobs  = jobs.map(j => ({ id: j.id, productUrl: j.product_url }));
              await chrome.storage.local.set({
                [STORAGE_KEY_QUEUE_BATCH_ID]: nextBatch,
                [STORAGE_KEY_CLAIMED_JOBS]:   state.claimedJobs,
              }).catch(() => {});
              const products = jobs.map(j => ({
                url: j.product_url, sku: j.sku,
                productName: j.product_name, priority: j.priority,
                handles: j.handles ? String(j.handles).split('|').filter(Boolean) : [],
                brands:  j.brands  ? String(j.brands).split('|').filter(Boolean)  : [],
              }));
              pushLog(`Continuous mode: claimed ${jobs.length} more job(s) — restarting engine`, 'ok');
              // Reset state.running so handleStart can re-enter, then
              // re-fire handleStart. Don't await — let it run async.
              setTimeout(() => handleStart({ products, ...(runOpts || {}) }).catch(e => {
                pushLog(`Continuous-claim re-start failed: ${e.message}`, 'err');
              }), 100);
            } else {
              pushLog(`Continuous mode: no more pending jobs in batch ${nextBatch} — stopping`, 'ok');
              state.continuousClaim = false;
              await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
            }
          } else {
            pushLog(`Continuous mode: no batches with pending work — stopping`, 'ok');
            state.continuousClaim = false;
            await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
          }
        } catch (e) {
          pushLog(`Continuous-claim error: ${e.message}`, 'err');
        }
      }
    } catch (err) {
      state.report = Array.from(reportMap.values());
      if (err.code === CAPTCHA_PAUSE_ERROR) {
        state.pausedByCaptcha = true;
        state.lastStatus = `${STATUS_PAUSED_CAPTCHA} — ${state.report.length} keywords, ${state.doneProducts.length} products done`;
      } else {
        state.lastStatus = `Error: ${err.message}`;
      }
      await persistReport();
      broadcast({
        action: 'discoveryDone',
        totalKeywords: state.report.length,
        error: err.message,
        captcha: err.code === CAPTCHA_PAUSE_ERROR,
        doneProducts: state.doneProducts.length,
      });
    } finally {
      state.running = false;
      state.stopRequested = false;
      try { chrome.power?.releaseKeepAwake?.(); } catch {}
    }
  })();

  return { ok: true };
}

async function handleResetProgress() {
  state.report = [];
  state.batchId = null;
  state.doneProducts = [];
  state.lastStatus = 'Idle';
  state.lastPushedCount = 0;
  state.log = [];
  state.lastProducts = [];
  state.lastRunOpts = null;
  state.restUntil = 0;
  state.pausedByCaptcha = false;
  state.runIntent = false;
  await chrome.storage.local.remove([
    STORAGE_KEY_LAST_REPORT,
    STORAGE_KEY_LAST_BATCH,
    STORAGE_KEY_LAST_STATUS,
    STORAGE_KEY_DONE_PRODUCTS,
    STORAGE_KEY_LAST_PUSHED_COUNT,
    STORAGE_KEY_LOG,
    STORAGE_KEY_REST_UNTIL,
    STORAGE_KEY_LAST_PRODUCTS,
    STORAGE_KEY_LAST_RUN_OPTS,
    STORAGE_KEY_RUN_INTENT,
    'adbrainKpCache',
  ]);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = msg?.action;

  if (action === 'getState') {
    coldStart.then(() => {
      sendResponse({
        running: state.running,
        reportSize: state.report.length,
        batchId: state.batchId,
        lastStatus: state.lastStatus,
        doneProducts: state.doneProducts.length,
        doneProductsList: state.doneProducts,
        lastPushedCount: state.lastPushedCount,
        unpushedCount: Math.max(0, state.report.length - state.lastPushedCount),
        log: state.log.slice(-LOG_MAX),
        restUntil: state.restUntil,
        pausedByCaptcha: state.pausedByCaptcha,
        // Resume is available when there is a persisted product list and at
        // least one product is still pending (i.e. not in doneProducts).
        canResume: state.lastProducts.length > 0 && state.doneProducts.length < state.lastProducts.length,
        totalProducts: state.lastProducts.length,
        // True when the run-intent flag is set — popup uses this to show
        // "auto-resume scheduled" instead of "Resume" so the user knows
        // the watchdog will pick this up after a crash without intervention.
        runIntent: state.runIntent,
        // Distributed-mode state for the Worker-tab live status block.
        workerId: state.workerId,
        queueBatchId: state.queueBatchId,
        claimedJobs: state.claimedJobs,
        continuousClaim: state.continuousClaim,
        workerArmed: state.workerArmed,
        connectionHealth: state.connectionHealth,
        pendingPushCount: _pendingPushes.length,
      });
    });
    return true;
  }

  if (action === 'startDiscovery') {
    coldStart.then(() => handleStart(msg)).then(sendResponse);
    return true;
  }

  // Resume = re-invoke the start path WITHOUT a products payload. handleStart
  // falls back to state.lastProducts + state.lastRunOpts, so progress carries
  // forward. The CAPTCHA-pause flag is cleared inside handleStart.
  if (action === 'resumeDiscovery') {
    coldStart.then(() => handleStart({ products: null })).then(sendResponse);
    return true;
  }

  if (action === 'stopDiscovery') {
    if (!state.running) { sendResponse({ ok: false, error: 'not running' }); return false; }
    state.stopRequested = true;
    // Clear the run-intent flag so the watchdog / onStartup hooks don't
    // immediately re-launch the run after the user asked us to stop.
    setRunIntent(false).catch(() => {});
    // Also turn OFF continuous-claim mode AND disarm the worker so the
    // auto-poll alarm doesn't immediately re-fire. Stop must mean
    // "stop for real" — the worker now requires another explicit
    // Connect click to start polling again.
    state.continuousClaim = false;
    state.workerArmed = false;
    state.userStoppedArm = true;
    chrome.storage.local.set({
      adbrainContinuousClaim: false,
      adbrainWorkerArmed: false,
      adbrainUserStoppedArm: true,
    }).catch(() => {});
    // Release any not-yet-processed claims back to pending so the dashboard
    // doesn't show '6 in-flight' after a Stop, and other workers can grab
    // those SKUs immediately. Fire-and-forget — Stop already resolved.
    releaseThisWorkerClaims('Local Stop button').catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (action === 'resetProgress') {
    if (state.running) { sendResponse({ ok: false, error: 'cannot reset while running' }); return false; }
    coldStart.then(() => handleResetProgress()).then(sendResponse);
    return true;
  }

  if (action === 'clearLog') {
    state.log = [];
    chrome.storage.local.remove([STORAGE_KEY_LOG]).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // Content scripts (kp.js, serp-reader.js) send their step logs here so they
  // land in the persistent buffer AND get broadcast to the panel.
  if (action === 'logFromContent') {
    emitProgress({
      currentAction: msg.text,
      logKind: msg.kind,
      currentSource: msg.source || 'content',
    });
    sendResponse({ ok: true });
    return false;
  }

  // KP's multi-seed loop polls this between seeds so a Stop click during a
  // long KP run is honored without waiting for all seeds to finish.
  if (action === 'kpCheckStop') {
    sendResponse({ stop: !!state.stopRequested });
    return false;
  }

  // KP's manual-fallback: when synthetic clicks fail, the content script asks
  // background to bring its tab to the foreground so the user can click it.
  if (action === 'activateMyTab') {
    if (sender.tab?.id) {
      chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
      if (sender.tab.windowId) {
        chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (action === 'exportDiscovery') {
    const fmt = msg.format || 'csv';
    (async () => {
      try {
        const filenames = fmt === 'xlsx'
          ? await toXLSX(state.report, state.batchId)
          : await toCSV(state.report, state.batchId);
        sendResponse({ ok: true, filenames, count: filenames.length });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ── Distributed mode ──────────────────────────────────────────────
  // Manager uploads a parsed product list to the shared jobs table.
  if (action === 'jobs:upload') {
    (async () => {
      try {
        const result = await uploadJobsToManager(msg.products || [], msg.batchId || state.batchId || String(Date.now()));
        sendResponse({ ok: true, ...result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Worker claims a chunk of pending jobs from the shared queue and
  // hands them straight to handleStart as the products list. Stores
  // the claim rows on state so heartbeat + markJobDone can find them.
  if (action === 'jobs:claimAndStart') {
    (async () => {
      try {
        const workerId = (msg.workerId || state.workerId || '').trim();
        const batchId  = (msg.batchId  || state.queueBatchId || '').trim();
        const limit    = Math.max(1, Math.min(50, Number(msg.limit) || 5));
        if (!workerId) throw new Error('Set a Worker ID in Settings first.');
        if (!batchId)  throw new Error('Pick a batch in the Manager tab first.');
        // Release any stale claims from crashed PCs before our claim — so
        // we pick them up too. Cheap, idempotent, distributed cleanup.
        const r = await releaseStaleJobs(10).catch(() => null);
        if (r && r.released > 0) pushLog(`Released ${r.released} stale claim(s) from offline workers`, 'ok');
        if (isKpCooldownActive()) {
          sendResponse({ ok: false, error: 'KP session cooldown active. Fix the Google Ads / KP session first, then use Force reconnect.' });
          return;
        }
        const jobs = await claimJobs({ workerId, batchId, limit });
        if (jobs.length === 0) {
          sendResponse({ ok: true, claimed: 0, message: 'no pending jobs in this batch' });
          return;
        }
        // Persist worker identity + current claims so the heartbeat alarm
        // can find them after an SW restart. If storage.set fails (quota
        // exceeded, profile lock), fail the claim — otherwise the engine
        // would start with in-memory claims that wouldn't survive an SW
        // teardown, and after 10 min of no heartbeat the jobs would be
        // released and reclaimed by another worker → double-processing.
        state.workerId     = workerId;
        state.queueBatchId = batchId;
        state.claimedJobs  = jobs.map(j => ({ id: j.id, productUrl: j.product_url }));
        // Manual claim → explicitly turn OFF continuous mode. A "Both"
        // user who previously hit "Connect & start working" still has
        // state.continuousClaim=true; we don't want the manual one-shot
        // claim to silently auto-loop afterwards.
        state.continuousClaim = false;
        try {
          await chrome.storage.local.set({
            [STORAGE_KEY_WORKER_ID]:      workerId,
            [STORAGE_KEY_QUEUE_BATCH_ID]: batchId,
            [STORAGE_KEY_CLAIMED_JOBS]:   state.claimedJobs,
            adbrainContinuousClaim:       false,
          });
        } catch (e) {
          // Storage failed — release our claims so another worker can pick
          // them up (rather than letting them sit locked for 10 min).
          pushLog(`Storage persist failed (${e.message}) — releasing claims and aborting`, 'err');
          await releaseStaleJobs(0).catch(() => {});  // 0 minutes = release ALL claims (will only hit those still 'claimed')
          state.claimedJobs = [];
          throw new Error(`Could not persist claim list: ${e.message}`);
        }
        // Set runIntent BEFORE awaiting handleStart so a crash during the
        // first product still triggers auto-resume via the watchdog. The
        // main startDiscovery handler sets this inside handleStart's body;
        // claim-and-start bypasses some of that path so we set it here.
        await setRunIntent(true);
        pushLog(`Claimed ${jobs.length} job(s) from queue (batch ${batchId}, worker ${workerId})`, 'ok');
        // Hand the claimed rows to handleStart as if the user had loaded
        // them from a file. Shape matches what popup.js sends on Start.
        const products = jobs.map(j => ({
          url:         j.product_url,
          sku:         j.sku,
          productName: j.product_name,
          priority:    j.priority,
          handles:     j.handles ? String(j.handles).split('|').filter(Boolean) : [],
          brands:      j.brands  ? String(j.brands).split('|').filter(Boolean)  : [],
        }));
        const startResult = await handleStart({
          products,
          ...(msg.runOpts || {}),
        });
        sendResponse({ ok: true, claimed: jobs.length, products, startResult });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Manager tab — live batch summary (counts by status, per batch).
  if (action === 'jobs:summary') {
    (async () => {
      try {
        const summary = await getJobSummary();
        const focusBatch = msg.batchId;
        let workers = [];
        let failed  = [];
        if (focusBatch) {
          // Fetch worker breakdown + failed list in parallel.
          [workers, failed] = await Promise.all([
            getActiveWorkers(focusBatch).catch(() => []),
            getFailedJobs(focusBatch, 50).catch(() => []),
          ]);
        }
        sendResponse({ ok: true, summary, workers, failed });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Manager pushes settings to all workers via the shared config table.
  // Workers fetch this row before each claim and merge the non-null fields
  // into their local runOpts. Change once, take effect on every PC.
  if (action === 'jobs:saveWorkerConfig') {
    (async () => {
      try {
        const updates = msg.updates || {};
        const result = await saveWorkerConfig(updates, msg.managerId || state.workerId || 'manager');
        sendResponse({ ok: true, config: result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // On-demand connection health check (popup + dashboard "Refresh
  // connection" button). Fires pingConnectionHealth and returns the
  // fresh result inline so the UI shows the up-to-date status.
  if (action === 'jobs:checkConnection') {
    (async () => {
      await pingConnectionHealth();
      sendResponse({ ok: true, health: state.connectionHealth, pendingPushCount: _pendingPushes.length });
    })();
    return true;
  }
  if (action === 'jobs:fetchWorkerConfig') {
    (async () => {
      try {
        const cfg = await fetchWorkerConfig();
        sendResponse({ ok: true, config: cfg });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Manager pins a specific batch as the one all workers should focus
  // on. Pass batchId=null to clear the pin and revert to "newest
  // pending" auto-pick. Every armed worker will pick up the change
  // on its next auto-poll tick (within 30s).
  // Live per-batch keyword-output stats for the dashboard.
  if (action === 'dashboard:batchKeywordStats') {
    (async () => {
      try {
        const stats = await fetchBatchKeywordStats(msg.batchId, msg.limit || 50);
        sendResponse({ ok: true, stats });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Manager triggers cleanup of old activity log + acked commands.
  // Activity log retention default 7 days, acked commands default 1 day.
  // Keyword data + job rows are NEVER auto-deleted (user data).
  if (action === 'jobs:cleanup') {
    (async () => {
      try {
        const result = await cleanupOldData({
          logDays:      Math.max(1, Number(msg.logDays) || 7),
          commandsDays: Math.max(1, Number(msg.commandsDays) || 1),
        });
        sendResponse({ ok: true, ...result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (action === 'jobs:setActiveBatch') {
    (async () => {
      try {
        const batchId = (msg.batchId || '').trim() || null;
        const result = await saveWorkerConfig({ active_batch_id: batchId }, msg.managerId || state.workerId || 'manager');
        sendResponse({ ok: true, pinned: batchId, config: result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // Worker one-button connect: auto-detect the newest pending batch,
  // claim a chunk, start the engine, and enable continuous-claim so the
  // worker keeps pulling chunks until the queue is empty or the user
  // hits Stop. Replaces the manual Batch-ID-paste + Chunk-size + Claim
  // flow for the common case where a worker just wants to "go".
  if (action === 'jobs:autoConnectWorker') {
    _doAutoConnectWorker(msg).then(sendResponse);
    return true;
  }
  // Legacy inline block preserved below solely to keep the diff small —
  // it's unreachable because the branch above returns early. Retained
  // during a follow-up cleanup.
  if (false && action === 'jobs:autoConnectWorker') {
    (async () => {
      try {
        const workerId = (msg.workerId || state.workerId || '').trim();
        if (!workerId) throw new Error('Set a Worker ID first.');
        // Bail clearly if the engine is already running. Without this
        // check, a re-apply of setup code or a stray Wake command would
        // silently return "already running" from handleStart with no
        // user-visible feedback.
        if (state.running || state.starting) {
          pushLog(`Auto-connect ignored: engine already running. Worker stays armed; will pick up next chunk when this one finishes.`, 'info');
          sendResponse({ ok: true, claimed: 0, message: 'engine already running — already armed' });
          return;
        }
        const chunkSize = Math.max(1, Math.min(50, Number(msg.chunkSize) || 5));
        const explicitBatch = (msg.batchId || '').trim();
        const batchId = explicitBatch || (await getActiveBatchId());
        if (!batchId) {
          sendResponse({ ok: false, error: 'No batches with pending work found. Ask the manager to upload a batch first.' });
          return;
        }
        // Mark this run as continuous AND armed BEFORE starting. The
        // armed flag persists across browser restart + engine completion
        // so the worker auto-resumes pulling work from any new batch
        // the manager uploads — without the user needing to click
        // Connect again on each PC.
        state.continuousClaim = true;
        state.continuousChunkSize = chunkSize;
        state.workerId = workerId;
        state.workerArmed = true;
        // User explicitly armed this PC — clear the "user stopped"
        // flag so future Wake broadcasts will be honored again.
        state.userStoppedArm = false;
        await chrome.storage.local.set({
          [STORAGE_KEY_WORKER_ID]: workerId,
          adbrainContinuousClaim: true,
          adbrainContinuousChunkSize: chunkSize,
          adbrainWorkerArmed: true,
          adbrainUserStoppedArm: false,
        }).catch(() => {});
        // Release any stale claims from offline workers first.
        await releaseStaleJobs(10).catch(() => null);
        // Fetch the manager's pushed config (KP URL, pacing, profile,
        // caps) BEFORE claiming so the engine starts with the central
        // settings. Worker's local Settings tab is now a fallback only.
        let centralConfig = null;
        try { centralConfig = await fetchWorkerConfig(); } catch {}
        const centralRunOpts = centralConfig ? workerConfigToRunOpts(centralConfig) : {};
        if (centralRunOpts.kpUrl) {
          // Mirror the central KP URL into chrome.storage so the KP
          // content script (which reads from storage) picks it up.
          await chrome.storage.local.set({ [STORAGE_KEY_KP_URL]: centralRunOpts.kpUrl }).catch(() => {});
        }
        // HARD GUARD: KP URL is mandatory. Without it, the engine
        // skips KP entirely, processes a product in 2-3 min instead
        // of the 10-15 min it should take, generates almost no
        // keyword rows, and silently marks the job done. Bail loudly
        // here with a clear next step.
        const localKpUrl = (await chrome.storage.local.get([STORAGE_KEY_KP_URL]))[STORAGE_KEY_KP_URL] || '';
        const effectiveKpUrl = (centralRunOpts.kpUrl || localKpUrl || '').trim();
        if (!effectiveKpUrl || !effectiveKpUrl.includes('ads.google.com')) {
          sendResponse({
            ok: false,
            error: 'No Keyword Planner URL configured. Manager: Settings → paste your Google Ads KP URL → Save Settings (also pushes to all workers). Without this, the engine skips KP entirely and processes each product in 2-3 minutes producing almost no keywords.',
          });
          return;
        }
        // Claim a chunk and start the engine (re-uses the existing
        // claimAndStart code path).
        if (isKpCooldownActive()) {
          sendResponse({ ok: false, error: 'KP session cooldown active. Fix Google Ads / KP session first, then Force reconnect.' });
          return;
        }
        const jobs = await claimJobs({ workerId, batchId, limit: chunkSize });
        if (jobs.length === 0) {
          // Nothing to claim right now — clear continuous flag so we
          // don't infinite-loop, and report back.
          state.continuousClaim = false;
          await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
          sendResponse({ ok: true, claimed: 0, batchId, message: 'No pending jobs in this batch right now.' });
          return;
        }
        state.queueBatchId = batchId;
        state.claimedJobs  = jobs.map(j => ({ id: j.id, productUrl: j.product_url }));
        await chrome.storage.local.set({
          [STORAGE_KEY_QUEUE_BATCH_ID]: batchId,
          [STORAGE_KEY_CLAIMED_JOBS]:   state.claimedJobs,
        }).catch(() => {});
        await setRunIntent(true);
        // Log what came from the manager's pushed config so the worker
        // log shows who's in charge of pacing / profile / KP URL.
        const centralKeys = Object.keys(centralRunOpts);
        const centralNote = centralKeys.length > 0
          ? ` · applied ${centralKeys.length} setting(s) from manager: ${centralKeys.slice(0, 6).join(', ')}`
          : '';
        pushLog(`Auto-connect: claimed ${jobs.length} job(s) from batch "${batchId}" — continuous mode ON${centralNote}`, 'ok');
        const products = jobs.map(j => ({
          url: j.product_url, sku: j.sku,
          productName: j.product_name, priority: j.priority,
          handles: j.handles ? String(j.handles).split('|').filter(Boolean) : [],
          brands:  j.brands  ? String(j.brands).split('|').filter(Boolean)  : [],
        }));
        // Merge order: manager's central config WINS over the caller's
        // runOpts (the worker's local Settings tab values), which still
        // beat hard-coded defaults. So the manager truly controls every
        // worker; local settings are only a fallback when the manager
        // hasn't pushed a value for a given field.
        const mergedRunOpts = { ...(msg.runOpts || {}), ...centralRunOpts };
        const startResult = await handleStart({ products, ...mergedRunOpts });
        sendResponse({ ok: true, claimed: jobs.length, batchId, startResult, centralConfig: !!centralConfig });
      } catch (e) {
        // Always send a useful error string. If e is a plain Error,
        // .message works; if it's an object or null, fall back to
        // toString / JSON / stack so we never collapse to "unknown".
        const errStr = (e && e.message) || (e && e.toString && e.toString()) || JSON.stringify(e) || 'unspecified exception in autoConnectWorker';
        sendResponse({ ok: false, error: errStr, stack: e?.stack?.split('\n')?.[1]?.trim() });
      }
    })();
    return true;
  }
  // Worker explicitly turns OFF continuous mode (without stopping the
  // current engine run).
  if (action === 'jobs:stopContinuous') {
    (async () => {
      state.continuousClaim = false;
      await chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Dashboard handlers ──────────────────────────────────────────────
  // Fetch activity log entries since a timestamp (incremental polling).
  if (action === 'dashboard:fetchLog') {
    (async () => {
      try {
        const entries = await fetchActivityLog({
          batchId: msg.batchId,
          sinceTs: msg.sinceTs,
          level:   msg.level,
          workerId: msg.workerId,
          limit:   msg.limit || 200,
        });
        sendResponse({ ok: true, entries });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Per-worker stats from the adbrain_worker_stats view.
  if (action === 'dashboard:workerStats') {
    (async () => {
      try {
        const stats = await fetchWorkerStats(msg.batchId);
        sendResponse({ ok: true, stats });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Per-product status grid.
  if (action === 'dashboard:perProduct') {
    (async () => {
      try {
        const rows = await fetchPerProductStatus(msg.batchId, msg.limit || 500);
        sendResponse({ ok: true, rows });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Send a command to one or all workers (workerId = null → broadcast).
  if (action === 'dashboard:sendCommand') {
    (async () => {
      try {
        const result = await sendWorkerCommand({
          workerId: msg.workerId || null,
          command:  msg.command,
          payload:  msg.payload,
          managerId: state.workerId || 'manager',
        });
        sendResponse({ ok: true, command: result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Open the dashboard in a new browser tab.
  if (action === 'dashboard:open') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    sendResponse({ ok: true });
    return false;
  }

  // Manager UI — re-queue a single failed job by id.
  if (action === 'jobs:requeue') {
    (async () => {
      try {
        const result = await requeueJob(msg.jobId);
        sendResponse({ ok: !!result.updated, ...result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Manual stale release for the Manager UI's "Release stale" button.
  if (action === 'jobs:releaseStale') {
    (async () => {
      try {
        const result = await releaseStaleJobs(Number(msg.staleMinutes) || 10);
        sendResponse({ ok: true, ...result });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // Manager UI — pull every row for a batch back from the manager and
  // generate the per-SKU CSVs locally on THIS PC. Solves the "CSVs are
  // scattered across worker PCs' Downloads folders" problem — manager
  // runs this once, gets one .csv per SKU for the entire batch,
  // grouped under Downloads/adbrain_<batchId>/ so multiple batches
  // don't intermingle.
  if (action === 'jobs:downloadBatchCsvs') {
    (async () => {
      try {
        const batchId = String(msg.batchId || '').trim();
        if (!batchId) throw new Error('Batch ID required.');
        emitProgress({ currentAction: `Fetching report rows for batch "${batchId}" from the manager…`, logKind: 'ok' });
        const report = await fetchBatchReportFromManager(batchId, (p) => {
          emitProgress({ currentAction: `Fetched ${p.fetched} row(s)…`, logKind: 'ok' });
        });
        if (report.length === 0) {
          sendResponse({ ok: true, filenames: [], count: 0, message: 'no rows in batch' });
          return;
        }
        // Folder name: "adbrain_<batchId>" — the _safeFolder helper inside
        // discovery-export strips any path-traversal or filename-unsafe
        // characters, so user-supplied batch IDs are sanitised.
        const folder = `adbrain_${batchId}`;
        emitProgress({ currentAction: `Generating CSVs from ${report.length} rows into "${folder}/"…`, logKind: 'ok' });
        const filenames = await toCSV(report, batchId, { folder });
        emitProgress({ currentAction: `✓ Downloaded ${filenames.length} CSV(s) into Downloads/${folder}/`, logKind: 'ok' });
        sendResponse({ ok: true, filenames, count: filenames.length, rows: report.length, folder });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  // Manager UI — credentials check + inline save so worker PCs don't
  // have to navigate to the Settings tab. Mirrors the same storage keys
  // the Settings tab writes to.
  if (action === 'jobs:credsStatus') {
    (async () => {
      const data = await chrome.storage.local.get([STORAGE_KEY_MANAGER_URL, STORAGE_KEY_MANAGER_TOKEN]);
      const url = String(data[STORAGE_KEY_MANAGER_URL] || '').trim();
      const token = String(data[STORAGE_KEY_MANAGER_TOKEN] || '').trim();
      sendResponse({
        ok: true,
        hasManagerUrl: url.length > 4,
        hasManagerToken: token.length > 0,
        managerUrl: url,
      });
    })();
    return true;
  }
  if (action === 'jobs:saveCreds') {
    (async () => {
      const updates = {};
      if (typeof msg.managerToken === 'string') {
        // Token is optional (manager may run un-authenticated on tailnet).
        // Empty string clears it.
        updates[STORAGE_KEY_MANAGER_TOKEN] = msg.managerToken.trim();
      }
      if (typeof msg.managerUrl === 'string' && msg.managerUrl.trim()) {
        // Normalise the URL: strip any path so ".../api/keywords" or a
        // trailing slash both collapse to `http://host:port`. The client
        // appends its own paths.
        const raw = msg.managerUrl.trim();
        let normalized;
        try {
          const u = new URL(raw);
          normalized = `${u.protocol}//${u.host}`;
        } catch {
          normalized = raw.replace(/\/+$/, '').replace(/^(https?:\/\/[^/]+)\/.*$/, '$1');
        }
        updates[STORAGE_KEY_MANAGER_URL] = normalized;
      }
      if (Object.keys(updates).length === 0) {
        sendResponse({ ok: false, error: 'nothing to save' });
        return;
      }
      await chrome.storage.local.set(updates);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Generate a one-string setup code that bundles managerUrl + optional
  // token as base64-encoded JSON. Manager generates once, workers paste
  // once — one-paste onboarding across PCs. Token IS exposed in the
  // code so users must share it only over encrypted channels (the UI
  // shows a warning when a token is present).
  if (action === 'jobs:exportSetupCode') {
    (async () => {
      const data = await chrome.storage.local.get([
        STORAGE_KEY_MANAGER_URL,
        STORAGE_KEY_MANAGER_TOKEN,
        STORAGE_KEY_KP_URL,
      ]);
      const url = String(data[STORAGE_KEY_MANAGER_URL] || '').trim();
      const token = String(data[STORAGE_KEY_MANAGER_TOKEN] || '').trim();
      const kpUrl = String(data[STORAGE_KEY_KP_URL] || '').trim();
      if (!url) {
        sendResponse({ ok: false, error: 'Save Manager URL first.' });
        return;
      }
      // Encode as `adb2:<base64>` — bump prefix to make older the manager
      // codes fail loudly instead of applying garbage. Payload version
      // stays for forward-compat.
      const payload = JSON.stringify({ v: 3, managerUrl: url, managerToken: token, kpUrl });
      const b64 = btoa(unescape(encodeURIComponent(payload)));
      sendResponse({
        ok: true,
        code: `adb2:${b64}`,
        includes: { kpUrl: !!kpUrl, token: !!token },
      });
    })();
    return true;
  }
  if (action === 'jobs:importSetupCode') {
    (async () => {
      try {
        const raw = String(msg.code || '').trim();
        if (raw.startsWith('adb1:')) {
          throw new Error('This is an old the manager setup code. Ask the manager for a fresh code (starts with "adb2:").');
        }
        if (!raw.startsWith('adb2:')) {
          throw new Error('Not a valid setup code (expected to start with "adb2:").');
        }
        const b64 = raw.slice(5);
        let payload;
        try {
          payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
        } catch {
          throw new Error('Could not decode setup code — paste the exact string the manager generated.');
        }
        if (!payload || payload.v !== 3 || !payload.managerUrl) {
          throw new Error('Setup code is missing required fields.');
        }
        let normalized;
        try {
          const u = new URL(payload.managerUrl);
          normalized = `${u.protocol}//${u.host}`;
        } catch {
          normalized = String(payload.managerUrl).replace(/\/+$/, '').replace(/^(https?:\/\/[^/]+)\/.*$/, '$1');
        }
        const updates = {
          [STORAGE_KEY_MANAGER_URL]: normalized,
          [STORAGE_KEY_MANAGER_TOKEN]: String(payload.managerToken || '').trim(),
        };
        // Bring the manager's KP URL along too, so workers don't have
        // to navigate to Settings → Keyword Planner to paste it. Without
        // a KP URL the engine can't run KP scrapes. Empty kpUrl in the
        // code is OK (manager hadn't saved one yet); we leave the
        // worker's existing KP URL untouched in that case.
        if (payload.kpUrl) {
          updates[STORAGE_KEY_KP_URL] = String(payload.kpUrl).trim();
        }
        await chrome.storage.local.set(updates);
        // Verify the manager is actually reachable before we call the
        // import "successful". Without this, a stale or wrong-network
        // setup code silently saves bad settings and the first heartbeat
        // fails later with a cryptic message. A quick /api/health ping
        // catches URL typos, wrong ports, expired tunnels, wrong tokens
        // (401), and manager-offline in one shot.
        try {
          const healthResp = await fetch(`${normalized}/api/health`, {
            method: 'GET',
            headers: updates[STORAGE_KEY_MANAGER_TOKEN]
              ? { 'X-Manager-Token': updates[STORAGE_KEY_MANAGER_TOKEN] }
              : {},
            signal: AbortSignal.timeout(5000),
          });
          if (!healthResp.ok) {
            const detail = healthResp.status === 401
              ? 'Token was rejected — the setup code may be stale. Ask the manager for a fresh one.'
              : `Manager responded with HTTP ${healthResp.status}.`;
            throw new Error(`Manager reachable but not healthy: ${detail}`);
          }
          const health = await healthResp.json().catch(() => ({}));
          if (!health.ok) throw new Error('Manager health check returned ok=false.');
        } catch (verifyErr) {
          // Save partially-applied settings but WARN clearly. The user
          // can still choose to keep them (in case the manager is
          // temporarily down) or clear them.
          sendResponse({
            ok: false,
            saved: true,
            error: `Settings saved but manager isn't reachable at ${normalized}: ${verifyErr.message}`,
          });
          return;
        }
        sendResponse({ ok: true, applied: { kpUrl: !!updates[STORAGE_KEY_KP_URL] }, verified: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // Settings tab — set/get this worker's identity.
  if (action === 'jobs:setWorkerId') {
    (async () => {
      const id = String(msg.workerId || '').trim();
      state.workerId = id;
      await chrome.storage.local.set({ [STORAGE_KEY_WORKER_ID]: id });
      sendResponse({ ok: true, workerId: id });
    })();
    return true;
  }

  if (action === 'pushDiscovery') {
    (async () => {
      try {
        // Snapshot length first — discovery may still be running and adding rows.
        const snapshotLength = state.report.length;
        const startIdx = Math.min(state.lastPushedCount, snapshotLength);
        const slice = state.report.slice(startIdx, snapshotLength);
        if (slice.length === 0) {
          sendResponse({ ok: true, success: 0, failed: 0, total: 0, totalInReport: snapshotLength, message: 'nothing new to push' });
          return;
        }
        const result = await pushToAdBrain(slice);
        // Advance the cursor only if every row in the slice landed (or at least
        // didn't fail — the manager's ignore-duplicates returns 200/201 even when
        // rows were skipped, so failed===0 means we're safe to advance).
        if (result.failed === 0) {
          state.lastPushedCount = snapshotLength;
          await persistPushed();
        }
        sendResponse({ ok: true, ...result, totalInReport: snapshotLength, pushedSoFar: state.lastPushedCount });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});
