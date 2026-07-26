// Getting SKUs INTO the queue, plus bulk mutation of what's already there.
//
// Split out from routes/jobs.js because this is the only part of the queue
// that talks to Shopify: resolving a bare SKU to the dropy.in product URL
// the engine will actually scrape. Queue mechanics stay dependency-free.
//
// The UPSERT semantics here are the subtle part. Many SKUs are variants of
// one product and resolve to the SAME product page. Those must collapse into
// ONE job row whose `sku` column lists them all, so that:
//   · the operator still sees every SKU they submitted, and
//   · the engine scrapes that product page exactly once, which is the whole
//     point of scraping.
// Two dedup paths achieve it: cross-batch (skip URLs already active in
// another batch) and in-batch (ON CONFLICT DO UPDATE appends the SKU, with a
// LIKE guard making it a no-op if already listed).
'use strict';

// Bulk SKU import. Body:
//   { batchId, skus: ['Dropy-B002OTT3US', ...],
//     resolve: 'amazon' | 'shopify' | 'both', dryRun?: true }
// Accepts 'Dropy-<ASIN>', bare '<ASIN>', any case. Blank lines and '#'
// comments are skipped; malformed lines are reported, not fatal.
// dryRun returns the resolution preview without inserting anything.
async function uploadBySku({ req, res, ctx }) {
  const { db, Q, send, readJson, shopifyRequest } = ctx;
  const b = await readJson(req);
  const batchId = String(b.batchId || '').trim();
  const skus    = Array.isArray(b.skus) ? b.skus : [];
  const resolveMode = ['amazon', 'shopify', 'both'].includes(b.resolve) ? b.resolve : 'amazon';
  const dryRun = !!b.dryRun;
  if (!batchId) return send(res, 400, { ok: false, error: 'batchId required' });
  if (skus.length === 0) return send(res, 400, { ok: false, error: 'skus (array) required' });

  // Parse: trim, drop blanks + '#' comments, dedup by ASIN.
  const parsed = new Map();
  const badFormat = [];
  for (const raw of skus) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith('#')) continue;
    const m2 = line.match(/^(?:Dropy-)?([A-Z0-9]{10})$/i);
    if (!m2) { badFormat.push(line); continue; }
    const asin = m2[1].toUpperCase();
    if (!parsed.has(asin)) parsed.set(asin, { sku: line, asin });
  }

  const cfgRow = Q.getConfig.get();
  const cfg = cfgRow?.config ? JSON.parse(cfgRow.config) : {};
  const shop = cfg.shopify || {};
  const apiVer = shop.apiVersion || '2024-10';
  const shopifyConfigured = !!(shop.shopDomain && shop.adminToken);
  const shopifyDomain = shop.shopDomain ? String(shop.shopDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;

  // ONE GraphQL query per lookup round, with OR'd values — 3 API calls per
  // 250-SKU batch instead of 750. Returns a map keyed by the field value so
  // the per-SKU loop below is O(1) local lookups.
  const batchGqlLookup = async (field, values) => {
    if (values.length === 0) return {};
    // Shopify's OR operator with double-quoted values (preserves hyphens).
    const clauses = values.map(v => `${field}:\\"${String(v).replace(/"/g, '')}\\"`).join(' OR ');
    const first = Math.min(250, values.length * 3);   // a SKU may have several variants
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
    const byKey = {};
    for (const edge of (r?.data?.data?.productVariants?.edges || [])) {
      // Ignore fuzzy hits — the returned field must equal what we asked for.
      const key = String(edge?.node?.[field] || '').toLowerCase();
      if (!key) continue;
      if (!byKey[key]) byKey[key] = edge.node;   // first exact match wins
    }
    return byKey;
  };

  // Handle wildcards — slower on Shopify's side than an exact lookup, but
  // still one round trip for the whole batch.
  const batchGqlHandleWildcard = async (asinTokens) => {
    if (asinTokens.length === 0) return {};
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
      for (const a of asinTokens) if (h.includes(a) && !byAsin[a]) byAsin[a] = edge.node;
    }
    return byAsin;
  };

  // The STOREFRONT host (public dropy.in domain), NOT the *.myshopify.com
  // admin host — the engine has to scrape the page a customer would see.
  let storefrontHost = shop.storefrontDomain
    ? String(shop.storefrontDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : null;
  if (!storefrontHost && shopifyConfigured) {
    try {
      const sr = await shopifyRequest({
        shopDomain: shop.shopDomain, adminToken: shop.adminToken,
        method: 'GET', apiPath: `/admin/api/${apiVer}/shop.json?fields=primary_domain`,
      });
      if (sr.ok && sr.data?.shop?.primary_domain?.host) storefrontHost = sr.data.shop.primary_domain.host;
    } catch { /* fall back to the admin domain below */ }
  }
  const publicHost = storefrontHost || shopifyDomain;

  // BATCH pre-lookup — one Shopify query per round covers every SKU.
  let skuMap = {}, barcodeMap = {}, handleMap = {};
  const wantShopifyForBatch = (resolveMode === 'shopify' || resolveMode === 'both') && shopifyConfigured;
  if (wantShopifyForBatch) {
    const allSkuCandidates = [], allBarcodeCandidates = [], allAsinTokens = [];
    for (const [asin, e] of parsed) {
      allSkuCandidates.push(e.sku, asin, `Dropy-${asin}`);
      allBarcodeCandidates.push(e.sku, asin);
      allAsinTokens.push(asin.toLowerCase());
    }
    const uniq = arr => [...new Set(arr.filter(Boolean))];
    // Each lookup is independently optional — a failure in one round must
    // not abort the others or the whole upload.
    try { skuMap     = await batchGqlLookup('sku',     uniq(allSkuCandidates)); }     catch {}
    try { barcodeMap = await batchGqlLookup('barcode', uniq(allBarcodeCandidates)); } catch {}
    try { handleMap  = await batchGqlHandleWildcard(uniq(allAsinTokens)); }           catch {}
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
  for (const [, entry] of parsed) {
    let url = null, source = null, note = null, matchedVia = null;
    let shopifyTried = false;
    // Consume the batched maps built above — three O(1) local lookups per
    // SKU instead of 3-9 Shopify round trips.
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
    if (matchedVia) note = `matched via ${matchedVia}`;
    // Shopify was consulted but found nothing — say which paths were tried,
    // so an operator debugging a mis-resolution isn't guessing.
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

  if (dryRun) {
    return send(res, 200, {
      ok: true, dryRun: true, batchId,
      parsed: parsed.size, badFormat: badFormat.length,
      resolved: withUrl.length, unresolved: withoutUrl.length,
      preview: resolved.slice(0, 200),
      badFormatSamples: badFormat.slice(0, 20),
      shopifyConfigured,
    });
  }

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
      // Nth time we've seen this URL in this call — hits the UPSERT UPDATE
      // branch and merges into the row we just inserted.
      if (seenInThisCall.has(r.url)) {
        upsertJob.run(batchId, r.sku, r.url, r.product_name, 100, r.handles, r.brands);
        linkedToExisting++;
        continue;
      }
      seenInThisCall.add(r.url);
      // First time in this call — was it already in the batch from a
      // previous upload? Decides inserted vs merged in the response.
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
    // SKUs merged into another row because they resolved to a URL already
    // in this batch. Every SKU is preserved; the URL is scraped once.
    linkedToExisting,
    badFormatSamples: badFormat.slice(0, 20),
    shopifyConfigured,
  });
}

