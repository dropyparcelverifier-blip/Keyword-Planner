// sandbox.js — runs inside sandbox.html (sandboxed extension page).
//
// Runs CLIP image-feature extraction via @xenova/transformers and answers
// embed / match requests from the parent offscreen.html via postMessage.
//
// Model: Xenova/clip-vit-base-patch32 — 512-dim image embeddings, robust to
// crop/angle/lighting variations. Downloads ~150 MB from HuggingFace CDN on
// first use; IndexedDB-cached for subsequent runs.
//
// Sandboxed pages have:
//   - 'unsafe-eval' and 'wasm-unsafe-eval' allowed (default sandbox CSP)
//   - null origin (chrome.* APIs not available)
//   - postMessage to the parent as the only channel back
//
// Wire protocol with offscreen.html (matches earlier sandbox attempt):
//   incoming:  { id, action, payload }
//   outgoing:  { id, ok: true,  ...result }  or  { id, ok: false, error }
//
// Actions:
//   init             — initialize CLIP (heavy first-run, then cached)
//   embed            — embed one image URL
//   embedReferences  — embed multiple product image URLs (no augmentation;
//                      CLIP is robust enough that augmentation isn't needed)
//   match            — score a list of candidate URLs vs. reference embeddings,
//                      return max-cosine per candidate

const MODEL_NAME = 'Xenova/clip-vit-base-patch32';

let extractorPromise = null;
let extractor = null;

function waitForTransformers(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (window.__transformers?.pipeline) { resolve(window.__transformers); return; }
    const onReady = () => { window.removeEventListener('transformers-ready', onReady); resolve(window.__transformers); };
    window.addEventListener('transformers-ready', onReady);
    setTimeout(() => {
      window.removeEventListener('transformers-ready', onReady);
      if (window.__transformers?.pipeline) resolve(window.__transformers);
      else reject(new Error('transformers.js did not load within ' + timeoutMs + ' ms'));
    }, timeoutMs);
  });
}

async function loadExtractor() {
  if (extractor) return extractor;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const t = await waitForTransformers();
      // image-feature-extraction returns embeddings for image input
      const ex = await t.pipeline('image-feature-extraction', MODEL_NAME, {
        // quantized: cuts model size + memory, slight accuracy hit (~1%)
        quantized: true,
      });
      extractor = ex;
      return ex;
    })().catch(err => { extractorPromise = null; throw err; });
  }
  return extractorPromise;
}

function l2normalize(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
  return out;
}
function cosineSim(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// ============ dHash pre-filter ============
// Fast (~3-5ms) perceptual hash check before the slow CLIP inference. Catches
// re-encoded / lightly-resized copies of the product image at near-zero cost.
// Hamming ≤ DHASH_HIT_THRESHOLD => instant match, skip CLIP.
const DHASH_HIT_THRESHOLD = 10; // bits out of 64

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}
function hamming(a, b) {
  if (!a || !b) return 64;
  return popcount(a.hi ^ b.hi) + popcount(a.lo ^ b.lo);
}

// 9x8 grayscale → 64 bits (one per cell horizontally).
// ============ Dominant-color extraction ============
//
// Signal 2 of the multi-signal product-match pipeline. Two supplement bottles
// from different brands look identical to CLIP (same shape, same generic
// label layout). What differs is the BRAND PALETTE — NOW Foods uses orange,
// Solaray uses green/white, Baidyanath uses brown/gold. K-means on the
// non-background pixels surfaces that palette quickly enough to run on every
// SERP thumbnail without changing the SERP dwell time.
//
// Output: array of up to 3 {r,g,b} dominant colors per image, in cluster-size
// order. Engine uses these alongside the reference product's colors.

const COLOR_CACHE_MAX = 1500;
const colorCache = new Map();

