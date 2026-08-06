# Bugfix Summary — Comprehensive Audit

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