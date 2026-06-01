// config/discovery-config.js
// Browser-only flow:
//   per product (priority order) -> Keyword Planner ideas
//   per keyword -> Google search image-count + autosuggest count -> store
//
// Note: KP automation drives the user's own logged-in Google Ads UI. It is
// brittle (selectors change) and carries ToS risk. The toggle in the popup
// disables it for runs where you only want autosuggest counts.

// Fallback Supabase URL — user can override via the popup Settings tab
// (stored in chrome.storage as 'adbrainSupabaseUrl').
export const SUPABASE_URL = 'https://YOUR-ADBRAIN-PROJECT.supabase.co';
export const SUPABASE_TABLE = 'adbrain_discovered_keywords';

export const STORAGE_KEY_SERVICE_KEY    = 'adbrainServiceKey';
export const STORAGE_KEY_SUPABASE_URL   = 'adbrainSupabaseUrl';
export const STORAGE_KEY_KP_URL         = 'adbrainKpUrl';
export const STORAGE_KEY_LAST_REPORT    = 'adbrainLastReport';
export const STORAGE_KEY_LAST_BATCH     = 'adbrainLastBatch';
export const STORAGE_KEY_LAST_STATUS    = 'adbrainLastStatus';
export const STORAGE_KEY_DONE_PRODUCTS    = 'adbrainDoneProducts';     // array of cleanProductUrl strings
export const STORAGE_KEY_LAST_PUSHED_COUNT = 'adbrainLastPushedCount';  // int — index into accumulated report
export const STORAGE_KEY_LOG               = 'adbrainLog';              // array of {ts, text, kind} — persistent log buffer
export const LOG_MAX = 300;

export const STORAGE_KEY_KP_CACHE = 'adbrainKpCache'; // { [seed.toLowerCase()]: { keywords, ts } }
export const KP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h — KP results don't change minute-to-minute

// Global runaway-prevention ceiling across ALL products in a single run.
// NOT a per-product cap — that's `kpMaxPerProduct` (default 5000, settable
// in the popup). With 23 products × ~200-2000 keywords each the report
// can legitimately reach 5k-20k+ rows; the previous 500 stopped the run
// at product 5 of 23 and trapped the watchdog in an infinite resume
// loop (every resume immediately hit the cap and exited).
export const KEYWORD_CAP = 50000;

// ============ Image-matching configuration ============
// Multi-signal perceptual hashing on SERP thumbnails vs. the product image(s).
// Three independent fingerprints are computed:
//   dHash 64-bit  — gradient structure (robust to brightness shifts)
//   aHash 64-bit  — average-brightness pattern (robust to compression)
//   color RGB     — average color of the center 60% (skips background)
//
// A "match" requires either:
//   - at least 2 of 3 signals STRICTLY agree (their distance <= xxxStrong), OR
//   - all 3 signals are at least BORDERLINE (distance <= xxxMax)
// This eliminates the false positives that pure-dHash matching produced when
// unrelated product photos happened to have similar gradients.
//
// Loose / Normal / Strict profiles. Each carries a per-profile confidence floor
// so the profile choice tunes both structural thresholds AND the minimum score.
//
// Key trade-off — pHash limit: we can only recognise "same image, recompressed
// or slightly modified". We CANNOT recognise "same product photographed
// differently" (different angle, different background, watermarked overlay).
// For that you'd need semantic embeddings, which were removed due to MV3 CSP.
// Realistic recall ceiling per product on a SERP: ~60–70%.
export const MATCH_PROFILES = {
  // Loose — broad recall, more borderline accepts. Use when you'd rather see
  // a possible match and judge from the confidence column than miss it.
  loose: {
    dhashStrong: 12, dhashMax: 22,
    ahashStrong:  9, ahashMax: 16,
    colorStrong: 40, colorMax:  90,
    minConfidence: 15,
  },
  // Normal — default. Tuned to catch same-product re-encodings without
  // accepting random white-background lookalikes.
  normal: {
    dhashStrong:  9, dhashMax: 17,
    ahashStrong:  7, ahashMax: 13,
    colorStrong: 30, colorMax:  65,
    minConfidence: 25,
  },
  // Strict — high-precision, low-recall. Only accept near-pixel-identical.
  strict: {
    dhashStrong:  5, dhashMax: 11,
    ahashStrong:  4, ahashMax:  8,
    colorStrong: 15, colorMax:  35,
    minConfidence: 45,
  },
};
export const DEFAULT_MATCH_PROFILE = 'normal';

// Fallback used when a profile doesn't carry a minConfidence (back-compat).
export const MIN_MATCH_CONFIDENCE = 25;

// Minimum thumbnail size to even attempt fingerprinting (px). Smaller images
// don't produce stable hashes.
export const MIN_THUMBNAIL_DIM = 24;

// Noise filter — cluster matched thumbnails across all keywords for a product
// by visual similarity (dHash hamming). Big clusters = real product matches.
// Tiny clusters = false positives. Drop clusters smaller than MIN_RELATIVE_SIZE
// of the largest cluster (default 0.3 = keep top 70% of appearances).
export const NOISE_FILTER_MIN_RELATIVE_SIZE = 0.3;
export const NOISE_FILTER_CLUSTER_HAMMING   = 5;

