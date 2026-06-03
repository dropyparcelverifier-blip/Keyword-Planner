// modules/keyword-filter.js
//
// All keyword filtering, categorization, and scoring logic for the engine.
// Pure functions — no chrome.* APIs. Imported by background.js and passed
// to the discovery engine via opts.

// ============ 1A. shouldKeepKeyword ============

// Non-India location tokens — drop these. Word-boundary matching only so
// "korean skincare" doesn't accidentally drop "korea" from a brand name.
const NON_INDIA_TOKENS = [
  'pakistan','bangladesh','sri lanka','nepal','uae','dubai','abu dhabi',
  'usa','us','uk','united kingdom','canada','australia','malaysia','singapore',
  'philippines','nigeria','saudi','qatar','oman','kuwait','bahrain',
  'europe','china','japan','korea','thailand','indonesia','vietnam','turkey',
  'egypt','brazil','mexico','germany','france','italy','spain','russia',
  'south africa','kenya','ghana','new zealand','ireland','scotland',
  'hong kong','taiwan','myanmar','cambodia','laos','iran','iraq','afghanistan',
  'somalia','libya','syria','yemen',
];
const NON_INDIA_RE = new RegExp(
  '\\b(' + NON_INDIA_TOKENS.map(t => t.replace(/\s+/g, '\\s+')).join('|') + ')\\b',
  'i'
);
const LOCATION_PATTERN_RE = /\b(?:price\s+in|buy\s+in|delivery\s+to|shipping\s+to|shipping)\s+([a-z\s]+?)(?:$|\s)/i;
const COUNTRY_ONLINE_RE = new RegExp(
  '\\b(' + NON_INDIA_TOKENS.map(t => t.replace(/\s+/g, '\\s+')).join('|') + ')\\s+(?:online|price)\\b',
  'i'
);

const PLATFORM_NOISE = [
  'reddit','quora','youtube','wikipedia','tiktok','pinterest','facebook',
  'instagram','twitter','linkedin','whatsapp','telegram',
];
const PLATFORM_NOISE_RE = new RegExp(
  '\\b(' + PLATFORM_NOISE.join('|') + ')\\b',
  'i'
);

const UI_LITERALS = new Set([
  'people also ask','related searches','see more','more results',
  'similar searches','feedback','images','videos','news','maps','shopping',
]);

// Question prefix — PAA questions and many high-intent searches start here.
// We give these keywords more leeway (longer length, allow without brand ref).
const QUESTION_PREFIX_RE = /^(is|can|does|do|did|are|was|were|what|how|why|which|where|when|who|whom|whose|will|would|should|could|may|might)\b/i;

// Phrase-level non-English detector. The character-class filter misses
// Spanish / French / Portuguese / German because they share the Latin
// alphabet — these phrases are the giveaway tokens that surface in Google's
// autocomplete on numeric / generic queries even with hl=en&gl=in.
const NON_ENGLISH_PHRASES = [
  // Spanish
  'para que sirve', 'como se usa', 'donde comprar', 'que es', 'como tomar',
  'efectos secundarios', 'precio de', 'beneficios de', 'contraindicaciones',
  ' es bueno', ' es malo',
  // French
  'pour quoi', 'comment utiliser', 'ou acheter', 'effets secondaires',
  'velo electrique', 'pour la sante',
  // Portuguese
  'para que serve', 'como usar', 'onde comprar', 'efeitos colaterais',
  // German
  'wie verwenden', 'wo kaufen', 'nebenwirkungen', 'erfahrungen',
];

function containsNonEnglishPhrase(lower) {
  for (const p of NON_ENGLISH_PHRASES) if (lower.includes(p)) return true;
  return false;
}

export function shouldKeepKeyword(keyword, productName) {
  const k = String(keyword || '').trim();
  if (!k) return false;
  const lower = k.toLowerCase();
  const isQuestion = QUESTION_PREFIX_RE.test(k) || k.endsWith('?');

  // Length filter — questions get a longer cap because PAA naturally runs
  // to 100+ chars ("What is the difference between CeraVe Moisturizing
  // Cream and CeraVe Daily Lotion?").
  const maxLen = isQuestion ? 200 : 80;
  if (k.length > maxLen) return false;
  if (k.length < 3) return false;

  // UI literal filter
  if (UI_LITERALS.has(lower)) return false;

  // Non-India geo filter
  if (NON_INDIA_RE.test(k)) return false;
  if (COUNTRY_ONLINE_RE.test(k)) return false;
  // "price in X" / "buy in X" / "delivery to X" / "shipping X" where X is a non-India country
  const locMatch = k.match(LOCATION_PATTERN_RE);
  if (locMatch) {
    const loc = locMatch[1].toLowerCase().trim();
    if (NON_INDIA_TOKENS.some(t => loc.includes(t))) return false;
  }

  // Platform noise filter
  if (PLATFORM_NOISE_RE.test(k)) return false;

  // Phrase-level non-English (Spanish "para que sirve" etc.) — these are
  // Latin-character so the script-density check below doesn't catch them.
  if (containsNonEnglishPhrase(lower)) return false;

  // Hyper-local Google auto-localised queries: "...near mumbai, maharashtra".
  // Low-value duplicates of the non-localised form — Google appends the
  // user's city/region automatically. Reject these so we don't burn SERP
  // loads on city-by-city variants of the same query.
  if (/\bnear\s+[a-z]+(?:\s*,\s*[a-z]+)?\s*$/i.test(k)) return false;

  // English-only filter (CJK / Arabic / Cyrillic / Thai / Hangul ranges
  // explicitly excluded; Devanagari allowed for Indian-language queries).
  // Reject if more than 20 % of characters fall in a non-English script
  // OR if more than 2 chars are clearly foreign script.
  const FOREIGN_RE = /[Ѐ-ӿ؀-ۿ฀-๿　-鿿가-힯]/g;
  const foreign = (k.match(FOREIGN_RE) || []).length;
  if (foreign > 2) return false;
  // Accented Latin-Extended characters used in continental European
  // languages (Spanish "cápsulas", Polish "kapsułek", German "ß",
  // French "à/è/ç", Czech "š/ř", etc.). India-targeted runs never want
  // these — even a single accented char is a strong signal that the
  // keyword is in the wrong language. Reject on any occurrence.
  // Note: this rejects Latin-Extended A/B (À-ɏ) but leaves Devanagari
  // intact for Hindi/Marathi keywords (still allowed by the density
  // check below).
  if (/[À-ɏ]/.test(k)) return false;
  // Generic non-Latin density check (catches partly-romanised foreign text)
  const nonLatin = (k.match(/[^\x00-\x7Fऀ-ॿ]/g) || []).length;
  if (k.length > 0 && nonLatin / k.length > 0.2) return false;
  // 100 % non-Latin (Chinese, Arabic, Korean, etc.) — reject
  const latin = (k.match(/[A-Za-z]/g) || []).length;
  if (latin === 0 && k.replace(/[\s\d\W]/g, '').length > 0) return false;

  // Generic filter: under 3 words AND doesn't contain product/brand name.
  // Questions are exempt — short questions like "Is CeraVe good?" are real
  // user queries, not noise. PAA questions earn their place by being
  // user-asked, regardless of brand-token overlap.
  const words = lower.split(/\s+/).filter(Boolean);
  if (!isQuestion && words.length < 3 && productName) {
    const productLower = String(productName).toLowerCase();
    const productTokens = productLower.split(/\s+/).filter(t => t.length >= 4);
    const hasProductRef = productTokens.some(t => lower.includes(t));
    if (!hasProductRef) return false;
  }

  return true;
}

// ============ 1B. categorizeKeyword ============

const TRANSACTIONAL_TOKENS = [
  'buy','price','cost','order','shop','deal','discount','offer','cheap',
  'affordable','online','cod','delivery','purchase','where to buy',
  'best price','lowest price','coupon','sale',
];
const TRANSACTIONAL_SYMBOLS = /[₹$]|\brs\b/i;

const NAVIGATIONAL_TOKENS = [
  'amazon','flipkart','nykaa','myntra','meesho','ajio','tatacliq','purplle',
  'bigbasket','blinkit','swiggy','snapdeal','shopclues','1mg','pharmeasy','netmeds',
];

const COMMERCIAL_TOKENS = [
  'best','top','vs','versus','compare','alternative','similar','which',
  'recommend','worth','ranking','rated','popular','trending','favorite',
];

const INFORMATIONAL_HINTS = [
  'how to','what is','why','does','can i','should i','benefits',
  'side effects','ingredients','review','works','safe','uses','meaning',
  'difference',
];

const TOPIC_PATTERNS = [
  { topic: 'price',        tokens: ['price','cost','₹','rs','under','budget','affordable','cheap','expensive','mrp','rate'] },
  { topic: 'review',       tokens: ['review','worth it','honest','rating','experience','opinion','good','bad','pros','cons'] },
  { topic: 'comparison',   tokens: ['vs','versus','compare','better than','alternative','difference','or','which is'] },
  { topic: 'how-to',       tokens: ['how to use','how to apply','routine','step','when to','morning','night','tutorial','guide','tips'] },
  { topic: 'ingredient',   tokens: ['ingredients','formula','contains','ceramide','retinol','niacinamide','hyaluronic','vitamin','spf','peptide','collagen'] },
  { topic: 'availability', tokens: ['where to buy','available','stock','store','india','online','near me','delivery','shipping','official'] },
  { topic: 'concern',      tokens: ['side effects','safe','sensitive','allergy','irritation','acne','eczema','dark circles','puffy','wrinkle','aging','dry','oily','redness','pigmentation'] },
];

function containsAnyToken(lower, tokens) {
  for (const t of tokens) {
    if (t.includes(' ')) {
      if (lower.includes(t)) return true;
    } else {
      // Single-word token: word-boundary match
      const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(lower)) return true;
    }
  }
  return false;
}

export function categorizeKeyword(keyword) {
  const lower = String(keyword || '').toLowerCase();

  // Intent — first match wins, in this order
  let intent;
  if (containsAnyToken(lower, TRANSACTIONAL_TOKENS) || TRANSACTIONAL_SYMBOLS.test(lower)) {
    intent = 'transactional';
  } else if (containsAnyToken(lower, NAVIGATIONAL_TOKENS)) {
    intent = 'navigational';
  } else if (containsAnyToken(lower, COMMERCIAL_TOKENS)) {
    intent = 'commercial';
  } else if (containsAnyToken(lower, INFORMATIONAL_HINTS)) {
    intent = 'informational';
  } else {
    intent = 'informational';
  }

  // Topic — first pattern wins
  let topic = 'general';
  for (const p of TOPIC_PATTERNS) {
    if (containsAnyToken(lower, p.tokens)) { topic = p.topic; break; }
  }

  // Funnel derived from intent + topic
  let funnel;
  if (intent === 'transactional' || intent === 'navigational' || topic === 'price' || topic === 'availability') {
    funnel = 'bottom';
  } else if (intent === 'commercial' || topic === 'review' || topic === 'comparison' || topic === 'ingredient') {
    funnel = 'mid';
  } else {
    funnel = 'top';
  }

  return { intent, topic, funnel };
}

// ============ 1C. computeAdRating ============
//
// Product-visibility-as-percentage scoring:
//   ad_rating = visibility_pct + frequency_bonus + seller_bonus
// where
//   visibility_pct = round(image_count / total_thumbs * 100)
//   frequency_bonus = min(20, (frequency - 1) * 5)
//   seller_bonus = min(10, total_sellers * 2)
//
// brand_other rows (stored without a SERP load) get a fixed floor of 5 —
// they have no visibility data to score against.
// Keywords whose SERP returned 0 thumbnails (CAPTCHA / verification page /
// scrape failure) score on bonuses only — visibility falls out to 0.

export function computeAdRating(row) {
  if (
    row.seller_type === 'brand_other_product' ||
    row.tier === 'brand_other' ||
    row._brandOnly
  ) {
    return 5;
  }

  const frequency    = Math.max(1, row.frequency || 1);
  const imageCount   = Math.max(0, row.image_count || row.imageCount || 0);
  const totalThumbs  = Math.max(0, row.total_thumbs || row.totalThumbs || 0);
  const totalSellers = Math.max(0, row.totalSellers || row.total_sellers || 0);

  const visibility     = totalThumbs > 0 ? Math.round((imageCount / totalThumbs) * 100) : 0;
  const frequencyBonus = Math.min(20, (frequency - 1) * 5);
  const sellerBonus    = Math.min(10, totalSellers * 2);

  return Math.min(100, visibility + frequencyBonus + sellerBonus);
}

// ============ 1D. mergeKeywordIntoReport ============

const SOURCE_PRIORITY = { kp_idea: 3, paa: 2, autosuggest: 1, related_search: 1 };

function mergeSellers(existing, incoming) {
  const byDomain = new Map();
  for (const s of (existing || [])) {
    if (s && s.domain) byDomain.set(s.domain, s);
  }
  for (const s of (incoming || [])) {
    if (!s || !s.domain) continue;
    const cur = byDomain.get(s.domain);
    if (!cur) { byDomain.set(s.domain, s); continue; }
    // Keep the entry with a price if one was missing it; else keep first.
    if (!cur.price && s.price) byDomain.set(s.domain, s);
  }
  return Array.from(byDomain.values());
}

