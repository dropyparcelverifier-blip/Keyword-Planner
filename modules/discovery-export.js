// modules/discovery-export.js
// CSV / XLSX export via locally bundled SheetJS (ESM build) and chrome.downloads.
// Supabase push via REST with Prefer: resolution=ignore-duplicates.

import * as XLSX from '../lib/xlsx.mjs';
import {
  SUPABASE_TABLE,
  getServiceKey,
  getSupabaseUrl,
} from '../config/discovery-config.js';

// SheetJS rejects strings longer than 32767 chars per cell.
// matched_thumbnails (many image URLs) and autosuggestions can blow past this
// for high-volume keywords — truncate with a clear suffix.
const MAX_CELL = 32700;
function safeCell(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_CELL) return value;
  return value.slice(0, MAX_CELL) + ` … [truncated ${value.length - MAX_CELL} chars]`;
}

function pairConfidences(thumbs, confs) {
  return (thumbs || []).map((url, i) => ({ url, conf: (confs && confs[i]) || 0 }));
}

// Inline base64 thumbnails (data:image/jpeg|png) are captured for CLIP
// matching but would bloat the CSV (~2 KB per thumb). Replace with a
// placeholder for export — the user can audit by checking the matched
// seller/title text instead.
function _exportUrl(u) {
  if (typeof u !== 'string') return '';
  if (u.startsWith('data:')) return '[inline-thumbnail]';
  return u;
}

// Pair thumbs + conf + seller + price for ordered, sortable export rows.
// Keeps data: URIs in the count (image_count still reflects them) but
// replaces the URL string at export time so the CSV stays small.
function pairMatched(r) {
  const thumbs  = r.matchedThumbnails  || [];
  const confs   = r.matchedConfidences || [];
  const sellers = r.matchedSellers     || [];
  const prices  = r.matchedPrices      || [];
  const out = [];
  for (let i = 0; i < thumbs.length; i++) {
    const raw = thumbs[i];
    if (typeof raw !== 'string' || !raw) continue;
    out.push({
      url:    _exportUrl(raw),
      conf:   confs[i]   || 0,
      seller: sellers[i] || '',
      price:  prices[i]  || '',
    });
  }
  return out;
}

// Export quality gate. A row makes it into the CSV / XLSX / Supabase push
// only when it carries actionable signal. Drop pure-noise rows (no image
// match, low rating, no commercial signal).
//
// Only keep rows where our product's image actually appeared on the SERP.
// Everything else is dropped, regardless of seller_type, adRating, or KP
// monthly searches. Rationale: the report is meant to answer "which queries
// surface our product?" — a high-volume keyword with 0 image matches doesn't
// answer that; it just clutters the file with educational / competitor
// queries where we never appear.
function _exportWorthKeeping(r) {
  // image_count is the CONFIRMED-match count (clean / dhash /
  // partial_spec_confirmed / pack_variant_*). ambiguous_match_count
  // tracks lower-confidence brand-only matches separately. Keep rows
  // that had either kind of attribution so the user can still audit
  // the ambiguous ones — they're real signal, just unverified.
  return (r.imageCount || 0) > 0 || (r.ambiguousMatchCount || 0) > 0;
}

// Row ordering: by adRating desc when available, else by image_count desc.
// This puts the highest-scoring keywords at the top of the export so the user
// can pick winners from the first rows without re-sorting in Excel.
function orderRows(report) {
  const filtered = report.filter(_exportWorthKeeping);
  filtered.sort((a, b) => {
    const ra = (typeof a.adRating === 'number') ? a.adRating : -1;
    const rb = (typeof b.adRating === 'number') ? b.adRating : -1;
    if (rb !== ra) return rb - ra;
    return (b.imageCount || 0) - (a.imageCount || 0);
  });
  return filtered;
}

