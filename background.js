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
  getJobSummary,
  getActiveWorkers,
  getFailedJobs,
  requeueJob,
  fetchBatchReportFromSupabase,
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
} from './modules/discovery-jobs.js';
import {
  STORAGE_KEY_SERVICE_KEY,
  STORAGE_KEY_SUPABASE_URL,
  STORAGE_KEY_KP_URL,
} from './config/discovery-config.js';
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
  // Empty array / null = local mode (file-driven), no Supabase coordination.
  workerId: '',
  queueBatchId: '',
  claimedJobs: [],
  // Continuous-claim mode: when true, after the engine finishes processing
  // a claimed chunk, the worker AUTOMATICALLY claims the next chunk from
  // the same batch (or the newest pending batch if queueBatchId is empty).
  // Loops until the queue is empty or the user clicks Stop. Set by the
  // worker UI's "Connect & start working" button.
  continuousClaim: false,
  continuousChunkSize: 5,
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
  ]);
  // Restore activity buffer from before SW death so we don't lose recent
  // events that hadn't been pushed to Supabase yet.
  if (Array.isArray(data.adbrainActivityBuffer)) {
    _activityBuffer.push(...data.adbrainActivityBuffer);
  }
  if (typeof data[STORAGE_KEY_WORKER_ID] === 'string')      state.workerId = data[STORAGE_KEY_WORKER_ID];
  if (typeof data[STORAGE_KEY_QUEUE_BATCH_ID] === 'string') state.queueBatchId = data[STORAGE_KEY_QUEUE_BATCH_ID];
  if (Array.isArray(data[STORAGE_KEY_CLAIMED_JOBS]))         state.claimedJobs = data[STORAGE_KEY_CLAIMED_JOBS];
  if (typeof data.adbrainContinuousClaim === 'boolean')      state.continuousClaim = data.adbrainContinuousClaim;
  if (typeof data.adbrainContinuousChunkSize === 'number')   state.continuousChunkSize = data.adbrainContinuousChunkSize;
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
    await chrome.storage.local.remove([STORAGE_KEY_RUN_INTENT]).catch(() => {});
  }
}

// Returns true when there is unfinished work AND the user wants it to
// continue (didn't explicitly Stop or Reset). Used by every auto-resume
// trigger so each path applies the same eligibility check.
function shouldAutoResume() {
  if (state.running) return false;
  if (!state.runIntent) return false;
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
// in-memory log buffer to Supabase so the manager dashboard's activity
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

// In-memory activity log buffer. Drained every 30s by the alarm AND
// immediately on high-impact events (errors, product done/failed). Capped
// to avoid runaway memory on long runs. Also periodically persisted to
// chrome.storage so SW death doesn't lose recent events that haven't
// hit Supabase yet.
const _activityBuffer = [];
const ACTIVITY_BUFFER_CAP = 500;
const ACTIVITY_STORAGE_KEY = 'adbrainActivityBuffer';
let _activityPersistTimer = null;
let _activityFlushScheduled = false;

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
  // Immediate flush for high-impact events so dashboard sees them within
  // a few seconds instead of waiting for the 30s alarm.
  const isUrgent = entry.level === 'err' || entry.level === 'warn'
    || /product (complete|partial|failed)/i.test(entry.message)
    || /captcha/i.test(entry.message);
  if (isUrgent && !_activityFlushScheduled) {
    _activityFlushScheduled = true;
    setTimeout(() => { _activityFlushScheduled = false; flushActivityBuffer(); }, 1000);
  }
}

async function flushActivityBuffer() {
  if (_activityBuffer.length === 0) return;
  const slice = _activityBuffer.splice(0, _activityBuffer.length);
  try {
    const r = await pushActivityLog(slice);
    if (r.error) {
      // On push failure, re-buffer (capped) so we don't lose every
      // entry permanently to one transient network error.
      _activityBuffer.unshift(...slice.slice(0, 100));
    }
  } catch {
    _activityBuffer.unshift(...slice.slice(0, 100));
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
          bufferActivity({ level: 'warn', source: 'cmd', message: `Stop command received from manager — halting after current product.` });
        } else if (c.command === 'pause') {
          // For now treat pause same as stop (graceful halt). True pause
          // requires engine-level pause primitives that don't exist yet.
          state.stopRequested = true;
          bufferActivity({ level: 'warn', source: 'cmd', message: `Pause command received — halting (no resumable pause primitive yet).` });
        } else if (c.command === 'release_claims') {
          // Release this worker's claims back to pending.
          await releaseStaleJobs(0).catch(() => {});
          state.claimedJobs = [];
          await chrome.storage.local.set({ [STORAGE_KEY_CLAIMED_JOBS]: [] }).catch(() => {});
          bufferActivity({ level: 'warn', source: 'cmd', message: `Release-claims command received — claims back to queue.` });
        }
        await acknowledgeCommand(c.id, state.workerId);
      } catch {}
    }
  } catch {}
}

