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
      let urlVal = '', priVal = '', skuVal = '', handlesVal = '';
      for (const k of Object.keys(row)) {
        const kl = k.toLowerCase().trim();
        if (kl === 'product url' || kl === 'producturl' || kl === 'url') urlVal = String(row[k]).trim();
        if (kl === 'priority' || kl === 'pri') priVal = String(row[k]).trim();
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
  if (state.reportSize > 0) {
    $('exportCsvBtn').disabled = false;
    $('exportXlsxBtn').disabled = false;
    $('pushBtn').disabled = false;
    $('keywordCount').textContent = state.reportSize;
  }
  if (state.lastStatus) $('statusText').textContent = state.lastStatus;
  syncHeaderState(!!state.running);
  if (state.doneProducts !== undefined) $('doneProductsStat').textContent = state.doneProducts;
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
