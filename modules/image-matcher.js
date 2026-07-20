// modules/image-matcher.js
//
// Engine-facing API for CLIP-based image similarity matching. Imported by
// modules/keyword-discovery.js. Implementation runs in a sandboxed iframe
// inside offscreen.html (see sandbox.html / sandbox.js / offscreen.js).
//
// Model: Xenova/clip-vit-base-patch32 — 512-dim image embeddings, robust to
// crop / angle / lighting / background variation. Cosine similarity ≥ 0.85
// is a good default for "same product".
//
// Why not run TF.js / a model directly here: MV3 extension pages cannot
// enable 'unsafe-eval'; transformers.js + ONNX need it. Only sandboxed pages
// can have 'unsafe-eval' in MV3. Hence the offscreen → sandbox-iframe split.

const TARGET = 'offscreen-image-matcher';
const OFFSCREEN_URL = 'offscreen.html';

let creating = null;
let initialized = false;

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    if (contexts.length > 0) return;
  }
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER'],
      justification: 'Host the CLIP image-matching sandbox iframe (no DOM available in service worker).',
    }).finally(() => { creating = null; });
  }
  await creating;
}

function sendToOffscreen(action, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: TARGET, action, payload },
      (resp) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!resp) { reject(new Error('no response from offscreen')); return; }
        if (resp.ok) resolve(resp);
        else reject(new Error(resp.error || 'offscreen error'));
      }
    );
  });
}

export async function initMatcher() {
  if (initialized) return;
  await ensureOffscreenDocument();
  // The init call BLOCKS until CLIP weights are loaded (~150 MB on first
  // run, ~few seconds when cached in IndexedDB). The caller should treat
  // this as a one-time per-run setup.
  await sendToOffscreen('init');
  initialized = true;
}

// Get a single image's CLIP embedding (512-dim, L2-normalised Float32Array).
export async function getEmbedding(imageUrl) {
  if (!imageUrl) return null;
  try {
    await initMatcher();
    const resp = await sendToOffscreen('embed', { url: imageUrl });
    return resp?.embedding ? new Float32Array(resp.embedding) : null;
  } catch {
    return null;
  }
}

// Embed each of N product image URLs. Each reference now carries BOTH:
//   - .data    Float32Array — CLIP 512-dim embedding (semantic match)
//   - .dhash   {hi, lo}      — 64-bit perceptual hash (fast identity check)
// matchImages uses dhash first (fast) and falls through to CLIP cosine for
// thumbnails that aren't pixel-identical re-encodings.
//
// References are still Float32Array-shaped at the array level (length/iter
// still work) for back-compat with callers that ignore the extra fields.
// Module-level: last error from getReferenceEmbeddings, exposed so the
// engine can include it in the 'CLIP init failed?' activity log entry.
// Previously the catch{ return [] } silently swallowed the reason and
// operators had to guess (WebGL disabled? Model CDN blocked? Quota?).
let _lastRefEmbedError = null;
export function getLastRefEmbedError() { return _lastRefEmbedError; }

export async function getReferenceEmbeddings(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];
  _lastRefEmbedError = null;
  try {
    await initMatcher();
    const resp = await sendToOffscreen('embedReferences', { urls: imageUrls });
    if (!resp?.embeddings) {
      _lastRefEmbedError = 'offscreen returned no embeddings (possible model-load or WebGL failure — check the offscreen document console)';
      return [];
    }
    return resp.embeddings.map(e => {
      // New format: { embedding: [...], dhash: {hi, lo} | null,
      //                colors: [{r,g,b}, ...] }
      if (e && typeof e === 'object' && Array.isArray(e.embedding)) {
        const arr = new Float32Array(e.embedding);
        // Attach dhash + colors as non-enumerable properties so callers that
        // JSON.stringify or iterate the Float32Array don't trip over them.
        Object.defineProperty(arr, 'dhash',  { value: e.dhash  || null, enumerable: false });
        Object.defineProperty(arr, 'colors', { value: e.colors || [],   enumerable: false });
        return arr;
      }
      // Old format: just [float...]
      return new Float32Array(e);
    });
  } catch (e) {
    _lastRefEmbedError = e?.message || String(e);
    return [];
  }
}

export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// Score every candidate URL against the reference set; return sorted.
//
//   referenceEmbeddings — Float32Array[] from getReferenceEmbeddings
//   candidateImageUrls  — string[] (deduplicated inside the sandbox)
//   threshold           — cosine score required for isMatch (default 0.85)
//   opts.includeEmbeddings — attach the candidate embedding to MATCHED results
//                            (used by the per-product noise filter)
//
// Each result: { url, score, isMatch, embedding? }
export async function matchImages(referenceEmbeddings, candidateImageUrls, threshold = 0.85, opts = {}) {
  if (!referenceEmbeddings || !candidateImageUrls || candidateImageUrls.length === 0) return [];
  const refs = Array.isArray(referenceEmbeddings) ? referenceEmbeddings : [referenceEmbeddings];
  if (refs.length === 0) return [];
  await initMatcher();
  try {
    // Send refs as { embedding, dhash } objects. The non-enumerable `dhash`
    // property attached in getReferenceEmbeddings comes through here.
    const resp = await sendToOffscreen('match', {
      referenceEmbeddings: refs.map(e => ({
        embedding: Array.from(e),
        dhash: e.dhash || null,
      })),
      candidateUrls: candidateImageUrls,
      threshold,
      includeEmbeddings: !!opts.includeEmbeddings,
    });
    const results = resp?.results || [];
    if (opts.includeEmbeddings) {
      for (const r of results) {
        if (r.embedding) r.embedding = new Float32Array(r.embedding);
      }
    }
    // Attach tier-breakdown counts on the array so callers can log them.
    Object.defineProperty(results, 'cacheHits',  { value: resp?.cacheHits  || 0, enumerable: false });
    Object.defineProperty(results, 'dhashHits',  { value: resp?.dhashHits  || 0, enumerable: false });
    Object.defineProperty(results, 'clipHits',   { value: resp?.clipHits   || 0, enumerable: false });
    return results;
  } catch {
    return [];
  }
}
