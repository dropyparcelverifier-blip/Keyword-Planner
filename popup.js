// popup.js — UI controller.
// Parses the input file in the popup (SheetJS UMD via <script> tag) and hands
// the product list to background.js to drive the discovery flow.

const $ = (id) => document.getElementById(id);
const STORAGE_KEY_SERVICE_KEY = 'adbrainServiceKey';
const STORAGE_KEY_SUPABASE_URL = 'adbrainSupabaseUrl';
const STORAGE_KEY_KP_URL      = 'adbrainKpUrl';
const STORAGE_KEY_KP_MAX      = 'adbrainKpMaxPerProduct';
const STORAGE_KEY_AUTO_EXPORT  = 'adbrainAutoExport';
const STORAGE_KEY_MATCH_PROFILE = 'adbrainMatchProfile';
const STORAGE_KEY_CLIP_THRESHOLD = 'adbrainClipThreshold';
const STORAGE_KEY_MAX_IMAGE_MATCH_ROWS = 'adbrainMaxImageMatchRows';
// Pacing knobs persisted to chrome.storage so the values survive across sessions.
const STORAGE_KEY_SEARCH_DELAY_MIN  = 'adbrainSearchDelayMin';
const STORAGE_KEY_SEARCH_DELAY_MAX  = 'adbrainSearchDelayMax';
const STORAGE_KEY_PRODUCT_DELAY_MIN = 'adbrainProductDelayMin';
const STORAGE_KEY_PRODUCT_DELAY_MAX = 'adbrainProductDelayMax';
const STORAGE_KEY_CHUNK_SIZE        = 'adbrainChunkSize';
const STORAGE_KEY_CHUNK_REST_MIN    = 'adbrainChunkRestMin';
const STORAGE_KEY_CHUNK_REST_MAX    = 'adbrainChunkRestMax';
const DEFAULT_KP_URL          = 'https://ads.google.com/aw/keywordplanner/home?ocid=8258883732&euid=6514712119&__u=5064884031&uscid=8258883732&__c=8714548468&authuser=0&subid=all-en-awhp-g-aw-c-t-kwp-signin-bgc%21o2';

let parsedProducts = []; // [{ url, priority }]

// ---- Tabs ----
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`panel-${tab.dataset.tab}`).classList.add('active');
    // Load results when switching to the Results tab — done on switch so we
    // always show the freshest persisted report.
    if (tab.dataset.tab === 'results') loadResultsFromStorage();
  });
});

// ---- File parsing (SheetJS) ----
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    parsedProducts = [];
    let invalidUrl = 0, missingUrl = 0;
    // Track whether we found a SKU column anywhere in the input — used to
    // warn the user when SKU is missing (per-product CSV export falls back
    // to product-name slug, which collapses identically-named products
    // into one file).
    let sawSkuColumn = false;
    for (const row of rows) {
      let urlVal = '', priVal = '', skuVal = '', handlesVal = '', brandVal = '';
      for (const k of Object.keys(row)) {
        const kl = k.toLowerCase().trim();
        if (kl === 'product url' || kl === 'producturl' || kl === 'url') urlVal = String(row[k]).trim();
        // Priority — accept the common "priroty" typo (and other obvious
        // misspellings) so a sheet authored with the wrong header still
        // ranks correctly instead of silently defaulting every row to 3.
        if (
          kl === 'priority' || kl === 'pri' ||
          kl === 'priroty' || kl === 'prioty' || kl === 'priorty' || kl === 'priorit' ||
          kl === 'rank' || kl === 'order'
        ) priVal = String(row[k]).trim();
        // Brand column — explicit brand beats heuristic auto-detection from
        // the URL slug. Critical for multi-word brands ("La Roche-Posay",
        // "The Ordinary") and brand-mate grouping across the batch.
        if (!brandVal && (kl === 'brand' || kl === 'brands' || kl === 'brand name' || kl === 'brandname' || kl === 'manufacturer' || kl === 'maker')) {
          brandVal = String(row[k]).trim();
        }
        // SKU column — accept anything containing "sku" or recognised as a
        // product identifier. Previously only exact-match "sku" / "product
        // sku" / "productsku" / "item sku" worked, which silently dropped
        // columns like "SKU Code", "Item Number", "Product Code".
        if (!skuVal) {
          const isSkuCol =
            kl === 'sku' || kl === 'product sku' || kl === 'productsku' || kl === 'item sku' ||
            kl === 'item number' || kl === 'itemnumber' || kl === 'item id' || kl === 'itemid' ||
            kl === 'product code' || kl === 'productcode' || kl === 'product id' || kl === 'productid' ||
            kl === 'product number' || kl === 'productnumber' || kl === 'item code' || kl === 'itemcode' ||
            /\bsku\b/.test(kl) || kl.endsWith('_sku') || kl.endsWith('-sku');
          if (isSkuCol) {
            skuVal = String(row[k]).trim();
            if (skuVal) sawSkuColumn = true;
          }
        }
        if (kl === 'handles' || kl === 'handle' || kl === 'extra seeds' || kl === 'seeds' || kl === 'extra keywords' || kl === 'keywords') handlesVal = String(row[k]).trim();
      }
      if (!urlVal) { missingUrl++; continue; }
      let isValid = false;
      try {
        const u = new URL(urlVal);
        isValid = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {}
      if (!isValid) { invalidUrl++; continue; }
      const priority = parseInt(priVal, 10);
      parsedProducts.push({
        url: urlVal,
        priority: (priority === 1 || priority === 2 || priority === 3) ? priority : 3,
        sku: skuVal,
        handles: handlesVal,
        brand: brandVal,
      });
    }

    const parts = [`${parsedProducts.length} valid URL(s) loaded`];
    if (invalidUrl) parts.push(`${invalidUrl} rejected (not a URL — check the "Product URL" column has actual https:// links, not page titles)`);
    if (missingUrl) parts.push(`${missingUrl} row(s) had no URL`);
    if (!sawSkuColumn && parsedProducts.length > 0) {
      parts.push(`⚠ no SKU column detected — export will use product-name slugs (rename your column to "SKU" or one of: Item Number, Product Code, Item ID)`);
    }
    $('fileInfo').textContent = parts.join(' • ');
    const warnColor = (!sawSkuColumn || invalidUrl) ? 'var(--warn)' : 'var(--success)';
    $('fileInfo').style.color = parsedProducts.length === 0 ? 'var(--danger)' : warnColor;
  } catch (err) {
    $('fileInfo').textContent = `Parse error: ${err.message}`;
    $('fileInfo').style.color = 'var(--danger)';
    parsedProducts = [];
  }
});

// ---- Start / Resume / Stop ----
// canResume = previous run has a persisted product list AND not all products
//             are marked done. Surface a Resume button distinct from Start.
let canResume = false;
let pausedByCaptcha = false;
let runIntent = false;

function setRunningUI(running) {
  $('startBtn').disabled = running;
  $('startBtn').textContent = running ? 'Discovery running…' : 'Start Discovery';
  $('stopBtn').style.display = running ? 'inline-block' : 'none';
  $('stopBtn').disabled = false;
  $('stopBtn').textContent = 'Stop';
  // Resume button shows when there is something to resume AND we are not
  // currently running. Hidden once a run kicks off.
  $('resumeBtn').style.display = (!running && canResume) ? 'inline-block' : 'none';
  $('captchaBanner').style.display = pausedByCaptcha ? 'block' : 'none';
  // Auto-resume banner: runIntent stays set while a paused or crashed run is
  // still pending. Hidden during an active run (no banner needed — it IS
  // running) and once the user Stops / Resets (runIntent cleared).
  const arb = $('autoResumeBanner');
  if (arb) arb.style.display = (!running && runIntent && canResume) ? 'block' : 'none';
  // Disable Run-tab Reset while a run is in progress — resetting mid-run
  // would corrupt the report write the engine is in the middle of.
  const rrb = $('runResetBtn');
  if (rrb) rrb.disabled = running;
  // Drive the header status pill + body data-state for CSS-driven visual
  // feedback (header dot pulse, progress-card highlight, etc).
  syncHeaderState(running);
}

// Sync header status pill text + body data-state attribute. CSS reads
// body[data-state] to colour the header dot, status pill, and progress
// card border. Called from setRunningUI and from the progress message
// handler.
function syncHeaderState(running) {
  const body = document.body;
  let state;
  let label;
  if (running) {
    state = 'running';
    label = 'Running';
  } else if (pausedByCaptcha) {
    state = 'paused';
    label = 'Paused — verify check';
  } else {
    // Read from #statusText (engine's authoritative text) for done / idle
    // distinction. If lastStatus is "Done …" or "Stopped …", treat as done.
    const txt = ($('statusText')?.textContent || 'Idle').trim();
    if (/^Done\b|^Stopped\b/i.test(txt)) {
      state = 'done';
      label = txt.length > 40 ? txt.slice(0, 40) + '…' : txt;
    } else if (/^(?:Starting|Resuming)/i.test(txt)) {
      state = 'running';
      label = txt;
    } else {
      state = 'idle';
      label = 'Idle';
    }
  }
  if (body.dataset.state !== state) body.dataset.state = state;
  const pill = document.getElementById('headerStatus');
  if (pill && pill.textContent !== label) pill.textContent = label;
}

function readRunOpts() {
  return {
    cap: parseInt($('capInput').value, 10) || 500,
    kpUrl: $('kpUrl').value.trim(),
    kpMaxPerProduct: parseInt($('kpMaxPerProduct').value, 10) || 200,
    autoExport: $('autoExport').checked,
    matchProfile: ($('matchProfile').value || 'normal'),
    // Slider override only takes effect when profile === 'custom'. Sent as a
    // 0-1 cosine value so the engine doesn't need to know about percentages.
    clipThresholdOverride: ($('matchProfile').value === 'custom')
      ? Math.max(0.5, Math.min(0.95, parseInt($('clipThreshold').value, 10) / 100))
      : null,
    maxImageMatchRows: Math.max(0, parseInt($('maxImageMatchRows').value, 10) || 0),
    searchDelayMinMs:  Math.max(1, parseInt($('searchDelayMin').value,  10) || 5)   * 1000,
    searchDelayMaxMs:  Math.max(1, parseInt($('searchDelayMax').value,  10) || 12)  * 1000,
    productDelayMinMs: Math.max(1, parseInt($('productDelayMin').value, 10) || 15)  * 1000,
    productDelayMaxMs: Math.max(1, parseInt($('productDelayMax').value, 10) || 35)  * 1000,
    chunkSize:         Math.max(1, parseInt($('chunkSize').value, 10) || 8),
    chunkRestMinMs:    Math.max(1, parseInt($('chunkRestMin').value, 10) || 5)  * 60 * 1000,
    chunkRestMaxMs:    Math.max(1, parseInt($('chunkRestMax').value, 10) || 10) * 60 * 1000,
  };
}