async function tickHeartbeat() {
  try {
    await coldStart;
    if (!state.workerId) return;
    const jobIds = state.claimedJobs.map(j => j.id).filter(Boolean);
    if (jobIds.length === 0) return;
    const r = await heartbeatClaims(state.workerId, jobIds);
    if (r.error) pushLog(`Heartbeat warning: ${r.error}`, 'err');
  } catch (e) {
    pushLog(`Heartbeat failed: ${e.message}`, 'err');
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM)        return void tryAutoResume('watchdog');
  if (alarm.name === HEARTBEAT_ALARM)       return void tickHeartbeat();
  if (alarm.name === DASHBOARD_PUSH_ALARM)  return void flushActivityBuffer();
  if (alarm.name === COMMAND_POLL_ALARM)    return void pollWorkerCommands();
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
          batchId: state.batchId,
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
            // Distributed mode: mark this job done in the shared queue
            // and drop it from this worker's claim list. Other workers
            // can now see it as done; heartbeat skips it on the next tick.
            //
            // Don't gate on claimedJobs.length > 0 — if the worker crashed
            // and resumed without persisting claimedJobs, the in-flight
            // row is still claimed in the DB and we need to attempt the
            // PATCH anyway. The PATCH is WHERE claimed_by=workerId so it's
            // safe (no-op if the row was reclaimed by another PC).
            if (state.workerId && state.queueBatchId) {
              try {
                const r = await markJobDone({
                  workerId: state.workerId,
                  batchId:  state.queueBatchId,
                  productUrl: cleanUrl,
                });
                // Only remove from claimedJobs AFTER the DB PATCH
                // succeeds. Otherwise a network failure would leave the
                // row 'claimed' in the DB but missing from our heartbeat
                // list, so it'd go stale → get reclaimed by another
                // worker → double-processing.
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
                // Network/auth failure — keep the job in claimedJobs so
                // heartbeat continues refreshing the lock. The next
                // onProductDone won't fire for this URL, so this is a
                // permanent leak unless the user manually triggers a
                // re-mark — log loudly.
                pushLog(`jobs:markDone failed (will retry on heartbeat): ${e.message}`, 'err');
              }
            }
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
      broadcast({ action: 'discoveryDone', totalKeywords: state.report.length, stopped, doneProducts: state.doneProducts.length });
      // CONTINUOUS-CLAIM AUTO-LOOP — when the worker is in continuous
      // mode and the engine finishes without the user stopping it, claim
      // the next chunk from the same batch (or the newest pending batch
      // if queueBatchId is empty) and start the engine on it. Loops until
      // the queue is empty. Adds a small cooldown so workers don't
      // hammer Supabase if the queue churns rapidly.
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
            pushLog(`Continuous mode: claiming next chunk from batch ${nextBatch}…`, 'ok');
            // Small cooldown so we don't immediately re-fire if Supabase
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
    // Also turn OFF continuous-claim mode — Stop should mean "stop for
    // real", not "stop this chunk and immediately claim another one".
    state.continuousClaim = false;
    chrome.storage.local.set({ adbrainContinuousClaim: false }).catch(() => {});
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
  if (action === 'jobs:fetchWorkerConfig') {
    (async () => {
      try {
        const cfg = await fetchWorkerConfig();
        sendResponse({ ok: true, config: cfg });
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
    (async () => {
      try {
        const workerId = (msg.workerId || state.workerId || '').trim();
        if (!workerId) throw new Error('Set a Worker ID first.');
        const chunkSize = Math.max(1, Math.min(50, Number(msg.chunkSize) || 5));
        const explicitBatch = (msg.batchId || '').trim();
        const batchId = explicitBatch || (await getActiveBatchId());
        if (!batchId) {
          sendResponse({ ok: false, error: 'No batches with pending work found. Ask the manager to upload a batch first.' });
          return;
        }
        // Mark this run as continuous BEFORE starting so the engine's
        // finish handler picks it up.
        state.continuousClaim = true;
        state.continuousChunkSize = chunkSize;
        state.workerId = workerId;
        await chrome.storage.local.set({
          [STORAGE_KEY_WORKER_ID]: workerId,
          adbrainContinuousClaim: true,
          adbrainContinuousChunkSize: chunkSize,
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
        // Claim a chunk and start the engine (re-uses the existing
        // claimAndStart code path).
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
        sendResponse({ ok: false, error: e.message });
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
  // Manager UI — pull every row for a batch back from Supabase and
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
        emitProgress({ currentAction: `Fetching report rows for batch "${batchId}" from Supabase…`, logKind: 'ok' });
        const report = await fetchBatchReportFromSupabase(batchId, (p) => {
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
      const data = await chrome.storage.local.get([STORAGE_KEY_SERVICE_KEY, STORAGE_KEY_SUPABASE_URL]);
      const key = (data[STORAGE_KEY_SERVICE_KEY] || '').trim();
      const url = (data[STORAGE_KEY_SUPABASE_URL] || '').trim();
      sendResponse({
        ok: true,
        hasServiceKey: key.length > 20,
        hasSupabaseUrl: url.length > 8 && !url.includes('YOUR-ADBRAIN-PROJECT'),
        supabaseUrl: url,
      });
    })();
    return true;
  }
  if (action === 'jobs:saveCreds') {
    (async () => {
      const updates = {};
      if (typeof msg.serviceKey === 'string' && msg.serviceKey.trim()) {
        updates[STORAGE_KEY_SERVICE_KEY] = msg.serviceKey.trim();
      }
      if (typeof msg.supabaseUrl === 'string' && msg.supabaseUrl.trim()) {
        // Normalise the URL so a user pasting any of these forms ends up
        // with the same canonical base:
        //   https://xyz.supabase.co
        //   https://xyz.supabase.co/
        //   https://xyz.supabase.co/rest/v1
        //   https://xyz.supabase.co/rest/v1/
        // Previously we only stripped trailing slashes, so the last two
        // would land as base="https://xyz.supabase.co/rest/v1" and the
        // PostgREST calls would compose ".../rest/v1/rest/v1/<table>" →
        // 404. Now we parse the URL and strip the entire path.
        const raw = msg.supabaseUrl.trim();
        let normalized;
        try {
          const u = new URL(raw);
          normalized = `${u.protocol}//${u.host}`;
        } catch {
          // If URL() rejects (no protocol, etc.), fall back to a regex
          // strip of any path/query so we don't store garbage.
          normalized = raw.replace(/\/+$/, '').replace(/^(https?:\/\/[^/]+)\/.*$/, '$1');
        }
        updates[STORAGE_KEY_SUPABASE_URL] = normalized;
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

  // Generate a one-string setup code that bundles supabaseUrl +
  // service_role key as base64-encoded JSON. Manager generates once,
  // workers paste once — replaces the two-field setup with a single
  // copy/paste. Service-role key IS exposed in the code so users must
  // share it only over encrypted channels (warning shown in the UI).
  if (action === 'jobs:exportSetupCode') {
    (async () => {
      const data = await chrome.storage.local.get([
        STORAGE_KEY_SERVICE_KEY,
        STORAGE_KEY_SUPABASE_URL,
        STORAGE_KEY_KP_URL,
      ]);
      const url = (data[STORAGE_KEY_SUPABASE_URL] || '').trim();
      const key = (data[STORAGE_KEY_SERVICE_KEY] || '').trim();
      const kpUrl = (data[STORAGE_KEY_KP_URL] || '').trim();
      if (!url || !key || url.includes('YOUR-ADBRAIN-PROJECT')) {
        sendResponse({ ok: false, error: 'Save Supabase URL + service_role key first.' });
        return;
      }
      // Encode as `adb1:<base64>` so future versions can use a different
      // prefix to identify the format. JSON wrapper carries a version
      // field for forward-compat too. v=2 adds kpUrl so workers also
      // get the manager's Google Ads Keyword Planner URL pre-filled —
      // without it, workers can't run KP scrapes.
      const payload = JSON.stringify({ v: 2, url, key, kpUrl });
      const b64 = btoa(unescape(encodeURIComponent(payload)));
      sendResponse({
        ok: true,
        code: `adb1:${b64}`,
        includes: { kpUrl: !!kpUrl },
      });
    })();
    return true;
  }
  if (action === 'jobs:importSetupCode') {
    (async () => {
      try {
        const raw = String(msg.code || '').trim();
        if (!raw.startsWith('adb1:')) {
          throw new Error('Not a valid setup code (expected to start with "adb1:").');
        }
        const b64 = raw.slice(5);
        let payload;
        try {
          payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
        } catch {
          throw new Error('Could not decode setup code — paste the exact string the manager generated.');
        }
        // Accept v=1 (URL + key only) and v=2 (also kpUrl). Reject
        // unknown versions so old workers don't silently apply garbage.
        if (!payload || (payload.v !== 1 && payload.v !== 2) || !payload.url || !payload.key) {
          throw new Error('Setup code is missing required fields.');
        }
        // Re-use the same URL-normalisation as jobs:saveCreds so a code
        // generated from a sloppy URL still produces a clean stored URL.
        let normalized;
        try {
          const u = new URL(payload.url);
          normalized = `${u.protocol}//${u.host}`;
        } catch {
          normalized = String(payload.url).replace(/\/+$/, '').replace(/^(https?:\/\/[^/]+)\/.*$/, '$1');
        }
        const updates = {
          [STORAGE_KEY_SUPABASE_URL]: normalized,
          [STORAGE_KEY_SERVICE_KEY]:  String(payload.key).trim(),
        };
        // v=2: bring the manager's KP URL along too, so workers don't
        // have to navigate to Settings → Keyword Planner to paste it.
        // Without a KP URL the engine can't run KP scrapes — every
        // worker NEEDS this. Empty kpUrl in the code is OK (manager
        // hadn't saved one yet); we just leave the worker's existing
        // KP URL untouched in that case.
        if (payload.v >= 2 && payload.kpUrl) {
          updates[STORAGE_KEY_KP_URL] = String(payload.kpUrl).trim();
        }
        await chrome.storage.local.set(updates);
        sendResponse({ ok: true, applied: { kpUrl: !!updates[STORAGE_KEY_KP_URL] } });
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
        // didn't fail — Supabase's ignore-duplicates returns 200/201 even when
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
