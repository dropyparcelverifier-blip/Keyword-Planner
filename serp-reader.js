// serp-reader.js — content script on https://www.google.com/search*
//
// RENDERED-AND-VISIBLE image collector. Only picks up <img> and <picture>
// elements that are:
//   - actually attached to the DOM
//   - have non-zero rendered size
//   - have an actual loaded `src` (naturalWidth > 0 or src starts with http)
//   - are not display:none, visibility:hidden, or opacity:0
//   - are not inside collapsed/hidden carousel slides, hidden tabs, or
//     placeholder skeleton containers
//
// Skips:
//   - <script> JSON blobs (those are data, not rendered pixels)
//   - off-screen / unrendered lazy-load tiles (Google preloads many it never
//     shows in a normal session)
//   - background-image CSS on element types that aren't visual product tiles
//   - tiny chrome (logos, icons, UI sprites) by min-size filter
//   - hidden header/footer/nav

(function () {
  if (window.__adbrainSERPReady) return;
  window.__adbrainSERPReady = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'SERP_PING') {
      sendResponse({ ok: true, ready: true });
      return false;
    }
    if (msg?.type === 'GET_PAGE_THUMBNAILS') {
      (async () => {
        try {
          // CAPTCHA / unusual-traffic page check — Google blocks scraping
          // when it detects automation. Tell the engine to STOP, not retry.
          if (detectCaptcha()) {
            sendResponse({ ok: false, urls: [], captcha: true, error: 'CAPTCHA / unusual-traffic page detected' });
            return;
          }
          await waitForResults();
          if (detectCaptcha()) {
            sendResponse({ ok: false, urls: [], captcha: true, error: 'CAPTCHA / unusual-traffic page detected' });
            return;
          }
          const urls = await collectAllThumbnails();
          sendResponse({ ok: true, urls });
        } catch (e) {
          sendResponse({ ok: false, urls: [], error: e.message });
        }
      })();
      return true;
    }

    // Combined endpoint — returns BOTH thumbnails (for image matching) and
    // People Also Ask questions (for keyword discovery) from a single SERP
    // load. Engine pacing assumes ONE SERP load per product, so we extract
    // everything we need on that single visit.
    if (msg?.type === 'GET_PAGE_DATA') {
      (async () => {
        try {
          if (detectCaptcha()) {
            sendResponse({ ok: false, urls: [], paa: [], sellers: [], totalSellers: 0, adsOnSerp: 0, relatedSearches: [], captcha: true, error: 'CAPTCHA / unusual-traffic page detected' });
            return;
          }
          await waitForResults();
          if (detectCaptcha()) {
            sendResponse({ ok: false, urls: [], paa: [], sellers: [], totalSellers: 0, adsOnSerp: 0, relatedSearches: [], captcha: true, error: 'CAPTCHA / unusual-traffic page detected' });
            return;
          }
          const urls            = await collectAllThumbnails();
          const paa             = collectPAAQuestions();
          const sellerData      = collectAllSellers();
          const relatedSearches = collectRelatedSearches();
          // Source breakdown for the engine log — e.g.
          //   { shopping_carousel: 5, knowledge_panel: 4, organic: 2 }
          const sourceBreakdown = {};
          for (const u of urls) {
            const s = (u && u.source) || 'organic';
            sourceBreakdown[s] = (sourceBreakdown[s] || 0) + 1;
          }
          sendResponse({
            ok: true,
            urls,
            paa,
            sellers: sellerData.sellers,
            totalSellers: sellerData.totalSellers,
            adsOnSerp: sellerData.adsOnSerp,
            relatedSearches,
            sourceBreakdown,
          });
        } catch (e) {
          sendResponse({ ok: false, urls: [], paa: [], sellers: [], totalSellers: 0, adsOnSerp: 0, relatedSearches: [], error: e.message });
        }
      })();
      return true;
    }
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand  = (a, b) => a + Math.random() * (b - a);

  async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { if (predicate()) return true; } catch {}
      await sleep(intervalMs);
    }
    return false;
  }

  function detectCaptcha() {
    // URL-based: Google redirects to /sorry/ for unusual-traffic challenges
    if (location.pathname.startsWith('/sorry/') || location.hostname.includes('sorry.')) return true;
    // Text-based: well-known CAPTCHA / unusual-traffic phrases
    const text = (document.body?.innerText || '').toLowerCase();
    const markers = [
      "i'm not a robot",
      'unusual traffic',
      'verify you are a human',
      "verify you're a human",
      'detected unusual',
      'before continuing to google search',
      'our systems have detected',
    ];
    for (const m of markers) if (text.includes(m)) return true;
    // DOM-based: a reCAPTCHA widget rendered on the page
    if (document.querySelector('[id^="recaptcha"], iframe[src*="recaptcha"], #captcha-form')) return true;
    return false;
  }

  async function waitForResults() {
    const ok = await waitFor(() => document.querySelector('#search, #rso, div[data-async-context]'),
      { timeoutMs: 12000 });
    if (!ok) throw new Error('SERP main results never appeared');
  }

  // ============ SERP DOM diagnostic ============
  //
  // Google rewrites class names frequently. When the specific collectors
  // come back empty but the user's screenshot clearly shows product images,
  // we need to know WHICH containers Google is using right now. This dump
  // logs container presence + the first few visible <img> elements'
  // positions, dimensions, alt text, and closest known container.
  //
  // Only runs when the specific collectors return 0 images — keeps log
  // volume sane during normal runs.
  function diagnoseSERP() {
    const containers = {
      '#search':                       !!document.querySelector('#search'),
      '#rso':                          !!document.querySelector('#rso'),
      '#rhs':                          !!document.querySelector('#rhs'),
      '#tads':                         !!document.querySelector('#tads'),
      '#bottomads':                    !!document.querySelector('#bottomads'),
      '.commercial-unit-desktop-top':  !!document.querySelector('.commercial-unit-desktop-top'),
      '.cu-container':                 !!document.querySelector('.cu-container'),
      '[data-pla]':                    document.querySelectorAll('[data-pla]').length,
      '.pla-unit':                     document.querySelectorAll('.pla-unit').length,
      '.sh-dgr__grid-result':          document.querySelectorAll('.sh-dgr__grid-result').length,
      '.kp-wholepage':                 !!document.querySelector('.kp-wholepage'),
      '.knowledge-panel':              !!document.querySelector('.knowledge-panel'),
      '.kp-blk':                       document.querySelectorAll('.kp-blk').length,
      '.IVvPP':                        document.querySelectorAll('.IVvPP').length,
      '.wDYxhc':                       document.querySelectorAll('.wDYxhc').length,
      '.Wt5Tfe':                       document.querySelectorAll('.Wt5Tfe').length,
      '.MjjYud':                       document.querySelectorAll('.MjjYud').length,
      '[data-attrid]':                 document.querySelectorAll('[data-attrid]').length,
    };
    const all = Array.from(document.querySelectorAll('img'));
    let visible = 0, loaded = 0, http = 0;
    const samples = [];
    const probeSel = '.commercial-unit-desktop-top, .pla-unit, .cu-container, .kp-blk, .kp-wholepage, #rhs, .sh-dgr__grid-result, [data-pla], .IVvPP, .wDYxhc, .MjjYud, #tads, #search, #rso';
    for (let i = 0; i < all.length; i++) {
      const img = all[i];
      const isVis = isElementVisible(img);
      const isLoad = imageHasLoaded(img);
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      const isHttp = typeof src === 'string' && src.startsWith('http');
      if (isVis)  visible++;
      if (isLoad) loaded++;
      if (isHttp) http++;
      if (samples.length < 8 && isVis) {
        const r = img.getBoundingClientRect();
        const c = img.closest(probeSel);
        samples.push({
          w: Math.round(r.width),
          h: Math.round(r.height),
          natW: img.naturalWidth,
          loaded: isLoad,
          container: c ? (c.tagName.toLowerCase() + '.' + (c.className || '').toString().split(/\s+/).slice(0, 2).join('.')).slice(0, 50) : 'NONE',
          alt: (img.alt || '').slice(0, 50),
          src: src.slice(0, 80),
        });
      }
    }

    // Shopping-carousel investigation: find the "Sponsored products" /
    // "Shop ..." heading and walk up the DOM until we hit a container with
    // ≥ 3 images. That container's class is the current class name Google
    // is using for the shopping carousel — paste it into the engine's
    // shopping selectors when this changes (which it does every few months).
    let shoppingInfo = null;
    const sponsoredHeading = Array.from(document.querySelectorAll('div, span, h2, h3, h4'))
      .find(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t === 'sponsored products' || t === 'shop products' ||
               t.startsWith('sponsored') || t.startsWith('shop ');
      });
    if (sponsoredHeading) {
      let container = sponsoredHeading;
      for (let depth = 0; depth < 6 && container; depth++) {
        container = container.parentElement;
        if (!container) break;
        const imgs = container.querySelectorAll('img');
        if (imgs.length >= 3) {
          const firstImg = imgs[0];
          shoppingInfo = {
            depth,
            tag: container.tagName.toLowerCase(),
            cls: (container.className || '').toString().slice(0, 100),
            id:  container.id || '',
            imgs: imgs.length,
            firstSrc: ((firstImg.currentSrc || firstImg.src || '') + '').slice(0, 80),
            firstDataSrc: (firstImg.getAttribute('data-src') || '').slice(0, 80),
            firstAlt: (firstImg.alt || '').slice(0, 80),
          };
          break;
        }
      }
    }

    // #tads probe — top-of-page ad slot
    const tadsDiv = document.getElementById('tads');
    let tadsInfo = null;
    if (tadsDiv) {
      const tadsImgs = tadsDiv.querySelectorAll('img');
      const f = tadsImgs[0];
      tadsInfo = {
        imgs: tadsImgs.length,
        firstSrc: f ? ((f.currentSrc || f.src || '') + '').slice(0, 80) : '',
        firstAlt: f ? (f.alt || '').slice(0, 80) : '',
      };
    }

    return { totalImgs: all.length, visible, loaded, http, containers, samples, shoppingInfo, tadsInfo };
  }

  // Brief lazy-load-triggering scroll, then read visible images from every
  // SERP region. The original implementation only walked `document.images`
  // which missed images inside the shopping carousel and the knowledge
  // panel (RHS / AI Overview). Those regions hold the highest-signal
  // thumbnails for brand keywords — Google literally shows our product
  // there. Add region-specific collectors and dedupe across all of them.
  async function collectAllThumbnails() {
    const startY = window.scrollY;
    await sleep(Math.round(rand(200, 350)));

    const maxY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const viewportH = window.innerHeight;

    // Wider scroll sweep — earlier we capped at 2.5× viewport, which missed
    // the shopping carousel on tall SERPs. Scroll up to 3× viewport so the
    // intersection-observer-based lazy thumbnails get a chance to fetch.
    const targetBottom = Math.min(maxY, viewportH * 3);
    let y = window.scrollY;
    for (let yy = viewportH * 0.5; yy <= targetBottom; yy += viewportH * 0.7) {
      window.scrollTo({ top: yy, behavior: 'smooth' });
      await sleep(Math.round(rand(250, 450)));
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    // Longer settle wait — gives lazy thumbnails (data:image/gif placeholders)
    // time to swap to the real JPEG/PNG before our collectors snapshot src.
    await sleep(Math.round(rand(700, 1000)));

    const mergeInto = (map, item) => {
      if (item && item.url && !map.has(item.url)) map.set(item.url, item);
    };
    const runCollectors = (map) => {
      const shopping  = collectShoppingCarouselImages();
      const kp        = collectKnowledgePanelImages();
      const imagePack = collectImagePackImages();
      const sponsored = collectSponsoredImages();
      const organic   = readVisibleImageSources().map(r => ({ ...r, source: r.source || 'organic' }));
      const bg        = collectBackgroundImages();
      const fallback  = collectAllVisibleImages();
      for (const item of [...shopping, ...kp, ...imagePack, ...sponsored, ...organic, ...bg, ...fallback]) {
        mergeInto(map, item);
      }
    };

    const seen = new Map();
    runCollectors(seen);

    // If the first pass came back sparse, the lazy-loader was still mid-flight.
    // Wait another beat and re-run the collectors — placeholder GIFs have
    // typically been replaced with the real product image by now.
    if (seen.size < 5) {
      await sleep(Math.round(rand(1000, 1500)));
      runCollectors(seen);
    }

    if (startY !== 0) window.scrollTo(0, startY);
    const merged = Array.from(seen.values());

    // Diagnostic dump if we still came back empty — tells us WHICH Google
    // containers exist on the page so the user can paste the log and the
    // specific zone selectors can be updated.
    if (merged.length === 0) {
      try {
        const d = diagnoseSERP();
        chrome.runtime.sendMessage({
          action: 'logFromContent', source: 'serp-reader', kind: 'err',
          text: `SERP DIAG: 0 images captured. total=${d.totalImgs} visible=${d.visible} loaded=${d.loaded} http=${d.http}`,
        }).catch(() => {});
        const containerSummary = Object.entries(d.containers)
          .map(([k, v]) => `${k}=${v}`).join(', ');
        chrome.runtime.sendMessage({
          action: 'logFromContent', source: 'serp-reader',
          text: `SERP DIAG containers: ${containerSummary}`,
        }).catch(() => {});
        if (d.shoppingInfo) {
          const s = d.shoppingInfo;
          chrome.runtime.sendMessage({
            action: 'logFromContent', source: 'serp-reader',
            text: `SERP DIAG shopping: <${s.tag}>.${s.cls} #${s.id} imgs=${s.imgs} firstAlt="${s.firstAlt}" firstSrc="${s.firstSrc}"`,
          }).catch(() => {});
        }
        if (d.tadsInfo) {
          const t = d.tadsInfo;
          chrome.runtime.sendMessage({
            action: 'logFromContent', source: 'serp-reader',
            text: `SERP DIAG #tads imgs=${t.imgs} firstAlt="${t.firstAlt}" firstSrc="${t.firstSrc}"`,
          }).catch(() => {});
        }
        for (const s of d.samples) {
          chrome.runtime.sendMessage({
            action: 'logFromContent', source: 'serp-reader',
            text: `  IMG ${s.w}x${s.h} natW=${s.natW} container="${s.container}" alt="${s.alt}" src="${s.src}"`,
          }).catch(() => {});
        }
      } catch {}
    }
    return merged;
  }

  // ---------- Region-specific image collectors ----------
  //
  // Each returns the same {url, seller, price, title, alt, titleAttr,
  // linkText, source} shape as readVisibleImageSources so the merger can
  // dedupe by URL with first-occurrence-wins semantics.

  function _imgPasses(img) {
    if (!isElementVisible(img)) return false;
    // imageHasLoaded is OK to skip here — many shopping/KP thumbs use
    // lazy-loading and the real URL lives in data-* before decode finishes.
    return true;
  }
  // Image-source filter:
  //   • http(s) URLs — always allow
  //   • data:image/jpeg | data:image/png — allow (Google inlines small
  //     product thumbnails as base64 — these are the ONLY images on many
  //     SERP regions). Stripped at export time so the CSV stays small.
  //   • data:image/gif placeholder — reject (1×1 lazy-load placeholders)
  //   • data:image/svg / *.svg — reject (CLIP can't decode SVG)
  function _acceptableImageSrc(src) {
    if (!src || typeof src !== 'string') return false;
    if (src.toLowerCase().endsWith('.svg')) return false;
    if (src.startsWith('data:image/gif')) return false;
    if (src.startsWith('data:image/svg')) return false;
    if (src.startsWith('data:image/jpeg')) return true;
    if (src.startsWith('data:image/png'))  return true;
    if (src.startsWith('data:image/webp')) return true; // shopping carousel inlines as webp
    if (src.startsWith('data:')) return false;          // any other data:* — reject
    if (src.startsWith('http')) return src.length <= 5000;
    return false;
  }
  function _pushImgRecord(out, img, source) {
    const src = getHighResSrc(img);
    if (!_acceptableImageSrc(src)) return;
    const ctx = extractImageContext(img);
    out.push({
      url: src,
      seller:    ctx.seller    || '',
      price:     ctx.price     || '',
      title:     ctx.title     || '',
      alt:       ctx.alt       || '',
      titleAttr: ctx.titleAttr || '',
      linkText:  ctx.linkText  || '',
      source,
    });
  }

  // Strategy 1 — Google's class names rotate every few months. Find the
  // shopping carousel by its visible heading text ("Sponsored products" /
  // "Shop ..." / "Sponsored") and walk up the DOM until we hit an ancestor
  // with ≥ 3 images. That ancestor IS the carousel — regardless of what
  // class name Google is using this week.
  function _shoppingContainerFromHeading() {
    const els = document.querySelectorAll('div, span, h2, h3, h4');
    for (const el of els) {
      const t = (el.textContent || '').trim();
      const tl = t.toLowerCase();
      // Exact-match the short heading variants; partial-match avoids
      // accidentally grabbing prose containing the phrase.
      if (tl !== 'sponsored products' && tl !== 'sponsored' &&
          tl !== 'shop products' && !tl.startsWith('shop ')) continue;
      let parent = el.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        const imgs = parent.querySelectorAll('img');
        if (imgs.length >= 3) return parent;
        parent = parent.parentElement;
      }
    }
    return null;
  }

  // Shopping carousel images often have empty alt text + data:image/png src,
  // so extractImageContext can't pull title/price/seller from the img's
  // ancestors. Instead, identify each PRODUCT CARD (usually an <a href>
  // wrapping the img) and parse its full text content for title / price /
  // seller. Patches the record we just pushed.
  function _enrichShoppingFromCard(record, img) {
    const card = img.closest('a[href]') || img.closest('[data-docid]') || img.parentElement?.parentElement;
    if (!card) return;
    const text = (card.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) return;
    // Title — first substantial run of letters; skip if we already have one.
    if (!record.title || record.title.length < 5) {
      const titleM = text.match(/([A-Z][\w&,'.\- ]{10,90})/);
      if (titleM) record.title = titleM[1].trim();
    }
    // Price.
    if (!record.price) {
      const priceM = text.match(/(?:Rs\.?\s?|INR\s?|\$|€|£|¥|₹)\s?\d[\d,]*(?:\.\d{1,2})?/);
      if (priceM) record.price = priceM[0].trim();
    }
    // Seller domain — "from amazon.in", "by nowfoods.com", or any *.com / .in
    if (!record.seller) {
      const sellerM = text.match(/\b(?:from|by)\s+([\w.-]+\.(?:com|in|co\.in|co\.uk|net|org|store))/i)
                    || text.match(/\b([\w.-]+\.(?:com|in|co\.in|co\.uk))/i);
      if (sellerM) record.seller = sellerM[1].replace(/^www\./, '');
      // Fallback: nearest a[href] domain
      if (!record.seller) {
        const a = card.querySelector('a[href]') || card;
        if (a && a.href) {
          try {
            const u = new URL(a.href, location.href);
            if (u.hostname && !u.hostname.includes('google.')) {
              record.seller = u.hostname.replace(/^www\./, '');
            }
          } catch {}
        }
      }
    }
    // If alt is empty but title is now populated, mirror it so the
    // multi-signal text-match scorer picks it up (it scans alt/title/link).
    if ((!record.alt || record.alt.length < 5) && record.title) {
      record.alt = record.title;
    }
  }

  // Best-effort: scroll the carousel container into view AND scroll its
  // internal horizontal track to the end and back. Both are synchronous —
  // we can't await image-load here, but collectAllThumbnails has a
  // sparse-retry that re-runs us after a 1-1.5s settle delay if the first
  // pass came back thin. Horizontal scrolling matters for shopping cards
  // that are off-screen to the right and only fetch their image when their
  // intersection observer fires.
  function _kickCarouselLazyLoaders(container) {
    if (!container) return;
    try { container.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch {}
    try {
      const track = container.querySelector('[role="list"]') ||
                    container.querySelector('.sh-sr__shop-result-group') ||
                    container.querySelector('[data-test-id="shopping-carousel"]') ||
                    container;
      if (track && typeof track.scrollLeft === 'number' && track.scrollWidth > track.clientWidth) {
        const origLeft = track.scrollLeft;
        track.scrollLeft = track.scrollWidth;
        // Schedule a reset so the carousel doesn't stay stuck at the end.
        // Reset happens AFTER our snapshot, so any images loaded by the
        // rightward scroll are still visible to the second collector pass.
        setTimeout(() => { try { track.scrollLeft = origLeft; } catch {} }, 800);
      }
    } catch {}
  }

  function collectShoppingCarouselImages() {
    const out = [];
    // Strategy 1: heading-text-anchored discovery — survives Google's
    // periodic class-name churn.
    const headingContainer = _shoppingContainerFromHeading();
    if (headingContainer) {
      _kickCarouselLazyLoaders(headingContainer);
      headingContainer.querySelectorAll('img').forEach(img => {
        // Force-promote a known lazy `data-*` URL into src when the real
        // image hasn't decoded yet (Google ships a 1×1 GIF placeholder
        // until the observer fires).
        if (img.naturalWidth <= 1) {
          const lazy =
            img.getAttribute('data-src') ||
            img.getAttribute('data-iurl') ||
            img.getAttribute('data-deferred-src') || '';
          if (lazy && /^https?:/.test(lazy)) {
            try { img.src = lazy; } catch {}
          }
        }
        if (!_imgPasses(img)) return;
        const before = out.length;
        _pushImgRecord(out, img, 'shopping_carousel');
        if (out.length > before) _enrichShoppingFromCard(out[out.length - 1], img);
      });
    }
    // Strategy 2: known class selectors (still useful when the heading is
    // missing or worded differently). De-dupe happens at the merger.
    const sel = [
      '.commercial-unit-desktop-top',
      '.commercial-unit-mobile-top',
      '.cu-container',
      '.top-pla-group-inner',
      '.sh-pr__product-results',
      '.sh-dgr__grid-result',
      '.sh-dgr__content',
      '.pla-unit',
      '.mnr-c',          // newer shopping-card variant
      '[data-pla]',
      '[data-docid]',
    ].join(', ');
    // Kick lazy-loaders on the WIDEST visible Strategy-2 container before
    // iterating: scrolls the carousel track to the right so off-screen
    // shopping cards fetch their images, then on the next collector pass
    // (sparse-retry in collectAllThumbnails) we capture them.
    const strat2Roots = Array.from(document.querySelectorAll(sel)).filter(isElementVisible);
    if (strat2Roots.length > 0) {
      strat2Roots.sort((a, b) => (b.clientWidth || 0) - (a.clientWidth || 0));
      _kickCarouselLazyLoaders(strat2Roots[0]);
    }
    strat2Roots.forEach(card => {
      card.querySelectorAll('img').forEach(img => {
        if (!_imgPasses(img)) return;
        const before = out.length;
        _pushImgRecord(out, img, 'shopping_carousel');
        if (out.length > before) _enrichShoppingFromCard(out[out.length - 1], img);
      });
    });
    return out;
  }

  function collectKnowledgePanelImages() {
    const out = [];
    const sel = [
      '.kp-wholepage', '.knowledge-panel', '.kp-blk',
      '#rhs', '.MjjYud', '.Wt5Tfe', '.IVvPP', '.wDYxhc',
      '.kno-fb-ctx', '.kno-vrt-t',
    ].join(', ');
    document.querySelectorAll(sel).forEach(panel => {
      if (!isElementVisible(panel)) return;
      panel.querySelectorAll('img').forEach(img => {
        if (_imgPasses(img)) _pushImgRecord(out, img, 'knowledge_panel');
      });
    });
    return out;
  }

  function collectSponsoredImages() {
    const out = [];
    const sel = [
      '[data-text-ad]', '.uEierd', '#tads', '#bottomads',
      '.commercial-unit-desktop-rhs', '.ad_cclk',
    ].join(', ');
    document.querySelectorAll(sel).forEach(ad => {
      if (!isElementVisible(ad)) return;
      ad.querySelectorAll('img').forEach(img => {
        if (_imgPasses(img)) _pushImgRecord(out, img, 'sponsored');
      });
    });
    return out;
  }

  // Google Images "image pack" — a row of related-image tiles that
  // sometimes appears inline among organic results. Different DOM shape
  // from the shopping carousel (uses Google's image-search components).
  function collectImagePackImages() {
    const out = [];
    const sel = [
      '[data-lpage]',
      '.isv-r', '.islir',
      'g-img', 'g-scrolling-carousel img',
      'a[data-jhmaha]', '.isv-r-vi',
    ].join(', ');
    document.querySelectorAll(sel).forEach(tile => {
      if (!isElementVisible(tile)) return;
      // The tile itself may be the <img>, or it may contain one.
      const imgs = tile.tagName === 'IMG' ? [tile] : tile.querySelectorAll('img');
      imgs.forEach(img => {
        if (_imgPasses(img)) _pushImgRecord(out, img, 'image_pack');
      });
    });
    return out;
  }

  // Universal fallback — catches every visible, loaded, HTTP <img> on the
  // page that the specific zone collectors missed. Used as the LAST step
  // so it only fills in gaps. Skips header/footer/nav UI imagery and tiny
  // icons (< 50 px). Tagged source='fallback' so the engine log shows when
  // we had to rely on it (signal that the zone selectors need updating).
  function collectAllVisibleImages() {
    const out = [];
    document.querySelectorAll('img').forEach(img => {
      if (img.closest('header, footer, nav, #searchform, .logo, #logo, #hdtb')) return;
      if (img.closest('video, iframe, [data-video-id], [aria-label*="video" i]')) return;
      if (!isElementVisible(img)) return;
      if (!imageHasLoaded(img)) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return;
      _pushImgRecord(out, img, 'fallback');
    });
    return out;
  }

  // Some product tiles render the image via CSS background-image rather
  // than an <img>. Scan elements with an inline background-image style
  // (cheaper than getComputedStyle on every node) and lift the URL.
  function collectBackgroundImages() {
    const out = [];
    document.querySelectorAll('[style*="background-image"]').forEach(el => {
      if (!isElementVisible(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      const bg = (getComputedStyle(el).backgroundImage || '');
      // Accept http(s) URLs AND data:image/jpeg|png — Google sometimes
      // uses base64 background-images for shopping tiles. Length is
      // bounded so an enormous SVG/font-as-bg can't blow up the report.
      const m = bg.match(/url\(["']?((?:https?:\/\/|data:image\/(?:jpeg|png);)[^"')]+)["']?\)/i);
      if (!m) return;
      const url = m[1];
      // Allow long base64 URLs (typical inline thumb is ~3-15 KB).
      const maxLen = url.startsWith('data:') ? 100_000 : 2000;
      if (url.length < 10 || url.length > maxLen) return;
      if (url.toLowerCase().endsWith('.svg')) return;
      out.push({
        url,
        seller:    '',
        price:     '',
        title:     (el.getAttribute('aria-label') || '').slice(0, 220),
        alt:       '',
        titleAttr: (el.getAttribute('title') || '').slice(0, 220),
        linkText:  '',
        source:    'background_image',
      });
    });
    return out;
  }

  // Visibility check — anchor-trimmed to "actually rendered for the user".
  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    // Zero-sized → not rendered. Tiny size (< 24px) → UI chrome, not product.
    if (rect.width < 24 || rect.height < 24) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden') return false;
    if (style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    // Inside a hidden tab / collapsed carousel slide / aria-hidden region?
    if (el.closest('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"]')) {
      return false;
    }
    return true;
  }

  // Image must have actually loaded (naturalWidth > 0) to count.
  function imageHasLoaded(img) {
    if (img.tagName === 'IMG') {
      // Inline JPEG/PNG thumbnails (Google's MjjYud product cards, KP
      // panels) are "loaded" by definition — the bytes are already in the
      // src attribute, no network decode needed. Without this branch the
      // fallback collector rejects them as `naturalWidth=0` during scroll.
      const src = img.src || '';
      if (src.startsWith('data:image/jpeg') || src.startsWith('data:image/png')) return true;
      return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    }
    return true; // other elements: visibility check already passed
  }

  // Walk up the DOM from an image looking for:
  //   - price text (e.g. "$24.99", "₹450", "Rs. 1,200")
  //   - seller (cite element text, or domain of the nearest <a href>)
  // Returns { seller, price, title }. Empty strings when not found.
  // `title` is the nearest heading / product-card title text — used by the
  // engine to verify CLIP matches: a thumb that visually resembles our
  // product but has a competitor brand in its surrounding text is a false
  // positive.
  function extractImageContext(img) {
    const PRICE_RE = /(?:Rs\.?\s?|INR\s?|\$|€|£|¥|₹)\s?\d[\d,]*(?:\.\d{1,2})?/;
    let scan = img.parentElement;
    let price = '';
    let seller = '';
    let title = '';
    for (let depth = 0; depth < 8 && scan; depth++) {
      if (!price) {
        const text = (scan.innerText || '').slice(0, 800);
        const m = text.match(PRICE_RE);
        if (m) price = m[0].replace(/\s+/g, ' ').trim();
      }
      if (!seller) {
        const cite = scan.querySelector?.('cite');
        if (cite && isElementVisible(cite)) {
          const raw = (cite.innerText || '').trim();
          seller = raw.split(/[›>·•|\s]/)[0].replace(/^https?:\/\//, '').replace(/^www\./, '');
        }
      }
      // Title: prefer the first visible heading / product-title element in
      // this subtree. Google uses .DKV0Md for shopping titles and h3 for
      // organic-result titles; .sh-np__product-title also appears on some
      // shopping cards.
      if (!title) {
        const h = scan.querySelector?.('h3, h4, [role="heading"], .DKV0Md, .sh-np__product-title, .product-title');
        if (h && isElementVisible(h)) {
          title = (h.innerText || h.textContent || '').trim().split('\n')[0].slice(0, 220);
        }
      }
      // Shopping-card structure: <a href><img/><div>title</div><div>price</div></a>.
      // When we walk up and hit an <a>, grab its plain-text content if no
      // title found yet — the inner <div>s usually have no class names and
      // no headings, just raw text.
      if (!title && scan.tagName === 'A' && scan.href) {
        const fullText = (scan.innerText || '').trim();
        if (fullText.length > 10) {
          const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
          if (lines.length > 0) title = lines[0].slice(0, 220);
        }
      }
      if (price && seller && title) break;
      scan = scan.parentElement;
    }
    // Fallback seller: domain of the nearest outbound <a> link
    if (!seller) {
      const a = img.closest('a[href]');
      if (a) {
        try {
          const u = new URL(a.href, location.href);
          if (u.hostname && !u.hostname.includes('google.com')) {
            seller = u.hostname.replace(/^www\./, '');
          }
        } catch {}
      }
    }
    // Sibling-text fallback — for layouts where the title sits in a sibling
    // <div> rather than a parent (common in shopping carousel tiles).
    // Looks at the img.parentElement's siblings for short text blocks.
    if (!title && img.parentElement) {
      const grandparent = img.parentElement.parentElement;
      if (grandparent) {
        for (const sibling of grandparent.children) {
          if (sibling === img.parentElement) continue;
          const txt = (sibling.innerText || '').trim();
          if (txt.length > 10 && txt.length < 300) {
            const firstLine = txt.split('\n')[0].trim();
            if (firstLine.length > 5) {
              title = firstLine.slice(0, 220);
              if (!price) {
                const pm = txt.match(PRICE_RE);
                if (pm) price = pm[0].trim();
              }
              break;
            }
          }
        }
      }
    }
    // Fallback title: the image's own alt text.
    if (!title) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt) title = alt.slice(0, 220);
    }

    // Direct image attributes — independent of nearby DOM. Google often
    // populates alt with the actual product name ("NOW Foods Alfalfa 650mg
    // 250 Tablets") which is the single most reliable brand-identity signal.
    const alt       = (img.getAttribute('alt') || '').trim().slice(0, 220);
    const titleAttr = (img.getAttribute('title') || img.getAttribute('aria-label') || '').trim().slice(0, 220);

    // Nearest outbound link's text — for shopping cards this is usually the
    // full product card label / merchant title.
    let linkText = '';
    const nearestLink = img.closest('a[href]');
    if (nearestLink) {
      linkText = (nearestLink.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220);
    }

    return {
      seller: seller || '',
      price:  price  || '',
      title:  title  || '',
      alt,
      titleAttr,
      linkText,
    };
  }

  // Pull the highest-resolution version we can find for an <img>. Google
  // typically serves a tiny ~100-200px thumb in src; the same image is
  // available at higher resolution through data-* attributes (data-iurl is
  // the Google Images convention) or via size params we can rewrite.
  // Higher-res thumbnails carry more detail → better CLIP recall.
  function getHighResSrc(img) {
    const ALL = [
      img.getAttribute('data-iurl'),
      img.getAttribute('data-thumbnail-url'),
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('srcset'),     // we'll resolve the largest below
      img.currentSrc,
      img.src,
      img.getAttribute('src'),
    ].filter(Boolean);
    // srcset is "url1 1x, url2 2x" — pick the highest-density variant
    for (const v of ALL) {
      if (v.includes(',') && /\s\d+(?:\.\d+)?[xw]\b/.test(v)) {
        const cands = v.split(',').map(s => {
          const [u, d] = s.trim().split(/\s+/);
          const dens = d ? parseFloat(d) : 1;
          return { u, dens: isFinite(dens) ? dens : 1 };
        });
        cands.sort((a, b) => b.dens - a.dens);
        if (cands[0]?.u) return cands[0].u;
      }
    }
    // First plain URL that looks like HTTP(S) — preferred (higher resolution).
    for (const v of ALL) {
      if (typeof v === 'string' && /^https?:/i.test(v)) {
        // For Google's encrypted-tbn URLs, bump the size param when present.
        if (/encrypted-tbn/i.test(v)) {
          return v.replace(/=w\d+/g, '=w400').replace(/=h\d+/g, '=h400').replace(/=s\d+/g, '=s400');
        }
        // For URLs with explicit width/height params, request a larger one.
        try {
          const u = new URL(v);
          let changed = false;
          if (u.searchParams.has('width'))  { u.searchParams.set('width',  '400'); changed = true; }
          if (u.searchParams.has('w'))      { u.searchParams.set('w',      '400'); changed = true; }
          if (u.searchParams.has('size'))   { u.searchParams.set('size',   '400'); changed = true; }
          if (changed) return u.toString();
        } catch {}
        return v;
      }
    }
    // Fallback: inline base64 thumbnails. Google inlines product images as
    // data:image on many SERP regions (MjjYud result cards, knowledge panel
    // tiles, image-pack, shopping carousel). Without this fallback,
    // getHighResSrc returns null for those images and _acceptableImageSrc
    // never gets a chance to approve the data URI it explicitly allows.
    // CLIP can decode base64 images directly; the export layer strips them
    // to [inline-thumbnail]. WebP is included because the current Shopping
    // carousel inlines as data:image/webp on most queries.
    for (const v of ALL) {
      if (typeof v === 'string' && (
        v.startsWith('data:image/jpeg') ||
        v.startsWith('data:image/png')  ||
        v.startsWith('data:image/webp')
      )) {
        return v;
      }
    }
    return null;
  }

  function readVisibleImageSources() {
    const seen = new Map(); // url -> { seller, price }

    document.querySelectorAll('img').forEach(img => {
      if (img.closest('header, footer, nav, #searchform, .logo, #logo, #hdtb')) return;
      if (img.closest('video, iframe, [data-video-id], [data-vimeo-id], [aria-label*="video" i]')) return;
      if (!isElementVisible(img)) return;
      if (!imageHasLoaded(img)) return;
      const src = getHighResSrc(img);
      if (!src) return;
      // Accept http(s) URLs AND data:image/jpeg|png — Google increasingly
      // inlines product thumbnails as base64 (especially in the MjjYud
      // result-card images). They're stripped at export time so the CSV
      // doesn't bloat, but they ARE captured here so CLIP can match them.
      if (!_acceptableImageSrc(src)) return;

      // First occurrence wins for context. Many SERP layouts repeat the same
      // thumbnail URL across multiple cards; the first one is usually the
      // canonical product card.
      if (!seen.has(src)) {
        seen.set(src, extractImageContext(img));
      }
    });

    // Return array of { url, seller, price, title, alt, titleAttr, linkText }.
    // All four text fields together are searched for brand and product-name
    // hits at match time — multi-signal verification beats single-signal.
    const out = [];
    for (const [url, ctx] of seen) {
      out.push({
        url,
        seller:    ctx.seller,
        price:     ctx.price,
        title:     ctx.title,
        alt:       ctx.alt,
        titleAttr: ctx.titleAttr,
        linkText:  ctx.linkText,
      });
    }
    return out;
  }

  // People Also Ask — Google's expandable accordion of related questions.
  // Selectors are best-effort (Google rewrites class names frequently); we
  // walk likely PAA containers first, then fall back to any role="heading"
  // element whose text reads as a question. De-duplicated.
  function collectPAAQuestions() {
    const out = new Set();
    const accept = (raw) => {
      if (!raw) return;
      const text = String(raw).trim().split('\n')[0].trim();
      if (text.length < 8 || text.length > 220) return;
      out.add(text);
    };

    // Most specific: data attributes Google uses for the PAA accordion.
    document.querySelectorAll(
      'div[data-initq], div[jsname][data-question], div.related-question-pair, ' +
      '[data-q], div[aria-expanded][role="button"]'
    ).forEach(el => {
      const dq = el.getAttribute('data-initq') || el.getAttribute('data-q');
      if (dq) accept(dq);
      const heading = el.querySelector('[role="heading"]');
      if (heading) accept(heading.innerText);
    });

    // Fallback — scan heading-role elements that look like questions.
    if (out.size === 0) {
      document.querySelectorAll('[role="heading"]').forEach(h => {
        const text = (h.innerText || '').trim().split('\n')[0].trim();
        if (text.endsWith('?')) accept(text);
      });
    }

    return Array.from(out);
  }

  // ============ collectAllSellers ============
  // Extract every seller/merchant on the page, not just those near matched
  // thumbnails. Looks at shopping cards + organic results + ad-slot count.
  // De-duplicated by domain (first occurrence wins).
  const PRICE_RE_GLOBAL = /(?:Rs\.?\s?|INR\s?|\$|€|£|¥|₹)\s?\d[\d,]*(?:\.\d{1,2})?/;

  function extractDomainFromHref(href) {
    if (!href) return '';
    try {
      const u = new URL(href, location.href);
      // Google wrapper — unwrap to the real destination. Sponsored results
      // wrap via /aclk?...&adurl=...; organic via /url?q=... or /url?url=....
      // Google itself can be google.com / google.co.in / google.in / etc.
      if (/(?:^|\.)google\.[a-z.]+$/i.test(u.hostname)) {
        const real = u.searchParams.get('adurl')
                  || u.searchParams.get('url')
                  || u.searchParams.get('q')
                  || '';
        if (real && /^https?:\/\//i.test(real)) {
          try {
            return new URL(real).hostname.replace(/^www\./, '');
          } catch { return ''; }
        }
        return '';
      }
      // googleusercontent / googleadservices wrappers — also drop, not the
      // real merchant domain.
      if (/googleusercontent|googleadservices|doubleclick/i.test(u.hostname)) {
        return '';
      }
      if (!u.hostname) return '';
      return u.hostname.replace(/^www\./, '');
    } catch { return ''; }
  }

  function extractCiteDomain(el) {
    const cite = el.querySelector?.('cite');
    if (!cite) return '';
    const raw = (cite.innerText || '').trim();
    if (!raw) return '';
    return raw.split(/[›>·•|\s]/)[0].replace(/^https?:\/\//, '').replace(/^www\./, '');
  }

  function extractPrice(el) {
    const text = (el.innerText || '').slice(0, 1200);
    const m = text.match(PRICE_RE_GLOBAL);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  function collectAllSellers() {
    const sellersByDomain = new Map();
    const push = (entry) => {
      if (!entry || !entry.domain) return;
      if (sellersByDomain.has(entry.domain)) return; // first wins
      sellersByDomain.set(entry.domain, entry);
    };

    // 1) Shopping cards / product knowledge panel
    document.querySelectorAll(
      '[data-docid], .sh-dgr__content, .commercial-unit-desktop-top, ' +
      'div[data-attrid*="shopping"], .sh-np__product-title'
    ).forEach(el => {
      if (!isElementVisible(el)) return;
      const titleEl = el.querySelector('h3, .sh-np__product-title, [role="heading"]');
      const title = (titleEl?.innerText || '').trim().split('\n')[0].slice(0, 200);
      const priceEl = el.querySelector('.sh-dgr__price, .a8Pemb, span.a8Pemb');
      const price = (priceEl?.innerText || '').trim() || extractPrice(el);
      const sellerEl = el.querySelector('.sh-dgr__merchant-name, .aULzUe, cite');
      let domain = (sellerEl?.innerText || '').trim().split(/[›>·•|\s]/)[0].replace(/^www\./, '');
      if (!domain) {
        const a = el.querySelector('a[href]');
        domain = extractDomainFromHref(a?.href);
      }
      if (!domain) return;
      push({ domain, title, price, link: el.querySelector('a[href]')?.href || '', source: 'shopping' });
    });

    // 2) Organic results.
    // Prefer the href domain over the <cite> text: Google's cite element
    // can show a different TLD than the actual link (e.g. "amazon.com" cite
    // text on a result that actually points to amazon.in). This caused the
    // report to mis-label Indian sellers as US sellers.
    document.querySelectorAll('#search .g, #rso > div, div[data-hveid]').forEach(el => {
      if (!isElementVisible(el)) return;
      if (el.parentElement && el.parentElement.closest('.g, [data-hveid]') !== null && el.parentElement.closest('.g, [data-hveid]') !== el.parentElement) return;
      const a = el.querySelector('a[href]');
      const hrefDomain = extractDomainFromHref(a?.href);
      const citeDomain = extractCiteDomain(el);
      const domain = hrefDomain || citeDomain;
      if (!domain) return;
      const titleEl = el.querySelector('h3');
      const title = (titleEl?.innerText || '').trim().slice(0, 200);
      const price = extractPrice(el);
      push({ domain, title, price, link: a?.href || '', source: 'organic' });
    });

    // 3) Sponsored / ad results — count only
    const adSlots = document.querySelectorAll(
      'div[data-text-ad], .uEierd, [aria-label="Ads"], [data-pcu]'
    );
    let adsOnSerp = 0;
    adSlots.forEach(el => {
      if (isElementVisible(el)) adsOnSerp++;
    });

    // 4) Knowledge-panel "Shops" — most reliable seller list for brand
    // searches. Google's product knowledge panel (.kp-wholepage / #rhs)
    // hosts a structured Shops tab with seller domain + price per row.
    // Selectors are cast wide because class names rotate.
    const kpShopSelectors = [
      '.kp-wholepage [data-attrid*="price"]',
      '.kp-wholepage [data-attrid*="shop"]',
      '.kp-wholepage [data-attrid*="seller"]',
      '.kp-wholepage .VLkRKc',
      '.kp-wholepage .dGSnJb',
      '.kp-wholepage .LGOjhe',
      '#rhs [data-attrid*="price"]',
      '#rhs [data-attrid*="shop"]',
      '#rhs .VLkRKc',
      '#rhs .dGSnJb',
    ].join(', ');
    document.querySelectorAll(kpShopSelectors).forEach(el => {
      if (!isElementVisible(el)) return;
      // Find a seller domain. Prefer href unwrap (Google redirect → real
      // merchant); fall back to <cite> text inside the panel row.
      const a = el.querySelector('a[href]');
      let domain = extractDomainFromHref(a?.href);
      if (!domain) domain = extractCiteDomain(el);
      if (!domain) return;
      const titleEl = el.querySelector('.VLkRKc, .translate-content, .ellip, h3, [role="heading"]');
      const title = ((titleEl?.innerText || titleEl?.textContent || '')).trim().split('\n')[0].slice(0, 200);
      const price = extractPrice(el);
      push({ domain, title, price, link: a?.href || '', source: 'knowledge_panel_shops' });
    });

    const sellers = Array.from(sellersByDomain.values());
    return { sellers, totalSellers: sellers.length, adsOnSerp };
  }

  // ============ collectRelatedSearches ============
  // "Related searches" anchors at the BOTTOM of the SERP only (#botstuff /
  // #bres). The earlier broader selector (`[data-ved] a`) was matching
  // Google's filter chips at the top of the page (time filters, price
  // ranges, "For Dry Skin", "Past 24 hours") which are NOT real search
  // queries — they pollute downstream KP runs and the report.
  function isFilterChipText(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    const lo = t.toLowerCase();

    // Price-range filters: starts with a currency symbol + digits
    if (/^[₹$€£¥]\s?\d/.test(t)) return true;

    // Mostly-numeric / mostly-punctuation strings (e.g. "₹800 - ₹1,500")
    if (/^[\d₹$€£¥.,\s\-–—]+$/.test(t)) return true;

    // Google time-filter chips
    const TIME_FILTERS = [
      'past hour','past 24 hours','past week','past month','past year',
      'any time','custom range','last hour','last 24 hours','last week',
      'last month','last year',
    ];
    if (TIME_FILTERS.includes(lo)) return true;

    // Short refinement chips that begin with a preposition ("For Dry Skin",
    // "With SPF", "Under ₹500"). Real related searches almost always include
    // a noun phrase that's >= 4 words.
    if (/^(for|with|near|under|over|by|in|from)\s/i.test(t) && t.split(/\s+/).length <= 4) return true;

    // Generic UI / sort options
    const UI_LABELS = [
      'relevance','date','rating','newest','best selling','best sellers',
      'price: low to high','price: high to low','all results','verbatim',
      'images','videos','news','maps','shopping','books','flights','tools',
      'see more','see fewer','show more','show fewer','view all','more',
    ];
    if (UI_LABELS.includes(lo)) return true;

    // Common Indian-SERP category chips (skin/hair/etc.) that match
    // "For X Skin / For All Skin Types / etc." would already be caught above
    // — these are the longer-form ones.
    const CATEGORY_CHIPS = [
      'fragrance free','organic','natural','best seller','top rated',
      'new arrival','featured',
    ];
    if (CATEGORY_CHIPS.includes(lo)) return true;

    return false;
  }

  function collectRelatedSearches() {
    const out = new Set();

    // Bottom-of-page container ONLY. #botstuff is the official Google
    // wrapper for the post-results section that holds related searches.
    // #bres is the legacy fallback (sometimes still present).
    const bottom = document.querySelector('#botstuff') || document.querySelector('#bres');
    if (!bottom) return [];

    // Method 1: explicit "related searches" anchors. Inside #botstuff,
    // any anchor pointing at /search?q= IS a related-search link.
    bottom.querySelectorAll('a[href*="/search"]').forEach(a => {
      const text = (a.innerText || a.textContent || '').trim().split('\n')[0].trim();
      if (text.length < 4 || text.length > 100) return;
      if (isFilterChipText(text)) return;
      if (/^(Images|Videos|News|Maps|Shopping|Books|Flights|Personal|Tools)$/i.test(text)) return;
      out.add(text);
    });

    // Method 2: "People also search for" tiles use data-q attributes.
    bottom.querySelectorAll('[data-q]').forEach(el => {
      const q = el.getAttribute('data-q');
      if (!q) return;
      if (q.length < 4 || q.length > 100) return;
      if (isFilterChipText(q)) return;
      out.add(q.trim());
    });

    return Array.from(out).slice(0, 16);
  }

  function addIfImage(src, out) {
    if (_acceptableImageSrc(src)) out.add(src);
  }
})();
