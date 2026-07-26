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

// Route registry + section modules. Router runs first in the request
// handler; if it matches, the response is already sent. Un-migrated
// sections (Jobs, Shopify, Batches, Workers, Keywords) still live in
// the if-ladder below — moved out one section at a time to keep diffs
// reviewable. See router.js for the primitive.
const { createRouter } = require('./router.js');
const healthRoutes      = require('./routes/health.js');
const activityRoutes    = require('./routes/activity.js');
const commandsRoutes    = require('./routes/commands.js');
const configRoutes      = require('./routes/config.js');
const backupsRoutes     = require('./routes/backups.js');
const destructiveRoutes = require('./routes/destructive.js');
const workersRoutes     = require('./routes/workers.js');
const keywordsRoutes    = require('./routes/keywords.js');
const batchesRoutes     = require('./routes/batches.js');
const jobsRoutes        = require('./routes/jobs.js');
const jobsUploadRoutes  = require('./routes/jobs-upload.js');
const shopifyRoutes     = require('./routes/shopify.js');

// ---------- Shopify Admin API helpers ----------
// STRICT ALLOWLIST for Shopify product updates. Everything NOT in this list
// is stripped server-side before we PUT to Shopify — even if the client
// puts price/weight/location/variants/inventory in the payload, they will
// NEVER leave this process. This is the safety guarantee the user asked for:
// "not price, weight, location etc should not be updated."
const SHOPIFY_ALLOWED_FIELDS = new Set([
  'title',
  'body_html',
  // Handle / tags / vendor / product_type DELIBERATELY EXCLUDED — any of
  // these can move a product between Smart Collections (auto-collections)
  // by matching a rule condition like "vendor is X" or "product_type equals
  // Y". Operator's Shopify Admin management is authoritative for anything
  // collection-affecting. Claude focuses on fields that CAN'T contaminate
  // collection membership (title / body_html / SEO fields / metafields /
  // product_category / image alts).
  //
  //   handle       → URL slug. Even a "better" keyword-rich handle scores
  //                  worse than the URL Google has already indexed. Manual
  //                  Admin task with 301 redirect setup.
  //   tags         → Smart-Collection rule anchor (product_tag contains X).
  //   vendor       → Smart-Collection rule anchor (vendor is X). Also brand-
  //                  page collections.
  //   product_type → Smart-Collection rule anchor (product_type equals Y).
  //                  Category-page collections.
  //
  // Shopify preserves each field when a PUT omits it — which is exactly
  // what we want.
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
// Custom metafields the theme's product page reads to populate its
// separate tabs (Description / How To Use / Ingredients) + the FAQ block.
//
// The keys below are ALIASES that Claude produces (stable, human-readable).
// The ACTUAL namespace.key on any given store is discovered at push time
// from the store's metafield_definitions (fetched in get-product). We
// match by DISPLAY NAME first (case-insensitive, hyphen-insensitive),
// then by the alias key itself as a fallback ('custom.how_to_use' etc).
//
// Why aliases and not fixed namespace.key: different stores use different
// namespaces (custom / product / dropy / a custom app namespace). We were
// writing to 'custom.*' regardless — creating orphan metafields no theme
// read. Definition-based resolution fixes that. Rules for matching:
//   1. Alias exactly matches a definition's namespace.key → use it.
//   2. Alias matches a definition's `name` (spaces normalized) → use it.
//   3. Otherwise fall back to writing at the alias's `custom.*` key
//      (existing behavior — may still orphan on stores without matching
//      definitions, but at least the operator sees the metafields listed
//      in Shopify Admin and can wire them up manually).
const SHOPIFY_METAFIELD_ALIASES = {
  'custom.how_to_use':    { displayNames: ['how to use', 'how-to-use', 'how_to_use', 'usage'],           type: 'multi_line_text_field' },
  'custom.ingredients':   { displayNames: ['ingredients', 'ingredient list', 'composition'],              type: 'multi_line_text_field' },
  'custom.bullet_points': { displayNames: ['bullet points', 'bullet_points', 'bullets', 'key features'], type: 'rich_text_field' },
  'custom.department':    { displayNames: ['department', 'category'],                                     type: 'single_line_text_field' },
  'custom.highlight_1':   { displayNames: ['highlight 1', 'highlight1'],                                  type: 'single_line_text_field' },
  'custom.highlight_2':   { displayNames: ['highlight 2', 'highlight2'],                                  type: 'single_line_text_field' },
  'custom.highlight_3':   { displayNames: ['highlight 3', 'highlight3'],                                  type: 'single_line_text_field' },
  // ONE consolidated FAQ block — 6-10 Q/A pairs as HTML details/summary.
  // Cleaner than 20 separate faq_q_1..10 / faq_a_1..10 metafields, and
  // matches store's existing 'FAQ'S' definition. Server writes to this
  // alias when a matching definition exists (any of the display names
  // below); otherwise falls back to the individual Q_1/A_1 slots.
  'custom.faqs':          { displayNames: ["faq's", "faqs", "faq", "frequently asked questions", "product faqs"], type: 'multi_line_text_field' },
};
// Individual FAQ Q/A pairs — 1 through 10. Kept as a fallback in case the
// store still reads from the per-question metafields, OR for stores that
// haven't migrated to the consolidated 'custom.faqs' single-field pattern.
// If both custom.faqs AND custom.faq_q_N are produced, the server prefers
// consolidated (see push handler) — one write, less noise in Shopify Admin.
for (let i = 1; i <= 10; i++) {
  SHOPIFY_METAFIELD_ALIASES[`custom.faq_q_${i}`] = {
    displayNames: [`f&q question ${i}`, `faq question ${i}`, `faq_q_${i}`, `faq q ${i}`, `question ${i}`],
    type: 'single_line_text_field',
  };
  SHOPIFY_METAFIELD_ALIASES[`custom.faq_a_${i}`] = {
    displayNames: [`f&q answer ${i}`, `faq answer ${i}`, `faq_a_${i}`, `faq a ${i}`, `answer ${i}`],
    type: 'multi_line_text_field',
  };
}
// Legacy shape kept for the client-side allowlist echo (unchanged public API).
const SHOPIFY_METAFIELD_ALLOWLIST = Object.fromEntries(
  Object.entries(SHOPIFY_METAFIELD_ALIASES).map(([k, v]) => [k, { type: v.type }])
);
// Resolver: given an alias and the fetched definitions list, return the
// {namespace, key, type} to actually POST to — OR null if we can't
// confidently resolve. NULL is the important case: if the store has no
// matching definition, writing to custom.* would create an orphan metafield
// the theme never reads (that's exactly what dumped everything into
// Description in the earlier push). Refuse the write instead — the client
// surfaces the miss so the operator can either define the metafield in
// Shopify or drop it from the output.
function resolveMetafieldTarget(alias, definitions = []) {
  const spec = SHOPIFY_METAFIELD_ALIASES[alias];
  if (!spec) return null;
  const norm = s => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  // 1. Exact namespace.key match against definitions.
  const exact = definitions.find(d => `${d.namespace}.${d.key}` === alias);
  if (exact) return { namespace: exact.namespace, key: exact.key, type: exact.type || spec.type, resolvedVia: 'exact-key' };
  // 2. Display name match.
  const byName = definitions.find(d => spec.displayNames.some(n => norm(d.name) === norm(n)));
  if (byName) return { namespace: byName.namespace, key: byName.key, type: byName.type || spec.type, resolvedVia: 'display-name' };
  // 3. NO MATCH — refuse the write. This is a change from the previous
  //    'fallback-custom' behavior which created orphan metafields. Loud
  //    failure is better than a silent 'wrote but theme ignored'.
  return null;
}
// Field-impact hierarchy (surfaces to the UI + prompt). Ordered by ranking/
// visibility impact — Claude is told to spend the most effort on the top
// items, and the manager UI shows the same order in previews.
const SHOPIFY_FIELD_IMPACT = [
  { field: 'title',                              impact: 'critical', why: 'primary rank signal + SERP snippet + cart title' },
  { field: 'seo_title',                          impact: 'critical', why: 'modern <title> (Shopify Admin > Search engine listing). 55-60 chars, keyword + benefit + brand. Prefer this over the legacy metafield.' },
  { field: 'metafields_global_title_tag',        impact: 'critical', why: 'legacy <title> metafield; kept for REST compatibility. Duplicate seo_title here for belt-and-braces coverage.' },
  { field: 'seo_description',                    impact: 'high',     why: 'modern <meta description>; drives SERP CTR. 150-160 chars, hook + benefit + CTA. Prefer this over the legacy metafield.' },
  { field: 'metafields_global_description_tag',  impact: 'high',     why: 'legacy <meta description> metafield; kept for REST compatibility.' },
  { field: 'body_html',                          impact: 'high',     why: 'first 100 words = ranking anchor; include secondary keywords + FAQ + buying-intent phrases' },
  { field: 'product_category',                   impact: 'high',     why: 'Standard Product Taxonomy node id (gid://shopify/ProductTaxonomyNode/N). Feeds Google Merchant / Meta Shop categorization + Shopify category filters. HIGH SEO signal.' },
];
// Auto-router: no matter how forcefully we tell Claude 'do not put X in
// body_html', it sometimes still dumps everything into Description. This
// runs BEFORE stripToShopifyAllowlist and forcibly EXTRACTS the theme-
// tab sections from body_html into metafields, then strips them from
// body_html. Safety net so 'dumped everything into Description' becomes
// architecturally impossible — even if Claude ignores the split rule,
// the server splits it for them.
function autoRouteBodyToMetafields(patch) {
  const original = patch.body_html || '';
  if (!original) return patch;
  patch.metafields = patch.metafields || {};
  let body = original;
  const htmlToPlain = html => String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Extract 'How to use' / 'Usage instructions' / 'Directions' h2 block.
  const howToRe = /<h2[^>]*>\s*(?:how\s+to\s+use|usage\s+instructions|directions)[^<]*<\/h2>([\s\S]*?)(?=<h2\b|<script\b|$)/i;
  const howToMatch = body.match(howToRe);
  if (howToMatch && !patch.metafields['custom.how_to_use']) {
    patch.metafields['custom.how_to_use'] = htmlToPlain(howToMatch[1]);
    body = body.replace(howToMatch[0], '');
  }
  // Extract 'Ingredients' or 'Composition' h2 block (bare — not 'Ingredient
  // breakdown' which is a body-html-appropriate deep-dive).
  const ingRe = /<h2[^>]*>\s*(?:ingredients?|composition)\s*<\/h2>([\s\S]*?)(?=<h2\b|<script\b|$)/i;
  const ingMatch = body.match(ingRe);
  if (ingMatch && !patch.metafields['custom.ingredients']) {
    patch.metafields['custom.ingredients'] = htmlToPlain(ingMatch[1]);
    body = body.replace(ingMatch[0], '');
  }
  // Extract FAQ <details><summary>Q</summary>A</details> blocks — up to 10.
  // Two write paths: (a) consolidated custom.faqs if Claude didn't already
  // set it, keeping the HTML details/summary formatting verbatim, AND
  // (b) individual custom.faq_q_N / faq_a_N slots as fallback. resolver
  // picks whichever alias has a matching definition on the store; both
  // fill so themes reading either shape find content.
  const detailsRe = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  const details = [...body.matchAll(detailsRe)].slice(0, 10);
  if (details.length > 0 && !patch.metafields['custom.faqs']) {
    patch.metafields['custom.faqs'] = details.map(m => m[0]).join('\n\n');
  }
  for (let i = 0; i < details.length; i++) {
    const qKey = `custom.faq_q_${i + 1}`;
    const aKey = `custom.faq_a_${i + 1}`;
    if (!patch.metafields[qKey]) patch.metafields[qKey] = htmlToPlain(details[i][1]);
    if (!patch.metafields[aKey]) patch.metafields[aKey] = htmlToPlain(details[i][2]);
  }
  if (details.length > 0) {
    body = body.replace(/<h2[^>]*>\s*(?:frequently\s+asked\s+questions?|faqs?)[^<]*<\/h2>[\s\S]*?(?=<h2\b|<script\b|$)/i, '');
    body = body.replace(detailsRe, '');
  }
  // Strip any Shipping & returns h2 section — theme renders policies
  // natively; body_html duplication is redundant. Runs even if we didn't
  // extract other sections, so the safety net always applies.
  const shipReturnsRe = /<h2[^>]*>\s*(?:shipping\s*(?:&|and|&amp;)\s*returns?|shipping,?\s*returns?\s*(?:&|and|&amp;)?\s*(?:refunds?)?|delivery\s*(?:&|and|&amp;)\s*returns?)[^<]*<\/h2>[\s\S]*?(?=<h2\b|<script\b|$)/i;
  const shipReturnsMatch = body.match(shipReturnsRe);
  if (shipReturnsMatch) body = body.replace(shipReturnsMatch[0], '');
  // Only rewrite body_html if we actually extracted something. Trim
  // consecutive blank lines the strips leave behind.
  if (body !== original) {
    patch.body_html = body.replace(/(\n\s*){3,}/g, '\n\n').trim();
    patch._auto_routed = {
      how_to_use_extracted: !!howToMatch,
      ingredients_extracted: !!ingMatch,
      faqs_extracted: details.length,
      shipping_returns_stripped: !!shipReturnsMatch,
      body_shrunk_by: original.length - patch.body_html.length,
    };
  }
  return patch;
}

// Tag patterns that MUST be preserved through a Claude rewrite, because
// dropping them silently changes collection membership or breaks downstream
// tooling that filters on them. Merged back into the outgoing tag list
// during stripToShopifyAllowlist if the current-listing carries them but
// Claude's new list doesn't. Case-insensitive match.
//
// - Drop N / drop-N / drop_N — internal batch groupings the operator uses
// - Vendor name matched separately below (need currentProduct.vendor to know)
// - Control flags — no-google / noindex / no-search / hidden / cod-eligible
// - Underscore-prefixed — internal convention many stores use (_pinned, _staff)
const TAG_PRESERVE_PATTERNS = [
  /^drop[\s_-]?\d+$/i,
  /^(no-google|noindex|no-index|no-search|nosearch|no_google|hidden)$/i,
  /^_[a-z0-9_-]+$/i,
];

// Return the safe tag list: Claude's new tags PLUS any preserved tags from
// the current tags that Claude dropped. Deduplicates case-insensitively but
// keeps the original casing when we preserve.
function mergeTagsPreservingProtected(claudeTagsRaw, currentTagsRaw, vendor) {
  const currentList = String(currentTagsRaw || '').split(/\s*,\s*/).filter(Boolean);
  const claudeList  = String(claudeTagsRaw  || '').split(/\s*,\s*/).filter(Boolean);
  const lowerSet = new Set(claudeList.map(t => t.toLowerCase()));
  const preserved = [];
  const vendorLc = String(vendor || '').toLowerCase();
  for (const tag of currentList) {
    const lc = tag.toLowerCase();
    if (lowerSet.has(lc)) continue;                       // already in Claude's list
    const isPatternProtected = TAG_PRESERVE_PATTERNS.some(rx => rx.test(tag));
    const isVendorTag = vendorLc && lc === vendorLc;
    if (isPatternProtected || isVendorTag) {
      preserved.push(tag);
      lowerSet.add(lc);
    }
  }
  return { merged: [...claudeList, ...preserved].join(', '), preserved, dropped: currentList.filter(t => !lowerSet.has(t.toLowerCase())) };
}

// If Claude sent the consolidated 'custom.faqs' block, fan its <details>
// entries out to individual 'custom.faq_q_N' / 'custom.faq_a_N' slots so
// storefront themes that render the OLD individual-metafield schema pick
// up new content. Also BLANK slots N+1..10 so stale FAQs from earlier
// pushes don't linger on the page. If Claude also sent explicit q/a
// values, respect them and don't overwrite.
function fanOutConsolidatedFaqs(patch) {
  patch.metafields = patch.metafields || {};
  const faqs = patch.metafields['custom.faqs'];
  if (typeof faqs !== 'string' || !faqs.trim()) return patch;
  const stripHtml = html => String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').trim();
  const rx = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  const blocks = [...faqs.matchAll(rx)].slice(0, 10);
  let filled = 0;
  for (let i = 0; i < blocks.length; i++) {
    const qKey = `custom.faq_q_${i + 1}`;
    const aKey = `custom.faq_a_${i + 1}`;
    if (!patch.metafields[qKey]) { patch.metafields[qKey] = stripHtml(blocks[i][1]); filled++; }
    if (!patch.metafields[aKey]) { patch.metafields[aKey] = stripHtml(blocks[i][2]); }
  }
  // Blank remaining slots (blocks.length+1..10) so stale content clears.
  // Empty string wipes the metafield value without deleting the definition.
  for (let i = blocks.length; i < 10; i++) {
    const qKey = `custom.faq_q_${i + 1}`;
    const aKey = `custom.faq_a_${i + 1}`;
    if (!(qKey in patch.metafields)) patch.metafields[qKey] = '';
    if (!(aKey in patch.metafields)) patch.metafields[aKey] = '';
  }
  patch._faq_fanout = { total_blocks: blocks.length, filled, blanked: Math.max(0, 10 - blocks.length) };
  return patch;
}

function stripToShopifyAllowlist(payload, opts = {}) {
  // Run auto-router FIRST so extracted content lands in metafields BEFORE
  // the allowlist strip decides what to keep. Non-destructive on payloads
  // that already split cleanly (metafields present, body_html clean).
  payload = autoRouteBodyToMetafields({ ...(payload || {}) });
  // Then fan out consolidated 'custom.faqs' to individual q_N/a_N slots
  // + blank empty slots. Handles the case where Claude sent FAQs only in
  // the consolidated field but the theme reads from individual slots.
  payload = fanOutConsolidatedFaqs(payload);
  // Tag preservation — merge protected tags from current listing back into
  // Claude's new tag list. opts.currentTags + opts.currentVendor supply the
  // 'before' state (fetched by update-product before we call this).
  let tagPreservation = null;
  if (typeof payload.tags === 'string' && opts.currentTags != null) {
    const merged = mergeTagsPreservingProtected(payload.tags, opts.currentTags, opts.currentVendor);
    payload.tags = merged.merged;
    tagPreservation = { preserved: merged.preserved, dropped: merged.dropped };
  }
  const autoRouted = payload._auto_routed || null;
  delete payload._auto_routed;   // don't emit as 'stripped'
  const faqFanout = payload._faq_fanout || null;
  delete payload._faq_fanout;
  const out = {};
  const stripped = [];
  const metafieldsOut = {};   // 'namespace.key' → value (only allowlisted)
  const imageAltsOut = [];    // [{imageId, alt}, ...] — routed to /update-image-alts after main push
  const raw = payload || {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'metafields' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [mkey, mval] of Object.entries(v)) {
        if (SHOPIFY_METAFIELD_ALLOWLIST[mkey]) metafieldsOut[mkey] = String(mval == null ? '' : mval);
        else stripped.push(`metafields.${mkey}`);
      }
    } else if (k === 'image_alts' && Array.isArray(v)) {
      // Image alts: [{imageId, alt}, ...] — validate shape here; write via
      // Shopify products/{pid}/images/{iid}.json PUT after main push.
      for (const entry of v) {
        const imageId = Number(entry?.imageId || entry?.id);
        const alt = String(entry?.alt || '').slice(0, 512);
        if (imageId && alt) imageAltsOut.push({ imageId, alt });
        else stripped.push(`image_alts entry with missing imageId or alt`);
      }
    } else if (SHOPIFY_ALLOWED_FIELDS.has(k)) {
      out[k] = v;
    } else {
      stripped.push(k);
    }
  }
  if (Object.keys(metafieldsOut).length > 0) out.metafields = metafieldsOut;
  if (imageAltsOut.length > 0) out.image_alts = imageAltsOut;
  return { safe: out, stripped, autoRouted, tagPreservation, faqFanout };
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
    if (bytes > 40 * 1024)      pushCrit('body_too_large', `body_html ${(bytes / 1024).toFixed(1)} KB > 40 KB hard cap`);
    else if (bytes > 25 * 1024) pushWarn('body_over_soft_cap', `body_html ${(bytes / 1024).toFixed(1)} KB > 25 KB soft cap — will drop Lighthouse Performance measurably on mobile. Consider trimming FAQ/table verbosity.`);
    if (words < 800)       pushCrit('body_too_short', `body_html ${words} words < 800 minimum (target 1200-2000)`);
    else if (words < 1200) pushWarn('body_short', `body_html ${words} words < 1200 target`);
    // Structural page-speed guardrails — count DOM cost proxies.
    const h2Count  = (bodyHtml.match(/<h2\b/gi) || []).length;
    const anchors  = (bodyHtml.match(/<a\b/gi) || []).length;
    const faqBlocks = (bodyHtml.match(/<details\b/gi) || []).length;
    stats.h2_count = h2Count;
    stats.anchor_count = anchors;
    if (h2Count > 12) pushWarn('body_too_many_sections', `body_html has ${h2Count} <h2> sections — target 8-10 for lean rendering`);
    if (anchors > 20) pushWarn('body_too_many_links',    `body_html has ${anchors} <a> tags — target ≤ 15 (each link adds DOM + potential preconnect cost)`);
    if (faqBlocks > 0) pushWarn('body_faq_leaked_to_body', `body_html has ${faqBlocks} FAQ <details> blocks — FAQ content belongs in metafields.custom.faqs (theme slots require exactly 10 pairs). Body_html should carry only the FAQPage JSON-LD schema, not visible <details>.`);
    // External-link rel enforcement — big Lighthouse Best Practices signal.
    const externalAnchorsWithoutRel = (bodyHtml.match(/<a\b[^>]*href=["']https?:\/\/(?!(?:[a-z0-9-]+\.)?dropy\.in)[^"']+["'][^>]*>/gi) || [])
      .filter(tag => !/rel=["'][^"']*(nofollow|noopener)/i.test(tag)).length;
    if (externalAnchorsWithoutRel > 0) pushWarn('body_external_no_rel', `body_html has ${externalAnchorsWithoutRel} external <a> tag(s) missing rel="nofollow noopener" — Lighthouse Best Practices flag`);
    // Content leak detection: body_html should NOT contain sections that
    // belong in metafields (How To Use, Ingredients, FAQ blocks). If Claude
    // put them here anyway, they'll duplicate the theme's tab content and
    // hurt SEO. Warn (not critical) so operator can force-push after review.
    if (/<h2[^>]*>[^<]{0,60}(how to use|usage instructions|directions?)/i.test(bodyHtml)) {
      pushWarn('body_leaked_how_to_use', 'body_html contains a "How to use" <h2> — this content should be in metafields.custom.how_to_use so it renders in the theme\'s dedicated tab. Duplicate content in both places hurts SEO.');
    }
    if (/<h2[^>]*>[^<]{0,60}(ingredients|composition|actives)/i.test(bodyHtml) &&
        !/<h2[^>]*>[^<]{0,60}(ingredient breakdown|key.*active)/i.test(bodyHtml)) {
      // Allow "Ingredient breakdown" (a body-html-appropriate deep-dive) but flag bare "Ingredients"
      pushWarn('body_leaked_ingredients', 'body_html contains an "Ingredients" <h2> — the raw ingredient list should be in metafields.custom.ingredients (theme renders it in the Ingredients tab). Body_html can discuss key actives but the list belongs in the metafield.');
    }
    const detailsCount = (bodyHtml.match(/<details\b/gi) || []).length;
    if (detailsCount >= 3) {
      pushWarn('body_leaked_faq', `body_html contains ${detailsCount} <details> blocks — FAQ content belongs in metafields.custom.faq_q_1..5 / faq_a_1..5 so the theme's FAQ section populates. Duplicate FAQ content in both hurts SEO.`);
    }
    // Page-speed guardrails
    const scriptMatches = bodyHtml.match(/<script\b[^>]*>/gi) || [];
    const jsonLdCount = scriptMatches.filter(s => /application\/ld\+json/i.test(s)).length;
    const nonLdScripts = scriptMatches.length - jsonLdCount;
    if (nonLdScripts > 0) pushCrit('body_has_scripts', `body_html has ${nonLdScripts} non-JSON-LD <script> tag(s) — page-speed + XSS risk`);
    // Old rule ('no JSON-LD is critical') flipped 2026-07-25 after live
    // audits confirmed the theme emits Product + FAQPage + BreadcrumbList
    // schemas natively. Any body_html JSON-LD creates duplicates AND is
    // at risk of the theme's text-highlighter corrupting it. Now a
    // WARNING when body_html has a JSON-LD block (instead of critical
    // when missing). Duplicate Product / FAQPage detection is handled
    // in the post-push live-page audit separately.
    if (jsonLdCount > 0) pushWarn('body_has_jsonld', 'body_html contains a JSON-LD script block — theme already emits Product + FAQPage + BreadcrumbList schemas natively. Any body_html schema creates duplicates AND risks corruption by the theme text-highlighter. Regenerate without the <script type="application/ld+json"> block.');
    // Actually PARSE the JSON-LD block(s). Google Rich Results Test flagged
    // 'Unparsable structured data' on Cetaphil because the theme's text-
    // transform highlighter injected a <span> inside our <script> block,
    // AND our own generation occasionally has trailing commas / smart quotes
    // / unescaped chars. Catching syntax errors at push time is much cheaper
    // than debugging days later via GSC. Also blocks emission of a Product
    // schema — the theme already outputs one, ours causes 'Duplicate field
    // brand' warnings when Google merges them.
    // ── DEEP JSON-LD schema validation — catch every issue Google's Rich
    // Results Test would flag, at push time. Every check here is one less
    // "why did this SKU get warned days later in GSC" mystery. Scope:
    //   • Parseability (JSON.parse must succeed)
    //   • Type inventory (FAQPage + HowTo required, Product forbidden)
    //   • FAQPage deep: mainEntity array with proper Question / Answer shape
    //   • HowTo deep: step array, totalTime ISO-8601 format
    //   • Cross-consistency with metafields (already checked below)
    const jsonLdBlocks = [...bodyHtml.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    stats.jsonld_block_count = jsonLdBlocks.length;
    let jsonLdHasProduct = false;
    let jsonLdParseError = null;
    let faqPageObj = null;
    let howToObj = null;
    for (let bi = 0; bi < jsonLdBlocks.length; bi++) {
      const raw = jsonLdBlocks[bi][1].trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const it of items) {
          const t = String(it?.['@type'] || '').toLowerCase();
          if (t === 'product') jsonLdHasProduct = true;
          if (t === 'faqpage') faqPageObj = it;
          if (t === 'howto') howToObj = it;
        }
      } catch (e) {
        jsonLdParseError = `block ${bi + 1}: ${e.message.slice(0, 120)}`;
        break;
      }
    }
    if (jsonLdParseError) {
      pushCrit('body_jsonld_unparsable', `JSON-LD in body_html failed JSON.parse (${jsonLdParseError}). Google will flag "Unparsable structured data" and drop all rich results. Common causes: (a) smart quotes / curly apostrophes instead of straight ", (b) trailing commas, (c) HTML tags leaked inside the JSON, (d) the theme injecting <span> for text-transform effects. Regenerate the block with clean straight-quoted JSON.`);
    }
    if (jsonLdHasProduct) {
      pushWarn('body_jsonld_has_product', `body_html JSON-LD includes a Product schema. The dropy.in theme already emits a Product schema with @id + shippingDetails + hasMerchantReturnPolicy + seller. Emitting our own causes Google to merge them and flag "Duplicate field \'brand\'" (seen on Cetaphil). Regenerate the block with only FAQPage + HowTo (skip Product).`);
    }
    if (jsonLdBlocks.length > 0 && !faqPageObj) {
      pushWarn('body_jsonld_missing_faq', 'body_html JSON-LD block(s) present but no FAQPage schema found. FAQPage is required per the prompt spec.');
    }
    if (jsonLdBlocks.length > 0 && !howToObj) {
      pushWarn('body_jsonld_missing_howto', 'body_html JSON-LD block(s) present but no HowTo schema found. HowTo is required per the prompt spec.');
    }
    // Deep FAQPage validation — Google requires each mainEntity to be a
    // Question with a non-empty name AND acceptedAnswer.text. Silently
    // malformed entries just get skipped in rich results.
    if (faqPageObj) {
      const me = Array.isArray(faqPageObj.mainEntity) ? faqPageObj.mainEntity : [];
      stats.faq_schema_pairs = me.length;
      if (me.length !== 10) {
        pushWarn('faqpage_count', `FAQPage schema has ${me.length} mainEntity item(s) — theme requires EXACTLY 10.`);
      }
      const seenQ = new Set();
      let badShape = 0, duplicateQ = 0, emptyA = 0;
      for (const q of me) {
        const t = String(q?.['@type'] || '').toLowerCase();
        const name = String(q?.name || '').trim();
        const answer = String(q?.acceptedAnswer?.text || '').trim();
        if (t !== 'question' || !name) { badShape++; continue; }
        if (!answer) { emptyA++; continue; }
        const norm = name.toLowerCase();
        if (seenQ.has(norm)) duplicateQ++;
        seenQ.add(norm);
      }
      if (badShape > 0) pushCrit('faqpage_bad_shape', `FAQPage has ${badShape} mainEntity item(s) missing @type=Question or non-empty name. Google will drop these from rich results.`);
      if (emptyA > 0) pushCrit('faqpage_empty_answer', `FAQPage has ${emptyA} Question(s) with empty acceptedAnswer.text. Google will drop these.`);
      if (duplicateQ > 0) pushWarn('faqpage_duplicate_q', `FAQPage has ${duplicateQ} duplicate question name(s) — Google may flag as duplicate content.`);
    }
    // Deep HowTo validation — name + step array with @type=HowToStep + text,
    // totalTime in ISO-8601 (PT#M / PT#H format).
    if (howToObj) {
      if (!String(howToObj.name || '').trim()) pushWarn('howto_no_name', 'HowTo schema missing non-empty "name" field.');
      const steps = Array.isArray(howToObj.step) ? howToObj.step : [];
      stats.howto_steps = steps.length;
      if (steps.length < 3) pushWarn('howto_too_few_steps', `HowTo has only ${steps.length} step(s). Google prefers 3+ for rich results.`);
      let badStep = 0;
      for (const s of steps) {
        const t = String(s?.['@type'] || '').toLowerCase();
        const text = String(s?.text || s?.name || '').trim();
        if (t !== 'howtostep' || !text) badStep++;
      }
      if (badStep > 0) pushCrit('howto_bad_step', `HowTo has ${badStep} step(s) missing @type=HowToStep or non-empty text. Google will drop these.`);
      const tt = String(howToObj.totalTime || '').trim();
      if (tt && !/^PT\d+(?:[HMS])/i.test(tt)) {
        pushWarn('howto_bad_totaltime', `HowTo.totalTime "${tt}" is not ISO-8601 format (should be PT2M, PT30S, PT1H etc.). Google will ignore this field.`);
      }
    }
    // body_html character-encoding sanity — mojibake / smart quotes / bad
    // encoding are silent killers: page renders but Google flags markup
    // errors or shows garbage in rich results. Catch at push time.
    if (/Ã[¢©®]|â€™|â€œ|â€|â€"|Â|â€|Ã¢â‚¬/.test(bodyHtml)) {
      pushCrit('body_mojibake', 'body_html contains mojibake (double-encoded UTF-8: Ã¢, â€™, Â, etc.). Paste-through corrupted characters — regenerate the block with clean UTF-8.');
    }
    if (/[“”‘’]/.test(bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, ''))) {
      pushWarn('body_smart_quotes_in_html', 'body_html visible content contains smart/curly quotes (' + '“ ” ‘ ’' + '). Fine for display but breaks JSON if any leaks into the schema block.');
    }
    // image_alts sanity — Google Image Search + accessibility both care.
    // Each alt should be present, distinct, and reasonable length (5-125 chars).
    if (Array.isArray(patch?.image_alts) && patch.image_alts.length > 0) {
      const alts = patch.image_alts.map(a => String(a?.alt || '').trim());
      stats.image_alt_count = alts.length;
      const short = alts.filter(a => a.length > 0 && a.length < 5).length;
      const long  = alts.filter(a => a.length > 125).length;
      const empty = alts.filter(a => a.length === 0).length;
      const dupes = alts.length - new Set(alts.filter(Boolean)).size;
      if (empty > 0) pushWarn('image_alt_empty', `image_alts has ${empty} empty entry(ies). Every image should describe its content.`);
      if (short > 0) pushWarn('image_alt_short', `image_alts has ${short} entry(ies) under 5 chars — too short to be useful for Image Search or screen readers.`);
      if (long > 0)  pushWarn('image_alt_long',  `image_alts has ${long} entry(ies) over 125 chars — Google may truncate; keep alt text tight.`);
      if (dupes > 0) pushWarn('image_alt_duplicate', `image_alts has ${dupes} duplicate alt text(s). Every image should describe what's distinct about it.`);
    }
    // External-links sanity — every non-dropy.in <a> must be rel="nofollow
    // noopener" (Lighthouse + SEO). Also flag fabricated citation domains.
    const anchorTags = bodyHtml.match(/<a\b[^>]*>/gi) || [];
    let extNoRel = 0, badCitation = 0;
    const CITATION_ALLOWED = /(?:dermnetnz\.org|aad\.org|pubmed\.ncbi\.nlm\.nih\.gov|schema\.org)/i;
    for (const tag of anchorTags) {
      const hm = tag.match(/href=["']([^"']+)["']/i);
      if (!hm) continue;
      const href = hm[1];
      if (!/^https?:\/\//i.test(href)) continue;
      if (/dropy\.in/i.test(href)) continue;
      // External link — must have nofollow + noopener
      if (!/rel=["'][^"']*(nofollow|noopener)/i.test(tag)) extNoRel++;
      // Guard against Claude inventing article paths on citation sites —
      // /search?q= paths on dermnetnz/aad/pubmed always resolve; deeper
      // paths often 404. Warn only, not critical.
      if (CITATION_ALLOWED.test(href) && !/[?&]q=|\/search/i.test(href)) badCitation++;
    }
    if (extNoRel > 0) pushWarn('body_external_no_rel_deep', `body_html has ${extNoRel} external anchor(s) without rel="nofollow noopener" — Lighthouse Best Practices flags, and PageRank leaks to competitors.`);
    if (badCitation > 0) pushWarn('body_citation_deep_path', `body_html has ${badCitation} citation link(s) using a specific path instead of a /search?q= URL — Claude may have fabricated the article path. Verify each 200s.`);
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
    // Competitor brand names in copy. Filter out the product's OWN vendor —
    // Cetaphil's page must say "Cetaphil" in prose (product name, brand story,
    // range comparisons). Live push showed this fire as a false positive:
    // vendor=Cetaphil + cetaphil.com in top SERPs → 'cetaphil' added to
    // competitorBrands → own brand rejected as competitor.
    const ownVendor = String(context.ownVendor || '').toLowerCase().trim();
    const seenBrands = new Set();
    for (const brand of (Array.isArray(context.competitorBrands) ? context.competitorBrands : [])) {
      if (!brand || brand.length < 3) continue;
      const brandLc = brand.toLowerCase();
      // Skip if this brand IS the product's own vendor (case-insensitive).
      // Also skip substring matches — 'always' would falsely match 'always maxi'.
      if (ownVendor && (brandLc === ownVendor || ownVendor.includes(brandLc) || brandLc.includes(ownVendor))) continue;
      // Dedupe — earlier code passed some competitor lists with the same brand
      // twice (e.g. once from vendor SERP hit, once from marketplace SERP hit),
      // producing duplicate critical entries.
      if (seenBrands.has(brandLc)) continue;
      seenBrands.add(brandLc);
      const rx = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      // Allow the brand in JSON-LD (schema.org "brand" field is OUR brand);
      // reject in prose. Rough heuristic: strip <script>...</script> before check.
      const prose = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ');
      if (rx.test(prose)) pushCrit(`competitor_brand_${brandLc}`, `body_html mentions competitor brand "${brand}" in copy`);
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

  // ─── FAQ count enforcement ────────────────────────────────────
  // Storefront theme has 10 FAQ slots (custom.f_q_question_1..10 +
  // custom.f_q_answer_1..10). If Claude sends fewer, the storefront
  // shows a mix of new + stale entries; the fan-out step will blank
  // the missing ones but the operator wants 10 distinct new FAQs
  // for long-tail keyword coverage. Enforce hard 10 minimum.
  const faqsBlock = String(patch?.metafields?.['custom.faqs'] || '');
  if (faqsBlock) {
    const faqPairs = (faqsBlock.match(/<details\b[^>]*>[\s\S]*?<\/details>/gi) || []).length;
    stats.faq_pairs = faqPairs;
    if (faqPairs < 10) {
      pushCrit('faq_count_below_10', `custom.faqs has ${faqPairs} <details> pair(s) — theme requires EXACTLY 10 slots. Ask Claude to add ${10 - faqPairs} more distinct Q&A pair(s) and re-paste (use different angles: usage frequency, storage, allergy, comparison with size N±1, post-partum, price/COD, etc.).`);
    }
    if (faqPairs > 10) {
      pushWarn('faq_count_above_10', `custom.faqs has ${faqPairs} <details> pair(s) — only the first 10 land in theme slots; extras are dropped.`);
    }
    // Cross-check schema JSON-LD count if body_html has FAQPage
    const bodyHtmlStr = String(patch?.body_html || '');
    const faqPageM = bodyHtmlStr.match(/"@type"\s*:\s*"FAQPage"[\s\S]*?"mainEntity"\s*:\s*\[([\s\S]*?)\]/i);
    if (faqPageM) {
      const questionCount = (faqPageM[1].match(/"@type"\s*:\s*"Question"/gi) || []).length;
      stats.faq_schema_pairs = questionCount;
      if (questionCount !== faqPairs) {
        pushWarn('faq_schema_mismatch', `custom.faqs has ${faqPairs} pair(s) but FAQPage JSON-LD has ${questionCount} — mismatch may trigger Google rich-result flag. Regenerate both from the same list.`);
      }
    }
  } else if (patch?.metafields && ('custom.faqs' in patch.metafields || Object.keys(patch.metafields).some(k => k.startsWith('custom.faq_q_')))) {
    // metafields object exists but custom.faqs is empty — Claude sent
    // per-question keys directly (older schema) OR blanked the field.
    pushCrit('faqs_metafield_empty', 'custom.faqs is empty in the payload — theme needs 10 FAQ pairs. Ask Claude to fill the consolidated custom.faqs block.');
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
-- Cross-batch duplicate check (Q.existsActiveUrl) runs once per uploaded
-- SKU. Without this the planner falls back to jobs_status_idx and, because
-- status has only four distinct values, effectively scans every 'done' job
-- for every row being uploaded — making bulk upload O(rows x table).
-- Measured on 50k existing jobs / 2000 new SKUs: 9829 ms -> 8 ms.
CREATE INDEX IF NOT EXISTS jobs_product_url_idx ON jobs (product_url, status);

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
-- No keywords(batch_id) index: UNIQUE (batch_id, product_url, keyword)
-- already creates one with batch_id leftmost, which the planner uses for
-- batch lookups (and as a covering index for COUNT). A second index only
-- added write cost on the highest-volume insert path in the system.
DROP INDEX IF EXISTS keywords_batch_idx;

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

-- Per-worker command acks. Fixes the broadcast bug where one worker's ack
-- consumed the command for all others. Every (command_id, worker_id) row
-- proves that specific worker saw + processed that specific command.
-- pendingCommands excludes commands already in this table for the polling
-- worker.
CREATE TABLE IF NOT EXISTS worker_command_acks (
  command_id INTEGER NOT NULL,
  worker_id  TEXT NOT NULL,
  acked_at   INTEGER DEFAULT (strftime('%s','now')*1000),
  PRIMARY KEY (command_id, worker_id)
);

CREATE TABLE IF NOT EXISTS worker_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT,               -- JSON blob of pushed run options
  active_batch_id TEXT
);
INSERT OR IGNORE INTO worker_config (id, config, active_batch_id) VALUES (1, '{}', NULL);

-- Shopify push history — one row per successful /api/shopify/update-product
-- call. Snapshot_json is the CURRENT product state we fetched right before
-- the PUT, so revert works by PUTting the snapshot back. Patch_json is what
-- Claude proposed (post-allowlist-strip) so we have audit trail of what
-- changed. Kept indefinitely on this small store; add cleanup later if size
-- becomes a concern.
CREATE TABLE IF NOT EXISTS shopify_push_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,
  product_url   TEXT,
  sku           TEXT,
  batch_id      TEXT,             -- which analytics batch drove this push (nullable)
  pushed_at     INTEGER NOT NULL, -- Date.now()
  pushed_by     TEXT,             -- operator identifier if we ever add auth
  snapshot_json TEXT NOT NULL,    -- allowlisted fields' PREVIOUS values, JSON
  patch_json    TEXT NOT NULL,    -- fields we actually sent to Shopify, JSON
  reverted_at   INTEGER           -- Date.now() if this snapshot was later restored
);
CREATE INDEX IF NOT EXISTS idx_push_history_product ON shopify_push_history(product_id, pushed_at DESC);
`);

// Additive migration for older DBs (workers table exists without the new cols).
try { db.exec(`ALTER TABLE workers ADD COLUMN mac_address TEXT`); } catch {}
try { db.exec(`ALTER TABLE workers ADD COLUMN hostname TEXT`); } catch {}
// Worker-side extension version hash — reported on heartbeat. Manager
// compares against its current WORKER_FILES hash to flag out-of-date
// installs on the Fleet UI. Extension re-install picks up updates.
try { db.exec(`ALTER TABLE workers ADD COLUMN version_hash TEXT`); } catch {}
try { db.exec(`ALTER TABLE workers ADD COLUMN version_reported_at INTEGER`); } catch {}

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
const MAX_BODY_BYTES = 60 * 1024 * 1024;
// Accumulate BUFFERS and decode once at the end. The previous version did
// `buf += chunk`, which calls chunk.toString('utf8') per chunk — so any
// multi-byte character straddling a chunk boundary decoded as two U+FFFD
// replacement chars. JSON.parse still succeeded, so the corruption was
// silent. That hits every non-ASCII product name and keyword (Devanagari
// especially, at 3 bytes/char), which is most of this product's data.
// Chunk boundaries only land mid-character on large bodies, which is
// exactly what the keyword-push endpoint sends.
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', c => {
      bytes += c.length;                  // byte length, not string length
      if (bytes > MAX_BODY_BYTES) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
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
  releaseStale: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL WHERE status='claimed' AND (heartbeat_at IS NULL OR heartbeat_at < ?) AND attempts < 3`),
  // Auto-fail jobs that have retried too many times so the worker stops
  // hammering them and moves to fresh SKUs. Runs alongside releaseStale.
  // Fires on jobs still 'claimed' with a stale heartbeat AND attempts >= 3
  // — same predicate as releaseStale except the attempts branch. Reason
  // string surfaces on the dashboard's failure column so the operator
  // knows this was a retry-loop bail-out, not a real error signal.
  // NOTE: every requeue/reset path MUST also set attempts=0. claimById
  // increments attempts on each claim and this predicate auto-fails at >= 3,
  // so a requeue that leaves the counter alone puts the job straight back
  // into 'failed' on its very next claim — the button appears to work and
  // silently changes nothing. That loop is what drove one live SKU to 24
  // attempts.
  failMaxAttempts: db.prepare(`UPDATE jobs SET status='failed', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=?, failed_reason='auto-failed: exceeded 3 attempts (retry loop). Fix the root cause and requeue.' WHERE status='claimed' AND (heartbeat_at IS NULL OR heartbeat_at < ?) AND attempts >= 3`),
  // Second-tier force-fail — no stale heartbeat required. Fires when a
  // job has been claimed 5+ times AND the CURRENT claim has been active
  // for >= 15 min without completing. Original version (3cbf5da) only
  // checked attempts >= 5, but that force-failed IMMEDIATELY on the next
  // claim — worker had no chance to complete, and any actual work done
  // during that claim was silently orphaned (worker kept processing,
  // manager already released the claim). Adding the claimed_at >= 15m
  // ago condition ensures the current claim gets a fair shot before
  // being yanked. Fresh claims (< 15 min old) are always safe from
  // force-fail, even if the historical attempts count is high.
  // failStuckClaims — force-fails jobs stuck in a retry loop. Requires
  // BOTH attempts>=5 AND (stale heartbeat OR very old claim). Previous
  // version (7f1e3f4) killed on 15-min claim age alone, which caught
  // legitimate slow SKUs (many products need 15-25 min for full R1+R2
  // + Amazon Round). Now needs one of:
  //   (a) heartbeat gone stale (worker died or SW abandoned) — the real
  //       retry-loop signal, OR
  //   (b) claim age > 30 min (extreme case — no legitimate SKU should
  //       hold a claim that long)
  // Fresh claims with healthy heartbeats always survive regardless of
  // historic attempts count.
  failStuckClaims: db.prepare(`UPDATE jobs SET status='failed', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=?, failed_reason='auto-failed: attempts >= 5 AND (stale heartbeat OR claim age > 30 min) — worker abandoned or genuinely stuck. Fix worker + requeue.' WHERE status='claimed' AND attempts >= 5 AND ((heartbeat_at IS NULL OR heartbeat_at < ?) OR (claimed_at IS NOT NULL AND claimed_at < ?))`),
  // Retry-loops diagnostic — surface every job with attempts >= 3 so the
  // operator sees which SKUs are stuck. done_at is populated when a job
  // was auto-failed, so we can distinguish 'still in flight but retried a
  // lot' from 'already gave up'.
  retryLoops: db.prepare(`SELECT id, batch_id, sku, product_name, product_url, status, attempts, claimed_at, heartbeat_at, done_at, failed_reason FROM jobs WHERE attempts >= 3 ORDER BY attempts DESC, id DESC`),
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
  updateJobStatus:   db.prepare(`UPDATE jobs SET status=?, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=NULL, failed_reason=NULL, attempts=0 WHERE id=?`),
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
      claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=NULL, failed_reason=NULL, attempts=0
    WHERE status='done' AND NOT EXISTS
      (SELECT 1 FROM keywords k WHERE k.batch_id=jobs.batch_id AND k.product_url=jobs.product_url)
    AND (? IS NULL OR batch_id=?)`),
  /* Reset a single job (by id) back to pending. Same shape as above but
     one-shot — used by the low-yield requeue helper which iterates a
     targeted list of jobs whose row count fell below the threshold. */
  resetJobToPending: db.prepare(`UPDATE jobs SET status='pending',
      claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, done_at=NULL, failed_reason=NULL, attempts=0
    WHERE id=?`),
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
  // Per-worker pending commands. Two clauses:
  //  (a) targeted (worker_id=?): pending as long as global acknowledged_at
  //      is null AND this worker hasn't personally acked. (Legacy check kept
  //      for backward compat with old commands.)
  //  (b) broadcast (worker_id IS NULL): pending as long as this worker
  //      hasn't personally acked, ignoring global acknowledged_at
  //      (which used to consume the broadcast for all other workers when
  //      the first one acked — the bug we're fixing).
  // Broadcast TTL: 10 min (created_at > now-10min). Anything older is
  // considered stale — workers not online during the window miss it.
  pendingCommands: db.prepare(`SELECT * FROM worker_commands wc
    WHERE (
      (wc.worker_id = ?1 AND wc.acknowledged_at IS NULL)
      OR (wc.worker_id IS NULL AND wc.created_at > ?2)
    )
    AND NOT EXISTS (SELECT 1 FROM worker_command_acks a WHERE a.command_id = wc.id AND a.worker_id = ?1)
    ORDER BY wc.id ASC`),
  ackCommand: db.prepare(`UPDATE worker_commands SET acknowledged_at=?, acknowledged_by=? WHERE id=? AND acknowledged_at IS NULL`),
  ackCommandPerWorker: db.prepare(`INSERT OR IGNORE INTO worker_command_acks (command_id, worker_id, acked_at) VALUES (?, ?, ?)`),
  getConfig: db.prepare(`SELECT config, active_batch_id FROM worker_config WHERE id=1`),
  setConfig: db.prepare(`UPDATE worker_config SET config=? WHERE id=1`),
  setActiveBatch: db.prepare(`UPDATE worker_config SET active_batch_id=? WHERE id=1`),
  requeue: db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL, attempts=0 WHERE id=?`),
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
  requeueAllFailed:      db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL, attempts=0 WHERE status='failed'`),
  requeueBatchFailed:    db.prepare(`UPDATE jobs SET status='pending', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL, attempts=0 WHERE status='failed' AND batch_id=?`),
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
  // ETA support — row landings in the last N minutes for the given batch.
  // Used by /api/batches/eta to compute rate + trend + projected finish.
  keywordsRateBatch: db.prepare(`SELECT COUNT(*) AS n FROM keywords WHERE batch_id=? AND created_at >= ?`),
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
  listWorkers: db.prepare(`SELECT worker_id, first_seen, last_seen, mac_address, hostname, version_hash, version_reported_at FROM workers ORDER BY last_seen DESC`),
  setWorkerVersion: db.prepare(`UPDATE workers SET version_hash=?, version_reported_at=? WHERE worker_id=?`),
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
    let target = path.join(BACKUP_DIR, `adbrain-${ts}.db`);
    // The stamp only has 1-second resolution, and VACUUM INTO refuses to
    // overwrite. Two backups in the same second (dev restarts, tests) would
    // otherwise fail with 'output file already exists'.
    for (let n = 2; fs.existsSync(target); n++) {
      target = path.join(BACKUP_DIR, `adbrain-${ts}-${n}.db`);
    }
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
    // Only if we don't already have a recent snapshot. The supervisor
    // restarts the manager on every file save, and this used to fire a full
    // copy of the DB each time — three restarts inside two minutes wrote
    // 312 MB of near-identical backups and evicted the genuinely old ones
    // from the keep-N window. A backup younger than the normal interval is
    // as good as one taken right now.
    const newest = listBackups()[0];
    const age = newest ? Date.now() - newest.mtime : Infinity;
    if (age < BACKUP_INTERVAL_MS) {
      console.log(`[manager] Startup backup skipped — ${Math.round(age / 60000)} min old snapshot already exists (${newest.name}).`);
      return;
    }
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

// Cheap version-hash covering the current WORKER_FILES bundle. Cached for
// 5s so the workers-list endpoint (polled every 3-10s) doesn't stat every
// file on every dashboard tick. Recomputes when any file's mtime changes.
// Used to flag out-of-date extensions on the Fleet UI — workers report
// their own loaded hash on heartbeat; when they diverge, the operator
// gets a badge saying 'update available'.
let _managerVersionCache = { at: 0, data: null };
// Shopify shop-policies cache — /policies.json is hit on every Shopify-update
// modal open for the 'echo store shipping/return language' prompt block.
// TTL 10 min; resets on server restart.
let _policyCache = { at: 0, data: null };
// Git commit this process was booted with. Captured ONCE at module load
// — never refreshed. The dashboard compares this against the current
// git HEAD (which /api/manager/version fetches live) so it can detect
// 'server code on disk changed but the process wasn't restarted' and
// prompt the user to restart. Without this we have no way to distinguish
// deployed-code from running-code and users get stale-behavior confusion
// (a fix landed in git but the running server still returns old shape).
let _bootCommit = null;
try {
  const { execSync } = require('child_process');
  _bootCommit = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* not a git repo — leave null; dashboard treats null as 'unknown' and doesn't alarm */ }
function currentManagerVersion() {
  const now = Date.now();
  if (now - _managerVersionCache.at < 30000 && _managerVersionCache.data) return _managerVersionCache.data;
  const { execSync } = require('child_process');
  const repoRoot = path.join(__dirname, '..');
  let data = { ok: true, commit: '(no git)', subject: '', committed_at: null, branch: '', dirty: false };
  try {
    const gitOpts = { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] };
    data.commit    = execSync('git rev-parse --short HEAD',              gitOpts).trim();
    data.subject   = execSync('git log -1 --format=%s',                  gitOpts).trim();
    data.committed_at = Number(execSync('git log -1 --format=%ct',       gitOpts).trim()) * 1000;
    data.branch    = execSync('git rev-parse --abbrev-ref HEAD',         gitOpts).trim();
    data.dirty     = execSync('git status --porcelain',                  gitOpts).trim().length > 0;
  } catch { /* leave defaults */ }
  _managerVersionCache = { at: now, data };
  return data;
}
let _workerBundleHashCache = { at: 0, hash: '0000000000000000' };
// Hashes the CONTENT of every worker file.
//
// This used to hash mtime+size, which broke the feature two ways. It made
// the hash change on any git checkout that rewrote identical bytes, and —
// far worse — a worker could not reproduce it, because a browser extension
// cannot see the mtime of its own files. So the worker "reported its
// version" by fetching THIS endpoint and echoing the manager's own hash
// back, which made hash_mismatch a tautology that could never be true. The
// fleet showed outdated=false for every worker while they ran old code.
//
// Content hashing is reproducible on both sides, so the comparison finally
// means something. Both sides must build the string identically:
//   sha256( "<rel>:<sha256hex(bytes)>" joined by "|" ).slice(0, 16)
function currentWorkerBundleHash() {
  const now = Date.now();
  if (now - _workerBundleHashCache.at < 5000) return _workerBundleHashCache.hash;
  const parts = [];
  for (const rel of WORKER_FILES) {
    try {
      const bytes = fs.readFileSync(path.join(__dirname, '..', rel));
      parts.push(`${rel}:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    } catch { parts.push(`${rel}:MISSING`); }
  }
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  _workerBundleHashCache = { at: now, hash };
  return hash;
}

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
$mgrTok = '${psEscape(currentToken)}'   # empty when manager has no token; watchdog auto-update uses this
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
    # Two-step download to sidestep Windows PowerShell 5.1's IWR -OutFile
    # misbehaving on .js content (adding a UTF-8 BOM or performing LF→CRLF
    # conversion) which caused Chrome MV3 to fail SW registration with
    # 'Status code: 15' after a fresh install.
    #
    # Use RawContentStream.ToArray() to get the raw byte payload — NOT
    # $resp.Content, which PS decodes to a string for text/* responses
    # (and WriteAllBytes then rejects the string arg, silently caught
    # here, leaving the extension dir empty except for worker-config.json).
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$mgr/worker/$f" -ErrorAction Stop
    $bytes = $resp.RawContentStream.ToArray()
    [System.IO.File]::WriteAllBytes($out, $bytes)
    # Sanity-check: reject empty writes and known-bad first bytes (BOM).
    if ((Get-Item $out).Length -eq 0) { throw "empty file downloaded" }
    if ($f -like '*.js' -or $f -like '*.mjs' -or $f -like '*.json') {
      if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        # Strip BOM in place — Chrome MV3 rejects BOM in ES modules.
        [System.IO.File]::WriteAllBytes($out, $bytes[3..($bytes.Length - 1)])
      }
    }
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
  $wdBody = $wdBody -replace '__TOKEN__',   ($mgrTok -replace "'","''")
  Set-Content -Path $watchdogPath -Value $wdBody -Encoding UTF8

  # Seed the local bundle-hash file with the manager's CURRENT hash so
  # the very next watchdog run doesn't false-positive 'update needed'
  # and re-download every file we just fetched during install. Written
  # to \$prof so it lives alongside profile data (not extension files).
  try {
    $hashFileInit = Join-Path $prof '.adbrain-bundle-hash'
    $hashResp = Invoke-WebRequest -UseBasicParsing -Uri "$mgr/api/worker/version-hash" -TimeoutSec 4 -ErrorAction Stop
    $hashJson = $hashResp.Content | ConvertFrom-Json
    if ($hashJson.hash) {
      if (-not (Test-Path $prof)) { New-Item -ItemType Directory -Path $prof -Force | Out-Null }
      Set-Content -Path $hashFileInit -Value $hashJson.hash -Encoding UTF8
    }
  } catch { }

  $taskName = 'AdBrain Chrome Watchdog'
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  $tAction    = New-ScheduledTaskAction    -Execute 'powershell.exe' -Argument ('-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + $watchdogPath + '"')
  $tTrigger   = New-ScheduledTaskTrigger   -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::FromDays(3650))
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
// Ctx bag passed into every handler under the route table. Individual
// modules destructure only what they need; nothing here is hot-path
// enough to matter. Kept in one place so route modules never need to
// reach for closures declared far above.
// Reclaim disk after a mass delete. SQLite marks freed pages reusable but
// never returns them to the filesystem, and the WAL keeps growing until
// something checkpoints it — so a DB that had been wiped down to ~150 KB of
// live rows was still occupying 116 MB on disk with a 17 MB WAL. Must run
// OUTSIDE a transaction (VACUUM cannot run inside one), so callers invoke
// this after COMMIT. Best-effort: a failure here is not worth failing the
// user's delete over.
// The checkpoint AFTER the VACUUM is the one that matters. VACUUM rebuilds
// the entire database, and in WAL mode every one of those pages is written
// to the write-ahead log first — so vacuuming a 121 MB file grew the WAL to
// 113 MB and left MORE total bytes on disk than before. Checkpointing only
// beforehand (as this did originally) reclaims nothing. Do both: before, so
// VACUUM sees a clean state; after, to fold the rebuild back into the main
// file and truncate the log.
function reclaimSpace() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.exec('VACUUM'); } catch (e) {
    console.error('[manager] VACUUM after delete failed (non-fatal):', e.message);
  }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {
    console.error('[manager] post-VACUUM WAL checkpoint failed (non-fatal):', e.message);
  }
}

