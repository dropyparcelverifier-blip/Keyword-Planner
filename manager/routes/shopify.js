// Shopify Admin API integration — read a product, audit its live storefront
// page, propose a patch, validate it, push it, and revert it.
//
// Everything here is operator-driven from the Shopify modal in the dashboard,
// not part of the worker pipeline. It is isolated in its own module because
// it is the only part of the manager that makes outbound HTTPS calls, and
// because a Shopify outage must not be able to affect queue mechanics.
//
// Two safety rails run on every write path:
//   · stripToShopifyAllowlist / SHOPIFY_ALLOWED_FIELDS — an LLM-authored
//     patch can only ever touch fields we explicitly permit.
//   · validateShopifyPatch — structural + length checks before anything
//     reaches the Admin API, so a malformed suggestion fails locally with a
//     readable error rather than as a 422 from Shopify.
// Every push is recorded in shopify_push_history so /revert can restore the
// previous value.
'use strict';

// GraphQL string-literal values here are always meant to be a SKU/ASIN/
// barcode (alphanumeric + hyphen). Stripping to that allowlist — rather
// than just removing `"` — closes off query-syntax injection (backslash
// escapes, colons, `OR`/parentheses) into Shopify's search query string.
function _gqlSafeValue(v) {
  return String(v == null ? '' : v).replace(/[^a-zA-Z0-9-]/g, '');
}

  // ---------- Shopify integration ----------
  // Returns the field-impact hierarchy (what carries most SEO/CTR weight).
  // UI uses this to render a priority list; the Claude prompt inlines it too.
  // Diagnostic endpoint: run the SAME GraphQL lookup as the bulk
  // upload for ONE SKU, and return the raw request + response so
  // the user can see exactly what Shopify is doing. Solves the
  // 'why is every SKU resolving to CLEARSTEM' debug loop.