$('startBtn').addEventListener('click', () => {
  if (parsedProducts.length === 0) {
    alert('Please load a product file first.');
    return;
  }
  const runOpts = readRunOpts();
  if (!runOpts.kpUrl) {
    alert('Keyword Planner URL is required (Settings tab).');
    return;
  }
  if (runOpts.searchDelayMaxMs < runOpts.searchDelayMinMs ||
      runOpts.productDelayMaxMs < runOpts.productDelayMinMs ||
      runOpts.chunkRestMaxMs < runOpts.chunkRestMinMs) {
    alert('Pacing max values must be >= min values.');
    return;
  }

  pausedByCaptcha = false;
  setRunningUI(true);
  $('statusText').textContent = 'Starting…';
  syncHeaderState(true);
  $('log').innerHTML = '';
  $('keywordCount').textContent = '0';
  // Fresh start — reset the per-product history list so we don't show
  // rows from the previous run. (Resume re-uses this popup session and
  // history accumulates only while the popup is open, so a Resume that
  // happens with the popup closed will start fresh too — acceptable.)
  pcState.productHistory = [];
  pcRenderHistory();

  chrome.runtime.sendMessage(
    { action: 'startDiscovery', products: parsedProducts, ...runOpts },
    (resp) => {
      if (chrome.runtime.lastError) {
        logLine(`Background error: ${chrome.runtime.lastError.message}`, 'err');
        setRunningUI(false);
      } else if (resp && !resp.ok) {
        logLine(`Start refused: ${resp.error || 'unknown'}`, 'err');
        setRunningUI(false);
      }
    }
  );
});

$('resumeBtn').addEventListener('click', () => {
  pausedByCaptcha = false;
  setRunningUI(true);
  $('statusText').textContent = 'Resuming…';
  syncHeaderState(true);
  $('captchaBanner').style.display = 'none';
  chrome.runtime.sendMessage({ action: 'resumeDiscovery' }, (resp) => {
    if (chrome.runtime.lastError) {
      logLine(`Background error: ${chrome.runtime.lastError.message}`, 'err');
      setRunningUI(false);
    } else if (resp && !resp.ok) {
      logLine(`Resume refused: ${resp.error || 'unknown'}`, 'err');
      setRunningUI(false);
    }
  });
});

$('stopBtn').addEventListener('click', () => {
  $('stopBtn').disabled = true;
  $('stopBtn').textContent = 'Stopping…';
  chrome.runtime.sendMessage({ action: 'stopDiscovery' }, (resp) => {
    if (!resp?.ok) logLine(`Stop ignored: ${resp?.error || 'unknown'}`, 'err');
    else logLine('Stop requested — finishing current step…');
  });
});

// ---- Export & Push ----
$('exportCsvBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'exportDiscovery', format: 'csv' }, (resp) => {
    if (resp?.ok) {
      logLine(`CSV export: ${resp.count} file(s) — ${(resp.filenames || []).join(', ')}`, 'ok');
    } else logLine(`CSV export failed: ${resp?.error || 'unknown'}`, 'err');
  });
});
$('exportXlsxBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'exportDiscovery', format: 'xlsx' }, (resp) => {
    if (resp?.ok) {
      logLine(`Excel export: ${resp.count} file(s) — ${(resp.filenames || []).join(', ')}`, 'ok');
    } else logLine(`Excel export failed: ${resp?.error || 'unknown'}`, 'err');
  });
});
$('pushBtn').addEventListener('click', () => {
  $('pushBtn').disabled = true;
  $('pushBtn').textContent = 'Pushing…';
  chrome.runtime.sendMessage({ action: 'pushDiscovery' }, (resp) => {
    $('pushBtn').disabled = false;
    $('pushBtn').textContent = 'Push to AdBrain';
    if (!resp?.ok) {
      logLine(`Push failed: ${resp?.error || 'unknown'}`, 'err');
      return;
    }
    if (resp.message === 'nothing new to push') {
      logLine(`Nothing new to push (${resp.totalInReport} total rows already on AdBrain).`);
      return;
    }
    const tail = resp.failed
      ? ` (${resp.failed} failed: ${(resp.errors || []).slice(0, 1).join(' / ')})`
      : '';
    logLine(`Pushed ${resp.success} new rows (${resp.pushedSoFar}/${resp.totalInReport} total cumulative)${tail}`,
      resp.failed ? 'err' : 'ok');
  });
});

// ---- Settings ----
const SETTINGS_KEYS = [
  STORAGE_KEY_SERVICE_KEY, STORAGE_KEY_SUPABASE_URL, STORAGE_KEY_KP_URL,
  STORAGE_KEY_KP_MAX, STORAGE_KEY_AUTO_EXPORT, STORAGE_KEY_MATCH_PROFILE,
  STORAGE_KEY_CLIP_THRESHOLD,
  STORAGE_KEY_MAX_IMAGE_MATCH_ROWS,
  STORAGE_KEY_SEARCH_DELAY_MIN, STORAGE_KEY_SEARCH_DELAY_MAX,
  STORAGE_KEY_PRODUCT_DELAY_MIN, STORAGE_KEY_PRODUCT_DELAY_MAX,
  STORAGE_KEY_CHUNK_SIZE, STORAGE_KEY_CHUNK_REST_MIN, STORAGE_KEY_CHUNK_REST_MAX,
];

chrome.storage.local.get(SETTINGS_KEYS, (data) => {
  if (data[STORAGE_KEY_SERVICE_KEY]) $('serviceKey').value = data[STORAGE_KEY_SERVICE_KEY];
  if (data[STORAGE_KEY_SUPABASE_URL]) $('supabaseUrl').value = data[STORAGE_KEY_SUPABASE_URL];
  $('kpUrl').value = data[STORAGE_KEY_KP_URL] || DEFAULT_KP_URL;
  if (data[STORAGE_KEY_KP_MAX] && data[STORAGE_KEY_KP_MAX] !== 100 && data[STORAGE_KEY_KP_MAX] !== 500) {
    $('kpMaxPerProduct').value = String(data[STORAGE_KEY_KP_MAX]);
  } else if (data[STORAGE_KEY_KP_MAX] === 100 || data[STORAGE_KEY_KP_MAX] === 500) {
    $('kpMaxPerProduct').value = '5000';
    chrome.storage.local.set({ [STORAGE_KEY_KP_MAX]: 5000 });
  }
  if (typeof data[STORAGE_KEY_AUTO_EXPORT] === 'boolean') $('autoExport').checked = data[STORAGE_KEY_AUTO_EXPORT];
  if (typeof data[STORAGE_KEY_MATCH_PROFILE] === 'string') {
    $('matchProfile').value = data[STORAGE_KEY_MATCH_PROFILE];
  }
  // CLIP threshold slider — persisted as integer percent (60-92), rendered
  // as 0.xx in the value label. Default 72 matches the new "normal" profile.
  if (typeof data[STORAGE_KEY_CLIP_THRESHOLD] === 'number') {
    $('clipThreshold').value = String(data[STORAGE_KEY_CLIP_THRESHOLD]);
  }
  const _renderClipThresh = () => {
    const v = parseInt($('clipThreshold').value, 10);
    $('clipThresholdValue').textContent = (v / 100).toFixed(2);
  };
  _renderClipThresh();
  $('clipThreshold').addEventListener('input', _renderClipThresh);
  if (typeof data[STORAGE_KEY_MAX_IMAGE_MATCH_ROWS] === 'number') {
    $('maxImageMatchRows').value = String(data[STORAGE_KEY_MAX_IMAGE_MATCH_ROWS]);
  }
  // Migrate previous pacing defaults to the new faster defaults. If the user
  // had an old persisted default, replace with the new default; otherwise keep
  // their custom value.
  const oldNew = (oldDefault, newDefault) => (v) =>
    (v === oldDefault) ? newDefault : v;
  const migrateSDmin = oldNew(10, 5);
  const migrateSDmax = oldNew(25, 12);
  const migratePDmin = oldNew(30, 15);
  const migratePDmax = oldNew(75, 35);
  const migrateCsize = oldNew(6, 8);
  const migrateCRmin = oldNew(10, 5);
  const migrateCRmax = oldNew(20, 10);
  if (typeof data[STORAGE_KEY_SEARCH_DELAY_MIN]  === 'number') $('searchDelayMin').value  = String(migrateSDmin(data[STORAGE_KEY_SEARCH_DELAY_MIN]));
  if (typeof data[STORAGE_KEY_SEARCH_DELAY_MAX]  === 'number') $('searchDelayMax').value  = String(migrateSDmax(data[STORAGE_KEY_SEARCH_DELAY_MAX]));
  if (typeof data[STORAGE_KEY_PRODUCT_DELAY_MIN] === 'number') $('productDelayMin').value = String(migratePDmin(data[STORAGE_KEY_PRODUCT_DELAY_MIN]));
  if (typeof data[STORAGE_KEY_PRODUCT_DELAY_MAX] === 'number') $('productDelayMax').value = String(migratePDmax(data[STORAGE_KEY_PRODUCT_DELAY_MAX]));
  if (typeof data[STORAGE_KEY_CHUNK_SIZE]        === 'number') $('chunkSize').value       = String(migrateCsize(data[STORAGE_KEY_CHUNK_SIZE]));
  if (typeof data[STORAGE_KEY_CHUNK_REST_MIN]    === 'number') $('chunkRestMin').value    = String(migrateCRmin(data[STORAGE_KEY_CHUNK_REST_MIN]));
  if (typeof data[STORAGE_KEY_CHUNK_REST_MAX]    === 'number') $('chunkRestMax').value    = String(migrateCRmax(data[STORAGE_KEY_CHUNK_REST_MAX]));
});

