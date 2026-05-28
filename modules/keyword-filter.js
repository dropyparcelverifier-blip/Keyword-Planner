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

export function extractFormFactor(rawProductName, category) {
  const name = String(rawProductName || '').toLowerCase();
  if (!name) return null;
  const forms = ALL_FORM_FACTORS[category] || ALL_FORM_FACTORS.general;
  for (const form of forms) {
    if (_formRegex(form).test(name)) return form;
  }
  // Fallback: concatenated digit + form word ("250tablets", "60capsules").
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
  if (/\b(creams?|lotions?|serums?|moisturiz|cleansers?|face wash|sunscreens?|toners?|spf|retinol)\b/.test(text)) return 'skincare';
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

export function buildProductContext(productName, handles, detectedCategory) {
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

  // 2-word brand iff second word is a known brand-suffix construction
  // ("Now Foods", "Forest Essentials", "Garden Naturals").
  if (BRAND_SUFFIXES.includes(second)) {
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
  if (hasAnchor && hasCategory) {
    // Tier 3 — generic product query. SERP decides via image match.
    return { relevant: true, tier: 'generic_product', loadSERP: true, expand: 'match_decides', reason: null };
  }
  if (hasAnchor) {
    // Tier 4 — anchor only. Promote to SERP ONLY when there's a commercial
    // signal in the query. Pure educational queries ("what is alfalfa
    // plant", "alfalfa nutrition value") burn a SERP for nothing.
    if (_hasCommercialIntent(kw)) {
      return { relevant: true, tier: 'anchor_only', loadSERP: true, expand: 'match_decides', reason: null };
    }
    return reject('anchor_only_no_commercial');
  }
  if (hasCategory) {
    // Category-only is too generic — would just surface competitors.
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
// Returns `{ match, missingWords }`. Caller decides the penalty (image
// matching uses -30; Amazon matching skips the row entirely).
export function checkProductIdentity(contextText, productContext) {
  if (!productContext) return { match: true, missingWords: [] };
  const coreWords = (productContext.coreTypeWords || []).map(w => String(w || '').toLowerCase()).filter(Boolean);
  if (coreWords.length === 0) return { match: true, missingWords: [] };
  const ctx = String(contextText || '').toLowerCase();
  if (!ctx) return { match: false, missingWords: coreWords };
  const missing = coreWords.filter(w => !ctx.includes(w));
  return { match: missing.length === 0, missingWords: missing };
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

  return specs;
}

// Returns an array of conflict descriptors (one per spec type) when the
// context text mentions a CLEARLY DIFFERENT value for a spec our product
// defines. Tolerances:
//   count   — > 1.5× or < 0.67× (90 vs 180 ❌, 90 vs 100 ✅)
//   dosage  — > 1.3× or < 0.77× same-unit only (650 vs 1000 ❌, 650 vs 700 ✅)
//   volume  — any difference (volume IS the variant on liquids)
//   weight  — any difference (weight IS the variant on bulk products)
//   pack    — any difference
// When the context simply doesn't mention a spec, we don't flag it — the
// page may just be silent on that detail.
export function hasConflictingSpec(contextText, ourSpecs) {
  if (!ourSpecs) return [];
  const ctx = String(contextText || '').toLowerCase();
  if (!ctx) return [];
  const conflicts = [];

  if (ourSpecs.count) {
    const re = /\b(\d+)\s*(capsules?|caps?|tablets?|tabs?|softgels?|vcaps?|veg\s*caps?|caplets?|count)\b/gi;
    let m;
    while ((m = re.exec(ctx)) !== null) {
      const theirs = m[1];
      if (theirs === ourSpecs.count) continue;
      const ratio = parseInt(theirs, 10) / parseInt(ourSpecs.count, 10);
      if (ratio >= 1.5 || ratio <= 0.67) {
        conflicts.push({
          type: 'count',
          ours: `${ourSpecs.count} ${ourSpecs.countUnit || ''}`.trim(),
          theirs: `${theirs} ${m[2]}`,
        });
        break;
      }
    }
  }

  if (ourSpecs.dosage) {
    const re = /\b(\d+(?:\.\d+)?)\s*(mg|mcg|µg|iu|ui)\b/gi;
    const ourUnit = (ourSpecs.dosageUnit || '').toLowerCase();
    let m;
    while ((m = re.exec(ctx)) !== null) {
      if (m[2].toLowerCase() !== ourUnit) continue;
      if (m[1] === ourSpecs.dosage) continue;
      const ratio = parseFloat(m[1]) / parseFloat(ourSpecs.dosage);
      if (ratio >= 1.3 || ratio <= 0.77) {
        conflicts.push({
          type: 'dosage',
          ours: `${ourSpecs.dosage}${ourSpecs.dosageUnit}`,
          theirs: `${m[1]}${m[2]}`,
        });
        break;
      }
    }
  }

  if (ourSpecs.volume) {
    const re = /\b(\d+(?:\.\d+)?)\s*(ml|l|liter|litre|fl\s*oz|fluid\s*oz)\b/gi;
    let m;
    while ((m = re.exec(ctx)) !== null) {
      if (m[1] === ourSpecs.volume) continue;
      conflicts.push({
        type: 'volume',
        ours: `${ourSpecs.volume}${ourSpecs.volumeUnit}`,
        theirs: `${m[1]}${m[2]}`,
      });
      break;
    }
  }

  if (ourSpecs.weight) {
    const re = /\b(\d+(?:\.\d+)?)\s*(g(?!m)|gm|gram|kg|oz|lb|pound)\b/gi;
    let m;
    while ((m = re.exec(ctx)) !== null) {
      if (m[1] === ourSpecs.weight) continue;
      conflicts.push({
        type: 'weight',
        ours: `${ourSpecs.weight}${ourSpecs.weightUnit}`,
        theirs: `${m[1]}${m[2]}`,
      });
      break;
    }
  }

  if (ourSpecs.packSize) {
    const re = /(?:pack\s*of\s*(\d+)|(\d+)\s*-?\s*pack|(twin)\s+pack|(multi)\s*-?\s*pack)/gi;
    let m;
    while ((m = re.exec(ctx)) !== null) {
      const theirs = m[1] || m[2] || (m[3] ? '2' : '2');
      if (theirs === ourSpecs.packSize) continue;
      conflicts.push({
        type: 'pack_size',
        ours: `pack of ${ourSpecs.packSize}`,
        theirs: `pack of ${theirs}`,
      });
      break;
    }
  }

  return conflicts;
}