async function debugLookup({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
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
      const quoted = `${field}:\\"${_gqlSafeValue(value)}\\"`;
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
        products(first: 3, query: "handle:*${_gqlSafeValue(asinLower)}*") {
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

async function fieldImpact({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    return send(res, 200, { ok: true, fields: SHOPIFY_FIELD_IMPACT, allowlist: [...SHOPIFY_ALLOWED_FIELDS] });
}

  // Diagnostic: dump every product-level metafield definition on the store
  // + show which alias (if any) our resolver would map each to. Answers
  // 'why are metafields still blank after push' by making the namespace
  // mismatch visible in one place.
async function metafieldDefinitions({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    const cfgRow = Q.getConfig.get();
    const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
    const shop = cfg.shopify || {};
    const apiVer = shop.apiVersion || '2024-10';
    const r = await shopifyRequest({
      shopDomain: shop.shopDomain, adminToken: shop.adminToken,
      method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
      body: { query: `{ metafieldDefinitions(first: 200, ownerType: PRODUCT) { edges { node { namespace key name type { name } description } } } }` },
    });
    if (!r.ok) return send(res, r.status || 502, { ok: false, error: `Shopify GraphQL: ${JSON.stringify(r.error)}` });
    const defs = (r.data?.data?.metafieldDefinitions?.edges || []).map(e => ({
      namespace: e.node.namespace, key: e.node.key, name: e.node.name,
      type: e.node.type?.name || null, description: e.node.description || null,
    }));
    // Cross-reference against our alias table so it's obvious which
    // definitions would be writable vs skipped.
    const resolution = Object.keys(SHOPIFY_METAFIELD_ALIASES).map(alias => {
      const target = resolveMetafieldTarget(alias, defs);
      return {
        alias,
        would_write_to: target ? `${target.namespace}.${target.key}` : null,
        resolved_via:   target ? target.resolvedVia : 'NO MATCH — would be skipped',
      };
    });
    return send(res, 200, { ok: true, definitions: defs, alias_resolution: resolution });
}

  // Fetch the store's shop-level policy pages (shipping, refund, privacy,
  // TOS) via Shopify Admin API. Returns strippped-plain-text body so the
  // Claude prompt can echo the store's ACTUAL policy language verbatim
  // instead of Claude inventing generic 'pan-India shipping' phrasing
  // that may contradict what's on /policies/shipping-policy.
  //
  // Results are cached in-memory for 10 minutes — policies rarely change
  // + this endpoint is hit on every Shopify-update modal open.
async function getPolicies({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    // Module-level cache (declared near top of file). Cheap + resets on
    // restart. Prevents hitting Shopify's /policies.json every modal open.
    if (now() - _policyCache.at < 10 * 60 * 1000 && _policyCache.data) return send(res, 200, _policyCache.data);
    const cfgRow = Q.getConfig.get();
    const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
    const shop = cfg.shopify || {};
    const apiVer = shop.apiVersion || '2024-10';
    const r = await shopifyRequest({
      shopDomain: shop.shopDomain, adminToken: shop.adminToken,
      method: 'GET', apiPath: `/admin/api/${apiVer}/policies.json`,
    }).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) return send(res, r.status || 502, { ok: false, error: `Shopify policies API: ${JSON.stringify(r.error)}` });
    // Strip HTML → readable plain text. Rough but good enough for a prompt.
    const strip = html => String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const policies = (r.data?.policies || []).map(p => ({
      title: p.title || '',
      handle: p.handle || '',            // shipping-policy / refund-policy / privacy-policy / terms-of-service
      url: p.url || '',
      body: strip(p.body || '').slice(0, 6000),  // cap at 6KB per policy to keep prompt tight
      updated_at: p.updated_at || null,
    }));
    const data = { ok: true, policies, fetched_at: now() };
    _policyCache.at = now();
    _policyCache.data = data;
    return send(res, 200, data);
}

  // GET current product from Shopify by URL. Extracts the handle, calls
  // /admin/api/2024-10/products.json?handle=… . Returns the current
  // title, body_html, tags, vendor, product_type, handle, SEO meta,
  // Live-page audit — fetch the rendered product HTML from the public
  // storefront (not Admin), extract every JSON-LD block, and run the same
  // deep validation we do at push time PLUS duplicate-schema detection.
  // Mirrors what Google Rich Results Test does. Runs post-push (auto-
  // triggered ~5s after a successful update-product) so the operator sees
  // whether the theme's schemas + ours combine into a clean rich-results
  // eligible page — or if we've caused Duplicate-brand / Unparsable-data
  // errors. Read-only, no Shopify creds needed (public URL fetch).
async function auditLivePage({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    const auditUrl = new URL(req.url, 'http://x');
    const targetUrl = auditUrl.searchParams.get('url') || '';
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return send(res, 400, { ok: false, error: 'url query param required (must be http/https)' });
    }
    // Fetch the public storefront HTML. No creds. Follow redirects (handle
    // drift protection). Timeout 12s — Shopify page usually served in <2s.
    let html;
    let finalUrl = targetUrl;
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 12_000);
      const resp = await fetch(targetUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'AdBrain-Audit/1.0 (compatible; Googlebot fingerprint)' },
      });
      clearTimeout(to);
      finalUrl = resp.url || targetUrl;
      if (!resp.ok) return send(res, 502, { ok: false, error: `fetch failed: HTTP ${resp.status}`, fetched_url: finalUrl });
      html = await resp.text();
    } catch (e) {
      return send(res, 502, { ok: false, error: `fetch error: ${e.message}` });
    }
    // Extract every JSON-LD block from the rendered HTML.
    const blockRegex = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
    const raw = [...html.matchAll(blockRegex)].map((m2) => m2[1]);
    const blocks = [];
    const typeCounts = {};
    const critical = [];
    const warnings = [];
    for (let i = 0; i < raw.length; i++) {
      const text = raw[i].trim();
      const entry = { index: i, length: text.length, parsed: false, types: [], error: null };
      if (!text) { entry.error = 'empty block'; blocks.push(entry); continue; }
      try {
        const obj = JSON.parse(text);
        entry.parsed = true;
        const items = Array.isArray(obj) ? obj : [obj];
        for (const it of items) {
          const t = String(it?.['@type'] || 'Unknown');
          entry.types.push(t);
          typeCounts[t] = (typeCounts[t] || 0) + 1;
        }
        entry.raw = items;
      } catch (e) {
        entry.error = `JSON.parse failed: ${e.message.slice(0, 200)}`;
        // Peek at the leading chars — surfaces the theme's <span> injection
        // that broke Cetaphil.
        const peek = text.slice(0, 150).replace(/\s+/g, ' ');
        entry.peek = peek;
        critical.push({
          id: 'unparsable_jsonld',
          message: `Block ${i + 1} is unparsable — Google will flag "Unparsable structured data" and drop ALL rich results from this page. First 150 chars: ${peek}`,
        });
      }
      blocks.push(entry);
    }
    // Duplicate-type detection — Google merges duplicates and flags
    // 'Duplicate field X'. Common on Shopify: theme + our push both emit
    // Product or both emit BreadcrumbList.
    for (const [t, n] of Object.entries(typeCounts)) {
      if (n > 1) {
        warnings.push({
          id: 'duplicate_schema_type',
          message: `${n} copies of ${t} schema found on the page. Google typically merges them and flags "Duplicate field X". If Product is duplicated, the theme is emitting one AND our push is emitting one — regenerate our block without Product.`,
        });
      }
    }
    // Deep validation of each type — same rules as push-time preflight.
    const faq = blocks.flatMap(b => b.raw || []).find(o => String(o?.['@type']).toLowerCase() === 'faqpage');
    if (faq) {
      const me = Array.isArray(faq.mainEntity) ? faq.mainEntity : [];
      if (me.length !== 10) warnings.push({ id: 'faqpage_count', message: `Live FAQPage has ${me.length} entries — theme requires exactly 10.` });
      const seen = new Set();
      let bad = 0, empty = 0, dup = 0;
      for (const q of me) {
        const name = String(q?.name || '').trim();
        const answer = String(q?.acceptedAnswer?.text || '').trim();
        if (!name || String(q?.['@type']).toLowerCase() !== 'question') bad++;
        else if (!answer) empty++;
        else { const norm = name.toLowerCase(); if (seen.has(norm)) dup++; seen.add(norm); }
      }
      if (bad > 0) critical.push({ id: 'faqpage_bad_shape', message: `Live FAQPage has ${bad} malformed Question(s). Google drops these.` });
      if (empty > 0) critical.push({ id: 'faqpage_empty_answer', message: `Live FAQPage has ${empty} empty answer(s). Google drops these.` });
      if (dup > 0) warnings.push({ id: 'faqpage_duplicate_q', message: `Live FAQPage has ${dup} duplicate question(s).` });
    }
    const howto = blocks.flatMap(b => b.raw || []).find(o => String(o?.['@type']).toLowerCase() === 'howto');
    if (howto) {
      const steps = Array.isArray(howto.step) ? howto.step : [];
      if (steps.length < 3) warnings.push({ id: 'howto_few_steps', message: `Live HowTo has ${steps.length} step(s) — Google prefers 3+.` });
      let bad = 0;
      for (const s of steps) {
        const t = String(s?.['@type'] || '').toLowerCase();
        if (t !== 'howtostep' || !String(s?.text || s?.name || '').trim()) bad++;
      }
      if (bad > 0) critical.push({ id: 'howto_bad_step', message: `Live HowTo has ${bad} malformed step(s).` });
    }
    const product = blocks.flatMap(b => b.raw || []).find(o => String(o?.['@type']).toLowerCase() === 'product');
    if (product && typeCounts['Product'] > 1) {
      warnings.push({ id: 'product_duplicate', message: `Live page has ${typeCounts['Product']} Product schemas. This causes Google "Duplicate field brand" warnings. Remove Product schema from our body_html push.` });
    }
    // Mojibake check on live HTML — catches issues that only surface post-
    // render (e.g., Shopify re-encoded some chars).
    if (/Ã[¢©®]|â€™|â€œ|â€|Â|â€/.test(html)) {
      warnings.push({ id: 'live_mojibake', message: 'Live HTML contains mojibake (double-encoded UTF-8). Reader will see garbage in visible text.' });
    }
    return send(res, 200, {
      ok: true,
      target_url: targetUrl,
      fetched_url: finalUrl,
      html_bytes: html.length,
      jsonld_block_count: blocks.length,
      type_inventory: typeCounts,
      blocks: blocks.map(b => ({ index: b.index, length: b.length, parsed: b.parsed, types: b.types, error: b.error, peek: b.peek })),
      critical,
      warnings,
      summary: {
        critical_count: critical.length,
        warning_count: warnings.length,
        verdict: critical.length === 0 ? (warnings.length === 0 ? 'CLEAN' : 'WARN') : 'FAIL',
      },
    });
}

  // images (readonly for context), variants (readonly for context only —
  // NEVER round-tripped to update). Used to build the Claude prompt.
// Parses its own URL from req.url rather than taking the router's parsed
// `url`, so it deliberately does not destructure that parameter.
async function getProduct({ req, res, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
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
    if (!r.ok) return send(res, r.status || 502, { ok: false, error: `Shopify API: ${JSON.stringify(r.error)}`, shop_domain: shop.shopDomain });
    let prod = (r.data?.products || [])[0];
    // Fallback: if handle lookup failed AND the caller supplied a
    // hint (?productId=), try direct lookup by id. Handles the case
    // where someone changed the slug in Shopify Admin between
    // discovery time and now — we still know the id from analytics.
    const hintId = Number(url.searchParams.get('productId') || 0);
    if (!prod && hintId > 0) {
      const rById = await shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'GET', apiPath: `/admin/api/${apiVer}/products/${hintId}.json`,
      }).catch(() => ({ ok: false }));
      if (rById.ok && rById.data?.product) {
        prod = rById.data.product;
        // Note the handle drift so the client can surface it.
        if (prod.handle && prod.handle !== handle) {
          prod._handle_drift = { queried: handle, current: prod.handle };
        }
      }
    }
    if (!prod) {
      const r2 = await shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'GET', apiPath: `/admin/api/${apiVer}/products.json?handle=${encodeURIComponent(handle)}&status=any`,
      }).catch(() => ({ ok: false }));
      const hidden = (r2.ok ? r2.data?.products || [] : [])[0];
      return send(res, 404, {
        ok: false,
        error: hidden
          ? `Product with handle "${handle}" exists on shop "${shop.shopDomain}" but has status="${hidden.status}" (not "active"). Publish it in Shopify Admin, then retry.`
          : `Shopify Admin API on shop "${shop.shopDomain}" returned no product with handle "${handle}". Possible causes: (1) Product was archived/deleted on Shopify side. (2) Shopify shop domain in Config → Shopify integration doesn't point at the store that hosts this product (verify: dropy.in and 7n0vkr-rn.myshopify.com are the SAME store — cross-check the SKU list in Shopify Admin). (3) Admin API token was rotated or lost read_products scope. (4) Handle changed on Shopify side after the last successful fetch.`,
        handle_queried: handle,
        shop_domain:    shop.shopDomain,
        hidden_status:  hidden?.status || null,
      });
    }
    // Parallel fetch: metafields (for reviews, seo, category) + product_category via GraphQL.
    // Metafields carry the review-app data (Judge.me / Loox / Yotpo / native).
    // Failing either request is soft — we still return the base product so the
    // prompt can render; the reviews block just stays empty.
    const [mfRes, gqlRes, defsRes] = await Promise.all([
      shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'GET', apiPath: `/admin/api/${apiVer}/products/${prod.id}/metafields.json`,
      }).catch(() => ({ ok: false })),
      shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
        body: { query: `{ product(id: "gid://shopify/Product/${prod.id}") { productCategory { productTaxonomyNode { id fullName name } } seo { title description } } }` },
      }).catch(() => ({ ok: false })),
      // Third parallel fetch: metafield DEFINITIONS for Products.
      // Definitions tell us the ACTUAL namespace + key that each display-
      // name (e.g. "How To Use", "Ingredients", "Bullet Points") lives
      // at on THIS store — we assumed 'custom.*' before and wrote to
      // orphan metafields that the theme never read. This resolves that.
      shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
        body: { query: `{ metafieldDefinitions(first: 200, ownerType: PRODUCT) { edges { node { namespace key name type { name } description } } } }` },
      }).catch(() => ({ ok: false })),
    ]);
    const metafields = mfRes.ok ? (mfRes.data?.metafields || []) : [];
    // Metafield definitions — { namespace, key, name, type }.
    const metafieldDefinitions = defsRes.ok
      ? (defsRes.data?.data?.metafieldDefinitions?.edges || []).map(e => ({
          namespace: e.node.namespace, key: e.node.key, name: e.node.name,
          type: e.node.type?.name || null, description: e.node.description || null,
        }))
      : [];
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
          // GTIN13/UPC/EAN — critical for Google Merchant matching. Product
          // schema JSON-LD MUST include gtin13:"<barcode>" when present.
          barcode: v.barcode || null,
        })),
        // Curated custom metafields — the store's theme renders these on
        // the product page (e.g. Bullet Points, Ingredients, How To Use,
        // F&Q). Claude sees them as SOURCE MATERIAL so it can (a) echo
        // factual content verbatim (ingredients list, dosage) rather than
        // paraphrase, and (b) NOT duplicate them in body_html (theme
        // already renders them). We include the full metafield row —
        // namespace + key + value + type — so the prompt can format them.
        // Filtered to a reasonable size cap per field to keep prompt lean.
        curated_metafields: metafields
          .filter(mf => mf && mf.namespace && !['judgeme', 'loox', 'yotpo', 'stamped'].includes(String(mf.namespace).toLowerCase())) // exclude review-app metafields (already surfaced in `reviews`)
          .filter(mf => typeof mf.value === 'string' && mf.value.trim().length > 0)
          .map(mf => ({
            namespace: mf.namespace,
            key: mf.key,
            type: mf.type || 'string',
            value: String(mf.value).slice(0, 3000),   // cap per-field; long descriptions get truncated
            truncated: String(mf.value).length > 3000,
          })),
        // Problem-tag detection so the client can show a red banner in
        // the modal. no-google / no-index / no-search blocks Google
        // Merchant Center + organic Shopping placement; users often set
        // these accidentally via bulk-edit apps.
        problem_tags: (String(prod.tags || '').split(/\s*,\s*/).filter(Boolean))
          .filter(t => /^(no-google|noindex|no-index|no-search|nosearch|no_google|hidden)$/i.test(t)),
        // READ-ONLY signal metafields — values Claude uses as INPUT (not
        // to write). Matched loosely by display name against ALL metafields
        // on the product. If populated, unlock real behavior in the prompt:
        //   · rating + rating_count → real AggregateRating in JSON-LD
        //   · bought_past_month     → mention social proof in copy
        //   · best_seller flag      → mention it, add 'best seller' to tags
        //   · SEO No-index true     → red banner (blocks Google indexing)
        //   · highlights            → preserve; don't overwrite
        signals: (() => {
          const norm = s => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
          const findMf = (nameCandidates) => {
            const targets = nameCandidates.map(norm);
            // Look up by matching display name via definitions, OR by
            // trying key patterns as a fallback.
            const def = metafieldDefinitions.find(d => targets.includes(norm(d.name)));
            if (def) return metafields.find(mf => mf.namespace === def.namespace && mf.key === def.key);
            return metafields.find(mf => targets.includes(norm(mf.key)));
          };
          const numOrNull = v => (v == null || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : v);
          const rating = findMf(['product rating']);
          const ratingCount = findMf(['product rating count']);
          const bought = findMf(['bought past month']);
          const bestSeller = findMf(['best seller']);
          const noIndex = findMf(['seo no-index']);
          const keepIndexed = findMf(['seo keep indexed']);
          const dept = findMf(['department']);
          const h1 = findMf(['highlight 1']);
          const h2 = findMf(['highlight 2']);
          const h3 = findMf(['highlight 3']);
          const brandColl = findMf(['brand collection']);
          const similarColl = findMf(['similar products collection']);
          const relatedProds = findMf(['related products']);
          return {
            rating:              numOrNull(rating?.value),
            rating_count:        numOrNull(ratingCount?.value),
            bought_past_month:   numOrNull(bought?.value),
            best_seller:         bestSeller?.value ? String(bestSeller.value) : null,
            no_index_metafield:  noIndex?.value === 'true' || noIndex?.value === true,
            keep_indexed:        keepIndexed?.value === 'true' || keepIndexed?.value === true,
            department:          dept?.value || null,
            current_highlights:  [h1, h2, h3].map(m => m?.value).filter(Boolean),
            brand_collection:    brandColl?.value || null,
            similar_collection:  similarColl?.value || null,
            related_products:    relatedProds?.value || null,
          };
        })(),
        // ALL metafield definitions on this store, with the display name
        // used to map from Claude's aliases (e.g. 'How To Use') to the
        // actual namespace/key the theme reads. Without this, previous
        // pushes wrote to custom.* which the theme ignored.
        metafield_definitions: metafieldDefinitions,
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
async function validatePatch({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    const b = await readJson(req);
    if (!b.patch || typeof b.patch !== 'object') return send(res, 400, { ok: false, error: 'patch object required' });
    const { safe, stripped, autoRouted, tagPreservation, faqFanout } = stripToShopifyAllowlist(b.patch, { currentTags: b.currentTags || null, currentVendor: b.currentVendor || null });
    const preflight = validateShopifyPatch(safe, b.validationContext || {});
    return send(res, 200, { ok: true, preflight, stripped, safe });
}

async function updateProduct({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    const b = await readJson(req);
    const productId = Number(b.productId);
    if (!productId) return send(res, 400, { ok: false, error: 'productId required' });
    if (!b.patch || typeof b.patch !== 'object') return send(res, 400, { ok: false, error: 'patch object required' });
    if (b.confirm !== 'PUSH') return send(res, 400, { ok: false, error: "safety: send {confirm:'PUSH'} to proceed" });
    const { safe, stripped, autoRouted, tagPreservation, faqFanout } = stripToShopifyAllowlist(b.patch, { currentTags: b.currentTags || null, currentVendor: b.currentVendor || null });
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
    // Snapshot the CURRENT state of the fields we're about to overwrite,
    // BEFORE the PUT. Stored in shopify_push_history so /api/shopify/revert
    // can restore them if the operator hates the new copy. Soft-fail: if
    // the fetch errors, we still push (better to lose the snapshot than
    // block the update) — but log the reason for audit.
    let snapshot = null, snapshotErr = null;
    try {
      const [gp, gq] = await Promise.all([
        shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'GET', apiPath: `/admin/api/${apiVer}/products/${productId}.json`,
        }),
        shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
          body: { query: `{ product(id: "gid://shopify/Product/${productId}") { seo { title description } productCategory { productTaxonomyNode { id } } } }` },
        }).catch(() => ({ ok: false })),
      ]);
      if (gp.ok && gp.data?.product) {
        const p = gp.data.product;
        const gqlProd = gq.ok ? (gq.data?.data?.product || {}) : {};
        // Only snapshot fields we're actually PUTting — no point saving
        // fields the operator didn't touch (they can't drift on revert).
        const snap = {};
        for (const key of Object.keys(safe)) {
          switch (key) {
            case 'title':          snap.title = p.title || ''; break;
            case 'body_html':      snap.body_html = p.body_html || ''; break;
            case 'tags':           snap.tags = p.tags || ''; break;
            case 'product_type':   snap.product_type = p.product_type || ''; break;
            case 'vendor':         snap.vendor = p.vendor || ''; break;
            case 'handle':         snap.handle = p.handle || ''; break;
            case 'seo_title':      snap.seo_title = gqlProd.seo?.title || ''; break;
            case 'seo_description':snap.seo_description = gqlProd.seo?.description || ''; break;
            case 'product_category': snap.product_category = gqlProd.productCategory?.productTaxonomyNode?.id || null; break;
            // metafields_global_*_tag: not fetched here — legacy metafields
            // need a separate metafields.json call. Skipped for now; revert
            // won't restore these but they mirror seo_title/description
            // in practice so seo_* restore covers 99% of intent.
          }
        }
        snapshot = snap;
      } else {
        snapshotErr = gp.error?.errors || gp.error || 'get-product before push returned no product';
      }
    } catch (e) { snapshotErr = e.message; }
    // Split the payload: REST for legacy fields, GraphQL productUpdate for
    // modern fields (seo object, productCategory). Metafields are a THIRD
    // path — POST /products/{id}/metafields.json per key. All three run;
    // caller gets full coverage regardless of which path a given field
    // lives on.
    const restPayload = {};
    const gqlPayload = {};
    const metafieldsToWrite = safe.metafields || {};
    for (const [k, v] of Object.entries(safe)) {
      if (k === 'metafields') continue;
      if (SHOPIFY_GRAPHQL_ONLY_FIELDS.has(k)) gqlPayload[k] = v;
      else restPayload[k] = v;
    }
    const results = { rest: null, graphql: null, metafields: null };
    // Snapshot the current metafield values BEFORE overwriting so revert
    // can restore. Fetches all product metafields (already cheap since
    // we may have fetched them for the snapshot above — but this endpoint
    // is separate from the pre-push snapshot flow, which fetched product
    // fields not metafields). One call, then filter to what we're writing.
    if (Object.keys(metafieldsToWrite).length > 0 && snapshot) {
      try {
        const mfList = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'GET', apiPath: `/admin/api/${apiVer}/products/${productId}/metafields.json`,
        });
        if (mfList.ok) {
          const existingMetas = (mfList.data?.metafields || []);
          snapshot.metafields = {};
          for (const mkey of Object.keys(metafieldsToWrite)) {
            const [ns, key] = mkey.split('.');
            const found = existingMetas.find(mf => mf.namespace === ns && mf.key === key);
            // Save {value, id?} — id needed to update-in-place instead of
            // duplicating. If no existing metafield, snapshot empty string
            // so revert clears the field (which is what 'before' was).
            snapshot.metafields[mkey] = { value: found?.value ?? '', id: found?.id ?? null, type: found?.type ?? null };
          }
        }
      } catch { /* soft-fail: revert for metafields simply won't be possible for this push */ }
    }
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
    // Write custom metafields. Resolve alias → actual namespace/key via
    // the store's metafield definitions. Fetches definitions first (cheap,
    // one GraphQL call) so we write to the SAME keys the theme reads
    // from — instead of orphaning content at custom.* keys no theme sees.
    if (Object.keys(metafieldsToWrite).length > 0) {
      // Fetch definitions for THIS store (also fetched in get-product but
      // that call may be stale between prompt-build and push).
      const defsResPush = await shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'POST', apiPath: `/admin/api/${apiVer}/graphql.json`,
        body: { query: `{ metafieldDefinitions(first: 200, ownerType: PRODUCT) { edges { node { namespace key name type { name } } } } }` },
      }).catch(() => ({ ok: false }));
      const definitionsPush = defsResPush.ok
        ? (defsResPush.data?.data?.metafieldDefinitions?.edges || []).map(e => ({
            namespace: e.node.namespace, key: e.node.key, name: e.node.name, type: e.node.type?.name || null,
          }))
        : [];
      const mfResults = [];
      for (const [alias, mval] of Object.entries(metafieldsToWrite)) {
        const target = resolveMetafieldTarget(alias, definitionsPush);
        if (!target) {
          // No definition on this store for this alias — refuse the
          // write. Would otherwise create an orphan at custom.* the
          // theme never reads (root cause of the earlier 'dumped into
          // Description' issue).
          mfResults.push({
            alias, ok: false, skipped: true, resolved_via: 'no-definition',
            error: `Skipped: no metafield definition on this store matches alias "${alias}". Either define it in Shopify Admin → Settings → Custom data → Products, or drop this key from Claude's output. Writing to custom.* would create an orphan the theme never reads.`,
          });
          continue;
        }
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer}/products/${productId}/metafields.json`,
          body: { metafield: { namespace: target.namespace, key: target.key, value: String(mval), type: target.type } },
        }).catch(e => ({ ok: false, error: e.message }));
        mfResults.push({
          alias,
          wrote_to: `${target.namespace}.${target.key}`,
          resolved_via: target.resolvedVia,
          ok: r.ok, status: r.status,
          error: r.ok ? null : r.error,
        });
      }
      results.metafields = mfResults;
      // Don't fail the whole push on metafield errors — product core fields
      // succeeded already. Surface individual failures in the response so
      // the client can show a warning banner.
    }
    // Image alts — if Claude produced them, PUT each via the same
    // /products/{pid}/images/{iid}.json endpoint the standalone
    // /api/shopify/update-image-alts uses. Individual failures don't
    // abort the whole push. Alt-text is a real ranking signal (Google
    // Image Search + main-image ranking factor).
    if (Array.isArray(safe.image_alts) && safe.image_alts.length > 0) {
      const altResults = [];
      for (const entry of safe.image_alts) {
        const r = await shopifyRequest({
          shopDomain: shop.shopDomain, adminToken: shop.adminToken,
          method: 'PUT', apiPath: `/admin/api/${apiVer}/products/${productId}/images/${entry.imageId}.json`,
          body: { image: { id: entry.imageId, alt: entry.alt } },
        }).catch(e => ({ ok: false, error: e.message }));
        altResults.push({ imageId: entry.imageId, alt: entry.alt, ok: r.ok, error: r.ok ? null : r.error });
      }
      results.image_alts = altResults;
    }
    // Record push history — one row per successful (or partial-success)
    // /update-product. Snapshot may be null if the pre-push fetch failed
    // — in that case there's no revert possible for this row, but we
    // still record the patch for audit. Wrapped so history insert failure
    // never breaks the push response.
    let historyId = null;
    try {
      const hist = db.prepare(`INSERT INTO shopify_push_history (product_id, product_url, sku, batch_id, pushed_at, pushed_by, snapshot_json, patch_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(productId, b.productUrl || null, b.sku || null, b.batchId || null, now(), b.pushedBy || null, JSON.stringify(snapshot || {}), JSON.stringify(safe));
      historyId = Number(hist.lastInsertRowid);
    } catch (e) { /* audit-only; do not fail the push */ }
    return send(res, 200, { ok: true, productId, sent: safe, stripped, results, product: results.rest?.product || null, history_id: historyId, snapshot_captured: !!snapshot, snapshot_error: snapshotErr, auto_routed: autoRouted, tag_preservation: tagPreservation, faq_fanout: faqFanout });
}

  // List push history for a product — powers the 'Revert' UI in the
  // Shopify modal. Returns most-recent first, with the fields we can
  // restore + the timestamp + whether it's already been reverted.