$('saveSettings').addEventListener('click', () => {
  const key = $('serviceKey').value.trim();
  const supabaseUrl = $('supabaseUrl').value.trim().replace(/\/+$/, '');
  const kpUrl = $('kpUrl').value.trim();
  const kpMax = parseInt($('kpMaxPerProduct').value, 10) || 100;
  const autoExport = $('autoExport').checked;
  const matchProfile = $('matchProfile').value || 'normal';
  chrome.storage.local.set(
    {
      [STORAGE_KEY_SERVICE_KEY]: key,
      [STORAGE_KEY_SUPABASE_URL]: supabaseUrl,
      [STORAGE_KEY_KP_URL]: kpUrl,
      [STORAGE_KEY_KP_MAX]: kpMax,
      [STORAGE_KEY_AUTO_EXPORT]: autoExport,
      [STORAGE_KEY_MATCH_PROFILE]: matchProfile,
      [STORAGE_KEY_CLIP_THRESHOLD]: parseInt($('clipThreshold').value, 10) || 72,
      [STORAGE_KEY_MAX_IMAGE_MATCH_ROWS]: Math.max(0, parseInt($('maxImageMatchRows').value, 10) || 0),
      [STORAGE_KEY_SEARCH_DELAY_MIN]:  parseInt($('searchDelayMin').value,  10) || 5,
      [STORAGE_KEY_SEARCH_DELAY_MAX]:  parseInt($('searchDelayMax').value,  10) || 12,
      [STORAGE_KEY_PRODUCT_DELAY_MIN]: parseInt($('productDelayMin').value, 10) || 15,
      [STORAGE_KEY_PRODUCT_DELAY_MAX]: parseInt($('productDelayMax').value, 10) || 35,
      [STORAGE_KEY_CHUNK_SIZE]:        parseInt($('chunkSize').value, 10) || 8,
      [STORAGE_KEY_CHUNK_REST_MIN]:    parseInt($('chunkRestMin').value, 10) || 5,
      [STORAGE_KEY_CHUNK_REST_MAX]:    parseInt($('chunkRestMax').value, 10) || 10,
    },
    () => {
      $('settingsSaved').textContent = 'Saved.';
      setTimeout(() => { $('settingsSaved').textContent = ''; }, 2000);
    }
  );
});

// ---- Progress bars ----
function paintBar(elId, processed, total) {
  const fill = $(elId);
  if (!fill) return;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  fill.style.width = `${pct}%`;
  fill.classList.toggle('complete', total > 0 && processed >= total);
}

// ---- Rest countdown ----
// Engine emits restUntil (ms epoch) on every chunk-rest tick. We render a
// live countdown locally so the banner stays current even if no new tick
// payload arrives for a few seconds.
let restCountdownTimer = null;
function startRestCountdown(restUntil) {
  if (restCountdownTimer) clearInterval(restCountdownTimer);
  if (!restUntil || restUntil <= Date.now()) {
    $('restBanner').style.display = 'none';
    return;
  }
  $('restBanner').style.display = 'block';
  $('restUntilText').textContent = new Date(restUntil).toLocaleTimeString();
  const tick = () => {
    const remaining = restUntil - Date.now();
    if (remaining <= 0) {
      clearInterval(restCountdownTimer);
      restCountdownTimer = null;
      $('restBanner').style.display = 'none';
      return;
    }
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    $('restCountdown').textContent = `${m}m ${String(s).padStart(2, '0')}s`;
  };
  tick();
  restCountdownTimer = setInterval(tick, 1000);
}

// ---- Structured progress card (derived from engine messages) ----
// The engine emits per-line progress messages (currentSource + currentAction).
// We derive the structured fields the card displays — stage, action type,
// counters — by mapping currentSource and pattern-matching currentAction.
// Conservative: when a field can't be parsed, leave the previous value.
const pcState = {
  productStartedAt: 0,         // ms timestamp of current product's start
  currentStage: null,          // 'init' | 'kp' | 'r1' | 'r2' | 'rs' | 'export'
  serpCount: 0,                // SERP loads completed for current product
  totalMatches: 0,             // image matches summed across current product
  totalSellers: 0,             // sellers seen across current product
  filteredCount: 0,            // keywords rejected by relevance/noise filters
  lastProductKey: '',          // detect product transitions
  // Per-product keyword counter — derived as (cumulative now) - (cumulative
  // at last product transition). The engine emits `keywordCount` as the
  // total across all products; subtracting the baseline gives the count
  // FOR THIS PRODUCT. Slightly under-counts when many keywords are
  // re-discovered cross-product (dedupe means the cumulative doesn't grow)
  // but that's acceptable — the alternative was emitting per-product
  // counts on every progress message.
  productKwBaseline: 0,
  productKwCount: 0,
  // Per-product completion history. Each row: { name, status, kwCount,
  // matchCount, thumbsCount }. Appended when the engine emits a "Product
  // complete" / "Product PARTIAL" progress action — the cumulative
  // counters above show the running total, this list disaggregates them.
  productHistory: [],
};

function pcResetCountersForNewProduct() {
  pcState.productStartedAt = Date.now();
  pcState.serpCount = 0;
  pcState.totalMatches = 0;
  pcState.totalSellers = 0;
  pcState.filteredCount = 0;
  pcState.productKwCount = 0;
  ['init','kp','r1','r2','rs','export'].forEach(s => {
    const el = document.getElementById(`pcStage-${s}`);
    if (!el) return;
    el.classList.remove('done','active'); el.classList.add('pending');
    const icon = el.querySelector('.pc-stage-icon');
    if (icon) icon.textContent = '○';
  });
}

function pcSetStage(stage) {
  const order = ['init','kp','r1','r2','rs','export'];
  const idx = order.indexOf(stage);
  if (idx < 0) return;
  if (pcState.currentStage === stage) return;
  pcState.currentStage = stage;
  order.forEach((s, i) => {
    const el = document.getElementById(`pcStage-${s}`);
    if (!el) return;
    el.classList.remove('done','active','pending');
    const icon = el.querySelector('.pc-stage-icon');
    if (i <  idx) { el.classList.add('done');    if (icon) icon.textContent = '✓'; }
    if (i === idx){ el.classList.add('active');  if (icon) icon.textContent = '⟳'; }
    if (i >  idx) { el.classList.add('pending'); if (icon) icon.textContent = '○'; }
  });
}

function pcMapSourceToStage(source, action) {
  if (!source) return null;
  if (source === 'kp' || source === 'kp expand') return 'kp';
  if (source === 'round1') return 'r1';
  if (source === 'round2') return 'r2';
  if (source === 'related') return 'rs';
  if (source === 'done') return 'export';
  if (source === 'context') return 'init';
  // 'serp' / 'pace' / 'autosuggest' don't carry a phase — leave whatever
  // stage we last set. Use the action prefix as a hint when available.
  if (typeof action === 'string') {
    if (action.startsWith('R1 ') || action.startsWith('R1-leaf:')) return 'r1';
    if (action.startsWith('R2 ') || action.startsWith('R2-leaf:')) return 'r2';
    if (action.startsWith('RS:'))  return 'rs';
  }
  return null;
}

function pcActionTypeFor(action) {
  if (!action) return '—';
  // Match label prefixes the engine writes ("R1 3/5 (kp_idea):", "R1-leaf:",
  // "R2 kpA/B kwC:", "R2-leaf:", "RS:").
  const m = action.match(/^(R[12]-leaf|R[12]|RS|KP|SERP)\b/i);
  if (m) return m[1].toUpperCase();
  return '—';
}

