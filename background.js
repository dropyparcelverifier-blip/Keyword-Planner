// background.js (module worker)
// Thin onMessage router with persistent accumulated state so a Stop mid-flow
// doesn't lose work, and completed products are skipped on the next Start.

import { runKeywordDiscovery, cleanProductUrl, CAPTCHA_PAUSE_ERROR } from './modules/keyword-discovery.js';
import { toCSV, toXLSX, pushToAdBrain, exportSingleProductCSV } from './modules/discovery-export.js';
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

// Watchdog alarm name. MV3 service workers can be torn down after ~30s idle
// even mid-run; an alarm wakes the worker back up so we can detect "we
// should be running but aren't" and re-enter handleStart().
const WATCHDOG_ALARM = 'adbrain-watchdog';

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
  ]);
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
  broadcast({ action: 'discoveryProgress', payload });
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
  // The cold-start hydration may not have finished if onStartup fires before
  // the IIFE resolves — await it explicitly.
  await coldStart;
  if (!shouldAutoResume()) return;
  pushLog(`Auto-resume (${triggerLabel}): ${state.doneProducts.length}/${state.lastProducts.length} products done — resuming run`, 'ok');
  try {
    await handleStart({ products: null });
  } catch (e) {
    pushLog(`Auto-resume failed: ${e.message}`, 'err');
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
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  tryAutoResume('watchdog');
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
  if (state.running) return { ok: false, error: 'already running' };

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
    runOpts  = state.lastRunOpts;
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

  const reportMap = new Map();
  for (const r of state.report) {
    const k = (r.keyword || '').toLowerCase().trim();
    if (k) reportMap.set(k, r);
  }
  const excludeUrls = new Set(state.doneProducts);

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
      }
      await persistReport();
      broadcast({ action: 'discoveryDone', totalKeywords: state.report.length, stopped, doneProducts: state.doneProducts.length });
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