async function pushHistory({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    const productId = Number(url.searchParams.get('productId') || 0);
    if (!productId) return send(res, 400, { ok: false, error: 'productId query param required' });
    const rows = db.prepare(`SELECT id, product_id, product_url, sku, batch_id, pushed_at, pushed_by, snapshot_json, patch_json, reverted_at FROM shopify_push_history WHERE product_id = ? ORDER BY pushed_at DESC LIMIT 20`).all(productId);
    // Parse the JSON columns so the client sees objects, not strings.
    return send(res, 200, { ok: true, history: rows.map(r => ({
      id: r.id, product_id: r.product_id, product_url: r.product_url, sku: r.sku, batch_id: r.batch_id,
      pushed_at: r.pushed_at, pushed_by: r.pushed_by,
      snapshot: (() => { try { return JSON.parse(r.snapshot_json); } catch { return {}; } })(),
      patch:    (() => { try { return JSON.parse(r.patch_json); } catch { return {}; } })(),
      reverted_at: r.reverted_at,
      can_revert: !r.reverted_at && Object.keys((() => { try { return JSON.parse(r.snapshot_json); } catch { return {}; } })()).length > 0,
    })) });
}

  // Revert a push — restores the snapshotted field values via a new PUT.
  // Records the revert time on the original history row so it can't be
  // double-reverted. The revert itself is ALSO recorded as its own history
  // entry (with the current state as snapshot) so the operator can revert
  // the revert if they change their mind again.
async function revert({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
    const b = await readJson(req);
    if (b.confirm !== 'REVERT') return send(res, 400, { ok: false, error: "safety: send {confirm:'REVERT'} to proceed" });
    const historyId = Number(b.historyId);
    if (!historyId) return send(res, 400, { ok: false, error: 'historyId required' });
    const row = db.prepare(`SELECT * FROM shopify_push_history WHERE id = ?`).get(historyId);
    if (!row) return send(res, 404, { ok: false, error: 'history row not found' });
    if (row.reverted_at) return send(res, 400, { ok: false, error: 'this push was already reverted' });
    let snapshot; try { snapshot = JSON.parse(row.snapshot_json); } catch { return send(res, 400, { ok: false, error: 'snapshot_json corrupt on this row — cannot revert' }); }
    if (!snapshot || Object.keys(snapshot).length === 0) return send(res, 400, { ok: false, error: 'no snapshot on this push (pre-push fetch failed at the time) — nothing to restore' });
    // Reuse the update-product code path by proxying to it. Simpler +
    // guaranteed same allowlist/split logic. Build the patch = snapshot
    // + confirm=PUSH + productId.
    const proxyBody = { productId: row.product_id, patch: snapshot, confirm: 'PUSH', pushedBy: `revert-of-${historyId}`, batchId: row.batch_id, sku: row.sku, productUrl: row.product_url, force: true };
    // Call the internal push path directly. Rather than re-implement,
    // just mark this history row as reverted after a successful PUT via
    // the shopifyRequest helper.
    const cfgRow2 = Q.getConfig.get();
    const cfg2 = cfgRow2?.config ? JSON.parse(cfgRow2.config) : {};
    const shop2 = cfg2.shopify || {};
    const apiVer2 = shop2.apiVersion || '2024-10';
    const { safe: safeSnap, stripped: strippedSnap } = stripToShopifyAllowlist(snapshot);
    const restPayload2 = {}, gqlPayload2 = {};
    for (const [k, v] of Object.entries(safeSnap)) {
      if (SHOPIFY_GRAPHQL_ONLY_FIELDS.has(k)) gqlPayload2[k] = v;
      else restPayload2[k] = v;
    }
    const restRes = Object.keys(restPayload2).length === 0 ? { ok: true } : await shopifyRequest({
      shopDomain: shop2.shopDomain, adminToken: shop2.adminToken,
      method: 'PUT', apiPath: `/admin/api/${apiVer2}/products/${row.product_id}.json`,
      body: { product: { id: row.product_id, ...restPayload2 } },
    });
    if (!restRes.ok) return send(res, restRes.status || 502, { ok: false, error: `Shopify REST revert failed: ${JSON.stringify(restRes.error)}` });
    if (Object.keys(gqlPayload2).length > 0) {
      const inputParts = [`id: "gid://shopify/Product/${row.product_id}"`];
      const seoFields = [];
      if (gqlPayload2.seo_title != null)       seoFields.push(`title: ${JSON.stringify(String(gqlPayload2.seo_title))}`);
      if (gqlPayload2.seo_description != null) seoFields.push(`description: ${JSON.stringify(String(gqlPayload2.seo_description))}`);
      if (seoFields.length > 0) inputParts.push(`seo: { ${seoFields.join(', ')} }`);
      if (gqlPayload2.product_category) inputParts.push(`productCategory: { productTaxonomyNodeId: "${String(gqlPayload2.product_category).replace(/"/g, '')}" }`);
      const mutation = `mutation { productUpdate(input: { ${inputParts.join(', ')} }) { product { id } userErrors { field message } } }`;
      const g = await shopifyRequest({
        shopDomain: shop2.shopDomain, adminToken: shop2.adminToken,
        method: 'POST', apiPath: `/admin/api/${apiVer2}/graphql.json`,
        body: { query: mutation },
      });
      const userErrs = g.data?.data?.productUpdate?.userErrors || [];
      if (!g.ok || userErrs.length > 0) return send(res, 502, { ok: false, error: `Shopify GraphQL revert failed: ${JSON.stringify(userErrs.length > 0 ? userErrs : g.error)}`, restReverted: true });
    }
    // Restore metafields too — snapshot.metafields is {'ns.key': {value, id, type}}.
    const metafieldsRestored = [];
    if (snapshot.metafields && typeof snapshot.metafields === 'object') {
      for (const [mkey, prev] of Object.entries(snapshot.metafields)) {
        const [ns, key] = mkey.split('.');
        const type = prev?.type || SHOPIFY_METAFIELD_ALLOWLIST[mkey]?.type || 'multi_line_text_field';
        // POST upserts (Shopify treats POST with existing namespace+key as update).
        const r = await shopifyRequest({
          shopDomain: shop2.shopDomain, adminToken: shop2.adminToken,
          method: 'POST', apiPath: `/admin/api/${apiVer2}/products/${row.product_id}/metafields.json`,
          body: { metafield: { namespace: ns, key: key, value: String(prev?.value ?? ''), type } },
        }).catch(e => ({ ok: false, error: e.message }));
        metafieldsRestored.push({ key: mkey, ok: r.ok, error: r.ok ? null : r.error });
      }
    }
    // Mark original row as reverted so it can't be double-reverted.
    db.prepare(`UPDATE shopify_push_history SET reverted_at = ? WHERE id = ?`).run(now(), historyId);
    return send(res, 200, { ok: true, revertedHistoryId: historyId, restoredFields: Object.keys(safeSnap), restoredMetafields: metafieldsRestored, strippedFields: strippedSnap });
}

  // Bulk-update image alt-text on a product. Deterministic template — does
  // NOT need Claude. Takes the current product images + a keyword-rich
  // template built from the research (e.g. `${primaryKeyword} — ${benefit}`)
  // and PUTs each image's alt via /products/{pid}/images/{iid}.json.
  // Missed SEO signal previously: alt text drives Google Image Search + the
  // main-image alt is a documented ranking signal on the product page.
async function updateImageAlts({ req, res, url, ctx }) {
  const { db, Q, send, readJson, now, shopifyRequest, resolveMetafieldTarget, stripToShopifyAllowlist,
          validateShopifyPatch, extractShopifyHandle, extractReviewSignals,
          SHOPIFY_FIELD_IMPACT, SHOPIFY_ALLOWED_FIELDS, SHOPIFY_METAFIELD_ALIASES,
          SHOPIFY_GRAPHQL_ONLY_FIELDS, SHOPIFY_METAFIELD_ALLOWLIST, _policyCache } = ctx;
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

function register(router) {
  router.get ('/api/shopify/debug-lookup',         debugLookup);
  router.get ('/api/shopify/field-impact',         fieldImpact);
  router.get ('/api/shopify/metafield-definitions', metafieldDefinitions);
  router.get ('/api/shopify/get-policies',         getPolicies);
  router.get ('/api/shopify/audit-live-page',      auditLivePage);
  router.get ('/api/shopify/get-product',          getProduct);
  router.post('/api/shopify/validate-patch',       validatePatch);
  router.post('/api/shopify/update-product',       updateProduct);
  router.get ('/api/shopify/push-history',         pushHistory);
  router.post('/api/shopify/revert',               revert);
  router.post('/api/shopify/update-image-alts',    updateImageAlts);
}

module.exports = { register };