function pcDeriveCounters(action) {
  if (typeof action !== 'string') return;
  // "...— N matches (X thumbs..."  → image matches for this keyword
  let m = action.match(/—\s+(\d+)\s+match(?:es)?\s*\(/);
  if (m) pcState.totalMatches += parseInt(m[1], 10) || 0;
  // "...sellers=N ads=..."  → cumulative seller count for current product
  m = action.match(/sellers=(\d+)/);
  if (m) pcState.totalSellers += parseInt(m[1], 10) || 0;
  // "Loading SERP for ..." or "— pausing N s before SERP" — each represents
  // one upcoming SERP load. We count the "pausing ... before SERP" form
  // because the engine emits exactly one of those per SERP cycle.
  if (/pausing\s+\d+\s+s\s+before\s+SERP/i.test(action)) pcState.serpCount++;
  // "Skipped irrelevant" / "non-English/noise dropped" / "off-product dropped"
  // are the engine's noise-filter log forms.
  m = action.match(/(\d+)\s+(?:non-English|off-product|near-duplicate)/i);
  if (m) pcState.filteredCount += parseInt(m[1], 10) || 0;
  if (/Skipped irrelevant/i.test(action)) pcState.filteredCount++;
}

// Parse the engine's product-completion lines and append to history.
// Engine emits (from keyword-discovery.js, line ~4584):
//   "Product complete (3/23) — 46 new keywords this product (28 with image
//    matches, 142 total matched thumbs); report total = 87"
//   "Product PARTIAL (3/23) — 12 new keywords this product (4 with image
//    matches, 18 total matched thumbs); will re-process on Resume; ..."
// Append one row per call, render at most once per completion.
function pcMaybeAppendHistory(productName, action) {
  if (!action) return;
  const completeRe = /^Product\s+(complete|PARTIAL)\s*\((\d+)\/(\d+)\)\s*—\s*(\d+)\s+new keywords[^(]*\((\d+)\s+with image matches,\s*(\d+)\s+total matched/i;
  const m = action.match(completeRe);
  if (!m) return;
  const [, kind, , , kwCount, matchCount, thumbsCount] = m;
  const status = kind.toLowerCase() === 'partial' ? 'partial' : 'done';
  // De-dupe: if the same product+status already at the tail, skip — engine
  // can emit the line twice in some resume paths.
  const tail = pcState.productHistory[pcState.productHistory.length - 1];
  if (tail && tail.name === productName && tail.status === status) return;
  pcState.productHistory.push({
    name: productName || '—',
    status,
    kwCount: parseInt(kwCount, 10) || 0,
    matchCount: parseInt(matchCount, 10) || 0,
    thumbsCount: parseInt(thumbsCount, 10) || 0,
  });
  pcRenderHistory();
}

function pcRenderHistory() {
  const wrap = document.getElementById('pcHistoryWrap');
  const list = document.getElementById('pcHistory');
  const count = document.getElementById('pcHistoryCount');
  if (!wrap || !list || !count) return;
  if (pcState.productHistory.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  count.textContent = String(pcState.productHistory.length);
  // Newest first — user wants to see the just-completed product without
  // scrolling.
  const rows = pcState.productHistory.slice().reverse().map(h => {
    const icon = h.status === 'done' ? '✓' : '◐';
    const safeName = String(h.name).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    return `
      <div class="pc-history-row ${h.status}">
        <span class="pc-history-status">${icon}</span>
        <span class="pc-history-name" title="${safeName}">${safeName}</span>
        <span class="pc-history-stats">
          <span><span class="v">${h.kwCount}</span> kw</span>
          <span><span class="v">${h.matchCount}</span> img</span>
          <span><span class="v">${h.thumbsCount}</span> thumbs</span>
        </span>
      </div>
    `;
  }).join('');
  list.innerHTML = rows;
}

function pcUpdate(p) {
  const card = document.getElementById('progressCard');
  if (!card) return;
  card.style.display = 'block';

  // Product transition — reset per-product counters and rebase the
  // keyword baseline so the per-product count starts at 0.
  const productKey = String(p.currentProduct || '').trim();
  if (productKey && productKey !== pcState.lastProductKey) {
    pcState.lastProductKey = productKey;
    pcResetCountersForNewProduct();
    if (typeof p.keywordCount === 'number') {
      pcState.productKwBaseline = p.keywordCount;
    }
    pcSetStage('init');
    $('pcProductName').textContent = productKey;
    $('pcProductUrl').textContent = '';
  }

  // Stage transition.
  const stage = pcMapSourceToStage(p.currentSource, p.currentAction);
  if (stage) pcSetStage(stage);

  // Batch progress bar — uses existing productsDone / productsTotal fields.
  if (p.productsTotal !== undefined) {
    const done = p.productsDone ?? 0;
    const total = p.productsTotal;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    $('pcBatchLabel').textContent = `Product ${Math.min(done + 1, total)} of ${total}`;
    $('pcBatchPct').textContent = `${pct}%`;
    $('pcBatchBar').style.width = `${pct}%`;
  }

  // Derive cumulative counters from the action text.
  pcDeriveCounters(p.currentAction);

  // Append a row to the per-product history list when the engine reports
  // a product as complete or partial. The list lives below the counters
  // and disaggregates the cumulative totals.
  pcMaybeAppendHistory(productKey, p.currentAction);

  // Stage-specific detail lines.
  if (p.currentSource === 'kp' && typeof p.currentAction === 'string') {
    const m = p.currentAction.match(/KP returned (\d+)/) || p.currentAction.match(/seed ".+?" → (\d+)\s+ideas/);
    if (m) $('pcStageDetail-kp').textContent = `${m[1]} ideas`;
  }
  if (p.currentSource === 'round1' && typeof p.currentAction === 'string') {
    const m = p.currentAction.match(/(\d+) SERP-cycled/) || p.currentAction.match(/processing (\d+) seed/);
    if (m) $('pcStageDetail-r1').textContent = `${m[1]} seeds`;
  }
  if (p.currentSource === 'round2' && typeof p.currentAction === 'string') {
    const m = p.currentAction.match(/(\d+) top KP1/) || p.currentAction.match(/(\d+) KP1/);
    if (m) $('pcStageDetail-r2').textContent = `${m[1]} seeds`;
  }

  // Counters. Prefer engine-provided per-product count when available
  // (set on completion / R2 progress messages); otherwise derive from
  // cumulative-keyword delta against the baseline saved at product
  // transition above.
  if (typeof p.productKeywordCount === 'number') {
    pcState.productKwCount = p.productKeywordCount;
  } else if (typeof p.keywordCount === 'number') {
    pcState.productKwCount = Math.max(0, p.keywordCount - pcState.productKwBaseline);
  }
  $('pcKeywords').textContent = pcState.productKwCount;
  // Show running cumulative total alongside the per-product count so the
  // user can reconcile against the report-total exported by CSV.
  if (typeof p.keywordCount === 'number') {
    const totalEl = document.getElementById('pcKeywordsTotal');
    if (totalEl) totalEl.textContent = `Total ${p.keywordCount}`;
  }
  $('pcSerps').textContent    = pcState.serpCount;
  $('pcMatches').textContent  = pcState.totalMatches;
  $('pcSellers').textContent  = pcState.totalSellers;
  $('pcFiltered').textContent = pcState.filteredCount;

  // Action line.
  $('pcActionType').textContent = pcActionTypeFor(p.currentAction);
  if (typeof p.currentAction === 'string') {
    const txt = p.currentAction.length > 90 ? p.currentAction.slice(0, 90) + '…' : p.currentAction;
    $('pcActionText').textContent = txt;
  }

  // Time.
  if (pcState.productStartedAt > 0) {
    const elapsed = Date.now() - pcState.productStartedAt;
    const m = Math.floor(elapsed / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    $('pcElapsed').textContent = `${m}:${String(s).padStart(2, '0')}`;
    // Naive ETA: avg per-SERP time × queue remaining. Only show after a few
    // SERPs so the estimate isn't wild.
    if (pcState.serpCount >= 3 && typeof p.queueRemaining === 'number' && p.queueRemaining > 0) {
      const avgMs = elapsed / pcState.serpCount;
      const remMin = Math.max(1, Math.ceil((avgMs * p.queueRemaining) / 60000));
      $('pcRemaining').textContent = `~${remMin} min remaining`;
    }
  }
}

// ---- Progress + done ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'discoveryProgress') {
    const p = msg.payload || {};
    // Keep the worker-live block fresh on every progress tick. The
    // current action line is the most useful single signal of what
    // the engine is doing right now.
    if (p.currentAction) {
      const act = $('workerLiveAction');
      if (act) act.textContent = p.currentAction.length > 100
        ? p.currentAction.slice(0, 100) + '…'
        : p.currentAction;
    }
    if (p.currentProduct !== undefined) $('currentProduct').textContent = p.currentProduct || '—';
    if (p.currentSource !== undefined) $('currentSource').textContent = p.currentSource || '—';
    if (p.currentAction !== undefined) $('currentAction').textContent = p.currentAction || '—';
    if (p.keywordCount !== undefined) {
      $('keywordCount').textContent = p.keywordCount;
      if (p.keywordCount > 0) {
        $('exportCsvBtn').disabled = false;
        $('exportXlsxBtn').disabled = false;
        $('pushBtn').disabled = false;
      }
    }
    if (p.queueRemaining !== undefined) $('queueRemaining').textContent = p.queueRemaining;

    if (p.productsTotal !== undefined) {
      $('productsTotal').textContent = p.productsTotal;
      $('productsDone').textContent  = p.productsDone ?? 0;
      paintBar('productsBar', p.productsDone ?? 0, p.productsTotal);
    }
    if (p.queueTotal !== undefined) {
      $('queueTotal').textContent     = p.queueTotal;
      $('queueProcessed').textContent = p.queueProcessed ?? 0;
      paintBar('queueBar', p.queueProcessed ?? 0, p.queueTotal);
    }
    if (typeof p.restUntil === 'number') startRestCountdown(p.restUntil);
    if (p.captcha) {
      pausedByCaptcha = true;
      $('captchaBanner').style.display = 'block';
    }
    pcUpdate(p);
    if (p.currentAction) logLine(p.currentAction, p.logKind);
  }
  if (msg.action === 'discoveryDone') {
    canResume = (msg.doneProducts !== undefined) && msg.doneProducts >= 0; // best-effort; getState corrects this
    pausedByCaptcha = !!msg.captcha;
    setRunningUI(false);
    startRestCountdown(0); // hide the banner if we were resting
    let label;
    if (msg.captcha) {
      label = 'Paused — Google verification check. Click Resume after solving it manually in your browser.';
    } else if (msg.error) {
      label = `Error: ${msg.error}`;
    } else if (msg.stopped) {
      label = `Stopped — ${msg.totalKeywords} keywords, ${msg.doneProducts || 0} products marked done`;
    } else {
      label = `Done — ${msg.totalKeywords} keywords, ${msg.doneProducts || 0} products marked done`;
    }
    $('statusText').textContent = label;
    syncHeaderState(false);
    $('exportCsvBtn').disabled = msg.totalKeywords === 0;
    $('exportXlsxBtn').disabled = msg.totalKeywords === 0;
    $('pushBtn').disabled = msg.totalKeywords === 0;
    if (msg.doneProducts !== undefined) $('doneProductsStat').textContent = msg.doneProducts;
    logLine(label, (msg.error || msg.captcha || msg.stopped) ? 'err' : 'ok');
    // Mark every stage on the progress card as complete (run finished).
    if (!msg.error && !msg.captcha) {
      ['init','kp','r1','r2','rs','export'].forEach(s => {
        const el = document.getElementById(`pcStage-${s}`);
        if (!el) return;
        el.classList.remove('active','pending'); el.classList.add('done');
        const icon = el.querySelector('.pc-stage-icon');
        if (icon) icon.textContent = '✓';
      });
      $('pcRemaining').textContent = 'finished';
    }
    // Re-sync canResume + button visibility from authoritative background state.
    chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
      if (!state) return;
      canResume = !!state.canResume;
      runIntent = !!state.runIntent;
      setRunningUI(false);
      updateWorkerLiveStatus(state);
    });
  }
});

// ---- Reset progress (shared by both buttons: Run tab + Settings tab) ----
function doResetProgress(onLog) {
  if (!confirm('Reset clears the accumulated report AND the done-products list. Continue?')) return;
  chrome.runtime.sendMessage({ action: 'resetProgress' }, (resp) => {
    if (resp?.ok) {
      $('doneProductsStat').textContent = '0';
      $('keywordCount').textContent = '0';
      $('productsDone').textContent = '0';
      $('queueProcessed').textContent = '0';
      paintBar('productsBar', 0, 1);
      paintBar('queueBar', 0, 1);
      $('exportCsvBtn').disabled = true;
      $('exportXlsxBtn').disabled = true;
      $('pushBtn').disabled = true;
      $('statusText').textContent = 'Idle';
      syncHeaderState(false);
      onLog?.('Reset complete.', 'ok');
    } else {
      onLog?.(`Reset failed: ${resp?.error || 'unknown'}`, 'err');
    }
  });
}
$('resetBtn').addEventListener('click', () => {
  doResetProgress((text) => {
    $('resetSaved').textContent = text;
    setTimeout(() => { $('resetSaved').textContent = ''; }, 2000);
  });
});
// Run-tab Reset button — same flow, just logs into the panel log instead of
// the Settings-tab status line.
const runResetBtn = $('runResetBtn');
if (runResetBtn) {
  runResetBtn.addEventListener('click', () => {
    doResetProgress((text, kind) => logLine(text, kind));
  });
}