function _dominantColorsFromImageData(imageData, k = 3) {
  const data = imageData.data;
  const pixels = [];
  // Sample every 4th pixel; skip near-white (background) / near-black / transparent.
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    if (r > 240 && g > 240 && b > 240) continue;
    if (r < 15  && g < 15  && b < 15)  continue;
    pixels.push([r, g, b]);
  }
  if (pixels.length < 10) return [];
  // Init centers at evenly-spaced sample positions.
  const centers = [];
  for (let i = 0; i < k; i++) centers.push([...pixels[Math.floor(i * pixels.length / k)]]);
  // K-means, 10 iterations is plenty for k=3.
  for (let iter = 0; iter < 10; iter++) {
    const clusters = Array.from({ length: k }, () => []);
    for (const px of pixels) {
      let minD = Infinity, closest = 0;
      for (let c = 0; c < centers.length; c++) {
        const d = (px[0] - centers[c][0]) ** 2
                + (px[1] - centers[c][1]) ** 2
                + (px[2] - centers[c][2]) ** 2;
        if (d < minD) { minD = d; closest = c; }
      }
      clusters[closest].push(px);
    }
    for (let c = 0; c < k; c++) {
      if (clusters[c].length === 0) continue;
      const sum = [0, 0, 0];
      for (const px of clusters[c]) { sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; }
      centers[c] = sum.map(v => Math.round(v / clusters[c].length));
    }
  }
  // Return in cluster-size order (most-dominant first) so the engine's
  // matcher compares the dominant ref color against the dominant thumb color.
  const tagged = centers.map((c, i) => ({ c, count: 0, idx: i }));
  for (const px of pixels) {
    let minD = Infinity, closest = 0;
    for (let i = 0; i < tagged.length; i++) {
      const d = (px[0] - tagged[i].c[0]) ** 2
              + (px[1] - tagged[i].c[1]) ** 2
              + (px[2] - tagged[i].c[2]) ** 2;
      if (d < minD) { minD = d; closest = i; }
    }
    tagged[closest].count++;
  }
  tagged.sort((a, b) => b.count - a.count);
  return tagged.map(t => ({ r: t.c[0], g: t.c[1], b: t.c[2] }));
}

// Hosts known to reject cross-origin fetches from sandbox (origin: null).
// Sandbox contexts are ALWAYS null-origin so any host without Access-Control-
// Allow-Origin:* returns opaque failures. These are the observed high-volume
// offenders — Instagram CDN especially appears in every Google Images SERP.
// Skipping upfront avoids the fetch noise AND saves the wall-clock cost of
// starting the request. Long-term fix is routing through background SW which
// bypasses CORS; this short-circuit cuts the loudest cases immediately.
const CORS_BLOCKED_HOSTS = [
  'scontent.cdninstagram.com',
  'scontent.fbcdn.net',
  'scontent-',            // matches all Meta CDN regional subdomains (scontent-lhr8-1, etc.)
  'lookaside.fbsbx.com',
  'instagram.com',
  'cdninstagram.com',
  'pinimg.com',           // Pinterest — also strict about CORS from null origin
];
function isKnownCorsBlocked(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return CORS_BLOCKED_HOSTS.some(h => host.includes(h));
  } catch { return false; }
}

async function fetchAndExtractColors(url) {
  if (colorCache.has(url)) {
    const v = colorCache.get(url);
    colorCache.delete(url); colorCache.set(url, v); // LRU touch
    return v;
  }
  if (isKnownCorsBlocked(url)) { colorCache.set(url, []); return []; }
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) { colorCache.set(url, []); return []; }
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/') && blob.size < 100) { colorCache.set(url, []); return []; }
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    const imageData = ctx.getImageData(0, 0, 64, 64);
    bitmap.close?.();
    const colors = _dominantColorsFromImageData(imageData, 3);
    colorCache.set(url, colors);
    if (colorCache.size > COLOR_CACHE_MAX) {
      const firstKey = colorCache.keys().next().value;
      colorCache.delete(firstKey);
    }
    return colors;
  } catch {
    colorCache.set(url, []);
    return [];
  }
}

function _colorsFromCanvas(canvas) {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return _dominantColorsFromImageData(imageData, 3);
  } catch { return []; }
}

async function fetchAndDHash(url) {
  if (isKnownCorsBlocked(url)) return null;
  try {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/') && blob.size < 100) return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 9; canvas.height = 8;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 9, 8);
    const data = ctx.getImageData(0, 0, 9, 8).data;
    bitmap.close?.();
    const gray = new Uint8Array(72);
    for (let i = 0; i < 72; i++) {
      gray[i] = (data[i*4]*0.299 + data[i*4+1]*0.587 + data[i*4+2]*0.114) | 0;
    }
    let hi = 0, lo = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (gray[y*9 + x] > gray[y*9 + x + 1]) {
          const bit = y * 8 + x;
          if (bit < 32) lo |= (1 << bit); else hi |= (1 << (bit - 32));
        }
      }
    }
    return { hi: hi >>> 0, lo: lo >>> 0 };
  } catch {
    return null;
  }
}

