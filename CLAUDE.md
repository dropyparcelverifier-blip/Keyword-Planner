# AdBrain Discovery — project context / handoff

## What the product is
Chrome MV3 extension for e-commerce keyword discovery (Shopify/dropy.in,
India-focused). Per product: pulls Google Keyword Planner ideas, expands via
autosuggest, scrapes Google SERPs, and image-matches (dHash + CLIP) to find
which keywords surface the product. Also drives Amazon.in and pushes results to
a self-hosted SQLite manager over Tailscale (with per-product CSV/XLSX export).

## Architecture
- **Manager / Worker / Both** mode (popup toggle). Distributed via the
  **self-hosted manager** at `manager/server.js` (dependency-free `node:sqlite`
  HTTP server, WAL mode): batches, claim-chunk, pending/claimed/done/failed,
  worker config, "Push to all workers", "Download all CSVs from manager".
  Coordinated by `modules/discovery-jobs.js`; Operations Dashboard =
  `dashboard.html` + `dashboard.js`.
- Engine: `modules/keyword-discovery.js` (paced discovery),
  `modules/keyword-filter.js` (scoring/classification), `image-matcher.js`
  (CLIP via offscreen→sandbox), `modules/discovery-export.js` (CSV/XLSX +
  manager push).
- Content scripts: `kp.js` (Keyword Planner), `serp-reader.js` (Google SERP),
  `amazon-reader.js` (Amazon).
- Runs on Tailscale hosts. This machine = "seven" (`seven.tailb8fa22.ts.net`).
- Manager PC must be always-on. Extension reaches it via chrome.storage keys
  `adbrainManagerUrl` + `adbrainManagerToken` (token is optional; sent as
  `X-Manager-Token` header).
- Git author for this work: `sagar21-creator
  <55117902+sagar21-creator@users.noreply.github.com>` (account
  dropy.parcel.verifier@gmail.com).

## Data features (columns on keywords / jobs)
- Keyword classification columns: `keyword_relevance`, `buying_intent`, `faq`,
  `competition`.
- `dropy_is_seller` (dropy.in sells our image-matched product) + `dropy_on_serp`.
- `serp_zone_counts` — per-zone FOUND image counts (popular/sponsored/shopping/…).
- Matched-link verification — open matched destination pages, re-check via CLIP:
  `link_checked_count` / `link_verified_count` / `matched_links` / `verified_links`.
- Autosuggest full coverage (`alwaysExpandAutosuggest`, default on).
- KP metrics backfill for non-KP rows (`KP_GET_METRICS` flow in `kp.js`).
- Amazon Round includes autosuggest rows; cap = `maxAmazonKeywords` (30).
- Header-block per-product CSV/XLSX (product context once, then keyword table).
- `serp-reader.js` captures each result's destination link (`resolveDestinationHref`).
- Live "Output uploaded to manager" panel on the dashboard — total rows +
  per-SKU breakdown; flags SKUs that finished with zero rows.

New-feature engine flags on `runKeywordDiscovery` (all default ON via `!== false`):
`alwaysExpandAutosuggest`, `backfillKpMetrics`, `maxAmazonKeywords`,
`verifyMatchedLinks`, `maxLinkVerify`. Brittle/untested against live Google:
the `KP_GET_METRICS` KP flow, SERP `link` capture, matched-link verification.

## Backend: self-hosted SQLite manager over Tailscale (Supabase removed)
- **`manager/server.js`** — dependency-free `node:sqlite` server. Tables:
  jobs / keywords / activity_log / worker_commands / worker_config.
  Endpoints: `/api/health`, jobs upload(+dedup)/claim(atomic)/heartbeat/done/
  failed/release-stale/summary/per-product/worker-stats/active-batch/requeue,
  `/api/keywords` push+read, activity, commands(+ack), config(get/merge/
  active-batch), cleanup. WAL mode. Runtime DB (`manager/adbrain.db*`) is
  gitignored. Run: `node manager/server.js` (PORT/MANAGER_TOKEN/DB env).
  Token via `X-Manager-Token` header or `?token=` query.
- **`modules/discovery-jobs.js`** — manager-API client. Manager URL/token
  read from `adbrainManagerUrl` / `adbrainManagerToken`.
- **`modules/discovery-export.js` `pushToAdBrain`** — POSTs results to
  `manager /api/keywords`.
- **Popup Settings** → "Manager URL" + optional "Manager token".
- **Setup-code** onboarding: manager generates `adb2:<b64>` bundle (URL +
  optional token + KP URL); worker pastes once to connect.
- **`supabase_schema.sql` deleted.** Schema now lives in `manager/server.js`.
- Host permissions include `http(s)://*.ts.net/*` + localhost for local dev.

## Conventions
- Reload the extension at chrome://extensions after changes.
- Manager PC must run `node manager/server.js` (Node 24+ for `node:sqlite`).
- Keep commits authored as `sagar21-creator`.

## Tests
- `npm test` runs the string-match + HTTP-integration regression suite
  (`scripts/regression-test.mjs`). Zero deps, ~2s. This is the smoke net.
- `npm run test:e2e` runs Playwright behavior tests against a real
  Chromium (spec-per-manager, isolated temp DB per spec) — see `e2e/`.
  First-time setup: `npm install && npm run test:e2e:install`.
- Two layers by intent: regression tests are cheap and cover surface
  area; e2e tests cover behavior that string matching can't verify
  (real clicks, real clipboard, real scroll semantics).