// ---- On popup open, refresh state from background ----
chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
  if (!state) {
    logLine('Could not reach background (SW may still be waking).', 'err');
    return;
  }
  canResume = !!state.canResume;
  pausedByCaptcha = !!state.pausedByCaptcha;
  runIntent = !!state.runIntent;
  setRunningUI(!!state.running);
  updateWorkerLiveStatus(state);
  if (state.reportSize > 0) {
    $('exportCsvBtn').disabled = false;
    $('exportXlsxBtn').disabled = false;
    $('pushBtn').disabled = false;
    $('keywordCount').textContent = state.reportSize;
  }
  if (state.lastStatus) $('statusText').textContent = state.lastStatus;
  syncHeaderState(!!state.running);
  if (state.doneProducts !== undefined) $('doneProductsStat').textContent = state.doneProducts;
  // Seed the per-product card's batch-progress label from getState — the
  // progress events that drive pcBatchLabel only arrive when a row is
  // emitted, so if the popup opens BETWEEN events (or after a SW restart
  // mid-run) the label sticks at the default "Product 0 of 0" even though
  // there are 23 products queued. state.totalProducts is the persisted
  // truth (= state.lastProducts.length).
  if (typeof state.totalProducts === 'number' && state.totalProducts > 0) {
    const total = state.totalProducts;
    const done = state.doneProducts || 0;
    const pct = Math.min(100, Math.round((done / total) * 100));
    const labelEl = $('pcBatchLabel');
    const pctEl   = $('pcBatchPct');
    const barEl   = $('pcBatchBar');
    if (labelEl) labelEl.textContent = `Product ${Math.min(done + 1, total)} of ${total}`;
    if (pctEl)   pctEl.textContent   = `${pct}%`;
    if (barEl)   barEl.style.width   = `${pct}%`;
    const totalEl = $('productsTotal');
    const doneEl  = $('productsDone');
    if (totalEl) totalEl.textContent = String(total);
    if (doneEl)  doneEl.textContent  = String(done);
  }
  if (typeof state.restUntil === 'number' && state.restUntil > Date.now()) {
    startRestCountdown(state.restUntil);
  }

  // Restore persisted log so the user can see what happened across SW
  // shutdowns / popup close+reopen cycles.
  if (Array.isArray(state.log) && state.log.length > 0) {
    $('log').innerHTML = '';
    for (const line of state.log) {
      const div = document.createElement('div');
      div.className = `log-line${line.kind ? ' ' + line.kind : ''}`;
      const ts = new Date(line.ts).toLocaleTimeString();
      div.textContent = `[${ts}] ${line.text}`;
      $('log').appendChild(div);
    }
    $('log').scrollTop = $('log').scrollHeight;
  }

  if (state.unpushedCount !== undefined && state.unpushedCount > 0) {
    // CUMULATIVE across all products in the persistent report buffer, not
    // per-batch. The batch CSV export shows the rows added in this run;
    // the "unpushed" counter includes earlier sessions whose rows haven't
    // been sent to AdBrain yet. Label the scope so 124 unpushed vs 46 in
    // the latest export doesn't look like a discrepancy.
    logLine(`${state.unpushedCount} row(s) accumulated in report (across all products) not yet pushed to AdBrain. Click "Push to AdBrain" to send.`, 'ok');
  }
});

function logLine(text, kind) {
  const div = document.createElement('div');
  div.className = `log-line${kind ? ' ' + kind : ''}`;
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${text}`;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

// =====================================================================
// Results tab — sortable, filterable, in-panel keyword view
// =====================================================================
//
// Loads the persisted report from chrome.storage (STORAGE_KEY_LAST_REPORT
// matches background.js's 'adbrainLastReport' key — keep these in sync).
// Sort + filter happen client-side over the full report.

const RT_STORAGE_KEY = 'adbrainLastReport';
let rtAll = [];           // full report
let rtFiltered = [];      // currently-visible subset (post sort+filter)
let rtSort = { field: 'adRating', dir: 'desc' };
let rtSelectedKeyword = null;

async function loadResultsFromStorage() {
  try {
    const data = await chrome.storage.local.get([RT_STORAGE_KEY]);
    rtAll = Array.isArray(data[RT_STORAGE_KEY]) ? data[RT_STORAGE_KEY] : [];
  } catch {
    rtAll = [];
  }
  rtRender();
}

function rtRatingClass(r) {
  if (r >= 80) return 'rt-rating-high';
  if (r >= 50) return 'rt-rating-mid';
  if (r >= 30) return 'rt-rating-low';
  return 'rt-rating-min';
}

function rtPillHtml(value, cls) {
  if (!value) return '<span style="color:var(--muted)">—</span>';
  return `<span class="rt-pill rt-pill-${cls || value}">${String(value).slice(0, 12)}</span>`;
}

function rtImgIndicator(count) {
  const n = count || 0;
  const cls = n > 0 ? 'rt-img-dot-match' : 'rt-img-dot-none';
  return `<span class="rt-img-dot ${cls}"></span>${n}`;
}

function rtTierLabel(t) {
  if (t === 'brand_product')   return 'T1';
  if (t === 'brand_other')     return 'T2';
  if (t === 'generic_product') return 'T3';
  if (t === 'anchor_only')     return 'T4';
  return t || '—';
}

function rtApplyFilters() {
  const q = ($('rtSearch').value || '').toLowerCase().trim();
  const intent = $('rtFilterIntent').value;
  const funnel = $('rtFilterFunnel').value;
  const topic  = $('rtFilterTopic').value;
  const tier   = $('rtFilterTier').value;
  const minR   = parseInt($('rtFilterRating').value || '0', 10);
  const hasImg = $('rtFilterHasImage').checked;
  const hasSel = $('rtFilterHasSellers').checked;

  rtFiltered = rtAll.filter(r => {
    if (q && !(r.keyword || '').toLowerCase().includes(q)) return false;
    if (intent && r.intent !== intent) return false;
    if (funnel && r.funnel !== funnel) return false;
    if (topic  && r.topic  !== topic)  return false;
    if (tier   && r.tier   !== tier)   return false;
    if (minR && (r.adRating || 0) < minR) return false;
    if (hasImg && (r.imageCount || 0) === 0) return false;
    if (hasSel && (r.totalSellers || 0) === 0) return false;
    return true;
  });

  // Sort
  const { field, dir } = rtSort;
  rtFiltered.sort((a, b) => {
    let va = a[field], vb = b[field];
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return dir === 'desc' ? vb - va : va - vb;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'desc' ? -cmp : cmp;
  });
}

function rtRender() {
  rtApplyFilters();
  const tbody = $('rtTbody');

  if (rtAll.length === 0) {
    $('rtSummary').textContent = 'No data yet — run a discovery first.';
    tbody.innerHTML = '<tr><td colspan="7" class="rt-empty">No data yet — run a discovery, then open this tab.</td></tr>';
    return;
  }

  $('rtSummary').textContent = `Showing ${rtFiltered.length} of ${rtAll.length} keywords`;

  if (rtFiltered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="rt-empty">No keywords match the current filters.</td></tr>';
    return;
  }

  const rows = [];
  for (let i = 0; i < rtFiltered.length; i++) {
    const r = rtFiltered[i];
    const sel = (r.keyword && r.keyword === rtSelectedKeyword) ? ' class="selected"' : '';
    rows.push(
      `<tr${sel} data-idx="${i}">` +
        `<td class="rt-keyword-cell" title="${(r.keyword || '').replace(/"/g, '&quot;')}">${(r.keyword || '').slice(0, 60)}</td>` +
        `<td><span class="rt-rating-badge ${rtRatingClass(r.adRating || 0)}">${r.adRating || 0}</span></td>` +
        `<td>${rtImgIndicator(r.imageCount)}</td>` +
        `<td>${r.totalSellers || 0}</td>` +
        `<td>${rtPillHtml(r.intent)}</td>` +
        `<td>${rtPillHtml(r.funnel)}</td>` +
        `<td style="font-size:10px;color:var(--muted)">${rtTierLabel(r.tier)}</td>` +
      `</tr>`
    );
  }
  tbody.innerHTML = rows.join('');

  // Row-click → detail panel
  tbody.querySelectorAll('tr[data-idx]').forEach(tr => {
    tr.addEventListener('click', () => {
      const idx = parseInt(tr.dataset.idx, 10);
      const row = rtFiltered[idx];
      if (row) rtShowDetail(row);
    });
  });
}

function rtShowDetail(row) {
  rtSelectedKeyword = row.keyword;
  $('rtDetailKeyword').textContent = row.keyword || '—';
  const cell = (label, value, opts = {}) => {
    const v = (value == null || value === '') ? '—' : String(value);
    const cls = opts.full ? 'rt-detail-item full' : 'rt-detail-item';
    const vCls = opts.small ? 'rt-detail-value' : 'rt-detail-value';
    return `<div class="${cls}"><div class="rt-detail-label">${label}</div>` +
           `<div class="${vCls}" style="${opts.small ? 'font-size:10px;' : ''}">${v}</div></div>`;
  };
  const parts = [
    cell('Ad rating', row.adRating || 0),
    cell('Frequency', row.frequency || 1),
    cell('Source',    row.source || '—'),
    cell('Tier',      rtTierLabel(row.tier)),
    cell('Intent',    row.intent || '—'),
    cell('Topic',     row.topic  || '—'),
    cell('Funnel',    row.funnel || '—'),
    cell('Parent',    row.parentKeyword || '—'),
    cell('Image matches', row.imageCount || 0),
    cell('Confidence (max)', (row.match_confidence_max || 0) + '%'),
    cell('Confidence (avg)', (row.match_confidence_avg || 0) + '%'),
    cell('Total sellers',    row.totalSellers || 0),
    cell('Seller type', row.seller_type || '—'),
    cell('Ads on SERP', row.adsOnSerp || 0),
    cell('Top seller', row.matchedSellers?.[0] || '—'),
    cell('Top price',  row.matchedPrices?.[0]  || '—'),
    cell('KP volume',      row.kpMonthlySearches || '—'),
    cell('KP competition', row.kpCompetition || '—'),
    cell('KP bid low',     row.kpBidLow  || '—'),
    cell('KP bid high',    row.kpBidHigh || '—'),
    cell('Autosuggest count', row.autosuggestCount || 0),
    cell('Amazon suggestions', row.amazon_suggest_count || 0),
  ];
  if (row.sellers && row.sellers.length) {
    const sellersLine = row.sellers
      .map(s => `${s.domain || ''}${s.price ? ' ('+s.price+')' : ''}`)
      .filter(Boolean).join(' | ');
    parts.push(cell('Sellers on SERP', sellersLine, { full: true, small: true }));
  }
  if (Array.isArray(row.autosuggestions) && row.autosuggestions.length) {
    parts.push(cell('Autosuggestions', row.autosuggestions.join(' | '), { full: true, small: true }));
  }
  $('rtDetailGrid').innerHTML = parts.join('');
  $('rtDetail').style.display = 'block';
  rtRender(); // re-render to mark the row selected
}