// Note: we deliberately drop fields prefixed with `_` (internal-only).
function rowsForExport(report) {
  const ordered = orderRows(report);
  return ordered.map(r => {
    const paired = pairMatched(r);
    paired.sort((a, b) => b.conf - a.conf);
    const confs = paired.map(p => p.conf);
    const avg = confs.length ? Math.round(confs.reduce((s, v) => s + v, 0) / confs.length) : 0;
    const max = confs.length ? confs[0] : 0;
    const min = confs.length ? confs[confs.length - 1] : 0;
    const top = paired[0] ? `${paired[0].url} [${paired[0].conf}]` : '';
    const matchedList = paired.map(p => `${p.url} [${p.conf}]`).join(' | ');
    // Sellers / prices: only non-empty entries, in the same sort order as
    // matched_thumbnails. Empty for keywords with no SERP match data.
    const sellersList = paired.map(p => p.seller).filter(Boolean).join(' | ');
    const pricesList  = paired.map(p => p.price ).filter(Boolean).join(' | ');
    const topSeller   = paired[0]?.seller || '';
    const topPrice    = paired[0]?.price  || '';

    // Per-keyword SERP sellers (from collectAllSellers) — distinct from
    // matched_sellers (which are only sellers tied to matched thumbnails).
    const allSellersList = (r.sellers || [])
      .map(s => `${s.domain || ''}${s.price ? ` (${s.price})` : ''}`)
      .filter(Boolean)
      .join(' | ');

    // seller_titles: for each seller that carries our product on this SERP,
    // record what name they use ("amazon.in: Now Foods Alfalfa 10 Grain,
    // 650 mg | iherb.com: Alfalfa, 650 mg, 250 Tablets"). Sourced from
    // collectAllSellers, which includes each seller's product card title.
    const sellerTitlesList = (r.sellers || [])
      .filter(s => s && s.domain && s.title && s.title.length > 5)
      .map(s => `${s.domain}: ${String(s.title).slice(0, 80)}`)
      .join(' | ');

    // Column order — grouped logically so the most-useful fields appear
    // first when the file opens. Object insertion order is preserved by
    // SheetJS's json_to_sheet, so this also defines the CSV/XLSX columns.
    //   1. Product context (batch / sku / name / priority)
    //   2. Keyword identity (keyword / source / parent_keyword)
    //   3. Scores & classification (ad_rating / frequency / intent / topic / funnel)
    //   4. Per-keyword SERP signal (image_count, confidences, sellers, ads)
    //   5. Top-match (single best thumb / seller / price)
    //   6. KP metrics
    //   7. Autosuggest
    //   8. Bulky reference arrays (matched_thumbnails / sellers / prices,
    //      product_url, product_image) — last so they don't dominate the
    //      visible columns when the file is opened in Excel.
    return {
      // --- Product context ---
      batch_id: r.batchId,
      sku: r.sku || '',
      product_name: r.productName,
      priority: r.priority,
      // --- Keyword identity ---
      keyword: r.keyword,
      source: r.source,
      parent_keyword: r.parentKeyword || '',
      // Clickable Google URL the user can open to spot-check image_count.
      serp_url: r.serp_url || '',
      // --- Scores & classification ---
      ad_rating: typeof r.adRating === 'number' ? r.adRating : 0,
      frequency: r.frequency || 1,
      intent: r.intent || '',
      topic: r.topic || '',
      funnel: r.funnel || '',
      // --- Image-match signal ---
      image_count: r.imageCount,
      // total_thumbs is the per-keyword denominator for visibility_pct: every
      // product thumbnail captured on that SERP, matched or not.
      total_thumbs: r.totalThumbs || r.total_thumbs || 0,
      visibility_pct: (() => {
        const t = r.totalThumbs || r.total_thumbs || 0;
        const m = r.imageCount  || 0;
        return t > 0 ? Math.round((m / t) * 100) : (typeof r.visibilityPct === 'number' ? r.visibilityPct : 0);
      })(),
      image_count_unverified: r.imageCountUnverified || 0,
      // Which SERP zones the matched thumbnails came from
      // ("knowledge_panel:5 | organic:3") + total-found vs matched audit.
      match_sources:    r.matchSources    || '',
      thumbs_captured:  r.thumbsCaptured  || '',
      match_confidence_max: typeof r.match_confidence_max === 'number' ? r.match_confidence_max : max,
      match_confidence_avg: typeof r.match_confidence_avg === 'number' ? r.match_confidence_avg : avg,
      match_confidence_min: typeof r.match_confidence_min === 'number' ? r.match_confidence_min : min,
      // --- Seller signal (per keyword's SERP) ---
      total_sellers: r.totalSellers || 0,
      seller_type:   r.seller_type || '',
      sellers_on_serp: safeCell(allSellersList),
      seller_titles:   safeCell(sellerTitlesList),
      ads_on_serp:   r.adsOnSerp    || 0,
      // --- Top match (single best) ---
      top_match_seller: topSeller,
      top_match_price:  topPrice,
      top_match_thumbnail: safeCell(top),
      // --- KP metrics (empty for autosuggest / PAA / related rows) ---
      kp_monthly_searches: r.kpMonthlySearches || '',
      kp_competition:      r.kpCompetition     || '',
      kp_bid_low:          r.kpBidLow          || '',
      kp_bid_high:         r.kpBidHigh         || '',
      // --- Autosuggest expansion ---
      autosuggest_count: r.autosuggestCount,
      autosuggestions:   safeCell((r.autosuggestions || []).join(' | ')),
      // --- Amazon Round (R3) ---
      amazon_suggest_count: r.amazon_suggest_count || 0,
      amazon_rank:          r.amazon_rank          || 0,
      amazon_price:         r.amazon_price         || '',
      amazon_rating:        r.amazon_rating        || '',
      amazon_reviews:       r.amazon_reviews       || '',
      amazon_title:         r.amazon_title         || '',
      amazon_competitors:   safeCell(r.amazon_competitors || ''),
      amazon_total_results: r.amazon_total_results || 0,
      // --- Bulky reference data (kept for verification — moved to the end) ---
      matched_thumbnails: safeCell(matchedList),
      matched_sellers:    safeCell(sellersList),
      matched_prices:     safeCell(pricesList),
      // Per-match quality tag (clean / partial_spec_confirmed /
      // ambiguous_brand_match / dhash / url_match). Lets the user filter
      // out ambiguous matches or audit them in Excel.
      matched_qualities:  safeCell((r.matchedQualities || []).join(' | ')),
      ambiguous_match_count: r.ambiguousMatchCount || 0,
      pack_variant_count:    r.packVariantCount     || 0,
      product_url:   r.productUrl,
      product_image: r.productImage,
    };
  });
}