async function embedUrl(url) {
  const ex = await loadExtractor();
  // transformers.js fetches the URL itself (CORS rules apply). RawImage layer
  // handles decode + resize. Output: { data: Float32Array, dims: [1, 512] }.
  const out = await ex(url);
  // out.data is typically a Float32Array of length 512 (one image)
  return l2normalize(out.data);
}

// In-memory LRU. Heavy lifting is the model inference, so this cache is the
// difference between "fast subsequent runs" and "slow always".
const embCache = new Map();
const EMB_CACHE_MAX = 1500;

// Per-URL match-result cache. Saved as { score, isMatch, via, hamming? } so
// the same SERP thumbnail appearing across multiple keyword queries doesn't
// repeat the fetch + dHash + CLIP work. Invalidated when reference set
// changes (between products). LRU eviction at MATCH_CACHE_MAX.
const matchCache = new Map();
const MATCH_CACHE_MAX = 2000;
let matchCacheRefsId = null;
async function getCachedEmbedding(url) {
  if (embCache.has(url)) {
    const e = embCache.get(url);
    embCache.delete(url);
    embCache.set(url, e);
    return e;
  }
  // Short-circuit hosts that will fail CORS on the transformers.js fetch.
  // Cache a null so we don't retry, keep embedUrl call semantics stable.
  if (isKnownCorsBlocked(url)) { embCache.set(url, null); return null; }
  const e = await embedUrl(url);
  embCache.set(url, e);
  if (embCache.size > EMB_CACHE_MAX) {
    const firstKey = embCache.keys().next().value;
    embCache.delete(firstKey);
  }
  return e;
}