// Sort-column click — toggle direction on same field, else default to desc.
document.querySelectorAll('#rtTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const field = th.dataset.sort;
    if (!field) return;
    if (rtSort.field === field) {
      rtSort.dir = (rtSort.dir === 'desc' ? 'asc' : 'desc');
    } else {
      rtSort = { field, dir: 'desc' };
    }
    document.querySelectorAll('#rtTable th').forEach(t => t.classList.remove('sort-active'));
    th.classList.add('sort-active');
    rtRender();
  });
});

// Filter listeners
['rtSearch','rtFilterIntent','rtFilterFunnel','rtFilterTopic','rtFilterTier',
 'rtFilterRating','rtFilterHasImage','rtFilterHasSellers'].forEach(id => {
  const el = $(id);
  if (!el) return;
  const ev = el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(ev, rtRender);
});

// Detail panel close
const _rtClose = $('rtDetailClose');
if (_rtClose) {
  _rtClose.addEventListener('click', () => {
    $('rtDetail').style.display = 'none';
    rtSelectedKeyword = null;
    rtRender();
  });
}

// When a new row arrives from the engine (live discovery), refresh the
// Results tab IF it's currently visible — otherwise the user loads on
// switch. This avoids re-querying storage on every progress message.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'discoveryProgress') {
    if ($('panel-results')?.classList.contains('active')) {
      // Throttle: only reload once per second to avoid storage thrash.
      if (!rtRefreshTimer) {
        rtRefreshTimer = setTimeout(() => {
          rtRefreshTimer = null;
          loadResultsFromStorage();
        }, 1000);
      }
    }
  }
});
let rtRefreshTimer = null;

// ─────────────────────────────────────────────────────────────────
// Manager tab — distributed multi-PC mode
// ─────────────────────────────────────────────────────────────────
// File parsing is identical to the Run tab's fileInput handler — but we
// keep a separate buffer (mgrParsedProducts) so loading a queue file
// doesn't overwrite the local-mode parsedProducts on the Run tab.
let mgrParsedProducts = [];

// ─── Role-based UI ───
// Setting body[data-mgr-role] is the SOLE driver of role-based
// visibility. Tabs and sections marked with [data-show-when="..."]
// are shown/hidden via CSS based on the body attribute. This replaces
// the previous per-element style.display toggling — single source of
// truth, no per-section JS, easier to add new role-gated elements.
const MGR_ROLE_KEY = 'adbrainMgrRole';

// Role-aware hint text shown in the banner so the user always knows
// what THIS role means for their PC.
const ROLE_HINT = {
  manager: 'Upload products, watch progress, download all CSVs',
  worker:  'Claim chunks from the queue, run the engine',
  both:    'Single-PC: do everything on this machine',
};

function mgrApplyRole(role) {
  if (!['manager', 'worker', 'both'].includes(role)) role = 'both';
  localStorage.setItem(MGR_ROLE_KEY, role);
  document.body.dataset.mgrRole = role;
  // Active-state styling for the banner buttons.
  document.querySelectorAll('.role-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.role === role);
  });
  const hint = document.getElementById('roleBannerHint');
  if (hint) hint.textContent = ROLE_HINT[role] || '';
  // If the current active tab is now hidden by the new role, fall back
  // to the first visible tab so the user isn't staring at an empty
  // panel. Queue is visible for all roles so it's a safe default.
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    const sw = String(activeTab.dataset.showWhen || '');
    if (!sw.includes(role)) {
      const firstVisible = Array.from(document.querySelectorAll('.tab'))
        .find(t => String(t.dataset.showWhen || '').includes(role));
      if (firstVisible) firstVisible.click();
    }
  }
  // Re-run the creds check on every role change. The credentials warning
  // card should show up regardless of which tab is active — workers
  // newly switched in shouldn't have to click Queue to see they're
  // missing keys. Safe to call before the function exists (defined
  // later in this file) because role-button click handlers fire on
  // user interaction, after parse.
  if (typeof mgrCheckCreds === 'function') mgrCheckCreds();
}
document.querySelectorAll('.role-btn').forEach(b => {
  b.addEventListener('click', () => mgrApplyRole(b.dataset.role));
});
mgrApplyRole(localStorage.getItem(MGR_ROLE_KEY) || 'both');

// Inline credentials card. Hides when both serviceKey + supabaseUrl
// are populated so daily use isn't visually cluttered. First-time
// setup happens here without a Settings-tab detour.
function mgrCheckCreds() {
  chrome.runtime.sendMessage({ action: 'jobs:credsStatus' }, (resp) => {
    if (!resp?.ok) return;
    const card = $('mgrCredsCard');
    const status = $('mgrCredsStatus');
    const haveAll = resp.hasServiceKey && resp.hasSupabaseUrl;
    // The card now ALWAYS stays visible — the setup-code helper inside it
    // is useful even after credentials are set (manager generates the
    // code from saved creds). The header status line just reflects state.
    if (card) card.style.display = '';
    if (haveAll) {
      if (status) {
        status.textContent = '✓ Connected to Supabase. Generate a setup code below to share with other PCs.';
        status.style.color = 'var(--success)';
      }
    } else {
      if (status) {
        const missing = [];
        if (!resp.hasSupabaseUrl) missing.push('Supabase URL');
        if (!resp.hasServiceKey)  missing.push('service_role key');
        status.textContent = `Missing: ${missing.join(' + ')}. Paste below, OR use a setup code from another PC.`;
        status.style.color = 'var(--warn)';
      }
    }
    if (resp.supabaseUrl && $('mgrSupabaseUrl') && !$('mgrSupabaseUrl').value) {
      $('mgrSupabaseUrl').value = resp.supabaseUrl;
    }
  });
}

$('mgrSaveCredsBtn')?.addEventListener('click', () => {
  const url = $('mgrSupabaseUrl').value.trim();
  const key = $('mgrServiceKey').value.trim();
  const r = $('mgrSaveCredsResult');
  if (!url || !key) { setQResult(r, 'Both fields required.', 'error'); return; }
  chrome.runtime.sendMessage({ action: 'jobs:saveCreds', supabaseUrl: url, serviceKey: key }, (resp) => {
    if (!resp?.ok) { setQResult(r, `Save failed: ${resp?.error || 'unknown'}`, 'error'); return; }
    setQResult(r, '✓ Saved. Settings tab also reflects these values.', 'success');
    $('mgrServiceKey').value = ''; // wipe from DOM so it doesn't lurk
    mgrCheckCreds();
  });
});

// Helper: write a status message to a .queue-card-result div with the
// proper colour class. Replaces the old `element.style.color = 'var(--X)'`
// pattern so the result line picks up the CSS background+border treatment
// (success = green pill, error = red pill, etc.) instead of just changing
// text colour.
function setQResult(el, text, kind = 'info') {
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('success', 'error', 'info', 'warn');
  if (text) el.classList.add(kind);
  // Clear any legacy inline colour from older code so the class wins.
  el.style.color = '';
}

// ─── Setup code (one-string portable creds) ───
// Generate: pull saved supabaseUrl + service_role from background, encode
// as base64 JSON so it's one string the user can copy/paste to other
// PCs. Apply: decode the string and save the contained creds. Single
// copy/paste setup per worker — replaces the two-field paste workflow.
const SETUP_CODE_VERSION = 1;

$('mgrGenerateSetupBtn')?.addEventListener('click', () => {
  const r = $('mgrSaveCredsResult');
  chrome.runtime.sendMessage({ action: 'jobs:exportSetupCode' }, (resp) => {
    if (!resp?.ok) {
      $('mgrSetupCode').value = '';
      setQResult(r, `Generate failed: ${resp?.error || 'creds not saved yet'}`, 'error');
      return;
    }
    $('mgrSetupCode').value = resp.code;
    $('mgrCopySetupBtn').disabled = false;
    setQResult(r, '✓ Setup code generated — copy + paste to worker PCs.', 'success');
  });
});

$('mgrCopySetupBtn')?.addEventListener('click', async () => {
  const txt = $('mgrSetupCode').value.trim();
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    $('mgrCopySetupBtn').textContent = '✓ Copied';
    setTimeout(() => { $('mgrCopySetupBtn').textContent = 'Copy'; }, 1500);
  } catch {
    // Clipboard API may be blocked in some contexts — fall back to
    // selecting the textarea so the user can manually copy.
    $('mgrSetupCode').select();
  }
});

$('mgrApplySetupBtn')?.addEventListener('click', () => {
  const r = $('mgrApplySetupResult');
  const raw = $('mgrApplySetupCode').value.trim();
  if (!raw) { setQResult(r, 'Paste the setup code first.', 'error'); return; }
  chrome.runtime.sendMessage({ action: 'jobs:importSetupCode', code: raw }, (resp) => {
    if (!resp?.ok) { setQResult(r, `Apply failed: ${resp?.error || 'invalid code'}`, 'error'); return; }
    const kpNote = resp.applied?.kpUrl ? ' Keyword Planner URL also configured.' : '';
    setQResult(r, `✓ Setup applied — Supabase connected.${kpNote} You can now click Connect & start working.`, 'success');
    $('mgrApplySetupCode').value = '';
    mgrCheckCreds();
  });
});