function uint8ToBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function groupByProduct(report) {
  const groups = new Map();
  for (const r of report) {
    const key = r.productUrl || r.productName || '_unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// Prefer SKU for the filename when provided in the input CSV. Falls back to a
// slug derived from the product name.
function fileSlug(sku, productName) {
  const base = (sku && sku.trim()) ? sku : (productName || 'product');
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'product';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Builds a CSV data: URL with UTF-8 BOM so Excel reads non-ASCII correctly.
function csvDataUrl(rows) {
  const ws = XLSX.utils.json_to_sheet(rowsForExport(rows));
  const csv = XLSX.utils.sheet_to_csv(ws);
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const body = new TextEncoder().encode(csv);
  const bytes = new Uint8Array(bom.length + body.length);
  bytes.set(bom, 0);
  bytes.set(body, bom.length);
  return `data:text/csv;base64,${uint8ToBase64(bytes)}`;
}

function xlsxDataUrl(rows) {
  const ws = XLSX.utils.json_to_sheet(rowsForExport(rows));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Discovery');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${uint8ToBase64(bytes)}`;
}

// Single-product CSV — used for auto-export when a product's queue empties.
// Filename intentionally OMITS batchId so a re-export of the same SKU (after
// a resume that re-processed the product) shares a base name with the
// previous file. conflictAction: 'overwrite' replaces any existing file
// with the same name — previously Chrome's default 'uniquify' would suffix
// "(1)", "(2)" each time, so a Stop-mid-product → Resume run produced two
// CSVs per SKU in the Downloads folder. With overwrite the most recent run
// is the only file on disk, which is what "auto-export per product" should
// mean.
export async function exportSingleProductCSV(rows, _batchId) {
  if (!rows || rows.length === 0) throw new Error('No rows for this product.');
  const slug = fileSlug(rows[0].sku, rows[0].productName);
  const filename = `${slug}.csv`;
  await chrome.downloads.download({
    url: csvDataUrl(rows),
    filename,
    saveAs: false,
    conflictAction: 'overwrite',
  });
  return filename;
}

// Build a Chrome-Downloads-safe folder name from an arbitrary batch ID.
// Strips path-traversal characters and anything that isn't filename-safe
// on Windows/macOS/Linux. Keeps it readable for the user.
function _safeFolder(name) {
  return String(name || 'batch')
    .replace(/[^a-z0-9_\-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'batch';
}

// One file per product. Chrome triggers one download per call; we pace them
// so the browser doesn't drop the batch.
//
// opts.folder: if set, every file is nested under that subfolder of the
// Downloads root — Chrome auto-creates the folder. Used by the central
// "Download all CSVs from Supabase" flow so a 23-SKU batch lands as
// Downloads/adbrain_batch_<id>/{sku}.csv instead of 23 loose files at
// the Downloads root.
export async function toCSV(report, batchId, opts = {}) {
  if (!report || report.length === 0) throw new Error('Report is empty.');
  const groups = groupByProduct(report);
  const filenames = [];
  const folder = opts.folder ? _safeFolder(opts.folder) : '';
  for (const [, rows] of groups) {
    const slug = fileSlug(rows[0].sku, rows[0].productName);
    // When folder is set the folder name already disambiguates batches,
    // so the per-file name doesn't need the batchId suffix.
    const filename = folder
      ? `${folder}/${slug}.csv`
      : `${slug}_${batchId || Date.now()}.csv`;
    await chrome.downloads.download({
      url: csvDataUrl(rows),
      filename,
      saveAs: false,
      // Overwrite so re-running the central download replaces previous
      // versions instead of accumulating "(1)", "(2)" copies.
      conflictAction: opts.folder ? 'overwrite' : 'uniquify',
    });
    filenames.push(filename);
    await sleep(250);
  }
  return filenames;
}

// Same folder/overwrite semantics as toCSV — see its doc comment.
export async function toXLSX(report, batchId, opts = {}) {
  if (!report || report.length === 0) throw new Error('Report is empty.');
  const groups = groupByProduct(report);
  const filenames = [];
  const folder = opts.folder ? _safeFolder(opts.folder) : '';
  for (const [, rows] of groups) {
    const slug = fileSlug(rows[0].sku, rows[0].productName);
    const filename = folder
      ? `${folder}/${slug}.xlsx`
      : `${slug}_${batchId || Date.now()}.xlsx`;
    await chrome.downloads.download({
      url: xlsxDataUrl(rows),
      filename,
      saveAs: false,
      conflictAction: opts.folder ? 'overwrite' : 'uniquify',
    });
    filenames.push(filename);
    await sleep(250);
  }
  return filenames;
}

export async function pushToAdBrain(report) {
  if (!report || report.length === 0) throw new Error('Report is empty.');
  const serviceKey = await getServiceKey();
  if (!serviceKey) throw new Error('AdBrain Supabase service_role key not set (Settings tab).');
  const supabaseUrl = await getSupabaseUrl();
  if (!supabaseUrl || supabaseUrl.includes('YOUR-ADBRAIN-PROJECT')) {
    throw new Error('Supabase URL not set (Settings tab — paste your project URL like https://xxxxx.supabase.co).');
  }

  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/${SUPABASE_TABLE}`;
  const BATCH = 100;
  let success = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < report.length; i += BATCH) {
    const slice = report.slice(i, i + BATCH).map(r => {
      const paired = pairMatched(r);
      paired.sort((a, b) => b.conf - a.conf);
      const confs = paired.map(p => p.conf);
      const avg = confs.length ? Math.round(confs.reduce((s, v) => s + v, 0) / confs.length) : 0;
      const max = confs.length ? confs[0] : 0;
      const min = confs.length ? confs[confs.length - 1] : 0;
      const allSellersList = (r.sellers || [])
        .map(s => `${s.domain || ''}${s.price ? ` (${s.price})` : ''}`)
        .filter(Boolean)
        .join(' | ') || null;
      const sellerTitlesList = (r.sellers || [])
        .filter(s => s && s.domain && s.title && s.title.length > 5)
        .map(s => `${s.domain}: ${String(s.title).slice(0, 80)}`)
        .join(' | ') || null;
      return {
        batch_id: r.batchId,
        sku: r.sku || null,
        keyword: r.keyword,
        source: r.source,
        parent_keyword: r.parentKeyword || null,
        serp_url: r.serp_url || null,
        product_name: r.productName,
        product_url: r.productUrl,
        product_image: r.productImage || null,
        priority: r.priority,
        ad_rating: typeof r.adRating === 'number' ? r.adRating : 0,
        frequency: r.frequency || 1,
        intent: r.intent || null,
        topic:  r.topic  || null,
        funnel: r.funnel || null,
        image_count: r.imageCount,
        total_thumbs: r.totalThumbs || r.total_thumbs || 0,
        visibility_pct: (() => {
          const t = r.totalThumbs || r.total_thumbs || 0;
          const m = r.imageCount || 0;
          return t > 0 ? Math.round((m / t) * 100) : (typeof r.visibilityPct === 'number' ? r.visibilityPct : 0);
        })(),
        image_count_unverified: r.imageCountUnverified || 0,
        match_sources:   r.matchSources    || null,
        thumbs_captured: r.thumbsCaptured  || null,
        match_confidence_avg: typeof r.match_confidence_avg === 'number' ? r.match_confidence_avg : avg,
        match_confidence_max: typeof r.match_confidence_max === 'number' ? r.match_confidence_max : max,
        match_confidence_min: typeof r.match_confidence_min === 'number' ? r.match_confidence_min : min,
        total_sellers: r.totalSellers || 0,
        seller_type:   r.seller_type || null,
        ads_on_serp:   r.adsOnSerp    || 0,
        sellers_on_serp: allSellersList,
        seller_titles:   sellerTitlesList,
        kp_monthly_searches: r.kpMonthlySearches || null,
        kp_competition:      r.kpCompetition     || null,
        kp_bid_low:          r.kpBidLow          || null,
        kp_bid_high:         r.kpBidHigh         || null,
        top_match_thumbnail: paired[0] ? paired[0].url : null,
        top_match_seller:    paired[0]?.seller || null,
        top_match_price:     paired[0]?.price  || null,
        matched_thumbnails:  paired.map(p => `${p.url} [${p.conf}]`).join(' | '),
        matched_sellers:     paired.map(p => p.seller).filter(Boolean).join(' | ') || null,
        matched_prices:      paired.map(p => p.price ).filter(Boolean).join(' | ') || null,
        matched_qualities:   (r.matchedQualities || []).join(' | ') || null,
        ambiguous_match_count: r.ambiguousMatchCount || 0,
        pack_variant_count:    r.packVariantCount    || 0,
        autosuggest_count: r.autosuggestCount,
        autosuggestions: (r.autosuggestions || []).join(' | '),
        amazon_suggest_count: r.amazon_suggest_count || 0,
        amazon_rank:          r.amazon_rank          || 0,
        amazon_price:         r.amazon_price         || null,
        amazon_rating:        r.amazon_rating        || null,
        amazon_reviews:       r.amazon_reviews       || null,
        amazon_title:         r.amazon_title         || null,
        amazon_competitors:   r.amazon_competitors   || null,
        amazon_total_results: r.amazon_total_results || 0,
      };
    });
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates',
        },
        body: JSON.stringify(slice),
      });
      if (resp.ok || resp.status === 201) {
        success += slice.length;
      } else {
        failed += slice.length;
        const text = await resp.text();
        errors.push(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      failed += slice.length;
      errors.push(e.message);
    }
  }

  return { success, failed, total: report.length, errors };
}
