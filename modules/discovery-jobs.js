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

  const rows = products.map(p => ({
    batch_id:     batchId,
    sku:          p.sku || null,
    product_url:  String(p.url || '').trim(),
    product_name: p.productName || p.name || null,
    priority:     typeof p.priority === 'number' ? p.priority : 100,
    handles:      Array.isArray(p.handles) ? p.handles.join('|') : (p.handles || null),
    brands:       Array.isArray(p.brands)  ? p.brands.join('|')  : (p.brands  || null),
    status:       'pending',
  })).filter(r => r.product_url);

  if (rows.length === 0) throw new Error('No valid product URLs in upload.');

  // Upsert on the (batch_id, product_url) unique constraint. on_conflict
  // tells PostgREST which columns to use; ignore_duplicates=false makes it
  // UPDATE (so re-upload refreshes priority/handles/brands on existing rows
  // without resetting status — workers won't lose their claims).
  const url = `${base}/rest/v1/${JOBS_TABLE}?on_conflict=batch_id,product_url`;
  const BATCH = 100;
  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(slice),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      errors.push(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      continue;
    }
    inserted += slice.length;
  }
  return { uploaded: inserted, total: rows.length, batchId, errors };
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
export async function getJobSummary() {
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/${JOBS_SUMMARY_VIEW}?order=batch_id.desc&limit=20`;
  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Summary fetch failed (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// MANAGER UI: per-batch detail — list current claims (claimed_by + count)
// so the user can see "PC-A is on 5 jobs, PC-B is on 3".
export async function getActiveWorkers(batchId) {
  const { base, headers } = await _supabaseHeaders();
  const url = `${base}/rest/v1/${JOBS_TABLE}`
    + `?batch_id=eq.${encodeURIComponent(batchId)}`
    + `&status=eq.claimed`
    + `&select=claimed_by,heartbeat_at`;
  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) return [];
  const rows = await resp.json().catch(() => []);
  // Group by worker.
  const byWorker = new Map();
  for (const r of rows) {
    const w = r.claimed_by || '(unknown)';
    const cur = byWorker.get(w) || { worker: w, count: 0, lastHeartbeat: null };
    cur.count++;
    if (r.heartbeat_at && (!cur.lastHeartbeat || r.heartbeat_at > cur.lastHeartbeat)) {
      cur.lastHeartbeat = r.heartbeat_at;
    }
    byWorker.set(w, cur);
  }
  return Array.from(byWorker.values()).sort((a, b) => b.count - a.count);
}