function _mgrParseRow(row) {
  let urlVal = '', priVal = '', skuVal = '', handlesVal = '', brandVal = '';
  for (const k of Object.keys(row)) {
    const kl = k.toLowerCase().trim();
    if (kl === 'product url' || kl === 'producturl' || kl === 'url') urlVal = String(row[k]).trim();
    if (kl === 'priority' || kl === 'priroty' || kl === 'prioty' || kl === 'priorty' || kl === 'rank' || kl === 'order') priVal = String(row[k]).trim();
    if (!brandVal && (kl === 'brand' || kl === 'brands' || kl === 'manufacturer')) brandVal = String(row[k]).trim();
    if (!skuVal && (kl === 'sku' || /\bsku\b/.test(kl) || kl === 'item id' || kl === 'item number' || kl === 'product code' || kl === 'product id')) skuVal = String(row[k]).trim();
    if (kl === 'handles' || kl === 'handle' || kl === 'extra seeds' || kl === 'seeds' || kl === 'extra keywords') handlesVal = String(row[k]).trim();
  }
  return { urlVal, priVal, skuVal, handlesVal, brandVal };
}

$('mgrFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    mgrParsedProducts = [];
    let invalid = 0;
    for (const row of rows) {
      const { urlVal, priVal, skuVal, handlesVal, brandVal } = _mgrParseRow(row);
      if (!urlVal) { invalid++; continue; }
      try { new URL(urlVal); } catch { invalid++; continue; }
      const priority = parseInt(priVal, 10);
      mgrParsedProducts.push({
        url: urlVal, sku: skuVal,
        priority: (priority >= 1 && priority <= 100) ? priority : 100,
        handles: handlesVal ? handlesVal.split(/[|,;]/).map(s => s.trim()).filter(Boolean) : [],
        brands: brandVal ? [brandVal] : [],
      });
    }
    $('mgrFileInfo').textContent = `${mgrParsedProducts.length} valid URL(s) loaded${invalid ? ` (${invalid} rejected)` : ''}`;
    $('mgrFileInfo').style.color = mgrParsedProducts.length > 0 ? 'var(--success)' : 'var(--danger)';
    $('mgrUploadBtn').disabled = mgrParsedProducts.length === 0;
  } catch (err) {
    $('mgrFileInfo').textContent = `Parse error: ${err.message}`;
    $('mgrFileInfo').style.color = 'var(--danger)';
    mgrParsedProducts = [];
    $('mgrUploadBtn').disabled = true;
  }
});

// Upload current file to the shared queue.
$('mgrUploadBtn')?.addEventListener('click', () => {
  if (mgrParsedProducts.length === 0) return;
  const batchId = ($('mgrBatchId').value || '').trim() || String(Date.now());
  const r = $('mgrUploadResult');
  $('mgrUploadBtn').disabled = true;
  setQResult(r, `Uploading ${mgrParsedProducts.length} product(s)…`, 'info');
  chrome.runtime.sendMessage(
    { action: 'jobs:upload', products: mgrParsedProducts, batchId },
    (resp) => {
      $('mgrUploadBtn').disabled = false;
      if (!resp?.ok) { setQResult(r, `Upload failed: ${resp?.error || 'unknown'}`, 'error'); return; }
      // PostgREST returned ok but inserted 0 rows — usually means RLS is
      // blocking writes or the schema cache is stale. Surface this clearly
      // instead of showing a falsely-cheerful "✓ Uploaded 0/N".
      const errLine = (resp.errors && resp.errors.length > 0)
        ? `\nErrors: ${resp.errors.slice(0, 2).join(' | ')}`
        : '';
      if (resp.uploaded === 0 && resp.total > 0) {
        setQResult(r,
          `Upload returned 0 inserted rows out of ${resp.total}. Check Supabase RLS policies on adbrain_discovery_jobs, OR run "NOTIFY pgrst, 'reload schema';" in SQL editor if you just created the table.${errLine}`,
          'error');
        return;
      }
      const partial = resp.uploaded < resp.total ? ` (${resp.total - resp.uploaded} skipped — see errors below)` : '';
      const dupNote = (resp.duplicatesDropped && resp.duplicatesDropped > 0)
        ? `\nNote: ${resp.duplicatesDropped} duplicate row(s) in your file were merged (same product URL appeared more than once).`
        : '';
      const kind = resp.uploaded < resp.total ? 'warn' : 'success';
      setQResult(r,
        `✓ Uploaded ${resp.uploaded}/${resp.total} into batch "${resp.batchId}"${partial}. Share this Batch ID with worker PCs.${dupNote}${errLine}`,
        kind);
      // Pre-fill the claim + download section's batch ID so single-PC manager+worker is one click.
      if (!$('mgrClaimBatchId').value)    $('mgrClaimBatchId').value    = resp.batchId;
      if (!$('mgrBatchId').value)         $('mgrBatchId').value         = resp.batchId;
      if (!$('mgrDownloadBatchId').value) $('mgrDownloadBatchId').value = resp.batchId;
      mgrRefreshSummary();
    }
  );
});

// Render live summary + active-worker breakdown using the .stat-grid
// CSS — coloured stat tiles per batch instead of the prior inline-styled
// rows. Each batch becomes a self-contained card with progress bar +
// 4-tile metrics grid.
function _esc(s) {
  return String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
}
function mgrRenderSummary(summary, workers, failed) {
  const wrap = $('mgrSummary');
  if (!wrap) return;
  if (!Array.isArray(summary) || summary.length === 0) {
    wrap.innerHTML = `<div style="padding:14px 8px; text-align:center; color:var(--muted); font-size:12px;">No batches yet — upload a file above to create one.</div>`;
    return;
  }
  const rows = summary.map(b => {
    const pct = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;
    return `
      <div style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px; background:var(--bg);">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
          <code style="font-weight:600; font-size:12px; color:var(--text);">${_esc(b.batch_id)}</code>
          <span style="font-size:11px; color:var(--muted);"><strong style="color:var(--text);">${b.done}</strong> / ${b.total} · ${pct}%</span>
        </div>
        <div style="height:4px; background:var(--panel); border-radius:2px; overflow:hidden; margin-bottom:8px;">
          <div style="height:100%; width:${pct}%; background:#22c55e; transition:width 0.3s;"></div>
        </div>
        <div class="stat-grid">
          <div class="stat-tile pending"><div class="stat-tile-value">${b.pending}</div><div class="stat-tile-label">pending</div></div>
          <div class="stat-tile claimed"><div class="stat-tile-value">${b.claimed}</div><div class="stat-tile-label">claimed</div></div>
          <div class="stat-tile done"><div class="stat-tile-value">${b.done}</div><div class="stat-tile-label">done</div></div>
          <div class="stat-tile failed"><div class="stat-tile-value">${b.failed}</div><div class="stat-tile-label">failed</div></div>
        </div>
      </div>
    `;
  }).join('');
  wrap.innerHTML = rows;

  // Per-worker breakdown — now shows BOTH done count and in-flight count
  // per PC so the manager can see who's actually contributing vs who's
  // sitting idle. Coloured heartbeat dot indicates freshness.
  const wWrap = $('mgrWorkers');
  if (wWrap) {
    if (!Array.isArray(workers) || workers.length === 0) {
      wWrap.innerHTML = '';
    } else {
      const wRows = workers.map(w => {
        const ago = w.lastHeartbeat ? Math.round((Date.now() - new Date(w.lastHeartbeat).getTime()) / 1000) : null;
        const hb = ago === null ? '—'
                 : ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
        const hbColor = ago === null ? 'var(--muted)' : (ago < 90 ? '#22c55e' : (ago < 300 ? '#f59e0b' : '#ef4444'));
        // Backwards compat: old worker shape had `count`, new shape has
        // `inFlight` + `doneCount` + `failedCount`. Support both.
        const inFlight = (typeof w.inFlight === 'number') ? w.inFlight : (w.count || 0);
        const doneCount = w.doneCount || 0;
        const failedCount = w.failedCount || 0;
        const failedBadge = failedCount > 0
          ? ` · <span style="color:#ef4444;">${failedCount} failed</span>`
          : '';
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:4px; font-size:11px;">
            <span><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${hbColor}; margin-right:6px; vertical-align:middle;"></span><strong style="color:var(--text);">${_esc(w.worker)}</strong></span>
            <span style="color:var(--muted);">
              <strong style="color:var(--text);">${doneCount}</strong> done ·
              <strong style="color:var(--text);">${inFlight}</strong> in flight${failedBadge} ·
              ${hb}
            </span>
          </div>
        `;
      }).join('');
      wWrap.innerHTML = `<div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.4px; margin:8px 0 6px;">Per-worker progress</div>${wRows}`;
    }
  }

  // Failed-jobs panel — surfaces which PC failed which product and why,
  // with a Re-queue button per row so the manager can retry transient
  // errors (CAPTCHA, KP timeout, network) without re-uploading the file.
  const fWrap = $('mgrFailed');
  if (fWrap) {
    if (!Array.isArray(failed) || failed.length === 0) {
      fWrap.innerHTML = '';
    } else {
      const fRows = failed.map(f => {
        const name = f.product_name || f.sku || f.product_url || '(unnamed)';
        const reason = f.failed_reason || 'no reason recorded';
        const worker = f.claimed_by || '(unknown)';
        return `
          <div style="padding:8px 10px; background:rgba(239,68,68,0.04); border:1px solid rgba(239,68,68,0.25); border-left:3px solid #ef4444; border-radius:6px; margin-bottom:4px; font-size:11px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <div style="flex:1; min-width:0;">
                <div style="font-weight:600; color:var(--text); word-break:break-word;">${_esc(name)}</div>
                <div style="color:var(--muted); margin-top:3px; font-size:10px;">
                  worker: <strong style="color:var(--text);">${_esc(worker)}</strong>
                  · attempts: ${f.attempts || 0}
                  · reason: <span style="color:var(--text);">${_esc(reason)}</span>
                </div>
              </div>
              <button class="secondary mgr-requeue-btn" data-job-id="${f.id}" style="padding:4px 10px; font-size:10px; flex-shrink:0;">Re-queue</button>
            </div>
          </div>
        `;
      }).join('');
      const headerNote = failed.length === 50
        ? ` (showing newest 50)`
        : ` (${failed.length})`;
      fWrap.innerHTML = `<div style="font-size:10px; color:#ef4444; text-transform:uppercase; letter-spacing:0.4px; margin:12px 0 6px;">Failed jobs${headerNote}</div>${fRows}`;
      // Wire up the per-row re-queue buttons.
      fWrap.querySelectorAll('.mgr-requeue-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.jobId;
          btn.disabled = true;
          btn.textContent = 'Re-queuing…';
          chrome.runtime.sendMessage({ action: 'jobs:requeue', jobId: id }, (resp) => {
            if (resp?.ok) {
              btn.textContent = '✓ Queued';
              setTimeout(mgrRefreshSummary, 400);
            } else {
              btn.disabled = false;
              btn.textContent = 'Re-queue';
              alert(`Re-queue failed: ${resp?.error || 'unknown'}`);
            }
          });
        });
      });
    }
  }
}

