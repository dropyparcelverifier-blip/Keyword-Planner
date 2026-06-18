// modules/discovery-jobs.js
// Distributed work queue — manager uploads products to a shared Supabase
// table, worker PCs atomically claim chunks via the adbrain_claim_jobs RPC,
// process them with the existing engine, and mark each job done as it
// finishes. See supabase_schema.sql for the table definition + RPC bodies.
//
// All operations go through PostgREST (Supabase's HTTP API). Same auth
// (service_role key) as the existing pushToAdBrain flow.

import {
  SUPABASE_TABLE,
  getServiceKey,
  getSupabaseUrl,
} from '../config/discovery-config.js';

export const JOBS_TABLE = 'adbrain_discovery_jobs';
export const JOBS_SUMMARY_VIEW = 'adbrain_discovery_job_summary';
export const CLAIM_RPC = 'adbrain_claim_jobs';
export const RELEASE_RPC = 'adbrain_release_stale_jobs';

// Build the auth/headers block every PostgREST call needs.
async function _supabaseHeaders() {
  const serviceKey = await getServiceKey();
  if (!serviceKey) throw new Error('AdBrain Supabase service_role key not set (Settings tab).');
  const supabaseUrl = await getSupabaseUrl();
  if (!supabaseUrl || supabaseUrl.includes('YOUR-ADBRAIN-PROJECT')) {
    throw new Error('Supabase URL not set (Settings tab).');
  }
  return {
    base: supabaseUrl.replace(/\/+$/, ''),
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  };
}

// MANAGER: bulk-upload products to the jobs table for distribution. Each
// product becomes one row with status='pending'. Upsert on (batch_id,
// product_url) so re-uploading the same file is idempotent — already-done
// jobs keep their status, only new SKUs get added.
export async function uploadJobsToManager(products, batchId) {
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('No products to upload.');
  }
  if (!batchId) batchId = String(Date.now());
  const { base, headers } = await _supabaseHeaders();

  const rawRows = products.map(p => ({
    batch_id:     batchId,
    sku:          p.sku || null,
    product_url:  String(p.url || '').trim(),
    product_name: p.productName || p.name || null,
    priority:     typeof p.priority === 'number' ? p.priority : 100,
    handles:      Array.isArray(p.handles) ? p.handles.join('|') : (p.handles || null),
    brands:       Array.isArray(p.brands)  ? p.brands.join('|')  : (p.brands  || null),
    status:       'pending',
  })).filter(r => r.product_url);

  if (rawRows.length === 0) throw new Error('No valid product URLs in upload.');

  // Deduplicate on (batch_id, product_url) BEFORE sending. PostgREST's
  // merge-duplicates strategy translates to `ON CONFLICT DO UPDATE`,
  // which fails with Postgres error 21000 when the same conflict key
  // appears twice in one INSERT statement. So if the input file has
  // two rows with the same product_url (intentionally or by accident),
  // the whole batch upsert blows up with HTTP 500. Keep the LAST
  // occurrence of each key — that's what the user usually intends when
  // they have a row appearing twice (latest value wins).
  const dedupMap = new Map();
  for (const r of rawRows) {
    dedupMap.set(`${r.batch_id}|${r.product_url}`, r);
  }
  const rows = Array.from(dedupMap.values());
  const dupDropped = rawRows.length - rows.length;

  // Upsert on the (batch_id, product_url) unique constraint. on_conflict
  // tells PostgREST which columns to use; resolution=merge-duplicates
  // makes it UPDATE existing rows (so re-upload refreshes priority/
  // handles/brands without resetting status — workers won't lose their
  // claims). return=representation makes PostgREST return the actual
  // rows inserted/updated so we can count them accurately. Previously
  // we used return=minimal and assumed slice.length on HTTP 200, which
  // produced false-success "Uploaded N/M" messages when the API
  // succeeded but actually inserted 0 rows (e.g. due to RLS / type
  // mismatch — which surfaced in the UI as "✓ Uploaded 0/2").
  const url = `${base}/rest/v1/${JOBS_TABLE}?on_conflict=batch_id,product_url`;
  const BATCH = 100;
  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(slice),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      errors.push(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
      continue;
    }
    // Count actual returned rows — not the slice length. If PostgREST
    // ignored the rows (RLS, duplicate keys with different semantics,
    // etc.) we'll see < slice.length and can surface the discrepancy.
    try {
      const returned = await resp.json();
      inserted += Array.isArray(returned) ? returned.length : 0;
    } catch {
      // If the body isn't JSON for some reason, fall back to assuming
      // success — but only when HTTP was 200/201.
      inserted += slice.length;
    }
  }
  return { uploaded: inserted, total: rows.length, batchId, errors, duplicatesDropped: dupDropped };
}

