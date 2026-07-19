// manager/server.js
//
// AdBrain Discovery — self-hosted MANAGER, backed by SQLite, served over
// Tailscale. Owns the job queue + atomic claim + stale-release + activity
// log + command bus + worker config + discovered-keyword storage. The
// extension's modules/discovery-jobs.js is the HTTP client for this API.
//
// Dependency-free: Node built-ins only, SQLite via the built-in `node:sqlite`
// (Node 22+/24). Run on ONE always-on machine on your tailnet:
//   node manager/server.js
//   PORT=8787 MANAGER_TOKEN=secret DB=manager/adbrain.db node manager/server.js
//
// Workers/dashboard reach it at http://<manager-tailscale-name>:8787.
//
// Concurrency: node:sqlite is synchronous and Node is single-threaded, so each
// HTTP handler (incl. the atomic claim) runs to completion before the next —
// no interleaving, no double-claims. WAL mode keeps readers non-blocking.

'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const dgram = require('dgram');

// ---------- Shopify Admin API helpers ----------
// STRICT ALLOWLIST for Shopify product updates. Everything NOT in this list
// is stripped server-side before we PUT to Shopify — even if the client
// puts price/weight/location/variants/inventory in the payload, they will
// NEVER leave this process. This is the safety guarantee the user asked for:
// "not price, weight, location etc should not be updated."
const SHOPIFY_ALLOWED_FIELDS = new Set([
  'title',
  'body_html',
  'tags',
  'product_type',
  'vendor',
  'handle',
  // Legacy SEO metafields — REST-compatible, still work on 2024-10.
  'metafields_global_title_tag',
  'metafields_global_description_tag',
  // Modern SEO object — GraphQL productUpdate path. If both legacy + modern
  // are present in a patch, both get written for belt-and-braces coverage.
  'seo_title',
  'seo_description',
  // Standard Product Taxonomy — GraphQL-only. Feeds Google Merchant Center /
  // Meta Shop categorization + Shopify's category-based filters. Value is a
  // taxonomy node ID like "gid://shopify/ProductTaxonomyNode/2914".
  'product_category',
]);
// Fields we route through GraphQL productUpdate instead of REST products.json.
// REST doesn't accept these; GraphQL does. Order: REST first (title/body/tags/
// etc), then supplementary GraphQL mutation for anything in this set.
const SHOPIFY_GRAPHQL_ONLY_FIELDS = new Set(['seo_title', 'seo_description', 'product_category']);
// Field-impact hierarchy (surfaces to the UI + prompt). Ordered by ranking/
// visibility impact — Claude is told to spend the most effort on the top
// items, and the manager UI shows the same order in previews.
const SHOPIFY_FIELD_IMPACT = [
  { field: 'title',                              impact: 'critical', why: 'primary rank signal + SERP snippet + cart title' },
  { field: 'handle',                             impact: 'critical', why: 'URL slug; changing an existing product\'s handle breaks SEO — only regenerate when intentional' },
  { field: 'seo_title',                          impact: 'critical', why: 'modern <title> (Shopify Admin > Search engine listing). 55-60 chars, keyword + benefit + brand. Prefer this over the legacy metafield.' },
  { field: 'metafields_global_title_tag',        impact: 'critical', why: 'legacy <title> metafield; kept for REST compatibility. Duplicate seo_title here for belt-and-braces coverage.' },
  { field: 'seo_description',                    impact: 'high',     why: 'modern <meta description>; drives SERP CTR. 150-160 chars, hook + benefit + CTA. Prefer this over the legacy metafield.' },
  { field: 'metafields_global_description_tag',  impact: 'high',     why: 'legacy <meta description> metafield; kept for REST compatibility.' },
  { field: 'body_html',                          impact: 'high',     why: 'first 100 words = ranking anchor; include secondary keywords + FAQ + buying-intent phrases' },
  { field: 'product_category',                   impact: 'high',     why: 'Standard Product Taxonomy node id (gid://shopify/ProductTaxonomyNode/N). Feeds Google Merchant / Meta Shop categorization + Shopify category filters. HIGH SEO signal.' },
  { field: 'tags',                               impact: 'medium',   why: 'on-site search + auto-collections; use themes here' },
  { field: 'product_type',                       impact: 'medium',   why: 'categorization; filters + auto-collections' },
  { field: 'vendor',                             impact: 'low',      why: 'brand filter; rarely changes' },
];
function stripToShopifyAllowlist(payload) {
  const out = {};
  const stripped = [];
  for (const [k, v] of Object.entries(payload || {})) {
    if (SHOPIFY_ALLOWED_FIELDS.has(k)) out[k] = v;
    else stripped.push(k);
  }
  return { safe: out, stripped };
}
// Preflight validator — runs against the tier rubric BEFORE any Shopify write.
// Returns {ok, critical: [], warn: [], stats}. Critical failures block the
// push (unless caller passes force:true); warnings are surfaced but don't block.
// Belt to the "Claude self-checks in the prompt" suspenders — trust-but-verify.
//
// context: {
//   primaryKeyword?: string,           // used to check title / handle
//   competitorBrands?: string[],       // words that must NOT appear in body copy
//   hasReviewData?: boolean,           // whether AggregateRating is legitimate
// }
function validateShopifyPatch(patch, context = {}) {
  const critical = [];
  const warn = [];
  const stats = {};
  const pushCrit = (id, msg) => critical.push({ id, msg });
  const pushWarn = (id, msg) => warn.push({ id, msg });

  const title = String(patch?.title || '');
  const handle = String(patch?.handle || '');
  const bodyHtml = String(patch?.body_html || '');
  const seoTitle = String(patch?.seo_title || patch?.metafields_global_title_tag || '');
  const seoDesc  = String(patch?.seo_description || patch?.metafields_global_description_tag || '');
  const tags = String(patch?.tags || '');
  const productCategory = String(patch?.product_category || '');

  // ─── Title checks ──────────────────────────────────────────────
  if (title) {
    stats.title_chars = title.length;
    if (title.length > 70)  pushWarn('title_length', `title ${title.length} chars — Shopify soft-warns > 70`);
    const primary = String(context.primaryKeyword || '').toLowerCase().trim();
    if (primary) {
      const first3 = title.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
      if (!first3.includes(primary.split(/\s+/)[0])) {
        pushWarn('title_primary_keyword', `primary keyword "${primary}" not in first 3 words of title`);
      }
    }
  }

  // ─── Handle checks ─────────────────────────────────────────────
  if (handle) {
    if (handle.length > 255)               pushCrit('handle_too_long', `handle ${handle.length} chars, Shopify max 255`);
    if (!/^[a-z0-9-]+$/i.test(handle))     pushCrit('handle_bad_chars', 'handle must be alphanumeric + hyphens only');
    const primary = String(context.primaryKeyword || '').toLowerCase().trim();
    if (primary && !handle.toLowerCase().includes(primary.split(/\s+/)[0])) {
      pushWarn('handle_primary_keyword', `primary keyword "${primary}" not in handle`);
    }
  }

  // ─── SEO title + description ───────────────────────────────────
  if (seoTitle) {
    stats.seo_title_chars = seoTitle.length;
    if (seoTitle.length < 40 || seoTitle.length > 70) {
      pushWarn('seo_title_length', `seo_title ${seoTitle.length} chars — target 55-60 (Shopify soft-warns > 60)`);
    }
  }
  if (seoDesc) {
    stats.seo_description_chars = seoDesc.length;
    if (seoDesc.length < 120 || seoDesc.length > 170) {
      pushWarn('seo_description_length', `seo_description ${seoDesc.length} chars — target 150-160 (Shopify soft-warns > 160)`);
    }
    if (!/(shop|buy|order|get|discover|find|try|explore|add to cart)/i.test(seoDesc)) {
      pushWarn('seo_description_no_cta', 'seo_description missing a CTA verb (shop / buy / order / get / etc.)');
    }
  }

  // ─── body_html — size, structure, schema, content ──────────────
  if (bodyHtml) {
    const bytes = Buffer.byteLength(bodyHtml, 'utf8');
    const words = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').trim().split(/\s+/).filter(Boolean).length;
    stats.body_bytes = bytes;
    stats.body_words = words;
    if (bytes > 40 * 1024) pushCrit('body_too_large', `body_html ${(bytes / 1024).toFixed(1)} KB > 40 KB page-speed cap`);
    if (words < 800)       pushCrit('body_too_short', `body_html ${words} words < 800 minimum (target 1200-2000)`);
    else if (words < 1200) pushWarn('body_short', `body_html ${words} words < 1200 target`);
    // Page-speed guardrails
    const scriptMatches = bodyHtml.match(/<script\b[^>]*>/gi) || [];
    const jsonLdCount = scriptMatches.filter(s => /application\/ld\+json/i.test(s)).length;
    const nonLdScripts = scriptMatches.length - jsonLdCount;
    if (nonLdScripts > 0) pushCrit('body_has_scripts', `body_html has ${nonLdScripts} non-JSON-LD <script> tag(s) — page-speed + XSS risk`);
    if (jsonLdCount === 0) pushCrit('body_no_json_ld', 'body_html has NO JSON-LD schema block — misses Product/FAQPage/HowTo rich snippets');
    if (/<iframe\b/i.test(bodyHtml))                pushCrit('body_iframe', 'body_html contains <iframe> — forbidden');
    if (/\bdata:image[^"'\s>]+base64/i.test(bodyHtml)) pushCrit('body_base64', 'body_html contains base64 image URI — forbidden (bloats payload)');
    if (/<link\b[^>]*stylesheet/i.test(bodyHtml))   pushCrit('body_external_css', 'body_html contains external <link rel=stylesheet> — forbidden');
    // Required sections
    if (!/<h2\b[^>]*>[^<]{0,80}(FAQ|frequently asked)/i.test(bodyHtml))      pushWarn('body_no_faq_heading', 'body_html has no FAQ <h2> heading');
    if (!/<details\b[^>]*>/i.test(bodyHtml) && !/faqpage/i.test(bodyHtml))    pushWarn('body_no_faq_block', 'body_html has no FAQ accordion (<details>) OR FAQPage schema');
    if (!/<h2\b[^>]*>[^<]{0,80}(ingredient|key active|specification|specs)/i.test(bodyHtml)) pushWarn('body_no_ingredient_section', 'body_html has no Ingredient / Specification <h2>');
    if (!/<h2\b[^>]*>[^<]{0,80}(how.*compares|comparison|vs\.?)/i.test(bodyHtml)) pushWarn('body_no_comparison', 'body_html has no "How it compares" section');
    if (!/<h2\b[^>]*>[^<]{0,80}(buying guide|how to choose|which.*for)/i.test(bodyHtml)) pushWarn('body_no_buying_guide', 'body_html has no Buying guide section');
    if (!/href=["']\/collections\//i.test(bodyHtml))                          pushWarn('body_no_internal_links', 'body_html has no /collections/ internal links (Related on dropy.in section missing?)');
    if (!/<time\b[^>]*datetime=/i.test(bodyHtml) && !/last updated/i.test(bodyHtml)) pushWarn('body_no_freshness', 'body_html has no <time datetime> or "Last updated" freshness marker');
    // Trust signals (India-first)
    if (!/(pan[- ]?india|COD|cash on delivery|GST|₹|inr)/i.test(bodyHtml))    pushWarn('body_no_india_trust', 'body_html mentions no India-first trust signals (pan-India / COD / GST / ₹ / INR)');
    // Fabricated AggregateRating check — biggest integrity risk
    if (/aggregaterating|"AggregateRating"/i.test(bodyHtml)) {
      if (!context.hasReviewData) pushCrit('fabricated_agg_rating', 'body_html includes AggregateRating schema but no real review data was provided in the request — cannot be validated as truthful');
    }
    // Competitor brand names in copy
    for (const brand of (Array.isArray(context.competitorBrands) ? context.competitorBrands : [])) {
      if (!brand || brand.length < 3) continue;
      const rx = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      // Allow the brand in JSON-LD (schema.org "brand" field is OUR brand);
      // reject in prose. Rough heuristic: strip <script>...</script> before check.
      const prose = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ');
      if (rx.test(prose)) pushCrit(`competitor_brand_${brand}`, `body_html mentions competitor brand "${brand}" in copy`);
    }
  }

  // ─── tags ──────────────────────────────────────────────────────
  if (tags) {
    const tagList = tags.split(/\s*,\s*/).filter(Boolean);
    stats.tag_count = tagList.length;
    if (tagList.length < 5)         pushWarn('tags_too_few',  `tags ${tagList.length} entries — target 10-15 for on-site search + auto-collections`);
    else if (tagList.length > 20)   pushWarn('tags_too_many', `tags ${tagList.length} entries — Shopify tag-search performance degrades > 20`);
  }

  // ─── product_category (Standard Taxonomy) ─────────────────────
  if (productCategory && !/^gid:\/\/shopify\/ProductTaxonomyNode\/\d+$/.test(productCategory)) {
    pushCrit('bad_product_category', `product_category "${productCategory}" is not a valid gid://shopify/ProductTaxonomyNode/N — Shopify will reject`);
  }

  return {
    ok: critical.length === 0,
    critical, warn, stats,
    summary: {
      critical_count: critical.length,
      warn_count: warn.length,
    },
  };
}
// Extract Shopify product handle from a URL like
// https://dropy.in/products/<handle> or /products/<handle>?variant=…
function extractShopifyHandle(url) {
  if (!url) return null;
  const m = String(url).match(/\/products\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}
// Detect product-review signals from Shopify metafields. The India-popular
// review apps store data in these namespaces:
//   Judge.me: judgeme.badge  (HTML with data-average-rating) OR judgeme.review_count
//   Loox:     loox.avg_rating + loox.num_reviews
//   Yotpo:    yotpo.reviews_average / yotpo.reviews_count
//   Stamped:  stamped.io.badge (contains rating attrs)
//   Native:   reviews.rating_count + reviews.rating (Shopify Product Reviews app)
// Returns { hasReviews, rating, count, source } — Claude uses this to decide
// whether to emit an AggregateRating schema (never fabricated).
function extractReviewSignals(metafields) {
  const out = { hasReviews: false, rating: null, count: null, source: null };
  if (!Array.isArray(metafields) || metafields.length === 0) return out;
  const findMf = (ns, key) => metafields.find(mf => mf.namespace === ns && mf.key === key);
  const num = (v) => {
    const n = Number(String(v ?? '').trim());
    return Number.isFinite(n) ? n : null;
  };
  // Loox — most explicit, check first
  const looxR = findMf('loox', 'avg_rating') || findMf('loox', 'aggregate_rating');
  const looxC = findMf('loox', 'num_reviews') || findMf('loox', 'reviews_count');
  if (looxR && num(looxR.value) != null) {
    out.rating = num(looxR.value);
    out.count = looxC ? num(looxC.value) : null;
    out.source = 'loox';
  }
  // Yotpo
  if (!out.rating) {
    const yR = findMf('yotpo', 'reviews_average') || findMf('yotpo', 'reviews_avg') || findMf('yotpo', 'rating');
    const yC = findMf('yotpo', 'reviews_count') || findMf('yotpo', 'review_count');
    if (yR && num(yR.value) != null) {
      out.rating = num(yR.value);
      out.count = yC ? num(yC.value) : null;
      out.source = 'yotpo';
    }
  }
  // Native Product Reviews app
  if (!out.rating) {
    const nR = findMf('reviews', 'rating');
    const nC = findMf('reviews', 'rating_count');
    if (nR && num(nR.value) != null) {
      out.rating = num(nR.value);
      out.count = nC ? num(nC.value) : null;
      out.source = 'shopify_reviews';
    }
  }
  // Judge.me — badge is HTML, parse data-average-rating + data-number-of-reviews
  if (!out.rating) {
    const jB = findMf('judgeme', 'badge') || findMf('judge.me', 'badge');
    if (jB && typeof jB.value === 'string') {
      const rMatch = jB.value.match(/data-average-rating="([\d.]+)"/i);
      const cMatch = jB.value.match(/data-number-of-reviews="(\d+)"/i);
      if (rMatch) {
        out.rating = num(rMatch[1]);
        out.count = cMatch ? num(cMatch[1]) : null;
        out.source = 'judgeme';
      }
    }
  }
  // Stamped.io badge
  if (!out.rating) {
    const sB = findMf('stamped.io', 'badge') || findMf('stamped', 'badge');
    if (sB && typeof sB.value === 'string') {
      const rMatch = sB.value.match(/data-rating="([\d.]+)"/i) || sB.value.match(/rating="([\d.]+)"/i);
      const cMatch = sB.value.match(/data-reviews="(\d+)"/i) || sB.value.match(/reviews-count="(\d+)"/i);
      if (rMatch) {
        out.rating = num(rMatch[1]);
        out.count = cMatch ? num(cMatch[1]) : null;
        out.source = 'stamped';
      }
    }
  }
  // Valid rating = number in [0, 5]. Reject anything else (bad metafield data).
  if (out.rating != null && (out.rating < 0 || out.rating > 5)) {
    out.rating = null; out.count = null; out.source = null;
  }
  out.hasReviews = out.rating != null && out.count != null && out.count > 0;
  return out;
}
function shopifyRequest({ shopDomain, adminToken, method, apiPath, body }) {
  return new Promise((resolve, reject) => {
    if (!shopDomain || !adminToken) return reject(new Error('Shopify creds missing (configure Shopify domain + admin token in Config → Shopify)'));
    const domain = String(shopDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const reqBody = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: domain,
      path: apiPath.startsWith('/') ? apiPath : `/${apiPath}`,
      method,
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(reqBody ? { 'Content-Length': reqBody.length } : {}),
      },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = raw ? JSON.parse(raw) : null; } catch {}
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve({ ok: true, status: r.statusCode, data: json });
        resolve({ ok: false, status: r.statusCode, error: json?.errors || raw || `HTTP ${r.statusCode}`, data: json });
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// Wake-on-LAN — send a magic packet to the given MAC. The magic packet
// is: 6 bytes of 0xFF followed by 16 repetitions of the target MAC.
// Broadcast on UDP port 9 (BOOTP/DHCP client port used by convention).
// Requires the target's NIC + BIOS to have WOL enabled AND requires
// this manager to be on the SAME physical LAN as the target (WOL works
// at Layer 2 — Tailscale, being Layer 3, does not tunnel it).
function sendWolPacket(macStr) {
  const mac = String(macStr).replace(/[^0-9a-fA-F]/g, '');
  if (mac.length !== 12) return { ok: false, error: `invalid MAC "${macStr}" — expected 12 hex chars (with or without separators)` };
  const macBytes = Buffer.from(mac, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => { try { sock.close(); } catch {} resolve({ ok: false, error: e.message }); });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      // Send to broadcast address on port 9 (also try 7 as backup — some
      // NICs listen on either).
      let done = 0;
      const finish = () => { if (++done === 2) { try { sock.close(); } catch {} resolve({ ok: true, mac: macStr, sent: 2 }); } };
      sock.send(packet, 9, '255.255.255.255', () => finish());
      sock.send(packet, 7, '255.255.255.255', () => finish());
    });
  });
}

const PORT  = parseInt(process.env.PORT || '8787', 10);
const HOST  = process.env.HOST || '0.0.0.0';
const TOKEN = (process.env.MANAGER_TOKEN || '').trim();
const DB_PATH = process.env.DB || path.join(__dirname, 'adbrain.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Auto-backup config. BACKUP_DIR defaults to manager/backups. BACKUP_KEEP_N
// keeps the N newest backups and prunes older ones. Set BACKUP_KEEP_N=0
// to disable the auto-scheduler entirely (manual backups still work).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP_N = parseInt(process.env.BACKUP_KEEP_N || '7', 10);
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 24h

// ---------------- DB ----------------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL,
  sku          TEXT,
  product_url  TEXT NOT NULL,
  product_name TEXT,
  priority     INTEGER DEFAULT 100,
  handles      TEXT,
  brands       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|done|failed
  claimed_by   TEXT,
  claimed_at   INTEGER,     -- epoch ms
  heartbeat_at INTEGER,
  done_at      INTEGER,
  failed_reason TEXT,
  attempts     INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE (batch_id, product_url)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS jobs_batch_idx  ON jobs (batch_id);

CREATE TABLE IF NOT EXISTS keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT,
  sku          TEXT,
  keyword      TEXT,
  product_url  TEXT,
  data         TEXT,        -- full JSON row (all export columns)
  created_at   INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE (batch_id, product_url, keyword)
);
CREATE INDEX IF NOT EXISTS keywords_batch_idx ON keywords (batch_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT, worker_id TEXT, level TEXT DEFAULT 'info', source TEXT,
  message     TEXT NOT NULL, product_url TEXT, sku TEXT,
  ts          INTEGER DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX IF NOT EXISTS activity_batch_ts_idx ON activity_log (batch_id, ts DESC);

CREATE TABLE IF NOT EXISTS workers (
  worker_id  TEXT PRIMARY KEY,
  first_seen INTEGER DEFAULT (strftime('%s','now')*1000),
  last_seen  INTEGER DEFAULT (strftime('%s','now')*1000),
  mac_address TEXT,
  hostname   TEXT
);
-- Additive migration for existing DBs that pre-date the mac/hostname cols.
-- Duplicate-column ADD is caught by node:sqlite and logged; we swallow it.

CREATE TABLE IF NOT EXISTS batch_names (
  batch_id     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at   INTEGER DEFAULT (strftime('%s','now')*1000)
);

CREATE TABLE IF NOT EXISTS worker_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id   TEXT,               -- null = broadcast
  command     TEXT NOT NULL, payload TEXT,
  created_at  INTEGER DEFAULT (strftime('%s','now')*1000),
  created_by  TEXT, acknowledged_at INTEGER, acknowledged_by TEXT
);
CREATE INDEX IF NOT EXISTS commands_pending_idx ON worker_commands (worker_id, acknowledged_at);

CREATE TABLE IF NOT EXISTS worker_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT,               -- JSON blob of pushed run options
  active_batch_id TEXT
);
INSERT OR IGNORE INTO worker_config (id, config, active_batch_id) VALUES (1, '{}', NULL);
`);

// Additive migration for older DBs (workers table exists without the new cols).
try { db.exec(`ALTER TABLE workers ADD COLUMN mac_address TEXT`); } catch {}
try { db.exec(`ALTER TABLE workers ADD COLUMN hostname TEXT`); } catch {}

const now = () => Date.now();

// ---------------- HTTP helpers ----------------
function send(res, code, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Manager-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }, headers || {}));
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 60 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function tokenOk(req, url) {
  if (!TOKEN) return true;
  const h = req.headers['x-manager-token'];
  if (typeof h === 'string' && h === TOKEN) return true;
  try { if (url.searchParams.get('token') === TOKEN) return true; } catch {}
  return false;
}
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' || ext === '.mjs' ? 'text/javascript'
      : ext === '.css' ? 'text/css'
      : 'application/octet-stream';
    // Rewrite asset URLs in index.html to include a version query string
    // pinned to the file's mtime. no-cache headers alone don't stop Chrome
    // from reusing its disk cache after a tab restore; a URL that changes
    // whenever the JS/CSS changes DOES. This is the belt to the no-cache
    // suspenders, so the user never has to hard-refresh again.
    if (ext === '.html') {
      const v = assetVersion();
      data = Buffer.from(String(data).replace(
        /(<(?:link|script)[^>]*\s(?:href|src)=")(\/public\/[^"?]+)(")/g,
        (_, pre, url, post) => `${pre}${url}?v=${v}${post}`
      ));
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}
// Cheap asset version — max mtime of app.js + styles.css + api.js so any
// edit to those bumps the string. Cached for a couple seconds so index.html
// doesn't stat three files on every hit.
let _assetVerCache = { at: 0, v: '0' };
function assetVersion() {
  const now = Date.now();
  if (now - _assetVerCache.at < 2000) return _assetVerCache.v;
  let mtimeMax = 0;
  for (const f of ['app.js', 'styles.css', 'api.js', 'index.html']) {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, f));
      if (st.mtimeMs > mtimeMax) mtimeMax = st.mtimeMs;
    } catch {}
  }
  _assetVerCache = { at: now, v: String(Math.floor(mtimeMax)) };
  return _assetVerCache.v;
}

// ---------------- Prepared statements ----------------
const Q = {
  insertJob: db.prepare(`INSERT INTO jobs (batch_id, sku, product_url, product_name, priority, handles, brands)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, product_url) DO UPDATE SET
      sku=excluded.sku, product_name=excluded.product_name, priority=excluded.priority,
      handles=excluded.handles, brands=excluded.brands`),
  pendingForClaim: db.prepare(`SELECT id FROM jobs WHERE status='pending' AND batch_id=? ORDER BY priority DESC, id ASC LIMIT ?`),
  claimById: db.prepare(`UPDATE jobs SET status='claimed', claimed_by=?, claimed_at=?, heartbeat_at=?, attempts=attempts+1 WHERE id=? AND status='pending'`),
  jobById: db.prepare(`SELECT * FROM jobs WHERE id=?`),
  heartbeatById: db.prepare(`UPDATE jobs SET heartbeat_at=? WHERE id=? AND claimed_by=? AND status='claimed'`),
  markDone: db.prepare(`UPDATE jobs SET status='done', done_at=? WHERE batch_id=? AND product_url=?`),
  markFailed: db.prepare(`UPDATE jobs SET status='failed', failed_reason=?, done_at=? WHERE batch_id=? AND product_url=?`),
  releaseStale: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL WHERE status='claimed' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`),
  // Direct release by worker_id — bypasses the release_claims command
  // (which routes through the worker's SW). Used when a worker is stopped
  // or offline and its stale claims are blocking other workers from
  // picking up the SKUs.
  releaseByWorker: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL WHERE status='claimed' AND claimed_by=?`),
  // Per-job CRUD helpers. Deliberately narrow (one field family per stmt)
  // so we can never accidentally update the wrong column via body param
  // injection. Job status transitions still respect claimed_by (worker
  // safety) — done inside the endpoint below, not at the SQL level.
  getJob:       db.prepare(`SELECT * FROM jobs WHERE id=?`),
  updateJobFields: db.prepare(`UPDATE jobs SET sku=?, product_name=?, priority=?, handles=?, brands=? WHERE id=?`),
  updateJobPriority: db.prepare(`UPDATE jobs SET priority=? WHERE id=?`),
  updateJobStatus:   db.prepare(`UPDATE jobs SET status=?, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=NULL, failed_reason=NULL WHERE id=?`),
  deleteJob:    db.prepare(`DELETE FROM jobs WHERE id=?`),
  jobsForBatch: db.prepare(`SELECT id, batch_id, sku, product_url, product_name, priority, status, claimed_by, claimed_at, heartbeat_at, done_at, failed_reason, attempts, handles, brands FROM jobs WHERE batch_id=? ORDER BY priority DESC, id ASC`),
  deleteKeywordsForProduct: db.prepare(`DELETE FROM keywords WHERE batch_id=? AND product_url=?`),
  jobIdByBatchAndUrl: db.prepare(`SELECT id FROM jobs WHERE batch_id=? AND product_url=?`),
  summary: db.prepare(`SELECT j.batch_id,
      COUNT(*) total,
      SUM(j.status='pending') pending, SUM(j.status='claimed') claimed,
      SUM(j.status='done') done, SUM(j.status='failed') failed,
      COUNT(DISTINCT CASE WHEN j.status='claimed' THEN j.claimed_by END) active_workers,
      MAX(j.done_at) last_done_at,
      /* done_empty = 'done' jobs with ZERO keyword rows in the keywords
         table. This surfaces the phantom-done bug: worker marked done
         BEFORE the keyword push, then the push failed. The row sits
         forever as 'done' with no data. UI shows a warning + 1-click
         requeue for these. */
      SUM(CASE WHEN j.status='done' AND NOT EXISTS
          (SELECT 1 FROM keywords k WHERE k.batch_id=j.batch_id AND k.product_url=j.product_url)
        THEN 1 ELSE 0 END) done_empty
    FROM jobs j GROUP BY j.batch_id ORDER BY j.batch_id DESC LIMIT 20`),
  /* List individual done-empty jobs so the UI can offer a per-job requeue
     (e.g. the user might want to skip one that they know has no results). */
  doneEmptyJobs: db.prepare(`SELECT id, batch_id, sku, product_url, product_name, done_at, claimed_by
    FROM jobs j WHERE status='done' AND NOT EXISTS
      (SELECT 1 FROM keywords k WHERE k.batch_id=j.batch_id AND k.product_url=j.product_url)
    AND (? IS NULL OR batch_id=?) ORDER BY done_at DESC LIMIT 500`),
  /* Bulk requeue: reset done-empty jobs back to pending so a worker
     re-picks them and (with the reorder fix) pushes keywords first. */
  requeueDoneEmpty: db.prepare(`UPDATE jobs SET status='pending',
      claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=NULL, failed_reason=NULL
    WHERE status='done' AND NOT EXISTS
      (SELECT 1 FROM keywords k WHERE k.batch_id=jobs.batch_id AND k.product_url=jobs.product_url)
    AND (? IS NULL OR batch_id=?)`),
  workerStats: db.prepare(`SELECT claimed_by worker_id, batch_id,
      COUNT(*) total_touched, SUM(status='done') done_count, SUM(status='failed') failed_count,
      SUM(status='claimed') in_flight, MAX(heartbeat_at) last_heartbeat
    FROM jobs WHERE claimed_by IS NOT NULL GROUP BY claimed_by, batch_id`),
  perProduct: db.prepare(`SELECT id, batch_id, sku, product_url, product_name, status, claimed_by, claimed_at, heartbeat_at, done_at, failed_reason, attempts, handles, brands,
    MAX(COALESCE(done_at, 0), COALESCE(heartbeat_at, 0), COALESCE(claimed_at, 0)) AS changed_at
    FROM jobs WHERE batch_id=? ORDER BY priority DESC, id ASC`),
  // Incremental variant — same shape, only rows whose changed_at > ? plus
  // the current tick timestamp echoed back for the client to advance cursor.
  perProductSince: db.prepare(`SELECT id, batch_id, sku, product_url, product_name, status, claimed_by, claimed_at, heartbeat_at, done_at, failed_reason, attempts, handles, brands,
    MAX(COALESCE(done_at, 0), COALESCE(heartbeat_at, 0), COALESCE(claimed_at, 0)) AS changed_at
    FROM jobs WHERE batch_id=? AND MAX(COALESCE(done_at, 0), COALESCE(heartbeat_at, 0), COALESCE(claimed_at, 0)) > ? ORDER BY priority DESC, id ASC`),
  perProductMaxChanged: db.prepare(`SELECT MAX(MAX(COALESCE(done_at, 0), COALESCE(heartbeat_at, 0), COALESCE(claimed_at, 0))) AS mx FROM jobs WHERE batch_id=?`),
  activeWorkers: db.prepare(`SELECT DISTINCT claimed_by worker_id, MAX(heartbeat_at) last_heartbeat FROM jobs WHERE batch_id=? AND claimed_by IS NOT NULL GROUP BY claimed_by`),
  insertKeyword: db.prepare(`INSERT INTO keywords (batch_id, sku, keyword, product_url, data) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, product_url, keyword) DO UPDATE SET data=excluded.data, sku=excluded.sku`),
  keywordsByBatch: db.prepare(`SELECT id, data FROM keywords WHERE batch_id=? ORDER BY id ASC`),
  // Incremental keyword fetch — only rows whose id > sinceId. Analytics
  // live-poll uses this to avoid re-sending the whole batch every 4s;
  // client keeps a running `lastMaxId` and requests only what's new.
  keywordsByBatchSince: db.prepare(`SELECT id, data FROM keywords WHERE batch_id=? AND id>? ORDER BY id ASC`),
  keywordsMaxIdByBatch: db.prepare(`SELECT MAX(id) mx FROM keywords WHERE batch_id=?`),
  insertActivity: db.prepare(`INSERT INTO activity_log (batch_id, worker_id, level, source, message, product_url, sku) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  recentActivity: db.prepare(`SELECT * FROM activity_log WHERE (?1 IS NULL OR batch_id=?1) ORDER BY ts DESC LIMIT ?2`),
  recentActivityWorker: db.prepare(`SELECT * FROM activity_log WHERE (?1 IS NULL OR batch_id=?1) AND worker_id=?2 ORDER BY ts DESC LIMIT ?3`),
  recentActivityLevel:  db.prepare(`SELECT * FROM activity_log WHERE (?1 IS NULL OR batch_id=?1) AND level=?2 ORDER BY ts DESC LIMIT ?3`),
  insertCommand: db.prepare(`INSERT INTO worker_commands (worker_id, command, payload, created_by) VALUES (?, ?, ?, ?)`),
  pendingCommands: db.prepare(`SELECT * FROM worker_commands WHERE acknowledged_at IS NULL AND (worker_id IS NULL OR worker_id=?) ORDER BY id ASC`),
  ackCommand: db.prepare(`UPDATE worker_commands SET acknowledged_at=?, acknowledged_by=? WHERE id=?`),
  getConfig: db.prepare(`SELECT config, active_batch_id FROM worker_config WHERE id=1`),
  setConfig: db.prepare(`UPDATE worker_config SET config=? WHERE id=1`),
  setActiveBatch: db.prepare(`UPDATE worker_config SET active_batch_id=? WHERE id=1`),
  requeue: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL WHERE id=?`),
  cleanupActivity: db.prepare(`DELETE FROM activity_log WHERE ts < ?`),
  cleanupCommands: db.prepare(`DELETE FROM worker_commands WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?`),
  // Per-batch delete: wipes jobs + keywords + activity for one batch_id.
  deleteBatchJobs:     db.prepare(`DELETE FROM jobs         WHERE batch_id = ?`),
  deleteBatchKeywords: db.prepare(`DELETE FROM keywords     WHERE batch_id = ?`),
  deleteBatchActivity: db.prepare(`DELETE FROM activity_log WHERE batch_id = ?`),
  // Full reset: wipes ALL rows from operational tables. Keeps worker_config
  // so KP URL / manager token / pinned batch survive the reset.
  wipeJobs:     db.prepare(`DELETE FROM jobs`),
  wipeKeywords: db.prepare(`DELETE FROM keywords`),
  wipeActivity: db.prepare(`DELETE FROM activity_log`),
  wipeCommands: db.prepare(`DELETE FROM worker_commands`),
  wipeWorkersRoster: db.prepare(`DELETE FROM workers`),
  // Bulk requeue: set every failed job back to pending. Optionally scope
  // to one batch. Returns updated row count.
  requeueAllFailed:      db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL WHERE status='failed'`),
  requeueBatchFailed:    db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL WHERE status='failed' AND batch_id=?`),
  // Every failed job with details (for the bulk-actions UI).
  failedJobsAll:         db.prepare(`SELECT id, batch_id, sku, product_url, product_name, failed_reason, claimed_by, attempts FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 500`),
  failedJobsByBatch:     db.prepare(`SELECT id, batch_id, sku, product_url, product_name, failed_reason, claimed_by, attempts FROM jobs WHERE status='failed' AND batch_id=? ORDER BY id DESC LIMIT 500`),
  // Throughput: keyword rows landed per hour for the last 24h. Bucket
  // is computed as (created_at / 3600000) * 3600000 (millisecond epoch
  // rounded down to hour). Two variants — all batches and batch-scoped.
  keywordsPerHourAll:    db.prepare(`SELECT (created_at / 3600000) * 3600000 AS bucket, COUNT(*) AS n FROM keywords WHERE created_at >= ? GROUP BY bucket ORDER BY bucket ASC`),
  keywordsPerHourBatch:  db.prepare(`SELECT (created_at / 3600000) * 3600000 AS bucket, COUNT(*) AS n FROM keywords WHERE created_at >= ? AND batch_id = ? GROUP BY bucket ORDER BY bucket ASC`),
  // Every batch that has keyword rows — used by the UI to surface orphan
  // batches (keywords landed after their jobs were wiped by reset-all).
  keywordsBatchList:     db.prepare(`SELECT batch_id, COUNT(*) AS row_count, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM keywords GROUP BY batch_id ORDER BY last_at DESC`),
  // Orphan detection + cleanup — keyword rows whose batch_id has no matching
  // jobs. Happens when reset-all wipes jobs while workers are mid-push.
  countOrphanKeywords:   db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT batch_id) AS batches FROM keywords WHERE batch_id NOT IN (SELECT DISTINCT batch_id FROM jobs)`),
  deleteOrphanKeywords:  db.prepare(`DELETE FROM keywords WHERE batch_id NOT IN (SELECT DISTINCT batch_id FROM jobs)`),
  // Pre-reset check — how many jobs are actively claimed right now? Used
  // to warn the user before reset wipes work-in-progress.
  claimedNowCount:       db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'claimed'`),
  // Worker roster — upsert on heartbeat + list. Lets us surface armed-
  // but-idle workers (which the jobs-derived workerStats can't see because
  // they've never claimed anything yet).
  upsertWorker: db.prepare(`INSERT INTO workers (worker_id, first_seen, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET last_seen=excluded.last_seen`),
  // Same as upsertWorker but also stores MAC + hostname when heartbeat carries them
  // (only set on cold start via worker-config.json). Never overwrites a MAC once set.
  upsertWorkerFull: db.prepare(`INSERT INTO workers (worker_id, first_seen, last_seen, mac_address, hostname) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET last_seen=excluded.last_seen,
      mac_address=COALESCE(NULLIF(excluded.mac_address, ''), workers.mac_address),
      hostname=COALESCE(NULLIF(excluded.hostname, ''), workers.hostname)`),
  listWorkers: db.prepare(`SELECT worker_id, first_seen, last_seen, mac_address, hostname FROM workers ORDER BY last_seen DESC`),
  deleteWorker: db.prepare(`DELETE FROM workers WHERE worker_id=?`),
  deleteStaleWorkers: db.prepare(`DELETE FROM workers WHERE last_seen < ?`),
  getWorker:   db.prepare(`SELECT * FROM workers WHERE worker_id = ?`),
  // Batch display names — user-friendly labels ("Aquaphor Round 2") that
  // replace opaque timestamp IDs in every dropdown / list. Underlying
  // batch_id stays unchanged (still the join key across all tables).
  upsertBatchName: db.prepare(`INSERT INTO batch_names (batch_id, display_name, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(batch_id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`),
  deleteBatchName: db.prepare(`DELETE FROM batch_names WHERE batch_id = ?`),
  listBatchNames:  db.prepare(`SELECT batch_id, display_name, updated_at FROM batch_names`),
  newestPendingBatch: db.prepare(`SELECT batch_id FROM jobs WHERE status='pending' GROUP BY batch_id ORDER BY MAX(created_at) DESC LIMIT 1`),
  // Per-batch readiness aggregate — feeds the ship-ready badge in the UI.
  // Joins jobs + keywords to compute low-yield SKUs (< READY_MIN_ROWS
  // keywords) and total row count. last_activity comes from activity_log.
  batchReadiness: db.prepare(`
    SELECT j.batch_id,
      COUNT(*)                                                    AS total,
      SUM(j.status='pending')                                     AS pending,
      SUM(j.status='claimed')                                     AS claimed,
      SUM(j.status='done')                                        AS done,
      SUM(j.status='failed')                                      AS failed,
      SUM(CASE WHEN j.status='done' AND NOT EXISTS
        (SELECT 1 FROM keywords k WHERE k.batch_id=j.batch_id AND k.product_url=j.product_url)
        THEN 1 ELSE 0 END)                                         AS done_empty,
      (SELECT COUNT(*) FROM keywords k WHERE k.batch_id=j.batch_id) AS total_rows,
      MAX(j.done_at)                                              AS last_done_at,
      MAX(j.heartbeat_at)                                         AS last_heartbeat,
      (SELECT MAX(ts) FROM activity_log al WHERE al.batch_id=j.batch_id) AS last_activity_iso
    FROM jobs j WHERE j.batch_id=? GROUP BY j.batch_id
  `),
  // Low-yield SKU list — done jobs whose keyword row count is below a
  // configurable READY_MIN_ROWS (default 30). We flag these separately so
  // the UI can list which specific SKUs need re-running / manual review.
  lowYieldDoneJobs: db.prepare(`
    SELECT j.id, j.sku, j.product_name, j.product_url,
      (SELECT COUNT(*) FROM keywords k WHERE k.batch_id=j.batch_id AND k.product_url=j.product_url) AS row_count
    FROM jobs j WHERE j.batch_id=? AND j.status='done'
    GROUP BY j.id
    HAVING row_count < ?
    ORDER BY row_count ASC
  `),
  batchHasPending: db.prepare(`SELECT 1 FROM jobs WHERE batch_id=? AND status='pending' LIMIT 1`),
  batchExists:     db.prepare(`SELECT 1 FROM jobs WHERE batch_id=? LIMIT 1`),
  existsActiveUrl: db.prepare(`SELECT 1 FROM jobs WHERE product_url=? AND batch_id<>? AND status IN ('pending','claimed','done') LIMIT 1`),
};

// ---------------- Backups ----------------
// Uses SQLite's VACUUM INTO to write a consistent snapshot even while the
// live DB is being written to (WAL-safe, no downtime). Files are stored
// as backups/adbrain-YYYYMMDD-HHMMSS.db and auto-pruned to the newest N.
function runBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0]; // YYYYMMDDTHHMMSS
    const target = path.join(BACKUP_DIR, `adbrain-${ts}.db`);
    // Escape single quotes for SQL literal.
    const safePath = target.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safePath}'`);
    // Prune: keep N newest by mtime.
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('adbrain-') && f.endsWith('.db'))
      .map(f => ({ name: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    const toDelete = files.slice(BACKUP_KEEP_N);
    for (const f of toDelete) { try { fs.unlinkSync(f.path); } catch {} }
    return { ok: true, path: target, size: fs.statSync(target).size, pruned: toDelete.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('adbrain-') && f.endsWith('.db'))
      .map(f => {
        const s = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, path: path.join(BACKUP_DIR, f), size: s.size, mtime: s.mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
// Auto-schedule the daily backup. Skip if BACKUP_KEEP_N=0.
if (BACKUP_KEEP_N > 0) {
  // Run once on startup so the first backup lands within seconds of the
  // manager coming up (users can verify the mechanism works without waiting).
  setTimeout(() => {
    const r = runBackup();
    if (r.ok) console.log(`[manager] Initial backup written: ${r.path} (${r.size} bytes)`);
    else console.error(`[manager] Initial backup FAILED: ${r.error}`);
  }, 5000);
  setInterval(() => {
    const r = runBackup();
    if (r.ok) console.log(`[manager] Nightly backup: ${r.path}`);
    else console.error(`[manager] Nightly backup FAILED: ${r.error}`);
  }, BACKUP_INTERVAL_MS);
}

// Atomic claim — one synchronous transaction (node:sqlite is sync + Node is
// single-threaded → no concurrent claim can interleave, so no double-claims).
function claimJobs(workerId, batchId, limit) {
  const t = now();
  const claimed = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = Q.pendingForClaim.all(batchId, limit).map(r => r.id);
    for (const id of ids) {
      const info = Q.claimById.run(workerId, t, t, id);
      if (info.changes > 0) claimed.push(Q.jobById.get(id));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK'); throw e;
  }
  return claimed;
}

// ---------------- Worker installer ----------------
// Exhaustive allowlist of extension files the worker PC needs. Anything
// not on this list is refused by the /worker/ route, so an accidental
// commit of secrets can't leak via directory traversal. Keep in sync
// with manifest.json + its imports.
const WORKER_FILES = [
  'manifest.json',
  'background.js',
  'popup.html', 'popup.js',
  'dashboard.html', 'dashboard.js',
  'offscreen.html', 'offscreen.js',
  'sandbox.html', 'sandbox.js',
  'kp.js', 'serp-reader.js', 'amazon-reader.js',
  'modules/keyword-discovery.js',
  'modules/keyword-filter.js',
  'modules/discovery-jobs.js',
  'modules/discovery-export.js',
  'modules/image-matcher.js',
  'modules/attribute-families.js',
  'config/discovery-config.js',
  'lib/xlsx.mjs', 'lib/transformers.min.js',
];

// PowerShell one-liner installer. Bootstraps the extension on a worker PC:
// downloads every file in WORKER_FILES, creates a dedicated Chrome
// profile + user-data-dir under %LOCALAPPDATA%, drops a startup shortcut
// so Chrome auto-launches with the extension pre-loaded on next login.
// The user still has to enable Developer Mode + Load Unpacked ONCE on
// first run — Chrome doesn't allow unattended install of an unpacked
// extension without an enterprise policy.
function serveWorkerInstaller(req, res, url) {
  const managerBase = `${url.protocol}//${req.headers.host}`;
  // Bake the current token + saved KP URL into the installer so the
  // worker extension auto-arms itself on first Load Unpacked with no
  // paste-a-setup-code step. The security posture is the same as the
  // adb2: setup code (which also carries the token) — anyone who can
  // fetch /install-worker.ps1 sees the token.
  const currentToken = TOKEN;
  let currentKpUrl = '';
  try {
    const cfgRow = Q.getConfig.get();
    if (cfgRow?.config) {
      const parsed = JSON.parse(cfgRow.config);
      currentKpUrl = String(parsed.kp_url || '').trim();
    }
  } catch {}
  // Escape single quotes for the PowerShell single-quoted string literal.
  const psEscape = (s) => String(s).replace(/'/g, "''");
  const script = `# AdBrain worker installer — generated by manager at ${managerBase}
# Usage (from PowerShell on the worker PC):
#   irm ${managerBase}/install-worker.ps1 | iex
#
# What it does:
#   1) Downloads the extension into %LOCALAPPDATA%\\AdBrainWorker\\extension
#   2) Creates a dedicated Chrome user-data-dir so the extension doesn't touch
#      the user's normal Chrome profile
#   3) Drops a Startup shortcut so Chrome auto-launches on login with the
#      extension loaded + the manager dashboard open in a tab
#   4) Fires Chrome once so you can enable Developer Mode + Load Unpacked
#
# After first run: connect the extension to this manager via the popup's
# 'Apply setup code' box (copy the code from the manager's Workers tab).

$ErrorActionPreference = 'Continue'
$mgr    = '${managerBase}'
$root   = Join-Path $env:LOCALAPPDATA 'AdBrainWorker'
$extDir = Join-Path $root 'extension'
$prof   = Join-Path $root 'profile'
$isReinstall = Test-Path (Join-Path $extDir 'manifest.json')

# Wipe the extension dir before re-downloading. Guarantees we don't
# leave orphaned files from an older WORKER_FILES set (renamed modules,
# etc.) that would confuse Chrome on reload. Profile dir is kept — that
# holds Chrome's login state, cookies, extension chrome.storage.
if ($isReinstall) {
  Write-Host '[AdBrain] Existing install detected — wiping old extension files...' -ForegroundColor Yellow
  Remove-Item -Path $extDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
New-Item -ItemType Directory -Force -Path $prof   | Out-Null

Write-Host '[AdBrain] Downloading extension files from' $mgr '...' -ForegroundColor Cyan
try {
  $list = (Invoke-RestMethod "$mgr/worker-files.json").files
} catch {
  Write-Host ("[AdBrain] Cannot reach manager: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host "  Check that the manager server is running at $mgr" -ForegroundColor Yellow
  exit 1
}
$total = $list.Count; $i = 0; $failed = @()
foreach ($f in $list) {
  $i++
  $out = Join-Path $extDir ($f -replace '/', '\\')
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$mgr/worker/$f" -OutFile $out -ErrorAction Stop
  } catch {
    $failed += $f
    Write-Host ("  [!] {0} - {1}" -f $f, $_.Exception.Message) -ForegroundColor Red
  }
  Write-Progress -Activity 'Downloading extension' -Status "$f" -PercentComplete ([int](100 * $i / $total))
}
Write-Progress -Activity 'Downloading extension' -Completed
$got = $total - $failed.Count
if ($failed.Count -eq 0) {
  Write-Host ("[AdBrain] Downloaded {0}/{0} file(s) to {1}" -f $total, $extDir) -ForegroundColor Green
} else {
  Write-Host ("[AdBrain] Downloaded {0}/{1} file(s). {2} failed:" -f $got, $total, $failed.Count) -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host ("  - {0}" -f $_) -ForegroundColor Yellow }
  Write-Host "The extension may still work if the failed files aren't runtime-critical, but Load Unpacked may show errors. Ask the manager to update the WORKER_FILES allowlist." -ForegroundColor Yellow
}

# Bake the manager URL, token, and KP URL into a worker-config.json inside
# the extension folder. background.js reads this on cold start and, IF the
# extension's chrome.storage doesn't already have these values, auto-populates
# them and arms the worker — no setup-code paste needed. Also captures this
# PC's MAC address + hostname so the manager can Wake-on-LAN this PC later.
$primaryMac = ''
try {
  $adapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
             Where-Object { $_.Status -eq 'Up' -and $_.MacAddress } |
             Select-Object -First 1
  if ($adapter) { $primaryMac = $adapter.MacAddress -replace '-', ':' }
} catch {}
$workerCfg = @{
  managerUrl   = '${psEscape(managerBase)}'
  managerToken = '${psEscape(currentToken)}'
  kpUrl        = '${psEscape(currentKpUrl)}'
  role         = 'worker'
  mac          = $primaryMac
  hostname     = $env:COMPUTERNAME
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $extDir 'worker-config.json') -Value $workerCfg -Encoding UTF8
if ($primaryMac) {
  Write-Host ("[AdBrain] Captured MAC for Wake-on-LAN: {0} ({1})" -f $primaryMac, $env:COMPUTERNAME) -ForegroundColor Green
}
Write-Host "[AdBrain] Wrote worker-config.json — extension will self-arm on first load" -ForegroundColor Green

# Locate chrome.exe
$chrome = $null
foreach ($p in @(
  "$env:PROGRAMFILES\\Google\\Chrome\\Application\\chrome.exe",
  "$\{env:PROGRAMFILES(X86)\}\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe"
)) { if (Test-Path $p) { $chrome = $p; break } }
if (-not $chrome) { throw '[AdBrain] Chrome not found in the usual locations. Install Chrome first.' }

# Startup shortcut — Chrome auto-launches on user login with the extension
# loaded. Opens a blank new-tab page for silent daily use. The manager UI
# stays on the MANAGER PC, not on every worker.
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'AdBrain Worker.lnk'
$startupArgs = ('--user-data-dir="{0}" --load-extension="{1}" --new-window "chrome://newtab"' -f $prof, $extDir)
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = $chrome
$lnk.Arguments  = $startupArgs
$lnk.WorkingDirectory = $extDir
$lnk.Description = 'AdBrain Discovery worker'
$lnk.Save()
Write-Host "[AdBrain] Startup shortcut placed: $lnkPath" -ForegroundColor Green

# First-time install: point Chrome at chrome://extensions so the user
# can do Load Unpacked without hunting. Reinstalls skip this — user
# just needs to click reload on the extension card in an already-open
# chrome://extensions tab.
if (-not $isReinstall) {
  $firstRunArgs = ('--user-data-dir="{0}" --load-extension="{1}" --new-window "chrome://extensions"' -f $prof, $extDir)
  Start-Process -FilePath $chrome -ArgumentList $firstRunArgs
}

# Chrome-watchdog scheduled task. Every 5 minutes it checks whether the
# AdBrain Chrome (identified by --user-data-dir matching our profile) is
# still running; if not, relaunches it. Covers Chrome crashes, user-
# closed windows, and post-Windows-Update reboots. Combined with the
# Startup shortcut this gives near-100% Chrome uptime on the worker PC.
$watchdogPath = Join-Path $root 'chrome-watchdog.ps1'
$logPathVar   = Join-Path $root 'chrome-watchdog.log'
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$mgr/worker/chrome-watchdog-template.ps1" -OutFile $watchdogPath -ErrorAction Stop
  # Substitute placeholders in the downloaded template. No PS line
  # continuations here (backticks would terminate the JS template literal
  # this whole installer script lives inside).
  $wdBody = Get-Content $watchdogPath -Raw
  $wdBody = $wdBody -replace '__PROFILE__', ($prof   -replace "'","''")
  $wdBody = $wdBody -replace '__EXTDIR__',  ($extDir -replace "'","''")
  $wdBody = $wdBody -replace '__CHROME__',  ($chrome -replace "'","''")
  $wdBody = $wdBody -replace '__LOG__',     ($logPathVar -replace "'","''")
  $wdBody = $wdBody -replace '__MGR__',     ($mgr    -replace "'","''")
  Set-Content -Path $watchdogPath -Value $wdBody -Encoding UTF8

  $taskName = 'AdBrain Chrome Watchdog'
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  $tAction    = New-ScheduledTaskAction    -Execute 'powershell.exe' -Argument ('-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + $watchdogPath + '"')
  $tTrigger   = New-ScheduledTaskTrigger   -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::FromDays(3650))
  $tPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $tSettings  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
  Register-ScheduledTask -TaskName $taskName -Action $tAction -Trigger $tTrigger -Principal $tPrincipal -Settings $tSettings | Out-Null
  Write-Host '[AdBrain] Chrome watchdog installed - relaunches Chrome every 5 min if it stops' -ForegroundColor Green
} catch {
  Write-Host ('[AdBrain] Could not install Chrome watchdog: ' + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host '         (Non-fatal - Chrome still auto-launches on login via Startup shortcut.)' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '===================================================================' -ForegroundColor Yellow
if ($isReinstall) {
  Write-Host ' REINSTALL — just ONE step to pick up the new version:' -ForegroundColor Yellow
  Write-Host '  * Go to chrome://extensions on this PC' -ForegroundColor Yellow
  Write-Host '  * Find "AdBrain Discovery" and click the reload (redo) icon' -ForegroundColor Yellow
  Write-Host '    (Or click "Remove" + "Load unpacked" again if you prefer.)' -ForegroundColor Yellow
  Write-Host ("    Extension folder: $extDir") -ForegroundColor Cyan
  Write-Host '===================================================================' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Your existing chrome.storage (worker id, armed state, today baseline)' -ForegroundColor Green
  Write-Host 'survives the reload — no need to reconfigure. worker-config.json' -ForegroundColor Green
  Write-Host 'was refreshed with the current manager URL + token + KP URL.' -ForegroundColor Green
} else {
  Write-Host ' ONE-TIME SETUP — just TWO steps, all on this worker PC:' -ForegroundColor Yellow
  Write-Host '  1) Chrome should have opened chrome://extensions automatically.' -ForegroundColor Yellow
  Write-Host '     If not, open that URL yourself in the Chrome window that opened.' -ForegroundColor Yellow
  Write-Host '     Toggle "Developer mode" ON (top-right corner).' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  2) Click "Load unpacked" and select this folder:' -ForegroundColor Yellow
  Write-Host ("     $extDir") -ForegroundColor Cyan
  Write-Host '===================================================================' -ForegroundColor Yellow
  Write-Host ''
  Write-Host "That's it. The extension reads worker-config.json (already written" -ForegroundColor Green
  Write-Host "next to the extension files) and auto-arms itself with the manager" -ForegroundColor Green
  Write-Host "URL + token + KP URL baked in. No setup code to paste. No role" -ForegroundColor Green
  Write-Host "picker. It starts claiming work within 30 seconds." -ForegroundColor Green
  Write-Host ""
  Write-Host "Every future Windows login auto-launches Chrome silently and" -ForegroundColor Green
  Write-Host "the extension resumes automatically. You can close this window." -ForegroundColor Green
}
`;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(script);
}

// PowerShell uninstaller. Removes everything the installer put down:
// startup shortcut, extension folder, and (with -Full) the Chrome profile
// dir too. Doesn't touch chrome://extensions — user still has to click
// "Remove" on the card since the extension is loaded via --load-extension
// from the now-missing folder (Chrome will silently drop it on next launch).
function serveWorkerUninstaller(req, res, url) {
  const managerBase = `${url.protocol}//${req.headers.host}`;
  const script = `# AdBrain worker UNINSTALLER — generated by manager at ${managerBase}
# Usage:
#   irm ${managerBase}/uninstall-worker.ps1 | iex
# or with the -Full flag to also wipe the Chrome profile (cookies etc):
#   $script = irm ${managerBase}/uninstall-worker.ps1
#   iex "& { $script } -Full"

param([switch]$Full = $false)
$ErrorActionPreference = 'Continue'
$root    = Join-Path $env:LOCALAPPDATA 'AdBrainWorker'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'AdBrain Worker.lnk'

# 0) Remove the Chrome-watchdog scheduled task if the installer registered it.
try {
  Unregister-ScheduledTask -TaskName 'AdBrain Chrome Watchdog' -Confirm:$false -ErrorAction Stop
  Write-Host "[AdBrain] Removed scheduled task 'AdBrain Chrome Watchdog'" -ForegroundColor Green
} catch {
  Write-Host "[AdBrain] No watchdog task to remove (or already gone)" -ForegroundColor Yellow
}

# 1) Remove the Startup shortcut so Chrome no longer auto-launches on login.
if (Test-Path $lnkPath) {
  Remove-Item -Path $lnkPath -Force -ErrorAction SilentlyContinue
  Write-Host "[AdBrain] Removed Startup shortcut" -ForegroundColor Green
} else {
  Write-Host "[AdBrain] No Startup shortcut found (already removed)" -ForegroundColor Yellow
}

# 2) Remove extension files. Chrome will silently drop the loaded
#    extension on its next launch once the folder is gone.
$extDir = Join-Path $root 'extension'
if (Test-Path $extDir) {
  Remove-Item -Path $extDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[AdBrain] Removed extension folder: $extDir" -ForegroundColor Green
} else {
  Write-Host "[AdBrain] No extension folder found" -ForegroundColor Yellow
}

# 3) Chrome profile dir — only if -Full. Preserves the profile by default
#    since it's isolated to this extension and users may not want to lose
#    Google login state / cookies from it.
if ($Full) {
  $prof = Join-Path $root 'profile'
  if (Test-Path $prof) {
    Remove-Item -Path $prof -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "[AdBrain] Removed Chrome profile: $prof" -ForegroundColor Green
  }
}

# 4) Top-level AdBrainWorker dir (empty at this point unless -Full skipped
#    the profile removal, in which case just leave it).
if (Test-Path $root) {
  if (-not (Get-ChildItem -Path $root -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -Path $root -Force -ErrorAction SilentlyContinue
    Write-Host "[AdBrain] Removed empty $root" -ForegroundColor Green
  } elseif (-not $Full) {
    Write-Host "[AdBrain] Kept $root (Chrome profile still there — pass -Full to wipe it too)" -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '===================================================================' -ForegroundColor Cyan
Write-Host ' UNINSTALL COMPLETE' -ForegroundColor Cyan
Write-Host '===================================================================' -ForegroundColor Cyan
Write-Host ' Final step (Chrome-side):' -ForegroundColor Cyan
Write-Host '   Open chrome://extensions and click "Remove" on the AdBrain card.' -ForegroundColor Cyan
Write-Host '   Chrome auto-drops it on next launch anyway, but Remove is cleaner.' -ForegroundColor Cyan
Write-Host ''
Write-Host ' Re-install anytime with:' -ForegroundColor Cyan
Write-Host ("   irm $mgr/install-worker.ps1 | iex" -f '') -ForegroundColor Green
Write-Host '===================================================================' -ForegroundColor Cyan
`.replace('$mgr', managerBase);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(script);
}

// ---------------- Router ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const m = req.method;
  if (m === 'OPTIONS') return send(res, 204, '');

  // Static dashboard.
  if (m === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/public/') || p === '/favicon.ico')) {
    if (p === '/favicon.ico') return send(res, 204, '');
    return serveStatic(res, p.startsWith('/public') ? p.replace(/^\/public/, '') : p);
  }

  // Worker installer + extension file serving. Un-authenticated so PowerShell
  // one-liners can bootstrap without token gymnastics; anyone who can reach
  // the manager URL over the tailnet can install the extension. Content is
  // strictly limited to a static allowlist (WORKER_FILES) below — no arbitrary
  // path access even if the request contains ../ escapes.
  if (m === 'GET' && p === '/install-worker.ps1') return serveWorkerInstaller(req, res, url);
  if (m === 'GET' && p === '/uninstall-worker.ps1') return serveWorkerUninstaller(req, res, url);
  if (m === 'GET' && p === '/worker-files.json') return send(res, 200, { ok: true, files: WORKER_FILES });
  if (m === 'GET' && p.startsWith('/worker/')) {
    const rel = p.replace(/^\/worker\//, '');
    // Special: watchdog script isn't part of the extension bundle but
    // the installer needs to download it. Served from scripts/ instead
    // of the repo root.
    if (rel === 'chrome-watchdog-template.ps1') {
      const file = path.join(__dirname, '..', 'scripts', rel);
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, { ok: false, error: 'watchdog template missing' });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    }
    if (!WORKER_FILES.includes(rel)) return send(res, 404, { ok: false, error: 'not in worker file allowlist' });
    const file = path.join(__dirname, '..', rel);
    return fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { ok: false, error: 'file missing' });
      const ext = path.extname(file).toLowerCase();
      const type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' || ext === '.mjs' ? 'text/javascript'
        : ext === '.css' ? 'text/css'
        : ext === '.json' ? 'application/json'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  if (p.startsWith('/api/') && !tokenOk(req, url)) return send(res, 401, { ok: false, error: 'bad or missing token' });

  try {
    // ----- Health -----
    // Cheap connectivity + token check. GET only; returns quickly so the
    // extension's health-ping alarm can flag a red pill within one round-trip.
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, ts: now() });

    // ----- Jobs / queue -----
    // Bulk-import SKUs from a plaintext list (one SKU per line). Handles
    // Dropy-<ASIN> format used by dropy.in — the trailing 10-char token
    // is the Amazon ASIN. Client sends:
    //   { batchId, skus: ['Dropy-B002OTT3US', ...], resolve: 'amazon' | 'shopify' | 'both', dryRun?: true }
    // Server:
    //   - Parses each line, trims whitespace, skips blanks/comments (# ...)
    //   - Extracts ASIN via /^(?:Dropy-)?([A-Z0-9]{10})$/i
    //   - resolve='amazon': generates https://www.amazon.in/dp/<ASIN>
    //   - resolve='shopify': calls Shopify Admin API to find the variant
    //     by SKU (needs Shopify creds configured), then builds the
    //     dropy.in product URL from the returned handle
    //   - resolve='both': tries shopify first, falls back to amazon
    //   - dryRun=true: parses + resolves + returns the preview WITHOUT
    //     inserting rows (so the UI can show 'we'll add these 25')
    if (m === 'POST' && p === '/api/jobs/upload-by-sku') {
      const b = await readJson(req);
      const batchId = String(b.batchId || '').trim();
      const skus    = Array.isArray(b.skus) ? b.skus : [];
      const resolveMode = ['amazon', 'shopify', 'both'].includes(b.resolve) ? b.resolve : 'amazon';
      const dryRun = !!b.dryRun;
      if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
      if (skus.length === 0) return send(res, 400, { ok: false, error: 'skus (array) required' });
      // Parse: trim, drop blanks + '#' comments, dedup case-insensitively.
      const parsed = new Map();
      const badFormat = [];
      for (const raw of skus) {
        const line = String(raw || '').trim();
        if (!line || line.startsWith('#')) continue;
        // Accept 'Dropy-BXXXXXXXXX', 'dropy-bXXXXXXXXX', or just 'BXXXXXXXXX'
        const m2 = line.match(/^(?:Dropy-)?([A-Z0-9]{10})$/i);
        if (!m2) { badFormat.push(line); continue; }
        const asin = m2[1].toUpperCase();
        const key = asin;
        if (!parsed.has(key)) parsed.set(key, { sku: line, asin });
      }
      // Resolve each SKU to a URL. Uses ONE GraphQL query per lookup
      // round (SKU / barcode / handle) with OR'd search values —
      // 3 API calls per 250-SKU batch instead of 750.
      const cfgRow = Q.getConfig.get();
      const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
      const shop = cfg.shopify || {};
      const apiVer = shop.apiVersion || '2024-10';
      const shopifyConfigured = !!(shop.shopDomain && shop.adminToken);
      const shopifyDomain = shop.shopDomain ? String(shop.shopDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;
      // Build the batch search value: field:"a" OR field:"b" OR ...
      const batchGqlLookup = async (field, values) => {
        if (values.length === 0) return {};
        // Shopify's OR operator + double-quoted values (hyphens preserved).
        // 'first' clamps to actual value count so we don't over-request.
        const clauses = values.map(v => `${field}:\\"${String(v).replace(/"/g, '')}\\"`).join(' OR ');
        const first = Math.min(250, values.length * 3);  // some SKUs may have multiple variants
        const graphqlText = `{
          productVariants(first: ${first}, query: "${clauses}") {
            edges { node { id sku barcode product { id handle title tags vendor productType } } }
          }
        }`;
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`, body: { query: graphqlText },
        });
        if (!r.ok) return {};
        // Return a map keyed by the field-value (lowercased) so the
        // per-SKU loop can look up matches locally in O(1). Ignore
        // fuzzy hits — the returned field must equal what we asked.
        const byKey = {};
        for (const edge of (r?.data?.data?.productVariants?.edges || [])) {
          const key = String(edge?.node?.[field] || '').toLowerCase();
          if (!key) continue;
          if (!byKey[key]) byKey[key] = edge.node;   // first exact match wins
        }
        return byKey;
      };
      const batchGqlHandleWildcard = async (asinTokens) => {
        if (asinTokens.length === 0) return {};
        // Handle wildcards — 'handle:*asin* OR handle:*asin2*'. Slower
        // than exact lookup on Shopify's side but still one round-trip.
        const clauses = asinTokens.map(a => `handle:*${a}*`).join(' OR ');
        const first = Math.min(250, asinTokens.length * 2);
        const graphqlText = `{
          products(first: ${first}, query: "${clauses}") {
            edges { node { id handle title tags vendor productType } }
          }
        }`;
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`, body: { query: graphqlText },
        });
        if (!r.ok) return {};
        const byAsin = {};
        for (const edge of (r?.data?.data?.products?.edges || [])) {
          const h = String(edge?.node?.handle || '').toLowerCase();
          for (const a of asinTokens) {
            if (h.includes(a) && !byAsin[a]) byAsin[a] = edge.node;
          }
        }
        return byAsin;
      };
      // Look up the STOREFRONT host (the public dropy.in domain, NOT
      // the *.myshopify.com admin host). Shopify's /admin/api/shop.json
      // returns .primary_domain.host which is what customers browse.
      // Cache for the duration of this request only.
      let storefrontHost = shop.storefrontDomain
        ? String(shop.storefrontDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '')
        : null;
      if (!storefrontHost && shopifyConfigured) {
        try {
          const sr = await shopifyRequest({
            shopDomain: shop.shopDomain, adminToken: shop.adminToken,
            method: 'GET', apiPath: `/admin/api/${apiVer}/shop.json?fields=primary_domain`,
          });
          if (sr.ok && sr.data?.shop?.primary_domain?.host) {
            storefrontHost = sr.data.shop.primary_domain.host;
          }
        } catch { /* fall back to shopifyDomain below */ }
      }
      // Fall back to the admin domain if we couldn't get the primary_domain.
      const publicHost = storefrontHost || shopifyDomain;
      // BATCH pre-lookup — one Shopify query per round covers every SKU.
      let skuMap = {}, barcodeMap = {}, handleMap = {};
      const wantShopifyForBatch = (resolveMode === 'shopify' || resolveMode === 'both') && shopifyConfigured;
      if (wantShopifyForBatch) {
        const allSkuCandidates = [];
        const allBarcodeCandidates = [];
        const allAsinTokens = [];
        for (const [asin, e] of parsed) {
          allSkuCandidates.push(e.sku);
          allSkuCandidates.push(asin);
          allSkuCandidates.push(`Dropy-${asin}`);
          allBarcodeCandidates.push(e.sku, asin);
          allAsinTokens.push(asin.toLowerCase());
        }
        const uniq = arr => [...new Set(arr.filter(Boolean))];
        try {
          skuMap     = await batchGqlLookup('sku',     uniq(allSkuCandidates));
        } catch (e) { /* skuMap stays empty */ }
        try {
          barcodeMap = await batchGqlLookup('barcode', uniq(allBarcodeCandidates));
        } catch (e) { /* barcodeMap stays empty */ }
        try {
          handleMap  = await batchGqlHandleWildcard(uniq(allAsinTokens));
        } catch (e) { /* handleMap stays empty */ }
      }
      const enrichFromProduct = (entry, p, matchedVia) => {
        if (!p?.handle) return false;
        entry._url = `https://${publicHost}/products/${p.handle}`;
        entry._source = 'shopify';
        entry._matchedVia = matchedVia;
        entry.product_name = p.title || null;
        const handleParts = [
          p.handle,
          ...(String(p.tags || '').split(',').map(t => t.trim()).filter(Boolean)),
          p.productType,
        ].filter(Boolean);
        entry.handles = handleParts.length ? handleParts.join('|') : null;
        entry.brands  = p.vendor || null;
        return true;
      };
      const resolved = [];
      for (const [asin, entry] of parsed) {
        let url = null, source = null, note = null;
        let shopifyTried = false;
        let matchedVia = null;
        // Consume the batched maps built ABOVE the loop. Each SKU makes
        // three O(1) local lookups instead of 3-9 Shopify roundtrips.
        if (wantShopifyForBatch) {
          shopifyTried = true;
          const asinUpper = entry.asin.toUpperCase();
          const asinLower = entry.asin.toLowerCase();
          const candidates = [entry.sku, asinUpper, `Dropy-${asinUpper}`];
          for (const c of candidates) {
            const node = skuMap[String(c).toLowerCase()];
            if (node?.product?.handle && enrichFromProduct(entry, node.product, `variant.sku="${c}"`)) {
              url = entry._url; source = entry._source; matchedVia = entry._matchedVia; break;
            }
          }
          if (!url) {
            for (const c of candidates) {
              const node = barcodeMap[String(c).toLowerCase()];
              if (node?.product?.handle && enrichFromProduct(entry, node.product, `variant.barcode="${c}"`)) {
                url = entry._url; source = entry._source; matchedVia = entry._matchedVia; break;
              }
            }
          }
          if (!url) {
            const p = handleMap[asinLower];
            if (p?.handle && enrichFromProduct(entry, p, `product.handle contains "${asinLower}"`)) {
              url = entry._url; source = entry._source; matchedVia = entry._matchedVia;
            }
          }
        }
        // If Shopify matched, surface WHICH variant matched.
        if (matchedVia) note = `matched via ${matchedVia}`;
        // If Shopify was tried but didn't match, explain the exhausted paths.
        if (shopifyTried && !url && !note) {
          note = `no Shopify variant/product found (tried SKU as-is + ASIN upper/lower + Dropy- prefix variants + barcode + handle-by-ASIN)`;
        }
        if (!url && (resolveMode === 'amazon' || resolveMode === 'both')) {
          url = `https://www.amazon.in/dp/${entry.asin}`;
          source = 'amazon';
        }
        resolved.push({
          sku: entry.sku, asin: entry.asin, url, source, note,
          product_name: entry.product_name || null,
          handles: entry.handles || null,
          brands: entry.brands || null,
        });
      }
      const withUrl = resolved.filter(r => r.url);
      const withoutUrl = resolved.filter(r => !r.url);
      // Dry-run: return preview, do not insert.
      if (dryRun) {
        return send(res, 200, {
          ok: true, dryRun: true, batchId,
          parsed: parsed.size, badFormat: badFormat.length, resolved: withUrl.length,
          unresolved: withoutUrl.length,
          preview: resolved.slice(0, 200),
          badFormatSamples: badFormat.slice(0, 20),
          shopifyConfigured,
        });
      }
      // UPSERT semantics — 25 SKUs that all resolve to the same dropy.in
      // product page (variants) become ONE job row whose 'sku' column
      // holds all 25 SKUs comma-separated. That way the user sees every
      // SKU they provided in the UI, and the engine still only scrapes
      // the product page ONCE (the whole point of scraping).
      //
      // Two dedup paths:
      //   (a) Cross-batch — skip URLs already active in ANOTHER batch.
      //   (b) In-batch    — INSERT ... ON CONFLICT DO UPDATE appends the
      //                     new SKU to the existing row's sku field.
      //                     No-op if the SKU is already listed
      //                     (guarded by NOT LIKE).
      let inserted = 0, skippedActive = 0, linkedToExisting = 0;
      const skippedSkus = [];
      const seenInThisCall = new Set();
      const upsertJob = db.prepare(`INSERT INTO jobs
        (batch_id, sku, product_url, product_name, priority, handles, brands)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id, product_url) DO UPDATE SET
          sku = CASE
            WHEN sku IS NULL OR sku = '' THEN excluded.sku
            WHEN (',' || sku || ',') LIKE '%,' || excluded.sku || ',%' THEN sku
            ELSE sku || ',' || excluded.sku
          END`);
      const existsInBatch = db.prepare(`SELECT 1 FROM jobs WHERE batch_id=? AND product_url=?`);
      db.exec('BEGIN');
      try {
        for (const r of withUrl) {
          if (Q.existsActiveUrl.get(r.url, batchId)) { skippedActive++; skippedSkus.push(r.sku); continue; }
          // Second (or Nth) time we see this URL in this call — it will
          // hit the UPSERT UPDATE branch and merge into the row we
          // just inserted.
          if (seenInThisCall.has(r.url)) {
            upsertJob.run(batchId, r.sku, r.url, r.product_name, 100, r.handles, r.brands);
            linkedToExisting++;
            continue;
          }
          seenInThisCall.add(r.url);
          // First time in this call — check if the URL was already in
          // the batch from a PREVIOUS upload to decide inserted vs merged.
          const preExists = !!existsInBatch.get(batchId, r.url);
          upsertJob.run(batchId, r.sku, r.url, r.product_name, 100, r.handles, r.brands);
          if (preExists) linkedToExisting++;
          else inserted++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, {
        ok: true, dryRun: false, batchId, inserted,
        parsed: parsed.size, badFormat: badFormat.length,
        unresolved: withoutUrl.length,
        skippedActive, skippedSkus: skippedSkus.slice(0, 20),
        // linkedToExisting = SKUs merged into another row's sku column
        // because they resolved to a URL already in this batch. The
        // engine still scrapes each URL once; every SKU is preserved
        // for downstream lookup / display.
        linkedToExisting,
        badFormatSamples: badFormat.slice(0, 20),
        shopifyConfigured,
      });
    }
    // Bulk mutate: apply the same {status|priority} update to N job IDs.
    // Used by the queue-manager multi-select toolbar. Force gate on
    // claimed jobs (server refuses claimed unless {force:true}).
    if (m === 'POST' && p === '/api/jobs/bulk-update') {
      const b = await readJson(req);
      const ids = Array.isArray(b.jobIds) ? b.jobIds.map(Number).filter(Number.isFinite) : [];
      const patch = b.patch || {};
      const force = !!b.force;
      if (ids.length === 0) return send(res, 400, { ok: false, error: 'jobIds required' });
      const allowed = ['priority', 'status', 'failed_reason'];
      const setCols = [];
      const args = [];
      for (const col of allowed) {
        if (col in patch) { setCols.push(`${col} = ?`); args.push(patch[col]); }
      }
      if (setCols.length === 0) return send(res, 400, { ok: false, error: 'patch must set at least one of: priority, status, failed_reason' });
      // Status=pending resets claim + heartbeat too (same as jobReset semantics).
      let extraCols = '';
      if (patch.status === 'pending') extraCols = ', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL';
      let sql = `UPDATE jobs SET ${setCols.join(', ')}${extraCols} WHERE id IN (${ids.map(() => '?').join(',')})`;
      if (!force) sql += ` AND status != 'claimed'`;
      const info = db.prepare(sql).run(...args, ...ids);
      return send(res, 200, { ok: true, updated: info.changes, requested: ids.length });
    }
    // Bulk delete: same semantics as jobDelete but for N IDs.
    if (m === 'POST' && p === '/api/jobs/bulk-delete') {
      const b = await readJson(req);
      const ids = Array.isArray(b.jobIds) ? b.jobIds.map(Number).filter(Number.isFinite) : [];
      const force = !!b.force;
      if (ids.length === 0) return send(res, 400, { ok: false, error: 'jobIds required' });
      db.exec('BEGIN');
      let deleted = 0, keywordsDeleted = 0;
      try {
        for (const id of ids) {
          const row = db.prepare('SELECT id, batch_id, product_url, status FROM jobs WHERE id=?').get(id);
          if (!row) continue;
          if (row.status === 'claimed' && !force) continue;
          keywordsDeleted += Q.deleteKeywordsForProduct.run(row.batch_id, row.product_url).changes;
          Q.deleteJob.run(id);
          deleted++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, deleted, keywordsDeleted, requested: ids.length });
    }
    if (m === 'POST' && p === '/api/jobs/upload') {
      const b = await readJson(req);
      const batchId = String(b.batchId || b.batch_id || '');
      const products = Array.isArray(b.products) ? b.products : [];
      if (!batchId || products.length === 0) return send(res, 400, { ok: false, error: 'batchId + products required' });
      // Dedup within this upload (last occurrence wins).
      const seen = new Map();
      for (const pr of products) { const u = String(pr.url || pr.product_url || '').trim(); if (u) seen.set(u, pr); }
      const dupDropped = products.filter(p => (p.url || p.product_url || '').trim()).length - seen.size;
      // Same UPSERT semantics as /api/jobs/upload-by-sku — an append-to-
      // existing-batch upload where the URL was already there merges the
      // new SKU into the existing row's sku column instead of throwing
      // UNIQUE. Idempotent re-uploads become a no-op.
      let n = 0, skippedActive = 0, linkedToExisting = 0;
      const skippedSkus = [];
      const upsertJobExcel = db.prepare(`INSERT INTO jobs
        (batch_id, sku, product_url, product_name, priority, handles, brands)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id, product_url) DO UPDATE SET
          sku = CASE
            WHEN sku IS NULL OR sku = '' THEN excluded.sku
            WHEN excluded.sku IS NULL OR excluded.sku = '' THEN sku
            WHEN (',' || sku || ',') LIKE '%,' || excluded.sku || ',%' THEN sku
            ELSE sku || ',' || excluded.sku
          END`);
      const seenUrlsExcel = new Set();
      db.exec('BEGIN');
      try {
        for (const [urlv, pr] of seen) {
          // Cross-batch dedup: skip URLs already pending/claimed/done in ANOTHER batch.
          if (Q.existsActiveUrl.get(urlv, batchId)) { skippedActive++; if (pr.sku) skippedSkus.push(pr.sku); continue; }
          upsertJobExcel.run(batchId, pr.sku || null, urlv, pr.product_name || pr.name || null,
            Number.isFinite(pr.priority) ? pr.priority : 100,
            Array.isArray(pr.handles) ? pr.handles.join('|') : (pr.handles || null),
            Array.isArray(pr.brands) ? pr.brands.join('|') : (pr.brands || null));
          if (!seenUrlsExcel.has(urlv)) { n++; seenUrlsExcel.add(urlv); }
          else linkedToExisting++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, uploaded: n, total: seen.size, batchId, duplicatesDropped: dupDropped, skippedActive, skippedSkus: skippedSkus.slice(0, 10), linkedToExisting });
    }
    if (m === 'POST' && p === '/api/jobs/claim') {
      const b = await readJson(req);
      const claimed = claimJobs(String(b.workerId || ''), String(b.batchId || ''), Math.max(1, Math.min(50, b.limit || 5)));
      return send(res, 200, { ok: true, jobs: claimed });
    }
    if (m === 'POST' && p === '/api/jobs/heartbeat') {
      const b = await readJson(req); const t = now();
      let n = 0;
      for (const id of (Array.isArray(b.jobIds) ? b.jobIds : [])) { const info = Q.heartbeatById.run(t, Number(id), b.workerId); n += info.changes; }
      // Echo the manager's authoritative active batch back to the worker so
      // it can detect drift (worker's cached queueBatchId != manager's pin).
      // Prevents orphan-batch writes when the manager re-pins after a Reset.
      const cfgHb = Q.getConfig.get();
      const pinnedHb = (cfgHb?.active_batch_id || '').trim();
      let activeHb = pinnedHb && Q.batchHasPending.get(pinnedHb) ? pinnedHb : null;
      if (!activeHb) activeHb = Q.newestPendingBatch.get()?.batch_id || null;
      return send(res, 200, { ok: true, updated: n, active_batch_id: activeHb });
    }
    if (m === 'POST' && p === '/api/jobs/requeue') {
      const b = await readJson(req); const info = Q.requeue.run(Number(b.jobId));
      return send(res, 200, { ok: info.changes > 0, updated: info.changes });
    }
    if (m === 'GET' && p === '/api/jobs/active-batch') {
      // Manager-pinned batch (if it still has pending work), else newest pending batch.
      const cfg = Q.getConfig.get();
      const pinned = (cfg?.active_batch_id || '').trim();
      if (pinned && Q.batchHasPending.get(pinned)) return send(res, 200, { ok: true, batchId: pinned });
      const row = Q.newestPendingBatch.get();
      return send(res, 200, { ok: true, batchId: row?.batch_id || null });
    }
    if (m === 'GET' && p === '/api/jobs/url-active') {
      // Cross-batch dedup check: is this product_url already active in another batch?
      const u = url.searchParams.get('url') || '';
      const b = url.searchParams.get('excludeBatch') || '';
      return send(res, 200, { ok: true, active: !!Q.existsActiveUrl.get(u, b) });
    }
    if (m === 'POST' && p === '/api/jobs/done')   { const b = await readJson(req); Q.markDone.run(now(), b.batchId, b.productUrl); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/jobs/failed') { const b = await readJson(req); Q.markFailed.run(b.reason || null, now(), b.batchId, b.productUrl); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/jobs/release-stale') {
      const b = await readJson(req); const mins = Number.isFinite(b.staleMinutes) ? b.staleMinutes : 10;
      const info = Q.releaseStale.run(now() - mins * 60000);
      return send(res, 200, { ok: true, released: info.changes });
    }
    // Release all claims held by a specific worker — used when the
    // dashboard detects a stopped/offline worker still holding SKUs
    // that other workers could be processing.
    if (m === 'POST' && p === '/api/jobs/release-by-worker') {
      const b = await readJson(req);
      const wid = String(b.workerId || '').trim();
      if (!wid) return send(res, 400, { ok: false, error: 'workerId required' });
      const info = Q.releaseByWorker.run(wid);
      return send(res, 200, { ok: true, released: info.changes, workerId: wid });
    }
    // ─── Per-job CRUD (worker-safe) ─────────────────────────────────
    // GET all jobs in a batch — richer than /per-product (adds worker,
    // heartbeat, attempts, failed_reason). Used by the Queue-manage UI.
    if (m === 'GET' && p === '/api/jobs/list') {
      const batchId = String(url.searchParams.get('batchId') || '').trim();
      if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
      return send(res, 200, { ok: true, rows: Q.jobsForBatch.all(batchId) });
    }
    // POST update — safe against active workers. Priority changes always
    // OK. Field edits (sku/name/handles/brands) refused for CLAIMED jobs
    // unless force=true, because changing product_url/name mid-run would
    // confuse the worker's local state. product_url is NEVER updatable
    // (it's part of the UNIQUE key + used as the job's identity across
    // the whole system).
    if (m === 'POST' && p === '/api/jobs/update') {
      const b = await readJson(req);
      const id = Number(b.jobId || b.id || 0);
      if (!Number.isFinite(id) || id <= 0) return send(res, 400, { ok: false, error: 'jobId required' });
      const row = Q.getJob.get(id);
      if (!row) return send(res, 404, { ok: false, error: `no job with id ${id}` });
      // Priority-only path — always safe.
      if (b.priority != null && Object.keys(b).length <= 3) {
        Q.updateJobPriority.run(Number(b.priority), id);
        return send(res, 200, { ok: true, updated: 1, mode: 'priority-only' });
      }
      // Full-field update — refuses if job is claimed unless force.
      if (row.status === 'claimed' && !b.force) {
        return send(res, 409, { ok: false, error: `job ${id} is claimed by ${row.claimed_by}. Release the claim first, or pass force=true (worker's next heartbeat may fail).` });
      }
      const newSku      = b.sku          != null ? String(b.sku)          : row.sku;
      const newName     = b.product_name != null ? String(b.product_name) : row.product_name;
      const newPriority = b.priority     != null ? Number(b.priority)     : row.priority;
      const newHandles  = b.handles      != null ? String(b.handles)      : row.handles;
      const newBrands   = b.brands       != null ? String(b.brands)       : row.brands;
      Q.updateJobFields.run(newSku, newName, newPriority, newHandles, newBrands, id);
      return send(res, 200, { ok: true, updated: 1, mode: 'full-field' });
    }
    // POST reset — flip a job back to pending regardless of current state.
    // Useful for "requeue this failed job" or "the worker is stuck, force
    // this SKU back to pending". Refuses to reset a DONE job unless force.
    if (m === 'POST' && p === '/api/jobs/reset') {
      const b = await readJson(req);
      const id = Number(b.jobId || b.id || 0);
      if (!Number.isFinite(id) || id <= 0) return send(res, 400, { ok: false, error: 'jobId required' });
      const row = Q.getJob.get(id);
      if (!row) return send(res, 404, { ok: false, error: `no job with id ${id}` });
      if (row.status === 'done' && !b.force) {
        return send(res, 409, { ok: false, error: `job ${id} is already done. Pass force=true to re-queue it (existing keyword rows stay in the DB).` });
      }
      Q.updateJobStatus.run('pending', id);
      return send(res, 200, { ok: true, updated: 1, previous: row.status });
    }
    // POST delete — refuses claimed jobs unless force. Also drops any
    // keyword rows for the deleted job's product_url within this batch
    // to prevent orphan rows lingering in Analytics.
    if (m === 'POST' && p === '/api/jobs/delete-one') {
      const b = await readJson(req);
      const id = Number(b.jobId || b.id || 0);
      if (!Number.isFinite(id) || id <= 0) return send(res, 400, { ok: false, error: 'jobId required' });
      const row = Q.getJob.get(id);
      if (!row) return send(res, 404, { ok: false, error: `no job with id ${id}` });
      if (row.status === 'claimed' && !b.force) {
        return send(res, 409, { ok: false, error: `job ${id} is claimed by ${row.claimed_by}. Release the claim first, or pass force=true.` });
      }
      // node:sqlite doesn't have better-sqlite3's db.transaction() helper —
      // use explicit BEGIN/COMMIT (the pattern used elsewhere in this file).
      let kwDeleted = 0;
      db.exec('BEGIN');
      try {
        Q.deleteJob.run(id);
        const kwDel = Q.deleteKeywordsForProduct.run(row.batch_id, row.product_url);
        kwDeleted = kwDel.changes;
        db.exec('COMMIT');
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }
      return send(res, 200, { ok: true, deleted: 1, keywordsDeleted: kwDeleted, sku: row.sku, productUrl: row.product_url });
    }
    // POST add-one — insert a single SKU into an existing batch. Uses the
    // same upsert semantics as /api/jobs/upload but bounded to one row.
    if (m === 'POST' && p === '/api/jobs/add-one') {
      const b = await readJson(req);
      const batchId = String(b.batchId || '').trim();
      const productUrl = String(b.url || b.product_url || '').trim();
      if (!batchId)    return send(res, 400, { ok: false, error: 'batchId required' });
      if (!productUrl) return send(res, 400, { ok: false, error: 'product url required' });
      const sku = b.sku ? String(b.sku) : null;
      const name = b.product_name ? String(b.product_name) : (b.name ? String(b.name) : null);
      const priority = Number.isFinite(b.priority) ? Number(b.priority) : 100;
      const handles = Array.isArray(b.handles) ? b.handles.join('|') : (b.handles ? String(b.handles) : null);
      const brands  = Array.isArray(b.brands)  ? b.brands.join('|')  : (b.brands  ? String(b.brands)  : null);
      Q.insertJob.run(batchId, sku, productUrl, name, priority, handles, brands);
      const row = Q.jobIdByBatchAndUrl.get(batchId, productUrl);
      return send(res, 200, { ok: true, jobId: row?.id, batchId, productUrl });
    }

    if (m === 'GET' && p === '/api/jobs/summary')      return send(res, 200, { ok: true, batches: Q.summary.all() });
    // Per-batch readiness — one clear status per batch so the UI can show
    // a ship-ready badge without users piecing 6 counters together. Query
    // params: batchId (required), minRows (default 30) = threshold below
    // which a done SKU is 'low yield'. Returns:
    //   status: 'READY' | 'REVIEW' | 'IN_PROGRESS' | 'STUCK' | 'EMPTY'
    //   reason: short human string explaining the status
    //   metrics: {total, pending, claimed, done, failed, done_empty,
    //             total_rows, low_yield, avg_rows_per_done, stall_minutes}
    //   low_yield_skus: [{id, sku, product_name, row_count}]
    if (m === 'GET' && p === '/api/batches/readiness') {
      const batchId = url.searchParams.get('batchId') || '';
      if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
      const minRows = Math.max(0, Number(url.searchParams.get('minRows') || 30));
      const stuckMinutes = Math.max(1, Number(url.searchParams.get('stuckMinutes') || 30));
      const r = Q.batchReadiness.get(batchId);
      if (!r) return send(res, 200, { ok: true, batchId, status: 'EMPTY', reason: 'no jobs found for this batch', metrics: { total: 0 }, low_yield_skus: [] });
      const total       = Number(r.total || 0);
      const pending     = Number(r.pending || 0);
      const claimed     = Number(r.claimed || 0);
      const done        = Number(r.done || 0);
      const failed      = Number(r.failed || 0);
      const done_empty  = Number(r.done_empty || 0);
      const total_rows  = Number(r.total_rows || 0);
      // Low-yield SKUs — done jobs with row count below minRows.
      const lowYieldRows = Q.lowYieldDoneJobs.all(batchId, minRows);
      const low_yield = lowYieldRows.length;
      const avg_rows_per_done = done > 0 ? Math.round(total_rows / done) : 0;
      // Stall detection: how many minutes since the last activity event.
      // Uses activity_log.ts which is ISO-8601 UTC. If never seen, Infinity.
      const lastActivityMs = r.last_activity_iso ? Date.parse(r.last_activity_iso) : 0;
      const stall_minutes = lastActivityMs > 0
        ? Math.round((Date.now() - lastActivityMs) / 60000)
        : Infinity;
      // Classify.
      let status, reason;
      if (total === 0) {
        status = 'EMPTY'; reason = 'no jobs in this batch';
      } else if (pending > 0 || claimed > 0) {
        // Still working. Check for stall.
        if (stall_minutes > stuckMinutes && Number.isFinite(stall_minutes)) {
          status = 'STUCK';
          reason = `${claimed + pending} SKU(s) not done; no activity for ${stall_minutes} min. Workers may have died or KP session expired.`;
        } else {
          status = 'IN_PROGRESS';
          reason = `${claimed} in-flight, ${pending} pending${done > 0 ? `, ${done} done so far` : ''}`;
        }
      } else if (failed > 0 || done_empty > 0 || low_yield > 0) {
        // All settled but not clean.
        const issues = [];
        if (failed > 0)     issues.push(`${failed} failed`);
        if (done_empty > 0) issues.push(`${done_empty} done-empty (0 rows)`);
        if (low_yield > 0)  issues.push(`${low_yield} low-yield (< ${minRows} rows)`);
        status = 'REVIEW';
        reason = `all SKUs settled but needs eyes: ${issues.join(', ')}. Requeue or accept as-is.`;
      } else {
        // All done, no failures, no low-yield.
        status = 'READY';
        reason = `${done}/${total} SKUs done · ${total_rows.toLocaleString()} rows (avg ${avg_rows_per_done}/SKU) · no failed / no low-yield · ready to ship`;
      }
      return send(res, 200, {
        ok: true,
        batchId,
        status,
        reason,
        metrics: {
          total, pending, claimed, done, failed, done_empty,
          total_rows, low_yield, avg_rows_per_done,
          stall_minutes: Number.isFinite(stall_minutes) ? stall_minutes : null,
        },
        low_yield_skus: lowYieldRows,
      });
    }
    if (m === 'GET' && p === '/api/jobs/worker-stats') {
      // Passive stale-claim reaper: any claim whose heartbeat is > 5 minutes
      // old is released before we count. Fixes the "10 in-flight for one
      // worker" case where a SW-reloaded worker abandoned claims that never
      // heartbeat again. Runs on every dashboard poll (10s) — cheap, one
      // UPDATE with an index-covered filter — and self-heals ghost claims
      // without waiting for a client to call /api/jobs/release-stale.
      Q.releaseStale.run(now() - 5 * 60000);
      return send(res, 200, { ok: true, workers: Q.workerStats.all() });
    }
    if (m === 'GET' && p === '/api/jobs/per-product') {
      const batchId = url.searchParams.get('batchId') || '';
      const sinceRaw = url.searchParams.get('sinceChangedAt');
      const sinceChangedAt = sinceRaw != null && sinceRaw !== '' ? Number(sinceRaw) : null;
      const incremental = Number.isFinite(sinceChangedAt);
      const rows = incremental
        ? Q.perProductSince.all(batchId, sinceChangedAt)
        : Q.perProduct.all(batchId);
      const maxRow = Q.perProductMaxChanged.get(batchId);
      const maxChangedAt = Number.isFinite(maxRow?.mx) ? maxRow.mx : 0;
      return send(res, 200, { ok: true, rows, maxChangedAt, incremental, sinceChangedAt: incremental ? sinceChangedAt : null });
    }
    if (m === 'GET' && p === '/api/jobs/active-workers') return send(res, 200, { ok: true, workers: Q.activeWorkers.all(url.searchParams.get('batchId') || '') });
    // Worker heartbeat — called by workers every 30s regardless of whether
    // they claim any work. Populates the `workers` roster so armed-idle
    // workers show up as online in the dashboard fleet.
    if (m === 'POST' && p === '/api/workers/heartbeat') {
      const b = await readJson(req);
      const wid = String(b.workerId || '').trim();
      if (!wid) return send(res, 400, { ok: false, error: 'workerId required' });
      const t = now();
      // MAC + hostname arrive only from workers whose installer captured
      // them (post-WOL feature). Fall back to bare upsert if absent so
      // older workers keep working.
      const mac  = String(b.mac || '').trim();
      const host = String(b.hostname || '').trim();
      if (mac || host) Q.upsertWorkerFull.run(wid, t, t, mac, host);
      else             Q.upsertWorker.run(wid, t, t);
      return send(res, 200, { ok: true });
    }
    // Wake-on-LAN — send a magic packet to the worker's stored MAC.
    // Requires the worker + manager be on the same physical LAN (WOL
    // works at Layer 2; Tailscale doesn't tunnel it). If they are on
    // different LANs, this silently fails at the target.
    if (m === 'POST' && p === '/api/workers/wol') {
      const b = await readJson(req);
      const wid = String(b.workerId || '').trim();
      let mac  = String(b.mac || '').trim();
      if (!mac && wid) {
        const w = Q.getWorker.get(wid);
        if (w?.mac_address) mac = w.mac_address;
      }
      if (!mac) return send(res, 400, { ok: false, error: 'no MAC available for this worker — install the extension with the current installer so it captures the MAC, or POST {mac: "AA:BB:CC:DD:EE:FF"}' });
      const r = await sendWolPacket(mac);
      if (!r.ok) {
        // Invalid MAC = 400 (client error); anything else = 500 (server side).
        const code = /invalid MAC/i.test(r.error) ? 400 : 500;
        return send(res, code, r);
      }
      return send(res, 200, r);
    }
    // Manually store a MAC for a worker (used if the worker was installed
    // before the auto-capture feature). POST {workerId, mac}.
    if (m === 'POST' && p === '/api/workers/set-mac') {
      const b = await readJson(req);
      const wid = String(b.workerId || '').trim();
      const mac = String(b.mac || '').trim();
      if (!wid || !mac) return send(res, 400, { ok: false, error: 'workerId + mac required' });
      const cleaned = mac.replace(/[^0-9a-fA-F]/g, '');
      if (cleaned.length !== 12) return send(res, 400, { ok: false, error: 'MAC must be 12 hex chars' });
      // Preserve the existing hostname if any.
      const cur = Q.getWorker.get(wid);
      Q.upsertWorkerFull.run(wid, cur?.first_seen || now(), cur?.last_seen || now(), cleaned, cur?.hostname || '');
      return send(res, 200, { ok: true, mac: cleaned });
    }
    if (m === 'GET' && p === '/api/workers/list') return send(res, 200, { ok: true, workers: Q.listWorkers.all() });
    // Ghost-worker cleanup — remove worker rows that haven't checked
    // in for `olderThanMinutes`. Used when a Chrome reload spawns a new
    // workerId and the OLD id is stuck in the fleet display.
    if (m === 'POST' && p === '/api/workers/delete') {
      const b = await readJson(req);
      const wId = String(b.workerId || '').trim();
      if (!wId) return send(res, 400, { ok: false, error: 'workerId required' });
      const info = Q.deleteWorker.run(wId);
      return send(res, 200, { ok: true, deleted: info.changes });
    }
    if (m === 'POST' && p === '/api/workers/prune-stale') {
      const b = await readJson(req);
      const cutoff = now() - Math.max(60, Number(b.olderThanMinutes) || 240) * 60 * 1000;
      const info = Q.deleteStaleWorkers.run(cutoff);
      return send(res, 200, { ok: true, deleted: info.changes });
    }
    // Quiesce broadcast — send 'pause' to every worker. Returns the current
    // in-flight snapshot so the UI can poll until it hits zero. Doesn't
    // reset or delete anything — just tells workers to stop claiming.
    if (m === 'POST' && p === '/api/workers/quiesce') {
      Q.insertCommand.run(null, 'pause', null, 'manager-quiesce');
      const claimed = Q.claimedNowCount.get();
      const workers = Q.listWorkers.all();
      const nowT = now();
      const active = workers.filter(w => (nowT - Number(w.last_seen)) < 3 * 60 * 1000).length;
      return send(res, 200, { ok: true, activeWorkers: active, claimedNow: claimed?.n || 0 });
    }
    if (m === 'GET' && p === '/api/backups/list') {
      return send(res, 200, { ok: true, backups: listBackups(), keepN: BACKUP_KEEP_N, dir: BACKUP_DIR });
    }
    if (m === 'POST' && p === '/api/backups/create') {
      const r = runBackup();
      if (!r.ok) return send(res, 500, r);
      return send(res, 200, r);
    }
    if (m === 'GET' && p === '/api/jobs/failed') {
      const bId = url.searchParams.get('batchId') || '';
      const rows = bId ? Q.failedJobsByBatch.all(bId) : Q.failedJobsAll.all();
      return send(res, 200, { ok: true, rows });
    }
    if (m === 'POST' && p === '/api/jobs/requeue-all-failed') {
      const b = await readJson(req);
      const bId = String(b.batchId || '').trim();
      const info = bId ? Q.requeueBatchFailed.run(bId) : Q.requeueAllFailed.run();
      return send(res, 200, { ok: true, updated: info.changes });
    }
    // Done-empty visibility: worker marked a job 'done' but the manager
    // has ZERO keyword rows for it (worker died / push failed after the
    // done-flag write). Returns the list so the UI can flag them and
    // offer 1-click requeue.
    if (m === 'GET' && p === '/api/jobs/done-empty') {
      const bId = url.searchParams.get('batchId') || '';
      const rows = Q.doneEmptyJobs.all(bId || null, bId || null);
      return send(res, 200, { ok: true, rows, count: rows.length });
    }
    if (m === 'POST' && p === '/api/jobs/requeue-done-empty') {
      const b = await readJson(req);
      const bId = (b.batchId && String(b.batchId).trim()) || null;
      const info = Q.requeueDoneEmpty.run(bId, bId);
      return send(res, 200, { ok: true, updated: info.changes });
    }
    if (m === 'GET' && p === '/api/keywords/batches') {
      return send(res, 200, { ok: true, batches: Q.keywordsBatchList.all() });
    }
    // Batch display names — a user-editable overlay on the opaque
    // timestamp batch_ids that dropdowns/lists render instead of the ID.
    if (m === 'GET' && p === '/api/batches/names') {
      return send(res, 200, { ok: true, names: Q.listBatchNames.all() });
    }
    if (m === 'POST' && p === '/api/batches/rename') {
      const b = await readJson(req);
      const bid = String(b.batchId || '').trim();
      const name = String(b.name || '').trim();
      if (!bid) return send(res, 400, { ok: false, error: 'batchId required' });
      if (!name) { Q.deleteBatchName.run(bid); return send(res, 200, { ok: true, cleared: true }); }
      if (name.length > 100) return send(res, 400, { ok: false, error: 'display_name max 100 chars' });
      Q.upsertBatchName.run(bid, name, now());
      return send(res, 200, { ok: true, batchId: bid, name });
    }
    // Count orphan keyword rows — rows whose batch_id no longer has any
    // jobs. Cheap read; used by the Config-tab cleanup card + the reset
    // preflight to warn about work-in-progress.
    if (m === 'GET' && p === '/api/keywords/orphans') {
      const r = Q.countOrphanKeywords.get();
      const claimed = Q.claimedNowCount.get();
      // Also enumerate active workers for the reset warning UI.
      const workers = Q.listWorkers.all();
      const nowT = now();
      const activeWorkerCount = workers.filter(w => (nowT - Number(w.last_seen)) < 3 * 60 * 1000).length;
      return send(res, 200, {
        ok: true,
        orphanRows: r?.n || 0,
        orphanBatches: r?.batches || 0,
        claimedNow: claimed?.n || 0,
        activeWorkers: activeWorkerCount,
      });
    }
    // Deletes orphan keyword rows in a single transaction. Returns the
    // number of rows removed. Same safety pattern as reset-all: requires
    // an explicit confirm string so a stray fetch can't nuke data.
    if (m === 'POST' && p === '/api/keywords/cleanup-orphans') {
      const b = await readJson(req);
      if (b.confirm !== 'CLEAN_ORPHANS') return send(res, 400, { ok: false, error: "safety: send {confirm:'CLEAN_ORPHANS'} to proceed" });
      const info = Q.deleteOrphanKeywords.run();
      return send(res, 200, { ok: true, deleted: info.changes });
    }
    if (m === 'GET' && p === '/api/keywords/timeline') {
      // 24h throughput (rows-per-hour). Optional ?batchId= scope.
      const since = now() - 24 * 3600 * 1000;
      const bId = url.searchParams.get('batchId') || '';
      const rows = bId ? Q.keywordsPerHourBatch.all(since, bId) : Q.keywordsPerHourAll.all(since);
      return send(res, 200, { ok: true, since, buckets: rows });
    }

    // ----- Discovered keywords (results) -----
    if (m === 'POST' && p === '/api/keywords') {
      const b = await readJson(req);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      // Orphan-batch guard: refuse writes whose batch_id references a batch
      // that has no jobs. This was the root cause of "orphan" batches in the
      // UI — workers with a cached queueBatchId kept writing keyword rows
      // after a Reset deleted the batch, so the rows had nowhere to hang.
      // Rejecting here forces the worker to re-sync via /api/jobs/active-batch.
      const seenBatches = new Set();
      const rejected = [];
      const accepted = [];
      for (const r of rows) {
        const bid = r.batch_id || b.batchId || null;
        if (!bid) { rejected.push({ row: r, reason: 'no_batch_id' }); continue; }
        if (!seenBatches.has(bid)) {
          if (!Q.batchExists.get(bid)) { rejected.push({ row: r, reason: 'orphan_batch' }); continue; }
          seenBatches.add(bid);
        }
        accepted.push(r);
      }
      let n = 0;
      db.exec('BEGIN');
      try {
        for (const r of accepted) {
          Q.insertKeyword.run(r.batch_id || b.batchId || null, r.sku || null, r.keyword || '', r.product_url || '', JSON.stringify(r));
          n++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      // Tell the worker the current active batch so it can self-correct after
      // a rejection — same escape hatch as heartbeat.
      const cfgKw = Q.getConfig.get();
      const pinnedKw = (cfgKw?.active_batch_id || '').trim();
      let activeKw = pinnedKw && Q.batchHasPending.get(pinnedKw) ? pinnedKw : null;
      if (!activeKw) activeKw = Q.newestPendingBatch.get()?.batch_id || null;
      return send(res, 200, { ok: true, inserted: n, rejected: rejected.length, active_batch_id: activeKw });
    }
    if (m === 'GET' && p === '/api/keywords') {
      const batchId = url.searchParams.get('batchId') || '';
      const sinceIdRaw = url.searchParams.get('sinceId');
      const sinceId = sinceIdRaw != null && sinceIdRaw !== '' ? Number(sinceIdRaw) : null;
      const raw = Number.isFinite(sinceId)
        ? Q.keywordsByBatchSince.all(batchId, sinceId)
        : Q.keywordsByBatch.all(batchId);
      const rows = raw.map(r => {
        try { const d = JSON.parse(r.data); if (d && typeof d === 'object') d._id = r.id; return d; }
        catch { return null; }
      }).filter(Boolean);
      // Always return the CURRENT max id for this batch — even when sinceId
      // was set. Lets the client update its cursor even on an empty tick
      // (no new rows since last check but max id has advanced elsewhere).
      const maxRow = Q.keywordsMaxIdByBatch.get(batchId);
      const maxId = Number.isFinite(maxRow?.mx) ? maxRow.mx : (rows.length > 0 ? rows[rows.length - 1]._id : 0);
      return send(res, 200, {
        ok: true,
        total: rows.length,
        rows,
        maxId,
        incremental: Number.isFinite(sinceId),
        sinceId: Number.isFinite(sinceId) ? sinceId : null,
      });
    }

    // ----- Activity log -----
    if (m === 'POST' && p === '/api/activity') {
      const b = await readJson(req);
      for (const e of (Array.isArray(b.events) ? b.events : [b])) {
        if (!e || !e.message) continue;
        Q.insertActivity.run(e.batch_id || b.batchId || null, e.worker_id || b.workerId || null, e.level || 'info', e.source || null, String(e.message), e.product_url || null, e.sku || null);
      }
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/activity') {
      const batchId  = url.searchParams.get('batchId') || null;
      const workerId = (url.searchParams.get('workerId') || '').trim();
      const level    = (url.searchParams.get('level') || '').trim();
      const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '120', 10));
      const rows = workerId
        ? Q.recentActivityWorker.all(batchId, workerId, limit)
        : level
        ? Q.recentActivityLevel.all(batchId, level, limit)
        : Q.recentActivity.all(batchId, limit);
      return send(res, 200, { ok: true, events: rows });
    }

    // ----- Command bus -----
    if (m === 'POST' && p === '/api/commands') {
      const b = await readJson(req);
      Q.insertCommand.run(b.workerId || null, String(b.command || ''), b.payload ? JSON.stringify(b.payload) : null, b.createdBy || null);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/commands') {
      const rows = Q.pendingCommands.all(url.searchParams.get('workerId') || '').map(c => ({ ...c, payload: c.payload ? JSON.parse(c.payload) : null }));
      return send(res, 200, { ok: true, commands: rows });
    }
    if (m === 'POST' && p === '/api/commands/ack') {
      const b = await readJson(req);
      for (const id of (Array.isArray(b.ids) ? b.ids : [])) Q.ackCommand.run(now(), b.workerId || null, id);
      return send(res, 200, { ok: true });
    }

    // ----- Worker config (push-to-workers + active batch) -----
    if (m === 'GET' && p === '/api/config') {
      const row = Q.getConfig.get();
      return send(res, 200, { ok: true, config: row?.config ? JSON.parse(row.config) : {}, active_batch_id: row?.active_batch_id || null });
    }
    if (m === 'POST' && p === '/api/config') {
      const b = await readJson(req);
      if (b.config !== undefined) Q.setConfig.run(JSON.stringify(b.config || {}));
      if (b.configPatch && typeof b.configPatch === 'object') {
        const cur = Q.getConfig.get();
        const merged = { ...(cur?.config ? JSON.parse(cur.config) : {}) };
        for (const [k, v] of Object.entries(b.configPatch)) { if (v === null) delete merged[k]; else merged[k] = v; }
        Q.setConfig.run(JSON.stringify(merged));
      }
      if ('activeBatchId' in b) Q.setActiveBatch.run(b.activeBatchId || null);
      return send(res, 200, { ok: true });
    }

    // ----- Destructive: delete a batch (jobs + keywords + activity) -----
    if (m === 'POST' && p === '/api/jobs/delete-batch') {
      const b = await readJson(req);
      const batchId = String(b.batchId || '').trim();
      if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
      let j = 0, k = 0, a = 0;
      db.exec('BEGIN');
      try {
        j = Q.deleteBatchJobs.run(batchId).changes;
        k = Q.deleteBatchKeywords.run(batchId).changes;
        a = Q.deleteBatchActivity.run(batchId).changes;
        // If the deleted batch was pinned, unpin so workers stop trying to claim it.
        const cfgRow = Q.getConfig.get();
        if (cfgRow?.active_batch_id === batchId) Q.setActiveBatch.run(null);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, batchId, deletedJobs: j, deletedKeywords: k, deletedActivity: a });
    }
    // ---------- Shopify integration ----------
    // Returns the field-impact hierarchy (what carries most SEO/CTR weight).
    // UI uses this to render a priority list; the Claude prompt inlines it too.
    // Diagnostic endpoint: run the SAME GraphQL lookup as the bulk
    // upload for ONE SKU, and return the raw request + response so
    // the user can see exactly what Shopify is doing. Solves the
    // 'why is every SKU resolving to CLEARSTEM' debug loop.
    if (m === 'GET' && p === '/api/shopify/debug-lookup') {
      const skuInput = String(url.searchParams.get('sku') || '').trim();
      if (!skuInput) return send(res, 400, { ok: false, error: 'sku query param required, e.g. ?sku=Dropy-B002OTT3US' });
      const cfgRow = Q.getConfig.get();
      const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
      const shop = cfg.shopify || {};
      const apiVer = shop.apiVersion || '2024-10';
      if (!shop.shopDomain || !shop.adminToken) {
        return send(res, 400, { ok: false, error: 'Shopify not configured — set credentials in Config → Shopify integration first' });
      }
      const asinMatch = skuInput.match(/^(?:Dropy-)?([A-Z0-9]{10})$/i);
      const asin = asinMatch ? asinMatch[1].toUpperCase() : null;
      const rounds = [];
      const tryQuery = async (field, value, label) => {
        const quoted = `${field}:\\"${String(value).replace(/"/g, '')}\\"`;
        const graphqlText = `{
          productVariants(first: 3, query: "${quoted}") {
            edges { node { id sku barcode product { id handle title vendor productType } } }
          }
        }`;
        const body = { query: graphqlText };
        const started = Date.now();
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`, body,
        });
        const elapsed = Date.now() - started;
        const edges = r?.data?.data?.productVariants?.edges || [];
        const returned = edges.map(e => ({
          sku: e?.node?.sku,
          barcode: e?.node?.barcode,
          product: {
            id: e?.node?.product?.id,
            handle: e?.node?.product?.handle,
            title: e?.node?.product?.title,
          },
          exactMatch: String(e?.node?.[field] || '').toLowerCase() === String(value).toLowerCase(),
        }));
        rounds.push({
          label, field, requested: value,
          graphqlQuery: graphqlText.replace(/\s+/g, ' ').trim(),
          shopifyStatus: r.status,
          shopifyOk: r.ok,
          shopifyError: r.error || null,
          elapsedMs: elapsed,
          returnedCount: edges.length,
          returned,
          firstExactMatch: returned.find(v => v.exactMatch) || null,
        });
      };
      // Round 1 — variant SKU exact match with 3 candidate forms
      const candidates = [skuInput];
      if (asin) {
        if (!candidates.includes(asin))              candidates.push(asin);
        if (!candidates.includes(`Dropy-${asin}`))   candidates.push(`Dropy-${asin}`);
      }
      for (const c of candidates) await tryQuery('sku', c, `sku="${c}"`);
      // Round 2 — variant BARCODE match
      for (const c of candidates) await tryQuery('barcode', c, `barcode="${c}"`);
      // Round 3 — product handle wildcard
      let handleRound = null;
      if (asin) {
        const asinLower = asin.toLowerCase();
        const graphqlText = `{
          products(first: 3, query: "handle:*${asinLower}*") {
            edges { node { id handle title vendor productType } }
          }
        }`;
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
          body: { query: graphqlText },
        });
        handleRound = {
          asin: asinLower,
          shopifyOk: r.ok,
          shopifyStatus: r.status,
          returned: (r?.data?.data?.products?.edges || []).map(e => ({
            handle: e?.node?.handle,
            title: e?.node?.title,
            matchesAsin: String(e?.node?.handle || '').toLowerCase().includes(asinLower),
          })),
        };
      }
      const winner = rounds.find(r => r.firstExactMatch) || null;
      return send(res, 200, {
        ok: true,
        input: skuInput,
        parsedAsin: asin,
        shopifyDomain: shop.shopDomain,
        apiVersion: apiVer,
        rounds,
        handleRound,
        conclusion: winner
          ? `MATCH: ${winner.label} → product '${winner.firstExactMatch.product.title}' (handle: ${winner.firstExactMatch.product.handle})`
          : `NO EXACT MATCH across ${rounds.length} lookup(s). Check the 'returned' arrays — Shopify may be returning fuzzy hits (wrong sku in returned[0].sku) OR nothing (returnedCount:0).`,
      });
    }
    if (m === 'GET' && p === '/api/shopify/field-impact') {
      return send(res, 200, { ok: true, fields: SHOPIFY_FIELD_IMPACT, allowlist: [...SHOPIFY_ALLOWED_FIELDS] });
    }
    // GET current product from Shopify by URL. Extracts the handle, calls
    // /admin/api/2024-10/products.json?handle=… . Returns the current
    // title, body_html, tags, vendor, product_type, handle, SEO meta,
    // images (readonly for context), variants (readonly for context only —
    // NEVER round-tripped to update). Used to build the Claude prompt.
    if (m === 'GET' && p === '/api/shopify/get-product') {
      const url = new URL(req.url, 'http://x');
      const productUrl = url.searchParams.get('url') || '';
      const handle = extractShopifyHandle(productUrl);
      if (!handle) return send(res, 400, { ok: false, error: `could not extract Shopify product handle from URL: ${productUrl}` });
      const cfgRow = Q.getConfig.get();
      const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
      const shop = cfg.shopify || {};
      const apiVer = shop.apiVersion || '2024-10';
      const r = await shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'GET', apiPath: `/admin/api/${apiVer}/products.json?handle=${encodeURIComponent(handle)}`,
      });
      if (!r.ok) return send(res, r.status || 502, { ok: false, error: `Shopify API: ${JSON.stringify(r.error)}` });
      const prod = (r.data?.products || [])[0];
      if (!prod) return send(res, 404, { ok: false, error: `no Shopify product with handle "${handle}"` });
      // Parallel fetch: metafields (for reviews, seo, category) + product_category via GraphQL.
      // Metafields carry the review-app data (Judge.me / Loox / Yotpo / native).
      // Failing either request is soft — we still return the base product so the
      // prompt can render; the reviews block just stays empty.
      const [mfRes, gqlRes] = await Promise.all([
        shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'GET', apiPath: `/admin/api/${apiVer}/products/${prod.id}/metafields.json`,
        }).catch(() => ({ ok: false })),
        shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
          body: { query: `{ product(id: "gid://shopify/Product/${prod.id}") { productCategory { productTaxonomyNode { id fullName name } } seo { title description } } }` },
        }).catch(() => ({ ok: false })),
      ]);
      const metafields = mfRes.ok ? (mfRes.data?.metafields || []) : [];
      // Extract review signals from common namespaces used by the top India-
      // supported review apps. Never fabricate — only emit numbers we found.
      const reviews = extractReviewSignals(metafields);
      // GraphQL SEO + productCategory (modern fields; not in REST payload).
      const gqlProd = gqlRes.ok ? (gqlRes.data?.data?.product || {}) : {};
      const seoTitle = gqlProd.seo?.title || '';
      const seoDescription = gqlProd.seo?.description || '';
      const productCategory = gqlProd.productCategory?.productTaxonomyNode || null;
      return send(res, 200, {
        ok: true, handle,
        product: {
          id: prod.id,
          title: prod.title || '',
          body_html: prod.body_html || '',
          tags: prod.tags || '',
          vendor: prod.vendor || '',
          product_type: prod.product_type || '',
          handle: prod.handle || '',
          status: prod.status || '',
          created_at: prod.created_at || null,
          updated_at: prod.updated_at || null,
          // SEO now populated from modern `seo` object on GraphQL Product.
          // Falls back to '' when GraphQL fetch failed (soft-fail above).
          seo_title: seoTitle,
          seo_description: seoDescription,
          // Standard Product Taxonomy — the Shopify Admin "Product category"
          // dropdown, which feeds Google Merchant / Meta Shop categorization.
          // null when unset in Shopify (that's the gap we want Claude to fill).
          product_category: productCategory,
          // Review-app data (Judge.me / Loox / Yotpo / native). Feeds the
          // conditional AggregateRating schema in the Claude prompt so we
          // never emit a fabricated rating.
          reviews,
          // Metafield namespaces detected — useful for the UI to show which
          // review app is wired up.
          metafield_namespaces: [...new Set(metafields.map(mf => mf.namespace))].filter(Boolean),
          // Images/variants included READ-ONLY for prompt context. Never
          // round-tripped to update — the allowlist has no room for them.
          images: (prod.images || []).map(im => ({ id: im.id, src: im.src, alt: im.alt || '' })),
          variants_readonly: (prod.variants || []).map(v => ({
            id: v.id, sku: v.sku, title: v.title,
            price: v.price, weight: v.weight, weight_unit: v.weight_unit,
            inventory_quantity: v.inventory_quantity, inventory_management: v.inventory_management,
          })),
        },
      });
    }
    // Update a Shopify product. Client sends {productId, patch}. Patch is
    // filtered against SHOPIFY_ALLOWED_FIELDS BEFORE the PUT; stripped
    // fields are returned in the response so the UI can show
    // "these were dropped, will not be sent" — the safety guarantee.
    // Standalone preflight — validate Claude's JSON without pushing. Useful
    // for the UI to show a red/yellow/green report next to the "Push" button
    // and let the user iterate on the prompt if the rubric flags issues.
    if (m === 'POST' && p === '/api/shopify/validate-patch') {
      const b = await readJson(req);
      if (!b.patch || typeof b.patch !== 'object') return send(res, 400, { ok: false, error: 'patch object required' });
      const { safe, stripped } = stripToShopifyAllowlist(b.patch);
      const preflight = validateShopifyPatch(safe, b.validationContext || {});
      return send(res, 200, { ok: true, preflight, stripped, safe });
    }
    if (m === 'POST' && p === '/api/shopify/update-product') {
      const b = await readJson(req);
      const productId = Number(b.productId);
      if (!productId) return send(res, 400, { ok: false, error: 'productId required' });
      if (!b.patch || typeof b.patch !== 'object') return send(res, 400, { ok: false, error: 'patch object required' });
      if (b.confirm !== 'PUSH') return send(res, 400, { ok: false, error: "safety: send {confirm:'PUSH'} to proceed" });
      const { safe, stripped } = stripToShopifyAllowlist(b.patch);
      if (Object.keys(safe).length === 0) {
        return send(res, 400, { ok: false, error: 'no allowlisted fields in patch (all were stripped)', stripped });
      }
      // Preflight rubric validation on the ALLOWLISTED (safe) payload. Critical
      // failures block the push unless caller explicitly passes force:true so
      // an obvious problem never reaches the store. Warnings surface but don't
      // block. Callers can dry-run via /api/shopify/validate-patch first.
      const preflight = validateShopifyPatch(safe, b.validationContext || {});
      if (!preflight.ok && !b.force) {
        return send(res, 400, {
          ok: false,
          error: `Preflight FAILED: ${preflight.critical.length} critical issue(s). Fix Claude's output or pass force:true to override.`,
          preflight,
          stripped,
          sent: safe,
        });
      }
      const cfgRow = Q.getConfig.get();
      const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
      const shop = cfg.shopify || {};
      const apiVer = shop.apiVersion || '2024-10';
      // Split the payload: REST for legacy fields, GraphQL productUpdate for
      // modern fields (seo object, productCategory). Both run — never one
      // instead of the other — so the caller gets full coverage regardless
      // of which path a given field lives on.
      const restPayload = {};
      const gqlPayload = {};
      for (const [k, v] of Object.entries(safe)) {
        if (SHOPIFY_GRAPHQL_ONLY_FIELDS.has(k)) gqlPayload[k] = v;
        else restPayload[k] = v;
      }
      const results = { rest: null, graphql: null };
      // REST update (title, body_html, tags, product_type, vendor, handle,
      // legacy SEO metafields). Skipped if only GraphQL-only fields were sent.
      if (Object.keys(restPayload).length > 0) {
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'PUT', apiPath: `/admin/api/${apiVer}/products/${productId}.json`,
          body: { product: { id: productId, ...restPayload } },
        });
        results.rest = { ok: r.ok, status: r.status, error: r.ok ? null : r.error, product: r.data?.product || null };
        if (!r.ok) return send(res, r.status || 502, { ok: false, error: `Shopify REST: ${JSON.stringify(r.error)}`, stripped, sent: safe, results });
      }
      // GraphQL supplementary — SEO + productCategory. Uses productUpdate;
      // productCategory takes a taxonomy node ID. seo.title / seo.description
      // are the modern replacement for metafields_global_*_tag.
      if (Object.keys(gqlPayload).length > 0) {
        const inputParts = [`id: "gid://shopify/Product/${productId}"`];
        const seoFields = [];
        if (gqlPayload.seo_title != null)       seoFields.push(`title: ${JSON.stringify(String(gqlPayload.seo_title))}`);
        if (gqlPayload.seo_description != null) seoFields.push(`description: ${JSON.stringify(String(gqlPayload.seo_description))}`);
        if (seoFields.length > 0) inputParts.push(`seo: { ${seoFields.join(', ')} }`);
        if (gqlPayload.product_category) inputParts.push(`productCategory: { productTaxonomyNodeId: "${String(gqlPayload.product_category).replace(/"/g, '')}" }`);
        const mutation = `mutation { productUpdate(input: { ${inputParts.join(', ')} }) { product { id seo { title description } productCategory { productTaxonomyNode { id fullName } } } userErrors { field message } } }`;
        const g = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
          body: { query: mutation },
        });
        const userErrs = g.data?.data?.productUpdate?.userErrors || [];
        results.graphql = { ok: g.ok && userErrs.length === 0, status: g.status, error: userErrs.length > 0 ? userErrs : (g.ok ? null : g.error), product: g.data?.data?.productUpdate?.product || null };
        if (!results.graphql.ok) {
          // REST already succeeded; return partial-success so the caller can
          // decide (retry the GraphQL half, or accept the REST-only write).
          return send(res, 502, { ok: false, error: `Shopify GraphQL: ${JSON.stringify(results.graphql.error)}`, stripped, sent: safe, results, note: 'REST fields written successfully; only modern SEO/category failed' });
        }
      }
      return send(res, 200, { ok: true, productId, sent: safe, stripped, results, product: results.rest?.product || null });
    }
    // Bulk-update image alt-text on a product. Deterministic template — does
    // NOT need Claude. Takes the current product images + a keyword-rich
    // template built from the research (e.g. `${primaryKeyword} — ${benefit}`)
    // and PUTs each image's alt via /products/{pid}/images/{iid}.json.
    // Missed SEO signal previously: alt text drives Google Image Search + the
    // main-image alt is a documented ranking signal on the product page.
    if (m === 'POST' && p === '/api/shopify/update-image-alts') {
      const b = await readJson(req);
      const productId = Number(b.productId);
      if (!productId) return send(res, 400, { ok: false, error: 'productId required' });
      if (b.confirm !== 'PUSH') return send(res, 400, { ok: false, error: "safety: send {confirm:'PUSH'} to proceed" });
      const alts = Array.isArray(b.alts) ? b.alts : null;
      if (!alts || alts.length === 0) return send(res, 400, { ok: false, error: 'alts array required — each entry: {imageId, alt}' });
      const cfgRow = Q.getConfig.get();
      const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
      const shop = cfg.shopify || {};
      const apiVer = shop.apiVersion || '2024-10';
      const results = [];
      for (const entry of alts) {
        const imageId = Number(entry.imageId || entry.id);
        const alt = String(entry.alt || '').slice(0, 512); // Shopify soft-cap
        if (!imageId || !alt) { results.push({ imageId, ok: false, error: 'missing imageId or alt' }); continue; }
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'PUT', apiPath: `/admin/api/${apiVer}/products/${productId}/images/${imageId}.json`,
          body: { image: { id: imageId, alt } },
        }).catch(e => ({ ok: false, error: e.message }));
        results.push({ imageId, ok: r.ok, status: r.status, alt: r.ok ? alt : null, error: r.ok ? null : r.error });
      }
      const okCount = results.filter(x => x.ok).length;
      return send(res, 200, { ok: okCount > 0, productId, updated: okCount, total: results.length, results });
    }
    // Selective wipe — user picks which categories to nuke, optionally
    // scoped to one batch. Client sends {confirm:'WIPE', flags:{...}, batchId?}.
    // Flags: jobs, keywords, activity, commands, workers, failedJobsOnly,
    // orphansOnly. batchId scopes {jobs, keywords, activity, failedJobsOnly}
    // to that batch; global-only flags (commands/workers/orphansOnly) ignore
    // batchId. Returns per-category delete counts.
    if (m === 'POST' && p === '/api/wipe-selective') {
      const b = await readJson(req);
      if (b.confirm !== 'WIPE') return send(res, 400, { ok: false, error: "safety: send {confirm:'WIPE'} to proceed" });
      const flags = b.flags || {};
      const batchId = (b.batchId && String(b.batchId).trim()) || null;
      let dJobs=0, dKw=0, dAct=0, dCmd=0, dWrk=0, dFail=0, dOrph=0;
      db.exec('BEGIN');
      try {
        // failedJobsOnly wins over the 'jobs' flag (it's a narrower delete).
        if (flags.failedJobsOnly) {
          const stmt = batchId
            ? db.prepare(`DELETE FROM jobs WHERE status='failed' AND batch_id=?`)
            : db.prepare(`DELETE FROM jobs WHERE status='failed'`);
          dFail = (batchId ? stmt.run(batchId) : stmt.run()).changes;
        } else if (flags.jobs) {
          dJobs = batchId ? Q.deleteBatchJobs.run(batchId).changes : Q.wipeJobs.run().changes;
        }
        if (flags.keywords) dKw  = batchId ? Q.deleteBatchKeywords.run(batchId).changes : Q.wipeKeywords.run().changes;
        if (flags.activity) dAct = batchId ? Q.deleteBatchActivity.run(batchId).changes : Q.wipeActivity.run().changes;
        // Global-only flags — batchId doesn't apply.
        if (flags.commands)     dCmd  = Q.wipeCommands.run().changes;
        if (flags.workers)      dWrk  = Q.wipeWorkersRoster.run().changes;
        if (flags.orphansOnly)  dOrph = Q.deleteOrphanKeywords.run().changes;
        // Unpin active batch ONLY if we actually deleted the pinned batch's
        // full job set. failedJobsOnly=true short-circuits above and leaves
        // pending/claimed/done intact — we must NOT unpin in that case
        // (workers would abandon the batch on next poll). Guard on dJobs.
        if (flags.jobs && !flags.failedJobsOnly && dJobs > 0) {
          const cfgRow = Q.getConfig.get();
          if (batchId && cfgRow?.active_batch_id === batchId) Q.setActiveBatch.run(null);
          if (!batchId) Q.setActiveBatch.run(null);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, {
        ok: true, batchId,
        deletedJobs: dJobs, deletedKeywords: dKw, deletedActivity: dAct,
        deletedCommands: dCmd, deletedWorkers: dWrk,
        deletedFailedJobs: dFail, deletedOrphans: dOrph,
      });
    }
    // ----- Destructive: nuke everything except worker_config -----
    if (m === 'POST' && p === '/api/reset-all') {
      const b = await readJson(req);
      // Belt-and-suspenders confirm: clients must send {confirm:'RESET'}.
      if (b.confirm !== 'RESET') return send(res, 400, { ok: false, error: "safety: send {confirm:'RESET'} to proceed" });
      let j = 0, k = 0, a = 0, c = 0, w = 0;
      db.exec('BEGIN');
      try {
        j = Q.wipeJobs.run().changes;
        k = Q.wipeKeywords.run().changes;
        a = Q.wipeActivity.run().changes;
        c = Q.wipeCommands.run().changes;
        w = Q.wipeWorkersRoster.run().changes;
        // Unpin any pinned batch — it no longer exists.
        Q.setActiveBatch.run(null);
        // Broadcast a reset_local command so every worker clears its
        // chrome.storage (stale batch IDs, claimed job IDs, done-products
        // list, in-memory report). Without this, workers keep trying to
        // heartbeat non-existent jobs after a reset. Broadcast = worker_id
        // NULL; every worker sees it on its next 30s command poll.
        Q.insertCommand.run(null, 'reset_local', null, 'manager-reset-all');
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, deletedJobs: j, deletedKeywords: k, deletedActivity: a, deletedCommands: c, deletedWorkers: w });
    }
    if (m === 'POST' && p === '/api/cleanup') {
      const b = await readJson(req);
      const a = Q.cleanupActivity.run(now() - (b.logDays ?? 7) * 86400000);
      const c = Q.cleanupCommands.run(now() - (b.commandsDays ?? 1) * 86400000);
      return send(res, 200, { ok: true, activityLog: a.changes, ackedCommands: c.changes });
    }
    // Clear activity log immediately with optional filters — used by the
    // "clear" buttons on the dashboard's Errors + Activity cards.
    // Supports: {level:'err'|'warn'|'info'} to scope by level,
    //           {workerId:'PC-XXX'} to scope by worker,
    //           {batchId:'...'} to scope by batch,
    //           {olderThanMs:N} to keep only recent.
    // Any combination ANDs together. Empty body = nuke every activity row.
    if (m === 'POST' && p === '/api/activity/clear') {
      const b = await readJson(req).catch(() => ({}));
      const conds = [], args = [];
      if (b.level)       { conds.push('level = ?');       args.push(String(b.level)); }
      if (b.workerId)    { conds.push('worker_id = ?');   args.push(String(b.workerId)); }
      if (b.batchId)     { conds.push('batch_id = ?');    args.push(String(b.batchId)); }
      if (Number.isFinite(b.olderThanMs)) { conds.push('ts < ?'); args.push(now() - Number(b.olderThanMs)); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const stmt = db.prepare(`DELETE FROM activity_log ${where}`);
      const info = stmt.run(...args);
      return send(res, 200, { ok: true, deleted: info.changes });
    }

    return send(res, 404, { ok: false, error: 'no such route' });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[manager] AdBrain SQLite manager on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
  console.log(`[manager] Dashboard: http://<this-tailscale-name>:${PORT}/`);
  console.log(TOKEN ? '[manager] MANAGER_TOKEN set — clients must send X-Manager-Token.' : '[manager] No token — relying on Tailscale for access control.');
});