export function mergeKeywordIntoReport(reportMap, newRow, productName) {
  const key = String(newRow.keyword || '').toLowerCase().trim();
  if (!key) return null;

  const existing = reportMap.get(key);
  if (!existing) {
    // First time — categorize, compute rating, frequency=1
    if (!newRow.intent || !newRow.topic || !newRow.funnel) {
      const cat = categorizeKeyword(newRow.keyword);
      newRow.intent = newRow.intent || cat.intent;
      newRow.topic  = newRow.topic  || cat.topic;
      newRow.funnel = newRow.funnel || cat.funnel;
    }
    newRow.frequency = newRow.frequency || 1;
    newRow.adRating  = computeAdRating(newRow);
    reportMap.set(key, newRow);
    return newRow;
  }

  // Duplicate — merge in place. frequency++, keep richer data.
  existing.frequency = (existing.frequency || 1) + 1;

  // When the new row has a BETTER image match, take its image-match data set
  // (image_count, total_thumbs, confidences, matched_* arrays) together.
  // Splitting them across rows would mismatch visibility_pct against the
  // matched-thumbnail list.
  const incomingImg = newRow.image_count          || 0;
  const existingImg = existing.image_count        || 0;
  if (incomingImg > existingImg) {
    existing.image_count          = incomingImg;
    existing.total_thumbs         = newRow.total_thumbs || newRow.totalThumbs || existing.total_thumbs || 0;
    existing.totalThumbs          = existing.total_thumbs;
    existing.match_confidence_max = newRow.match_confidence_max || 0;
    existing.match_confidence_avg = newRow.match_confidence_avg || 0;
    existing.match_confidence_min = newRow.match_confidence_min || 0;
    if (newRow.matchedThumbnails)  existing.matchedThumbnails  = newRow.matchedThumbnails;
    if (newRow.matchedConfidences) existing.matchedConfidences = newRow.matchedConfidences;
    if (newRow.matchedSellers)     existing.matchedSellers     = newRow.matchedSellers;
    if (newRow.matchedPrices)      existing.matchedPrices      = newRow.matchedPrices;
    if (newRow._matchedEmbeddings) existing._matchedEmbeddings = newRow._matchedEmbeddings;
    if (newRow.matchSources)       existing.matchSources       = newRow.matchSources;
    if (newRow.thumbsCaptured)     existing.thumbsCaptured     = newRow.thumbsCaptured;
    if (newRow.serp_url)           existing.serp_url           = newRow.serp_url;
  } else if (!existing.total_thumbs && (newRow.total_thumbs || newRow.totalThumbs)) {
    // First time we see a thumb count for this keyword — adopt it even if
    // the new row didn't beat us on image_count.
    existing.total_thumbs = newRow.total_thumbs || newRow.totalThumbs;
    existing.totalThumbs  = existing.total_thumbs;
  }
  existing.totalSellers = Math.max(existing.totalSellers || 0, newRow.totalSellers || 0);
  existing.adsOnSerp    = Math.max(existing.adsOnSerp || 0,    newRow.adsOnSerp || 0);

  // Source: union all discovery paths so the CSV shows every route the
  // keyword surfaced via ("kp_idea, autosuggest, related_search"). The
  // higher-priority source still wins the parent_keyword slot.
  if (newRow.source && newRow.source !== existing.source) {
    const tokens = new Set(
      String(existing.source || '')
        .split(/\s*,\s*/)
        .map(s => s.trim())
        .filter(Boolean)
    );
    tokens.add(String(newRow.source).trim());
    existing.source = Array.from(tokens).join(', ');
  }
  const existPri = SOURCE_PRIORITY[String(existing.source || '').split(/\s*,\s*/)[0]] || 0;
  const newPri   = SOURCE_PRIORITY[newRow.source]   || 0;
  if (newPri > existPri && newRow.parentKeyword) {
    existing.parentKeyword = newRow.parentKeyword;
  }

  // Union sellers by domain
  existing.sellers = mergeSellers(existing.sellers, newRow.sellers);

  // Take longer thumbnails / autosuggestions arrays
  if ((newRow.matchedThumbnails || []).length > (existing.matchedThumbnails || []).length) {
    existing.matchedThumbnails  = newRow.matchedThumbnails;
    existing.matchedConfidences = newRow.matchedConfidences;
    existing.matchedSellers     = newRow.matchedSellers;
    existing.matchedPrices      = newRow.matchedPrices;
    existing._matchedEmbeddings = newRow._matchedEmbeddings;
  }
  if ((newRow.autosuggestions || []).length > (existing.autosuggestions || []).length) {
    existing.autosuggestions = newRow.autosuggestions;
    existing.autosuggestCount = newRow.autosuggestCount;
  }

  // KP metrics: fill in if missing
  for (const f of ['kpMonthlySearches','kpCompetition','kpBidLow','kpBidHigh']) {
    if (!existing[f] && newRow[f]) existing[f] = newRow[f];
  }

  // Recompute rating after merge
  existing.adRating = computeAdRating(existing);
  return existing;
}

// ============ 1E. handlesToSeeds ============
//
// Returns the user-provided handle seeds, normalised. Splits on , | ; and
// newlines. Converts hyphens (Shopify-style slugs like
// `la-roche-posay-effaclar`) to spaces. No auto-derivation of brandless
// variants — that assumed a single-word brand and produced near-duplicate
// seeds for multi-word brands (e.g. "La Roche Posay" → "Roche Posay …").
// Trust what the user typed.

export function handlesToSeeds(url, handlesString) {
  const seeds = [];

  if (handlesString && typeof handlesString === 'string') {
    const parts = handlesString.split(/[,|;\r\n]/).map(p => p.trim()).filter(Boolean);
    for (const p of parts) {
      seeds.push(p.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim());
    }
  }

  // Fallback: derive ONE seed from the URL path /products/<handle> when no
  // explicit handles were provided in the CSV.
  if (seeds.length === 0 && url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/products\/([^/?#]+)/);
      if (m && m[1]) {
        seeds.push(m[1].replace(/-+/g, ' ').replace(/\s+/g, ' ').trim());
      }
    } catch {}
  }

  // Dedupe + cap at 4.
  const out = [];
  const seen = new Set();
  for (const s of seeds) {
    const key = s.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

// True when `candidate` is essentially the same query as one of `existing`
// (>=70 % token overlap, ignoring case and order). Used by the engine to
// skip a handle seed that would duplicate the auto-derived kpSeed.
export function seedsAreSimilar(candidate, existing) {
  const toks = (s) => new Set(
    String(s).toLowerCase().split(/\s+/).filter(t => t.length >= 3)
  );
  const a = toks(candidate);
  if (a.size === 0) return false;
  for (const e of existing) {
    const b = toks(e);
    if (b.size === 0) continue;
    let overlap = 0;
    for (const t of a) if (b.has(t)) overlap++;
    const ratio = overlap / Math.min(a.size, b.size);
    if (ratio >= 0.7) return true;
  }
  return false;
}

// Selects up to `maxSeeds` distinct KP seeds from a candidate list. When two
// Only EXACT duplicates (case-insensitive) are skipped. Substring / token-
// overlap dedup was removed: two handles for the same product ("NOW Foods
// Super Enzymes" vs "NOW Foods Super Enzymes Digestive Support Supplement")
// return DIFFERENT KP idea sets — KP weighs every token, so the longer form
// surfaces long-tail variants the shorter form misses. The extra KP runs
// (typically 2–3 seeds per product) are worth the keyword diversity.
export function selectKpSeeds(candidates, maxSeeds = 3) {
  const kept = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of candidates || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) { skipped.push(text); continue; }
    seen.add(key);
    kept.push(text);
  }

  return {
    seeds: kept.slice(0, maxSeeds),
    skipped,
  };
}

// ============ 1F. Product-relevance gate ============
//
// `shouldKeepKeyword` is product-agnostic (India / English / noise / UI
// literals). It can't tell that "how long does it take to sprout alfalfa
// seeds" is irrelevant to a "NOW Foods Alfalfa supplement" listing.
//
// `isRelevantToProduct` adds that product-aware judgement. It runs AFTER
// shouldKeepKeyword and BEFORE a keyword enters the SERP queue. The engine
// builds a `productContext` once per product (brand + product type +
// detected category) and passes it in here.

// ============ Form factors ============
//
// Every physical product has a FORM — tablet, cream, shampoo, etc. A keyword
// that mentions the WRONG form (e.g. "alfalfa powder price" when we sell
// alfalfa TABLETS) is about a different product entirely. We extract the
// form from the raw product name at context-build time and use it to
// reject wrong-form queries before they reach a SERP.
//
// Singular base forms only; the matcher handles regular and -y/-ies plurals.
const ALL_FORM_FACTORS = {
  supplement: [
    'tablet','capsule','softgel','pill','powder','liquid','drop','gummy',
    'chewable','lozenge','seed','tea','tincture','extract','oil','syrup','spray',
    // Indian-market homeopathic / ayurvedic forms — distinct products that
    // share the same active ingredient names ("Alfalfa Q", "Alfalfa Malt").
    'malt','tonic','mt',
  ],
  skincare: [
    'cream','lotion','serum','gel','oil','balm','ointment','spray','foam',
    'mist','mask','peel','patch','stick','butter','milk','essence','ampoule',
    'emulsion','toner','cleanser','wash','scrub','exfoliant','wipe',
  ],
  haircare: [
    'shampoo','conditioner','oil','serum','mask','spray','gel','cream',
    'mousse','foam','wax','paste','pomade',
  ],
  bodycare: [
    'wash','lotion','cream','gel','oil','butter','scrub','soap','spray',
    'deodorant','antiperspirant','stick',
  ],
  food: [
    'powder','bar','shake','tablet','capsule','tea','liquid','syrup','oil','butter',
  ],
  general: [],
};

function _formRegex(formBase) {
  // Build a word-boundary regex that matches both singular and plural forms.
  // Handles regular (cream/creams) and -y → -ies (gummy/gummies, berry/berries).
  let plural;
  if (formBase.endsWith('y')) plural = formBase.slice(0, -1) + 'ies';
  else plural = formBase + 's';
  return new RegExp(`\\b(?:${formBase}|${plural})\\b`, 'i');
}

// Look at the RAW product name and return the form factor it advertises, if
// any. Always pass the RAW name (still carries "Tablets" / "Cream" / etc.);
// the cleaned name has those tokens stripped by simplifyForKP.
//
// Two passes:
//   1. Standard word-boundary match for "250 tablets" / "500ml" / etc.
//   2. Concatenated-digit fallback for "250tablets" / "650mg" — digits and
//      letters are both \w chars so the standard \b regex doesn't fire
//      between them. We accept a digit-prefix or any non-letter prefix.
function _digitPrefixRegex(formBase) {
  let plural;
  if (formBase.endsWith('y')) plural = formBase.slice(0, -1) + 'ies';
  else plural = formBase + 's';
  // (?<=\d)tablets? would be cleanest but lookbehind support is patchy in
  // older engines — use a non-capturing alternation that requires a digit
  // immediately before the form word.
  return new RegExp(`\\d(?:${formBase}|${plural})\\b`, 'i');
}

// Dosage forms ranked HIGHEST — these are what the product physically IS.
// Standalone product forms (oil, cream, etc.) are secondary because they
// often describe an INGREDIENT in a dosage-form product ("fish oil 200
// softgels" — the product is a softgel, not an oil).
const _DOSAGE_FORMS = ['softgel', 'capsule', 'tablet', 'caplet', 'lozenge', 'gummy', 'chewable', 'pill'];
// "oil" needs special handling because it appears as an ingredient name
// in many supplements. Reject "oil" as the form factor when it follows
// fish/cod/krill/flax/essential/coconut/olive/castor — those are oil
// INGREDIENTS in a softgel/capsule, not "oil" the form factor.
// Oil-as-ingredient context — when "oil" follows one of these words it's
// describing the ACTIVE INGREDIENT in a dosage-form product (a softgel /
// capsule of fish oil), not the form factor. Without this guard,
// "Now Foods Fish Oil 200 Softgels" gets form=oil instead of form=softgel.
// "Baby Oil" / "Hair Oil" / "Body Oil" are NOT in this list — those are
// product-form names where oil IS the form.
const _OIL_INGREDIENT_RE = /\b(?:fish|cod|krill|flax|flaxseed|essential|coconut|olive|castor|jojoba|argan|borage|primrose|hemp|almond|avocado|rosemary|sunflower|sesame|mustard|peanut|soybean|palm|canola|vegetable|mineral|motor|engine|cooking|safflower|grapeseed|walnut|tea\s+tree|black\s+seed|black\s+cumin|moringa|emu|salmon|liver|cbd|hempseed)\s+oil\b/i;

export function extractFormFactor(rawProductName, category) {
  const name = String(rawProductName || '').toLowerCase();
  if (!name) return null;
  const forms = ALL_FORM_FACTORS[category] || ALL_FORM_FACTORS.general;

  // Pass 1: dosage forms with a count prefix ("200 softgels", "60 capsules").
  // This is the most reliable signal of what the product physically is.
  for (const form of _DOSAGE_FORMS) {
    if (!forms.includes(form)) continue;
    const countPrefixed = new RegExp(`\\b\\d+\\s*(?:${form}|${form}s)\\b`, 'i');
    if (countPrefixed.test(name)) return form;
  }
  // Pass 2: standalone dosage form mention ("Softgels", "Capsules").
  for (const form of _DOSAGE_FORMS) {
    if (!forms.includes(form)) continue;
    if (_formRegex(form).test(name)) return form;
  }
  // Pass 3: product forms (cream, lotion, oil, etc.) — but guard "oil"
  // against ingredient-mode usage ("fish oil 200 softgels" should not
  // be classified as form=oil).
  for (const form of forms) {
    if (_DOSAGE_FORMS.includes(form)) continue;
    if (form === 'oil' && _OIL_INGREDIENT_RE.test(name)) continue;
    if (_formRegex(form).test(name)) return form;
  }
  // Pass 4: digit-prefixed concatenated form ("250tablets", "60capsules").
  for (const form of forms) {
    if (_digitPrefixRegex(form).test(name)) return form;
  }
  return null;
}

// If `keyword` mentions a form that's NOT our product's form (and doesn't
// also mention our form, which would be a comparison query), return a short
// reason string like "powder ≠ tablet"; otherwise return null. The engine
// uses this both as a relevance gate AND to enrich the rejection log.
export function getWrongFormReason(keyword, productContext) {
  if (!productContext) return null;
  const correctForm = productContext.formFactor;
  if (!correctForm) return null; // no form detected for product → can't filter
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return null;

  // If the keyword also mentions OUR form, it's a comparison query
  // ("alfalfa tablets vs capsules") — keep it. Check both the standard
  // word-boundary form AND the concatenated digit-prefix form.
  if (_formRegex(correctForm).test(kw)) return null;
  if (_digitPrefixRegex(correctForm).test(kw)) return null;

  const forms = ALL_FORM_FACTORS[productContext.category] || ALL_FORM_FACTORS.general;
  for (const form of forms) {
    if (form === correctForm) continue;
    if (_formRegex(form).test(kw)) return `${form} ≠ ${correctForm}`;
    if (_digitPrefixRegex(form).test(kw)) return `${form} ≠ ${correctForm}`;
  }
  return null;
}

const CATEGORY_TERMS = {
  supplement: ['supplement','supplements','tablets','tablet','capsules','capsule',
               'pills','pill','softgel','softgels','vitamins','vitamin',
               'extract','powder','herbal','dietary','nutraceutical','mg','iu'],
  skincare:   ['cream','lotion','serum','moisturizer','moisturiser','cleanser',
               'face wash','sunscreen','toner','mask','exfoliator','eye cream',
               'spf','retinol','niacinamide','hyaluronic'],
  haircare:   ['shampoo','conditioner','hair oil','hair mask','hair serum',
               'hair fall','anti dandruff','hair growth'],
  bodycare:   ['body wash','body lotion','body cream','shower gel','deodorant',
               'body oil','hand cream','foot cream'],
  food:       ['protein','whey','meal replacement','energy bar','granola',
               'muesli','peanut butter','honey','seeds','nuts'],
  general:    [],
};

export function detectCategory(productType, productName) {
  const text = `${productType || ''} ${productName || ''}`.toLowerCase();
  // `s?` on every form word so "Capsules", "Tablets", "Supplements" — the
  // typical plural spelling on a product title — match the same as the
  // singular. Without this, `\bcapsule\b` failed against "90 Capsules"
  // and the product fell through to category='general', which in turn
  // killed extractFormFactor (ALL_FORM_FACTORS.general = []) and the
  // wrong-audience filter (gated on supplement/health/skincare).
  if (/\b(tablets?|capsules?|softgels?|supplements?|vitamins?|enzymes?|probiotics?|extracts?|herbals?|\d+\s*mg|\d+\s*mcg|\d+\s*iu|dosage|digestive|immune|antioxidant)\b/.test(text)) return 'supplement';
  // Skincare: includes ointment/balm/petroleum-jelly family (Aquaphor,
  // Vaseline, A+D Ointment) — these were falling to 'general' because
  // the previous regex only listed cream/lotion/serum. Also include
  // "skin protectant", "diaper rash" (Aquaphor Baby, Desitin, Boudreaux's),
  // "healing ointment", "skin care".
  if (/\b(creams?|lotions?|serums?|moisturiz|cleansers?|face wash|sunscreens?|toners?|spf|retinol|ointments?|balms?|salves?|petroleum jelly|skin protectants?|diaper rash|healing|skin care)\b/.test(text)) return 'skincare';
  if (/\b(shampoos?|conditioners?|hair oils?|hair masks?|hair serums?|anti.?dandruff)\b/.test(text)) return 'haircare';
  if (/\b(body wash|body lotions?|shower gel|deodorants?|body oils?)\b/.test(text)) return 'bodycare';
  if (/\b(proteins?|whey|granolas?|muesli|peanut butter|energy bars?)\b/.test(text)) return 'food';
  return 'general';
}

// Multi-word brand suffixes — when the second word of the handle is one of
// these, treat the first two words as the brand (e.g. "now foods alfalfa"
// -> brand="now foods", product="alfalfa"). This is a small linguistic list,
// NOT a brand database — it captures how brands construct their names. Any
// brand not matched here falls back to "first word = brand".
const BRAND_SUFFIXES = [
  'foods','labs','laboratories','naturals','essentials','nutrition',
  'cosmetics','company','co','inc','beauty','organics','pharma',
];

export function buildProductContext(productName, handles, detectedCategory, explicitBrand) {
  // Source preference: handle (cleanest, slug-style) → product name → empty.
  const primaryHandle = (handles ? String(handles).split(/[,|;]/)[0] : '')
    .trim()
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const baseSource = primaryHandle || String(productName || '').toLowerCase().trim();
  const words = baseSource.split(/\s+/).filter(w => w.length > 1);

  let brandName = '';
  let productType = '';
  const first1 = words[0] || '';
  const second = words[1] || '';

  // Explicit brand from the input file wins over heuristic detection. Handles
  // multi-word brands the suffix list doesn't cover ("La Roche-Posay", "The
  // Ordinary", "Mary Kay") and prevents the first-word-of-slug fallback from
  // mis-classifying. Normalise to lowercase + collapse whitespace + drop
  // punctuation that won't appear in token-matched SERP text.
  const normalisedExplicit = String(explicitBrand || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalisedExplicit) {
    brandName = normalisedExplicit;
    // Strip every brand token (handles "la roche-posay" → strip la, roche,
    // posay, roche-posay) from the words list to derive the product type.
    const brandTokenSet = new Set([
      ...normalisedExplicit.split(/[\s-]+/).filter(Boolean),
      normalisedExplicit.replace(/[\s-]+/g, ''),
      normalisedExplicit.replace(/\s+/g, '-'),
    ]);
    productType = words.filter(w => !brandTokenSet.has(w) && !brandTokenSet.has(w.replace(/-/g, ''))).join(' ');
  } else if (BRAND_SUFFIXES.includes(second)) {
    // 2-word brand iff second word is a known brand-suffix construction
    // ("Now Foods", "Forest Essentials", "Garden Naturals").
    brandName = `${first1} ${second}`;
    productType = words.slice(2).join(' ');
  } else {
    brandName = first1;
    productType = words.slice(1).join(' ');
  }

  // Strip size/quantity tokens from product type
  productType = productType
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|iu|g|gm|kg|ml|l|oz|lb|tablets?|capsules?|softgels?|pills?|count|pcs?)\b/gi, '')
    .replace(/\b\d+\s*-?\s*pack\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  if (!productType && words.length > 1) {
    productType = words.find(w => w !== brandName && w.length > 3) || words[1] || '';
  }

  // Anchor words: core product words from the handle (everything that isn't
  // brand), length > 3. Used by isRelevantToProduct to require that a
  // non-branded keyword actually mentions OUR product, not just our
  // category. Without this, "Alpha powder" passes a supplement filter
  // because "powder" is a category term.
  const brandTokens = new Set(brandName.split(/\s+/).filter(Boolean));
  const handleWords = words
    .filter(w => !brandTokens.has(w) && w.length > 3)
    .map(w => w.replace(/\b\d+(?:\.\d+)?\b/g, '').trim())
    .filter(Boolean);

  // Brand aliases — different spellings users actually search.
  const brandAliases = new Set();
  if (brandName) {
    brandAliases.add(brandName);
    if (brandName.includes(' ')) {
      brandAliases.add(brandName.replace(/\s+/g, ''));
      brandAliases.add(brandName.split(/\s+/)[0]);
    }
  }

  const category = detectedCategory || detectCategory(productType, productName);
  // Form factor must come from the RAW product name — `simplifyForKP`
  // strips "Tablets" / "Cream" / "Shampoo" before we get here, so by this
  // point `productName` (cleaned form) may not carry the cue anymore.
  // The harness will also call extractFormFactor directly with the raw
  // name and override this when needed.
  const formFactor = extractFormFactor(productName, category);
  // Core type words = product-identity discriminator. First 2 words of
  // productType (after brand + size strip). "super enzymes digestive
  // support" → ["super","enzymes"]; "alfalfa" → ["alfalfa"]; "vitamin c"
  // → ["vitamin","c"]. Used by checkProductIdentity to enforce that ALL
  // discriminator words appear in a SERP context — single-word _hasAnchor
  // would otherwise accept "now foods PLANT enzymes" as our "Super Enzymes"
  // product because "enzymes" alone matched. Cap at 2 to avoid false
  // negatives from tagline tokens ("digestive", "support") that most ad
  // copy omits.
  const coreTypeWords = productType
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return {
    brandName,
    productType,
    coreTypeWords,
    category,
    categoryTerms: CATEGORY_TERMS[category] || CATEGORY_TERMS.general,
    brandAliases: Array.from(brandAliases).filter(Boolean),
    handleWords,
    formFactor,
  };
}