// WORKER: atomically claim up to `limit` pending jobs for this worker.
// Uses the adbrain_claim_jobs RPC which wraps a SELECT … FOR UPDATE SKIP
// LOCKED + UPDATE, so concurrent claims from multiple PCs never collide.
// Returns an array of job rows (with id field — needed for mark-done).
export async function claimJobs({ workerId, batchId, limit = 5 }) {
  if (!workerId)  throw new Error('Worker ID required.');
  if (!batchId)   throw new Error('Batch ID required (pick one in the Manager tab).');
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/rpc/${CLAIM_RPC}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      p_worker_id: workerId,
      p_batch_id:  batchId,
      p_limit:     limit,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Claim failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

// WORKER: heartbeat — refresh heartbeat_at on every job claimed by this
// worker that's still in-flight. Called every 60s by the alarm. If a PC
// dies, no heartbeat for >10min → releaseStaleJobs frees its claims.
export async function heartbeatClaims(workerId, jobIds) {
  if (!workerId) return { updated: 0 };
  if (!Array.isArray(jobIds) || jobIds.length === 0) return { updated: 0 };
  const { base, headers } = await _supabaseHeaders();
  // PATCH rows WHERE id IN (...) AND claimed_by = workerId (safety: don't
  // touch other workers' rows even if jobIds list got crossed).
  const inList = `(${jobIds.map(n => Number(n)).filter(Number.isFinite).join(',')})`;
  const url = `${base}/rest/v1/${JOBS_TABLE}?id=in.${inList}&claimed_by=eq.${encodeURIComponent(workerId)}&status=eq.claimed`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ heartbeat_at: new Date().toISOString() }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { updated: 0, error: `HTTP ${resp.status}: ${text.slice(0, 120)}` };
  }
  return { updated: jobIds.length };
}

// WORKER: mark a single job done by product_url (engine doesn't know job
// id; it works in URL terms). Status transition: claimed → done.
export async function markJobDone({ workerId, batchId, productUrl }) {
  if (!workerId || !batchId || !productUrl) return { updated: 0 };
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/${JOBS_TABLE}`
    + `?batch_id=eq.${encodeURIComponent(batchId)}`
    + `&product_url=eq.${encodeURIComponent(productUrl)}`
    + `&claimed_by=eq.${encodeURIComponent(workerId)}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      status: 'done',
      done_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { updated: 0, error: `HTTP ${resp.status}: ${text.slice(0, 120)}` };
  }
  return { updated: 1 };
}

// WORKER (or anyone): release stale claims (no heartbeat in >10 min) so
// other PCs can pick them up. Called by every worker on each claim cycle —
// distributed cleanup, no central scheduler needed.
export async function releaseStaleJobs(staleMinutes = 10) {
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/rpc/${RELEASE_RPC}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_stale_minutes: staleMinutes }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { released: 0, error: `HTTP ${resp.status}: ${text.slice(0, 120)}` };
  }
  const count = await resp.json().catch(() => 0);
  return { released: Number(count) || 0 };
}