// Render a transformed copy of the bitmap onto a 224x224 canvas, return both
// the canvas (for CLIP embedding) and its dHash (computed before CLIP runs
// so we don't decode twice). Opts:
//   flipH        — horizontal flip (catches mirror-view product photos)
//   zoom         — 1.0 = fit; >1 = crop in (focus on product center)
//   offsetX/Y    — 0..1, fraction of remaining space to shift the image
//   brightness   — -0.2 .. +0.2 additive RGB offset
function renderAugmented(bitmap, opts = {}) {
  const { flipH = false, zoom = 1, offsetX = 0.5, offsetY = 0.5, brightness = 0 } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = 224; canvas.height = 224;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 224, 224);

  const baseScale = Math.min(224 / bitmap.width, 224 / bitmap.height);
  const scale = baseScale * zoom;
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  // With zoom > 1, drawW/drawH may exceed 224. offsetX/Y biases which crop
  // we keep (0 = leftmost / top, 0.5 = center, 1 = rightmost / bottom).
  const dx = (224 - drawW) * offsetX;
  const dy = (224 - drawH) * offsetY;

  if (flipH) {
    ctx.save();
    ctx.translate(224, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(bitmap, 224 - dx - drawW, dy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(bitmap, dx, dy, drawW, drawH);
  }

  if (brightness !== 0) {
    const img = ctx.getImageData(0, 0, 224, 224);
    const d = img.data;
    const delta = Math.round(brightness * 255);
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = Math.max(0, Math.min(255, d[i]     + delta));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + delta));
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

// Compute dHash from any HTMLCanvasElement (used for augmented variants
// where we have a canvas, not a URL).
function dHashFromCanvas(canvas) {
  const small = document.createElement('canvas');
  small.width = 9; small.height = 8;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;
  const gray = new Uint8Array(72);
  for (let i = 0; i < 72; i++) {
    gray[i] = (data[i*4]*0.299 + data[i*4+1]*0.587 + data[i*4+2]*0.114) | 0;
  }
  let hi = 0, lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (gray[y*9 + x] > gray[y*9 + x + 1]) {
        const bit = y * 8 + x;
        if (bit < 32) lo |= (1 << bit); else hi |= (1 << (bit - 32));
      }
    }
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

// Embed a canvas via CLIP (pipeline accepts canvas-derived blob).
async function embedCanvas(canvas) {
  const ex = await loadExtractor();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  const out = await ex(blob);
  return l2normalize(out.data);
}

async function buildReferenceEmbeddings(urls) {
  // Each reference carries BOTH a CLIP embedding (semantic match) and a
  // dHash (fast pixel-identity check). Tier 1 = real product photos from
  // Shopify. Tier 2 = if too few real photos succeeded, augment the first
  // one with flips/crops/brightness so the matcher has multiple "views" to
  // compare against (catches side-view/angled/cropped SERP thumbnails).
  const refs = [];
  const seenUrls = new Set();
  let firstBitmap = null;

  for (const u of urls) {
    if (!u || seenUrls.has(u)) continue;
    seenUrls.add(u);
    try {
      const [embedding, dhash, colors] = await Promise.all([
        embedUrl(u),
        fetchAndDHash(u),
        fetchAndExtractColors(u),
      ]);
      refs.push({ embedding, dhash, colors });
      // Stash the first successful bitmap for potential augmentation below.
      if (!firstBitmap && !isKnownCorsBlocked(u)) {
        try {
          const resp = await fetch(u, { credentials: 'omit' });
          if (resp.ok) {
            const blob = await resp.blob();
            firstBitmap = await createImageBitmap(blob);
          }
        } catch {}
      }
    } catch {}
    if (refs.length >= 6) break;
  }

  // Augment when we have only 1-2 real references — gives the matcher more
  // viewpoints (flip, two off-center crops, two brightness shifts).
  if (refs.length < 3 && firstBitmap) {
    const augs = [
      { flipH: true,  zoom: 1.0 },                       // mirror-view
      { zoom: 1.3, offsetX: 0.3, offsetY: 0.5 },          // crop-left
      { zoom: 1.3, offsetX: 0.7, offsetY: 0.5 },          // crop-right
      { zoom: 1.5, offsetX: 0.5, offsetY: 0.5 },          // tight center
      { zoom: 1.0, brightness:  0.12 },                    // brighter
      { zoom: 1.0, brightness: -0.12 },                    // darker
    ];
    for (const opts of augs) {
      if (refs.length >= 6) break;
      try {
        const canvas = renderAugmented(firstBitmap, opts);
        const [embedding, dhash] = await Promise.all([
          embedCanvas(canvas),
          Promise.resolve(dHashFromCanvas(canvas)),
        ]);
        const colors = _colorsFromCanvas(canvas);
        refs.push({ embedding, dhash, colors });
      } catch {}
    }
  }
  if (firstBitmap) firstBitmap.close?.();
  return refs;
}

async function handleAction(action, payload) {
  if (action === 'init') {
    await loadExtractor();
    return { modelName: MODEL_NAME };
  }
  if (action === 'embed') {
    const emb = await getCachedEmbedding(payload.url);
    return { embedding: Array.from(emb) };
  }
  if (action === 'embedReferences') {
    const refs = await buildReferenceEmbeddings(payload.urls || []);
    // Wire format: array of { embedding: [...], dhash: {hi, lo} | null,
    //                          colors: [{r,g,b}, ...] }.
    return {
      embeddings: refs.map(r => ({
        embedding: r.embedding ? Array.from(r.embedding) : null,
        dhash:  r.dhash  || null,
        colors: r.colors || [],
      })),
      count: refs.length,
    };
  }
  if (action === 'match') {
    let refsRaw = payload.referenceEmbeddings;
    if (!Array.isArray(refsRaw) || refsRaw.length === 0) {
      throw new Error('no reference embeddings provided');
    }
    const refs = refsRaw.map(r => {
      if (Array.isArray(r)) return { embedding: new Float32Array(r), dhash: null };
      return {
        embedding: r.embedding ? new Float32Array(r.embedding) : null,
        dhash: r.dhash || null,
      };
    });
    const refDhashes = refs.map(r => r.dhash).filter(Boolean);
    const refEmbeddings = refs.map(r => r.embedding).filter(Boolean);

    // Invalidate per-URL match cache when the reference set changes (i.e.
    // we moved to a new product). The cache holds {score, isMatch, via}
    // per URL — reusing it across products would give nonsense matches.
    const refsId = refDhashes.map(d => (d?.hi >>> 0) + ':' + (d?.lo >>> 0)).join('|');
    if (refsId !== matchCacheRefsId) {
      matchCache.clear();
      matchCacheRefsId = refsId;
    }

    const urls = Array.from(new Set(payload.candidateUrls || []));
    const threshold = typeof payload.threshold === 'number' ? payload.threshold : 0.85;
    const includeEmbeddings = !!payload.includeEmbeddings;
    const results = [];
    let cacheHits = 0, dhashHits = 0, clipHits = 0;

    // Kick off color extraction for ALL candidate URLs in parallel up front.
    // Colors live in their own cache so the same SERP thumbnail across many
    // keyword queries only pays the fetch + k-means cost once. Each result
    // below gets colors attached when we assemble it.
    const colorPromises = new Map();
    for (const u of urls) colorPromises.set(u, fetchAndExtractColors(u));

    const needsClip = [];

    // === Tier 0: per-URL cache lookup ===
    // Same thumbnail appearing across multiple keyword SERPs is common
    // (Google's top results overlap heavily for similar queries).
    const remainingForDhash = [];
    for (const u of urls) {
      if (matchCache.has(u)) {
        const cached = matchCache.get(u);
        results.push({ ...cached, url: u });
        cacheHits++;
      } else {
        remainingForDhash.push(u);
      }
    }

    // === Tier A: dHash fast pre-filter ===
    // dHash is fetch + canvas-decode + 72-byte gray array — all I/O-bound,
    // safe to parallelise across all candidates. Concurrent fetches use the
    // browser's own request scheduler.
    if (refDhashes.length === 0) {
      // No refs to compare against — everything falls through to CLIP.
      for (const u of remainingForDhash) needsClip.push(u);
    } else {
      const dhashResults = await Promise.all(remainingForDhash.map(async u => {
        const thumbDhash = await fetchAndDHash(u);
        return { u, thumbDhash };
      }));
      for (const { u, thumbDhash } of dhashResults) {
        if (!thumbDhash) { needsClip.push(u); continue; }
        let minHam = 64;
        for (const rh of refDhashes) {
          const h = hamming(rh, thumbDhash);
          if (h < minHam) minHam = h;
        }
        if (minHam <= DHASH_HIT_THRESHOLD) {
          const score = Math.max(0.85, 1 - (minHam / 64));
          const r = { url: u, score, isMatch: true, via: 'dhash', hamming: minHam };
          if (includeEmbeddings && refEmbeddings[0]) r.embedding = Array.from(refEmbeddings[0]);
          matchCache.set(u, { score: r.score, isMatch: true, via: 'dhash', hamming: r.hamming });
          results.push(r);
          dhashHits++;
        } else {
          needsClip.push(u);
        }
      }
    }

    // === Tier B: CLIP semantic match for the rest ===
    // CLIP inference itself is single-threaded inside transformers.js, so we
    // can't run multiple model passes simultaneously — they'd serialise.
    // BUT the fetch + decode happens BEFORE the model runs, so a bounded-
    // concurrency window lets one URL be embedding while the next two are
    // being fetched + decoded. Conc=3 keeps memory pressure low while
    // overlapping I/O with compute.
    const CLIP_CONCURRENCY = 3;
    async function _clipOne(u) {
      try {
        const emb = await getCachedEmbedding(u);
        let best = 0;
        for (const refEmb of refEmbeddings) {
          const s = cosineSim(refEmb, emb);
          if (s > best) best = s;
        }
        const r = { url: u, score: best, isMatch: best >= threshold, via: 'clip' };
        if (includeEmbeddings && r.isMatch) r.embedding = Array.from(emb);
        matchCache.set(u, { score: r.score, isMatch: r.isMatch, via: 'clip' });
        return r;
      } catch (e) {
        return { url: u, score: 0, isMatch: false, error: (e && e.message) || String(e) };
      }
    }
    for (let i = 0; i < needsClip.length; i += CLIP_CONCURRENCY) {
      const slice = needsClip.slice(i, i + CLIP_CONCURRENCY);
      const sliceResults = await Promise.all(slice.map(_clipOne));
      for (const r of sliceResults) {
        results.push(r);
        if (r.isMatch && !r.error) clipHits++;
      }
    }

    // LRU eviction so the cache doesn't grow without limit.
    while (matchCache.size > MATCH_CACHE_MAX) {
      const firstKey = matchCache.keys().next().value;
      matchCache.delete(firstKey);
    }

    // Attach dominant colors to each result. Colors were kicked off in
    // parallel at the top of the action, so by now they're (mostly) ready —
    // any straggler URL still completes here before serialising the response.
    for (const r of results) {
      try {
        const p = colorPromises.get(r.url);
        r.colors = p ? (await p) : [];
      } catch { r.colors = []; }
    }

    results.sort((a, b) => b.score - a.score);
    return { results, cacheHits, dhashHits, clipHits };
  }
  throw new Error('unknown action: ' + action);
}

window.addEventListener('message', async (event) => {
  const msg = event.data || {};
  const { id, action, payload } = msg;
  if (!id || !action) return;
  try {
    const result = await handleAction(action, payload || {});
    event.source.postMessage({ id, ok: true, ...result }, '*');
  } catch (e) {
    event.source.postMessage({ id, ok: false, error: (e && e.message) || String(e) }, '*');
  }
});

// Tell the parent we're alive.
if (window.parent && window.parent !== window) {
  window.parent.postMessage({ __sandboxReady: true }, '*');
}