// Universal product-relevance rule:
//
//   Keep a keyword iff
//     it mentions OUR brand, OR
//     it mentions BOTH a product "anchor" word from the handle AND a
//       category term.
//
// Category term alone is too broad: "Alpha powder" passes a supplement
// category check ("powder" is a supplement term) even though it's a totally
// different product. The anchor-word requirement (one of OUR product's core
// handle words) closes that hole without resorting to product-specific
// blocklists.
//
// No product-specific noise lists — any "drift" list ("hay", "pellets",
// "tea", "for dogs") will block legitimate keywords for a different product
// where the same word is a positive signal.

// Common English words that happen to be brand names. Short forms of these
// brands MUST appear as the full multi-word brand to count — "now" alone
// matches "now what", "for now", "right now". Require "now foods".
const _BRAND_COMMON_WORDS = new Set([
  'now','go','one','yes','life','pure','real','best','good','new','big',
  'max','pro','plus','elite','prime','top','red','blue','green','black',
  'white','gold','silver','star','core','base','full','smart','simple',
  'easy','old','young','hot','cool','soft','hard','wild','free','clean',
]);

function _hasBrandSubstr(kw, brandAliases) {
  return (brandAliases || []).some(alias => {
    if (!alias) return false;
    if (alias.length <= 2) return false;            // way too short
    // Single-token common-English aliases (e.g. "now", "life") only count
    // when they appear as the FULL brand — so we never count "now" alone.
    if (!alias.includes(' ') && _BRAND_COMMON_WORDS.has(alias)) return false;
    // Short aliases (≤ 4 chars) need a word-boundary match — substring
    // would catch "samsungs" or "lg" inside "kellogg".
    if (alias.length <= 4) {
      try {
        const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${esc}\\b`, 'i').test(kw);
      } catch { return false; }
    }
    // Long aliases — substring is safe (low collision risk).
    return kw.includes(alias);
  });
}

// Contextual brand match for common-word aliases. When the keyword contains
// a common-word alias (e.g. "now") AND an anchor word adjacent to it
// (within 2 word positions) AND a category term, treat it as a brand hit.
// "now alfalfa tablets" → "now" (common alias) + "alfalfa" (anchor at pos 1)
// + "tablets" (category) → contextual brand match. "alfalfa now Little
// Rascals" lacks a category term, so common-word "now" doesn't qualify.
function _hasContextualBrand(kw, brandAliases, handleWords, categoryTerms) {
  const aliases = (brandAliases || []).filter(a => a && !a.includes(' ') && _BRAND_COMMON_WORDS.has(a));
  if (aliases.length === 0) return false;
  if (!_hasCategoryTerm(kw, categoryTerms)) return false;
  const words = kw.split(/\s+/);
  const anchors = (handleWords || []).filter(w => w && w.length > 3);
  for (const alias of aliases) {
    const aliasIdx = words.indexOf(alias);
    if (aliasIdx < 0) continue;
    for (const hw of anchors) {
      const hwIdx = words.findIndex(w => w === hw || w.startsWith(hw));
      if (hwIdx >= 0 && Math.abs(hwIdx - aliasIdx) <= 2) return true;
    }
  }
  return false;
}

function _hasAnchor(kw, handleWords) {
  return (handleWords || []).some(word => {
    if (!word || word.length <= 3) return false;
    return kw.includes(word);
  });
}

function _hasCategoryTerm(kw, categoryTerms) {
  return (categoryTerms || []).some(term => {
    if (!term || term.length <= 2) return false;
    try {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}`, 'i').test(kw);
    } catch {
      return kw.includes(term);
    }
  });
}

// Classify a keyword into a tier and decide BOTH whether it deserves a SERP
// load AND whether it should expand into leaf SERPs:
//
//   tier "brand_product"   brand + anchor word  → SERP + always expand
//                          "now foods alfalfa tablets price"
//   tier "brand_other"     brand only, no anchor → STORE (no SERP)
//                          "now foods vitamin c"  — sibling brand product
//   tier "generic_product" anchor + category    → SERP, image-match decides expand
//                          "alfalfa tablets price"
//   tier "anchor_only"     anchor only          → SERP, image-match decides expand
//                          "best alfalfa 650mg"
//   reject "wrong_form"    form factor mismatch (powder vs tablet, etc.)
//   reject "category_only" only category term — too generic, would match competitors
//   reject "no_signals"    no brand, no anchor, no category
//
// `loadSERP` says "should we spend a SERP load on this?", `expand` says "if
// it succeeds, should leaves be queued?" — `true` (always), `match_decides`
// (only if image matched), or `false`.
// Homeopathic potency markers ("Alfalfa Q", "Arnica 30C", "Belladonna 200C",
// "biochemic", "mother tincture"). These describe a SPECIFIC product line
// that shares an ingredient name with our product but is a different SKU
// entirely. Apply only when we're a supplement and NOT already a tincture.
const _HOMEOPATHIC_RE = /\b(mother\s+tincture|biochemic|homeopath|homoeopath|\d+\s?[xc]\b|\bq\b)/i;

// Veterinary / animal-audience queries — disqualifying for human-consumer
// categories. Phrasing is intentionally loose: "for dogs", "dog supplement",
// "veterinary biotin" all read as wrong-audience for a human supplement.
const _WRONG_AUDIENCE_RE = /\b(for\s+(dogs?|cats?|pets?|horses?|cattle|livestock|puppies|kittens|birds?|fish|rabbits?)|(?:dog|cat|pet|horse|cattle|livestock|puppy|kitten|bird|rabbit)\s+(?:supplement|food|chew|treat|shampoo|conditioner)|veterinary|vet\s+(?:supplement|grade|formula))\b/i;
const _WRONG_AUDIENCE_CATEGORIES = new Set(['supplement', 'health', 'skincare', 'haircare']);

