// modules/keyword-discovery.js
//
// Human-paced, batched discovery engine.
//
// Image-matching model:
//   - URL match (precision tier): if a SERP thumbnail URL contains the product
//     image's CDN filename/path, it's an immediate confidence-100 match. This
//     catches every case where Google indexes the original Shopify URL.
//   - Multi-signal perceptual hashing (recall tier): dHash + aHash + color
//     signature on 4 crops of each product image, vs. 2 crops of each
//     thumbnail. A match requires 2-of-3 signals strong agreement OR all 3
//     borderline. Tunable via Loose / Normal / Strict profiles.
//   - Multi-image references: Shopify product.images[] usually has 4-6 angles
//     of the same product; we fingerprint up to 6. Any thumbnail matching ANY
//     angle scores.
//   - Noise filter: after every keyword for a product is processed, cluster
//     the matched thumbnails by visual similarity. Tail clusters get dropped.
//
// Pacing — slow on purpose:
//   - One SERP load per product (rate-limited step).
//   - Keyword expansion uses /complete/search (autosuggest) only.
//   - Randomised pauses: 25-50 s pre-SERP, 60-120 s between products,
//     10-20 min between every CHUNK_SIZE products.
//
// CAPTCHA handling — DETECT AND STOP only. Never solve, never bypass.
//
// Resumability — all progress persisted via callbacks, chunk-rest deadline
// stored to chrome.storage, re-invocation skips already-done products.

import {
  KEYWORD_CAP,
  DELAY_AFTER_TAB_LOAD_MS,
  TAB_LOAD_TIMEOUT_MS,
  KP_HYDRATE_TIMEOUT_MS,
  KP_TABLE_TIMEOUT_MS,
  STORAGE_KEY_KP_CACHE,
  STORAGE_KEY_REST_UNTIL,
  KP_CACHE_TTL_MS,
  MATCH_PROFILES,
  DEFAULT_MATCH_PROFILE,
  NOISE_FILTER_MIN_RELATIVE_SIZE,
  SEARCH_DELAY_MIN_MS,
  SEARCH_DELAY_MAX_MS,
  PRODUCT_DELAY_MIN_MS,
  PRODUCT_DELAY_MAX_MS,
  CHUNK_SIZE,
  CHUNK_REST_MIN_MS,
  CHUNK_REST_MAX_MS,
  AUTOSUGGEST_DELAY_MIN_MS,
  AUTOSUGGEST_DELAY_MAX_MS,
} from '../config/discovery-config.js';

// CLIP-based image matching via the offscreen → sandbox iframe.
import {
  initMatcher,
  getReferenceEmbeddings,
  matchImages,
  cosineSimilarity,
} from './image-matcher.js';

// Surface used by the harness to distinguish CAPTCHA-pause from generic errors.
export const CAPTCHA_PAUSE_ERROR = 'CAPTCHA_PAUSE';

// ============ Random delays ============
function randInt(minMs, maxMs) {
  if (maxMs < minMs) maxMs = minMs;
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sleep that wakes early if shouldStop returns true. Returns false if stopped,
// true if the full duration elapsed.
// Sleep that wakes early if shouldStop returns true, AND keeps the MV3
// service worker alive across the duration. MV3 SWs are terminated after
// ~30s of inactivity, so a naive setTimeout-only sleep longer than ~30s
// silently dies and the whole engine evaporates. We tick chrome.storage
// every 20s, which counts as activity and resets the idle timer.
async function sleepInterruptible(ms, shouldStop, onTick) {
  const step = 1000;
  const end = Date.now() + ms;
  let nextKeepalive = Date.now() + 20_000;
  while (Date.now() < end) {
    if (shouldStop && shouldStop()) return false;
    const remaining = end - Date.now();
    if (onTick) onTick(remaining);
    if (Date.now() >= nextKeepalive) {
      try { await chrome.storage.local.get('__sw_keepalive'); } catch {}
      nextKeepalive = Date.now() + 20_000;
    }
    await sleep(Math.min(step, remaining));
  }
  return true;
}

// ============ KP result cache ============
async function getCachedKp(seed) {
  if (!seed) return null;
  const key = seed.toLowerCase().trim();
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_KP_CACHE]);
    const cache = data[STORAGE_KEY_KP_CACHE] || {};
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() - (entry.ts || 0) > KP_CACHE_TTL_MS) return null;
    return Array.isArray(entry.keywords) ? entry.keywords : null;
  } catch {
    return null;
  }
}
// LRU-ish cap on the KP cache so it can't grow unbounded. Prior to this,
// every KP seed added an entry with (up to) kpMaxPerProduct = 5000 keyword
// strings — a few hundred seeds and the cache alone could exceed Chrome's
// 10 MB storage.local quota (which we've also lifted via unlimitedStorage,
// but a bloated cache still slows every set() and clogs the SW).
const KP_CACHE_MAX_ENTRIES = 300;
const KP_CACHE_MAX_KEYWORDS_PER_ENTRY = 2000;
async function setCachedKp(seed, keywords) {
  if (!seed || !Array.isArray(keywords) || keywords.length === 0) return;
  const key = seed.toLowerCase().trim();
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_KP_CACHE]);
    const cache = data[STORAGE_KEY_KP_CACHE] || {};
    // Cap the per-entry keyword count — one huge seed shouldn't eat MBs.
    const capped = keywords.length > KP_CACHE_MAX_KEYWORDS_PER_ENTRY
      ? keywords.slice(0, KP_CACHE_MAX_KEYWORDS_PER_ENTRY) : keywords;
    cache[key] = { keywords: capped, ts: Date.now() };
    // Evict least-recently-used entries if the cache balloons past cap.
    const entries = Object.entries(cache);
    if (entries.length > KP_CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
      const kept = Object.fromEntries(entries.slice(0, KP_CACHE_MAX_ENTRIES));
      await chrome.storage.local.set({ [STORAGE_KEY_KP_CACHE]: kept });
    } else {
      await chrome.storage.local.set({ [STORAGE_KEY_KP_CACHE]: cache });
    }
  } catch {}
}

// ============ URL + name helpers ============
const STRIP_QUERY_KEYS = ['_pos', '_psq', '_ss', '_v'];

export function cleanProductUrl(url) {
  try {
    const u = new URL(url.trim());
    STRIP_QUERY_KEYS.forEach(k => u.searchParams.delete(k));
    const search = u.searchParams.toString();
    return `${u.origin}${u.pathname}${search ? '?' + search : ''}`;
  } catch {
    return url.trim();
  }
}

const RELEVANCE_STOPWORDS = new Set([
  'the','a','an','of','for','and','or','with','in','on','to','at','by','as',
  'is','are','was','were','be','been','have','has','had','do','does','did',
  'this','that','these','those','from','your','their','will','what','when',
  'where','how','why','just','like','than','then','into','about','best',
  'now','foods','food','brand',
]);

function buildRelevanceSet(productName, sku) {
  const source = `${productName || ''} ${sku || ''}`;
  return new Set(
    source.toLowerCase()
      .split(/[\s\W]+/)
      .filter(t => t.length >= 4 && !RELEVANCE_STOPWORDS.has(t))
  );
}

function isRelevantKeyword(keyword, relevanceSet) {
  if (!relevanceSet || relevanceSet.size === 0) return true;
  const tokens = (keyword || '').toLowerCase().split(/[\s\W]+/);
  for (const t of tokens) {
    if (t.length >= 4 && relevanceSet.has(t)) return true;
  }
  return false;
}

// Junk-keyword filter — rejects keywords whose intent doesn't match
// purchase / discovery for the product. We want commercial keyword leads;
// negative-sentiment, piracy, and review queries don't belong in the report.
//
// Edit JUNK_TOKEN_PATTERNS to tune what gets dropped. Word-boundary regex
// throughout so substring false positives don't fire (e.g. "previewed" is
// not "review", "classy" is not "ass").
const JUNK_TOKEN_PATTERNS = [
  // Review / research intent — we want buy intent, not research
  /\breviews?\b/i,
  /\bcomplaints?\b/i,
  /\bratings?\b/i,
  /\btestimonials?\b/i,
  // Negative brand sentiment
  /\b(scam|scams|scammer|scammers|fake|fakes|counterfeit|fraud|frauds|fraudulent|lawsuit|lawsuits|sued)\b/i,
  // Piracy / freebie / hack intent
  /\b(torrents?|cracked?|pirated?|warez|keygen|patched?)\b/i,
  /\b(free\s+download|download\s+free|hack(?:ed)?\s+version)\b/i,
  // Explicit profanity (basic English set — extend as needed)
  /\b(fuck|fucking|fucked|shit|shitty|bullshit|damn|crap|crappy|bitch|asshole|bastard)\b/i,
  // Mild adult / NSFW terms that don't belong in e-commerce keyword sets
  /\b(porn|porno|nude|xxx|nsfw)\b/i,
];
function isJunkKeyword(keyword) {
  const s = String(keyword || '');
  if (!s.trim()) return true;
  for (const re of JUNK_TOKEN_PATTERNS) if (re.test(s)) return true;
  return false;
}

// Does this KP row carry any commercially-relevant signal? KP returns many
// keywords with both monthly_searches and competition set to "—" (em-dash)
// or empty — these are keywords KP knows about but has zero measurement on.
// Treat them as low-value and drop. Only applies to kp_idea / kp_reexpand
// rows; PAA and autosuggest rows have no KP metrics by design.
function isLowSignalKpMeta(kpMeta) {
  if (!kpMeta) return true;
  const vol  = String(kpMeta.monthlySearches || '').trim();
  const comp = String(kpMeta.competition     || '').trim();
  const noVol  = !vol  || vol  === '—' || vol  === '-';
  const noComp = !comp || comp === '—' || comp === '-';
  return noVol && noComp;
}

// ============ Keyword classification signals ============
// Derived per keyword for the export columns:
//   keyword_relevance — how tightly the keyword ties to THIS product (from the
//                       classifyKeyword tier already stored on the row).
//   buying_intent     — purchase-readiness (from intent/topic/funnel).
//   faq               — is it a question / informational FAQ-style query.
//   competition       — surfaced from KP competition (Low/Medium/High).
const _QUESTION_RE = /^(is|can|does|do|did|are|was|were|what|how|why|which|where|when|who|whom|whose|will|would|should|could|may|might)\b/i;

function deriveBuyingIntent(intent, topic, funnel) {
  if (intent === 'transactional' || topic === 'price' || topic === 'availability') return 'high';
  if (intent === 'commercial' || funnel === 'mid') return 'medium';
  return 'low';
}
function isFaqKeyword(keyword) {
  const s = String(keyword || '').trim();
  if (!s) return false;
  return _QUESTION_RE.test(s) || s.includes('?');
}
function deriveKeywordRelevance(tier) {
  switch (tier) {
    case 'brand_product':   return 'high';
    case 'generic_product': return 'medium';
    case 'anchor_only':     return 'low';
    case 'brand_other':     return 'sibling-brand';
    default:                return '';
  }
}

export function simplifyForKP(name) {
  if (!name) return name;
  let s = String(name);
  // Strip parenthetical / bracketed text first: "(200ml)", "[Pack of 2]"
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  // "8 Fluid Ounce", "16 fluid ounces", "1.7 fl oz" — runs BEFORE the
  // generic unit pass so we don't leave a stray "Ounce" behind.
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:fluid\s+ounces?|fl\.?\s?oz\.?)\b/gi, ' ');
  // Count-style descriptors with a leading number. `\s*` (zero or more
  // spaces) so "250tablets" / "60capsules" — concatenated forms common in
  // imported product titles — match the same as "250 tablets".
  s = s.replace(/\b\d+\s*(softgels?|capsules?|caps?|tablets?|tabs?|vegcaps?|vcaps?|count|ct|pack|servings?|gels?|gummies|chewables?|pieces?|bottles?|sachets?|sheets?|wipes?|units?|pcs?)\b/gi, ' ');
  // Mass / volume / energy units (e.g. "200ml", "1.7 oz", "100 g", "650mg")
  s = s.replace(/\b\d+(?:\.\d+)?\s*(mg|mcg|g|gm|gms|ml|oz|ounces?|lb|lbs|kg|kgs|l|liters?|litres?|iu|kcal)\b/gi, ' ');
  // Percentages — "15 Percent", "15%", "0.5%" — strip the leading number
  // and the percent word, keeping the substance name intact ("15 Percent
  // Zinc Oxide" → "Zinc Oxide"). SPF is a strength indicator, not a unit
  // KP optimises for; strip "SPF 60" / "SPF60" too. No trailing \b on
  // "%" — JS \b only fires between word/non-word, and "%" is non-word,
  // so "0.2% " gets no boundary. Use \b on the word variants instead.
  s = s.replace(/\b\d+(?:\.\d+)?\s*%/g, ' ');
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:percent|per\s*cent)\b/gi, ' ');
  s = s.replace(/\bspf\s*\d+\s*(?:\+|plus)?\b/gi, ' ');
  // "Pack of 3", "Set of 2", "3-Pack", "Twin/Value/Combo/Multi/Family Pack"
  s = s.replace(/\b(?:pack|set|box|case)\s+of\s+\d+\b/gi, ' ');
  s = s.replace(/\b\d+\s*-\s*pack\b/gi, ' ');
  s = s.replace(/\b(?:twin|value|combo|multi|family)\s+pack\b/gi, ' ');
  // Stray years or large numbers
  s = s.replace(/\b\d{4,}\b/g, ' ');
  // Trailing small number like "Cream 3" (variant indicators)
  s = s.replace(/\s+\d{1,3}\s*$/g, ' ');
  // Trailing body-area tokens narrow KP results too much — strip them.
  s = s.replace(/\s+(?:for\s+)?(?:face|body|hair|skin|hands|feet|lips)(?:\s+(?:face|body|hair|skin|hands|feet|lips))*\s*$/gi, ' ');
  // Trailing punctuation left over from removed segments
  s = s.replace(/[,|–-]+\s*$/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Cap at 10 meaningful words — long enough to preserve the full handle
  // (e.g. "Aquaphor Baby Healing Cream 3 In 1 Diaper Rash Cream" is 10
  // words and stays intact), short enough that KP's "Get results" button
  // hydrates reliably (anything >12 words tends to time out the UI).
  // Step back off trailing stop-words so we don't end the seed on "for",
  // "with", "and", etc., and off trailing orphan numbers that became the
  // last token only because the cap landed on them.
  const STOP = new Set(['for','with','and','the','a','an','of','in','on','by','to']);
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 10) {
    let cutoff = 10;
    while (cutoff > 4 && (STOP.has(words[cutoff - 1].toLowerCase()) || /^\d{1,3}$/.test(words[cutoff - 1]))) cutoff--;
    s = words.slice(0, cutoff).join(' ');
  }
  // Post-truncation cleanup: trailing strips have to run AGAIN because the
  // cap may have created new trailing tokens that weren't there originally
  // (e.g. cap lands on "For Face", "For Dry", "Of Three", "3 In 1").
  // Order matters — strip stop-word + body-part runs first, then orphan
  // numbers, then a final whitespace collapse.
  s = s.replace(/\s+(?:for\s+)?(?:face|body|hair|skin|hands|feet|lips|dry|oily|chapped|cracked|sensitive)(?:\s+(?:face|body|hair|skin|hands|feet|lips|dry|oily|chapped|cracked|sensitive))*\s*$/gi, ' ');
  s = s.replace(/\s+(?:for|with|and|the|of|in|on|by|to)\s*$/gi, ' ');
  s = s.replace(/\s+\d{1,3}(?:\s+in\s+\d{1,3})?\s*$/gi, ' ');
  s = s.replace(/[,|–-]+\s*$/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || name;
}

// Detect a multi-pack / bundle indicator in SERP listing text. Returns
// null when no pack marker is present. Returns a label like
// 'pack_variant_3' (count known) or 'pack_variant' (named bundle without
// explicit count, e.g. "Value Pack"). Used to re-tag clean matches whose
// listing is the multi-pack retail variant of the same SKU 
// — still our
// product, just packaged as a bundle. Tagged separately so the user can
// audit pack listings without losing them from image_count.
export function detectPackIndicator(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  // Order matters. "3 packs of 24" — N is the PACK count (3), not 24.
  // Check this BEFORE "pack of N" so we don't read "packs of 24" as a
  // 24-unit single pack.
  let m = s.match(/\b(\d{1,3})\s+packs?\s+of\b/);
  if (m && parseInt(m[1], 10) >= 2) return { count: parseInt(m[1], 10), label: `pack_variant_${m[1]}` };
  // "pack of 3" — explicit single-pack-of-N (N units in one bundle).
  m = s.match(/\b(?:pack|set|box|case|bundle)\s+of\s+(\d{1,3})\b/);
  if (m && parseInt(m[1], 10) >= 2) return { count: parseInt(m[1], 10), label: `pack_variant_${m[1]}` };
  // "3-Pack" / "3 Pack" — same idea, hyphen form.
  m = s.match(/\b(\d{1,3})\s*[-–]\s*pack\b/);
  if (m && parseInt(m[1], 10) >= 2) return { count: parseInt(m[1], 10), label: `pack_variant_${m[1]}` };
  // Deliberately NOT matching "N count / N sheets / N strips / N wipes"
  // since those are units-per-pack (e.g. "60 sheets" face mask, "72
  // strips" Listerine) rather than a pack count. We'd rather miss those
  // edge cases than mis-label them as multipacks.
  // Named-pack forms — count inferred where possible, otherwise generic.
  if (/\btwin\s+pack\b/.test(s))                       return { count: 2, label: 'pack_variant_2' };
  if (/\b(?:triple|trio)\s+pack\b/.test(s))            return { count: 3, label: 'pack_variant_3' };
  if (/\bquad\s+pack\b/.test(s))                       return { count: 4, label: 'pack_variant_4' };
  if (/\b(?:value|combo|multi|family|variety)\s+pack\b/.test(s)) return { count: null, label: 'pack_variant' };
  return null;
}