// Excel/CSV upload path — products already carry URLs, so no resolution.
// Same UPSERT semantics as uploadBySku, so an append-to-existing-batch
// upload merges rather than throwing UNIQUE, and a re-upload is a no-op.
async function upload({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  const batchId = String(b.batchId || b.batch_id || '');
  const products = Array.isArray(b.products) ? b.products : [];
  if (!batchId || products.length === 0) return send(res, 400, { ok: false, error: 'batchId + products required' });

  // Dedup within this upload — last occurrence wins.
  const seen = new Map();
  for (const pr of products) {
    const u = String(pr.url || pr.product_url || '').trim();
    if (u) seen.set(u, pr);
  }
  const dupDropped = products.filter(p => (p.url || p.product_url || '').trim()).length - seen.size;

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
      // Cross-batch dedup: skip URLs already pending/claimed/done elsewhere.
      if (Q.existsActiveUrl.get(urlv, batchId)) { skippedActive++; if (pr.sku) skippedSkus.push(pr.sku); continue; }
      upsertJobExcel.run(
        batchId, pr.sku || null, urlv, pr.product_name || pr.name || null,
        Number.isFinite(pr.priority) ? pr.priority : 100,
        Array.isArray(pr.handles) ? pr.handles.join('|') : (pr.handles || null),
        Array.isArray(pr.brands)  ? pr.brands.join('|')  : (pr.brands  || null),
      );
      if (!seenUrlsExcel.has(urlv)) { n++; seenUrlsExcel.add(urlv); }
      else linkedToExisting++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return send(res, 200, {
    ok: true, uploaded: n, total: seen.size, batchId,
    duplicatesDropped: dupDropped, skippedActive,
    skippedSkus: skippedSkus.slice(0, 10), linkedToExisting,
  });
}

// Apply the same {status|priority|failed_reason} patch to N job ids, for the
// queue-manager multi-select toolbar. Claimed jobs are excluded unless
// force=true, matching the single-job update rule.
async function bulkUpdate({ req, res, ctx }) {
  const { db, send, readJson } = ctx;
  const b = await readJson(req);
  const ids = Array.isArray(b.jobIds) ? b.jobIds.map(Number).filter(Number.isFinite) : [];
  const patch = b.patch || {};
  if (ids.length === 0) return send(res, 400, { ok: false, error: 'jobIds required' });
  // Column allowlist — `patch` is client-supplied and is interpolated into
  // the SET clause, so only these names may ever reach the SQL.
  const allowed = ['priority', 'status', 'failed_reason'];
  const setCols = [], args = [];
  for (const col of allowed) {
    if (col in patch) { setCols.push(`${col} = ?`); args.push(patch[col]); }
  }
  if (setCols.length === 0) return send(res, 400, { ok: false, error: 'patch must set at least one of: priority, status, failed_reason' });
  // status=pending clears claim + heartbeat too, matching /api/jobs/reset.
  const extraCols = patch.status === 'pending'
    ? ', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, failed_reason=NULL'
    : '';
  let sql = `UPDATE jobs SET ${setCols.join(', ')}${extraCols} WHERE id IN (${ids.map(() => '?').join(',')})`;
  if (!b.force) sql += ` AND status != 'claimed'`;
  const info = db.prepare(sql).run(...args, ...ids);
  return send(res, 200, { ok: true, updated: info.changes, requested: ids.length });
}

// Same semantics as delete-one, for N ids. Skips (rather than fails on)
// claimed rows without force, so one claimed job doesn't block the batch.
async function bulkDelete({ req, res, ctx }) {
  const { db, Q, send, readJson } = ctx;
  const b = await readJson(req);
  const ids = Array.isArray(b.jobIds) ? b.jobIds.map(Number).filter(Number.isFinite) : [];
  const force = !!b.force;
  if (ids.length === 0) return send(res, 400, { ok: false, error: 'jobIds required' });
  let deleted = 0, keywordsDeleted = 0;
  db.exec('BEGIN');
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

function register(router) {
  router.post('/api/jobs/upload',        upload);
  router.post('/api/jobs/upload-by-sku', uploadBySku);
  router.post('/api/jobs/bulk-update',   bulkUpdate);
  router.post('/api/jobs/bulk-delete',   bulkDelete);
}

module.exports = { register };