// Product-line modifiers. When one of these appears in a KEYWORD but is
// absent from our product's name, it almost always names a SIBLING product
// from the same brand. Example: our product = "Now Foods Omega 3 Fish Oil";
// keyword = "now foods ULTRA omega 3" — same brand, same anchor tokens
// (omega, 3, fish, oil) all present, but "Ultra Omega 3" is a different
// formulation (different EPA/DHA ratio, different bottle, different price).
// The identity check at the IMAGE layer catches the wrong-product image,
// but at the keyword layer this rejects the wasted SERP load too.
//
// The "in keyword AND NOT in product name" rule handles the tricky case
// of products where the modifier IS the product line ("Super Enzymes" —
// `super` is in productType, so keywords containing "super enzymes" pass).
const _PRODUCT_LINE_MODIFIERS = [
  'ultra', 'super', 'mega',
  'double strength', 'triple strength', 'extra strength', 'high potency',
  'enteric coated', 'time release', 'sustained release', 'slow release',
  'sport', 'premium', 'max', 'pro', 'plus', 'advanced',
  'gold', 'platinum', 'elite', 'prime',
  'mini', 'junior', 'kids', 'children',
  'liquid', 'gummies', 'chewable', 'powder',
];
const _PRODUCT_LINE_MODIFIER_RES = _PRODUCT_LINE_MODIFIERS.map(m => ({
  text: m,
  re:   new RegExp(`\\b${m.replace(/\s+/g, '\\s+')}\\b`, 'i'),
}));

// Returns { match: true, modifier } when `text` contains a modifier the
// product itself doesn't use; null otherwise.
export function checkProductLineModifier(text, productContext) {
  if (!productContext) return null;
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  const ourName = `${productContext.productType || ''} ${productContext.fullProductName || ''}`.toLowerCase();
  for (const { text: modText, re } of _PRODUCT_LINE_MODIFIER_RES) {
    if (re.test(haystack) && !re.test(ourName)) {
      return { match: true, modifier: modText };
    }
  }
  return null;
}

// ============ Shade / model name swap (scoped to cosmetics) ============
// Catches keywords that swap a SHADE or MODEL name on the same product
// line — "Maybelline 80 Ruler" product, keyword "maybelline 20 Pioneer".
// The classic identity / line / sibling layers can't catch this because
// both shade names ARE legitimate words in the product line; the question
// is whether the right one is referenced.
//
// The rule is dangerous when applied broadly — supplements / generic
// retail keywords routinely add commerce/intent words ("amazon", "price
// india", "review", "side effects") that look like "new" name tokens.
// Two safeguards:
//   1. Only fire on cosmetics-style products (lipstick / foundation /
//      mascara / nail polish / etc.). Detected from productType keywords.
//   2. Strict trigger: ≥2 extra-in-keyword AND ≥2 missing-from-keyword
//      meaningful tokens, AFTER filtering a protected commerce/intent
//      vocabulary. A 1+1 trigger over-rejects.
const _COSMETICS_FORMS = new Set([
  'lipstick', 'lip', 'gloss', 'foundation', 'mascara', 'eyeliner', 'eye',
  'blush', 'bronzer', 'highlighter', 'concealer', 'primer', 'powder',
  'eyeshadow', 'shadow', 'liner', 'pencil', 'tint', 'stain',
  'nail', 'polish', 'lacquer', 'gel',
  'palette', 'kit',
]);

function _isShadeVariantProduct(productContext) {
  if (!productContext) return false;
  const text = `${productContext.productType || ''} ${productContext.fullProductName || ''}`.toLowerCase();
  if (!text) return false;
  for (const w of text.split(/[\s,/.()&-]+/)) {
    if (_COSMETICS_FORMS.has(w)) return true;
  }
  return false;
}

// Protected vocabulary: commerce / geo / intent words that legitimately
// appear in keyword expansions and should NEVER be counted as "extra name
// tokens" that imply a shade swap. Expandable without code change — add
// strings here as you discover legitimate keywords falsely rejected.
const _NAMESWAP_PROTECTED = new Set([
  // Marketplaces
  'amazon', 'flipkart', 'iherb', 'nykaa', 'myntra', 'ajio', 'meesho',
  '1mg', 'pharmeasy', 'apollo', 'tata', 'cliq', 'shopify', 'walmart',
  'target', 'sephora', 'ulta', 'boots', 'cvs', 'rite',
  // Geo qualifiers
  'india', 'usa', 'uk', 'online', 'near', 'me', 'in', 'shop',
  'delivery', 'shipping', 'available', 'store',
  // Intent / info words
  'review', 'reviews', 'rating', 'ratings', 'price', 'cost', 'buy',
  'best', 'top', 'cheapest', 'discount', 'offer', 'deal', 'coupon',
  'sale', 'free', 'shipping',
  'vs', 'versus', 'compared', 'comparison', 'alternative',
  'side', 'effects', 'effect', 'benefits', 'benefit', 'uses', 'use',
  'usage', 'dosage', 'dose', 'how', 'when', 'why', 'what',
  'ingredients', 'composition', 'safety', 'safe',
  // Common modifiers / fillers that aren't cosmetic identity markers
  'original', 'authentic', 'genuine', 'new', 'latest',
  'set', 'combo', 'pack', 'pack of', 'box',
  // Common audience words
  'women', 'men', 'girls', 'boys', 'ladies',
  // Numeric noise (parsed elsewhere; not identity)
  'pcs', 'qty', 'piece', 'pieces',
]);