// ============ Human-paced defaults ============
// These ranges are intentionally LONG. Slow, randomised pacing + small batches
// is the mechanism that keeps the tool within normal browsing behaviour.
// A full run on 30+ products is expected to take several hours; that is the
// point. Do not shorten these defaults.
//
// Each delay is a UNIFORM-RANDOM pick within [MIN, MAX] per occurrence — not
// a constant — so cadence does not look mechanical to Google's detection.
//
// SEARCH_DELAY: pause BEFORE each initial-tier SERP load (KP1, KP2, PAA seeds).
// Leaf SERPs (autosuggest children) use a separate 5-15s window in the engine.
// PRODUCT_DELAY: additional rest AFTER a product is fully processed.
// CHUNK_REST: long rest between batches of CHUNK_SIZE products.
//
// All randomised within their range. <30s on the SERP side keeps Google's
// per-IP rate threshold from triggering as fast as the 25-50s range did,
// but the engine handles CAPTCHA gracefully (continues with image_count=0)
// if Google does flag a request.
// FAST DEFAULTS — roughly 2× faster than the previous 5-12 / 15-35 set.
// Reasoning: a 23-product run was taking 20+ hours, which is impractical
// to babysit. Halving the pacing keeps the run within "browsing-style"
// cadence (still randomised, still pauses between SERPs) while bringing
// a typical 20-product run down toward a working-day window. CAPTCHA risk
// is higher than the old conservative pacing, but the engine continues
// gracefully when Google does serve a verification page (sets
// image_count=0 for affected rows and moves on). User can override any
// of these in the popup Settings tab if they hit CAPTCHA repeatedly.
export const SEARCH_DELAY_MIN_MS   =        3 * 1000;
export const SEARCH_DELAY_MAX_MS   =        7 * 1000;
export const PRODUCT_DELAY_MIN_MS  =        5 * 1000;
export const PRODUCT_DELAY_MAX_MS  =       12 * 1000;
export const CHUNK_SIZE            =       12;        // fewer chunk-rest breaks
export const CHUNK_REST_MIN_MS     =  2 * 60 * 1000;  // 2 min
export const CHUNK_REST_MAX_MS     =  4 * 60 * 1000;  // 4 min

// Back-compat aliases used by the popup.js storage migration code:
export const DEFAULT_SEARCH_DELAY_MIN_MS  = SEARCH_DELAY_MIN_MS;
export const DEFAULT_SEARCH_DELAY_MAX_MS  = SEARCH_DELAY_MAX_MS;
export const DEFAULT_PRODUCT_DELAY_MIN_MS = PRODUCT_DELAY_MIN_MS;
export const DEFAULT_PRODUCT_DELAY_MAX_MS = PRODUCT_DELAY_MAX_MS;
export const DEFAULT_CHUNK_SIZE           = CHUNK_SIZE;
export const DEFAULT_CHUNK_REST_MIN_MS    = CHUNK_REST_MIN_MS;
export const DEFAULT_CHUNK_REST_MAX_MS    = CHUNK_REST_MAX_MS;

// Short polite jitter between low-risk autosuggest fetches (no SERP load) —
// keep it small, this endpoint is not rate-limited the way SERP is.
export const AUTOSUGGEST_DELAY_MIN_MS = 250;
export const AUTOSUGGEST_DELAY_MAX_MS = 800;

export const DELAY_AFTER_TAB_LOAD_MS     = 1800;
export const TAB_LOAD_TIMEOUT_MS         = 30000;
export const ELEMENT_WAIT_TIMEOUT_MS     = 20000;
// 30s is enough for KP's Discover-keywords card to hydrate on a warm tab
// (typical: 5–20s). Trimmed from 45s — when hydration genuinely fails the
// retry layer adds a fresh-navigate attempt with another 30s window, so
// total worst-case time is the same but the happy path returns faster.
export const KP_HYDRATE_TIMEOUT_MS       = 30000;
export const KP_TABLE_TIMEOUT_MS         = 90000;

// Currency normalisation. Store-locale is gl=in → INR. When the SERP shows
// a USD price (often on nowfoods.com / iherb.com), we convert at this rate
// so price aggregation can sort/compare numerically. Marked as "converted"
// in the row so the user knows the value isn't a live retailer quote.
//
// Update periodically. A stale rate by ±10% doesn't change shopping-rank
// decisions but will show up if the user compares to live prices.
export const USD_TO_INR_RATE             = 83;

// Status strings persisted to chrome.storage. The popup uses these to render
// different UI (e.g. show a Resume button when paused-by-captcha).
export const STATUS_IDLE            = 'Idle';
export const STATUS_RUNNING         = 'Running';
export const STATUS_RESTING         = 'Resting between chunks';
export const STATUS_PAUSED_CAPTCHA  = 'Paused — Google served a verification check';
export const STATUS_PAUSED_USER     = 'Paused by user';

// Storage keys for paced-run state. doneProducts already lives separately;
// these add chunk-rest persistence so a browser restart mid-rest still resumes.
export const STORAGE_KEY_REST_UNTIL    = 'adbrainRestUntil';      // unix ms or 0

export async function getServiceKey() {
  const data = await chrome.storage.local.get([STORAGE_KEY_SERVICE_KEY]);
  return (data[STORAGE_KEY_SERVICE_KEY] || '').trim();
}

// Returns the user-overridden Supabase URL if set, else the file-level fallback.
export async function getSupabaseUrl() {
  const data = await chrome.storage.local.get([STORAGE_KEY_SUPABASE_URL]);
  const userVal = (data[STORAGE_KEY_SUPABASE_URL] || '').trim().replace(/\/+$/, '');
  return userVal || SUPABASE_URL;
}

export async function getKpUrl() {
  const data = await chrome.storage.local.get([STORAGE_KEY_KP_URL]);
  return (data[STORAGE_KEY_KP_URL] || '').trim();
}