// MANAGER UI: pull batch summary (counts by status, per batch). Used by the
// Manager tab's live status panel.
//
// First-try path: PostgREST view `adbrain_discovery_job_summary`. This is
// efficient because the DB does the aggregation. But on a freshly-migrated
// project PostgREST's schema cache may not include the view yet, returning
// a 404 PGRST205. When that happens we fall back to querying the table
// directly and aggregating in JS — same result, slightly more bandwidth,
// always works.
export async function getJobSummary() {
  const { base, headers } = await _supabaseHeaders();
  // Path 1: the view
  try {
    const url = `${base}/rest/v1/${JOBS_SUMMARY_VIEW}?order=batch_id.desc&limit=20`;
    const resp = await fetch(url, { method: 'GET', headers });
    if (resp.ok) return resp.json();
    // 404 with PGRST205 = view not in schema cache. Try the fallback.
    const text = await resp.text().catch(() => '');
    if (resp.status !== 404 && !text.includes('PGRST205')) {
      throw new Error(`Summary fetch failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
    // fall through to fallback
  } catch (e) {
    // Network error: also fall through.
  }
  // Path 2: aggregate from the table directly. Fetch up to 10k rows per
  // call (PostgREST default cap is 1000 so use Range). For a typical
  // multi-PC run with < 500 jobs/batch this is one round trip.
  const tableUrl = `${base}/rest/v1/${JOBS_TABLE}?select=batch_id,status,claimed_by,done_at`;
  const resp = await fetch(tableUrl, {
    method: 'GET',
    headers: { ...headers, 'Range-Unit': 'items', 'Range': '0-9999' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Summary fallback fetch failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  const rows = await resp.json();
  return _aggregateJobsByBatch(rows);
}

// Fallback aggregator — replicates the view's GROUP BY batch_id +
// counts-per-status + active-worker count, in JS.
function _aggregateJobsByBatch(rows) {
  const byBatch = new Map();
  for (const r of rows) {
    const b = r.batch_id;
    if (!byBatch.has(b)) {
      byBatch.set(b, {
        batch_id: b, total: 0, pending: 0, claimed: 0, done: 0, failed: 0,
        active_workers: new Set(), last_done_at: null,
      });
    }
    const agg = byBatch.get(b);
    agg.total++;
    if (r.status === 'pending') agg.pending++;
    else if (r.status === 'claimed') {
      agg.claimed++;
      if (r.claimed_by) agg.active_workers.add(r.claimed_by);
    }
    else if (r.status === 'done')   agg.done++;
    else if (r.status === 'failed') agg.failed++;
    if (r.done_at && (!agg.last_done_at || r.done_at > agg.last_done_at)) {
      agg.last_done_at = r.done_at;
    }
  }
  return Array.from(byBatch.values())
    .map(b => ({ ...b, active_workers: b.active_workers.size }))
    .sort((a, b) => String(b.batch_id).localeCompare(String(a.batch_id)));
}

// MANAGER UI: pull every discovered-keyword row for a batch back from
// Supabase so the manager PC can generate the per-SKU CSVs locally.
// Solves the "CSVs are scattered across worker PCs' Downloads folders"
// problem — the manager runs this once and gets one .csv per SKU for
// the whole batch, regardless of which worker processed each SKU.
//
// Paginated via PostgREST's Range header (default cap is 1000 rows).
// Converts snake_case columns back to the camelCase shape that toCSV/
// fileSlug/etc expect, mirroring the inverse of pushToAdBrain's mapping.
export async function fetchBatchReportFromSupabase(batchId, onProgress) {
  if (!batchId) throw new Error('Batch ID required.');
  const { base, headers } = await _supabaseHeaders();
  const PAGE = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    const url = `${base}/rest/v1/adbrain_discovered_keywords`
      + `?batch_id=eq.${encodeURIComponent(batchId)}`
      + `&select=*&order=product_url.asc,id.asc`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { ...headers, 'Range-Unit': 'items', 'Range': `${from}-${from + PAGE - 1}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Fetch failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
    }
    const page = await resp.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    onProgress?.({ fetched: out.length });
    if (page.length < PAGE) break;
    from += PAGE;
  }
  // Convert snake_case Supabase columns into the camelCase row shape
  // that modules/discovery-export.js (toCSV, groupByProduct, fileSlug,
  // rowsForExport) expects. This is the inverse of the mapping in
  // pushToAdBrain — keep them in sync if columns change.
  return out.map(r => ({
    batchId:               r.batch_id,
    sku:                   r.sku,
    keyword:               r.keyword,
    source:                r.source,
    parentKeyword:         r.parent_keyword,
    productName:           r.product_name,
    productUrl:            r.product_url,
    productImage:          r.product_image,
    priority:              r.priority,
    adRating:              r.ad_rating,
    frequency:             r.frequency,
    intent:                r.intent,
    topic:                 r.topic,
    funnel:                r.funnel,
    imageCount:            r.image_count,
    imageCountUnverified:  r.image_count_unverified,
    totalThumbs:           r.total_thumbs,
    visibilityPct:         r.visibility_pct,
    matchSources:          r.match_sources,
    thumbsCaptured:        r.thumbs_captured,
    match_confidence_avg:  r.match_confidence_avg,
    match_confidence_max:  r.match_confidence_max,
    match_confidence_min:  r.match_confidence_min,
    totalSellers:          r.total_sellers,
    seller_type:           r.seller_type,
    adsOnSerp:             r.ads_on_serp,
    sellers_on_serp:       r.sellers_on_serp,
    seller_titles:         r.seller_titles,
    serp_url:              r.serp_url,
    kpMonthlySearches:     r.kp_monthly_searches,
    kpCompetition:         r.kp_competition,
    kpBidLow:              r.kp_bid_low,
    kpBidHigh:             r.kp_bid_high,
    autosuggestCount:      r.autosuggest_count,
    autosuggestions:       r.autosuggestions,
    amazonSuggestCount:    r.amazon_suggest_count,
    amazonRank:            r.amazon_rank,
    amazonPrice:           r.amazon_price,
    amazonRating:          r.amazon_rating,
    amazonReviews:         r.amazon_reviews,
    amazonTitle:           r.amazon_title,
    amazonCompetitors:     r.amazon_competitors,
    amazonTotalResults:    r.amazon_total_results,
    topMatchSeller:        r.top_match_seller,
    topMatchPrice:         r.top_match_price,
    topMatchThumbnail:     r.top_match_thumbnail,
    matched_thumbnails:    r.matched_thumbnails,
    matched_sellers:       r.matched_sellers,
    matched_prices:        r.matched_prices,
  }));
}

// MANAGER UI: per-batch detail — list current claims (claimed_by + count)
// AND each worker's lifetime done count for the batch, so the manager
// sees "PC-A: 5 in flight, 12 done" instead of just the in-flight count.
// Used by the live-status panel's per-worker breakdown.
export async function getActiveWorkers(batchId) {
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/${JOBS_TABLE}`
    + `?batch_id=eq.${encodeURIComponent(batchId)}`
    + `&select=claimed_by,heartbeat_at,status`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { ...headers, 'Range-Unit': 'items', 'Range': '0-9999' },
  });
  if (!resp.ok) return [];
  const rows = await resp.json().catch(() => []);
  const byWorker = new Map();
  for (const r of rows) {
    // Skip pending rows — they don't have a worker attribution yet.
    if (!r.claimed_by && r.status !== 'done' && r.status !== 'failed') continue;
    const w = r.claimed_by || '(unknown)';
    const cur = byWorker.get(w) || {
      worker: w, inFlight: 0, doneCount: 0, failedCount: 0, lastHeartbeat: null,
    };
    if (r.status === 'claimed') {
      cur.inFlight++;
      if (r.heartbeat_at && (!cur.lastHeartbeat || r.heartbeat_at > cur.lastHeartbeat)) {
        cur.lastHeartbeat = r.heartbeat_at;
      }
    } else if (r.status === 'done')   cur.doneCount++;
    else if (r.status === 'failed') cur.failedCount++;
    byWorker.set(w, cur);
  }
  return Array.from(byWorker.values())
    .sort((a, b) => (b.inFlight + b.doneCount) - (a.inFlight + a.doneCount));
}

// MANAGER UI: list failed jobs for a batch — surface which PC failed which
// product and why, so the manager can re-queue / debug / blame the right
// thing. Capped at 50 rows to keep the panel readable.
export async function getFailedJobs(batchId, limit = 50) {
  if (!batchId) return [];
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/${JOBS_TABLE}`
    + `?batch_id=eq.${encodeURIComponent(batchId)}`
    + `&status=eq.failed`
    + `&select=id,sku,product_name,product_url,claimed_by,failed_reason,attempts,claimed_at`
    + `&order=claimed_at.desc.nullslast`
    + `&limit=${Math.max(1, Math.min(500, limit))}`;
  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) return [];
  return resp.json().catch(() => []);
}

// MANAGER UI: re-queue a failed job. Sets status back to 'pending' and
// clears the claim/failure fields so any worker can pick it up again.
// Useful when a worker hits a transient error (network, CAPTCHA, KP
// timeout) and the manager wants to retry without re-uploading.
export async function requeueJob(jobId) {
  if (!jobId) return { updated: 0, error: 'job id required' };
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/${JOBS_TABLE}?id=eq.${Number(jobId)}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      status: 'pending', claimed_by: null, claimed_at: null,
      heartbeat_at: null, failed_reason: null,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { updated: 0, error: `HTTP ${resp.status}: ${text.slice(0, 120)}` };
  }
  return { updated: 1 };
}