function _meaningfulTokens(text, ourBrand) {
  if (!text) return [];
  let t = String(text).toLowerCase();
  // Strip brand
  if (ourBrand) {
    for (const b of ourBrand.toLowerCase().split(/\s+/)) {
      if (b.length > 1) {
        t = t.replace(new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
      }
    }
  }
  // Strip number+unit specs (parsed at the spec layer, not identity).
  t = t.replace(/\b\d+\.?\d*\s*(mg|mcg|µg|iu|ui|ml|fl\s*oz|oz|l|g|gm|kg|lb|gb|tb|w|mah|epa|dha|spf|softgel|capsule|tablet|caplet|gummy|count|ct|pcs?|pack)s?\b/gi, ' ');
  // Strip bare numbers.
  t = t.replace(/\b\d+\b/g, ' ');
  // Tokenise.
  return t.split(/[\s,/.()&-]+/).filter(w => w.length > 1 && !_NAMESWAP_PROTECTED.has(w));
}

// Returns { match, extras, missing } when keyword/context looks like a
// shade / model name swap on a cosmetics product. null otherwise.
//
// Trigger: ≥2 meaningful tokens in text that aren't in our name AND ≥2
// meaningful tokens in our name that aren't in the text. Both sides need
// "real swap" evidence to avoid rejecting legit commerce keywords.
export function checkNameSwap(text, productContext) {
  if (!productContext) return null;
  if (!_isShadeVariantProduct(productContext)) return null;
  const haystack = String(text || '');
  if (!haystack) return null;
  const ourName = `${productContext.productType || ''} ${productContext.fullProductName || ''}`;
  const ourBrand = productContext.brandName || '';
  const ourTokens = new Set(_meaningfulTokens(ourName, ourBrand));
  if (ourTokens.size < 2) return null; // not enough product-identity vocabulary to compare
  const theirTokens = new Set(_meaningfulTokens(haystack, ourBrand));
  if (theirTokens.size === 0) return null;
  const extras = [...theirTokens].filter(w => !ourTokens.has(w));
  const missing = [...ourTokens].filter(w => !theirTokens.has(w));
  if (extras.length >= 2 && missing.length >= 2) {
    return {
      match: true,
      extras: extras.slice(0, 4),
      missing: missing.slice(0, 4),
    };
  }
  return null;
}

// ============ Color conflict ============
// For products that exist in multiple colors / shades (cosmetics, apparel,
// electronics, footwear, hair color, nail polish), a different color name
// in the keyword/context indicates a different SKU even when brand +
// identity + form all match.
//
// Symmetric rule: only fires when BOTH our product name AND the text
// contain at least one color, AND none of the text's colors are in our
// product's color set. A multi-color page that includes our color
// alongside others doesn't trigger (ours is present).
const _COLOR_WORDS = new Set([
  // Primary + secondary
  'red','blue','green','black','white','pink','purple','violet','orange','yellow',
  'brown','grey','gray','beige','ivory','tan',
  // Tints / shades
  'nude','coral','berry','mauve','burgundy','wine','rose','lilac','lavender',
  'crimson','scarlet','navy','teal','turquoise','maroon','peach','plum','cherry',
  'chocolate','caramel','honey','amber','rust','sage','olive','mint','aqua',
  'indigo','magenta','fuchsia','champagne','taupe','charcoal','onyx','pearl',
  // Metals
  'silver','gold','titanium','bronze','copper','platinum',
  // Hair-color terms
  'blonde','brunette','auburn',
]);

// Returns { match, ours, theirs } when text names a color our product
// doesn't use; null otherwise.
export function checkColorConflict(text, productContext) {
  if (!productContext) return null;
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  const ourText = `${productContext.productType || ''} ${productContext.fullProductName || ''}`.toLowerCase();
  if (!ourText) return null;

  // Cache our colors on the context — same idea as the slot-words cache.
  let ourColors = productContext._colorWords;
  if (!ourColors) {
    ourColors = new Set();
    for (const w of ourText.split(/[\s,/.()&-]+/)) {
      if (_COLOR_WORDS.has(w)) ourColors.add(w);
    }
    productContext._colorWords = ourColors;
  }
  if (ourColors.size === 0) return null; // not a color-variant product

  const theirColors = new Set();
  for (const w of haystack.split(/[\s,/.()&-]+/)) {
    if (_COLOR_WORDS.has(w)) theirColors.add(w);
  }
  if (theirColors.size === 0) return null; // text doesn't mention a color
  // If any of the text's colors matches ours, it's a same-color (or
  // multi-variant page); not a conflict.
  for (const c of theirColors) if (ourColors.has(c)) return null;
  // Otherwise: text named at least one color, none ours.
  const theirsArr = Array.from(theirColors);
  return {
    match: true,
    ours: Array.from(ourColors).join('/'),
    theirs: theirsArr[0],
  };
}

// ============ Variant slot conflicts ============
// Many same-brand SKUs differ on a SINGLE qualifier word that names a
// product-line slot: day vs night, AM vs PM, men vs women, adult vs baby,
// regular vs sensitive, dry vs oily, wired vs wireless, matte vs glossy,
// scented vs unscented. Bottles look near-identical (so CLIP can't tell
// them apart), brand and core anchor match, and the only differentiator
// is which side of the pair the keyword/context names.
//
// These pairs are explicitly catalogued — not auto-detected — because:
//   • They're universal across categories (skincare, supplements, food,
//     electronics, personal care all use these splits).
//   • Auto-detection from product name + filler-list is brittle; explicit
//     pairs let the engine reason about "if product is A, text saying B is
//     a wrong-SKU signal".
// Pairs are symmetric: each pair is checked both directions.
const _VARIANT_SLOT_PAIRS = [
  // Time of day / use-cycle
  ['day', 'night'],
  ['am', 'pm'],
  ['morning', 'evening'], ['morning', 'night'],
  // Demographic
  ['men', 'women'], ['man', 'woman'], ['male', 'female'],
  ['boys', 'girls'],
  ['adult', 'baby'], ['adult', 'kids'], ['adult', 'children'], ['adult', 'infant'],
  ['adult', 'junior'],
  // Skin / formulation profile
  ['regular', 'sensitive'], ['normal', 'sensitive'],
  ['dry', 'oily'], ['dry', 'combination'], ['dry', 'normal'],
  ['gentle', 'deep'], ['mild', 'strong'], ['light', 'rich'],
  ['oil-free', 'moisturizing'], ['matte', 'glossy'], ['matte', 'satin'],
  ['scented', 'unscented'], ['fragranced', 'unscented'],
  ['original', 'sensitive'], ['classic', 'sensitive'],
  // Temperature / season
  ['hot', 'cold'], ['warm', 'cool'], ['summer', 'winter'],
  // Use context
  ['indoor', 'outdoor'],
  ['travel', 'home'],
  // Connectivity
  ['wired', 'wireless'], ['bluetooth', 'wired'],
  // Cosmetics / nail polish / lipstick formulations
  ['gel', 'lacquer'], ['gel', 'cream'], ['gel', 'liquid'],
  ['matte', 'vinyl'], ['matte', 'glossy'], ['matte', 'satin'],
  ['cream', 'liquid'],
  // Hair color / type
  ['permanent', 'semi-permanent'], ['permanent', 'temporary'],
];

// Build a per-product set of "our qualifier words" so checkVariantSlot can
// determine, for each pair, which side IS ours. Words come from
// productType + fullProductName, lowercased, broken on whitespace, with
// punctuation stripped.
function _ourSlotWords(productContext) {
  const text = `${productContext?.productType || ''} ${productContext?.fullProductName || ''}`.toLowerCase();
  return new Set(text.split(/[\s,/.()&-]+/).filter(Boolean));
}

// Returns { match, ours, theirs } when text names the OPPOSITE side of a
// pair our product is on; null otherwise. Word-boundary regex against the
// candidate text — multi-word entries (none currently, but kept for
// future) get whitespace-collapsing.
export function checkVariantSlot(text, productContext) {
  if (!productContext) return null;
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  const ourWords = productContext._slotWords || _ourSlotWords(productContext);
  if (!productContext._slotWords) productContext._slotWords = ourWords;
  for (const [a, b] of _VARIANT_SLOT_PAIRS) {
    const ourSideA = ourWords.has(a);
    const ourSideB = ourWords.has(b);
    if (ourSideA === ourSideB) continue; // either both or neither — pair doesn't apply
    const ours    = ourSideA ? a : b;
    const theirs  = ourSideA ? b : a;
    const re = new RegExp(`\\b${theirs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(haystack)) return { match: true, ours, theirs };
  }
  return null;
}

// ============ Brand-family sibling exclusions ============
// Big brands (Now Foods, CeraVe, Aveeno, Johnson's, Cetaphil) sell dozens
// of products that share packaging aesthetics so closely CLIP can't tell
// them apart (CLIP scores 88-97 on visually-near-identical bottles of
// completely different SKUs). Text-based veto is the only defense.
//
// buildSiblingExclusions analyses the product name and returns a list of
// terms that, if present in a SERP context or keyword, indicate a SIBLING
// product (same brand, different SKU). Three families of exclusion:
//   • form-alternatives — when our product is a softgel, terms like
//     "tablet" / "capsule" / "gummy" / "cream" / "lotion" mark a sibling
//   • brand-family patterns — hand-encoded for common product families
//     ("3-6-9" / "dha-1000" / "mini gel" / "red omega" for Omega 3 line;
//     "AM" / "PM" / "SA" for CeraVe; etc.)
//   • product-name antonyms — auto-derived; if our name says "regular",
//     siblings include "advanced", "ultra", "premium", etc.
//
// All terms are filtered against the product name BEFORE inclusion — if
// the name itself contains the term, it's the product line and we don't
// exclude. The terms map nicely onto the same word-boundary regex used
// by checkProductLineModifier.

// Sibling form alternatives: when our form is X, presence of Y in a
// keyword/context indicates a different SKU from the same brand.
const _FORM_SIBLINGS = {
  softgel:  ['tablet', 'capsule', 'gummy', 'gummies', 'chewable', 'chew', 'liquid', 'powder', 'spray', 'drops', 'cream', 'lotion', 'serum'],
  capsule:  ['tablet', 'softgel', 'gummy', 'gummies', 'chewable', 'chew', 'liquid', 'powder', 'spray', 'drops', 'cream', 'lotion', 'serum'],
  tablet:   ['softgel', 'capsule', 'gummy', 'gummies', 'chewable', 'chew', 'liquid', 'powder', 'spray', 'drops', 'cream', 'lotion', 'serum'],
  pill:     ['softgel', 'capsule', 'tablet', 'gummy', 'liquid', 'powder'],
  gummy:    ['softgel', 'capsule', 'tablet', 'liquid', 'powder'],
  powder:   ['softgel', 'capsule', 'tablet', 'liquid', 'gummy', 'oil'],
  liquid:   ['softgel', 'capsule', 'tablet', 'gummy', 'powder'],
  cream:    ['lotion', 'serum', 'gel', 'ointment', 'oil', 'spray', 'foam', 'cleanser', 'toner', 'wash', 'scrub', 'mask', 'butter'],
  lotion:   ['cream', 'serum', 'gel', 'ointment', 'oil', 'spray', 'foam', 'cleanser', 'toner', 'wash', 'scrub', 'mask'],
  serum:    ['cream', 'lotion', 'gel', 'oil', 'cleanser', 'toner', 'wash', 'moisturizer'],
  cleanser: ['cream', 'lotion', 'serum', 'oil', 'toner', 'moisturizer', 'mask', 'wash'],
  oil:      ['cream', 'lotion', 'serum', 'gel', 'powder', 'spray', 'shampoo', 'conditioner'],
  shampoo:  ['conditioner', 'oil', 'cream', 'lotion', 'serum', 'mask', 'spray'],
};

// Brand-family-specific sibling patterns. Each entry's `when` predicate
// tests whether the product name belongs to this family; if so, the
// listed terms (when ABSENT from the product name) are added as siblings.
const _BRAND_FAMILY_SIBLINGS = [
  // Now Foods Omega family — many sibling products in this line.
  {
    when: (n) => /\bomega\b/.test(n) && /\bfish\s+oil\b/.test(n),
    terms: [
      '3-6-9', '369', '3 6 9',     // Omega 3-6-9 blend
      'red omega',                  // Red Omega (different formulation)
      'tri-3d', 'tri 3d', 'tri3d',  // Tri-3D Omega
      'dha-500', 'dha 500', 'dha500',
      'dha-1000', 'dha 1000', 'dha1000',
      'mini gel', 'mini gels',      // Mini Gels variant
      'molecularly distilled gel',  // sibling variant marker
      'enteric coated',             // enteric variant
    ],
  },
  // Now Foods Enzymes family.
  {
    when: (n) => /\benzymes?\b/.test(n) && /\bnow\b/.test(n),
    terms: [
      'plant enzymes', 'papaya enzymes', 'pancreatin', 'bromelain only',
      'digestive enzymes' /* gentle reject — different SKU; user can override */,
    ],
  },
  // CeraVe day/night/SA distinctions.
  {
    when: (n) => /\bcerave\b/.test(n),
    terms: ['am', 'pm', 'sa', 'baby', 'eye repair', 'healing'],
    matchAsWord: true,  // short tokens — must match \bword\b
  },
  // Aveeno product line distinctions.
  {
    when: (n) => /\baveeno\b/.test(n),
    terms: ['eczema', 'calm', 'relief', 'positively radiant', 'baby', 'clear complexion'],
  },
  // Johnson's product types — oil vs lotion vs shampoo are all separate SKUs.
  {
    when: (n) => /\bjohnsons?\b/.test(n) || /\bjohnson['’]s?\b/.test(n),
    terms: ['cottontouch', 'milk + rice', 'bedtime'],
  },
];

// Build the full sibling-exclusion list for a productContext. Cached on
// the context object so we don't rebuild per keyword. Returns an array
// of { term, type, matchAsWord }.
export function buildSiblingExclusions(productContext) {
  if (!productContext) return [];
  const name = `${productContext.productType || ''} ${productContext.fullProductName || ''}`.toLowerCase();
  if (!name) return [];
  const exclusions = [];
  const seen = new Set();
  const push = (term, type, matchAsWord = false) => {
    const key = `${term}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    exclusions.push({ term, type, matchAsWord });
  };

  // Form-alternative siblings.
  const form = productContext.formFactor;
  if (form && _FORM_SIBLINGS[form]) {
    for (const alt of _FORM_SIBLINGS[form]) {
      // Skip if our name contains the alt form (multi-form combo product).
      if (new RegExp(`\\b${alt}\\b`, 'i').test(name)) continue;
      push(alt, 'wrong_form');
    }
  }

  // Brand-family sibling patterns.
  for (const family of _BRAND_FAMILY_SIBLINGS) {
    if (!family.when(name)) continue;
    for (const term of family.terms) {
      if (name.includes(term)) continue; // we ARE this sibling
      push(term, 'brand_family_sibling', family.matchAsWord === true);
    }
  }

  return exclusions;
}

// Check a single text against productContext.siblingExclusions. Returns
// the first hit's descriptor or null. Pre-computed regexes are cached on
// the exclusion entry on first use.
export function checkSiblingProduct(text, productContext) {
  if (!productContext) return null;
  const exclusions = productContext.siblingExclusions;
  if (!Array.isArray(exclusions) || exclusions.length === 0) return null;
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  for (const ex of exclusions) {
    if (!ex._re) {
      // Word-boundary regex for everything — even multi-word terms.
      const escaped = ex.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      ex._re = new RegExp(`\\b${escaped}\\b`, 'i');
    }
    if (ex._re.test(haystack)) return { term: ex.term, type: ex.type };
  }
  return null;
}

// Known supplement / health / skincare / baby brand list for competitor-
// brand rejection. When a keyword names one of these brands and that
// brand isn't ours, the query is shopping for a different brand entirely
// (or a comparison) and shouldn't burn a SERP load. Substring-matched as
// whole phrases so "now" alone doesn't trigger "now foods" rejection on
// our own keywords. Note: includes our own portfolio (aquaphor, la-roche-
// posay, listerine, etc.) — checkCompetitorBrand skips our brand at runtime,
// so listing them here is safe AND useful: if another SKU's run names one
// of OUR sibling brands, we still want to keep the query (brand-mate gate
// will catch sibling-SKU specifics).
const _KNOWN_COMPETITOR_BRANDS = [
  // Supplement / health
  'now foods', 'now supplements', 'nature made', 'nature\'s bounty', 'natures bounty',
  'nordic naturals', 'garden of life', 'vitabiotics', 'solgar', 'gnc', 'kirkland',
  'swanson', 'life extension', 'doctor\'s best', 'doctors best',
  'jarrow', 'carlson', 'nutrilite', 'amway', 'himalaya', 'muscleblaze',
  'optimum nutrition', 'myprotein', 'healthkart', 'oziva', 'wellbeing',
  'centrum', 'seven seas', 'blackmores', 'puritan\'s pride', 'puritans pride',
  'pharmeasy', 'apollo pharmacy', 'wellness forever',
  // General skincare / face & body
  'cerave', 'cetaphil', 'neutrogena', 'olay', 'l\'oreal', 'loreal',
  'mamaearth', 'plum', 'wow skin', 'minimalist', 'biotique', 'nivea',
  'dove', 'pond\'s', 'ponds', 'lakme', 'lakmé', 'mac', 'estee lauder',
  'clinique', 'lancome', 'lancôme', 'shiseido', 'kiehl\'s', 'kiehls',
  'the body shop', 'the inkey list', 'paula\'s choice', 'paulas choice',
  'drunk elephant', 'sunday riley', 'glossier', 'fenty',
  // Baby & diaper care — added after Aquaphor batch surfaced these in
  // comparison queries (vs desitin / vs vaseline / vs sudocrem etc.)
  'desitin', 'sudocrem', 'vaseline', 'boudreaux', 'butt paste', 'a+d ointment',
  'a and d ointment', 'triple paste', 'burt\'s bees', 'burts bees',
  'weleda', 'mustela', 'pampers', 'huggies', 'mamypoko', 'pigeon',
  'johnson\'s baby', 'johnsons baby', 'sebamed', 'chicco', 'himalaya baby',
  'mothercare', 'eucerin', 'bepanthen', 'penaten',
  // Oral / mouthwash (Listerine portfolio context)
  'colgate', 'crest', 'oral-b', 'oral b', 'sensodyne', 'parodontax',
  'closeup', 'close-up', 'pepsodent', 'meswak', 'patanjali dant',
  // Lip care (ChapStick portfolio context)
  'burt\'s bees lip', 'eos', 'carmex', 'blistex', 'nivea lip',
  'maybelline baby lips', 'vaseline lip',
];
const _COMPETITOR_BRAND_RES = _KNOWN_COMPETITOR_BRANDS.map(b => ({
  text: b,
  re:   new RegExp(`\\b${b.replace(/'/g, "[']?").replace(/\s+/g, '\\s+')}\\b`, 'i'),
}));

// Returns { match: true, brand } when `text` contains a competitor brand
// name that's not ours; null otherwise.
export function checkCompetitorBrand(text, productContext) {
  if (!productContext) return null;
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  const ourBrand = String(productContext.brandName || '').toLowerCase();
  const ourAliases = (productContext.brandAliases || []).map(a => String(a).toLowerCase());
  for (const { text: brandText, re } of _COMPETITOR_BRAND_RES) {
    // Skip our own brand — never reject ourselves.
    if (brandText === ourBrand) continue;
    if (ourAliases.some(a => a === brandText)) continue;
    if (re.test(haystack)) return { match: true, brand: brandText };
  }
  return null;
}

// Commercial-intent vocabulary for Tier-4 promotion. Anchor-only queries
// without any commercial cue are usually educational ("what is alfalfa
// plant", "alfalfa nutrition value") and aren't worth a SERP load.
const _COMMERCIAL_INTENT = [
  'price','cost','buy','order','shop','deal','discount','offer','coupon',
  'review','rating','worth','best','top','vs','versus','compare',
  'alternative','similar','substitute',
  'where to buy','online','near me','in india','india price',
  'amazon','flipkart','nykaa','myntra','meesho','ajio',
  'mg','dose','dosage','daily','for adults',
];
// Product-spec regex: someone searching "650 mg" / "8 oz" / "250 tablets" /
// "100 ml" is implicitly a buying-stage query. Treat product specifications
// as commercial intent on par with explicit verbs like "buy" / "price".
const _PRODUCT_SPEC_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|iu|ml|millilitre|milliliter|g\b|gm|kg|oz|fl\s*oz|lb|ct|count|pack|tablets?|capsules?|softgels?|pills?|mm|inch|cm|kcal)\b/i;

function _hasCommercialIntent(kw) {
  for (const w of _COMMERCIAL_INTENT) if (kw.includes(w)) return true;
  if (_PRODUCT_SPEC_RE.test(kw)) return true;
  return false;
}

export function classifyKeyword(keyword, productContext) {
  const reject = (reason) => ({ relevant: false, tier: null, loadSERP: false, expand: false, reason });
  if (!productContext) return { relevant: true, tier: 'anchor_only', loadSERP: true, expand: 'match_decides', reason: null };
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return reject('empty');

  // Form factor mismatch is always disqualifying (powder ≠ tablet, etc.).
  if (getWrongFormReason(kw, productContext)) return reject('wrong_form');

  // Homeopathic-product reject for non-homeopathic supplements. Even brand
  // matches don't save these — "Sbl Alfalfa Q" / "Bakson Alfalfa Tonic" are
  // distinct SKUs from a NOW Foods Alfalfa Tablets listing.
  if (productContext.category === 'supplement' &&
      productContext.formFactor !== 'tincture' &&
      productContext.formFactor !== 'malt' &&
      productContext.formFactor !== 'tonic' &&
      _HOMEOPATHIC_RE.test(kw)) {
    return reject('homeopathic_product');
  }

  // Wrong-audience reject: human supplements / health / skincare products
  // never want veterinary or animal-targeted queries — "now foods alfalfa
  // for cattle", "fish oil for dogs", "biotin shampoo for horses". Brand
  // match doesn't save these; they're a different product market.
  if (_WRONG_AUDIENCE_CATEGORIES.has(productContext.category) &&
      _WRONG_AUDIENCE_RE.test(kw)) {
    return reject('wrong_audience');
  }

  // Wrong-variant reject: the keyword itself names a count/dosage/volume
  // that differs from ours. "now foods super enzymes 180 capsules" is a
  // keyword for a DIFFERENT SKU even if the image matching layer would
  // also catch it — rejecting here saves the SERP load too. Uses the
  // same hasConflictingSpec helper as image-match variant detection.
  if (productContext.specs && hasConflictingSpec(kw, productContext.specs).length > 0) {
    return reject('wrong_variant_keyword');
  }

  // Wrong-product-line reject: keyword contains a modifier (ultra / super /
  // double strength / extra strength / etc.) that our product's name
  // doesn't carry. Same-brand sibling product — different formulation.
  // Bigger driver of false positives than wrong_variant on product lines
  // like "Omega 3 Fish Oil" (where "Ultra Omega 3" passes brand+anchor).
  const lineMod = checkProductLineModifier(kw, productContext);
  if (lineMod) return reject(`wrong_product_line:${lineMod.modifier}`);

  // Competitor-brand reject: keyword names a different brand. "vitabiotics
  // ultra omega 3 amazon" for our Now Foods product is shopping for the
  // wrong brand. Comparison queries ("now foods vs solgar") also get
  // rejected; the spec accepts that trade-off.
  const compBrand = checkCompetitorBrand(kw, productContext);
  if (compBrand) return reject(`competitor_brand:${compBrand.brand}`);

  // Sibling-product reject: same brand, but the keyword names a sibling
  // SKU — different form (tablet vs softgel), different family member
  // (3-6-9 vs 3, DHA-1000 vs general fish oil, mini gel vs regular).
  // Brand-family patterns are hardcoded for common families (Omega line,
  // CeraVe, Aveeno, Johnson's); form-alternatives are derived from
  // productContext.formFactor.
  const sibling = checkSiblingProduct(kw, productContext);
  if (sibling) return reject(`sibling_product:${sibling.term}`);

  // Variant-slot reject: keyword names the opposite side of a paired
  // product-line slot. Product is "day cream" but keyword names "night";
  // product is "men's shampoo" but keyword names "women's". Catches the
  // last common category of sibling-SKU mismatches that survives the
  // other filters.
  const slot = checkVariantSlot(kw, productContext);
  if (slot) return reject(`variant_slot:${slot.ours}!=${slot.theirs}`);

  // Color conflict reject: product name has color X, keyword has color Y
  // with no overlap. Fires only when our product is a colored SKU
  // ("Maybelline Matte Ink 80 Ruler RED") and the keyword names a
  // different shade ("maybelline matte ink black"). Multi-shade queries
  // that include our color pass through.
  const colorConflict = checkColorConflict(kw, productContext);
  if (colorConflict) return reject(`color_conflict:${colorConflict.ours}!=${colorConflict.theirs}`);

  // Name-swap reject (cosmetics only): keyword has ≥2 unaccounted-for
  // shade/model tokens AND drops ≥2 of ours. Strict trigger + protected
  // commerce/intent vocab keeps the false-positive rate low. Only
  // checked when product is a cosmetics-style SKU.
  const swap = checkNameSwap(kw, productContext);
  if (swap) return reject(`name_swap:+${swap.extras.join(',')}/-${swap.missing.join(',')}`);

  // Attribute-family reject: keyword names a value of a family our
  // product also asserts, but the value differs ("vegan omega 3 supplement"
  // when our product is a fish-oil formulation). Symmetric with the
  // image-side veto — keyword text is checked the same way as SERP ctx.
  const attrFam = checkAttributeFamily(kw, productContext);
  if (attrFam) return reject(`attribute:${attrFam.family}:${attrFam.ours}!=${attrFam.theirs}`);

  // Brand-mate reject: keyword contains a token that belongs to a sibling
  // SKU in this batch ("aquaphor baby healing ointment" when our product
  // is the adult Healing Ointment). Same logic as the image-side veto —
  // protects against KP / autosuggest seeding our pipeline with brand-mate
  // traffic that we'd then misattribute to OUR SKU.
  const bm = checkBrandMate(kw, productContext);
  if (bm) return reject(`brand_mate:${bm.token}`);

  let hasBrand     = _hasBrandSubstr(kw, productContext.brandAliases);
  const hasAnchor   = _hasAnchor(kw, productContext.handleWords);
  const hasCategory = _hasCategoryTerm(kw, productContext.categoryTerms);
  // Contextual brand: if the standard brand check missed, but a common-word
  // alias appears adjacent to an anchor AND a category term is present,
  // upgrade to a brand match. Promotes "now alfalfa tablets" from Tier 3 to
  // Tier 1 without accepting "alfalfa now Little Rascals" (no category).
  if (!hasBrand && hasAnchor && hasCategory) {
    hasBrand = _hasContextualBrand(kw, productContext.brandAliases, productContext.handleWords, productContext.categoryTerms);
  }

  if (hasBrand && hasAnchor) {
    // Tier 1 — this IS our product.
    return { relevant: true, tier: 'brand_product', loadSERP: true, expand: true, reason: null };
  }
  if (hasBrand && !hasAnchor) {
    // Tier 2 — sibling brand product. Store as competitive intel, skip SERP.
    return { relevant: true, tier: 'brand_other', loadSERP: false, expand: false, reason: null };
  }
  // Strict-brand mode: anything below this point has NO brand mention.
  // Previously Tier 3 (anchor+category) and Tier 4 (anchor+commercial) were
  // kept as "exploratory" queries — they'd load a SERP and hope our image
  // surfaced. In practice they bloated the row count with low-confidence
  // matches that mostly attributed to competitors (Aquaphor seed yielded
  // 331 SERP-eligible of 1203 ideas — too many for "only relevant to our
  // product"). Reject them at the filter so the CSV stays clean.
  if (hasAnchor && hasCategory) {
    return reject('generic_no_brand');
  }
  if (hasAnchor) {
    if (_hasCommercialIntent(kw)) {
      return reject('anchor_commercial_no_brand');
    }
    return reject('anchor_only_no_commercial');
  }
  if (hasCategory) {
    return reject('category_only_no_anchor');
  }
  return reject('no_signals');
}

// Thin boolean wrapper for legacy call sites that just want yes/no. New code
// (engine SERP gates, R2 seed selection) should use classifyKeyword directly
// to read the tier.
export function isRelevantToProduct(keyword, productContext) {
  return classifyKeyword(keyword, productContext).relevant;
}

// True when a keyword matches our brand but lacks an anchor word. The
// engine uses this to STORE such keywords (they're useful competitive
// intel — sibling products from our own brand) WITHOUT spending a SERP
// load on them. Per-keyword image data and seller data would be 0 either
// way since these are different products.
export function isBrandOnlyMatch(keyword, productContext) {
  if (!productContext) return false;
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return false;
  if (!_hasBrandSubstr(kw, productContext.brandAliases)) return false;
  return !_hasAnchor(kw, productContext.handleWords);
}

// ============ Product identity ============
// Layer 2 of the brand → product → variant match chain. The brand check
// (Layer 1) accepts "now foods PLANT enzymes" because "now foods" matches.
// The legacy single-word _hasAnchor check accepts it too because "enzymes"
// matches one of our handle words. But it's a DIFFERENT product (Plant
// Enzymes vs Super Enzymes). The fix: every word of `coreTypeWords` must
// appear in the context. If any are missing, we're looking at a sibling
// product, not ours.
//
// Returns `{ tier, match, missingWords, matchedCount, totalCount }` where
// `tier` is:
//   'full'    — every coreTypeWord present in ctx
//   'partial' — at least ⌈N/2⌉ of N coreTypeWords present (caller decides
//               whether to accept based on brand + spec confirmation)
//   'fail'    — fewer than ⌈N/2⌉ matched (clearly wrong product)
//
// Backwards-compat: `match` mirrors the old boolean (true iff tier === 'full').
// Callers that want the new behavior check `tier` directly.
//
// The partial tier exists because retailers sometimes drop a coreTypeWord
// from the title (e.g. "Now Foods Omega-3 200 Softgels" — "fish" is on
// the bottle / in the product description but not in the SERP text).
// Strict all-or-nothing rejection over-killed legitimate matches; the
// partial path lets the caller validate via brand + spec confirmation.
export function checkProductIdentity(contextText, productContext) {
  if (!productContext) return { tier: 'full', match: true, missingWords: [], matchedCount: 0, totalCount: 0 };
  const coreWords = (productContext.coreTypeWords || []).map(w => String(w || '').toLowerCase()).filter(Boolean);
  if (coreWords.length === 0) {
    return { tier: 'full', match: true, missingWords: [], matchedCount: 0, totalCount: 0 };
  }
  const ctx = String(contextText || '').toLowerCase();
  if (!ctx) return { tier: 'fail', match: false, missingWords: coreWords.slice(), matchedCount: 0, totalCount: coreWords.length };
  const matched = coreWords.filter(w => ctx.includes(w));
  const missing = coreWords.filter(w => !ctx.includes(w));
  const matchedCount = matched.length;
  const totalCount = coreWords.length;
  const partialThreshold = Math.ceil(totalCount / 2);
  let tier;
  if (matchedCount === totalCount) tier = 'full';
  else if (matchedCount >= partialThreshold) tier = 'partial';
  else tier = 'fail';
  return { tier, match: tier === 'full', missingWords: missing, matchedCount, totalCount };
}

// Spec-confirmation helper: does the context positively confirm at least
// one of our product's specs (count / dose / volume / mass / extended)?
// Used by the identity-tier handler to rescue partial-text matches that
// otherwise look ambiguous.
//
// "Confirmation" = ctx value present AND matches ours within the same
// tolerances hasConflictingSpec uses (count exact, dose ±15%, etc.).
//
// Returns { confirmed: bool, dim?: string, ours?: string, theirs?: string }
// so the caller can log WHICH spec confirmed.
export function hasSpecConfirmation(contextText, ourSpecs) {
  if (!ourSpecs) return { confirmed: false };
  const ctx = String(contextText || '').toLowerCase();
  if (!ctx) return { confirmed: false };
  const ctxQty = parseQty(ctx);

  // Count: exact match
  if (ourSpecs.count != null) {
    const ourCount = parseInt(ourSpecs.count, 10);
    if (ctxQty.count != null && Math.round(ctxQty.count) === ourCount) {
      return { confirmed: true, dim: 'count', ours: ourSpecs.count, theirs: String(ctxQty.count) };
    }
  }
  // Dose / dosage: ±15% (matches hasConflictingSpec tolerance)
  if (ourSpecs.dosage != null) {
    const ours = parseFloat(ourSpecs.dosage);
    if (ctxQty.dose != null) {
      const r = ctxQty.dose / ours;
      if (r >= 0.85 && r <= 1.15) {
        return { confirmed: true, dim: 'dosage', ours: ourSpecs.dosage, theirs: String(ctxQty.dose) };
      }
    }
    // also IU
    if (ctxQty.doseIU != null) {
      const r = ctxQty.doseIU / ours;
      if (r >= 0.85 && r <= 1.15 && (ourSpecs.dosageUnit || '').toLowerCase() === 'iu') {
        return { confirmed: true, dim: 'dosage', ours: ourSpecs.dosage + 'iu', theirs: ctxQty.doseIU + 'iu' };
      }
    }
  }
  // Volume / weight: exact within rounding
  if (ourSpecs.volume != null && ctxQty.volume != null) {
    const ours = parseFloat(ourSpecs.volume);
    if (Math.abs(ctxQty.volume - ours) / Math.max(ours, 1) < 0.05) {
      return { confirmed: true, dim: 'volume', ours: ourSpecs.volume, theirs: String(ctxQty.volume) };
    }
  }
  if (ourSpecs.weight != null && ctxQty.mass != null) {
    const ours = parseFloat(ourSpecs.weight);
    if (Math.abs(ctxQty.mass - ours) / Math.max(ours, 1) < 0.05) {
      return { confirmed: true, dim: 'weight', ours: ourSpecs.weight, theirs: String(ctxQty.mass) };
    }
  }
  // Extended specs (epa, dha, spf, etc.) — exact-or-tight match
  for (const k of ['epa', 'dha', 'spf', 'storage', 'wattage', 'battery', 'screen']) {
    if (ourSpecs[k] != null && ctxQty[k] != null) {
      const ours = parseFloat(ourSpecs[k]);
      const theirs = parseFloat(ctxQty[k]);
      if (Math.abs(theirs - ours) / Math.max(ours, 1) < 0.05) {
        return { confirmed: true, dim: k, ours: ourSpecs[k], theirs: String(theirs) };
      }
    }
  }
  return { confirmed: false };
}

// ============ Sibling SKU ambiguity (universal quantity gate) ============
// When the input batch contains multiple SKUs that share the same baseKey
// (name with all quantity dimensions stripped) and differ ONLY on a
// quantity dimension (count / dose / volume / mass), the SERP image is
// visually identical across siblings. CLIP / color / brand / identity
// cannot tell them apart. The discriminating dimension is the only valid
// signal — and ONLY when the SERP context names a value for it.
//
// Three cases per match:
//   1. ctx names the discriminator AND value matches ours → match ✓
//   2. ctx names the discriminator AND value differs       → VETO (existing
//                                                            checkVariantConflict
//                                                            already handles this
//                                                            for known dimensions)
//   3. ctx does NOT name the discriminator                 → AMBIGUOUS — we
//                                                            cannot claim this
//                                                            sibling-specific
//                                                            SKU. Reject.
// Without case 3, every unnumbered keyword's SERP image gets accepted onto
// every sibling SKU, inflating each SKU's match count and pinning the
// keyword to whichever SKU was processed first.

// Universal quantity parser. Returns an object keyed by canonical dimension
// (volume → ml, mass → g, dose → mg, count → ct) with normalized numeric
// values. "Last match wins" within a dimension — for context strings like
// "30 caps from 200 caps pack" we'd return 200, but the upstream rule
// "ours present → no conflict" handles multi-quantity strings cleanly.
export function parseQty(text) {
  if (!text) return {};
  const t = String(text).toLowerCase().replace(/[(),]/g, ' ');
  const out = {};
  const grab = (re, dim, mul = 1) => {
    let m;
    let v = null;
    while ((m = re.exec(t))) v = parseFloat(m[1]) * mul;
    if (v != null && out[dim] == null) out[dim] = v;
  };
  // VOLUME first so "fl oz" isn't eaten by mass-oz; canonical = ml
  grab(/(\d+(?:\.\d+)?)\s*fl\.?\s*oz\b/g,           'volume', 29.5735);
  grab(/(\d+(?:\.\d+)?)\s*ml\b/g,                   'volume', 1);
  grab(/(\d+(?:\.\d+)?)\s*(?:l|liter|litre)\b/g,    'volume', 1000);
  // MASS; canonical = g (mg/mcg handled as dose, not mass)
  grab(/(\d+(?:\.\d+)?)\s*kg\b/g,                   'mass',   1000);
  grab(/(\d+(?:\.\d+)?)\s*(?:g|gm|gram)\b/g,        'mass',   1);
  grab(/(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/g,       'mass',   28.35);
  grab(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound)\b/g,     'mass',   453.592);
  // DOSE / strength; canonical = mg (IU kept separate via "iu" tag)
  grab(/(\d+(?:\.\d+)?)\s*mcg\b/g,                  'dose',   0.001);
  grab(/(\d+(?:\.\d+)?)\s*mg\b/g,                   'dose',   1);
  grab(/(\d+(?:\.\d+)?)\s*iu\b/g,                   'doseIU', 1);
  // COUNT; canonical = ct (count units normalised)
  grab(/(?:pack\s*of\s*)(\d{1,4})\b/g,              'count',  1);
  grab(/(\d{1,4})\s*(?:'s|x)?\s*(?:soft\s*gels?|s[\s\/]?gels?|sgels?|capsules?|caps?|tablets?|tabs?|gummies|gummy|chewables?|lozenges?|sachets?|strips?|pieces?|pcs?|count|ct|nos?|no\.)\b/g, 'count', 1);
  grab(/(\d{1,4})\s*'s\b/g,                         'count',  1);
  return out;
}

// Collapse a product name to its identity tokens — strip every numeric
// quantity-bearing token so two SKUs that differ ONLY on quantity end up
// with the same baseKey. Universal — same regex pattern set as parseQty.
export function baseKey(title) {
  if (!title) return '';
  return String(title).toLowerCase()
    .replace(/\d+(?:\.\d+)?\s*(?:soft\s*gels?|sgels?|caps?|capsules?|tablets?|tabs?|gummies?|chewables?|lozenges?|sachets?|strips?|pieces?|pcs?|count|ct|fl\.?\s*oz|ml|l|liter|litre|kg|gm|gram|g|oz|ounces?|lb|lbs|pound|mcg|mg|iu)\b/g, ' ')
    .replace(/pack\s*of\s*\d+/g, ' ')
    .replace(/\b\d+\s*'s\b/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Numeric-tolerance check for "same value". 1% tolerance handles unit
// rounding (28.35 oz ↔ 28 oz, 29.5735 ml ↔ 30 ml) without admitting
// genuine product differences. count is exact (discrete SKU choices).
function _qtyEqual(dim, a, b) {
  if (a == null || b == null) return false;
  if (dim === 'count') return Math.round(a) === Math.round(b);
  if (a === 0 || b === 0) return a === b;
  const ratio = a / b;
  return ratio >= 0.99 && ratio <= 1.01;
}

// Brand-mate conflict check. The sibling-ambiguity gate (Layer 8) only
// fires when two products share a baseKey (name with quantities stripped).
// But many same-brand siblings have different baseKeys — Aquaphor sells
// "Baby Healing Ointment" and "Healing Ointment" (no "baby") as separate
// SKUs, and these don't share a baseKey because "baby" is in the name
// of one but not the other.
//
// This layer catches them: if a SERP context contains a token that
// belongs to ANOTHER product in our batch from the same brand, but NOT
// to ours, the context is for that other product. Veto.
//
// Returns { match, token, ourSibling } when text asserts a brand-mate's
// exclusive token; null otherwise.
export function checkBrandMate(text, productContext) {
  if (!productContext) return null;
  const brandMateTokens = productContext.brandMateExclusionTokens;
  if (!(brandMateTokens instanceof Set) || brandMateTokens.size === 0) return null;
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  // Tokenise context the same way the pre-pass tokenised product names.
  const ctxTokens = extractDiscriminatorTokens(haystack);
  for (const tok of brandMateTokens) {
    if (ctxTokens.has(tok)) {
      return { match: true, token: tok };
    }
  }
  return null;
}

// Raw-token discriminator extraction. Universal across categories — we
// don't need a config to know that "fish oil" / "enteric coated" / "hd"
// / "titanium" can distinguish sibling SKUs. The pre-pass takes the
// product names in a baseKey group, tokenises each (stripping numerics,
// units, and fillers), and any token that appears in SOME but not ALL
// members becomes a discriminator.
//
// Fillers cover commerce/generic words that aren't identity markers.
// Length >= 3 cuts noise tokens. Words inside number+unit phrases get
// stripped by parseQty's regex set first.
const _DISCRIMINATOR_FILLERS = new Set([
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'in', 'of', 'to', 'from',
  'by', 'is', 'its', 'on', 'new', 'pack', 'size', 'value', 'set', 'kit',
  'box', 'bottle', 'each', 'item', 'qty', 'quantity', 'piece', 'pieces',
  'unit', 'units', 'count', 'natural', 'pure', 'best', 'premium',
  'organic', 'non', 'gmo', 'free', 'gluten', 'vegan', 'vegetarian',
  'halal', 'kosher', 'certified', 'tested', 'verified',
  // Slug numeric artefacts: "1point75-ounce" → tokenises to "point",
  // "0point35" → "point", "x-large" → "large". Strip the fragments
  // that aren't meaningful discriminators.
  'point', 'plus', 'percent', 'per', 'cent',
]);
export function extractDiscriminatorTokens(name) {
  const out = new Set();
  if (!name) return out;
  let t = String(name).toLowerCase();
  // Strip number+unit phrases (parseQty's coverage)
  t = t.replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|iu|ui|ml|fl\.?\s*oz|oz|l|liter|litre|g|gm|gram|kg|lb|gb|tb|w|watt|mah|epa|dha|spf|softgel|sgel|capsule|cap|tablet|tab|caplet|gummy|gummies|chewable|lozenge|sachet|strip|piece|pcs|count|ct|pack)s?\b/g, ' ');
  t = t.replace(/pack\s*of\s*\d+/g, ' ');
  t = t.replace(/\b\d+\s*'s\b/g, ' ');
  t = t.replace(/\b\d+\b/g, ' ');
  for (const w of t.split(/[^a-z]+/)) {
    if (w.length < 3) continue;
    if (_DISCRIMINATOR_FILLERS.has(w)) continue;
    out.add(w);
  }
  return out;
}

// Returns one of:
//   null                                       — gate doesn't apply (no
//                                                 siblings) OR positive
//                                                 confirmation present
//   { ambiguous: true, ... }                   — ctx is silent on every
//                                                 discriminator we own;
//                                                 cannot pin to this SKU
//   { mismatch: true, kind, ... }              — ctx asserts a discriminator
//                                                 value that's another
//                                                 sibling's (not ours)
//
// Universal logic (works for any product type, no per-category config):
//   1. If ctx asserts a value of any discriminator that another sibling
//      owns and WE don't own → mismatch (definitely not ours).
//   2. Otherwise, require positive confirmation: at least one
//      discriminator we own must be present in ctx OR (if we have no
//      unique discriminators at all — the "plain" SKU) every other
//      sibling's discriminator must be ABSENT from ctx.
//   3. Otherwise → ambiguous.
//
// Three sources of discriminators, all unified via this gate:
//   • quantity dimensions (count / dose / volume / mass / etc.)
//   • formal attribute-family values (supplement.formulation = fish oil)
//   • raw tokens that vary across siblings (auto-derived, universal)
export function checkSiblingAmbiguity(text, productContext) {
  if (!productContext) return null;
  const info = productContext.siblingGroupInfo;
  if (!info || info.siblingCount < 2) return null;

  const ctx = String(text || '').toLowerCase();
  const ctxQty = parseQty(ctx);
  const ctxRawTokens = extractDiscriminatorTokens(ctx);
  // Per-sibling attr-family Sets are stored on info.siblingAttrValuesByIdx
  // (computed at pre-pass time); for ctx we compute on-the-fly.

  // --- Step 1: Veto on other-sibling-only assertions ---
  // For each raw discriminator token that another sibling has but we
  // DON'T have, if ctx contains it → definitely not ours.
  for (const tok of info.rawDiscriminators) {
    if (!ctxRawTokens.has(tok)) continue;
    const oursHas = info.ourRawTokens.has(tok);
    if (!oursHas) {
      // Other sibling owns this token, ctx asserts it → not ours.
      return { mismatch: true, kind: 'raw', token: tok };
    }
  }
  // Same for quantity discriminators.
  for (const dim of info.quantityDiscriminators) {
    if (ctxQty[dim] == null) continue;
    if (info.ourQty[dim] == null || !_qtyEqual(dim, ctxQty[dim], info.ourQty[dim])) {
      return {
        mismatch: true,
        kind: 'qty',
        dim,
        ours: info.ourQty[dim],
        theirs: ctxQty[dim],
      };
    }
  }
  // Same for attribute-family discriminators.
  if (Array.isArray(info.attrFamilyDiscriminators)) {
    for (const { family, values } of info.attrFamilyDiscriminators) {
      const ctxValues = familyValuesAll(ctx, values, null);
      for (const v of ctxValues) {
        const oursHas = info.ourAttrFamilyValues && info.ourAttrFamilyValues[family]
                        && info.ourAttrFamilyValues[family].has(v);
        if (!oursHas) {
          return { mismatch: true, kind: 'attr', family, ours: info.ourAttrFamilyValues?.[family] ? Array.from(info.ourAttrFamilyValues[family]).join('+') : null, theirs: v };
        }
      }
    }
  }

  // --- Step 2: Require positive confirmation ---
  // At least one discriminator WE positively own must be confirmed by ctx.
  let sawConfirmation = false;
  for (const tok of info.ourRawTokens) {
    if (info.rawDiscriminators.has(tok) && ctxRawTokens.has(tok)) {
      sawConfirmation = true; break;
    }
  }
  if (!sawConfirmation) {
    for (const dim of info.quantityDiscriminators) {
      if (info.ourQty[dim] != null && ctxQty[dim] != null && _qtyEqual(dim, ctxQty[dim], info.ourQty[dim])) {
        sawConfirmation = true; break;
      }
    }
  }
  if (!sawConfirmation && Array.isArray(info.attrFamilyDiscriminators)) {
    for (const { family, values } of info.attrFamilyDiscriminators) {
      const ourSet = info.ourAttrFamilyValues?.[family];
      if (!ourSet || ourSet.size === 0) continue;
      const ctxValues = familyValuesAll(ctx, values, null);
      for (const v of ourSet) {
        if (ctxValues.has(v)) { sawConfirmation = true; break; }
      }
      if (sawConfirmation) break;
    }
  }

  if (!sawConfirmation) {
    // Special case: if WE have NO positive discriminators at all (the
    // "plain" SKU — defined by ABSENCE of features), we can match a
    // listing only if every OTHER sibling's exclusive discriminator is
    // absent too. Step 1 already vetoed when ctx asserts another's
    // discriminator. If we got here, ctx is clean of all asserts. The
    // result is genuinely ambiguous — could be any plain-or-silent
    // sibling. Reject.
    return {
      ambiguous: true,
      reason: 'no_discriminator_confirmation',
    };
  }
  return null;
}

// ============ Attribute-family veto (category-keyed config) ============
// See modules/attribute-families.js for the configuration. The gate fires
// only when the PRODUCT positively declares a value of a family AND the
// candidate text declares a DIFFERENT value of the same family. Silent
// product → no veto on that axis; generic informational keywords pass
// freely. Families are resolved once per product (cached on productContext)
// so per-thumbnail checks are just string-set lookups.
import { ATTRIBUTE_FAMILIES, BRAND_FAMILY_OVERRIDES } from './attribute-families.js';

// Resolve the effective attribute-family map for a product:
//   _global  ←  ATTRIBUTE_FAMILIES[category]  ←  BRAND_FAMILY_OVERRIDES[brand]
// later layers override earlier ones on family-key collision (whole family
// is replaced, not merged value-by-value — intentional, so brand overrides
// are atomic per axis).
export function familiesFor(productContext) {
  if (!productContext) return {};
  const cat = (productContext.category || 'general').toLowerCase();
  const brand = (productContext.brandName || '').toLowerCase();
  const base = {
    ...(ATTRIBUTE_FAMILIES._global || {}),
    ...(ATTRIBUTE_FAMILIES[cat] || {}),
  };
  const overrides = BRAND_FAMILY_OVERRIDES[brand];
  return overrides ? { ...base, ...overrides } : base;
}

// Cache-friendly regex builder. We compile one regex per value (sorted
// longest-first) and store on productContext._familyRes so per-thumbnail
// calls don't re-compile.
function _escapeForFamilyRe(token) {
  return token.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

// Returns ALL family values present in `text` as a Set, sorted/scanned
// longest-first so "color-treated" claims the substring before "color"
// would. Empty Set if no value of the family appears. A product can
// assert MULTIPLE values within one family (e.g. process =
// "molecularly distilled" AND "enteric coated" — both flags
// simultaneously). The single-string return was missing the second
// assertion; multi-value Set fixes that.
function familyValuesAll(text, values, cachedRes) {
  const out = new Set();
  if (!text || !Array.isArray(values) || values.length === 0) return out;
  const t = String(text).toLowerCase();
  const sorted = [...values].sort((a, b) => b.length - a.length);
  // To respect longest-match precedence, blank-out each match's region as
  // we go so a shorter substring of an already-matched value doesn't
  // re-fire. Without this, matching "color-treated" would also report
  // "color" as a separate assertion.
  let scratch = t;
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    let re = cachedRes && cachedRes[v];
    if (!re) {
      re = new RegExp(`(^|[^a-z])(${_escapeForFamilyRe(v)})([^a-z]|$)`, 'gi');
      if (cachedRes) cachedRes[v] = re;
    } else {
      re.lastIndex = 0;
    }
    let m;
    let hit = false;
    while ((m = re.exec(scratch)) !== null) {
      hit = true;
      // Blank out the matched value so shorter substrings can't re-fire.
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      scratch = scratch.slice(0, start) + ' '.repeat(end - start) + scratch.slice(end);
      re.lastIndex = end;
    }
    if (hit) out.add(v);
  }
  return out;
}

// Pre-compute the product's family values from its name/type tokens.
// Called once per product at engine init; result cached on productContext
// as { family: Set<value> }.
export function computeProductFamilyValues(productContext) {
  if (!productContext) return {};
  const fam = productContext.attrFamilies || familiesFor(productContext);
  const sourceText = `${productContext.productType || ''} ${productContext.fullProductName || ''}`.toLowerCase();
  const out = {};
  const reCache = productContext._familyRes || (productContext._familyRes = {});
  for (const [familyName, values] of Object.entries(fam)) {
    reCache[familyName] = reCache[familyName] || {};
    out[familyName] = familyValuesAll(sourceText, values, reCache[familyName]);
  }
  return out;
}

// Check a candidate text for an attribute-family conflict against this
// product. Returns:
//   null                                       — no conflict (product silent
//                                                 on every asserted family,
//                                                 or text-asserted values
//                                                 are subset of ours)
//   { family, ours, theirs }                   — text asserts a value of
//                                                 `family` that's NOT in our
//                                                 set for that family
//
// Rule with multi-value Sets: text declares family value V; if V is not
// in our set for that family AND our set is non-empty, conflict. Empty
// set means "product silent" — gate doesn't apply (per the safety
// property: silent product → no veto).
export function checkAttributeFamily(text, productContext) {
  if (!productContext) return null;
  const fam = productContext.attrFamilies;
  if (!fam) return null;
  const ours = productContext.attrFamilyValues;
  if (!ours) return null;
  const reCache = productContext._familyRes || (productContext._familyRes = {});
  for (const [familyName, values] of Object.entries(fam)) {
    const ourSet = ours[familyName];
    if (!ourSet || ourSet.size === 0) continue; // silent — no veto on this axis
    reCache[familyName] = reCache[familyName] || {};
    const theirSet = familyValuesAll(text, values, reCache[familyName]);
    if (theirSet.size === 0) continue; // ctx silent — no conflict
    // Conflict if ANY ctx-asserted value isn't in our set.
    for (const v of theirSet) {
      if (!ourSet.has(v)) {
        return {
          family: familyName,
          ours: Array.from(ourSet).join('+'),
          theirs: v,
        };
      }
    }
  }
  return null;
}

// ============ Variant matching ============
// Same brand + same product line + visually identical bottle ≠ same SKU.
// "Now Foods Super Enzymes 90 Capsules" and "…180 Capsules" share brand,
// anchor, color palette, and (often) CLIP score, but a customer searching
// for one and seeing an ad for the other is a real mismatch. We extract
// numeric specs (count / dosage / volume / weight / pack) from the raw
// product name once during init, then on each SERP thumbnail we compare
// the spec values found in the surrounding context against ours.
export function extractProductSpecs(productName) {
  const name = String(productName || '').toLowerCase();
  const specs = {
    count: null,       countUnit: null,
    dosage: null,      dosageUnit: null,
    volume: null,      volumeUnit: null,
    weight: null,      weightUnit: null,
    packSize: null,
    // Extended numeric dimensions — universal across categories. These give
    // the spec-conflict layer additional axes to detect wrong SKUs that
    // share the basic count/dosage but differ on a named dimension.
    epa: null,         // omega-3 EPA mg per serving
    dha: null,         // omega-3 DHA mg per serving
    spf: null,         // skincare sun protection factor
    storage: null,     // electronics storage in GB
    storageUnit: null, // 'gb' | 'tb'
    wattage: null,     // wattage (electronics)
    battery: null,     // mAh
    screen: null,      // inches
  };

  const countMatch = name.match(/\b(\d+)\s*(capsules?|caps?|tablets?|tabs?|softgels?|vcaps?|veg\s*caps?|caplets?|gummies?|lozenges?|chewables?|packets?|sachets?|servings?|count)\b/i);
  if (countMatch) {
    specs.count = countMatch[1];
    specs.countUnit = countMatch[2].replace(/s$/, '').toLowerCase();
  }

  const dosageMatch = name.match(/\b(\d+(?:\.\d+)?)\s*(mg|mcg|µg|iu|ui|g(?!m)|gram)\b/i);
  if (dosageMatch) {
    specs.dosage = dosageMatch[1];
    specs.dosageUnit = dosageMatch[2].toLowerCase();
  }

  const volumeMatch = name.match(/\b(\d+(?:\.\d+)?)\s*(ml|l|liter|litre|fl\s*oz|fluid\s*oz)\b/i);
  if (volumeMatch) {
    specs.volume = volumeMatch[1];
    specs.volumeUnit = volumeMatch[2].toLowerCase();
  }

  // Weight regex deliberately runs only when volume didn't match — "g"
  // collides with the start of "gallon"-style volume words on some products,
  // and a volume signal is more discriminating.
  if (!volumeMatch) {
    const weightMatch = name.match(/\b(\d+(?:\.\d+)?)\s*(g(?!m)|gm|gram|kg|oz|lb|pound)\b/i);
    if (weightMatch) {
      specs.weight = weightMatch[1];
      specs.weightUnit = weightMatch[2].toLowerCase();
    }
  }

  // "pack of 2" | "2-pack" | "twin pack" | "multi-pack"
  const packMatch = name.match(/(?:pack\s*of\s*(\d+)|(\d+)\s*-?\s*pack|(twin)\s+pack|(multi)\s*-?\s*pack)/i);
  if (packMatch) {
    if (packMatch[1]) specs.packSize = packMatch[1];
    else if (packMatch[2]) specs.packSize = packMatch[2];
    else if (packMatch[3]) specs.packSize = '2';
    else specs.packSize = '2';
  }

  // Extended specs — each tries multiple phrasings; first hit wins.
  const tryPatterns = (patterns) => {
    for (const p of patterns) {
      const m = name.match(p);
      if (m) return m[1];
    }
    return null;
  };
  specs.epa     = tryPatterns([/(\d+)\s*(?:mg\s+)?epa\b/i, /\bepa\s*[:=]?\s*(\d+)/i]);
  specs.dha     = tryPatterns([/(\d+)\s*(?:mg\s+)?dha\b/i, /\bdha\s*[:=]?\s*(\d+)/i]);
  specs.spf     = tryPatterns([/\bspf\s*(\d+)/i, /(\d+)\s*spf\b/i]);
  const storageMatch = name.match(/\b(\d+)\s*(gb|tb)\b/i);
  if (storageMatch) {
    specs.storage = storageMatch[1];
    specs.storageUnit = storageMatch[2].toLowerCase();
  }
  specs.wattage = tryPatterns([/\b(\d+)\s*(?:w|watt|watts)\b/i]);
  specs.battery = tryPatterns([/\b(\d+)\s*mah\b/i]);
  specs.screen  = tryPatterns([/\b(\d+(?:\.\d+)?)\s*(?:inch|"|inches)\b/i]);

  return specs;
}

// Returns an array of conflict descriptors (one per spec type) when the
// context text mentions a CLEARLY DIFFERENT value for a spec our product
// defines.
//
// Rule of thumb: if OUR value appears anywhere in the context, no conflict
// fires for that spec — the page is a multi-variant listing, a comparison
// article, or a category page that includes us alongside other SKUs. The
// engine should treat that as "our product is one of the items here", not
// "this is the wrong SKU". Conflicts fire ONLY when (a) context names a
// value of the right kind, (b) ours isn't among them, and (c) the named
// value is far enough from ours to be a different SKU (per the ratio
// tolerances below).
//
// Tolerances when our value is absent:
//   count   — > 1.5× or < 0.67× (90 vs 180 ❌, 90 vs 100 ✅ borderline)
//   dosage  — > 1.3× or < 0.77× same-unit only (650 vs 1000 ❌, 650 vs 700 ✅)
//   volume  — any difference (volume IS the variant on liquids)
//   weight  — any difference (weight IS the variant on bulk products)
//   pack    — any difference
// When the context simply doesn't mention a spec, no conflict.
export function hasConflictingSpec(contextText, ourSpecs) {
  if (!ourSpecs) return [];
  const ctx = String(contextText || '').toLowerCase();
  if (!ctx) return [];
  const conflicts = [];

  // Collect all numeric values found in `ctx` matching `re`. Each match's
  // captured value is at `valueIdx`. Unit filter is optional — when set,
  // only matches whose unit-capture (`unitIdx`) equals `requireUnit` count.
  const collect = (re, valueIdx, unitIdx, requireUnit) => {
    const out = [];
    let m;
    while ((m = re.exec(ctx)) !== null) {
      if (requireUnit && unitIdx != null) {
        const u = (m[unitIdx] || '').toLowerCase();
        if (u !== requireUnit) continue;
      }
      out.push({ value: m[valueIdx], unit: unitIdx != null ? m[unitIdx] : null });
    }
    return out;
  };

  // Apply the "ours is also present → not a conflict" rule + ratio check
  // for the genuine-different-SKU case.
  const checkConflict = (found, ourValue, ratioHi, ratioLo) => {
    if (found.length === 0) return null;
    if (found.some(f => f.value === ourValue)) return null; // we're in the list
    if (ratioHi == null) return found[0]; // any-difference rule (volume/weight/pack)
    for (const f of found) {
      const ratio = parseFloat(f.value) / parseFloat(ourValue);
      if (ratio >= ratioHi || ratio <= ratioLo) return f;
    }
    return null;
  };

  if (ourSpecs.count) {
    const found = collect(
      /\b(\d+)\s*(capsules?|caps?|tablets?|tabs?|softgels?|vcaps?|veg\s*caps?|caplets?|count)\b/gi,
      1, 2, null
    );
    // Tightened tolerance: 5% (was 50%). Supplement counts are discrete
    // (30, 60, 90, 100, 200, 250) so any meaningful difference is a
    // different SKU. The previous 0.67-1.5 range let "200 vs 180 softgels"
    // pass — a clearly-different bottle.
    const hit = checkConflict(found, ourSpecs.count, 1.05, 0.95);
    if (hit) {
      conflicts.push({
        type: 'count',
        ours: `${ourSpecs.count} ${ourSpecs.countUnit || ''}`.trim(),
        theirs: `${hit.value} ${hit.unit}`,
      });
    }
  }

  if (ourSpecs.dosage) {
    const found = collect(
      /\b(\d+(?:\.\d+)?)\s*(mg|mcg|µg|iu|ui)\b/gi,
      1, 2, (ourSpecs.dosageUnit || '').toLowerCase()
    );
    // Tightened tolerance: 15% (was 30%). Dosages step in product-design
    // increments — 500 vs 600 mg is a different SKU, not a borderline
    // labeling difference.
    const hit = checkConflict(found, ourSpecs.dosage, 1.15, 0.85);
    if (hit) {
      conflicts.push({
        type: 'dosage',
        ours: `${ourSpecs.dosage}${ourSpecs.dosageUnit}`,
        theirs: `${hit.value}${hit.unit}`,
      });
    }
  }

  if (ourSpecs.volume) {
    const found = collect(
      /\b(\d+(?:\.\d+)?)\s*(ml|l|liter|litre|fl\s*oz|fluid\s*oz)\b/gi,
      1, 2, null
    );
    const hit = checkConflict(found, ourSpecs.volume, null, null);
    if (hit) {
      conflicts.push({
        type: 'volume',
        ours: `${ourSpecs.volume}${ourSpecs.volumeUnit}`,
        theirs: `${hit.value}${hit.unit}`,
      });
    }
  }

  if (ourSpecs.weight) {
    const found = collect(
      /\b(\d+(?:\.\d+)?)\s*(g(?!m)|gm|gram|kg|oz|lb|pound)\b/gi,
      1, 2, null
    );
    const hit = checkConflict(found, ourSpecs.weight, null, null);
    if (hit) {
      conflicts.push({
        type: 'weight',
        ours: `${ourSpecs.weight}${ourSpecs.weightUnit}`,
        theirs: `${hit.value}${hit.unit}`,
      });
    }
  }

  if (ourSpecs.packSize) {
    // Pack regex has multiple alternatives — normalise to {value, unit}.
    const packRe = /(?:pack\s*of\s*(\d+)|(\d+)\s*-?\s*pack|(twin)\s+pack|(multi)\s*-?\s*pack)/gi;
    const found = [];
    let m;
    while ((m = packRe.exec(ctx)) !== null) {
      const v = m[1] || m[2] || (m[3] ? '2' : '2');
      found.push({ value: v, unit: 'pack' });
    }
    const hit = checkConflict(found, ourSpecs.packSize, null, null);
    if (hit) {
      conflicts.push({
        type: 'pack_size',
        ours: `pack of ${ourSpecs.packSize}`,
        theirs: `pack of ${hit.value}`,
      });
    }
  }

  // Extended numeric specs. Same "ours present → no conflict" rule. Per-
  // spec tolerances: EPA/DHA 10% (formulation-level differences),
  // SPF / storage exact (discrete consumer choices), wattage/battery 10%,
  // screen size 5% (1.0 vs 1.1 inch is borderline; 6.1 vs 6.7 is real).
  const extendedSpecs = [
    ['epa',     /(\d+)\s*(?:mg\s+)?epa\b/gi,                                  1.10, 0.90],
    ['dha',     /(\d+)\s*(?:mg\s+)?dha\b/gi,                                  1.10, 0.90],
    ['spf',     /\bspf\s*(\d+)/gi,                                            null, null],
    ['wattage', /\b(\d+)\s*(?:w|watt|watts)\b/gi,                             1.10, 0.90],
    ['battery', /\b(\d+)\s*mah\b/gi,                                          1.10, 0.90],
    ['screen',  /\b(\d+(?:\.\d+)?)\s*(?:inch|"|inches)\b/gi,                  1.05, 0.95],
  ];
  for (const [name, re, hi, lo] of extendedSpecs) {
    if (!ourSpecs[name]) continue;
    const found = collect(re, 1, null, null);
    const hit = checkConflict(found, ourSpecs[name], hi, lo);
    if (hit) {
      conflicts.push({
        type: name,
        ours: `${ourSpecs[name]}${name === 'spf' ? ' SPF' : ''}`,
        theirs: `${hit.value}${name === 'spf' ? ' SPF' : ''}`,
      });
    }
  }

  // Storage (separate because it carries a unit).
  if (ourSpecs.storage) {
    const found = collect(/\b(\d+)\s*(gb|tb)\b/gi, 1, 2, (ourSpecs.storageUnit || '').toLowerCase());
    const hit = checkConflict(found, ourSpecs.storage, null, null);
    if (hit) {
      conflicts.push({
        type: 'storage',
        ours: `${ourSpecs.storage}${(ourSpecs.storageUnit || '').toUpperCase()}`,
        theirs: `${hit.value}${(hit.unit || '').toUpperCase()}`,
      });
    }
  }

  return conflicts;
}
