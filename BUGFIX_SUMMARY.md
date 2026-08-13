# Bugfix Summary — Comprehensive Audit

## Issues Fixed

### 0. CRITICAL: `_resumedPriorRows` ReferenceError (crashed every product on resume)
**Root cause**: The code at line 3758 referenced `_resumedPriorRows` which was **never declared**. The comment claimed it was "declared BEFORE the try block" but the actual code used `const prior` inside the try block (line 3650). This `for` loop was NOT inside a try/catch, so it threw a ReferenceError on **every product**, crashing the entire run. This was the #1 reason SKUs took too long — the engine crashed and restarted on every product, never completing any.

**Fix** (`modules/keyword-discovery.js`): Declared `let _resumedPriorRows = []` **before** the try block so the normalisation loop below can access it. The previous code had `prior` scoped inside the try, then referenced a non-existent `_resumedPriorRows` in the loop below — a ReferenceError on every product, which crashed the whole run.

**Impact**: Previously, resume was completely broken. Every product crashed with a ReferenceError, the error was caught and logged as "Resume state unavailable", and every round re-ran from scratch. Fixing this means resumed SKUs correctly skip already-completed rounds, saving 5-10+ min per SKU on re-queued products.

**Per-SKU performance impact**: This bug alone could add 10-30+ minutes per SKU depending on how many rounds had already completed, because every round (KP, PAA, R1, R2, Amazon) re-ran from scratch on every resume.

### Algorithmic Drawbacks Identified (future work — not yet fixed):
1. **Link verification re-fetches same destination URLs repeatedly**: `getProductImages(link)` does a full Shopify .json fetch + HTML scrape for each destination link on every matched keyword. With 60+ keywords per SKU, the same destination URL gets re-fetched dozens of times. A per-product `Map<url, boolean>` cache would eliminate ~3-8s of redundant work per keyword.

2. **`ensureContentScriptReady` waits 20 seconds** before falling back to programmatic injection on every SERP load. This adds 20s to every SERP load when the content script is already injected (most of the time). The function could probe the tab URL first and skip the initial wait.

3. **KP storage poll loop is 3 minutes** (36 × 5s) when the content script dies mid-flow. This is correct for recovery but devastating when the KP session is actually dead — 3 minutes per seed × 5 seeds × 2 attempts = 30 minutes wasted on a dead session before the bail logic kicks in.

## Issues Fixed

### 1. orphan_guard / no_product_url (4,959 rows rejected)
**Root cause**: Manager stores rows in snake_case (`product_url`, `batch_id`), engine reads camelCase (`productUrl`, `batchId`). A `normaliseRow()` helper mapped fields, but the loop reading restored rows from `resumedRounds?.priorRows` silently never ran — `resumedRounds` is a **Set**, which has no `.priorRows`.

**Fixes**:
- `modules/keyword-discovery.js`: Added `normaliseRow()` (20+ field mappings) + captured restored rows in a separate `resumedPriorRows` array so normalization actually executes.

### 2. Amazon SERP 0-listings / selector breakage
**Root cause**: Amazon rotates CSS selectors; old selector set was too narrow. No diagnostics on 0-card results.

**Fixes** (`amazon-reader.js`):
- Expanded selectors: `[data-asin][class*="s-result"]`, `li[data-asin]`, `div[data-asin]`
- Added 0-card diagnostic capturing URL/title/bodyLength/key element presence
- Added `.a-offscreen` price fallback
- Diagnostics always fire (not just on success)

### 3. Amazon tab crash between Step 1 and Step 2
**Root cause**: If Amazon tab crashed between `AMAZON_GET_SUGGESTIONS` and `AMAZON_GET_RESULTS`, keyword silently skipped.

**Fix** (`modules/keyword-discovery.js`): Full tab-recreation + retry in Step 2 matching Step 1's recovery.

### 4. managerRowToReportRow lost all image-match data on restore
**Root cause**: `matched_thumbnails` stored as `"url [conf] | url [conf]"` string, but restored rows got `matched_thumbnails` (string) instead of camelCase arrays. `matchedConfidences`, `matchedSellers`, `matchedPrices`, `matchedQualities`, `matchedLinks`, `verifiedLinks` all lost array shape.

**Fix** (`modules/discovery-jobs.js`):
- Added `_splitMatchedThumbs()` → parses `"url [conf]"` back into `{url, conf}` pairs
- Added `_splitList()` → pipe-string → array
- `managerRowToReportRow` now returns proper camelCase arrays:
  - `matchedThumbnails` (URLs)
  - `matchedConfidences` (numbers)
  - `matchedSellers`, `matchedPrices`, `matchedQualities`
  - `matchedLinks`, `verifiedLinks` (arrays)
  - `sellers: []` placeholder (can't round-trip from joined strings)

---

## Files Modified

| File | Changes |
|------|---------|
| `modules/keyword-discovery.js` | normaliseRow + resumedPriorRows fix + Amazon Step 2 tab recovery |
| `amazon-reader.js` | Expanded selectors + 0-card diagnostics + price fallback |
| `modules/discovery-jobs.js` | managerRowToReportRow round-trip fix (image-match arrays restored) |
| `BUGFIX_SUMMARY.md` | This file |

---

## Deployment

**Workers**: Reload extension in `chrome://extensions/` (🔄)
**Manager**: No changes needed — fixes are entirely client-side

---

## Expected Results
- **orphan_guard**: 0 `no_product_url` rejections for resumed rows
- **Amazon SERP**: Broader selector coverage; diagnostics show exactly which DOM elements are missing on breakage
- **Amazon tab crashes**: Auto-recovery instead of silent keyword loss
- **Resume round-trip**: Restored rows keep `matchedThumbnails` / `matchedConfidences` / `matchedSellers` / `matchedPrices` / `matchedQualities` so exports & re-pushes preserve image-match data