const routerCtx = {
  db, Q,
  send, readJson, now,
  reclaimSpace,
  currentManagerVersion,
  bootCommit: _bootCommit,
  runBackup, listBackups,
  currentWorkerBundleHash, sendWolPacket,
  claimJobs, shopifyRequest,
  resolveMetafieldTarget, stripToShopifyAllowlist, validateShopifyPatch,
  extractShopifyHandle, extractReviewSignals,
  SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
  SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST,
  // Shared by reference — routes/shopify.js mutates .at/.data, never reassigns.
  _policyCache,
  BACKUP_KEEP_N, BACKUP_DIR,
};
const router = createRouter();
healthRoutes.register(router);
activityRoutes.register(router);
commandsRoutes.register(router);
configRoutes.register(router);
backupsRoutes.register(router);
destructiveRoutes.register(router);
workersRoutes.register(router);
keywordsRoutes.register(router);
batchesRoutes.register(router);
jobsRoutes.register(router);
jobsUploadRoutes.register(router);
shopifyRoutes.register(router);

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
  // Worker-side version detection. Returns a hash covering the current
  // WORKER_FILES bundle. When a worker's cached hash != this hash, it
  // means the manager has newer extension files than what's loaded in
  // Chrome and the operator needs to re-run install-worker.ps1 on that
  // PC. Cheap: reads all mtimes (already cached for assetVersion) and
  // hashes them. Recomputed on every request but the mtime lookups are
  // fast + cached by the OS.
  if (m === 'GET' && p === '/api/worker/version-hash') {
    return send(res, 200, { ok: true, hash: currentWorkerBundleHash(), file_count: WORKER_FILES.length });
  }
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
      // Explicit charset on JS + a Content-Length so PowerShell's
      // Invoke-WebRequest downloads as raw bytes without re-encoding
      // (Windows PowerShell 5.1 has been observed to insert a UTF-8
      // BOM or convert LF→CRLF on downloads whose Content-Type omits
      // charset, which causes Chrome MV3 to fail SW registration with
      // 'Status code: 15' on the reinstalled extension).
      const type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css'
        : ext === '.json' ? 'application/json'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  if (p.startsWith('/api/') && !tokenOk(req, url)) return send(res, 401, { ok: false, error: 'bad or missing token' });

  try {
    // Route table first — small handler modules under routes/. If a
    // route matches, the module already sent the response; fall through
    // to the legacy if-ladder below for un-migrated sections.
    if (await router.dispatch(req, res, url, routerCtx)) return;

    // SKU/Excel upload + bulk mutate — see routes/jobs-upload.js.
    // Queue core: claim / heartbeat / done / requeue / CRUD / reporting
    // — see routes/jobs.js.
    // Keywords, batch names — see routes/keywords.js.

    // Activity, Commands, Config, delete-batch — see routes/*.js (registered above).

    // Shopify integration — see routes/shopify.js.

    return send(res, 404, { ok: false, error: 'no such route' });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});

// Crash safety. This process is meant to be always-on, and the whole fleet
// stalls when it dies: workers can't claim, heartbeat, or push results.
// Node's default for an unhandled rejection is to terminate, so a single
// missed `.catch()` anywhere would take the manager down. Log loudly and
// stay up — a manager serving 95% of routes beats a dead one. A genuinely
// corrupt process is still caught by the supervisor's health check.
process.on('unhandledRejection', (reason) => {
  console.error('[manager] UNHANDLED REJECTION (staying up):', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[manager] UNCAUGHT EXCEPTION (staying up):', err && err.stack || err);
});
// Flush WAL and close cleanly so we never leave a hot journal behind.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[manager] ${sig} — checkpointing WAL and shutting down.`);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`[manager] AdBrain SQLite manager on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
  console.log(`[manager] Dashboard: http://<this-tailscale-name>:${PORT}/`);
  console.log(TOKEN ? '[manager] MANAGER_TOKEN set — clients must send X-Manager-Token.' : '[manager] No token — relying on Tailscale for access control.');
});