export function deriveName(handleOrUrl) {
  let handle = handleOrUrl;
  const m = handleOrUrl.match(/\/products\/([^/?#]+)/);
  if (m) handle = m[1];
  return handle
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function isUnusableImage(src) {
  if (!src) return true;
  const lower = src.toLowerCase();
  return lower.endsWith('.svg') || lower.startsWith('data:image/svg');
}
function normalizeImageUrl(src) {
  if (!src) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('http://')) return `https://${src.slice(7)}`;
  return src;
}

// Shopify CDN trick: theme apps often re-upload product photos with a
// `padded_<timestamp>_` prefix that adds white borders. The padded variant
// hashes very differently from any other retailer's photo of the same item,
// killing match recall. Return the original (unpadded) URL alongside the
// padded one so we have a better chance of catching SERP thumbnails.
function shopifyUnpaddedVariants(url) {
  if (!url || typeof url !== 'string') return [];
  // Match: .../cdn/shop/files/padded_<digits>_<rest> or
  //        .../cdn/shop/products/padded_<digits>_<rest>
  const m = url.match(/^(.+\/(?:files|products)\/)padded_\d+_(.+)$/i);
  if (!m) return [];
  return [m[1] + m[2]];
}
const BANNER_HINTS = /logo|banner|icon|sprite|cart|trust|badge|favicon|theme|placeholder|creative_\d/i;
const MAX_REF_IMAGES = 6;

export async function getProductImages(cleanUrl, log) {
  log = log || (() => {});
  const out = [];
  const seen = new Set();
  const pushOne = (raw, source) => {
    if (!raw) return false;
    if (isUnusableImage(raw)) return false;
    const norm = normalizeImageUrl(raw);
    const key = norm.split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(norm);
    log(`image via ${source}`);
    return true;
  };
  const push = (raw, source) => {
    if (!raw) return false;
    const added = pushOne(raw, source);
    // If this is a Shopify "padded_*" variant, also try the unpadded original.
    // SERP thumbnails (from other retailers + Google's image proxy) almost
    // always show the unpadded photo, so the unpadded URL is a far stronger
    // reference for CLIP/dHash matching.
    if (out.length < MAX_REF_IMAGES) {
      const variants = shopifyUnpaddedVariants(normalizeImageUrl(raw));
      for (const v of variants) {
        if (out.length >= MAX_REF_IMAGES) break;
        pushOne(v, `${source} (unpadded)`);
      }
    }
    return added;
  };

  // 1) Shopify product .json — FREE, no Google SERP load.
  //
  // Pull the FULL set of references: top-level product.images, the legacy
  // product.image, and every variant's featured_image. Variants typically
  // carry different-angle / different-colour photos of the same product —
  // each one is another shot at matching a SERP thumbnail.
  try {
    const resp = await fetch(`${cleanUrl}.json`, { credentials: 'omit' });
    if (resp.ok) {
      const j = await resp.json();
      const imgs = Array.isArray(j?.product?.images) ? j.product.images : [];
      for (let i = 0; i < imgs.length && out.length < MAX_REF_IMAGES; i++) {
        push(imgs[i]?.src, `Shopify .json images[${i}]`);
      }
      if (out.length === 0) push(j?.product?.image?.src, 'Shopify .json product.image');
      // Variant featured images — different angles of the same product.
      const variants = Array.isArray(j?.product?.variants) ? j.product.variants : [];
      for (let i = 0; i < variants.length && out.length < MAX_REF_IMAGES; i++) {
        const vsrc = variants[i]?.featured_image?.src;
        if (vsrc) push(vsrc, `Shopify variant[${i}].featured_image`);
      }
      if (out.length > 0) return out;
      log(`Shopify .json returned but no usable images`);
    } else {
      log(`Shopify .json HTTP ${resp.status}`);
    }
  } catch (e) {
    log(`Shopify .json error: ${e.message}`);
  }

  // Fall back to HTML scrape.
  // Amazon (and increasingly Flipkart / Nykaa) block bare fetch() with a
  // captcha or challenge page unless we send browser-realistic headers.
  // The default fetch UA is `Mozilla/5.0 ...` — but no Accept, no
  // Accept-Language, no Sec-Fetch-* → gets flagged. Sending the same
  // shape a real Chrome navigation would send gets a real HTML response
  // ~90% of the time on amazon.in.
  let html = '';
  try {
    const resp = await fetch(cleanUrl, {
      credentials: 'omit',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9,en-US;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    if (!resp.ok) { log(`Product HTML HTTP ${resp.status}`); return out; }
    html = await resp.text();
    // Detect Amazon captcha/challenge page — the fetch returned 200 but
    // the body is a "Enter the characters you see below" wall. Log
    // clearly so users don't chase 'no images' when the real issue is
    // 'blocked by anti-bot'.
    if (/amazon\.in|amazon\.com/i.test(cleanUrl) &&
        /(Enter the characters you see below|To discuss automated access|robot check)/i.test(html.slice(0, 3000))) {
      log(`Amazon returned an anti-bot challenge page (captcha). Use Shopify resolve mode instead so we scrape dropy.in URLs directly.`);
      return out;
    }
  } catch (e) {
    log(`Product HTML fetch error: ${e.message}`);
    return out;
  }

  log('fallback step: scanning JSON-LD Product schema');
  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldBlocks) {
    try {
      const raw = JSON.parse(m[1].trim());
      const items = Array.isArray(raw) ? raw : (raw['@graph'] || [raw]);
      for (const item of items) {
        if (!item || item['@type'] !== 'Product' || !item.image) continue;
        const imgArr = Array.isArray(item.image) ? item.image : [item.image];
        for (const imgRaw of imgArr) {
          if (out.length >= MAX_REF_IMAGES) break;
          const imgUrl = typeof imgRaw === 'string' ? imgRaw : (imgRaw?.url || imgRaw?.['@id']);
          push(imgUrl, 'JSON-LD Product schema');
        }
      }
    } catch {}
    if (out.length >= MAX_REF_IMAGES) break;
  }
  if (out.length > 0) return out;

  log('fallback step: og:image');
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1] && !BANNER_HINTS.test(og[1])) push(og[1], 'og:image');
  if (out.length > 0) return out;

  log('fallback step: twitter:image');
  const tw = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (tw && tw[1] && !BANNER_HINTS.test(tw[1])) push(tw[1], 'twitter:image');
  if (out.length > 0) return out;

  log('fallback step: <img> scan (product-path)');
  const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
  for (const src of imgs) {
    if (out.length >= MAX_REF_IMAGES) break;
    if (BANNER_HINTS.test(src)) continue;
    // Widened: Shopify /products/ + Amazon media (m.media-amazon.com,
    // images-*.ssl-images-amazon.com), Flipkart img, Nykaa media so we
    // pick up product hero shots on marketplaces too.
    if (/\/products\/|cdn\.shopify\.com\/s\/files\/.*products|(?:m\.media|images-\w+\.ssl-images)-amazon\.com|rukminim\d\.flixcart\.com|images-static\.nykaa\.com/i.test(src)) push(src, '<img> scan');
  }
  if (out.length > 0) return out;
  // Amazon-specific: look for the landing image ID in inline JS. Amazon's
  // main product image is set via `#landingImage` with a data-a-dynamic-
  // image attribute that maps URLs → dimensions. We grep the JSON out
  // and take the first URL (biggest dimensions usually first).
  if (/amazon\./i.test(cleanUrl)) {
    log('fallback step: Amazon data-a-dynamic-image');
    const dyn = html.match(/data-a-dynamic-image=["']([^"']+)["']/i);
    if (dyn) {
      try {
        const decoded = dyn[1].replace(/&quot;/g, '"');
        const map = JSON.parse(decoded);
        for (const url of Object.keys(map)) {
          if (out.length >= MAX_REF_IMAGES) break;
          if (!BANNER_HINTS.test(url)) push(url, 'Amazon dynamic-image');
        }
      } catch { /* not JSON, skip */ }
    }
    if (out.length > 0) return out;
    // Fallback: hi-res landing image ID pattern
    const lb = html.match(/id=["']landingImage["'][^>]+data-old-hires=["']([^"']+)["']/i);
    if (lb) push(lb[1], 'Amazon landingImage');
    if (out.length > 0) return out;
  }

  log('fallback step: generic <img> tags (last-ditch)');
  for (const src of imgs) {
    if (out.length >= MAX_REF_IMAGES) break;
    if (BANNER_HINTS.test(src)) continue;
    push(src, '<img> generic fallback');
  }

  if (out.length === 0) log('all fallbacks exhausted — no usable product image found');
  return out;
}

// ============ Autosuggest (low-risk, free) ============
// /complete/search?client=chrome -> ["q",[suggestions]]
// Not rate-limited like SERP; we still apply small jitter for politeness.
// Fetch with a hard timeout. If the endpoint hangs (slow network, Google
// throttling, DNS issue), AbortController kills the request at the deadline
// so the engine doesn't get stuck on a single unanswered request.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// Amazon's marketplace-suggest API. Same shape as Google's autocomplete:
// a free HTTP GET with a `prefix` parameter, returns ranked suggestions
// reflecting what Amazon shoppers in that marketplace search for. Used by
// the Amazon Round to enrich the keyword set with marketplace-specific
// long-tail queries.
//
// `marketplace` is the Amazon TLD short code: 'in' (default), 'com', 'co.uk',
// 'de', 'ca', etc. `mid` is the marketplace ID baked into Amazon's API.
const AMAZON_MARKETPLACE_IDS = {
  'in':    'A21TJRUUN4KGV',
  'com':   'ATVPDKIKX0DER',
  'co.uk': 'A1F83G8C2ARO7P',
  'de':    'A1PA6795UKMFR9',
  'ca':    'A2EUQ1WTGCTBG2',
};
export async function getAmazonSuggest(query, marketplace = 'in', log) {
  if (!query || !query.trim()) return [];
  log = typeof log === 'function' ? log : (() => {});
  const mid = AMAZON_MARKETPLACE_IDS[marketplace] || AMAZON_MARKETPLACE_IDS['in'];

  // Primary: /api/2017/suggestions — returns {suggestions: [{value, type}]}
  const primaryParams = new URLSearchParams({
    'session-id':       '000-0000000-0000000',
    'customer-id':      '',
    'request-id':       String(Date.now()),
    'page-type':        'Gateway',
    'lop':              'en_IN',
    'site-variant':     'desktop',
    'client-info':      'amazon-search-ui',
    'mid':              mid,
    'alias':            'aps',
    'prefix':           query,
    'event':            'onKeyPress',
    'limit':            '11',
    'fb':               '1',
    'suggestion-type':  'KEYWORD',
  });
  const primaryUrl = `https://completion.amazon.${marketplace}/api/2017/suggestions?${primaryParams.toString()}`;

  // Fallback: /search/complete — older endpoint, returns [keyword, [suggestions]]
  const fallbackUrl =
    `https://completion.amazon.${marketplace}/search/complete?` +
    `search-alias=aps&client=amazon-search-ui&mkt=${marketplace === 'in' ? '44571' : '1'}` +
    `&q=${encodeURIComponent(query)}`;

  const _parsePrimary = (data) => {
    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
    return suggestions
      .filter(s => s && (s.type === 'KEYWORD' || !s.type))
      .map(s => (typeof s === 'string' ? s : (s.value || s.suggestion || '')).trim())
      .filter(v => v && v.length >= 2 && v.length <= 120);
  };
  const _parseFallback = (data) => {
    if (!Array.isArray(data)) return [];
    const arr = Array.isArray(data[1]) ? data[1] : [];
    return arr
      .map(s => (typeof s === 'string' ? s : s?.value || '').trim())
      .filter(v => v && v.length >= 2 && v.length <= 120);
  };

  // Try primary endpoint first.
  let primaryErr = null;
  try {
    const resp = await fetchWithTimeout(primaryUrl, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json, text/plain, */*' },
    }, 10000);
    if (resp.ok) {
      const data = await resp.json();
      const parsed = _parsePrimary(data);
      if (parsed.length > 0) return parsed.slice(0, 15);
      log(`Amazon primary returned 0 suggestions (keys=${Object.keys(data || {}).join(',') || 'none'})`);
    } else {
      primaryErr = `HTTP ${resp.status}`;
    }
  } catch (e) {
    primaryErr = e?.message || String(e);
  }
  if (primaryErr) log(`Amazon primary failed: ${primaryErr}`);

  // Try fallback endpoint.
  let fallbackErr = null;
  try {
    const resp = await fetchWithTimeout(fallbackUrl, { credentials: 'omit' }, 10000);
    if (resp.ok) {
      const data = await resp.json();
      const parsed = _parseFallback(data);
      if (parsed.length > 0) return parsed.slice(0, 15);
      log(`Amazon fallback returned 0 suggestions`);
    } else {
      fallbackErr = `HTTP ${resp.status}`;
    }
  } catch (e) {
    fallbackErr = e?.message || String(e);
  }
  if (fallbackErr) log(`Amazon fallback failed: ${fallbackErr}`);

  return [];
}

export async function getAutocomplete(query) {
  if (!query || !query.trim()) return [];
  try {
    const url = `https://www.google.com/complete/search?q=${encodeURIComponent(query)}&gl=in&hl=en&client=chrome`;
    const resp = await fetchWithTimeout(url, { credentials: 'omit' }, 10000);
    if (!resp.ok) return [];
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      const cleaned = text.replace(/^[^\[]+/, '');
      try { data = JSON.parse(cleaned); } catch { return []; }
    }
    const arr = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return arr.filter(s => typeof s === 'string' && s.trim().length > 3).slice(0, 15);
  } catch (e) {
    // AbortError on timeout, network errors, etc. Return empty so the engine
    // moves on instead of crashing.
    return [];
  }
}

// ============ Tab orchestration ============
function waitForNavigationComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('navigation timeout'));
    }, TAB_LOAD_TIMEOUT_MS);
    let sawLoading = false;
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const Worker = (() => {
  let tabId = null;

  async function existsAndAlive() {
    if (tabId === null) return false;
    try { await chrome.tabs.get(tabId); return true; }
    catch { tabId = null; return false; }
  }

  return {
    async navigate(url) {
      if (await existsAndAlive()) {
        await chrome.tabs.update(tabId, { url });
      } else {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      }
      await waitForNavigationComplete(tabId);
      return tabId;
    },
    async close() {
      if (await existsAndAlive()) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      tabId = null;
    },
    getId() { return tabId; },
  };
})();

async function pingContentScript(tabId, type, maxAttempts = 12, intervalMs = 700) {
  for (let i = 0; i < maxAttempts; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type }); if (r?.ready) return true; } catch {}
    await sleep(intervalMs);
  }
  return false;
}

// Try a declarative-injection ping first; if that fails, programmatically
// inject the content script via chrome.scripting.executeScript and retry.
// Returns { ok, url } where url is the tab's current URL (useful for diagnosing
// redirects to consent / sorry / login pages).
async function ensureContentScriptReady(tabId, pingType, scriptFile) {
  // Tier 1: wait for the declarative content_scripts injection (manifest).
  for (let i = 0; i < 20; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: pingType }); if (r?.ready) return { ok: true }; } catch {}
    await sleep(1000);
  }
  // Get the actual URL — Google may have redirected us somewhere that the
  // content_scripts pattern doesn't match.
  let tabUrl = '';
  try { const t = await chrome.tabs.get(tabId); tabUrl = t?.url || ''; } catch {}

  // Tier 2: force-inject programmatically. This bypasses the declarative
  // match patterns and works on any tab the extension has access to.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile],
    });
  } catch (e) {
    return { ok: false, url: tabUrl, error: `executeScript failed: ${e.message}` };
  }
  await sleep(800);
  for (let i = 0; i < 8; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: pingType }); if (r?.ready) return { ok: true, url: tabUrl, injected: true }; } catch {}
    await sleep(700);
  }
  return { ok: false, url: tabUrl, error: 'content script did not respond even after programmatic injection' };
}

// ============ KP step (separate from Google SERP) ============
// Uses the user's own ads.google.com KP tab — does NOT load a Google search
// results page, so it isn't subject to the per-product SERP budget.
function transformToIdeasUrl(kpUrl) {
  try {
    const u = new URL(kpUrl);
    if (/\/aw\/keywordplanner\b/.test(u.pathname)) {
      u.pathname = '/aw/keywordplanner/ideas/new';
      const keep = new URLSearchParams();
      for (const k of ['ocid', 'euid', '__u', 'uscid', '__c', 'authuser']) {
        if (u.searchParams.has(k)) keep.set(k, u.searchParams.get(k));
      }
      u.search = keep.toString();
    }
    return u.toString();
  } catch {
    return kpUrl;
  }
}

// Accepts either a single seed string OR an array of seeds. The engine
// drives multi-seed runs by NAVIGATING the KP tab between seeds (one fresh
// kp.js injection per seed). The earlier in-content-script seed loop broke
// because reloading the KP page after the first seed killed the message
// channel mid-call. Each seed call is now a discrete navigate -> wait -> ping
// -> send roundtrip, isolated by a fresh content-script instance.
async function getKeywordPlannerIdeas(seedTextOrSeeds, kpUrl, maxResults = 200, log, kpOpts = {}) {
  log = log || (() => {});
  const seedList = Array.isArray(seedTextOrSeeds)
    ? seedTextOrSeeds.filter(s => typeof s === 'string' && s.trim())
    : (seedTextOrSeeds ? [seedTextOrSeeds] : []);
  if (seedList.length === 0) return { ok: false, error: 'no seeds provided', keywords: [] };
  // When the keyword-based search returns fewer than KP_WEBSITE_FALLBACK_THRESHOLD
  // ideas total, fall back to KP's "Start with a website" flow against productUrl.
  // The fallback runs on a freshly navigated KP tab — we navigate the tab again
  // after the seed loop rather than asking the content script to reopen Discover
  // Keywords from the results view (that path was unreliable: the Discover card
  // doesn't reliably re-hydrate within the 45s budget).
  //
  // allowWebsiteFallback gates this entirely. The website fallback returns
  // the SAME ideas regardless of seed — it scrapes the productUrl, not the
  // seed. So once R1 has run it for a product, every R2 expansion call would
  // re-scrape the same URL for 0 new keywords (~3 min per R2 seed wasted).
  // R2 callers pass `allowWebsiteFallback: false` to skip it.
  const productUrl = typeof kpOpts.productUrl === 'string' ? kpOpts.productUrl : '';
  const allowWebsiteFallback = kpOpts.allowWebsiteFallback !== false;
  const KP_WEBSITE_FALLBACK_THRESHOLD = 70;

  // Check cache for ALL seeds first — return union if every seed is cached
  // and at least one returns results.
  const cachedUnion = [];
  const seenCached = new Set();
  let allCached = true;
  for (const s of seedList) {
    const c = await getCachedKp(s);
    if (c && c.length > 0) {
      for (const item of c) {
        const kw = typeof item === 'string' ? item : item?.kw;
        if (!kw) continue;
        const lo = kw.toLowerCase();
        if (seenCached.has(lo)) continue;
        seenCached.add(lo);
        cachedUnion.push(item);
      }
    } else {
      allCached = false;
    }
  }
  if (allCached && cachedUnion.length > 0) {
    log(`KP CACHE HIT for ${seedList.length} seed(s) — ${cachedUnion.length} keywords`);
    return { ok: true, keywords: cachedUnion.slice(0, maxResults), cached: true };
  }

  const ideasUrl = transformToIdeasUrl(kpUrl);
  if (ideasUrl !== kpUrl) log(`KP: rewrote URL -> ${ideasUrl.slice(0, 140)}`);

  const accumulated = [];
  const seen = new Set();
  const seedErrors = [];

  // Treat these error substrings as TRANSIENT — Google's KP UI just didn't
  // hydrate fast enough this time. A fresh navigate + retry rescues a
  // surprising fraction of these (the second tab load tends to land on a
  // warmer cache and the Discover button hydrates within seconds).
  // "no keyword ideas" / "try different keywords" are NOT transient — that's
  // KP's actual response, and retrying just wastes time.
  const TRANSIENT_RE = /timed out|hydrate|never responded|shell|get results button|discover keywords/i;
  const SEED_MAX_ATTEMPTS = 2;

  for (let i = 0; i < seedList.length; i++) {
    const seed = seedList[i];
    if (accumulated.length >= maxResults) break;
    let succeeded = false;
    for (let attempt = 1; attempt <= SEED_MAX_ATTEMPTS && !succeeded; attempt++) {
      try {
        // Navigate the KP tab for this seed. The Worker reuses the same tab id;
        // the navigation forces kp.js to re-inject cleanly.
        const attemptLabel = attempt > 1 ? ` (retry ${attempt}/${SEED_MAX_ATTEMPTS})` : '';
        log(`KP seed ${i + 1}/${seedList.length}: navigating to ideas page${attemptLabel}`);
        const tabId = await Worker.navigate(ideasUrl);
        await sleep(randInt(2500, 4000));
        const ready = await pingContentScript(tabId, 'KP_PING', 15, 1000);
        if (!ready) {
          if (attempt < SEED_MAX_ATTEMPTS) {
            log(`KP seed ${i + 1}: content script never responded — retrying in 5s`);
            await sleep(5000);
            continue;
          }
          seedErrors.push(`seed ${i + 1}: KP content script never responded (after ${attempt} attempts)`);
          break;
        }
        const single = await chrome.tabs.sendMessage(tabId, {
          type: 'KP_GET_IDEAS',
          seed: seed,                  // single seed per content-script call
          maxResults: maxResults - accumulated.length,
          hydrateTimeoutMs: KP_HYDRATE_TIMEOUT_MS,
          tableTimeoutMs:   KP_TABLE_TIMEOUT_MS,
        });
        if (!single?.ok) {
          const errMsg = single?.error || 'unknown';
          if (attempt < SEED_MAX_ATTEMPTS && TRANSIENT_RE.test(errMsg)) {
            log(`KP seed ${i + 1}: transient failure ("${errMsg.slice(0, 60)}") — retrying with fresh navigate in 5s`);
            await sleep(5000);
            continue;
          }
          seedErrors.push(`seed ${i + 1} ("${seed.slice(0, 30)}"): ${errMsg}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
          break;
        }
        const keywords = Array.isArray(single.keywords) ? single.keywords : [];
        log(`KP seed ${i + 1} "${seed.slice(0, 40)}" → ${keywords.length} ideas${attempt > 1 ? ` (succeeded on attempt ${attempt})` : ''}`);
        for (const item of keywords) {
          if (accumulated.length >= maxResults) break;
          const kw = typeof item === 'string' ? item : item?.kw;
          if (!kw) continue;
          const lo = String(kw).toLowerCase().trim();
          if (seen.has(lo)) continue;
          seen.add(lo);
          accumulated.push(item);
        }
        // Cache this seed's results so future single-seed lookups hit.
        if (keywords.length > 0) await setCachedKp(seed, keywords);
        succeeded = true;
      } catch (e) {
        if (attempt < SEED_MAX_ATTEMPTS && TRANSIENT_RE.test(e.message || '')) {
          log(`KP seed ${i + 1}: threw transient error ("${(e.message || '').slice(0, 60)}") — retrying in 5s`);
          await sleep(5000);
          continue;
        }
        seedErrors.push(`seed ${i + 1} ("${seed.slice(0, 30)}"): ${e.message}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
        break;
      }
    }
  }

  // Website fallback — when the keyword-based union is thin, run KP's
  // "Start with a website" flow against productUrl on a freshly navigated
  // tab. Existing accumulated keywords win on collision. Gated by
  // allowWebsiteFallback so R2 expansion calls don't re-scrape the same URL.
  if (!allowWebsiteFallback && productUrl && accumulated.length < KP_WEBSITE_FALLBACK_THRESHOLD) {
    log(`KP: ${accumulated.length} ideas (< ${KP_WEBSITE_FALLBACK_THRESHOLD}), skipping website fallback (disabled for this call — usually R2 expansion)`);
  }
  if (allowWebsiteFallback && productUrl && accumulated.length < KP_WEBSITE_FALLBACK_THRESHOLD && accumulated.length < maxResults) {
    log(`KP: only ${accumulated.length} ideas (< ${KP_WEBSITE_FALLBACK_THRESHOLD}), running "Start with a website" fallback on fresh tab`);
    try {
      const tabId = await Worker.navigate(ideasUrl);
      await sleep(randInt(2500, 4000));
      const ready = await pingContentScript(tabId, 'KP_PING', 15, 1000);
      if (!ready) {
        seedErrors.push(`website fallback: KP content script never responded after fresh navigate`);
      } else {
        const resp = await chrome.tabs.sendMessage(tabId, {
          type: 'KP_GET_IDEAS_WEBSITE',
          productUrl,
          maxResults: maxResults - accumulated.length,
          hydrateTimeoutMs: KP_HYDRATE_TIMEOUT_MS,
          tableTimeoutMs:   KP_TABLE_TIMEOUT_MS,
        });
        if (!resp?.ok) {
          seedErrors.push(`website fallback: ${resp?.error || 'unknown'}`);
        } else {
          const websiteIdeas = Array.isArray(resp.keywords) ? resp.keywords : [];
          let added = 0;
          for (const item of websiteIdeas) {
            if (accumulated.length >= maxResults) break;
            const kw = typeof item === 'string' ? item : item?.kw;
            if (!kw) continue;
            const lo = String(kw).toLowerCase().trim();
            if (seen.has(lo)) continue;
            seen.add(lo);
            accumulated.push(item);
            added++;
          }
          log(`KP website fallback: +${added} new (${websiteIdeas.length - added} duplicates)`);
        }
      }
    } catch (e) {
      seedErrors.push(`website fallback: ${e.message}`);
    }
  }

  if (accumulated.length === 0) {
    // Two very different failure modes both land here:
    //   A) The KP UI never yielded — content script never responded,
    //      hydrate timeout, etc. seedErrors will be non-empty. Callers
    //      SHOULD retry this — it's transient.
    //   B) Google legitimately has no keyword ideas for this seed
    //      ("try different keywords"). seedErrors is EMPTY because
    //      that's not an error, it's a real answer. Retrying just
    //      wastes ~25s per retry cycle and hits Google harder.
    // Distinguish by seedErrors:
    if (seedErrors.length === 0) {
      // Case B — permanent empty result. Return ok:true with empty
      // keywords so callers move on immediately instead of retrying.
      return { ok: true, keywords: [], empty: true };
    }
    return { ok: false, error: seedErrors.join(' | '), keywords: [] };
  }
  return { ok: true, keywords: accumulated, errors: seedErrors };
}

// ============ KP metrics lookup (Search volume & forecasts) ============
// Backfills KP metrics (avg monthly searches / competition / bid range) for a
// batch of keywords that did NOT originate from KP's Discover flow —
// autosuggest, PAA, related-search, amazon. Drives KP's "Get search volume
// and forecasts" tool + its Historical-metrics view; reuses the same table
// scraper kp.js already uses for the ideas table.
// Returns { ok, metrics: [{ kw, monthlySearches, competition, bidLow, bidHigh }] }.
async function getKeywordPlannerMetrics(keywords, kpUrl, log) {
  log = log || (() => {});
  const list = Array.from(new Set(
    (Array.isArray(keywords) ? keywords : [])
      .map(k => String(k || '').trim())
      .filter(Boolean)
  ));
  if (list.length === 0) return { ok: true, metrics: [] };
  try {
    const tabId = await Worker.navigate(kpUrl);
    await sleep(randInt(2500, 4000));
    const ready = await pingContentScript(tabId, 'KP_PING', 15, 1000);
    if (!ready) return { ok: false, error: 'KP content script never responded', metrics: [] };
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'KP_GET_METRICS',
      keywords: list,
      maxResults: list.length + 50,
      hydrateTimeoutMs: KP_HYDRATE_TIMEOUT_MS,
      tableTimeoutMs:   KP_TABLE_TIMEOUT_MS,
    });
    if (!resp?.ok) return { ok: false, error: resp?.error || 'unknown', metrics: [] };
    const metrics = Array.isArray(resp.keywords) ? resp.keywords : [];
    return { ok: true, metrics };
  } catch (e) {
    return { ok: false, error: e.message, metrics: [] };
  }
}

// ============ CLIP image matching ============
// All inference happens in the sandbox iframe via image-matcher.js. This
// module just wires the engine to the matcher API.
//
// Strictness profile maps to a cosine threshold:
//   loose=0.75, normal=0.82, strict=0.90.
// CLIP cosine of two L2-normalised embeddings is in [-1, 1]; for ImageNet/
// CLIP-style image embeddings of "same product different photo", expected
// scores: 0.95+ near-identical, 0.85-0.95 same product same angle, 0.75-0.85
// same product different angle/crop, 0.60-0.75 same product category.
// Lowered again from { 0.72, 0.78, 0.88 }. The 0.78 normal threshold was
// still killing real matches — a padded Shopify reference vs a compressed
// Google SERP thumbnail of the same product often scores 0.72-0.77. The
// dHash pre-filter catches near-identical thumbs at any threshold, so the
// CLIP threshold only needs to gate "same product, different photo / angle
// / source", which lives in the 0.70+ range. False positives at 0.72 are
// rare for distinct product photography.
const CLIP_THRESHOLDS = { loose: 0.68, normal: 0.72, strict: 0.82 };

// Optional `override` is a 0-1 cosine. Used when the Settings-tab profile
// is set to "custom" and the user wants to tune the threshold by hand.
// Clamped to [0.50, 0.95] so a slipped slider can't disable matching.
function pickClipThreshold(profileName, override) {
  if (typeof override === 'number' && isFinite(override) && override > 0) {
    return Math.max(0.50, Math.min(0.95, override));
  }
  return CLIP_THRESHOLDS[profileName] || CLIP_THRESHOLDS.normal;
}

// URL match — first-pass precision tier. Returns true if the candidate URL
// looks like a re-host of one of the product images (substring of filename
// or Shopify CDN path). Same as before — URL identity is the most reliable
// "definitely same product" signal we have, and it's free.
function buildUrlMatchKeys(productImageUrls) {
  const keys = new Set();
  for (const u of productImageUrls || []) {
    if (!u) continue;
    const noQuery = u.split('?')[0].toLowerCase();
    keys.add(noQuery);
    const filename = noQuery.split('/').pop();
    if (filename && filename.length > 6) keys.add(filename);
  }
  return keys;
}
function urlMatches(candidateUrl, urlMatchKeys) {
  if (!candidateUrl || !urlMatchKeys?.size) return false;
  const c = candidateUrl.split('?')[0].toLowerCase();
  if (urlMatchKeys.has(c)) return true;
  const cFile = c.split('/').pop();
  if (cFile && urlMatchKeys.has(cFile)) return true;
  for (const k of urlMatchKeys) {
    if (k.length >= 12 && candidateUrl.toLowerCase().includes(k)) return true;
  }
  return false;
}

// ============ SERP load ============
// Tried the homepage-and-type flow but chrome.scripting.executeScript hangs
// indefinitely on google.com in this Chrome version — every attempt timed
// out at the 30s cap. Reverted to direct URL navigation: simple, reliable,
// produces actual image counts. CAPTCHA on direct URL is the existing
// trade-off; the engine continues on CAPTCHA gracefully.

// Run a promise with a hard time cap.
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: `${label || 'operation'} timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      (err)   => { clearTimeout(timer); resolve({ ok: false, error: err?.message || String(err) }); }
    );
  });
}

// ============ SERP load + CLIP match ============
// Direct URL navigation. Tried the homepage-and-type "human flow" but it
// hung 100% on this Chrome version (chrome.scripting.executeScript on
// google.com homepage never returned). Direct URL is reliable.
//   1. Human-style: navigate to google.com, type the query, submit. Slower
//      (~3-5 s extra) but Google sees it as a real user search session, which
//      lowers CAPTCHA frequency.
//
// Multi-signal match confidence. CLIP alone can't distinguish "same product"
// from "different product, similar bottle" — supplement / cosmetics packaging
// is visually homogeneous across brands. We combine four signals taken
// directly from the SERP itself.
//
// Signals:
//   1. CLIP cosine            (max 40): visual similarity (× 0.5)
//   2. Color-palette match    (max 15): dominant-colors distance (× 0.2)
//   3. Brand mention          (+15)    : any alias in alt/title/link/seller text
//   4. Product-text overlap   (max 30): word-overlap between FULL product name
//                                      and the SERP thumbnail's text fields (× 0.35).
//                                      Single strongest signal — Amazon's alt text
//                                      for our product matches 6+ words of the raw
//                                      product title.
//   penalty (−15)             : CLIP ≥ 70 AND text-overlap < 30 % AND no brand
//                              (visually similar but textually unrelated → competitor)
//   penalty (−20)             : brand mentioned but no anchor word — same brand,
//                              different product (e.g. "NOW Foods Vitamin C"
//                              instead of our alfalfa)
//   bonus   (+10)             : text-overlap ≥ 60 % AND CLIP ≥ 55 (strong textual
//                              match + reasonable visual match = high-confidence)
//
// `isMatch` flips at combined >= 55. URL-identity and dHash hits skip this
// pipeline entirely — they're already definitive image-identity matches.
function _normalize(s) { return String(s || '').toLowerCase(); }

const _TEXT_SIM_SKIP = new Set([
  'a','an','the','for','and','or','of','in','on','by',
  'with','to','from','is','are','was','be',
]);
// Match a product word against the thumbnail's context text.
//   • Word ≤ 4 chars  → require WORD BOUNDARY ("now" must not match "know"
//     or "snow"; "650" must not match "16500").
//   • Word > 4 chars  → substring is safe (low collision risk for words
//     like "alfalfa" / "moisturizing").
// Fuzzy plural fallback applies the same word-boundary rule and requires
// the stripped form to be > 3 chars so we never bridge "tablet" → "tab".
function _ctxContainsWord(ctxText, word) {
  if (!word) return false;
  if (word.length <= 4) {
    try {
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${esc}\\b`, 'i').test(ctxText);
    } catch { return false; }
  }
  return ctxText.includes(word);
}

function _productTextSimilarity(fullProductName, ctxText) {
  const empty = { score: 0, matched: [], missed: [] };
  if (!fullProductName || !ctxText) return empty;
  const words = String(fullProductName).toLowerCase()
    .split(/[\s,\-–—/()]+/)
    .filter(w => w.length > 1 && !_TEXT_SIM_SKIP.has(w));
  if (words.length === 0) return empty;
  let matchCount = 0;
  const matched = [];
  const missed = [];
  for (const w of words) {
    if (_ctxContainsWord(ctxText, w)) {
      matchCount += 1;
      matched.push(w);
      continue;
    }
    // Fuzzy plural fallback ("tablet" matches "tablets" only when "tablet"
    // appears as its own word boundary — not as a substring of "tabletop").
    const fuzzy = w.replace(/s$/, '');
    if (fuzzy.length > 3 && fuzzy !== w && _ctxContainsWord(ctxText, fuzzy)) {
      matchCount += 0.8;
      matched.push(w + '~');
    } else {
      missed.push(w);
    }
  }
  return {
    score: Math.round((matchCount / words.length) * 100),
    matched,
    missed,
  };
}

// Weighted RGB distance approximating luminance perception (the same 0.30 /
// 0.59 / 0.11 weights used in dHash gray conversion). Two colors at distance
// 0 are identical; distance ~100 = unrelated. Map to a 0-100 "similarity"
// score by subtracting from 100 and clamping.
function _colorPaletteSimilarity(refColors, thumbColors) {
  if (!Array.isArray(refColors) || !Array.isArray(thumbColors)) return 0;
  if (refColors.length === 0 || thumbColors.length === 0) return 0;
  let totalMatch = 0;
  for (const ref of refColors) {
    let bestDist = Infinity;
    for (const tc of thumbColors) {
      const d = Math.sqrt(
        (ref.r - tc.r) ** 2 * 0.30 +
        (ref.g - tc.g) ** 2 * 0.59 +
        (ref.b - tc.b) ** 2 * 0.11
      );
      if (d < bestDist) bestDist = d;
    }
    totalMatch += Math.max(0, 100 - bestDist);
  }
  return Math.round(totalMatch / refColors.length);
}

function computeMatchConfidence(clipScorePct, ctx, productContext, thumbColors, searchQuery, priorMatchedUrls, priorMatchedConfidences) {
  // Two-pass scoring: primary pass on AGGRESSIVELY-stripped context (full
  // query + Google's "<query> from <domain>" suffix removed) gives high
  // precision — generic editorial images and mid-CLIP lookalikes never get
  // brand-credit from query-echo. Then a rescue pass for the few real
  // products whose page just happens to name itself with the query verbatim
  // (kiwla "now foods alfalfa, 650mg, 250 tabs"): they keep CLIP >= 75
  // because the visual really is our product, so we re-check brand+anchor
  // on the ORIGINAL un-stripped context and accept at a stricter (65) bar.
  const buildText = (strip) => {
    let t = [ctx?.seller, ctx?.title, ctx?.alt, ctx?.titleAttr, ctx?.linkText]
      .map(_normalize).join(' ');
    if (strip && typeof searchQuery === 'string') {
      const q = searchQuery.toLowerCase().trim();
      if (q.length > 2) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(escaped, 'gi'), ' ');
        t = t.replace(/\s+from\s+[\w.-]+\.\w{2,}/gi, ' ');
      }
    }
    return t.replace(/\s+/g, ' ').trim();
  };

  const strippedText = buildText(true);
  const originalText = buildText(false);

  const brandAliases = (productContext?.brandAliases || []).filter(a => a && a.length > 2);
  const handleWords  = (productContext?.handleWords  || []).filter(w => w && w.length > 3);
  // Brand check on strippedText (body) first — catches genuine brand
  // mentions in title/alt/seller after stripping the query echo. If
  // that misses, also check the ORIGINAL ctx URL/seller field: when
  // the SERP listing's domain literally IS our brand's site (e.g.
  // "aquaphorus.com" for an Aquaphor product), brand is unambiguous
  // regardless of whether the body text echoed the query word. Without
  // this, brand-domain SERP listings get flagged brand=✗ when the
  // keyword query happens to include the brand word.
  const sellerDomain = String(ctx?.seller || '').toLowerCase();
  // Brand-in-domain check: previously `sellerDomain.includes(a)` for any
  // alias. Short aliases like "now" (NOW Foods) or "ad" (A+D Ointment)
  // would falsely match unrelated domains via plain substring — e.g.
  // `nowblog.com`, `nownews.com`, `addtocart.com` would all light up
  // `brandInDomain` and inadvertently trigger the high-clip fail-tier
  // rescue. Two-layer guard:
  //   1. Skip aliases shorter than 4 chars — too generic to be reliable.
  //   2. Require a word-boundary on either side (start/end of host,
  //      hyphen, or dot) so "aquaphor" matches `aquaphorus.com` and
  //      `shop.aquaphor.com` but NOT a longer word containing the alias.
  const _brandDomainRe = (a) => new RegExp(`(?:^|[.\\-])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[.\\-]|$)`, 'i');
  const brandInDomain = brandAliases.some(a => {
    if (!a || a.length < 4) return false;
    return _brandDomainRe(a).test(sellerDomain);
  });
  const brandMentioned = brandAliases.some(a => strippedText.includes(a)) || brandInDomain;
  const anchorFound    = handleWords.some(w => strippedText.includes(w));
  // titleHasBrand: brand appears in the genuine page-title element (not the
  // alt / linkText where Google's query echo lives). Editorial images
  // (WebMD, Wikipedia) never have our brand in their actual heading.
  const titleText = _normalize(ctx?.title || '');
  const titleHasBrand = brandAliases.some(a => titleText.includes(a));
  const textSim = _productTextSimilarity(productContext?.fullProductName, strippedText);
  const colorScore = _colorPaletteSimilarity(productContext?.refColors, thumbColors);

  let total = 0;
  total += Math.min(40, clipScorePct  * 0.5);   // CLIP        — max 40
  total += Math.min(15, colorScore    * 0.2);   // Color match — max 15
  total += Math.min(30, textSim.score * 0.35);  // Text overlap — max 30
  if (brandMentioned) total += 15;              // Brand alias bonus

  // Visually similar but textually unrelated → almost certainly a competitor
  // with similar packaging.
  if (clipScorePct >= 70 && textSim.score < 30 && !brandMentioned) total -= 15;

  // Brand-absence hard cap — addresses the user-reported case where the
  // text matches on GENERIC category terms (omega / fish / oil are in
  // every fish-oil supplement listing) but no brand is mentioned. CLIP
  // 65-78 between similar-archetype bottles (Muscleblaze, MuscleNectar,
  // Centrum fish-oil softgels all look like our reference). Without
  // brand confirmation we cannot tell which bottle the listing is for.
  //
  // Rule: !brandMentioned AND CLIP < 80 → cap score at 35 (below the
  // 55 match threshold). Visually-unmistakable matches (CLIP >= 80)
  // skip this cap because the image alone is conclusive. The rescue
  // path below still recovers cache-trusted URLs (already verified on
  // a brand SERP), so legitimate cross-SERP attribution survives.
  let brandAbsenceCapped = false;
  if (!brandMentioned && clipScorePct < 80) {
    total = Math.min(total, 35);
    brandAbsenceCapped = true;
  }

  // Same brand, different product (brand in text but our product's anchor
  // word — the actual product identifier — is missing). E.g. "NOW Foods
  // Vitamin C" when we sell "NOW Foods Alfalfa".
  if (brandMentioned && !anchorFound) total -= 20;

  // Strong text + reasonable visual → definitive match.
  if (textSim.score >= 60 && clipScorePct >= 55) total += 10;

  // Low CLIP + no brand in the page title → almost certainly a generic /
  // editorial image (WebMD herb photo, Wikipedia botanical diagram).
  if (clipScorePct < 50 && !titleHasBrand) total -= 20;

  total = Math.round(Math.max(0, Math.min(100, total)));
  let isMatch = total >= 55;
  let rescued = false;
  let rescueSource = ''; // 'cache' | 'brand-context' (diagnostic)

  // Is this a "generic" query — one that doesn't name our brand? Generic
  // SERPs ("alfalfa 650 mg super green") mix our product with competitor
  // bottles that look visually similar (CLIP 65-78 lookalikes are common).
  // Rescue is stricter for these.
  const queryLower = typeof searchQuery === 'string' ? searchQuery.toLowerCase() : '';
  const isGenericQuery = queryLower.length === 0 || !brandAliases.some(a => queryLower.includes(a));
  const rescueClipFloor = isGenericQuery ? 80 : 75;

  // High-CLIP rescue — runs ONLY when the primary pass rejected us AND the
  // image is visually near-identical (CLIP >= floor). Two paths:
  //
  //   A) CACHE TRUST. If this URL was already matched on an EARLIER SERP
  //      for this product (almost always the product SERP or a brand
  //      keyword's SERP), we trust the prior decision. The brand context
  //      was already verified once; demanding it again on a generic
  //      keyword's SERP — where ALT text won't have our brand — would
  //      cost real matches.
  //
  //   B) BRAND-CONTEXT in the original (un-stripped) text. For brand
  //      queries we accept brand-mention anywhere in alt/title/seller.
  //      For generic queries we require brand in the PAGE TITLE — alt
  //      text often carries Google's echoed-query brand, which is unreliable.
  if (!isMatch && clipScorePct >= rescueClipFloor) {
    const priorMatched = priorMatchedUrls instanceof Set && priorMatchedUrls.has(ctx?.url);
    if (priorMatched) {
      const priorConf = (priorMatchedConfidences instanceof Map && priorMatchedConfidences.get(ctx?.url)) || 0;
      total = Math.max(priorConf, 65);
      isMatch = true;
      rescued = true;
      rescueSource = 'cache';
    } else {
      let origBrand = brandAliases.some(a => originalText.includes(a));
      const origAnchor = handleWords.some(w => originalText.includes(w));
      // Generic query → brand MUST be in the page-title element (not just
      // alt/seller). The query echo doesn't carry our brand in the title.
      if (isGenericQuery && origBrand && !titleHasBrand) {
        origBrand = false;
      }
      if (origBrand && origAnchor) {
        const origTextSim = _productTextSimilarity(productContext?.fullProductName, originalText);
        let rescueTotal = 0;
        rescueTotal += Math.min(40, clipScorePct  * 0.5);
        rescueTotal += Math.min(15, colorScore    * 0.2);
        rescueTotal += 15; // brand confirmed in original
        rescueTotal += Math.min(30, origTextSim.score * 0.35);
        if (origTextSim.score >= 60 && clipScorePct >= 50) rescueTotal += 10;
        rescueTotal = Math.round(Math.max(0, Math.min(100, rescueTotal)));
        if (rescueTotal >= 65) {
          total = rescueTotal;
          isMatch = true;
          rescued = true;
          rescueSource = 'brand-context';
        }
      }
    }
  }

  // Product identity (Layer 2) — tiered:
  //   full    — every coreTypeWord present → pass clean
  //   partial — ≥⌈N/2⌉ present → check brand + spec confirmation:
  //               brand ✓ + spec ✓ → -10 (accepted with small penalty)
  //               brand ✓ + spec ✗ → -25 + tag matchQuality='ambiguous'
  //                                  (may still pass threshold if other
  //                                   signals are strong; the matchQuality
  //                                   tag surfaces in the CSV)
  //               brand ✗ → -30 (treated as fail)
  //   fail    — <⌈N/2⌉ present → -30 (clearly wrong product)
  //
  // The "fish oil on bottle / count in alt text" case (kiwla.com,
  // amazon.com 180 EPA) lands in partial+brand+spec → accepted.
  // Generic brand-only pages (nowfoods.com overview) without specs
  // land in partial+brand-only → tagged ambiguous, may slip below
  // threshold via the penalty.
  let identityMatch = true;
  let identityMissing = [];
  let identityTier = 'full';
  let matchQuality = 'clean';
  // runDownstreamVetoes — gates the sibling/wrong-form/variant/brand-mate
  // checks below. Previously these guarded on `identityMatch` (which is
  // only true for tier='full'), so every rescue tier (partial_clip_high,
  // partial_text_high, partial_combined, partial_anchor_clip,
  // partial_brand_domain_high_clip, ambiguous_brand_match) BYPASSED the
  // vetoes — letting same-brand sibling SKUs slip through whenever a
  // rescue tier set isMatch=true. The vetoes now run whenever the thumb
  // is currently considered a match (isMatch=true at this point in the
  // pipeline), regardless of which tier produced it. Only fully-rejected
  // thumbs (isMatch=false) skip the cascade because there's nothing left
  // to veto.
  // If the brand-absence cap fired earlier, tag the match quality so
  // the breakdown log shows it. The cap pushes total to 35; the
  // threshold check below decides whether rescue brings it back.
  if (brandAbsenceCapped) matchQuality = 'no_brand_lowclip';
  if (typeof productContext?.checkProductIdentity === 'function') {
    const ident = productContext.checkProductIdentity(originalText) || { tier: 'full', match: true, missingWords: [] };
    identityTier = ident.tier || (ident.match ? 'full' : 'fail');
    identityMatch = identityTier === 'full';
    identityMissing = ident.missingWords || [];
    if (identityTier === 'partial') {
      // Check brand + spec confirmation.
      const specConf = (typeof productContext.hasSpecConfirmation === 'function')
        ? productContext.hasSpecConfirmation(originalText)
        : { confirmed: false };
      // Visual-confidence rescue: when CLIP score is high (>= 75) the
      // thumbnail is visually very similar to our reference product image.
      // Paired with brand mention (eliminates random visual lookalikes),
      // this is enough to confirm WITHOUT explicit text spec — covers the
      // common Google knowledge_panel / shopping_carousel case where each
      // tile carries only "amazon.in" / "babyamore.in" as context but the
      // user can visually verify the tile IS our SKU. Downstream sibling /
      // wrong-form / brand-mate vetoes still gate this layer, so a
      // same-brand SIBLING thumb won't slip through.
      //
      // Text-confidence rescue (parallel): SERP text shares ≥60% of our
      // product's words AND brand + anchor present → confirm. Handles
      // cases where the user's full product name has "garnish" words
      // ("Healing", "Advanced Therapy") that retailers routinely drop.
      //
      // Combined-signal rescue (third path): moderate CLIP (>= 65) +
      // moderate text overlap (>= 50%) → confirm. Catches borderline
      // visual + textual matches that fail BOTH single-signal thresholds
      // but together are clearly our SKU. Tagged 'partial_combined' so
      // the user can audit. Combined with brand requirement, this catches
      // the long tail of borderline thumbnails without over-promoting
      // random competitor pages.
      const highClipConfirms = clipScorePct >= 75;
      const highTextConfirms = (textSim?.score || 0) >= 60;
      const combinedConfirms = clipScorePct >= 65 && (textSim?.score || 0) >= 50;
      // Anchor-plus-CLIP rescue: when CLIP score is moderate (≥ 65), brand
      // is present, AND an anchor word (one of our product's identity
      // words like "baby" or "healing") is present in the SERP text, the
      // listing is almost certainly our SKU even if the overall text
      // overlap is low. This catches retailer listings where Google
      // truncates the snippet ("aquaphor baby" / "babyamore.in aquaphor
      // baby") and text-similarity comes back at 20-40% but the IMAGE +
      // brand + anchor combination is unambiguous. Sibling / wrong-form /
      // brand-mate vetoes still run after this rescue, so a same-brand
      // sibling SKU with matching anchor (Aquaphor Healing Ointment) is
      // still vetoed.
      const anchorPlusClipConfirms = clipScorePct >= 65 && anchorFound;
      if (brandMentioned && (
        specConf.confirmed ||
        highClipConfirms ||
        highTextConfirms ||
        combinedConfirms ||
        anchorPlusClipConfirms
      )) {
        total = Math.max(0, total - 10);
        isMatch = total >= 55;
        // Tag distinctly when the rescue rode on visual / text / combined
        // / anchor confidence (not spec) so the CSV row makes the source
        // of the confidence legible. Priority order reflects signal
        // strength: CLIP-high → text-high → combined → anchor+clip.
        if (!specConf.confirmed) {
          if (highClipConfirms) {
            matchQuality = 'partial_clip_high';
          } else if (highTextConfirms) {
            matchQuality = 'partial_text_high';
          } else if (combinedConfirms) {
            matchQuality = 'partial_combined';
          } else if (anchorPlusClipConfirms) {
            matchQuality = 'partial_anchor_clip';
          }
        }
      } else if (brandMentioned) {
        // Weak partial: brand present, no spec, CLIP not high enough to
        // visually confirm. Could be us, could be a sibling. Tag ambiguous;
        // the breakdown log shows the case so the user can audit.
        total = Math.max(0, total - 25);
        isMatch = total >= 55;
        matchQuality = 'ambiguous_brand_match';
      } else {
        total = Math.max(0, total - 30);
        isMatch = total >= 55;
      }
    } else if (identityTier === 'fail') {
      // Fail-tier rescue: when CLIP score is very high (≥ 85) AND brand
      // is unambiguous via the seller's own domain (e.g. aquaphorus.com
      // for an Aquaphor product, or nowfoods.com for a Now Foods
      // product), accept as a brand-domain-confirmed match. The brand's
      // own product page rarely embeds a competitor's image, so CLIP
      // saying "near-identical to our reference product photo" combined
      // with "this IS the brand's own page" is enough signal to call it
      // our product — even when the body text echoes the query and
      // strips out the brand word.
      //
      // Universal across all brands. The check requires brandInDomain
      // (computed earlier from ctx?.seller) — a SERP listing on
      // thebump.com or healthline.com does NOT trigger this, because
      // those domains don't contain "aquaphor" / "nowfoods" / etc.
      // Downstream sibling / wrong-form / brand-mate / variant-conflict
      // vetoes still gate this path so a same-brand SIBLING SKU image
      // hosted on the brand's domain is still vetoed.
      const failClipRescue = clipScorePct >= 85 && brandInDomain;
      if (failClipRescue) {
        total = Math.max(0, total - 15);
        isMatch = total >= 55;
        matchQuality = 'partial_brand_domain_high_clip';
      } else if (clipScorePct >= 70 && brandMentioned) {
        // Graduated rescue: identity 'fail' is usually a real wrong-product
        // signal, but a flat -30 penalty over-punishes text-poor SERP cards
        // (Pinterest pins, image-only carousels, cropped knowledge-panel
        // tiles) where the text was truncated even though the image IS
        // ours. When CLIP says "very visually similar" (>= 70) AND brand
        // is at least mentioned somewhere, apply -20 instead of -30. The
        // downstream sibling / variant / wrong-form vetoes still run on
        // every isMatch=true thumb, so a sibling SKU image that happens
        // to land here is still caught — this rescue only saves the
        // genuine same-product-text-poor case.
        total = Math.max(0, total - 20);
        isMatch = total >= 55;
        matchQuality = 'partial_clip_text_poor';
      } else {
        total = Math.max(0, total - 30);
        isMatch = total >= 55;
      }
    }
  }

  // Product-line modifier (Layer 2.5) — same brand + identity tokens
  // present, but the SERP context names a sibling-product LINE the
  // product itself doesn't carry ("Ultra Omega 3" when we sell "Omega 3").
  // Hard veto, same justification as identity: this isn't a different
  // size of the same product, it's a different formulation entirely.
  let productLineModifier = null;
  if (isMatch && typeof productContext?.checkProductLineModifier === 'function') {
    productLineModifier = productContext.checkProductLineModifier(originalText);
    if (productLineModifier) {
      isMatch = false;
    }
  }

  // Variant conflict (Layer 3) — same brand + same identity + same
  // packaging but a DIFFERENT size/dosage/volume/weight/pack size. The
  // image is "this product line, wrong SKU"; a customer searching for our
  // SKU and seeing that ad is a mismatch.
  //
  // Hard veto, not a penalty: any conflict drops `isMatch` to false. The
  // detection in hasConflictingSpec is conservative — it only fires when
  // ours is NOT present in context AND the named value clears a ratio
  // tolerance, so multi-variant pages ("available in 90 or 180 caps") and
  // comparison articles ("90 vs 180 which is better") don't trigger.
  // When the check DOES fire, the image is unambiguously the wrong SKU
  // and no amount of CLIP / color / brand signal should rescue it.
  //
  // Only runs when identity AND product-line both passed.
  let variantConflicts = [];
  if (isMatch && !productLineModifier && typeof productContext?.checkVariantConflict === 'function') {
    variantConflicts = productContext.checkVariantConflict(originalText) || [];
    if (variantConflicts.length > 0) {
      isMatch = false;
    }
  }

  // Sibling-product veto (Layer 4) — catches same-brand siblings the
  // identity/line/variant layers don't: form-alternative SERP listings
  // ("now foods omega 3 GUMMY chews" when our form is softgel), brand-
  // family siblings ("dha-1000", "mini gel", "3-6-9"), category-specific
  // sub-lines ("cerave AM" vs "cerave PM"). CLIP can't tell these apart
  // because the bottles look identical; text is the only defence.
  let siblingMatch = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 &&
      typeof productContext?.checkSiblingProduct === 'function') {
    siblingMatch = productContext.checkSiblingProduct(originalText);
    if (siblingMatch) {
      isMatch = false;
    }
  }

  // Variant-slot veto (Layer 5) — final text-based defence: same brand,
  // identity tokens present, no modifier/sibling/variant conflict, but
  // the SERP context names the OPPOSITE side of a product-line pair our
  // product is on (day vs night, men vs women, AM vs PM, etc.).
  let variantSlotMatch = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 && !siblingMatch &&
      typeof productContext?.checkVariantSlot === 'function') {
    variantSlotMatch = productContext.checkVariantSlot(originalText);
    if (variantSlotMatch) {
      isMatch = false;
    }
  }

  // Color veto (Layer 6) — universal across categories. Same brand, same
  // identity, no other conflict, but the context names a different color
  // than ours ("titanium black" product, context says "titanium violet").
  // Cosmetics, apparel, electronics, footwear, hair color, nail polish.
  let colorConflictMatch = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 && !siblingMatch && !variantSlotMatch &&
      typeof productContext?.checkColorConflict === 'function') {
    colorConflictMatch = productContext.checkColorConflict(originalText);
    if (colorConflictMatch) {
      isMatch = false;
    }
  }

  // Name-swap veto (Layer 7) — cosmetics-only shade/model swap. Only
  // fires when our product is a cosmetics-style SKU; the gate is inside
  // checkNameSwap (returns null for non-cosmetics products).
  let nameSwapMatch = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 && !siblingMatch && !variantSlotMatch && !colorConflictMatch &&
      typeof productContext?.checkNameSwap === 'function') {
    nameSwapMatch = productContext.checkNameSwap(originalText);
    if (nameSwapMatch) {
      isMatch = false;
    }
  }

  // Sibling ambiguity veto (Layer 8) — the only layer that depends on
  // OTHER products in the same batch. Fires when this SKU has siblings
  // that differ only on a quantity dimension AND the ctx either (a)
  // names a value that doesn't match ours (would be caught by Layer 3
  // variant check too, but kept here for completeness with the right
  // dimension named) or (b) doesn't name the discriminator at all — in
  // which case the image could equally be any sibling, so we can't claim
  // it for this specific SKU.
  let siblingAmbiguity = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 && !siblingMatch && !variantSlotMatch && !colorConflictMatch && !nameSwapMatch &&
      typeof productContext?.checkSiblingAmbiguity === 'function') {
    siblingAmbiguity = productContext.checkSiblingAmbiguity(originalText);
    if (siblingAmbiguity) {
      isMatch = false;
    }
  }

  // Attribute-family veto (Layer 9, category-keyed). Fires when the
  // product declares a value of a family (e.g. supplement.formulation =
  // "fish oil") and the SERP context declares a different value of the
  // same family ("vegan", "algae"). Per attribute-families.js, silent
  // product → no veto. Hard-veto on hit.
  let attrFamilyMatch = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 && !siblingMatch && !variantSlotMatch && !colorConflictMatch && !nameSwapMatch && !siblingAmbiguity &&
      typeof productContext?.checkAttributeFamily === 'function') {
    attrFamilyMatch = productContext.checkAttributeFamily(originalText);
    if (attrFamilyMatch) {
      isMatch = false;
    }
  }

  // Brand-mate veto (Layer 10) — cross-product discrimination that doesn't
  // require a shared baseKey. The pre-pass builds per-product exclusion
  // sets from OTHER same-brand SKUs in the batch; if the SERP text asserts
  // any of those tokens, it's a brand-mate's product, not ours. Catches
  // "Aquaphor Healing Ointment" (adult) falsely claiming a SERP image
  // captioned "Aquaphor Baby Healing Ointment" — "baby" is in our
  // brand-mate exclusion set.
  let brandMateMatch = null;
  if (isMatch && !productLineModifier && variantConflicts.length === 0 && !siblingMatch && !variantSlotMatch && !colorConflictMatch && !nameSwapMatch && !siblingAmbiguity && !attrFamilyMatch &&
      typeof productContext?.checkBrandMate === 'function') {
    brandMateMatch = productContext.checkBrandMate(originalText);
    if (brandMateMatch) {
      isMatch = false;
    }
  }

  // Pack-variant tagging — runs AFTER every veto layer. If we still have a
  // CONFIRMED match (clean OR any partial_* rescue tier), check whether
  // the SERP listing says "Pack of 3" / "Twin Pack" / "3-Pack" / "Set of
  // 2" / "60 count" etc. Skip ambiguous_brand_match / no_brand_lowclip
  // because those are NOT counted toward image_count — tagging them as
  // pack variants would be misleading.
  //
  // Previously this was gated on matchQuality === 'clean' only, so pack-
  // of-N listings that landed in a partial-rescue tier (partial_clip_high,
  // etc.) were never tagged — leading to pack_variant_count = 0 even
  // when packs were clearly present. Now tagging runs across all confirmed
  // tiers; the original tier label is preserved as a suffix so the CSV
  // shows BOTH the rescue tier and the pack status
  // (e.g. "pack_variant_3|partial_clip_high").
  const _ambiguousQ = matchQuality === 'ambiguous_brand_match' || matchQuality === 'no_brand_lowclip';
  if (isMatch && !_ambiguousQ) {
    const pack = detectPackIndicator(originalText);
    if (pack) {
      matchQuality = (matchQuality && matchQuality !== 'clean')
        ? `${pack.label}|${matchQuality}`
        : pack.label;
    }
  }

  return {
    total,
    clipScore: clipScorePct,
    colorScore,
    textScore: textSim.score,
    matchedWords: textSim.matched,
    missedWords:  textSim.missed,
    brandMentioned,
    anchorFound,
    titleHasBrand,
    rescued,
    rescueSource,
    isGenericQuery,
    contextSample: strippedText.slice(0, 80).trim(),
    identityMatch,
    identityMissing,
    identityTier,
    matchQuality,
    productLineModifier,
    variantConflicts,
    siblingMatch,
    variantSlotMatch,
    colorConflictMatch,
    nameSwapMatch,
    siblingAmbiguity,
    attrFamilyMatch,
    brandMateMatch,
    isMatch,
  };
}

async function loadProductSerp(seedQuery, referenceEmbeddings, productImageUrls, threshold, log, productContext, loadOpts = {}) {
  log = log || (() => {});

  // forceMethod: 'directUrl' skips chrome.search.query() and goes straight
  // to the direct URL path. Used by the brand_product 0-match retry so the
  // second attempt rolls a different SERP layout / fingerprint than the
  // first (Google A/B-tests SERPs heavily — different referrers can land
  // different buckets).
  const forceDirectUrl = loadOpts.forceMethod === 'directUrl';

  let tabId;
  // Primary path: chrome.search.query() — Chrome's built-in extension API for
  // performing searches AS IF the user typed in the omnibox. Goes out with
  // normal browsing context (referrer, cookies, omnibox-search fingerprint),
  // which is more human-looking than direct URL navigation.
  let chromeSearchOk = false;
  if (!forceDirectUrl && chrome.search?.query) {
    try {
      // Ensure worker tab exists first (chrome.search.query needs a tabId).
      tabId = await Worker.navigate('about:blank');
      log(`using chrome.search.query() — human-style search via Chrome's omnibox API`);
      await chrome.search.query({ text: seedQuery, tabId });
      const navRace = await withTimeout(waitForNavigationComplete(tabId), 25_000, 'chrome.search navigation');
      if (navRace.ok) {
        chromeSearchOk = true;
      } else {
        log(`chrome.search.query navigation timed out, falling back to direct URL`);
      }
    } catch (e) {
      log(`chrome.search.query failed (${e.message}) — falling back to direct URL`);
    }
  }

  // Fallback: direct URL navigation
  if (!chromeSearchOk) {
    // pws=0 disables personalized web search — Google still A/B-tests SERP
    // layouts, but at least our session history doesn't bias the result set.
    // Keeps direct-URL passes more reproducible than chrome.search.query().
    const url = `https://www.google.com/search?q=${encodeURIComponent(seedQuery)}&gl=in&hl=en&pws=0`;
    log(`navigating to Google search (direct URL)`);
    try {
      const navRace = await withTimeout(Worker.navigate(url), 25_000, 'SERP navigation');
      if (!navRace.ok) return { ok: false, error: navRace.error };
      tabId = navRace.value;
    } catch (e) {
      return { ok: false, error: `SERP navigation failed: ${e.message}` };
    }
  }

  await sleep(randInt(DELAY_AFTER_TAB_LOAD_MS, DELAY_AFTER_TAB_LOAD_MS + 1200));
  const readiness = await ensureContentScriptReady(tabId, 'SERP_PING', 'serp-reader.js');
  if (!readiness.ok) {
    const urlPart = readiness.url ? ` (current tab URL: ${readiness.url.slice(0, 160)})` : '';
    return { ok: false, error: `serp script not ready: ${readiness.error || 'no response'}${urlPart}` };
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_DATA' });
  } catch (e) {
    return { ok: false, error: `SERP message failed: ${e.message}` };
  }

  if (resp?.captcha) {
    return {
      ok: false,
      captcha: true,
      error: resp.error || 'CAPTCHA detected',
      // Tag which method got blocked so the inline retry flips to the
      // other one ('chrome.search.query' vs 'directUrl').
      method: chromeSearchOk ? 'chromeSearch' : 'directUrl',
    };
  }

  // SERP reader now returns enriched items: { url, seller, price }. Build a
  // lookup map URL → {seller, price} so matched thumbnails can carry their
  // retailer + price context into the report.
  const rawItems = Array.isArray(resp?.urls) ? resp.urls : [];
  const ctxByUrl = new Map();
  const urls = [];
  for (const item of rawItems) {
    if (typeof item === 'string') {
      // Back-compat: older serp-reader returned plain strings
      if (!ctxByUrl.has(item)) {
        urls.push(item);
        ctxByUrl.set(item, { seller: '', price: '', title: '', alt: '', titleAttr: '', linkText: '' });
      }
    } else if (item && typeof item.url === 'string') {
      if (!ctxByUrl.has(item.url)) {
        urls.push(item.url);
        ctxByUrl.set(item.url, {
          seller:    item.seller    || '',
          price:     item.price     || '',
          title:     item.title     || '',
          alt:       item.alt       || '',
          titleAttr: item.titleAttr || '',
          linkText:  item.linkText  || '',
          // Destination page URL for this result — used by the optional
          // matched-link verification step.
          link:      item.link      || '',
          // Carry the source-region tag so we can compute a
          // matched-only zone breakdown (separate from sourceBreakdown
          // which counts ALL captured thumbs).
          source:    item.source    || '',
        });
      }
    }
  }
  const paa             = Array.isArray(resp?.paa)             ? resp.paa             : [];
  const allSellers      = Array.isArray(resp?.sellers)         ? resp.sellers         : [];
  const totalSellers    = typeof resp?.totalSellers === 'number' ? resp.totalSellers : allSellers.length;
  const adsOnSerp       = typeof resp?.adsOnSerp    === 'number' ? resp.adsOnSerp    : 0;
  const relatedSearches = Array.isArray(resp?.relatedSearches) ? resp.relatedSearches : [];
  const sourceBreakdown = (resp && typeof resp.sourceBreakdown === 'object' && resp.sourceBreakdown) || {};
  const serpBlocked     = resp?.serpBlocked === true;

  let matchedThumbnails  = [];
  let matchedConfidences = [];
  let matchedEmbeddings  = [];
  let matchedSellers     = [];
  let matchedPrices      = [];
  let matchedLinks       = [];
  let urlMatchCount = 0;
  let scored = 0;
  const tierBreakdown = { cache: 0, dhash: 0, clip: 0 };

  // matchedQualities[i] aligns with matchedThumbnails[i]:
  //   'clean'                    — full identity match
  //   'partial_spec_confirmed'   — partial identity + brand + spec confirmation
  //   'ambiguous_brand_match'    — partial identity + brand only (audit needed)
  //   'dhash'                    — dHash near-identical hit, identity skipped
  //   'url_match'                — URL identity match, identity skipped
  // Surfaces in CSV as a `match_qualities` column so the user can filter
  // ambiguous-brand-only matches out (or audit them) without losing
  // count signal.
  const matchedQualities = [];
  const pushMatch = (url, conf, emb, quality = 'clean') => {
    const ctx = ctxByUrl.get(url) || { seller: '', price: '' };
    matchedThumbnails.push(url);
    matchedConfidences.push(conf);
    matchedEmbeddings.push(emb);
    matchedSellers.push(ctx.seller);
    matchedPrices.push(ctx.price);
    matchedLinks.push(ctx.link || '');
    // dHash veto path stashes a tier on the ctx so we pick it up here.
    if (quality === 'clean' && ctx._matchQuality) {
      quality = ctx._matchQuality;
    }
    matchedQualities.push(quality);
  };

  // Tier 1 (URL identity match) — always runs.
  const urlMatchedSet = new Set();
  if (urls.length > 0 && productImageUrls?.length) {
    const urlMatchKeys = buildUrlMatchKeys(productImageUrls);
    for (const u of urls) {
      if (urlMatches(u, urlMatchKeys)) {
        pushMatch(u, 100, null, 'url_match');
        urlMatchedSet.add(u);
        urlMatchCount++;
      }
    }
  }

  // Tier 2 (CLIP) — only if embeddings are available.
  //
  // Multi-signal scoring: we feed every thumbnail that the sandbox SCORED
  // (regardless of whether it cleared the raw CLIP threshold) into
  // computeMatchConfidence, which folds CLIP + brand-text context into a
  // single 0-100 confidence. The final match decision is `confidence >= 55`,
  // not the raw CLIP threshold. This fixes both failure modes that single-
  // signal CLIP couldn't:
  //   • False positive: competitor bottle scores 0.81 CLIP but has no
  //     brand mention → penalty → final 42 → skip.
  //   • False negative: own product scores 0.76 CLIP + brand in alt text
  //     → bonus → final 90 → keep.
  //
  // dHash / URL-identity hits skip the multi-signal scorer — they're
  // definitive same-image matches and don't need verification.
  const allScores = [];                  // all per-thumb CLIP scores (for near-miss diagnostics)
  let unverifiedCount = 0;               // CLIP-passed thumbs that the multi-signal scorer rejected
  const unverifiedSamples = [];          // up to 5 examples for the log
  const matchBreakdownLog = [];          // [{conf, clip, brand, product, ctx, kept}] for the engine's per-thumb log
  if (urls.length > 0 && referenceEmbeddings?.length) {
    const clipCandidates = urls.filter(u => !urlMatchedSet.has(u));
    if (clipCandidates.length > 0) {
      // Force the sandbox to score EVERY thumbnail by passing threshold=0 —
      // we want raw CLIP scores so the engine-side scorer can apply the
      // multi-signal logic. Brand text can pull a 0.66 thumb into a match,
      // so we can't filter to >= threshold inside the sandbox anymore.
      const results = await matchImages(referenceEmbeddings, clipCandidates, 0, { includeEmbeddings: true });
      scored = results.filter(r => !r.error).length;
      for (const r of results) {
        if (typeof r.score === 'number') allScores.push(Math.round(r.score * 100));
        const confPct = Math.round((r.score || 0) * 100);
        // dHash hits — visually near-identical to our reference. The
        // assumption "near-identical bottle = our product" breaks when
        // sibling SKUs share packaging design (Super Enzymes 90 vs 180
        // capsules: same label, just different number) or when sibling
        // products share brand visual style (Plant Enzymes vs Super
        // Enzymes). Gate the dHash accept on the same identity + variant
        // checks that computeMatchConfidence runs for the multi-signal
        // path, using the surrounding SERP text.
        if (r.via === 'dhash' && r.isMatch) {
          const dCtx = ctxByUrl.get(r.url) || {};
          const dText = [dCtx.seller, dCtx.title, dCtx.alt, dCtx.titleAttr, dCtx.linkText]
            .filter(Boolean).join(' ').toLowerCase();
          let vetoReason = null;
          if (typeof productContext?.checkProductIdentity === 'function') {
            const ident = productContext.checkProductIdentity(dText);
            // Brand-in-domain check, same logic as multi-signal path —
            // catches the case where the SERP listing is hosted on the
            // brand's own domain (aquaphorus.com / nowfoods.com /
            // larocheposay.com) but the body text doesn't echo the
            // brand word.
            const dSellerDomain = String(dCtx.seller || '').toLowerCase();
            const dBrandInDomain = (productContext.brandAliases || []).some(
              a => a && dSellerDomain.includes(a)
            );
            if (ident && ident.tier === 'fail') {
              // Fail-tier rescue: dHash already says the image is
              // visually near-identical to our reference. If the seller
              // domain IS the brand's own site, accept as a
              // brand-domain-confirmed match. Universal across brands.
              if (dBrandInDomain) {
                dCtx._identityTier = 'fail';
                dCtx._matchQuality = 'partial_brand_domain_high_clip';
              } else {
                vetoReason = `identity fail (missing:${(ident.missingWords || []).join(',')})`;
              }
            } else if (ident && ident.tier === 'partial') {
              // Partial — same rescue logic as multi-signal path: require
              // brand + spec confirmation. Without spec confirmation a
              // dHash hit on a generic brand-overview page would otherwise
              // wrongly claim our SKU.
              const brand = (productContext.brandAliases || []).some(a => a && dText.includes(a));
              const specConf = typeof productContext.hasSpecConfirmation === 'function'
                ? productContext.hasSpecConfirmation(dText)
                : { confirmed: false };
              if (!brand) {
                vetoReason = `identity partial+no_brand (missing:${(ident.missingWords || []).join(',')})`;
              } else if (!specConf.confirmed) {
                // Brand match but no spec — mark ambiguous; let it through
                // with attribution so the row is visible but flagged.
                // (No veto reason set; falls to pushMatch with ambiguous
                // matchQuality tag below.)
              }
              // Stash the tier on the dCtx so the breakdown log + row
              // pickup the matchQuality. dHash matches are already
              // visually near-identical to the reference image, so when
              // brand is also present we treat them as visual-confidence
              // confirmed even without spec — same logic as the multi-
              // signal partial_clip_high tier, just sourced from dHash
              // instead of CLIP cosine.
              if (!vetoReason) {
                dCtx._identityTier = 'partial';
                if (specConf.confirmed) {
                  dCtx._matchQuality = 'partial_spec_confirmed';
                } else if (brand) {
                  dCtx._matchQuality = 'partial_clip_high';
                } else {
                  dCtx._matchQuality = 'ambiguous_brand_match';
                }
              }
            }
          }
          if (!vetoReason && typeof productContext?.checkVariantConflict === 'function') {
            const conflicts = productContext.checkVariantConflict(dText) || [];
            if (conflicts.length > 0) {
              const c = conflicts[0];
              vetoReason = `variant (${c.type}:${c.ours}/${c.theirs})`;
            }
          }
          if (!vetoReason && typeof productContext?.checkSiblingProduct === 'function') {
            const sib = productContext.checkSiblingProduct(dText);
            if (sib) vetoReason = `sibling (${sib.term}:${sib.type})`;
          }
          if (!vetoReason && typeof productContext?.checkVariantSlot === 'function') {
            const slt = productContext.checkVariantSlot(dText);
            if (slt) vetoReason = `slot (${slt.ours}!=${slt.theirs})`;
          }
          if (!vetoReason && typeof productContext?.checkColorConflict === 'function') {
            const clr = productContext.checkColorConflict(dText);
            if (clr) vetoReason = `color (${clr.ours}!=${clr.theirs})`;
          }
          if (!vetoReason && typeof productContext?.checkNameSwap === 'function') {
            const sw = productContext.checkNameSwap(dText);
            if (sw) vetoReason = `swap (+${sw.extras.join(',')}/-${sw.missing.join(',')})`;
          }
          if (!vetoReason && typeof productContext?.checkSiblingAmbiguity === 'function') {
            const sa = productContext.checkSiblingAmbiguity(dText);
            if (sa) {
              vetoReason = sa.ambiguous
                ? `ambig (no_confirmation)`
                : sa.kind === 'raw'
                  ? `ambig (raw: ${sa.token})`
                  : sa.kind === 'attr'
                    ? `ambig (attr ${sa.family}: ${sa.ours ?? '—'}/${sa.theirs})`
                    : `ambig (qty ${sa.dim}: ${sa.ours}/${sa.theirs})`;
            }
          }
          if (!vetoReason && typeof productContext?.checkAttributeFamily === 'function') {
            const af = productContext.checkAttributeFamily(dText);
            if (af) vetoReason = `attr (${af.family}: ${af.ours}/${af.theirs})`;
          }
          if (!vetoReason && typeof productContext?.checkBrandMate === 'function') {
            const bm = productContext.checkBrandMate(dText);
            if (bm) vetoReason = `brand_mate (${bm.token})`;
          }
          if (vetoReason) {
            matchBreakdownLog.push({
              conf:    confPct,
              clip:    confPct,
              color:   '—',     // secondary scores aren't computed on dHash veto
              text:    '—',
              matched: [],
              brand:   false,
              anchor:  false,
              product: null,
              variant: null,
              via:     'dhash',
              ctx:     dText.slice(0, 80),
              kept:    false,
              veto:    vetoReason,
            });
            continue;
          }
          // dHash kept — pickup any matchQuality tag the partial-identity
          // rescue stashed on dCtx. If the result would be a plain 'dhash'
          // tag (no partial-identity rescue fired), check for a pack
          // indicator in the surrounding SERP text and upgrade to
          // 'pack_variant_N' if the listing is the multipack retail
          // variant of our SKU.
          let dQuality = dCtx._matchQuality || 'dhash';
          if (dQuality === 'dhash') {
            const pack = detectPackIndicator(dText);
            if (pack) dQuality = pack.label;
          }
          pushMatch(r.url, confPct, r.embedding || null, dQuality);
          continue;
        }
        // Multi-signal path: ALL CLIP-scored thumbs are evaluated, regardless
        // of how low CLIP scored. A high text-overlap can lift a CLIP=50 thumb
        // into a match if the alt text shows our brand + product name. The
        // previous CLIP pre-filter (>= threshold-12) was killing exactly
        // those cases — different photo angle but unmistakably our product.
        const baseCtx = ctxByUrl.get(r.url);
        // Attach the URL onto ctx so the rescue path can look it up in the
        // per-product matched-URL cache.
        const ctx = baseCtx ? { ...baseCtx, url: r.url } : { url: r.url };
        const thumbColors = Array.isArray(r.colors) ? r.colors : [];
        const ms = computeMatchConfidence(
          confPct, ctx, productContext, thumbColors, seedQuery,
          loadOpts.priorMatchedUrls, loadOpts.priorMatchedConfidences
        );
        // To keep the per-keyword log readable, only surface thumbs that have
        // ANY signal (CLIP >= 40 OR text-overlap > 0).
        if (confPct >= 40 || ms.textScore > 0) {
          matchBreakdownLog.push({
            conf:    ms.total,
            clip:    ms.clipScore,
            color:   ms.colorScore,
            text:    ms.textScore,
            matched: ms.matchedWords.slice(0, 6),
            brand:   ms.brandMentioned,
            anchor:  ms.anchorFound,
            product: ms.identityTier === 'fail'
              ? `fail(missing:${(ms.identityMissing || []).join(',')})`
              : ms.identityTier === 'partial'
                ? `partial(missing:${(ms.identityMissing || []).join(',')},quality:${ms.matchQuality})`
                : 'ok',
            matchQuality: ms.matchQuality || null,
            line:    ms.productLineModifier ? ms.productLineModifier.modifier : null,
            sibling: ms.siblingMatch ? `${ms.siblingMatch.term}(${ms.siblingMatch.type})` : null,
            slot:    ms.variantSlotMatch ? `${ms.variantSlotMatch.ours}!=${ms.variantSlotMatch.theirs}` : null,
            colorVeto: ms.colorConflictMatch ? `${ms.colorConflictMatch.ours}!=${ms.colorConflictMatch.theirs}` : null,
            swap:    ms.nameSwapMatch ? `+${ms.nameSwapMatch.extras.join(',')}/-${ms.nameSwapMatch.missing.join(',')}` : null,
            ambig:   ms.siblingAmbiguity
                       ? (ms.siblingAmbiguity.ambiguous
                          ? `no_confirmation`
                          : (ms.siblingAmbiguity.kind === 'raw'
                             ? `raw(${ms.siblingAmbiguity.token})`
                             : ms.siblingAmbiguity.kind === 'attr'
                               ? `attr(${ms.siblingAmbiguity.family}:${ms.siblingAmbiguity.ours ?? '—'}/${ms.siblingAmbiguity.theirs})`
                               : `qty(${ms.siblingAmbiguity.dim}:${ms.siblingAmbiguity.ours}/${ms.siblingAmbiguity.theirs})`))
                       : null,
            attr:    ms.attrFamilyMatch
                       ? `${ms.attrFamilyMatch.family}:${ms.attrFamilyMatch.ours}/${ms.attrFamilyMatch.theirs}`
                       : null,
            brandMate: ms.brandMateMatch ? ms.brandMateMatch.token : null,
            ctx:     ms.contextSample,
            kept:    ms.isMatch,
            variant: ms.variantConflicts && ms.variantConflicts.length > 0
              ? ms.variantConflicts.map(c => `${c.type}:${c.ours}/${c.theirs}`).join(',')
              : null,
          });
        }
        if (ms.isMatch) {
          pushMatch(r.url, ms.total, r.embedding || null, ms.matchQuality || 'clean');
        } else if (confPct >= Math.round(threshold * 100)) {
          // Was a raw CLIP match but multi-signal flipped it to "no" — that
          // means CLIP was confident but context didn't agree. Worth
          // surfacing as an "unverified candidate" for audit.
          unverifiedCount++;
          if (unverifiedSamples.length < 5) {
            unverifiedSamples.push({
              url:    r.url,
              conf:   confPct,
              total:  ms.total,
              text:   ms.textScore,
              seller: (ctx?.seller || '').slice(0, 40),
              title:  (ctx?.title  || ctx?.alt || '').slice(0, 60),
            });
          }
        }
      }
      tierBreakdown.cache = results.cacheHits || 0;
      tierBreakdown.dhash = results.dhashHits || 0;
      tierBreakdown.clip  = results.clipHits  || 0;
    }
  }
  allScores.sort((a, b) => b - a);
  const thresholdPct = Math.round(threshold * 100);
  const nearMissBand = 8; // points below threshold
  const nearMisses = allScores.filter(s => s >= thresholdPct - nearMissBand && s < thresholdPct);

  // Per-zone breakdown of MATCHED thumbnails (separate from sourceBreakdown
  // which counts every captured thumb regardless of whether it matched).
  // Lets the CSV show "where did the wins come from" — knowledge_panel:5,
  // organic:3 etc.
  const matchSourceBreakdown = {};
  for (const url of matchedThumbnails) {
    const src = (ctxByUrl.get(url) || {}).source || 'unknown';
    matchSourceBreakdown[src] = (matchSourceBreakdown[src] || 0) + 1;
  }

  return {
    ok: true,
    // Which navigation method actually landed the SERP — used by the
    // CAPTCHA inline retry to flip to the OTHER method ('chromeSearch'
    // vs 'directUrl') on the next attempt, since verification often
    // sits on a per-method fingerprint.
    method: chromeSearchOk ? 'chromeSearch' : 'directUrl',
    count: matchedThumbnails.length,
    matchedThumbnails,
    matchedConfidences,
    matchedEmbeddings,
    matchedSellers,
    matchedLinks,
    matchedPrices,
    matchedQualities,
    urlMatchCount,
    paa,
    // Rich SERP context — every keyword carries its own seller landscape +
    // related-search seeds. Never inherited or shared across keywords.
    allSellers,
    totalSellers,
    adsOnSerp,
    relatedSearches,
    thumbCount: urls.length,
    scored,
    tierBreakdown,
    // Diagnostic: top-10 per-thumbnail CLIP scores + near-miss count so the
    // engine can surface "you're 2 points below the threshold" in logs.
    topScores: allScores.slice(0, 10),
    nearMissCount: nearMisses.length,
    thresholdPct,
    // Which SERP regions the thumbnails came from
    // (shopping_carousel, knowledge_panel, sponsored, organic, background_image).
    sourceBreakdown,
    // Soft-blocked SERP: results pane empty + only Google asset images
    // captured. Engine should NOT record 0-image rows on such SERPs as
    // real "0 visibility" — they're Google bot-flagging us.
    serpBlocked,
    // Same shape as sourceBreakdown but counts ONLY matched thumbnails.
    matchSourceBreakdown,
    // Two-step verification: CLIP candidates that passed the threshold but
    // had no brand mention in their surrounding SERP text. They're NOT in
    // matchedThumbnails / count — kept here as a separate diagnostic.
    unverifiedCount,
    unverifiedSamples,
    // Per-thumb multi-signal breakdown for the engine's per-keyword log:
    //   [{ conf, clip, brand, product, ctx, kept }, ...]
    matchBreakdownLog,
  };
}

// ============ Noise filter (cosine variant) ============
// Cluster matched thumbnails across this product's keywords by visual
// similarity (cosine of CLIP embeddings). Big clusters = the product appearing
// across many keywords. Tiny clusters = isolated false positives. Drop
// clusters smaller than MIN_RELATIVE_SIZE × biggest. URL-matched thumbs have
// no embedding and are treated as definitive (always kept).
const NOISE_FILTER_CLUSTER_COSINE = 0.92;

function clusterByCosine(items, cosineThreshold) {
  const clusters = [];
  for (const item of items) {
    if (!item.emb) {
      clusters.push({ rep: null, items: [item], definitive: true });
      continue;
    }
    let placed = false;
    for (const c of clusters) {
      if (c.rep && cosineSimilarity(c.rep, item.emb) >= cosineThreshold) {
        c.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: item.emb, items: [item], definitive: false });
  }
  return clusters;
}

function applyNoiseFilter(productRows, opts = {}) {
  const minRelativeSize = opts.minRelativeSize ?? NOISE_FILTER_MIN_RELATIVE_SIZE;
  const cosineT         = opts.cosineThreshold  ?? NOISE_FILTER_CLUSTER_COSINE;

  const items = [];
  for (const row of productRows) {
    const thumbs = row.matchedThumbnails || [];
    const embs   = row._matchedEmbeddings || [];
    for (let i = 0; i < thumbs.length; i++) {
      items.push({ emb: embs[i] || null, rowKey: row.keyword.toLowerCase(), idx: i });
    }
  }
  if (items.length === 0) {
    return { kept: 0, dropped: 0, clusters: 0, keptClusters: 0, maxSize: 0, cutoff: 0 };
  }

  const clusters = clusterByCosine(items, cosineT);
  const embClusters = clusters.filter(c => !c.definitive);
  const maxSize = embClusters.length > 0 ? Math.max(...embClusters.map(c => c.items.length)) : 1;
  // For niche / low-match products (< 10 total matched thumbs across the
  // whole product) every cluster is size 1, so the default cutoff=2 would
  // drop every match. Drop the cutoff to 1 in that regime — the noise
  // filter is designed to catch popular-product false positives that recur
  // many times, not to delete sparse-but-real matches.
  const cutoff  = items.length < 10
    ? 1
    : Math.max(2, Math.floor(maxSize * minRelativeSize));

  const keep = new Set();
  let keptClusters = 0;
  for (const c of clusters) {
    if (c.definitive || c.items.length >= cutoff) {
      keptClusters++;
      for (const it of c.items) keep.add(`${it.rowKey}|${it.idx}`);
    }
  }

  let kept = 0, dropped = 0;
  for (const row of productRows) {
    const thumbs   = row.matchedThumbnails || [];
    const embs     = row._matchedEmbeddings || [];
    const confs    = row.matchedConfidences || [];
    const sellers  = row.matchedSellers || [];
    const prices   = row.matchedPrices || [];
    const newThumbs = [];
    const newEmbs = [];
    const newConfs = [];
    const newSellers = [];
    const newPrices = [];
    for (let i = 0; i < thumbs.length; i++) {
      if (keep.has(`${row.keyword.toLowerCase()}|${i}`)) {
        newThumbs.push(thumbs[i]);
        newEmbs.push(embs[i] || null);
        newConfs.push(confs[i] || 0);
        newSellers.push(sellers[i] || '');
        newPrices.push(prices[i] || '');
        kept++;
      } else {
        dropped++;
      }
    }
    row.matchedThumbnails = newThumbs;
    row._matchedEmbeddings = newEmbs;
    row.matchedConfidences = newConfs;
    row.matchedSellers = newSellers;
    row.matchedPrices = newPrices;
    row.imageCount = newThumbs.length;
  }

  return { kept, dropped, clusters: clusters.length, keptClusters, maxSize, cutoff };
}

// ============ Main entry ============
export async function runKeywordDiscovery(products, onProgress, opts = {}) {
  const cap             = opts.cap             || KEYWORD_CAP;
  const kpUrl           = opts.kpUrl           || '';
  const kpMaxPerProduct = opts.kpMaxPerProduct || 5000;
  const shouldStop      = opts.shouldStop      || (() => false);
  const matchProfile    = MATCH_PROFILES[opts.matchProfile] || MATCH_PROFILES[DEFAULT_MATCH_PROFILE];
  const matchProfileName = MATCH_PROFILES[opts.matchProfile] ? opts.matchProfile : DEFAULT_MATCH_PROFILE;

  // Pacing (caller can override per run; defaults from config).
  const searchDelayMin  = opts.searchDelayMinMs ?? SEARCH_DELAY_MIN_MS;
  const searchDelayMax  = opts.searchDelayMaxMs ?? SEARCH_DELAY_MAX_MS;
  const productDelayMin = opts.productDelayMinMs ?? PRODUCT_DELAY_MIN_MS;
  const productDelayMax = opts.productDelayMaxMs ?? PRODUCT_DELAY_MAX_MS;
  const chunkSize       = Math.max(1, opts.chunkSize ?? CHUNK_SIZE);
  const chunkRestMin    = opts.chunkRestMinMs ?? CHUNK_REST_MIN_MS;
  const chunkRestMax    = opts.chunkRestMaxMs ?? CHUNK_REST_MAX_MS;

  const report        = opts.report        || new Map();
  const excludeUrls   = opts.excludeUrls   || new Set();
  const onRowAdded    = opts.onRowAdded    || (async () => {});
  const onProductDone = opts.onProductDone || (async () => {});
  const batchId       = opts.batchId       || String(Date.now());

  // ----- Data-feature knobs (default ON) -----
  // alwaysExpandAutosuggest: fetch autosuggest for EVERY keyword and SERP-cycle
  //   each suggestion, regardless of whether the parent matched (removes the
  //   image-guided expansion optimisation → more coverage, longer runs).
  const alwaysExpandAutosuggest = opts.alwaysExpandAutosuggest !== false;
  // backfillKpMetrics: after discovery, run ONE KP "Search volume" scrape per
  //   product to fill kp_* columns on non-KP rows (autosuggest/PAA/related/amazon).
  const backfillKpMetrics = opts.backfillKpMetrics !== false;
  // maxAmazonKeywords: cap on keywords per product entering the Amazon Round.
  // Raised default 30→50 to keep pace with the wider R1/R2 KP net so total
  // per-SKU output reliably lands in the 100-300 target range.
  const maxAmazonKeywords = Math.max(1, opts.maxAmazonKeywords || 50);
  // verifyMatchedLinks: open each matched result's destination page and re-check
  //   it carries our product image (bounded to matched links only).
  const verifyMatchedLinks = opts.verifyMatchedLinks !== false;
  const maxLinkVerify = Math.max(1, opts.maxLinkVerify || 5);

  if (!kpUrl) throw new Error('Keyword Planner URL is required (Settings tab).');

  // Kick off CLIP model load now so it's warming up while KP runs for the
  // first product. Errors here are non-fatal — image matching just won't
  // happen if the matcher fails to init.
  initMatcher().catch((e) => {
    onProgress?.({ currentAction: `CLIP matcher init warning (will retry per product): ${e.message}`, logKind: 'err' });
  });

  const sorted = [...products].sort((a, b) => a.priority - b.priority);

  // Pre-pass: group products by baseKey (name stripped of every quantity
  // token) and identify three kinds of cross-sibling discriminators —
  // unified into one `siblingGroupInfo` object per product:
  //   • quantityDiscriminators — count/dose/volume/mass dims that differ
  //   • attrFamilyDiscriminators — supplement.formulation / skincare.spf
  //     / etc. families where siblings disagree (including silent-vs-asserted)
  //   • rawDiscriminators — raw tokens that appear in some siblings but
  //     not all (auto-derived, universal across categories — handles the
  //     "fish oil" vs "enteric coated" naming case without config)
  //
  // The unified ambiguity gate (checkSiblingAmbiguity) then enforces:
  //   (a) ctx asserting a discriminator we don't own → mismatch veto
  //   (b) ctx asserting no discriminator we DO own → ambiguity veto
  //
  // Single-member groups produce no info; gate is silent for them.
  const siblingInfoByIdx = new Map();
  if (typeof opts.baseKey === 'function' && typeof opts.parseQty === 'function') {
    const groups = new Map(); // baseKey → [{idx, qty, name, rawTokens, attrVals}]
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const name = deriveName(cleanProductUrl(p.url));
      const k = opts.baseKey(name);
      if (!k) continue;
      const qty = opts.parseQty(name);
      const rawTokens = (typeof opts.extractDiscriminatorTokens === 'function')
        ? opts.extractDiscriminatorTokens(name)
        : new Set();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ idx: i, qty, name, rawTokens });
    }
    for (const [k, members] of groups) {
      if (members.length < 2) continue;

      // 1. Quantity dimensions that differ across members.
      const allQtyDims = new Set();
      members.forEach(m => Object.keys(m.qty).forEach(d => allQtyDims.add(d)));
      const quantityDiscriminators = [];
      for (const dim of allQtyDims) {
        const uniques = new Set();
        for (const m of members) {
          if (m.qty[dim] != null) uniques.add(Math.round(m.qty[dim] * 1000));
        }
        // Discriminator if values differ OR if some assert, some are silent.
        if (uniques.size > 1) quantityDiscriminators.push(dim);
        else if (uniques.size === 1 && members.some(m => m.qty[dim] == null)) {
          quantityDiscriminators.push(dim);
        }
      }

      // 2. Raw-token discriminators — tokens in some but not all members.
      const rawDiscriminators = new Set();
      const allRawTokens = new Set();
      members.forEach(m => m.rawTokens.forEach(t => allRawTokens.add(t)));
      for (const tok of allRawTokens) {
        let present = 0;
        for (const m of members) if (m.rawTokens.has(tok)) present++;
        if (present > 0 && present < members.length) rawDiscriminators.add(tok);
      }

      // 3. Skip the group if no discriminators of any kind exist (data
      //    quality issue — duplicate input SKUs). Log + leave gate off.
      if (quantityDiscriminators.length === 0 && rawDiscriminators.size === 0) {
        onProgress?.({
          currentAction: `Sibling group "${k}" — ${members.length} SKU(s) with NO discriminators (likely duplicate inputs); gate disabled`,
          logKind: 'err',
        });
        continue;
      }

      // 4. Attach per-member info. attrFamilyDiscriminators is populated
      //    LATER (after each product's attribute families are computed
      //    in the per-product init block) — see attrFamilyDiscriminators
      //    finalisation below.
      for (const m of members) {
        siblingInfoByIdx.set(m.idx, {
          baseKey: k,
          siblingCount: members.length,
          quantityDiscriminators,
          rawDiscriminators,
          ourQty: m.qty,
          ourRawTokens: m.rawTokens,
          // Placeholders — filled in once each product's attrFamilyValues
          // are computed by the per-product init block.
          attrFamilyDiscriminators: [],
          ourAttrFamilyValues: null,
        });
      }

      const previewRaw = Array.from(rawDiscriminators).slice(0, 6).join(', ');
      onProgress?.({
        currentAction: `Sibling group "${k}" — ${members.length} SKU(s); qty discriminator(s): [${quantityDiscriminators.join(', ') || '—'}]; raw discriminator(s): [${previewRaw}${rawDiscriminators.size > 6 ? ', ...' : ''}]`,
        logKind: 'ok',
      });
    }
  }
  // attrFamilyDiscriminators get finalised later (after the per-product
  // attribute-family init runs). We stash a closure-accessible reference
  // so the per-product init block can finish the pre-pass info.
  const finalizeAttrFamilyDiscriminatorsForBaseKey = new Map();
  for (const [idx, info] of siblingInfoByIdx) {
    const list = finalizeAttrFamilyDiscriminatorsForBaseKey.get(info.baseKey) || [];
    list.push({ idx, info });
    finalizeAttrFamilyDiscriminatorsForBaseKey.set(info.baseKey, list);
  }

  // Brand-mate pre-pass — broader than baseKey grouping. Groups products
  // by brand (explicit `p.brand` from the input file when present, else
  // first word of derived name). For each group of size >= 2, computes
  // the union of tokens present in OTHER members but NOT in this member —
  // these become the product's "brand-mate exclusion tokens" (tokens that,
  // if present in a SERP listing, indicate a different sibling).
  //
  // Catches the Aquaphor case: "Aquaphor Healing Ointment" (adult) gains
  // exclusion tokens [baby, cream, panthenol, zinc, ...] from its
  // brand-mates in the batch. Any listing whose text contains those tokens
  // is vetoed as a brand-mate's product, not ours.
  //
  // The explicit-brand key fixes multi-word / hyphenated brands the
  // first-word fallback couldn't group ("la roche-posay", "the ordinary").
  // False negatives are OK (no exclusions added), and false positives are
  // bounded (only exclude tokens present in another product in THIS batch).
  const brandMateExclusionByIdx = new Map();
  if (typeof opts.extractDiscriminatorTokens === 'function') {
    const brandGroups = new Map();
    const tokensByIdx = new Map();
    const namesByIdx = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const derived = deriveName(cleanProductUrl(p.url));
      // Include the handle (if provided) as additional name source so
      // tokens like "panthenol" / "zinc oxide" that are only in handles
      // get picked up.
      const fullName = `${derived} ${p.handles || ''}`.trim();
      const tokens = opts.extractDiscriminatorTokens(fullName);
      // Strip brand tokens from the discriminator set — if every product
      // in the group shares the brand word, including it adds nothing,
      // and if one product accidentally lacks it, the brand becomes an
      // exclusion token for that product (false veto on legit listings).
      const brandRaw = String(p.brand || '').toLowerCase().trim();
      if (brandRaw) {
        for (const bt of brandRaw.split(/[\s\-]+/).filter(Boolean)) tokens.delete(bt);
        tokens.delete(brandRaw.replace(/[\s-]+/g, ''));
      }
      tokensByIdx.set(i, tokens);
      namesByIdx.set(i, fullName);
      // Group key: normalized explicit brand if available, else first word
      // of the derived slug.
      const groupKey = brandRaw
        ? brandRaw.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : (derived.split(/\s+/)[0] || '').toLowerCase();
      if (!groupKey) continue;
      if (!brandGroups.has(groupKey)) brandGroups.set(groupKey, []);
      brandGroups.get(groupKey).push(i);
    }
    for (const [groupKey, indices] of brandGroups) {
      if (indices.length < 2) continue;
      // Frequency map across the group — tokens present in more than half
      // of the SKUs are brand-broad descriptors (e.g. "moisturizer" appears
      // in 5/8 La Roche-Posay items), not sibling discriminators. Excluding
      // them from the exclusion-set keeps false vetoes off legit listings
      // that use category vocabulary.
      const groupTokenFreq = new Map();
      for (const otherIdx of indices) {
        const ot = tokensByIdx.get(otherIdx) || new Set();
        for (const t of ot) groupTokenFreq.set(t, (groupTokenFreq.get(t) || 0) + 1);
      }
      // Strict majority — a token must appear in MORE THAN HALF the group
      // (not exactly half) to count as "brand-broad". This keeps tokens
      // like "baby" — which appears in 3 of 6 Aquaphor SKUs — as valid
      // sibling discriminators rather than treating them as generic
      // brand vocabulary. For 2-SKU groups, the cutoff becomes 2, which
      // effectively disables the broad filter (correct — with two SKUs
      // every cross-token is by definition a discriminator).
      const broadCutoff = Math.floor(indices.length / 2) + 1;
      for (const idx of indices) {
        const ourTokens = tokensByIdx.get(idx) || new Set();
        const exclusions = new Set();
        for (const otherIdx of indices) {
          if (otherIdx === idx) continue;
          const otherTokens = tokensByIdx.get(otherIdx) || new Set();
          for (const t of otherTokens) {
            if (ourTokens.has(t)) continue;
            // Broad-token guard: only skip a sibling token as "brand-broad"
            // when WE (the focal product) also share it. The previous logic
            // skipped any token meeting the broad cutoff regardless of our
            // membership — meaning a token in 5/6 siblings but NOT in our
            // SKU still got filtered as broad and never made it into our
            // veto list, letting sibling SERPs slip through. Since we
            // already skip tokens we share (line above), this added check
            // is redundant and should be removed: any sibling token we
            // don't share IS a discriminator, regardless of frequency.
            // (groupTokenFreq is kept for the diagnostic log line below.)
            exclusions.add(t);
          }
        }
        if (exclusions.size > 0) {
          brandMateExclusionByIdx.set(idx, {
            brandGroupKey: groupKey,
            groupSize: indices.length,
            tokens: exclusions,
          });
        }
      }
      onProgress?.({
        currentAction: `Brand-mate group "${groupKey}" — ${indices.length} SKU(s) (broad-token cutoff ≥${broadCutoff}/${indices.length})`,
        logKind: 'ok',
      });
    }
  }

  const productsTotal = sorted.length;
  let productsAlreadyDone = 0;
  for (const p of sorted) if (excludeUrls.has(cleanProductUrl(p.url))) productsAlreadyDone++;
  let productsDone = productsAlreadyDone;

  onProgress?.({
    productsDone, productsTotal,
    keywordCount: report.size,
    currentAction: `Resuming with ${productsAlreadyDone} of ${productsTotal} products already marked done`,
    logKind: productsAlreadyDone > 0 ? 'ok' : undefined,
  });

  // Honour any persisted chunk-rest deadline from a previous session.
  try {
    const { [STORAGE_KEY_REST_UNTIL]: restUntil } = await chrome.storage.local.get([STORAGE_KEY_REST_UNTIL]);
    if (typeof restUntil === 'number' && restUntil > Date.now()) {
      const remaining = restUntil - Date.now();
      onProgress?.({
        currentAction: `Resuming inside a chunk rest — ${Math.ceil(remaining / 60000)} min remaining`,
        logKind: 'ok',
        restUntil,
      });
      const ok = await sleepInterruptible(remaining, shouldStop, (rem) => {
        onProgress?.({ restUntil, currentAction: `Resting between chunks (${Math.ceil(rem/1000)} s remaining)` });
      });
      if (!ok) return { report: Array.from(report.values()), batchId, productsDone, productsTotal, stopped: true };
    }
    await chrome.storage.local.remove([STORAGE_KEY_REST_UNTIL]).catch(() => {});
  } catch {}

  // GLOBAL SW HEARTBEAT. The MV3 service worker idles out after ~30s without
  // chrome.* API activity. Slow fetches (autosuggest, SERP loads) don't
  // always count as activity, so a hung fetch + idle timer = engine vanishes
  // silently mid-row. We tick chrome.storage every 20s for the whole run
  // lifetime. Cleared in finally{} no matter how the run ends.
  const __heartbeatTimer = setInterval(() => {
    try { chrome.storage.local.get('__sw_heartbeat').catch(() => {}); } catch {}
  }, 20_000);

  let chunkProductCount = 0;
  // Counts back-to-back products that hit a CAPTCHA or SERP error. Resets to
  // zero on any successful SERP load. Used only to surface a warning, never
  // to stop the run.
  let consecutiveSerpBlocks = 0;

  try {
    for (let pi = 0; pi < sorted.length; pi++) {
      if (shouldStop() || report.size >= cap) break;

      const p = sorted[pi];
      const cleanUrl = cleanProductUrl(p.url);
      if (excludeUrls.has(cleanUrl)) continue;
      const productName = deriveName(cleanUrl);

      onProgress?.({
        currentProduct: productName,
        currentSource: 'product setup',
        currentAction: 'Fetching product data (Shopify JSON — no Google load)',
        keywordCount: report.size,
        productIndex: pi + 1,
        productTotal: sorted.length,
        productsDone, productsTotal,
      });

      const productImages = await getProductImages(cleanUrl, (m) => {
        onProgress?.({ currentProduct: productName, currentAction: m });
      });

      if (productImages.length === 0) {
        // Explicit abort: every fallback (Shopify .json → JSON-LD → og:image
        // → twitter:image → <img> scan) returned nothing. Without a product
        // image, CLIP can't match anything, the product palette is empty,
        // and the SERP image-counting layer is meaningless. Skip this
        // product cleanly rather than running the full discovery pipeline
        // for no-signal-output. The for-product loop catches and
        // continues to the next product.
        onProgress?.({
          currentProduct: productName,
          currentAction: `Aborting product: no product image after Shopify .json + JSON-LD + og:image + twitter:image + <img> fallbacks at ${cleanUrl}`,
          logKind: 'err',
        });
        productsDone++;
        // Distributed mode: mark this job as FAILED rather than DONE.
        // Marking aborts as "done" silently buried real failures so the
        // dashboard's failed-jobs panel was always empty even when the
        // engine couldn't process products. onProductFailed gets a
        // reason string so the manager can see why each one died.
        if (typeof opts.onProductFailed === 'function') {
          await opts.onProductFailed(cleanUrl, 'no_product_image');
        } else {
          await onProductDone(cleanUrl);
        }
        continue;
      }

      // Build CLIP reference embeddings for the product. One embedding per
      // image (CLIP is robust enough that augmentation isn't required). The
      // first call to getReferenceEmbeddings() implicitly triggers CLIP model
      // load — ~150 MB download from HuggingFace on first run (cached to
      // IndexedDB thereafter, so subsequent runs are instant).
      onProgress?.({
        currentProduct: productName,
        currentAction: `Initializing CLIP model + embedding ${productImages.length} product image(s). First run downloads ~150 MB from HuggingFace; subsequent runs use IndexedDB cache.`,
      });
      const referenceEmbeddings = productImages.length > 0
        ? await getReferenceEmbeddings(productImages)
        : [];

      if (productImages.length > 0 && referenceEmbeddings.length === 0) {
        onProgress?.({
          currentProduct: productName,
          currentAction: `Could not embed any product image (CLIP init failed?). image_count will be 0 for all keywords.`,
          logKind: 'err',
        });
      } else if (referenceEmbeddings.length > 0) {
        onProgress?.({
          currentProduct: productName,
          currentAction: `Product embedded with CLIP (${referenceEmbeddings.length} image(s), 512-dim each; threshold=${pickClipThreshold(matchProfileName, opts.clipThresholdOverride).toFixed(2)} for ${matchProfileName}${typeof opts.clipThresholdOverride === 'number' ? ' (custom)' : ''})`,
          logKind: 'ok',
        });
      }
      // Local alias for downstream code.
      const productFps = referenceEmbeddings;     // back-compat name
      const clipThreshold = pickClipThreshold(matchProfileName, opts.clipThresholdOverride);

      const productImage = productImages[0] || '';
      const relevanceSet = buildRelevanceSet(productName, p.sku);

      // ----- KP scrape (separate from Google SERP) -----
      const kpSeed = simplifyForKP(productName);
      if (kpSeed !== productName) {
        onProgress?.({ currentProduct: productName, currentSource: 'kp', currentAction: `KP seed simplified: "${productName}" -> "${kpSeed}"`, logKind: 'ok' });
      }

      // Build the per-product relevance context once. Drives the
      // isRelevantToProduct gate that rejects farming / cooking / competitor /
      // wrong-category keywords before they enter the SERP queue.
      //
      // IMPORTANT: detectCategory runs on the RAW productName (still has
      // "650mg", "250 tablets", etc.) — that's where the category signal
      // lives. simplifyForKP strips those tokens before we use the name as
      // a KP seed, but by then the category clue is gone.
      const detectedCategory = (typeof opts.detectCategory === 'function')
        ? opts.detectCategory(productName, productName)
        : null;
      const productContext = (typeof opts.buildProductContext === 'function')
        ? opts.buildProductContext(kpSeed || productName, p.handles, detectedCategory, p.brand)
        : null;
      if (productContext) {
        // The RAW product name carries the most signal for text-match scoring
        // against SERP thumbnails ("NOW Foods Alfalfa 650mg Green Food
        // Tablets" matches Amazon's alt text "NOW Supplements, Alfalfa
        // 650 mg, Green Superfood, 250 Tablets" on 6+ words). Use it as
        // fullProductName for the multi-signal scorer.
        productContext.fullProductName = productName;
        // Reference dominant colors (Signal 2). getReferenceEmbeddings now
        // returns Float32Arrays with `.colors` attached as a non-enumerable
        // property. We aggregate the FIRST reference's colors (the primary
        // product image) as the brand palette; using the union across all
        // refs would dilute the signal when augmented references include
        // colour-shifted variants.
        const _firstRef = referenceEmbeddings[0];
        const _firstColors = (_firstRef && Array.isArray(_firstRef.colors)) ? _firstRef.colors : [];
        productContext.refColors = _firstColors;
        if (_firstColors.length > 0) {
          const hex = _firstColors
            .map(c => `#${[c.r,c.g,c.b].map(v => v.toString(16).padStart(2,'0')).join('')}`)
            .join(', ');
          onProgress?.({
            currentProduct: productName,
            currentSource: 'context',
            currentAction: `Product palette: ${hex}`,
            logKind: 'ok',
          });
        }
        // Form factor is the strongest universal product-identity cue. If
        // the auto-derived one is missing or wrong, the harness's
        // extractFormFactor on the RAW name gives a second chance — the
        // cleaned kpSeed loses tokens like "Tablets" / "Cream" during
        // simplifyForKP. Pick whichever resolves to a non-null value.
        if (!productContext.formFactor && typeof opts.extractFormFactor === 'function') {
          const ff = opts.extractFormFactor(productName, productContext.category);
          if (ff) productContext.formFactor = ff;
        }
        onProgress?.({
          currentProduct: productName,
          currentSource: 'context',
          currentAction: `Product context: brand="${productContext.brandName}", type="${productContext.productType}", form="${productContext.formFactor || '—'}", category="${productContext.category}"`,
          logKind: 'ok',
        });
        // Numeric specs (count / dosage / volume / weight / pack). Extracted
        // from the RAW productName because simplifyForKP strips the size
        // tokens by the time we hit buildProductContext. Used downstream to
        // penalise SERP thumbnails of the same brand+anchor in a different
        // size/dosage variant.
        if (typeof opts.extractProductSpecs === 'function') {
          productContext.specs = opts.extractProductSpecs(productName);
          const s = productContext.specs;
          const parts = [];
          if (s.count)    parts.push(`count=${s.count} ${s.countUnit || ''}`.trim());
          if (s.dosage)   parts.push(`dosage=${s.dosage}${s.dosageUnit || ''}`);
          if (s.volume)   parts.push(`volume=${s.volume}${s.volumeUnit || ''}`);
          if (s.weight)   parts.push(`weight=${s.weight}${s.weightUnit || ''}`);
          if (s.packSize) parts.push(`pack=${s.packSize}`);
          if (parts.length > 0) {
            onProgress?.({
              currentProduct: productName,
              currentSource: 'context',
              currentAction: `Product specs: ${parts.join(', ')}`,
              logKind: 'ok',
            });
          }
          // Bound conflict check — lets module-level functions (which can't
          // see `opts`) detect variant conflicts via productContext alone.
          if (typeof opts.hasConflictingSpec === 'function') {
            productContext.checkVariantConflict = (text) =>
              opts.hasConflictingSpec(text, productContext.specs);
          }
        }
        // Bound product-identity check (Layer 2 of the match chain — brand,
        // identity, variant). Returns { match, missingWords }.
        if (typeof opts.hasSpecConfirmation === 'function') {
          productContext.hasSpecConfirmation = (text) =>
            opts.hasSpecConfirmation(text, productContext.specs);
        }
        if (typeof opts.checkProductIdentity === 'function') {
          productContext.checkProductIdentity = (text) =>
            opts.checkProductIdentity(text, productContext);
          if (Array.isArray(productContext.coreTypeWords) && productContext.coreTypeWords.length > 0) {
            onProgress?.({
              currentProduct: productName,
              currentSource: 'context',
              currentAction: `Product identity words: [${productContext.coreTypeWords.join(', ')}] (all must appear in context for identity match)`,
              logKind: 'ok',
            });
          }
        }
        // Bound product-line modifier check. Returns { match, modifier } when
        // text contains an ultra/super/extra/etc. modifier our product
        // doesn't carry. Used by image matching to demote sibling-product
        // SERP thumbs (Ultra Omega 3 alongside our Omega 3, etc.).
        if (typeof opts.checkProductLineModifier === 'function') {
          productContext.checkProductLineModifier = (text) =>
            opts.checkProductLineModifier(text, productContext);
        }
        // Brand-family sibling exclusions — build once per product based on
        // productType + form + brand. Returns terms like "tablet"/"capsule"
        // (when our form is softgel), "3-6-9"/"dha-1000"/"mini gel" (when
        // we're an Omega 3 Fish Oil product), "AM"/"PM" (when we're CeraVe).
        // Same-brand visually-identical-bottle products are CLIP's blind
        // spot; this list is the text-based defense.
        if (typeof opts.buildSiblingExclusions === 'function') {
          productContext.siblingExclusions = opts.buildSiblingExclusions(productContext);
          if (productContext.siblingExclusions.length > 0) {
            const preview = productContext.siblingExclusions
              .slice(0, 12)
              .map(e => `"${e.term}"(${e.type.replace('brand_family_sibling', 'fam').replace('wrong_form', 'form')})`)
              .join(', ');
            onProgress?.({
              currentProduct: productName,
              currentSource: 'context',
              currentAction: `Sibling exclusions (${productContext.siblingExclusions.length} terms): ${preview}${productContext.siblingExclusions.length > 12 ? ', ...' : ''}`,
              logKind: 'ok',
            });
          }
        }
        if (typeof opts.checkSiblingProduct === 'function') {
          productContext.checkSiblingProduct = (text) =>
            opts.checkSiblingProduct(text, productContext);
        }
        // Variant-slot pair check (day/night, men/women, AM/PM, scented/
        // unscented, wired/wireless, etc.). Universal across categories —
        // catches sibling-SKU lookalikes the form/modifier/sibling layers
        // don't pick up.
        if (typeof opts.checkVariantSlot === 'function') {
          productContext.checkVariantSlot = (text) =>
            opts.checkVariantSlot(text, productContext);
        }
        // Color conflict check — for color-variant products (cosmetics,
        // apparel, electronics, footwear, hair color, nail polish). Only
        // fires when our product name contains a color name.
        if (typeof opts.checkColorConflict === 'function') {
          productContext.checkColorConflict = (text) =>
            opts.checkColorConflict(text, productContext);
        }
        // Shade / model name-swap check — cosmetics-scoped only. Detects
        // keywords that swap a shade name on the same product line
        // (Maybelline 80 Ruler → 20 Pioneer). Strictly gated by
        // _isShadeVariantProduct so supplement / generic keywords aren't
        // touched. See keyword-filter.js _NAMESWAP_PROTECTED for the
        // commerce/intent allowlist.
        if (typeof opts.checkNameSwap === 'function') {
          productContext.checkNameSwap = (text) =>
            opts.checkNameSwap(text, productContext);
        }
        // Attribute-family veto (Layer 9, category-keyed config). See
        // modules/attribute-families.js for the value-set declarations.
        // Resolves the family map from product.category + brand, computes
        // OUR positive assertions once, and binds a per-thumb checker.
        // The check fires only when the PRODUCT positively declares a
        // value of a family; silent product → no veto on that axis.
        if (typeof opts.familiesFor === 'function' && typeof opts.computeProductFamilyValues === 'function') {
          productContext.attrFamilies = opts.familiesFor(productContext);
          productContext.attrFamilyValues = opts.computeProductFamilyValues(productContext);
          // Family values are Sets (Fix 1 — multi-value support). Filter
          // for non-empty Sets and serialise each Set's contents joined
          // by "|" so the log shows e.g. "process=molecularly distilled
          // |enteric coated" instead of "[object Set]".
          const declared = Object.entries(productContext.attrFamilyValues)
            .filter(([, v]) => v && typeof v.size === 'number' && v.size > 0)
            .map(([k, v]) => `${k}=${Array.from(v).join('|')}`);
          if (declared.length > 0) {
            onProgress?.({
              currentProduct: productName,
              currentSource: 'context',
              currentAction: `Attribute families (${productContext.category}): ${declared.join(', ')}`,
              logKind: 'ok',
            });
          }
          if (typeof opts.checkAttributeFamily === 'function') {
            productContext.checkAttributeFamily = (text) =>
              opts.checkAttributeFamily(text, productContext);
          }
        }
        // Brand-mate exclusions — cross-product check that doesn't require
        // shared baseKey. The pre-pass built per-product exclusion sets
        // (tokens present in other batch siblings' names but not in ours);
        // attaching them here lets checkBrandMate fire from the match
        // layer. For the Aquaphor example, product 4 ("Healing Ointment"
        // adult) gains exclusions [baby, panthenol, zinc, multi-purpose, ...]
        // from its baby-line siblings.
        const brandMateInfo = brandMateExclusionByIdx.get(pi);
        if (brandMateInfo && brandMateInfo.tokens.size > 0) {
          productContext.brandMateExclusionTokens = brandMateInfo.tokens;
          productContext.brandMateGroupKey = brandMateInfo.brandGroupKey;
          if (typeof opts.checkBrandMate === 'function') {
            productContext.checkBrandMate = (text) =>
              opts.checkBrandMate(text, productContext);
          }
          const preview = Array.from(brandMateInfo.tokens).slice(0, 10).join(', ');
          onProgress?.({
            currentProduct: productName,
            currentSource: 'context',
            currentAction: `Brand-mate exclusions (group "${brandMateInfo.brandGroupKey}", ${brandMateInfo.groupSize - 1} other SKU(s)): [${preview}${brandMateInfo.tokens.size > 10 ? ', ...' : ''}]`,
            logKind: 'ok',
          });
        }
        // Sibling SKU ambiguity — unified gate covering quantity dims,
        // attribute-family values, and auto-derived raw-token
        // discriminators. The pre-pass populated quantity + raw pieces of
        // siblingInfoByIdx; here we attach the per-product attribute
        // family Sets and bind the productContext checker. Once all
        // siblings have been processed, the attrFamilyDiscriminators list
        // is finalised across the group.
        const siblingInfo = siblingInfoByIdx.get(pi);
        if (siblingInfo) {
          siblingInfo.ourAttrFamilyValues = productContext.attrFamilyValues || {};
          productContext.siblingGroupInfo = siblingInfo;
          productContext.siblingBaseKey = siblingInfo.baseKey;
          if (typeof opts.checkSiblingAmbiguity === 'function') {
            productContext.checkSiblingAmbiguity = (text) =>
              opts.checkSiblingAmbiguity(text, productContext);
          }
          // Finalise attrFamilyDiscriminators for this group: a family
          // is a discriminator if at least one sibling's value-set
          // differs from another's (including silent-vs-asserted). This
          // runs once the last sibling of the group is initialised.
          const groupMembers = finalizeAttrFamilyDiscriminatorsForBaseKey.get(siblingInfo.baseKey) || [];
          const allInitialised = groupMembers.every(({ info }) => info.ourAttrFamilyValues != null);
          if (allInitialised && productContext.attrFamilies) {
            const familyDiscs = [];
            for (const [familyName, values] of Object.entries(productContext.attrFamilies)) {
              const distinctSets = new Set();
              for (const { info } of groupMembers) {
                const s = info.ourAttrFamilyValues[familyName];
                const key = s ? Array.from(s).sort().join('|') : '';
                distinctSets.add(key);
              }
              if (distinctSets.size > 1) {
                familyDiscs.push({ family: familyName, values });
              }
            }
            for (const { info } of groupMembers) {
              info.attrFamilyDiscriminators = familyDiscs;
            }
            if (familyDiscs.length > 0) {
              const preview = familyDiscs.map(d => d.family).join(', ');
              onProgress?.({
                currentProduct: productName,
                currentSource: 'context',
                currentAction: `Sibling group "${siblingInfo.baseKey}" attribute discriminator(s): ${preview}`,
                logKind: 'ok',
              });
            }
          }
          const ourQtyStr = siblingInfo.quantityDiscriminators
            .map(d => `${d}=${siblingInfo.ourQty[d] ?? '—'}`)
            .join(', ') || '—';
          const ourRawStr = Array.from(siblingInfo.ourRawTokens).filter(t => siblingInfo.rawDiscriminators.has(t)).join(',') || '—';
          onProgress?.({
            currentProduct: productName,
            currentSource: 'context',
            currentAction: `Sibling SKU group "${siblingInfo.baseKey}" — ${siblingInfo.siblingCount} variant(s); our qty: [${ourQtyStr}]; our discriminator tokens: [${ourRawStr}]`,
            logKind: 'ok',
          });
        }
      }
      // Combined gate: India/English/noise filter AND product-relevance.
      // shouldKeepKeyword is product-agnostic; isRelevantToProduct is the
      // product-aware second pass.
      const passesRelevance = (kw) => {
        if (typeof opts.shouldKeepKeyword === 'function' && !opts.shouldKeepKeyword(kw, productName)) return false;
        if (typeof opts.isRelevantToProduct === 'function' && productContext && !opts.isRelevantToProduct(kw, productContext)) return false;
        return true;
      };
      // Build the candidate seed list: simplified product name + any optional
      // CSV "handles". selectKpSeeds picks the SHORTER one when two candidates
      // overlap heavily — verbose product titles ("...Face Body 8 Fluid
      // Ounce") return narrow KP idea sets, so a shorter handle like
      // "cerave moisturizing cream" should replace them, not be skipped.
      // Raised 3→5: broader KP seed net so per-SKU output reliably hits
      // the 100-300 keyword target. The seed candidate list is deduped/
      // overlap-filtered by selectKpSeeds so bumping this is safe.
      const MAX_KP_SEEDS = 5;
      // Seed candidate order:
      //   [0] = simplified kpSeed (cleaned + capped to 10 words)
      //   [1+] = file-provided handles, each ALSO passed through
      //          simplifyForKP so any size/dosage/percentage tokens
      //          ("99g", "15 Percent", "180 EPA") get stripped before
      //          they reach KP. Without this, the file handle
      //          "Aquaphor Baby Healing Cream 3 In 1 Diaper Rash Cream
      //          With 15 Percent Zinc Oxide And Panthenol 99g" is 16
      //          words and reliably times out KP's Get results button.
      //          After cleaning + cap it collapses to a usable seed
      //          that preserves the identity vocabulary and yields
      //          many more keywords for a famous brand.
      const candidates = [kpSeed];
      if (typeof opts.handlesToSeeds === 'function' && p.handles) {
        const extra = opts.handlesToSeeds(cleanUrl, p.handles) || [];
        for (const s of extra) {
          const cleaned = simplifyForKP(String(s).trim());
          if (cleaned) candidates.push(cleaned);
        }
      }
      let kpSeeds, skippedSeeds = [];
      if (typeof opts.selectKpSeeds === 'function') {
        const r = opts.selectKpSeeds(candidates, MAX_KP_SEEDS);
        kpSeeds = r.seeds || [];
        skippedSeeds = r.skipped || [];
      } else {
        kpSeeds = candidates.slice(0, MAX_KP_SEEDS);
      }
      if (candidates.length > 1) {
        onProgress?.({ currentProduct: productName, currentSource: 'kp', currentAction: `KP seeds (with handles): ${kpSeeds.join(' | ')}`, logKind: 'ok' });
      }
      if (skippedSeeds.length > 0) {
        onProgress?.({ currentProduct: productName, currentSource: 'kp', currentAction: `Skipped ${skippedSeeds.length} duplicate seed(s) — already covered by another seed in the list: ${skippedSeeds.join(' | ')}`, logKind: 'ok' });
      }
      onProgress?.({ currentProduct: productName, currentSource: 'kp', currentAction: `Running Keyword Planner for ${kpSeeds.length} seed(s): "${kpSeeds.join('", "')}"`, keywordCount: report.size });
      const kpResult = await getKeywordPlannerIdeas(kpSeeds, kpUrl, kpMaxPerProduct,
        (m) => onProgress?.({ currentProduct: productName, currentAction: m }),
        { productUrl: cleanUrl });
      const kpKeywords = (kpResult?.ok ? (kpResult.keywords || []) : []).filter(Boolean);
      if (!kpResult?.ok) {
        onProgress?.({
          currentProduct: productName,
          currentSource: 'kp',
          currentAction: `⚠ KP FAILED: ${kpResult.error}. Engine will continue with PAA + autosuggest only (likely < 30 keywords, 2-3 min total). Common fix: re-login to Google Ads in this profile + check the KP URL in Settings.`,
          logKind: 'err',
        });
      } else if (kpKeywords.length === 0) {
        // KP succeeded (HTTP 200) but returned zero ideas. This happens
        // when the seed is too long/specific, when Google has no data
        // for it, or when the KP UI changed and the scraper missed
        // results. Engine continues, but the user needs to know this
        // product will be keyword-poor.
        onProgress?.({
          currentProduct: productName,
          currentSource: 'kp',
          currentAction: `⚠ KP returned 0 ideas for "${kpSeeds.join(', ')}". Engine will fall back to PAA + autosuggest only. If this happens on every product, check: (1) KP URL is current, (2) Google Ads session is active, (3) seed is short enough.`,
          logKind: 'warn',
        });
      } else {
        onProgress?.({ currentProduct: productName, currentSource: 'kp', currentAction: `KP returned ${kpKeywords.length} ideas`, logKind: 'ok' });
      }

      // Honor a stop request that arrived while KP was working. Without this
      // the engine prints "Pre-SERP pause" + waits 12s before bailing out,
      // which looks like the stop button is ignored.
      if (shouldStop()) {
        onProgress?.({ currentProduct: productName, currentSource: 'pace', currentAction: 'Stop honored after KP — skipping SERP load.', logKind: 'ok' });
        break;
      }

      // ----- Search delay BEFORE the one SERP load -----
      const sdMs = randInt(searchDelayMin, searchDelayMax);
      onProgress?.({
        currentProduct: productName,
        currentSource: 'pace',
        currentAction: `Pre-SERP pause: ${Math.round(sdMs/1000)} s (human-paced; randomised ${Math.round(searchDelayMin/1000)}-${Math.round(searchDelayMax/1000)} s)`,
        logKind: 'ok',
      });
      const sdOk = await sleepInterruptible(sdMs, shouldStop);
      if (!sdOk) break;

      // ----- THE ONE SERP LOAD -----
      // Use the CLEANED seed (kpSeed) for the product-discovery SERP, not the
      // verbose raw title. The cleaned form (e.g. "Cerave Moisturizing Cream"
      // instead of "...Face Body 8 Fluid Ounce") returns far more SERP hits
      // and far more relevant PAA / related searches.
      const productSerpQuery = kpSeeds[0] || kpSeed || productName;
      // Per-product matched-thumbnail cache. Carries URLs that were verified
      // as matches on EARLIER SERPs in this product's run (the product SERP
      // first, then brand keywords) so they can be trusted on generic
      // keyword SERPs without re-running the brand-context check. Critical
      // for generic queries like "alfalfa 650 mg super green" where the
      // alt text doesn't carry our brand but the image really is ours.
      const productMatchedUrls = new Set();
      const productMatchedConfidences = new Map(); // url -> confidence (0-100)
      onProgress?.({
        currentProduct: productName,
        currentSource: 'serp',
        currentAction: `Loading SERP for "${productSerpQuery}" (the one and only SERP load for this product)`,
      });
      const serpData = await loadProductSerp(productSerpQuery, productFps, productImages, clipThreshold,
        (m) => onProgress?.({ currentProduct: productName, currentSource: 'serp', currentAction: `SERP: ${m}` }),
        productContext);
      // Seed the cache from the product SERP — every match here is a
      // ground-truth verified instance of our product. The cache is then
      // queryable by per-keyword SERPs' rescue path.
      if (serpData?.ok && Array.isArray(serpData.matchedThumbnails)) {
        const confs = serpData.matchedConfidences || [];
        for (let mi = 0; mi < serpData.matchedThumbnails.length; mi++) {
          const u = serpData.matchedThumbnails[mi];
          if (!u) continue;
          productMatchedUrls.add(u);
          productMatchedConfidences.set(u, confs[mi] || 100);
        }
      }

      // No hard-stop on CAPTCHA or any other SERP failure. The MAIN value of
      // the run is keyword discovery (KP + autosuggest); image counting is
      // supplementary. When Google blocks us (verification check, redirect to
      // a non-search URL, content script never injects, network error, etc.),
      // we log it, count this product as "image-skipped", and continue with
      // keyword discovery using the KP keywords we already have. PAA is empty
      // because we couldn't read the page, but autosuggest expansion still
      // produces a full keyword list for the product.
      let productImageCount = 0;
      let matchedThumbnails = [];
      let matchedConfidences = [];
      let matchedEmbeddings = [];
      let matchedSellers = [];
      let matchedPrices = [];
      let paaQuestions = [];
      let serpOk = false;

      if (serpData.captcha) {
        consecutiveSerpBlocks++;
        onProgress?.({
          currentProduct: productName,
          currentSource: 'serp',
          currentAction: `Google verification page — image match unavailable for this product. Continuing keyword discovery.`,
        });
        if (consecutiveSerpBlocks === 5) {
          onProgress?.({
            currentProduct: productName,
            currentAction: `Note: ${consecutiveSerpBlocks} consecutive Google verification pages. Image counts will be 0 for these products. Keyword discovery (KP + autosuggest) is unaffected.`,
          });
        }
      } else if (!serpData.ok) {
        consecutiveSerpBlocks++;
        onProgress?.({
          currentProduct: productName,
          currentSource: 'serp',
          currentAction: `SERP unavailable (${serpData.error}) — image match unavailable for this product. Continuing keyword discovery.`,
        });
      } else {
        consecutiveSerpBlocks = 0;
        serpOk = true;
        productImageCount    = serpData.count;
        matchedThumbnails    = serpData.matchedThumbnails;
        matchedConfidences   = serpData.matchedConfidences;
        matchedEmbeddings    = serpData.matchedEmbeddings || [];
        matchedSellers       = serpData.matchedSellers || [];
        matchedPrices        = serpData.matchedPrices  || [];
        paaQuestions         = serpData.paa;
        const _pScores = (serpData.topScores && serpData.topScores.length)
          ? ` scores=[${serpData.topScores.join(',')}] t=${serpData.thresholdPct} near=${serpData.nearMissCount || 0}`
          : '';
        const _pSrc = serpData.sourceBreakdown && Object.keys(serpData.sourceBreakdown).length
          ? ` [${Object.entries(serpData.sourceBreakdown).map(([k,v]) => `${k}:${v}`).join(', ')}]`
          : '';
        onProgress?.({
          currentProduct: productName,
          currentSource: 'serp',
          currentAction: `SERP: ${serpData.thumbCount} thumbnails${_pSrc}, ${productImageCount} matched (${serpData.urlMatchCount || 0} via URL + ${productImageCount - (serpData.urlMatchCount || 0)} via CLIP; ${serpData.scored || 0} CLIP-scored);${_pScores} ${paaQuestions.length} PAA questions`,
          logKind: 'ok',
        });
      }

      // ----- Build keyword list (autosuggest-only expansion below) -----
      // Seeds: KP keywords + PAA questions. Each becomes a row, then we
      // expand each via /complete/search (free) until we hit the cap.
      const productRows = [];
      const productKeywordSet = new Set();
      // Word-order dedup: "now foods super enzymes" and "super enzymes now
      // foods" return effectively the same SERP. Tokenize → sort → join to
      // build a canonical key per token-set; subsequent reorderings of the
      // same tokens are dropped from the SERP cycle (one SERP load per
      // unique token-set is enough). The duplicate's "I saw this keyword
      // again" signal isn't wasted — we bump the canonical row's frequency
      // counter so it scores higher in computeAdRating. Map value is the
      // canonical row's normalised key (used by report.get).
      const productKeywordSortedMap = new Map();
      const _sortedKey = (kw) => String(kw || '').toLowerCase().trim()
        .split(/\s+/).filter(Boolean).sort().join(' ');
      // Per-product cap as an ABSOLUTE bound on report.size for this
      // product's iteration. Previously `productCap = cap` aliased the
      // global ceiling, so the FIRST product to push the report over the
      // 500-row global stopped every subsequent product cold and the
      // watchdog spun in an infinite resume loop. Now: snapshot the
      // report size at the top of this product, add kpMaxPerProduct, and
      // also clip to the global runaway ceiling so a misconfigured
      // kpMaxPerProduct can't blow up memory.
      const productStartReportSize = report.size;
      const productCap = Math.min(cap, productStartReportSize + kpMaxPerProduct);
      // Per-product cache state already initialized above the product SERP
      // (productMatchedUrls / productMatchedConfidences) so the product SERP
      // can populate it before the per-keyword loop runs.
      // Related-search seeds discovered while processing SERPs flow into here.
      // Drained at the end of Round 1 to push additional keyword rows.
      const relatedSearchQueue = [];
      // CAPTCHA retry queue — keywords whose per-keyword SERP hit a
      // verification page get pushed here and retried at the end of the
      // product cycle (after the related-search drain, before Amazon).
      // Capped at MAX_CAPTCHA_RETRIES attempts per keyword to avoid
      // endless loops on persistently-blocked queries.
      const captchaRetryQueue = []; // [{ row, attempts }]
      const MAX_CAPTCHA_RETRIES = 2;

      // Seed the queue from the product-discovery SERP's own related-search
      // section — but only if our product actually appeared on that SERP.
      // With 0 matches, Google didn't surface our product for the product's
      // own seed query, so related searches will drift to competitor land.
      if (serpOk && productImageCount > 0 && Array.isArray(serpData.relatedSearches)) {
        let queuedFromProductSerp = 0;
        for (const rs of serpData.relatedSearches) {
          if (typeof opts.shouldKeepKeyword === 'function' &&
              !opts.shouldKeepKeyword(rs, productName)) continue;
          if (typeof opts.isRelevantToProduct === 'function' && productContext &&
              !opts.isRelevantToProduct(rs, productContext)) continue;
          relatedSearchQueue.push(rs);
          queuedFromProductSerp++;
        }
        if (queuedFromProductSerp > 0) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'serp',
            currentAction: `Queued ${queuedFromProductSerp} related-search seed(s) from product SERP (image-visible)`,
            logKind: 'ok',
          });
        }
      } else if (serpOk && Array.isArray(serpData.relatedSearches) && serpData.relatedSearches.length > 0) {
        onProgress?.({
          currentProduct: productName,
          currentSource: 'serp',
          currentAction: `Product SERP had ${serpData.relatedSearches.length} related searches but 0 image matches — not queued (image-guided expansion)`,
        });
      }

      // KP keyword normaliser — kp.js now returns objects { kw, monthlySearches, ... }
      // but older cached values and PAA / autosuggest sources pass strings.
      const toKpItem = (item) => {
        if (item == null) return null;
        if (typeof item === 'string') return { kw: item };
        if (typeof item === 'object' && typeof item.kw === 'string') return item;
        return null;
      };

      // Bump frequency + union the source field on an existing row. Used by
      // both the exact-dup and word-order-dup branches below. Re-discovering
      // a keyword from a different source is meaningful signal — the
      // frequencyBonus in computeAdRating tops out at +20 ((freq-1)*5), and
      // the source column should show every route the keyword surfaced via
      // ("kp_idea, autosuggest, related_search"). Without this merge, the
      // existing keyword-filter.js mergeKeywordIntoReport function never
      // got called from the engine — exports showed frequency=1 and
      // source="kp_idea" alone even when the same keyword had been
      // re-surfaced by PAA, autosuggest, and related-search.
      const _mergeIntoExisting = (existing, newSource) => {
        if (!existing) return;
        existing.frequency = (existing.frequency || 1) + 1;
        if (newSource && newSource !== existing.source) {
          const tokens = new Set(
            String(existing.source || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)
          );
          tokens.add(String(newSource).trim());
          existing.source = Array.from(tokens).join(', ');
        }
        if (typeof opts.computeAdRating === 'function') {
          try { existing.adRating = opts.computeAdRating(existing); } catch {}
        }
      };

      // Composite report key = `${cleanUrl}|${normalizedKeyword}`. Previously
      // `report` was keyed by keyword alone, which meant that if "aquaphor
      // diaper rash cream" was discovered for Product A AND for Product B,
      // the second product would silently merge into Product A's row —
      // inheriting Product A's image_count (which was matched against
      // Product A's image, not B's). Result: per-product image counts mixed
      // across products. Composite keys give every (product, keyword) pair
      // its own row, its own SERP, and its own image-match calculation.
      const keyFor = (k) => `${cleanUrl}|${k}`;

      const addRow = (keyword, source, parentKeyword, kpMeta) => {
        const key = (keyword || '').toLowerCase().trim();
        if (!key) return null;
        const compositeKey = keyFor(key);
        // Exact duplicate of a keyword we've already added for this product.
        // Don't re-SERP it, but DO merge: bump frequency + union source.
        if (productKeywordSet.has(key)) {
          _mergeIntoExisting(report.get(compositeKey), source);
          return null;
        }
        const sortedKey = _sortedKey(keyword);
        if (sortedKey && productKeywordSortedMap.has(sortedKey)) {
          // Same tokens, different order — merge into the canonical row.
          const canonicalKey = productKeywordSortedMap.get(sortedKey);
          _mergeIntoExisting(report.get(keyFor(canonicalKey)), source);
          return null;
        }
        // No cross-product duplicate check — each (product, keyword) pair is
        // independent. Previously this branch existed and silently dropped
        // Product B's discovery of a keyword Product A had already added,
        // attributing A's image_count to a row that was meant to describe B.
        if (report.size >= productCap) return null;
        if (isJunkKeyword(keyword)) return null;
        // External quality filter (geo/platform/UI-literal/etc.) if provided
        // by the harness via opts.shouldKeepKeyword.
        if (typeof opts.shouldKeepKeyword === 'function' && !opts.shouldKeepKeyword(keyword, productName)) {
          return null;
        }
        // Product-relevance gate. Skipped for kp_idea and kp_reexpand rows —
        // KP already returns product-related ideas; running the relevance
        // gate there would over-prune KP's broad set. Applied to PAA,
        // autosuggest, related_search and any other source where Google's
        // suggestions can drift off-product.
        if (
          source !== 'kp_idea' && source !== 'kp_reexpand' &&
          typeof opts.isRelevantToProduct === 'function' && productContext &&
          !opts.isRelevantToProduct(keyword, productContext)
        ) {
          return null;
        }
        // Low-signal KP entries (no volume AND no competition) used to be
        // dropped here. They're now kept — KP knows about the keyword even
        // if it has no measurement, and they're useful for completeness.
        // The SERP-cycle queue (round1Seeds) prioritises high-signal rows,
        // so low-signal entries land in the report but don't trigger a SERP
        // load on their own.
        const lowSignalKp = (source === 'kp_idea' || source === 'kp_reexpand') && isLowSignalKpMeta(kpMeta);
        productKeywordSet.add(key);
        if (sortedKey) productKeywordSortedMap.set(sortedKey, key);

        // Categorize intent/topic/funnel at row creation. The harness passes
        // opts.categorizeKeyword from modules/keyword-filter.js.
        let intent = '', topic = '', funnel = 'top';
        if (typeof opts.categorizeKeyword === 'function') {
          const cat = opts.categorizeKeyword(keyword);
          intent = cat.intent;
          topic  = cat.topic;
          funnel = cat.funnel;
        }

        const row = {
          batchId,
          keyword,
          source,
          parentKeyword: parentKeyword || '',
          sku: p.sku || '',
          productName,
          productUrl: cleanUrl,
          productImage,
          productImages,
          referenceCount: productImages.length,
          priority: p.priority,
          // Per-keyword image data — filled later by per-keyword SERP cycle.
          imageCount: 0,
          matchedThumbnails: [],
          matchedConfidences: [],
          matchedSellers: [],
          matchedPrices: [],
          _matchedEmbeddings: [],
          // Per-keyword SERP context (sellers + ad slots from THIS keyword's SERP)
          sellers: [],
          totalSellers: 0,
          adsOnSerp: 0,
          autosuggestCount: 0,
          autosuggestions: [],
          // KP-derived per-keyword metrics (empty for autosuggest / PAA rows).
          kpMonthlySearches: (kpMeta && kpMeta.monthlySearches) || '',
          kpCompetition:     (kpMeta && kpMeta.competition)     || '',
          kpBidLow:          (kpMeta && kpMeta.bidLow)          || '',
          kpBidHigh:         (kpMeta && kpMeta.bidHigh)         || '',
          // Categorization + scoring (recomputed after SERP completes too)
          intent,
          topic,
          funnel,
          // Keyword-classification columns.
          buyingIntent: deriveBuyingIntent(intent, topic, funnel),
          isFaq: isFaqKeyword(keyword),
          keywordRelevance: '', // set after tier is classified below
          frequency: 1,
          adRating: 0,
          // Internal-only: marker for KP rows with no volume + no competition.
          // Used by the SERP-cycle seed picker to deprioritise these. Stripped
          // before persistence by background.js stripInternalFields.
          _lowSignalKp: lowSignalKp || false,
          // Internal-only: keyword matched our brand but not an anchor word
          // (e.g. "now superfoods" while we sell "now foods alfalfa"). Useful
          // competitive intel — store the row, skip the SERP load.
          _brandOnly: (typeof opts.isBrandOnlyMatch === 'function' && productContext &&
                       source !== 'kp_idea' && source !== 'kp_reexpand')
            ? opts.isBrandOnlyMatch(keyword, productContext)
            : false,
        };
        // Tier classification (brand_product / brand_other / generic_product /
        // anchor_only). Surfaces on every row — including KP rows — so the
        // export + Results UI can group by tier; also drives R2 seed
        // selection and the SERP-cycle log.
        if (typeof opts.classifyKeyword === 'function' && productContext) {
          const cls = opts.classifyKeyword(keyword, productContext);
          row.tier = cls.tier || '';
          // Tier 2 (brand_other) — whether discovered via PAA, autosuggest,
          // related search, OR KP — should skip the SERP cycle. Mark with
          // _brandOnly so processKeywordCycle's skip-SERP branch picks it up.
          if (cls.tier === 'brand_other') row._brandOnly = true;
        } else {
          row.tier = '';
        }
        // Product-relevance label derived from the tier just assigned.
        row.keywordRelevance = deriveKeywordRelevance(row.tier);
        // Brand-only rows are sibling-brand products. Their sellers (when
        // we eventually look at them) aren't carrying OUR product — they're
        // a different product from the same brand. Distinct from both
        // `product_sellers` and `competitor_sellers`.
        if (row._brandOnly) row.seller_type = 'brand_other_product';
        // Seed an initial adRating from categorical signals so rows that
        // never get a SERP-success branch (CAPTCHA, network failure, no
        // image refs) still carry a non-zero, sortable score.
        // Brand-only rows get a fixed low score — they're siblings of our
        // product, not direct competitors, so they shouldn't crowd the top.
        // (computeAdRating now also handles brand_other internally → 5.)
        if (row._brandOnly) {
          row.adRating = 5;
        } else if (typeof opts.computeAdRating === 'function') {
          row.adRating = opts.computeAdRating({
            frequency: 1,
            image_count: 0,
            total_thumbs: 0,
            match_confidence_max: 0,
            totalSellers: 0,
            source: row.source,
            funnel: row.funnel,
            kp_monthly_searches: row.kpMonthlySearches,
            seller_type: row.seller_type,
            tier: row.tier,
            _brandOnly: !!row._brandOnly,
          });
        }
        report.set(compositeKey, row);
        productRows.push(row);
        return row;
      };

      // ----- INTERLEAVED per-keyword processing -----
      // Original spec: "For each keyword: Google search → image count →
      // autosuggest → write row." Each keyword finishes its full cycle BEFORE
      // we discover the next one. This makes every row 'complete' as it's
      // written, so a mid-run Stop never leaves rows missing data.
      const maxRows = Math.max(0, opts.maxImageMatchRows ?? 0);
      let serpsDone = 0;
      const shouldSkipSerp = () => maxRows > 0 && serpsDone >= maxRows;

      // The per-row cycle. Does:
      //   1. SERP image match for THIS row (unless capped/blocked)
      //   2. Autosuggest fetch for THIS row (stored on the row)
      // Returns the autosuggestion strings so the caller can choose to expand
      // them into their own rows. Does NOT add any rows itself.
      // Leaf-pacing knobs. Autosuggest leaves are lower-risk than initial KP
      // seed searches (Google sees them as follow-up queries, not a surge),
      // so we use a shorter randomised pause window for them.
      const LEAF_SERP_DELAY_MIN_MS = 5_000;
      const LEAF_SERP_DELAY_MAX_MS = 15_000;

      // NOTE: param renamed from `opts` -> `cycleOpts` so the outer `opts`
      // (which carries shouldKeepKeyword / isRelevantToProduct / computeAdRating /
      // etc. from the harness) is reachable. The previous local-shadow form
      // silently disabled every `opts.x` callback inside this function.
      async function processKeywordCycle(row, label, cycleOpts = {}) {
        if (shouldStop()) return [];

        // Pre-SERP relevance gate. addRow already filters non-KP rows at
        // creation time, but a redundant check here is the load-bearing one
        // for KP rows that bypass addRow's filter (kp_idea / kp_reexpand
        // skip the filter on purpose so KP's broader set isn't over-pruned).
        // For any KP keyword that reached the SERP-cycle subset and is
        // clearly off-product, skip the SERP load entirely.
        if (typeof opts.isRelevantToProduct === 'function' && productContext &&
            !opts.isRelevantToProduct(row.keyword, productContext)) {
          // If the rejection was specifically a form-factor mismatch, name
          // the wrong-form in the log so the user can see why.
          const formReason = (typeof opts.getWrongFormReason === 'function')
            ? opts.getWrongFormReason(row.keyword, productContext)
            : null;
          onProgress?.({
            currentProduct: productName,
            currentSource: 'serp',
            currentAction: formReason
              ? `${label} ⛔ Wrong form: "${row.keyword}" (${formReason})`
              : `${label} skipped irrelevant keyword: "${row.keyword}" (no SERP load)`,
            logKind: 'err',
          });
          return [];
        }

        // Brand-only rows: store the keyword + autosuggest data but skip
        // the SERP block entirely. These are sibling-brand products (e.g.
        // "now superfoods" while we sell "now foods alfalfa") — they have
        // brand value as competitive intel, but their product images and
        // sellers won't match our actual product so a SERP load is wasted.
        const skipSerpForBrandOnly = !!row._brandOnly;
        if (skipSerpForBrandOnly) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'serp',
            currentAction: `${label} <brand_other> 📦 "${row.keyword}" — sibling-brand product, storing without SERP`,
            logKind: 'ok',
          });
        }

        // Tier 1: SERP image match
        if (productFps && productFps.length > 0 && !shouldSkipSerp() && !skipSerpForBrandOnly) {
          const sdMin = cycleOpts.leaf ? LEAF_SERP_DELAY_MIN_MS : searchDelayMin;
          const sdMax = cycleOpts.leaf ? LEAF_SERP_DELAY_MAX_MS : searchDelayMax;
          const sdMs = randInt(sdMin, sdMax);
          onProgress?.({
            currentProduct: productName,
            currentSource: 'serp',
            currentAction: `${label} "${row.keyword}" — pausing ${Math.round(sdMs/1000)} s before SERP`,
          });
          const ok = await sleepInterruptible(sdMs, shouldStop);
          if (!ok) return [];
          serpsDone++;
          // Fire the SERP load and the autocomplete fetch in parallel. The
          // autosuggest endpoint is independent and finishes in ~50-200ms;
          // running it alongside the SERP load saves ~0.5-1s per keyword.
          // The result is stashed on `row._prefetchedAutosuggest` so the
          // Tier-2 autosuggest step below picks it up instead of re-fetching.
          const _suggestPromise = getAutocomplete(row.keyword).catch(() => []);
          let serpData = await loadProductSerp(row.keyword, productFps, productImages, clipThreshold,
            (m) => onProgress?.({ currentProduct: productName, currentSource: 'serp', currentAction: `${label} ${m}` }),
            productContext,
            { priorMatchedUrls: productMatchedUrls, priorMatchedConfidences: productMatchedConfidences });
          try { row._prefetchedAutosuggest = await _suggestPromise; } catch { row._prefetchedAutosuggest = []; }

          // brand_product retry: if this keyword names our brand AND our
          // product anchor (e.g. "now foods alfalfa") yet the SERP returned
          // 0 matches, it's almost always a bad SERP roll — Google A/B-tested
          // us into a layout that hid the KP/shopping shelf. Retry ONCE with
          // direct-URL navigation (different referrer fingerprint than
          // chrome.search.query). Skip on retries, leaves, and non-brand rows.
          if (
            serpData.ok && !serpData.captcha &&
            (serpData.count || 0) === 0 &&
            row.tier === 'brand_product' &&
            !cycleOpts.isRetry && !cycleOpts.leaf &&
            !row._brandRetryDone
          ) {
            row._brandRetryDone = true;
            const retryDelay = randInt(5000, 10000);
            onProgress?.({
              currentProduct: productName, currentSource: 'serp',
              currentAction: `${label} "${row.keyword}" — brand_product with 0 matches, retrying in ${Math.round(retryDelay/1000)}s (direct-URL pass)`,
            });
            const ok = await sleepInterruptible(retryDelay, shouldStop);
            if (ok) {
              const retrySerp = await loadProductSerp(row.keyword, productFps, productImages, clipThreshold,
                (m) => onProgress?.({ currentProduct: productName, currentSource: 'serp', currentAction: `${label} retry ${m}` }),
                productContext,
                { forceMethod: 'directUrl', priorMatchedUrls: productMatchedUrls, priorMatchedConfidences: productMatchedConfidences });
              if (retrySerp.ok && !retrySerp.captcha && (retrySerp.count || 0) > (serpData.count || 0)) {
                onProgress?.({
                  currentProduct: productName, currentSource: 'serp',
                  currentAction: `${label} "${row.keyword}" — retry found ${retrySerp.count} match(es) (was 0)`,
                  logKind: 'ok',
                });
                serpData = retrySerp;
              }
            }
          }
          // Inline CAPTCHA retry — fresh-tab pass with the opposite
          // navigation method before falling back to the end-of-product
          // retry queue. Google rotates verification at the per-tab /
          // per-referrer level; a fresh tab via the OTHER method often
          // clears immediately. Skip if we've already tried this (the
          // _captchaInlineRetry flag), if we're on a retry pass, or if
          // it's a leaf row (those are low-priority and don't justify
          // double the time budget).
          if (serpData.captcha && !cycleOpts.isRetry && !cycleOpts.leaf && !row._captchaInlineRetry) {
            row._captchaInlineRetry = true;
            const captchaRetryDelay = randInt(7000, 14000);
            // Toggle the method — if loadProductSerp used chrome.search.query
            // first, retry with direct URL; if it used direct URL, retry via
            // chrome.search.query (forceMethod=null reverts to default).
            const flipMethod = (serpData.method === 'directUrl') ? null : 'directUrl';
            onProgress?.({
              currentProduct: productName, currentSource: 'serp',
              currentAction: `${label} "${row.keyword}" — verification page, retrying in ${Math.round(captchaRetryDelay/1000)}s (fresh tab, ${flipMethod === 'directUrl' ? 'direct-URL' : 'chrome.search'} pass)`,
              logKind: 'err',
            });
            const ok = await sleepInterruptible(captchaRetryDelay, shouldStop);
            if (ok) {
              const retrySerp = await loadProductSerp(row.keyword, productFps, productImages, clipThreshold,
                (m) => onProgress?.({ currentProduct: productName, currentSource: 'serp', currentAction: `${label} captcha-retry ${m}` }),
                productContext,
                { forceMethod: flipMethod, priorMatchedUrls: productMatchedUrls, priorMatchedConfidences: productMatchedConfidences });
              if (retrySerp.ok && !retrySerp.captcha) {
                onProgress?.({
                  currentProduct: productName, currentSource: 'serp',
                  currentAction: `${label} "${row.keyword}" — captcha-retry cleared, ${retrySerp.count} match(es)`,
                  logKind: 'ok',
                });
                serpData = retrySerp;
                consecutiveSerpBlocks = 0;
              }
            }
          }
          if (serpData.captcha) {
            consecutiveSerpBlocks++;
            // Queue for retry at the end of the product cycle, unless we're
            // already on a retry attempt (cycleOpts.isRetry) — that would
            // re-queue endlessly. Skip retry for leaf rows too; they're
            // low-priority enough to drop.
            const _curAttempt = row._captchaAttempts || 0;
            if (!cycleOpts.isRetry && !cycleOpts.leaf && _curAttempt < MAX_CAPTCHA_RETRIES && captchaRetryQueue) {
              row._captchaAttempts = _curAttempt + 1;
              captchaRetryQueue.push({ row, attempts: row._captchaAttempts });
              onProgress?.({
                currentProduct: productName,
                currentSource: 'serp',
                currentAction: `${label} "${row.keyword}" — ⚠️ verification page, queued for retry (attempt ${row._captchaAttempts}/${MAX_CAPTCHA_RETRIES})`,
                logKind: 'err',
              });
            } else {
              onProgress?.({
                currentProduct: productName,
                currentSource: 'serp',
                currentAction: `${label} "${row.keyword}" — Google verification page (image_count=0, continuing)`,
              });
            }
          } else if (!serpData.ok) {
            consecutiveSerpBlocks++;
            onProgress?.({
              currentProduct: productName,
              currentSource: 'serp',
              currentAction: `${label} "${row.keyword}" — ${serpData.error} (image_count=0, continuing)`,
            });
          } else {
            consecutiveSerpBlocks = 0;
            // CLIP candidates that scored above threshold but had no brand
            // context in their surrounding SERP text. Almost always a
            // visually-similar competitor product. Kept as a separate count
            // so the user can audit potential matches.
            row.imageCountUnverified = serpData.unverifiedCount || 0;
            row.matchedThumbnails    = serpData.matchedThumbnails;
            row.matchedConfidences   = serpData.matchedConfidences;
            row.matchedSellers       = serpData.matchedSellers || [];
            row.matchedPrices        = serpData.matchedPrices  || [];
            row.matchedLinks         = serpData.matchedLinks   || [];
            row.matchedQualities     = serpData.matchedQualities || [];
            row._matchedEmbeddings   = serpData.matchedEmbeddings || [];
            // image_count semantics: CONFIRMED matches only. A thumbnail
            // counts as image_count when its surrounding SERP text resolves
            // to our specific SKU (clean / dhash / partial_spec_confirmed /
            // pack_variant_*). Pack variants count because they ARE our
            // product, just packaged as a multipack at retail.
            //
            // Two quality tiers are EXCLUDED from image_count and tracked
            // separately so a SERP with 9 different sibling Aquaphor
            // thumbnails (only brand visible in text, can't pin to a
            // specific SKU) doesn't claim all 9 as ours:
            //   - ambiguous_brand_match → ambiguous_match_count
            //   - no_brand_lowclip      → folded into ambiguous_match_count
            const NON_CONFIRMED = (q) => q === 'ambiguous_brand_match' || q === 'no_brand_lowclip';
            row.ambiguousMatchCount = (row.matchedQualities || []).filter(NON_CONFIRMED).length;
            row.imageCount = Math.max(0, (serpData.count || 0) - row.ambiguousMatchCount);
            // Count of pack-variant matches (multipack listings of our SKU).
            // Subset of image_count; surfaced so the user can spot when a
            // keyword's match story is dominated by bundle listings vs
            // single-unit listings.
            row.packVariantCount = (row.matchedQualities || [])
              .filter(q => typeof q === 'string' && q.startsWith('pack_variant')).length;
            // Feed the per-product matched-URL cache with this keyword's
            // matches. Subsequent generic-query SERPs reuse these via the
            // rescue path's cache-trust check.
            if (Array.isArray(row.matchedThumbnails)) {
              const _confs = row.matchedConfidences || [];
              for (let mi = 0; mi < row.matchedThumbnails.length; mi++) {
                const u = row.matchedThumbnails[mi];
                if (!u) continue;
                productMatchedUrls.add(u);
                const prev = productMatchedConfidences.get(u) || 0;
                const cur = _confs[mi] || 0;
                if (cur > prev) productMatchedConfidences.set(u, cur);
              }
            }
            // Rich per-keyword SERP context (sellers + ads on the page).
            // Variant filter: drop seller entries whose title carries a
            // CONFLICTING spec value (e.g. "180 capsules" for our 90-cap
            // product). The CLIP layer already rejects the matching
            // thumbnail; without this, the listing's title/price still
            // leaked into seller_* / top_match_* / amazon_* fields.
            const rawSellers = serpData.allSellers || [];
            row.sellers = (typeof productContext?.checkVariantConflict === 'function')
              ? rawSellers.filter(s => {
                  const txt = `${s?.title || ''} ${s?.price || ''}`.toLowerCase();
                  return !txt || (productContext.checkVariantConflict(txt) || []).length === 0;
                })
              : rawSellers;
            if (rawSellers.length !== row.sellers.length) {
              onProgress?.({
                currentProduct: productName,
                currentSource: 'serp',
                currentAction: `${label} variant-filtered sellers: ${rawSellers.length} → ${row.sellers.length} (${rawSellers.length - row.sellers.length} dropped for wrong SKU)`,
              });
            }
            // Merge sellers from matched thumbnails into the seller set —
            // these merchants are demonstrably selling our product on this
            // SERP, so they should count toward total_sellers even when the
            // SERP-wide seller scrape (.kp-wholepage etc.) missed them.
            // Without this, brand-only SERPs (KP-driven) report
            // total_sellers=1 even though 9 thumbnails matched.
            {
              const existing = new Set(
                (row.sellers || [])
                  .map(s => (s && s.domain ? String(s.domain).toLowerCase() : ''))
                  .filter(Boolean)
              );
              for (let i = 0; i < (row.matchedSellers || []).length; i++) {
                const raw = (row.matchedSellers[i] || '').toString().trim();
                if (!raw) continue;
                const key = raw.toLowerCase();
                if (existing.has(key)) continue;
                existing.add(key);
                row.sellers.push({
                  domain: raw,
                  title : '',
                  price : (row.matchedPrices && row.matchedPrices[i]) || '',
                  source: 'image_match',
                });
              }
            }
            row.totalSellers = Array.isArray(row.sellers) ? row.sellers.length : (serpData.totalSellers || 0);
            row.adsOnSerp    = serpData.adsOnSerp     || 0;
            // SERP-blocked tag: Google soft-blocked this query (empty #rso
            // + only Google asset images). Surface in the row + log so the
            // 0-match isn't mistaken for real "no visibility".
            if (serpData.serpBlocked) {
              row.serp_status = 'blocked';
              onProgress?.({
                currentProduct: productName,
                currentSource: 'serp',
                currentAction: `${label} ⚠ SERP_BLOCKED: empty #rso + only Google asset images — recording as blocked, not 0-match`,
                logKind: 'err',
              });
            }

            // Per-keyword audit aids (exported to CSV / manager). serp_url is
            // a clickable Google link the user can open to manually compare
            // against image_count. match_sources tells them WHICH zone the
            // wins came from. thumbs_captured contrasts what we found vs what
            // matched, including how many CLIP-passed thumbs were dropped for
            // missing brand context.
            row.serp_url = `https://www.google.com/search?q=${encodeURIComponent(row.keyword)}&gl=in&hl=en&pws=0`;
            row.matchSourceBreakdown = serpData.matchSourceBreakdown || {};
            row.matchSources = Object.entries(row.matchSourceBreakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}:${v}`)
              .join(' | ');
            // Per-zone FOUND image counts (all thumbnails captured, matched or
            // not) — e.g. "shopping_carousel:8 | popular_products:6 | organic:4".
            row.foundZoneCounts = Object.entries(serpData.sourceBreakdown || {})
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}:${v}`)
              .join(' | ');
            const _tCap = serpData.thumbCount || 0;
            const _tMatched = serpData.count || 0;
            const _tUnv = serpData.unverifiedCount || 0;
            row.thumbsCaptured = `${_tCap} found, ${_tMatched} matched` +
              (_tUnv > 0 ? `, ${_tUnv} unverified` : '');
            // Raw counts that feed the new ad_rating formula (visibility %).
            // Stored under both keyCase variants because the export layer
            // reads `total_thumbs` while the engine uses `totalThumbs`.
            row.totalThumbs   = _tCap;
            row.total_thumbs  = _tCap;
            row.visibilityPct = _tCap > 0 ? Math.round((_tMatched / _tCap) * 100) : 0;
            // Tag whose sellers these are. With image_count > 0 at least
            // one SERP thumbnail matched our product → some of these sellers
            // are selling US. With 0 matches the sellers are competitors
            // selling something else on the same query — still useful as
            // competitive intel, but materially different data.
            row.seller_type = (row.imageCount || 0) > 0 ? 'product_sellers' : 'competitor_sellers';
            // Dropy-as-seller check. dropy.in is our own store; surface whether
            // it shows up as a seller on this keyword's Google (Shopping) SERP.
            const _isDropy = (d) => typeof d === 'string' && /(^|[./@])dropy\b|dropy\.in/i.test(d);
            row.dropyIsSeller = (row.matchedSellers || []).some(_isDropy);
            row.dropyOnSerp   = row.dropyIsSeller ||
              (row.sellers || []).some(s => _isDropy(s && s.domain)) ||
              (row.matchedSellers || []).some(_isDropy);
            // Confidence stats so adRating has match_confidence_max to work with
            const confs = (row.matchedConfidences || []).filter(c => typeof c === 'number');
            row.match_confidence_max = confs.length ? Math.max(...confs) : 0;
            row.match_confidence_min = confs.length ? Math.min(...confs) : 0;
            row.match_confidence_avg = confs.length ? Math.round(confs.reduce((s,v) => s+v, 0) / confs.length) : 0;
            // Recompute adRating with the new per-keyword data (image_count,
            // match_confidence_max, totalSellers, etc.)
            if (typeof opts.computeAdRating === 'function') {
              row.adRating = opts.computeAdRating({
                frequency: row.frequency || 1,
                image_count: row.imageCount,
                total_thumbs: row.totalThumbs || 0,
                match_confidence_max: row.match_confidence_max,
                totalSellers: row.totalSellers,
                source: row.source,
                funnel: row.funnel,
                kp_monthly_searches: row.kpMonthlySearches,
                seller_type: row.seller_type,
                tier: row.tier,
                _brandOnly: !!row._brandOnly,
              });
            }
            // ----- Matched-link verification -----
            // For each result whose thumbnail already matched our product,
            // open its destination page, pull that page's product image, and
            // re-run CLIP to confirm the landing page really carries our
            // product. Bounded to matched links + maxLinkVerify (0-match
            // keywords cost nothing). Uses fetch, not a tab navigation.
            if (verifyMatchedLinks && productFps && productFps.length > 0) {
              const uniqueLinks = Array.from(new Set(
                (row.matchedLinks || []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
              )).slice(0, maxLinkVerify);
              if (uniqueLinks.length > 0) {
                let checked = 0, verified = 0;
                const verifiedLinks = [];
                for (const link of uniqueLinks) {
                  if (shouldStop()) break;
                  try {
                    const destImages = await getProductImages(link, () => {});
                    if (!destImages || destImages.length === 0) { checked++; continue; }
                    const results = await matchImages(productFps, destImages, clipThreshold);
                    const isMatch = Array.isArray(results) && results.some(r => r && r.isMatch);
                    checked++;
                    if (isMatch) { verified++; verifiedLinks.push(link); }
                  } catch { checked++; }
                  await sleep(randInt(600, 1500));
                }
                row.linkCheckedCount  = checked;
                row.linkVerifiedCount = verified;
                row.linkVerified      = verified > 0;
                row.verifiedLinks     = verifiedLinks;
                onProgress?.({
                  currentProduct: productName,
                  currentSource: 'verify',
                  currentAction: `${label} "${row.keyword}" — link verify: ${verified}/${checked} destination page(s) confirmed carry our product`,
                  logKind: verified > 0 ? 'ok' : undefined,
                });
              }
            }
            // Image-guided expansion: only push related searches into the
            // queue if our product is actually visible on this SERP (or the
            // keyword mentions our brand). With image_count=0 the related
            // searches are about competitor products — they'd just cascade
            // more competitor-territory SERPs.
            const _rowKwLower = String(row.keyword || '').toLowerCase();
            const _hasBrand = !!productContext && (productContext.brandAliases || []).some(a =>
              a && a.length > 2 && _rowKwLower.includes(a));
            const _expansionEligible = (row.imageCount || 0) > 0 || _hasBrand;
            const rsList = serpData.relatedSearches || [];
            let rsQueued = 0;
            if (_expansionEligible && rsList.length > 0 && relatedSearchQueue) {
              for (const rs of rsList) {
                if (typeof opts.shouldKeepKeyword === 'function' &&
                    !opts.shouldKeepKeyword(rs, productName)) continue;
                if (typeof opts.isRelevantToProduct === 'function' && productContext &&
                    !opts.isRelevantToProduct(rs, productContext)) continue;
                relatedSearchQueue.push(rs);
                rsQueued++;
              }
            }
            // Diagnostic: surface the actual CLIP scores so the user can see
            // when matches are dying just below the threshold. A line like
            //   scores=[76,72,45] threshold=72 nearMiss=1
            // says "one thumb scored 70-71 — try lowering the threshold".
            const _scoresStr = (serpData.topScores && serpData.topScores.length)
              ? ` scores=[${serpData.topScores.join(',')}] t=${serpData.thresholdPct} near=${serpData.nearMissCount || 0}`
              : '';
            const _unvStr = (serpData.unverifiedCount || 0) > 0
              ? ` unverified=${serpData.unverifiedCount} (CLIP-passed but no brand context)`
              : '';
            const _srcStr = serpData.sourceBreakdown && Object.keys(serpData.sourceBreakdown).length
              ? ` [${Object.entries(serpData.sourceBreakdown).map(([k,v]) => `${k}:${v}`).join(', ')}]`
              : '';
            const _tierBadge = row.tier ? ` <${row.tier}>` : '';
            const _stypeLabel =
              row.seller_type === 'product_sellers'      ? 'product'      :
              row.seller_type === 'brand_other_product'  ? 'brand-other'  :
                                                           'competitor';
            onProgress?.({
              currentProduct: productName,
              currentSource: 'serp',
              currentAction: `${label}${_tierBadge} "${row.keyword}" — ${serpData.count} match${serpData.count === 1 ? '' : 'es'} (${serpData.thumbCount} thumbs${_srcStr}; tier: cache=${serpData.tierBreakdown?.cache || 0} dhash=${serpData.tierBreakdown?.dhash || 0} clip=${serpData.tierBreakdown?.clip || 0});${_scoresStr}${_unvStr} sellers=${row.totalSellers}/${_stypeLabel} ads=${row.adsOnSerp}; rs=${rsList.length}${_expansionEligible ? '' : ' (rs not queued — 0 matches)'} | verify: ${row.serp_url}`,
              logKind: serpData.count > 0 ? 'ok' : undefined,
            });
            // Per-thumb multi-signal breakdown — one line per scored thumb,
            // showing total confidence and every signal that fed into it:
            // CLIP, color, text-overlap %, the matched product words,
            // brand/anchor hits, and the leading bit of surrounding text.
            // This is the line that explains exactly why each thumbnail
            // was kept or skipped.
            if (Array.isArray(serpData.matchBreakdownLog) && serpData.matchBreakdownLog.length > 0) {
              for (const m of serpData.matchBreakdownLog) {
                const matchedStr = (m.matched && m.matched.length) ? m.matched.join(',') : '—';
                // Surface the three-layer match outcome so a kept-but-
                // penalised thumb (variant fired, identity demoted) doesn't
                // look identical to a clean match in the log. Without these
                // fields it's impossible to tell whether checkVariantConflict
                // fired at all; with them, "variant=✗" makes the penalty
                // visible even when the total still clears the threshold.
                const identityStr = m.product && m.product !== 'ok' ? ` product=✗(${m.product})` : '';
                const lineStr     = m.line ? ` line=✗(${m.line})` : '';
                const siblingStr  = m.sibling ? ` sibling=✗(${m.sibling})` : '';
                const slotStr     = m.slot ? ` slot=✗(${m.slot})` : '';
                const colorVStr   = m.colorVeto ? ` color=✗(${m.colorVeto})` : '';
                const swapStr     = m.swap ? ` swap=✗(${m.swap})` : '';
                const ambigStr    = m.ambig ? ` AMBIG=${m.ambig}` : '';
                const attrStr     = m.attr ? ` attr=✗(${m.attr})` : '';
                const variantStr  = m.variant ? ` variant=✗(${m.variant})` : '';
                const vetoStr     = m.veto ? ` VETO=${m.veto}` : '';
                onProgress?.({
                  currentProduct: productName,
                  currentSource: 'serp',
                  currentAction: `${label}   ${m.kept ? '✓' : '✗'} total=${m.conf} clip=${m.clip} color=${m.color ?? '—'} text=${m.text ?? '—'}${typeof m.text === 'number' ? '%' : ''} brand=${m.brand ? '✓' : '✗'} anchor=${m.anchor ? '✓' : '✗'}${identityStr}${lineStr}${siblingStr}${slotStr}${colorVStr}${swapStr}${ambigStr}${attrStr}${variantStr}${vetoStr} matched=[${matchedStr}] ctx="${m.ctx}"`,
                });
              }
            }
            // Unverified examples already covered by the breakdown above when
            // present; this block is a fallback for older sandbox responses.
            if ((!Array.isArray(serpData.matchBreakdownLog) || serpData.matchBreakdownLog.length === 0)
                && Array.isArray(serpData.unverifiedSamples) && serpData.unverifiedSamples.length > 0) {
              for (const s of serpData.unverifiedSamples) {
                onProgress?.({
                  currentProduct: productName,
                  currentSource: 'serp',
                  currentAction: `${label}   ⚠ unverified clip=${s.conf} total=${s.total || '?'} — seller="${s.seller}" title="${s.title}"`,
                });
              }
            }
            // Remember the eligibility flag for the Tier-2 return.
            row._expansionEligible = _expansionEligible;
          }
        }

        // Tier 2: autosuggest fetch (free, no SERP load)
        if (shouldStop()) {
          await onRowAdded(row);
          return [];
        }
        // Image-guided autosuggest gate: when the SERP had 0 image matches
        // AND the keyword has no brand mention, autosuggest results will
        // be about competitor products. Skip the fetch entirely and don't
        // store autosuggestions on the row — saves a request and prevents
        // competitor noise from polluting the report.
        // Exceptions:
        //   • brand-only rows (_brandOnly) — sibling-brand context still useful
        //   • keywords whose own text contains a brand alias — same logic
        const _captureKw = String(row.keyword || '').toLowerCase();
        const _captureHasBrand = !!productContext && (productContext.brandAliases || [])
          .some(a => a && a.length > 2 && _captureKw.includes(a));
        if (!alwaysExpandAutosuggest && !row._brandOnly && !_captureHasBrand && (row.imageCount || 0) === 0) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'autosuggest',
            currentAction: `${label} "${row.keyword}" — skipping autosuggest (0 matches, no brand)`,
          });
          row.autosuggestions = [];
          row.autosuggestCount = 0;
          await onRowAdded(row);
          return [];
        }
        // Log before AND after the autosuggest fetch so any stall (slow
        // Google response, network hang, etc.) is visible. 10 s hard timeout
        // in fetchWithTimeout below means even a hung fetch can't lock us up.
        // If the SERP-tier already prefetched suggestions in parallel, we
        // reuse those instead of issuing a second request.
        const t0 = Date.now();
        const _prefetched = Array.isArray(row._prefetchedAutosuggest) ? row._prefetchedAutosuggest : null;
        onProgress?.({
          currentProduct: productName,
          currentSource: 'autosuggest',
          currentAction: _prefetched
            ? `${label} "${row.keyword}" — using prefetched autosuggest (${_prefetched.length} raw)`
            : `${label} "${row.keyword}" — fetching autosuggest`,
        });
        const rawSuggestions = _prefetched !== null
          ? _prefetched
          : await getAutocomplete(row.keyword);
        if (_prefetched !== null) row._prefetchedAutosuggest = null;
        // Three-stage filter for leaf candidates:
        //   1. shouldKeepKeyword     — India / English / noise (product-agnostic)
        //   2. classifyKeyword       — relevance, form, tier (product-aware)
        //      relevant=false       → drop, log reason
        //      loadSERP=false (T2)  → drop from leaf queue (brand-other:
        //                              competitive intel but no SERP cost)
        //   3. else                  → keep, log will show the rejection counts
        let suggestions = rawSuggestions;
        if (typeof opts.shouldKeepKeyword === 'function') {
          suggestions = suggestions.filter(s => opts.shouldKeepKeyword(s, productName));
        }
        const leafRejectCounts = {};
        let leafBrandOther = 0;
        if (typeof opts.classifyKeyword === 'function' && productContext) {
          suggestions = suggestions.filter(s => {
            const cls = opts.classifyKeyword(s, productContext);
            if (!cls.relevant) {
              const reason = cls.reason || 'rejected';
              leafRejectCounts[reason] = (leafRejectCounts[reason] || 0) + 1;
              return false;
            }
            if (!cls.loadSERP) { leafBrandOther++; return false; }
            return true;
          });
        } else if (typeof opts.isRelevantToProduct === 'function' && productContext) {
          // Back-compat fallback for old harnesses.
          suggestions = suggestions.filter(s => opts.isRelevantToProduct(s, productContext));
        }
        const dropped = rawSuggestions.length - suggestions.length;
        const _leafBreakdown = (Object.keys(leafRejectCounts).length || leafBrandOther > 0)
          ? ' [' + [
              ...Object.entries(leafRejectCounts).map(([k,v]) => `${k}:${v}`),
              ...(leafBrandOther > 0 ? [`brand_other:${leafBrandOther}`] : []),
            ].join(', ') + ']'
          : '';
        const dt = Date.now() - t0;
        onProgress?.({
          currentProduct: productName,
          currentSource: 'autosuggest',
          currentAction: `${label} "${row.keyword}" — got ${suggestions.length} autosuggestion${suggestions.length === 1 ? '' : 's'}${dropped > 0 ? ` (${dropped} filtered${_leafBreakdown})` : ''} in ${dt} ms`,
          logKind: suggestions.length > 0 ? 'ok' : undefined,
        });
        row.autosuggestions = suggestions;
        row.autosuggestCount = suggestions.length;
        await onRowAdded(row);
        await sleep(randInt(AUTOSUGGEST_DELAY_MIN_MS, AUTOSUGGEST_DELAY_MAX_MS));

        // Image-guided expansion decision. The caller spawns leaf-SERPs from
        // whatever this function returns; returning [] suppresses leaves.
        //   - image_count > 0 → product visible → expand (leaves likely match too)
        //   - has brand     → keyword is on-brand → expand (leaves are on-brand too)
        //   - brand-only    → SERP skipped, but row._brandOnly === true → expand
        //   - otherwise     → store autosuggestions as text but DO NOT cascade
        //                     into leaf SERPs. Saves ~K × 15s per 0-match parent.
        const kwLowerFinal = String(row.keyword || '').toLowerCase();
        const hasBrandFinal = !!productContext && (productContext.brandAliases || []).some(a =>
          a && a.length > 2 && kwLowerFinal.includes(a));
        const expansionEligible = alwaysExpandAutosuggest
          || !!row._brandOnly
          || hasBrandFinal
          || (row.imageCount || 0) > 0
          || row._expansionEligible === true;

        if (expansionEligible) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'expand',
            currentAction: `✓ "${row.keyword}" — ${row.imageCount || 0} match(es)${hasBrandFinal ? ' / brand' : ''}, expanding ${suggestions.length} leaf(s)`,
            logKind: 'ok',
          });
          return suggestions;
        }
        if (suggestions.length > 0) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'expand',
            currentAction: `○ "${row.keyword}" — 0 matches, stored ${suggestions.length} autosuggestion(s) without leaf expansion`,
          });
        }
        return [];
      }

      // Wrapper that catches any error from processKeywordCycle so a single
      // bad row never kills the for-loop. Returns [] on failure; caller just
      // moves on to the next row.
      async function safeCycle(row, label, opts = {}) {
        try {
          return await processKeywordCycle(row, label, opts);
        } catch (e) {
          onProgress?.({
            currentProduct: productName,
            currentAction: `${label} "${row.keyword}" — cycle error (${e?.message || e}) — moving on`,
            logKind: 'err',
          });
          return [];
        }
      }

      // ----- ROUND 1: KP1 + PAA seeds, each processed in full before next -----
      // First, classify every KP keyword:
      //   - Tier 1/3/4 (relevant, SERP-eligible) → addRow + push to kp1RowsArr.
      //   - Tier 2 (brand_other) → addRow with _brandOnly=true, stored without
      //     SERP. Not added to kp1RowsArr (won't enter R1 SERP-cycle queue).
      //   - Rejected (wrong_form / category_only_no_anchor / no_signals) →
      //     dropped before they pollute the report or burn a SERP slot.
      const kp1RowsArr = [];
      const round1Seeds = [];
      // Raised 30→60: more Round-1 SERP seeds → more autosuggest + PAA +
      // related expansion downstream → more keywords per SKU (target 100-300).
      const MAX_R1_KP_SERP_SEEDS = 60;
      const kpRejectCounts = {};
      let kpBrandOtherStored = 0;
      const kpBrandOtherSamples = [];
      for (const item of kpKeywords) {
        if (report.size >= productCap) break;
        const k = toKpItem(item);
        if (!k) continue;
        // KP filtering: classify each idea up front, drop irrelevant ones,
        // route brand-other to the storage-only path.
        if (typeof opts.classifyKeyword === 'function' && productContext) {
          const cls = opts.classifyKeyword(k.kw, productContext);
          if (!cls.relevant) {
            const reason = cls.reason || 'rejected';
            kpRejectCounts[reason] = (kpRejectCounts[reason] || 0) + 1;
            continue;
          }
          if (!cls.loadSERP) {
            // Tier 2 — store as brand-other, no SERP cycle.
            const r = addRow(k.kw, 'kp_idea', '', k);
            if (r) {
              kpBrandOtherStored++;
              if (kpBrandOtherSamples.length < 5) kpBrandOtherSamples.push(k.kw);
            }
            continue;
          }
        }
        const r = addRow(k.kw, 'kp_idea', '', k);
        if (r) kp1RowsArr.push(r);
      }
      const totalKpRejected = Object.values(kpRejectCounts).reduce((s, v) => s + v, 0);
      if (totalKpRejected > 0 || kpBrandOtherStored > 0) {
        const rejStr = Object.entries(kpRejectCounts).map(([k,v]) => `${k}:${v}`).join(', ');
        onProgress?.({
          currentProduct: productName,
          currentSource: 'kp',
          currentAction: `KP filter: ${kpKeywords.length} ideas → ${kp1RowsArr.length} SERP-eligible, ${kpBrandOtherStored} brand-other stored, ${totalKpRejected} rejected${rejStr ? ' ['+rejStr+']' : ''}`,
          logKind: 'ok',
        });
        if (kpBrandOtherSamples.length > 0) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'kp',
            currentAction: `  brand-other samples: ${kpBrandOtherSamples.join(' | ')}`,
          });
        }
      }
      // PAA questions are always SERP-cycled (high-intent, small list).
      for (const q of paaQuestions) {
        if (report.size >= productCap) break;
        const r = addRow(q, 'paa', '');
        if (r) round1Seeds.push(r);
      }
      // KP SERP-cycle picks: high-signal first (have volume or competition),
      // then fill remaining slots from low-signal rows in original KP order.
      const highSignalKp = kp1RowsArr.filter(r => !r._lowSignalKp);
      const lowSignalKp  = kp1RowsArr.filter(r =>  r._lowSignalKp);
      const kpPicks = [...highSignalKp, ...lowSignalKp].slice(0, MAX_R1_KP_SERP_SEEDS);
      for (const r of kpPicks) round1Seeds.push(r);

      // FALLBACK SEED: if KP returned zero AND there are zero PAA questions
      // (worst case — engine has nothing to cycle), seed R1 with the product
      // name itself + a few obvious variants. Without this fallback, the
      // engine bails after the one product SERP load and finishes in 2-3 min
      // with almost no keywords. This rescues the run instead of silently
      // producing nothing.
      if (round1Seeds.length === 0) {
        // Guard against empty productName — happens when URL slug
        // parsing failed or the page had no usable title. Without
        // this guard fallback seeds become `["", " review", " price",
        // " best"]` which are useless searches.
        const seedBase = (productName && productName.trim().length > 0)
          ? productName.trim()
          : (p.sku || cleanUrl.split('/').pop() || '').replace(/[^a-z0-9\s-]/gi, ' ').replace(/[-_]+/g, ' ').trim();
        if (seedBase) {
          const fallbackSeeds = [
            seedBase,
            `${seedBase} review`,
            `${seedBase} price`,
            `${seedBase} best`,
          ];
          for (const fs of fallbackSeeds) {
            if (report.size >= productCap) break;
            const r = addRow(fs, 'fallback_no_kp', '');
            if (r) round1Seeds.push(r);
          }
          onProgress?.({
            currentProduct: productName,
            currentSource: 'round1',
            currentAction: `⚠ KP + PAA both empty — using ${round1Seeds.length} fallback seed(s) from "${seedBase}". Yield will be low (~10-30 kw). Check KP URL / Google Ads login if this happens on every product.`,
            logKind: 'warn',
          });
        } else {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'round1',
            currentAction: `⚠ KP + PAA both empty AND no usable product name / SKU / URL slug for fallback seeds. Product will yield 0 keywords. Check the product file's "Product URL" + "SKU" columns.`,
            logKind: 'err',
          });
        }
      }

      onProgress?.({
        currentProduct: productName,
        currentSource: 'round1',
        currentAction: `Round 1: ${kp1RowsArr.length} KP keyword(s) stored, ${round1Seeds.length} SERP-cycled (${paaQuestions.length} PAA + ${kpPicks.length} top KP). Each cycled seed: SERP → image match → autosuggest → expansion.`,
        logKind: 'ok',
      });

      for (let si = 0; si < round1Seeds.length; si++) {
        if (shouldStop() || report.size >= productCap) break;
        const seedRow = round1Seeds[si];
        const seedLabel = `R1 ${si + 1}/${round1Seeds.length} (${seedRow.source}):`;
        const suggestions = await safeCycle(seedRow, seedLabel);

        // Expand each relevance-passing suggestion as its own row, then
        // process it through the same cycle (with leaf-paced SERP and leaf
        // autosuggest stored).
        for (const s of suggestions) {
          if (shouldStop() || report.size >= productCap) break;
          if (!isRelevantKeyword(s, relevanceSet)) continue;
          const child = addRow(s, 'autosuggest', seedRow.keyword);
          if (!child) continue;
          await safeCycle(child, `R1-leaf:`, { leaf: true });
        }
      }

      // ----- ROUND 2: KP re-expansion driven by R1 PERFORMERS -----
      //
      // Old behaviour: re-fed the original KP picks back into KP, which
      // returned the same ideas → 0 new keywords every time. New seed
      // selection: keywords that R1 surfaced AS WINNERS — image_count > 0
      // OR adRating >= 30. Excludes the original kpPicks (no point asking
      // KP about a seed it already gave us) and Tier-2 brand-other rows.
      //
      // Result: R2 explores "what does KP know about queries that just
      // proved themselves on Google?" — usually long-tail commercial
      // variants we wouldn't have seeded otherwise.
      const MAX_R2_KP_SEEDS = 5;
      const r2BrandAliases  = productContext?.brandAliases || [];
      const r2CategoryTerms = productContext?.categoryTerms || [];
      const r2SeedQualityOk = (kwText) => {
        const text = String(kwText || '').trim();
        if (text.split(/\s+/).length < 2) return false; // too generic
        if (typeof opts.classifyKeyword === 'function' && productContext) {
          const cls = opts.classifyKeyword(text, productContext);
          // Accept any classify-relevant SERP-loadable seed for R2 — image
          // matches on Tier 3/4 anchor queries are valuable too.
          return cls.relevant && cls.loadSERP;
        }
        const lo = text.toLowerCase();
        const hasBrand = r2BrandAliases.some(a => a && lo.includes(a));
        const hasCategoryTerm = r2CategoryTerms.some(t => lo.includes(t));
        if (!hasBrand && !hasCategoryTerm) return false;
        if (typeof opts.isRelevantToProduct === 'function' &&
            !opts.isRelevantToProduct(text, productContext)) return false;
        return true;
      };
      // The set of keywords we already fed to KP in R1 + R2-seed proposals.
      // Excluding these prevents KP from being asked the same seed twice.
      const r1KpSeedSet = new Set(
        kp1RowsArr.map(r => String(r.keyword || '').toLowerCase().trim())
      );
      // Candidates = rows that R1 surfaced as strong winners (image_count
      // >= 3 — single-match seeds drag too-generic competitor floods into
      // R2's KP scrape). Also exclude brand-other rows and the original
      // R1 KP seeds (no point re-asking KP about a seed it already gave us).
      const R2_MIN_IMAGE_MATCHES = 3;
      const r2Candidates = Array.from(productRows).filter(r => {
        const kwLower = String(r.keyword || '').toLowerCase().trim();
        if (!kwLower) return false;
        if (r.tier === 'brand_other') return false;
        if (r1KpSeedSet.has(kwLower)) return false;
        if ((r.imageCount || 0) < R2_MIN_IMAGE_MATCHES) return false;
        if (!r2SeedQualityOk(r.keyword)) return false;
        return true;
      });
      // Sort: image matches first (Google confirmed our product), then by
      // adRating. Take top N. Dedupe via seedsAreSimilar so we don't
      // re-expand near-identical seeds.
      r2Candidates.sort((a, b) => {
        const imgDiff = (b.imageCount || 0) - (a.imageCount || 0);
        if (imgDiff !== 0) return imgDiff;
        return (b.adRating || 0) - (a.adRating || 0);
      });
      const kp1ForR2 = [];
      for (const cand of r2Candidates) {
        if (kp1ForR2.length >= MAX_R2_KP_SEEDS) break;
        if (typeof opts.seedsAreSimilar === 'function' &&
            kp1ForR2.some(picked => opts.seedsAreSimilar(cand.keyword, [picked.keyword]))) continue;
        kp1ForR2.push(cand);
      }
      if (kp1ForR2.length > 0) {
        onProgress?.({
          currentProduct: productName,
          currentSource: 'round2',
          currentAction: `Round 2 seeds from top R1 performers: ${kp1ForR2.map(r => `"${r.keyword}"`).join(', ')}`,
          logKind: 'ok',
        });
      }
      const totalKp1 = kp1ForR2.length;
      const AVG_KP_REEXPAND_SECONDS = 50;
      const round2StartedAt = Date.now();
      if (!shouldStop() && report.size < productCap && totalKp1 > 0) {
        const estMin = Math.max(1, Math.round((totalKp1 * AVG_KP_REEXPAND_SECONDS) / 60));
        onProgress?.({
          currentProduct: productName,
          currentSource: 'round2',
          currentAction: `Round 2 starting: re-running KP on ${totalKp1} top KP1 keyword(s) (out of ${kp1RowsArr.length} stored). Estimated ~${estMin} min for KP scrapes alone.`,
          logKind: 'ok',
        });
      }
      let kp1Idx = 0;
      let kp2RowCount = 0;
      // R2 degradation tracking. Each seed that exhausts retries increments
      // this; the per-product completion summary surfaces the count so a
      // silently-degraded run is visible without grepping the log.
      let r2DegradedSeeds = 0;
      for (const seedRow of kp1ForR2) {
        kp1Idx++;
        if (shouldStop() || report.size >= productCap) break;
        const expandSeed = simplifyForKP(seedRow.keyword);
        const elapsedS  = (Date.now() - round2StartedAt) / 1000;
        const observedAvg = kp1Idx > 1 ? elapsedS / (kp1Idx - 1) : AVG_KP_REEXPAND_SECONDS;
        const remaining = Math.max(0, totalKp1 - kp1Idx + 1);
        const etaMin = Math.max(1, Math.round((remaining * observedAvg) / 60));
        onProgress?.({
          currentProduct: productName,
          currentSource: 'kp expand',
          currentAction: `Round 2 (${kp1Idx}/${totalKp1}): re-expanding KP for "${expandSeed}" — ~${etaMin} min KP work remaining`,
          keywordCount: report.size,
          productKeywordCount: productRows.length,
        });
        // R2 KP with up to 2 retries. The KP UI is brittle after R1's long
        // idle (Discover-card click hangs, results table times out, content
        // script disconnects). Without retry, a transient failure on the
        // first attempt makes us skip the entire R2 branch — which is
        // exactly the high-value re-expansion stage. We back off between
        // attempts so the KP tab has time to settle / hydrate.
        const R2_KP_MAX_ATTEMPTS = 3; // 1 initial + 2 retries
        let expansion = null;
        let r2SeedAttempts = 0;
        let r2SeedDegraded = false;
        for (let attempt = 1; attempt <= R2_KP_MAX_ATTEMPTS; attempt++) {
          r2SeedAttempts = attempt;
          if (attempt > 1) {
            const backoff = randInt(8000, 15000) * (attempt - 1); // 8-15s, then 16-30s
            onProgress?.({
              currentProduct: productName,
              currentSource: 'kp expand',
              currentAction: `Round 2 (${kp1Idx}/${totalKp1}): KP attempt ${attempt}/${R2_KP_MAX_ATTEMPTS} for "${expandSeed}" — backing off ${Math.round(backoff/1000)}s before retry`,
            });
            const ok = await sleepInterruptible(backoff, shouldStop);
            if (!ok) break;
          }
          expansion = await getKeywordPlannerIdeas(expandSeed, kpUrl, kpMaxPerProduct,
            (m) => onProgress?.({ currentProduct: productName, currentAction: m }),
            { productUrl: cleanUrl, allowWebsiteFallback: false });
          if (expansion?.ok) break;
        }

        // "Google returned no ideas for this seed" is now ok:true + empty:true.
        // It's not a failure; the seed just has no useful expansion. Log softly
        // (not as R2_DEGRADED) and move on to the next seed.
        if (expansion?.ok && expansion?.empty) {
          onProgress?.({
            currentProduct: productName,
            currentAction: `Round 2 (${kp1Idx}/${totalKp1}): "${seedRow.keyword}" — Google returned no keyword ideas (empty seed, not an error)`,
            logKind: 'info',
          });
          continue;
        }

        if (!expansion?.ok) {
          r2SeedDegraded = true;
          r2DegradedSeeds++;
          onProgress?.({
            currentProduct: productName,
            currentAction: `Round 2 (${kp1Idx}/${totalKp1}): "${seedRow.keyword}" KP failed after ${r2SeedAttempts} attempt(s): ${expansion?.error || 'unknown'} — flagging R2 as degraded for this product`,
            logKind: 'err',
          });
        } else {
          // Filter R2 KP output against the product-relevance gate BEFORE
          // any per-row cycle. KP re-expansion on a category-broad seed like
          // "alfalfa supplement" returns farming / livestock ideas mixed in.
          // We store all R2 ideas as rows (addRow's own gate decides), but
          // for SERP cycling we apply an extra strict relevance pass here.
          const rawR2 = expansion.keywords || [];
          const relevantR2 = (typeof opts.isRelevantToProduct === 'function' && productContext)
            ? rawR2.filter(item => {
                const kw = typeof item === 'string' ? item : item?.kw;
                return kw && opts.isRelevantToProduct(kw, productContext);
              })
            : rawR2;
          if (rawR2.length !== relevantR2.length) {
            onProgress?.({
              currentProduct: productName,
              currentSource: 'round2',
              currentAction: `R2 KP "${seedRow.keyword}": ${rawR2.length} ideas, ${relevantR2.length} relevant after filter (${rawR2.length - relevantR2.length} off-product dropped)`,
              logKind: 'ok',
            });
          }

          let kp2Added = 0;
          // Cap KP output per seed — KP can return 300+ ideas for a
          // borderline seed like "alfalfa 650 mg benefits", and most are
          // competitor-brand noise. Raised 20→40 to feed the 100-300
          // kw/SKU target; relevance filter still gates the wide net.
          const R2_KP_CAP_PER_SEED = 40;
          const cappedR2 = relevantR2.slice(0, R2_KP_CAP_PER_SEED);
          if (relevantR2.length > R2_KP_CAP_PER_SEED) {
            onProgress?.({
              currentProduct: productName,
              currentSource: 'round2',
              currentAction: `R2 KP cap: "${seedRow.keyword}" took top ${R2_KP_CAP_PER_SEED} of ${relevantR2.length} relevant ideas`,
            });
          }
          // 3-strike rule: after 3 consecutive 0-match KP2 children, the
          // remaining ideas from this seed are almost certainly competitor
          // brands. Skip the rest and move on to the next R2 seed.
          let consecutiveZeroMatch = 0;
          const R2_ZERO_BREAK = 3;
          for (const item of cappedR2) {
            if (shouldStop() || report.size >= productCap) break;
            const k = toKpItem(item);
            if (!k) continue;
            const child = addRow(k.kw, 'kp_reexpand', seedRow.keyword, k);
            if (!child) continue;
            kp2Added++;
            kp2RowCount++;
            const childLabel = `R2 kp${kp1Idx}/${totalKp1} kw${kp2Added}:`;
            const suggestions = await safeCycle(child, childLabel);
            if ((child.imageCount || 0) === 0) {
              consecutiveZeroMatch++;
              if (consecutiveZeroMatch >= R2_ZERO_BREAK) {
                onProgress?.({
                  currentProduct: productName,
                  currentSource: 'round2',
                  currentAction: `R2 strike: 3 consecutive 0-match KP2 keywords for "${seedRow.keyword}" — skipping remaining`,
                  logKind: 'ok',
                });
                break;
              }
            } else {
              consecutiveZeroMatch = 0;
            }

            for (const s of suggestions) {
              if (shouldStop() || report.size >= productCap) break;
              if (!isRelevantKeyword(s, relevanceSet)) continue;
              const leaf = addRow(s, 'autosuggest', child.keyword);
              if (!leaf) continue;
              await safeCycle(leaf, `R2-leaf:`, { leaf: true });
            }
          }
          onProgress?.({
            currentProduct: productName,
            currentAction: `Round 2 (${kp1Idx}/${totalKp1}): "${seedRow.keyword}" → ${kp2Added} KP2 keyword(s) processed (${expansion.cached ? 'cache hit' : 'fresh scrape'})`,
            logKind: kp2Added > 0 ? 'ok' : undefined,
            keywordCount: report.size,
          });
        }
        await sleep(randInt(3000, 8000));
      }
      if (totalKp1 > 0 && !shouldStop()) {
        const wholeMin = Math.round((Date.now() - round2StartedAt) / 60000);
        onProgress?.({
          currentProduct: productName,
          currentSource: 'round2',
          currentAction: `Round 2 complete: ${kp1Idx}/${totalKp1} KP1 keywords re-expanded, ${kp2RowCount} KP2 rows processed in ${wholeMin} min`,
          logKind: 'ok',
        });
      }

      // ----- Related-search drain -----
      // Process the related-searches discovered during R1/R2 SERPs as
      // additional 'related_search' rows. Each gets the same per-row cycle
      // (own SERP + own image-match + own autosuggest).
      if (relatedSearchQueue.length > 0 && !shouldStop() && report.size < productCap) {
        const uniqueRs = Array.from(new Set(relatedSearchQueue.map(s => s.trim()))).filter(Boolean);
        onProgress?.({
          currentProduct: productName,
          currentSource: 'related',
          currentAction: `Related-search drain: processing ${uniqueRs.length} unique seed(s) discovered during R1/R2`,
        });
        for (const rs of uniqueRs) {
          if (shouldStop() || report.size >= productCap) break;
          const row = addRow(rs, 'related_search', '');
          if (!row) continue;
          await safeCycle(row, `RS:`, { leaf: true });
        }
      }

      // ----- CAPTCHA retry drain -----
      // Re-run SERPs for keywords that hit a verification page during R1/R2.
      // Longer pre-SERP pauses (15-30 s) since the IP / session got flagged
      // before. Capped to MAX_CAPTCHA_RETRIES attempts per keyword.
      if (captchaRetryQueue.length > 0 && !shouldStop()) {
        const _retries = captchaRetryQueue.splice(0); // drain
        onProgress?.({
          currentProduct: productName,
          currentSource: 'retry',
          currentAction: `CAPTCHA retry: re-running ${_retries.length} keyword(s) flagged earlier`,
          logKind: 'ok',
        });
        for (const item of _retries) {
          if (shouldStop()) break;
          const restMs = randInt(15_000, 30_000);
          onProgress?.({
            currentProduct: productName,
            currentSource: 'retry',
            currentAction: `Retry pause: ${Math.round(restMs/1000)} s before re-attempting "${item.row.keyword}"`,
          });
          const ok = await sleepInterruptible(restMs, shouldStop);
          if (!ok) break;
          await safeCycle(item.row, `RETRY${item.attempts}:`, { leaf: true, isRetry: true });
        }
      }

      // ----- Amazon Round (R3) — browser-driven -----
      //
      // Amazon's completion.amazon.* endpoint 502s for non-browser callers,
      // so we drive the search box in a real Amazon.in tab. For each of the
      // top-N highest-rated keywords in the report:
      //   1. Type into Amazon's search input, read the autosuggest dropdown.
      //   2. Navigate to amazon.in/s?k=<kw>, scrape the listings.
      //   3. Find OUR product on the listings → record rank/price/rating
      //      /reviews/Amazon's-title-for-our-product.
      //   4. Record top competitor listings.
      //   5. For each Amazon-suggested keyword that passes the relevance
      //      gate, run the standard per-row cycle (Google SERP + match).
      const MAX_AMAZON_TOP_KEYWORDS = maxAmazonKeywords;
      const AMAZON_PER_SUGGEST_CAP   = 6;
      if (!shouldStop() && report.size < productCap) {
        // Amazon search list: product name first, then every KP keyword that
        // passed the relevance filter. KP ideas already carry real search
        // volume and KP's own product gate, so they're a better starting
        // point than picking by adRating (which was biased toward keywords
        // that happened to find image matches on Google).
        const topForAmazon = [];
        const seen = new Set();
        const pushParent = (row) => {
          if (!row || !row.keyword) return;
          const k = String(row.keyword).toLowerCase().trim();
          if (!k || seen.has(k)) return;
          if (row.tier === 'brand_other' || row._brandOnly) return;
          seen.add(k);
          topForAmazon.push(row);
        };

        // 1) Product name itself — find an existing row for it, otherwise
        // synthesize one so the Amazon search still runs. Synthesized rows
        // are stored in the report so amazon_* fields land in the CSV.
        const pnQuery = (productContext?.fullProductName || productName || '').trim();
        if (pnQuery) {
          const pnKey = pnQuery.toLowerCase();
          // Composite key — see `keyFor` defined in addRow above. The report
          // map is now keyed per (product, keyword) pair so multiple SKUs
          // can share the same headline keyword.
          let pnRow = report.get(keyFor(pnKey));
          if (!pnRow) {
            pnRow = addRow(pnQuery, 'product_name', '');
          }
          // addRow returns null if the row was rejected (junk/relevance gate
          // /cap). When that happens, fall back to a transient parent — the
          // Amazon data won't persist but the search still runs.
          if (!pnRow) {
            pnRow = { keyword: pnQuery, source: 'product_name', _transient: true };
          }
          pushParent(pnRow);
        }

        // 2) All KP rows that survived the relevance filter.
        for (const r of productRows) {
          if (r.source === 'kp_idea' || r.source === 'kp_reexpand') pushParent(r);
        }
        // Autosuggest rows also enter the Amazon Round (after KP ideas, which
        // keep priority within the cap) so long-tail queries get Amazon data.
        for (const r of productRows) {
          if (r.source === 'autosuggest') pushParent(r);
        }
        // Cap: KP-driven runs return ~20-30 ideas; limit to keep Amazon Round
        // bounded to a few minutes.
        if (topForAmazon.length > MAX_AMAZON_TOP_KEYWORDS) {
          topForAmazon.length = MAX_AMAZON_TOP_KEYWORDS;
        }

        if (topForAmazon.length > 0) {
          onProgress?.({
            currentProduct: productName,
            currentSource: 'amazon',
            currentAction: `Amazon Round: ${topForAmazon.length} keyword(s) — product name + KP ideas`,
            logKind: 'ok',
          });

          // Open a single Amazon tab; keep it across all top keywords.
          let amazonTabId = null;
          try {
            amazonTabId = await Worker.navigate('https://www.amazon.in/');
            await sleep(randInt(2500, 4000));
            const ready = await pingContentScript(amazonTabId, 'AMAZON_PING', 15, 1000);
            if (!ready) {
              onProgress?.({
                currentProduct: productName,
                currentSource: 'amazon',
                currentAction: `Amazon Round: amazon-reader content script never responded — skipping`,
                logKind: 'err',
              });
              amazonTabId = null;
            }
          } catch (e) {
            onProgress?.({
              currentProduct: productName,
              currentSource: 'amazon',
              currentAction: `Amazon Round: failed to open tab — ${e.message}`,
              logKind: 'err',
            });
            amazonTabId = null;
          }

          let amazonStored = 0, amazonRejected = 0;
          if (amazonTabId !== null) {
            const brandAliases = (productContext?.brandAliases || []).filter(a => a && a.length > 2);
            const handleWords  = (productContext?.handleWords  || []).filter(w => w && w.length > 3);

            for (const parent of topForAmazon) {
              if (shouldStop() || report.size >= productCap) break;

              // --- Step 1: autosuggest from Amazon ---
              let amazonSugs = [];
              try {
                const r = await chrome.tabs.sendMessage(amazonTabId, {
                  type: 'AMAZON_GET_SUGGESTIONS', keyword: parent.keyword,
                });
                amazonSugs = Array.isArray(r?.suggestions) ? r.suggestions : [];
              } catch (e) {
                onProgress?.({
                  currentProduct: productName, currentSource: 'amazon',
                  currentAction: `Amazon suggest error for "${parent.keyword}": ${e.message}`,
                  logKind: 'err',
                });
              }
              parent.amazon_suggest_count = amazonSugs.length;
              onProgress?.({
                currentProduct: productName, currentSource: 'amazon',
                currentAction: `Amazon suggest "${parent.keyword}" → ${amazonSugs.length} suggestion(s)`,
                logKind: amazonSugs.length > 0 ? 'ok' : undefined,
              });

              // --- Step 2: navigate to Amazon search results ---
              let amazonResults = [];
              try {
                await chrome.tabs.update(amazonTabId, {
                  url: `https://www.amazon.in/s?k=${encodeURIComponent(parent.keyword)}`,
                });
                await sleep(randInt(2500, 4500));
                const ready = await pingContentScript(amazonTabId, 'AMAZON_PING', 10, 800);
                if (ready) {
                  const r = await chrome.tabs.sendMessage(amazonTabId, { type: 'AMAZON_GET_RESULTS' });
                  amazonResults = Array.isArray(r?.results) ? r.results : [];
                }
              } catch (e) {
                onProgress?.({
                  currentProduct: productName, currentSource: 'amazon',
                  currentAction: `Amazon SERP error for "${parent.keyword}": ${e.message}`,
                  logKind: 'err',
                });
              }
              onProgress?.({
                currentProduct: productName, currentSource: 'amazon',
                currentAction: `Amazon SERP "${parent.keyword}" → ${amazonResults.length} product listing(s)`,
              });

              // Diagnostic — surface what we got back from amazon-reader so
              // we can see WHY matches succeed or fail (brand/anchor presence).
              // Combine title + brand field — Amazon's card often puts the
              // brand in a SEPARATE element ("Now Foods"), with the title only
              // showing the product type ("Alfalfa 10 Grain, 650mg, 500 Tabs").
              // Checking only title misses the brand on every such card.
              if (amazonResults.length > 0) {
                const previewLines = amazonResults.slice(0, 5).map(r => {
                  const tl = `${r.title || ''} ${r.brand || ''}`.toLowerCase();
                  const b = brandAliases.some(a => tl.includes(a));
                  const a = handleWords.some(w => tl.includes(w));
                  return `  #${r.position} brand=${b} anchor=${a} "${(r.title || '').slice(0, 80)}" brand_field="${(r.brand || '').slice(0, 30)}"`;
                });
                onProgress?.({
                  currentProduct: productName, currentSource: 'amazon',
                  currentAction:
                    `Amazon match-debug brandAliases=[${brandAliases.slice(0, 5).join(',')}] anchors=[${handleWords.slice(0, 5).join(',')}]\n` +
                    previewLines.join('\n'),
                });
              } else {
                onProgress?.({
                  currentProduct: productName, currentSource: 'amazon',
                  currentAction: `Amazon match-debug: 0 listings scraped — check amazon-reader log for selector breakage`,
                  logKind: 'err',
                });
              }

              // --- Step 3 & 4: find our product + record competitors ---
              let ourRank = 0, ourPrice = '', ourRating = '', ourReviews = '', ourTitle = '';
              const competitors = [];
              for (const r of amazonResults.slice(0, 20)) {
                // Brand lives in `result.brand` on most current Amazon cards;
                // only checking `title` misses every card where the title is
                // just the product line. Combine both fields for the check.
                const tl = `${r.title || ''} ${r.brand || ''}`.toLowerCase();
                const hasBrand  = brandAliases.some(a => tl.includes(a));
                const hasAnchor = handleWords.some(w => tl.includes(w));
                // Three-layer match: brand → product identity → variant.
                //   • brand fails           → competitor (different brand)
                //   • brand ✓ identity ✗    → competitor (sibling product:
                //                              "Plant Enzymes" not "Super
                //                              Enzymes" even though both
                //                              are NOW Foods + "enzymes")
                //   • brand ✓ identity ✓ variant ✗ → competitor (wrong SKU)
                //   • brand ✓ identity ✓ variant ✓ → OURS
                let identity = { tier: 'full', match: true, missingWords: [] };
                if (hasBrand && hasAnchor && productContext?.checkProductIdentity) {
                  identity = productContext.checkProductIdentity(tl);
                }
                // Tiered identity for Amazon: partial-tier requires spec
                // confirmation to claim, otherwise treat as competitor.
                if (identity.tier === 'partial') {
                  const specConf = typeof productContext.hasSpecConfirmation === 'function'
                    ? productContext.hasSpecConfirmation(tl)
                    : { confirmed: false };
                  // Promote partial-tier to "match" only if spec confirms.
                  // Without spec confirmation, treat as identity miss
                  // (downstream logic uses identity.match).
                  if (specConf.confirmed) {
                    identity = { ...identity, match: true, specConfirmation: specConf };
                  }
                }
                const lineMod = (hasBrand && hasAnchor && identity.match && productContext?.checkProductLineModifier)
                  ? productContext.checkProductLineModifier(tl)
                  : null;
                const variantConflicts = (hasBrand && hasAnchor && identity.match && !lineMod && productContext?.checkVariantConflict)
                  ? productContext.checkVariantConflict(tl)
                  : [];
                const siblingMatchAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && productContext?.checkSiblingProduct)
                  ? productContext.checkSiblingProduct(tl)
                  : null;
                const slotMatchAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && productContext?.checkVariantSlot)
                  ? productContext.checkVariantSlot(tl)
                  : null;
                const colorMatchAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && !slotMatchAmz && productContext?.checkColorConflict)
                  ? productContext.checkColorConflict(tl)
                  : null;
                const swapMatchAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && !slotMatchAmz && !colorMatchAmz && productContext?.checkNameSwap)
                  ? productContext.checkNameSwap(tl)
                  : null;
                const sibAmbAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && !slotMatchAmz && !colorMatchAmz && !swapMatchAmz && productContext?.checkSiblingAmbiguity)
                  ? productContext.checkSiblingAmbiguity(tl)
                  : null;
                const attrFamAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && !slotMatchAmz && !colorMatchAmz && !swapMatchAmz && !sibAmbAmz && productContext?.checkAttributeFamily)
                  ? productContext.checkAttributeFamily(tl)
                  : null;
                const brandMateAmz = (hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && !slotMatchAmz && !colorMatchAmz && !swapMatchAmz && !sibAmbAmz && !attrFamAmz && productContext?.checkBrandMate)
                  ? productContext.checkBrandMate(tl)
                  : null;
                const ourProduct = hasBrand && hasAnchor && identity.match && !lineMod && variantConflicts.length === 0 && !siblingMatchAmz && !slotMatchAmz && !colorMatchAmz && !swapMatchAmz && !sibAmbAmz && !attrFamAmz && !brandMateAmz;
                if (ourProduct) {
                  if (!ourRank) {
                    ourRank    = r.position;
                    ourPrice   = r.price || '';
                    ourRating  = r.rating || '';
                    ourReviews = r.reviewCount || '';
                    ourTitle   = r.title || '';
                  }
                } else if (competitors.length < 5) {
                  if (hasBrand && hasAnchor && !identity.match) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand match but WRONG PRODUCT (missing: ${identity.missingWords.join(', ')} from identity [${(productContext.coreTypeWords || []).join(' ')}])`,
                    });
                  } else if (hasBrand && hasAnchor && lineMod) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but WRONG PRODUCT LINE (modifier "${lineMod.modifier}" not in our product name)`,
                    });
                  } else if (siblingMatchAmz) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but SIBLING PRODUCT ("${siblingMatchAmz.term}", ${siblingMatchAmz.type})`,
                    });
                  } else if (slotMatchAmz) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but VARIANT SLOT MISMATCH (ours="${slotMatchAmz.ours}", theirs="${slotMatchAmz.theirs}")`,
                    });
                  } else if (colorMatchAmz) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but COLOR MISMATCH (ours="${colorMatchAmz.ours}", theirs="${colorMatchAmz.theirs}")`,
                    });
                  } else if (swapMatchAmz) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but SHADE/MODEL SWAP (+${swapMatchAmz.extras.join(',')} / -${swapMatchAmz.missing.join(',')})`,
                    });
                  } else if (sibAmbAmz) {
                    let msg;
                    if (sibAmbAmz.ambiguous) {
                      msg = `  ⚠ Amazon #${r.position}: brand+identity match but SIBLING AMBIGUOUS — listing has no confirmation of any discriminator we own; cannot pin to our SKU`;
                    } else if (sibAmbAmz.kind === 'raw') {
                      msg = `  ⚠ Amazon #${r.position}: brand+identity match but SIBLING TOKEN MISMATCH (listing has "${sibAmbAmz.token}" which is another sibling's discriminator)`;
                    } else if (sibAmbAmz.kind === 'attr') {
                      msg = `  ⚠ Amazon #${r.position}: brand+identity match but SIBLING ATTR MISMATCH (${sibAmbAmz.family}: ours=${sibAmbAmz.ours ?? '—'}, theirs=${sibAmbAmz.theirs})`;
                    } else {
                      msg = `  ⚠ Amazon #${r.position}: brand+identity match but SIBLING DIM MISMATCH (${sibAmbAmz.dim}: ours=${sibAmbAmz.ours}, theirs=${sibAmbAmz.theirs})`;
                    }
                    onProgress?.({ currentProduct: productName, currentSource: 'amazon', currentAction: msg });
                  } else if (attrFamAmz) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but ATTRIBUTE MISMATCH (${attrFamAmz.family}: ours=${attrFamAmz.ours}, theirs=${attrFamAmz.theirs})`,
                    });
                  } else if (brandMateAmz) {
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but BRAND-MATE TOKEN (listing has "${brandMateAmz.token}", which belongs to a sibling SKU in this batch)`,
                    });
                  } else if (variantConflicts.length > 0) {
                    const c = variantConflicts[0];
                    onProgress?.({
                      currentProduct: productName, currentSource: 'amazon',
                      currentAction: `  ⚠ Amazon #${r.position}: brand+identity match but WRONG VARIANT (${c.type}: ${c.ours} vs ${c.theirs})`,
                    });
                  }
                  competitors.push(
                    `#${r.position} ${(r.title || '').slice(0, 60)}${r.price ? ' (' + r.price + ')' : ''}`
                  );
                }
              }
              parent.amazon_rank          = ourRank;
              parent.amazon_price         = ourPrice;
              parent.amazon_rating        = ourRating;
              parent.amazon_reviews       = ourReviews;
              parent.amazon_title         = ourTitle;
              parent.amazon_competitors   = competitors.join(' | ');
              parent.amazon_total_results = amazonResults.length;
              onProgress?.({
                currentProduct: productName, currentSource: 'amazon',
                currentAction: ourRank
                  ? `  ✓ Our product at #${ourRank} on Amazon (${ourPrice || 'no price'})`
                  : `  ✗ Our product NOT in top ${amazonResults.length} Amazon results`,
                logKind: ourRank ? 'ok' : undefined,
              });

              // --- Step 5: queue Amazon suggestions through the standard cycle ---
              let processed = 0;
              for (const sug of amazonSugs) {
                if (processed >= AMAZON_PER_SUGGEST_CAP) break;
                if (shouldStop() || report.size >= productCap) break;
                if (typeof opts.shouldKeepKeyword === 'function' &&
                    !opts.shouldKeepKeyword(sug, productName)) { amazonRejected++; continue; }
                if (typeof opts.classifyKeyword === 'function' && productContext) {
                  const cls = opts.classifyKeyword(sug, productContext);
                  if (!cls.relevant || !cls.loadSERP) { amazonRejected++; continue; }
                }
                const row = addRow(sug, 'amazon_suggest', parent.keyword);
                if (!row) { amazonRejected++; continue; }
                row.amazon_parent_rating = parent.adRating || 0;
                await safeCycle(row, `AMZN:`, { leaf: true });
                amazonStored++;
                processed++;
              }

              // Polite pause before the next Amazon keyword.
              await sleep(randInt(2000, 4000));
            }
          }

          onProgress?.({
            currentProduct: productName,
            currentSource: 'amazon',
            currentAction: `Amazon Round complete: ${amazonStored} new keyword(s) added, ${amazonRejected} filtered`,
            logKind: 'ok',
          });
        }
      }

      // ----- KP metrics backfill (R4) -----
      // Autosuggest / PAA / related-search / amazon rows never went through KP,
      // so their kp_* columns are empty. Collect every metric-less row and run
      // ONE KP "Search volume and forecasts" scrape to backfill, then re-score.
      if (backfillKpMetrics && !shouldStop() && kpUrl && report.size < productCap) {
        const needMetrics = [];
        const seenBf = new Set();
        for (const row of productRows) {
          if (String(row.kpMonthlySearches || '').trim() ||
              String(row.kpCompetition     || '').trim()) continue;
          if (row._brandOnly) continue;
          const k = String(row.keyword || '').toLowerCase().trim();
          if (!k || seenBf.has(k)) continue;
          seenBf.add(k);
          needMetrics.push(row);
        }
        const BF_CAP = 300;
        if (needMetrics.length > 0) {
          const capped = needMetrics.slice(0, BF_CAP);
          if (needMetrics.length > BF_CAP) {
            onProgress?.({ currentProduct: productName, currentSource: 'kp metrics',
              currentAction: `KP metrics backfill: ${needMetrics.length} keywords need metrics — capping to ${BF_CAP} this product`, logKind: 'err' });
          }
          onProgress?.({ currentProduct: productName, currentSource: 'kp metrics',
            currentAction: `KP metrics backfill: looking up ${capped.length} metric-less keyword(s) via KP "Search volume and forecasts"`, logKind: 'ok' });
          const metricsResp = await getKeywordPlannerMetrics(
            capped.map(r => r.keyword), kpUrl,
            (m) => onProgress?.({ currentProduct: productName, currentSource: 'kp metrics', currentAction: m }));
          if (metricsResp.ok && metricsResp.metrics.length > 0) {
            const byKw = new Map();
            for (const m of metricsResp.metrics) {
              const kw = typeof m === 'string' ? m : m?.kw;
              if (kw) byKw.set(String(kw).toLowerCase().trim(), m);
            }
            let filled = 0;
            for (const row of capped) {
              const m = byKw.get(String(row.keyword || '').toLowerCase().trim());
              if (!m || typeof m === 'string') continue;
              let changed = false;
              if (m.monthlySearches && !row.kpMonthlySearches) { row.kpMonthlySearches = m.monthlySearches; changed = true; }
              if (m.competition     && !row.kpCompetition)     { row.kpCompetition     = m.competition;     changed = true; }
              if (m.bidLow          && !row.kpBidLow)          { row.kpBidLow          = m.bidLow;          changed = true; }
              if (m.bidHigh         && !row.kpBidHigh)         { row.kpBidHigh         = m.bidHigh;         changed = true; }
              if (!changed) continue;
              filled++;
              if (typeof opts.computeAdRating === 'function') {
                row.adRating = opts.computeAdRating({
                  frequency: row.frequency || 1,
                  image_count: row.imageCount || 0,
                  total_thumbs: row.totalThumbs || 0,
                  match_confidence_max: row.match_confidence_max || 0,
                  totalSellers: row.totalSellers || 0,
                  source: row.source,
                  funnel: row.funnel,
                  kp_monthly_searches: row.kpMonthlySearches,
                  seller_type: row.seller_type,
                  tier: row.tier,
                  _brandOnly: !!row._brandOnly,
                });
              }
              await onRowAdded(row);
            }
            onProgress?.({ currentProduct: productName, currentSource: 'kp metrics',
              currentAction: `KP metrics backfill: filled ${filled}/${capped.length} keyword(s) with KP volume/competition/bids`, logKind: 'ok' });
          } else {
            onProgress?.({ currentProduct: productName, currentSource: 'kp metrics',
              currentAction: `KP metrics backfill: no metrics returned${metricsResp.error ? ` (${metricsResp.error})` : ''}`, logKind: 'err' });
          }
        }
      }

      // ----- Noise filter DISABLED -----
      // The 3-tier matching (URL cache → dHash → CLIP cosine ≥ 0.78) is
      // already selective enough; the post-hoc cluster filter destroyed
      // legitimate matches on niche/sparse-match products (every cluster of
      // size 1 was being dropped). Per-keyword image_count is now the
      // authoritative figure — whatever CLIP found on a keyword's own SERP
      // stays on that row.
      //
      // (Kept the `applyNoiseFilter` function definition for now in case we
      // want to bring it back behind a profile flag later.)

      // Only mark the product as DONE if the user did NOT press Stop
      // mid-product. If they did, the in-flight product still has
      // unprocessed work (more PAA / R1 / RS keywords), and persisting it
      // to doneProducts would cause the next Resume to skip it and start
      // at the FOLLOWING product instead. Leaving it unmarked means
      // resume re-enters the same product cleanly; any rows already added
      // to `report` dedupe by keyword on the re-run.
      const stoppedMidProduct = shouldStop();
      if (!stoppedMidProduct) {
        productsDone++;
        await onProductDone(cleanUrl);
      } else {
        onProgress?.({
          currentProduct: productName,
          currentSource: 'done',
          currentAction: `Stop pressed mid-product — leaving "${productName}" UNMARKED so the next Resume restarts it from the beginning`,
          logKind: 'ok',
        });
      }
      // Summarise matches across every keyword's per-keyword SERP, not just
      // the one product-discovery SERP — those numbers were nearly always 0
      // even when individual R1 / RS keywords found 1-3 matches each.
      let totalMatchedThumbs = 0;
      let kwWithMatches = 0;
      for (const row of productRows) {
        const c = row.imageCount || 0;
        if (c > 0) {
          totalMatchedThumbs += c;
          kwWithMatches++;
        }
      }
      // R2_DEGRADED suffix: when one or more R2 KP seeds exhausted retries
      // for this product, surface the fact in the completion line so the
      // run isn't silently degraded. Without this the only evidence was
      // the per-seed "KP failed" log line buried thousands of lines back.
      const r2DegradedNote = r2DegradedSeeds > 0
        ? ` ⚠ R2_DEGRADED (${r2DegradedSeeds} KP seed(s) failed after retries)`
        : '';
      // Completion line distinguishes session-new (productRows.length —
      // keywords ADDED for this product during this session) from the
      // running total (report.size — every keyword in the report Map,
      // including ones merged from earlier sessions / earlier products).
      // The exported CSV size always matches report.size; the previous
      // line only mentioned productRows.length, which made users think
      // the export was wrong when in fact the log was incomplete.
      // Health check: warn if this product generated very few keywords.
      // Typical product: 50-200 keywords. < 20 = something went wrong.
      const productHealth = productRows.length < 20
        ? ` ⚠ LOW YIELD (${productRows.length} kw) — likely KP failed or all filtered. Check earlier KP log line for this product.`
        : '';
      onProgress?.({
        currentProduct: productName,
        currentSource: 'done',
        currentAction: stoppedMidProduct
          ? `Product PARTIAL (${productsDone}/${productsTotal}) — ${productRows.length} new keywords this product (${kwWithMatches} with image matches, ${totalMatchedThumbs} total matched thumbs); will re-process on Resume; report total = ${report.size}${r2DegradedNote}${productHealth}`
          : `Product complete (${productsDone}/${productsTotal}) — ${productRows.length} new keywords this product (${kwWithMatches} with image matches, ${totalMatchedThumbs} total matched thumbs); report total = ${report.size}${r2DegradedNote}${productHealth}`,
        keywordCount: report.size,
        productKeywordCount: productRows.length,
        productMatchCount: kwWithMatches,
        productsDone, productsTotal,
        logKind: (r2DegradedSeeds > 0 || productRows.length < 20) ? 'warn' : 'ok',
      });
      // Tag every row from this product with the run status so the export
      // can surface degraded products at the row level.
      if (r2DegradedSeeds > 0) {
        for (const row of productRows) {
          row.run_status = `R2_DEGRADED (${r2DegradedSeeds} seed${r2DegradedSeeds === 1 ? '' : 's'} failed)`;
        }
      }

      chunkProductCount++;

      const moreProductsLeft = sorted.slice(pi + 1).some(rp => !excludeUrls.has(cleanProductUrl(rp.url)));

      // ----- Chunk-rest? -----
      if (moreProductsLeft && chunkProductCount >= chunkSize && !shouldStop()) {
        const restMs = randInt(chunkRestMin, chunkRestMax);
        const restUntil = Date.now() + restMs;
        try { await chrome.storage.local.set({ [STORAGE_KEY_REST_UNTIL]: restUntil }); } catch {}
        onProgress?.({
          currentSource: 'rest',
          currentAction: `Chunk of ${chunkSize} complete. Resting ${Math.round(restMs/60000)} min until ${new Date(restUntil).toLocaleTimeString()} (randomised ${Math.round(chunkRestMin/60000)}-${Math.round(chunkRestMax/60000)} min)`,
          logKind: 'ok',
          restUntil,
        });
        const restOk = await sleepInterruptible(restMs, shouldStop, (rem) => {
          onProgress?.({ restUntil, currentAction: `Resting between chunks (${Math.ceil(rem/1000)} s remaining)` });
        });
        try { await chrome.storage.local.remove([STORAGE_KEY_REST_UNTIL]); } catch {}
        if (!restOk) break;
        chunkProductCount = 0;
        onProgress?.({ currentSource: 'pace', currentAction: 'Rest complete — starting next chunk', logKind: 'ok' });
      } else if (moreProductsLeft && !shouldStop()) {
        // Normal between-products pause.
        const pdMs = randInt(productDelayMin, productDelayMax);
        onProgress?.({
          currentSource: 'pace',
          currentAction: `Between-products pause: ${Math.round(pdMs/1000)} s (randomised ${Math.round(productDelayMin/1000)}-${Math.round(productDelayMax/1000)} s)`,
          logKind: 'ok',
        });
        const pdOk = await sleepInterruptible(pdMs, shouldStop);
        if (!pdOk) break;
      }
    }
  } finally {
    try { clearInterval(__heartbeatTimer); } catch {}
    try { await Worker.close(); } catch {}
  }

  return { report: Array.from(report.values()), batchId, productsDone, productsTotal };
}