function mgrRefreshSummary() {
  // Prefer the most specific batch ID the user has typed — claim section
  // takes priority over upload/download since claim is the worker's
  // primary focus and most-recently-touched.
  const batchId = ($('mgrClaimBatchId').value
    || $('mgrDownloadBatchId').value
    || $('mgrBatchId').value
    || '').trim();
  chrome.runtime.sendMessage(
    { action: 'jobs:summary', batchId },
    (resp) => {
      if (!resp?.ok) {
        $('mgrSummary').textContent = `Status fetch failed: ${resp?.error || 'unknown'}`;
        $('mgrSummary').style.color = 'var(--danger)';
        return;
      }
      $('mgrSummary').style.color = '';
      mgrRenderSummary(resp.summary, resp.workers, resp.failed);
    }
  );
}

$('mgrRefreshBtn')?.addEventListener('click', mgrRefreshSummary);

$('mgrReleaseBtn')?.addEventListener('click', () => {
  const r = $('mgrReleaseResult');
  setQResult(r, 'Releasing…', 'info');
  chrome.runtime.sendMessage({ action: 'jobs:releaseStale', staleMinutes: 10 }, (resp) => {
    if (!resp?.ok) { setQResult(r, `Release failed: ${resp?.error || 'unknown'}`, 'error'); return; }
    setQResult(r, `✓ Released ${resp.released} stale claim(s).`, 'success');
    mgrRefreshSummary();
  });
});

// Persist worker ID on every keystroke (debounced 400ms). The previous
// 'change' event only fired on blur — if the user typed an ID and
// immediately clicked "Claim & start" the new value never got persisted,
// and on next popup open the input pre-filled from the OLD stored value.
let _mgrWorkerIdTimer = null;
$('mgrWorkerId')?.addEventListener('input', () => {
  const id = $('mgrWorkerId').value.trim();
  if (_mgrWorkerIdTimer) clearTimeout(_mgrWorkerIdTimer);
  _mgrWorkerIdTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'jobs:setWorkerId', workerId: id });
  }, 400);
});

// Worker live-status update — tracks engine state and updates the
// worker live block in real time. Driven by discoveryProgress events
// (when state changes) + getState polling (when popup opens fresh).
function updateWorkerLiveStatus(state) {
  const live = $('workerLiveStatus');
  const connectActions = $('workerConnectActions');
  const stopActions = $('workerStopActions');
  if (!live) return;
  const running = !!state?.running;
  if (running) {
    live.style.display = 'block';
    if (connectActions) connectActions.style.display = 'none';
    if (stopActions) stopActions.style.display = 'flex';
    const dot = $('workerLiveDot');
    if (dot) dot.classList.remove('idle', 'err');
    const statusText = state.pausedByCaptcha ? 'Paused (CAPTCHA)' : 'Working';
    if (state.pausedByCaptcha && dot) dot.classList.add('err');
    $('workerLiveStatusText').textContent = statusText;
    $('workerLiveBatch').textContent = state.queueBatchId ? `batch ${String(state.queueBatchId).slice(0, 16)}` : '—';
    $('workerLiveDone').textContent = (typeof state.doneProducts === 'number')
      ? state.doneProducts
      : (state.doneProducts?.length || 0);
    $('workerLiveFlight').textContent = state.claimedJobs?.length || 0;
    $('workerLiveTotal').textContent = state.reportSize || 0;
  } else {
    live.style.display = 'none';
    if (connectActions) connectActions.style.display = 'flex';
    if (stopActions) stopActions.style.display = 'none';
  }
}

// Stop buttons (worker mode). "Graceful" = honor mid-product, finish
// current product, then halt + clear continuous mode. "Force" = the
// same Stop signal but explicit copy so the user knows it's not magic.
$('workerStopBtn')?.addEventListener('click', () => {
  if (!confirm('Stop after the current product finishes? The remaining claimed jobs will be released back to the queue.')) return;
  chrome.runtime.sendMessage({ action: 'stopDiscovery' }, () => {
    $('workerStopBtn').textContent = 'Stop requested…';
    $('workerStopBtn').disabled = true;
  });
});
$('workerForceStopBtn')?.addEventListener('click', () => {
  if (!confirm('Stop immediately? In-flight SERP loads / KP queries will be abandoned.')) return;
  chrome.runtime.sendMessage({ action: 'stopDiscovery' }, () => {
    $('workerForceStopBtn').textContent = 'Stopping…';
    $('workerForceStopBtn').disabled = true;
  });
});

// One-button worker connect — auto-detects the newest pending batch
// and starts a continuous-claim loop. Replaces the manual Batch ID +
// chunk size + Claim button workflow for the common worker case.
$('mgrAutoConnectBtn')?.addEventListener('click', () => {
  const r = $('mgrAutoConnectResult');
  const workerId = $('mgrWorkerId').value.trim();
  if (!workerId) { setQResult(r, 'Set a Worker ID first.', 'error'); return; }
  // Force-persist Worker ID before sending in case debounce hasn't fired.
  chrome.runtime.sendMessage({ action: 'jobs:setWorkerId', workerId });
  setQResult(r, 'Connecting — finding latest batch…', 'info');
  $('mgrAutoConnectBtn').disabled = true;
  const runOpts = (typeof readRunOpts === 'function') ? readRunOpts() : {};
  chrome.runtime.sendMessage(
    { action: 'jobs:autoConnectWorker', workerId, chunkSize: 5, runOpts },
    (resp) => {
      $('mgrAutoConnectBtn').disabled = false;
      if (!resp?.ok) {
        setQResult(r, `Connect failed: ${resp?.error || 'unknown'}`, 'error');
        return;
      }
      if (resp.claimed === 0) {
        setQResult(r,
          `No pending jobs in batch "${resp.batchId}" right now. Manager hasn't uploaded anything yet, or another worker grabbed everything.`,
          'warn');
        return;
      }
      setQResult(r,
        `✓ Connected to batch "${resp.batchId}". Claimed ${resp.claimed} job(s) — engine starting. Will auto-claim more when this chunk finishes.`,
        'success');
      mgrRefreshSummary();
    }
  );
});

// Claim a chunk and hand it to the engine.
$('mgrClaimBtn')?.addEventListener('click', () => {
  const r = $('mgrClaimResult');
  const workerId = $('mgrWorkerId').value.trim();
  const batchId  = $('mgrClaimBatchId').value.trim();
  const limit    = parseInt($('mgrChunkSize').value, 10) || 5;
  if (!workerId) { setQResult(r, 'Set a Worker ID first.', 'error'); return; }
  if (!batchId)  { setQResult(r, 'Paste a Batch ID to claim from.', 'error'); return; }
  // Force-persist the Worker ID synchronously in case the user typed it
  // and clicked Claim before the debounced 'input' handler fired.
  chrome.runtime.sendMessage({ action: 'jobs:setWorkerId', workerId });
  setQResult(r, 'Claiming…', 'info');
  // Snapshot the same runOpts the Run tab would use so the engine runs
  // identically whether started from a local file or a queue claim.
  const runOpts = (typeof readRunOpts === 'function') ? readRunOpts() : {};
  chrome.runtime.sendMessage(
    { action: 'jobs:claimAndStart', workerId, batchId, limit, runOpts },
    (resp) => {
      if (!resp?.ok) { setQResult(r, `Claim failed: ${resp?.error || 'unknown'}`, 'error'); return; }
      if (resp.claimed === 0) {
        setQResult(r, '✓ Queue empty — no jobs left to claim in this batch.', 'warn');
        return;
      }
      setQResult(r, `✓ Claimed ${resp.claimed} job(s). Engine started — watch the Run tab.`, 'success');
      mgrRefreshSummary();
    }
  );
});

// Open the full-screen Operations Dashboard in a new browser tab.
$('mgrOpenDashboardBtn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'dashboard:open' });
});

// Centralised CSV download — pull every row for a batch from Supabase
// and generate per-SKU CSVs locally. Cures the "CSVs scattered across
// workers' Downloads folders" problem.
$('mgrDownloadBtn')?.addEventListener('click', () => {
  const r = $('mgrDownloadResult');
  const batchId = $('mgrDownloadBatchId').value.trim()
    || $('mgrClaimBatchId').value.trim()
    || $('mgrBatchId').value.trim();
  if (!batchId) { setQResult(r, 'Paste a Batch ID to download.', 'error'); return; }
  $('mgrDownloadBtn').disabled = true;
  setQResult(r, 'Fetching from Supabase…', 'info');
  chrome.runtime.sendMessage(
    { action: 'jobs:downloadBatchCsvs', batchId },
    (resp) => {
      $('mgrDownloadBtn').disabled = false;
      if (!resp?.ok) { setQResult(r, `Download failed: ${resp?.error || 'unknown'}`, 'error'); return; }
      if (resp.count === 0) {
        setQResult(r, 'No rows in this batch yet — workers haven\'t pushed anything.', 'warn');
        return;
      }
      setQResult(r,
        `✓ Downloaded ${resp.count} CSV(s) (${resp.rows} rows) into Downloads/${resp.folder || 'adbrain_' + batchId}/`,
        'success');
    }
  );
});

// Auto-refresh summary every 30s while the Manager panel is visible,
// and run the creds check + role apply on tab open so worker PCs see a
// clean focused UI immediately.
let mgrAutoRefresh = null;
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (mgrAutoRefresh) { clearInterval(mgrAutoRefresh); mgrAutoRefresh = null; }
    // Tab id changed from 'manager' to 'queue' so the label could rename
    // without breaking selectors; the panel id is panel-queue.
    if (tab.dataset.tab === 'queue') {
      mgrCheckCreds();
      mgrRefreshSummary();
      mgrAutoRefresh = setInterval(mgrRefreshSummary, 30000);
    }
  });
});
// Also run a creds check on popup open so the warning shows immediately
// if this is a fresh PC install.
mgrCheckCreds();

// Hydrate worker ID on popup open so it persists across sessions.
chrome.storage.local.get(['adbrainWorkerId'], (data) => {
  if (data.adbrainWorkerId) {
    const el = $('mgrWorkerId');
    if (el) el.value = data.adbrainWorkerId;
  }
});
