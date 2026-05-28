// amazon-reader.js — content script on https://www.amazon.{in,com}/*
//
// Two RPC actions, driven from the background service worker:
//   AMAZON_GET_SUGGESTIONS  — type a keyword into Amazon's search input,
//                             wait for the autosuggest dropdown, return
//                             the suggestion strings.
//   AMAZON_GET_RESULTS      — scrape the current Amazon search-results
//                             page for product listings (title / price /
//                             rating / reviews / brand / ASIN).
//
// The completion API (completion.amazon.in) returns HTTP 502 to non-browser
// callers, so we drive the UI instead. Same approach as kp.js for Google KP.

(function () {
  if (window.__adbrainAmazonReady) return;
  window.__adbrainAmazonReady = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand  = (a, b) => a + Math.random() * (b - a);

  // ============ RPC ============
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'AMAZON_PING') {
      sendResponse({ ok: true, ready: true });
      return false;
    }
    if (msg?.type === 'AMAZON_GET_SUGGESTIONS') {
      getSuggestions(String(msg.keyword || ''))
        .then(suggestions => sendResponse({ ok: true, suggestions }))
        .catch(err => sendResponse({ ok: false, suggestions: [], error: err?.message || String(err) }));
      return true;
    }
    if (msg?.type === 'AMAZON_GET_RESULTS') {
      try {
        sendResponse({ ok: true, results: scrapeSearchResults() });
      } catch (e) {
        sendResponse({ ok: false, results: [], error: e?.message || String(e) });
      }
      return false;
    }
  });

  // ============ Autosuggest ============
  //
  // Amazon's autocomplete listens for REAL KeyboardEvents — not just an
  // `input` event with a `value` set programmatically. A plain
  // `input.value = '...'` + `input.dispatchEvent(new Event('input'))` is
  // ignored by Amazon's handler because the synthetic event carries no
  // keyCode/which/code. The fix is to simulate per-character typing with
  // KeyboardEvents that carry the actual keyCode, AND set the value via
  // the native setter so React-style state updates fire.
  async function getSuggestions(keyword) {
    const input = document.querySelector(
      '#twotabsearchtextbox, input[name="field-keywords"], input.nav-input, input[type="text"][role="searchbox"]'
    );
    if (!input) throw new Error('Amazon search input not found');

    input.focus();
    input.click();
    _setInputValue(input, '');
    await sleep(Math.round(rand(200, 350)));

    // Type character-by-character — Amazon's autocomplete handler watches
    // for keydown/input/keyup sequences with proper key codes.
    for (let i = 0; i < keyword.length; i++) {
      const char = keyword[i];
      const upper = char.toUpperCase();
      const keyCode = upper.charCodeAt(0);
      const codeName = /[A-Z]/.test(upper) ? `Key${upper}` :
                       (char === ' ' ? 'Space' :
                        /[0-9]/.test(char) ? `Digit${char}` : '');
      _dispatchKey(input, 'keydown', char, codeName, keyCode);
      // Set partial value via native setter so React picks it up.
      _setInputValue(input, keyword.slice(0, i + 1));
      _dispatchKey(input, 'keyup',   char, codeName, keyCode);
      // Slightly slower for the first few chars — gives Amazon's debounced
      // autocomplete time to start fetching.
      await sleep(i < 3 ? Math.round(rand(80, 130)) : Math.round(rand(40, 80)));
    }

    let suggestions = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      await sleep(200);
      suggestions = readDropdown();
      if (suggestions.length > 0) break;
    }

    // Fallback: bump the input again. Sometimes the dropdown closes when
    // focus shifts during scripted typing.
    if (suggestions.length === 0) {
      input.click();
      input.focus();
      // Press space then backspace — a no-op typing burst that re-triggers
      // the autocomplete fetch on the current value.
      _dispatchKey(input, 'keydown', ' ', 'Space', 32);
      _dispatchKey(input, 'keyup',   ' ', 'Space', 32);
      _setInputValue(input, keyword);
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(300);
        suggestions = readDropdown();
        if (suggestions.length > 0) break;
      }
    }

    // Diagnostic — surface what we observed so the user can paste the log
    // and we can update selectors / handlers if Amazon rotates them.
    try {
      const visible = !!document.querySelector(
        '.s-suggestion, [role="listbox"], #suggestions, .autocomplete-results-container'
      );
      chrome.runtime.sendMessage({
        action: 'logFromContent',
        source: 'amazon-reader',
        text: `Amazon autosuggest: input.value="${input.value}" suggestions=${suggestions.length} dropdownVisible=${visible}`,
      }).catch(() => {});
    } catch {}

    return suggestions;
  }

  function _setInputValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function _dispatchKey(el, type, char, code, keyCode) {
    try {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: char,
        code: code || '',
        keyCode: keyCode || 0,
        which:   keyCode || 0,
        charCode: type === 'keypress' ? (keyCode || 0) : 0,
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
  }

  function readDropdown() {
    const out = [];
    const pushUnique = (text) => {
      if (!text) return;
      const t = text.trim();
      if (t.length < 2 || t.length > 120) return;
      if (out.includes(t)) return;
      out.push(t);
    };

    // Sweep every container Amazon might use for the autosuggest dropdown.
    const containers = document.querySelectorAll(
      '#suggestions, .autocomplete-results-container, #nav-flyout-searchAjax, ' +
      '[class*="suggestion"], [role="listbox"], #search-autocomplete, .nav-search-autocomplete'
    );

    for (const container of containers) {
      if (!container || container.offsetHeight < 10) continue;

      // Diagnostic — log the raw DOM so we can update selectors when Amazon
      // rotates them. Truncated to keep the bg log readable.
      try {
        chrome.runtime.sendMessage({
          action: 'logFromContent',
          source: 'amazon-reader',
          text: `Amazon dropdown DOM: tag=${container.tagName} id="${container.id}" ` +
                `class="${(container.className || '').toString().slice(0, 80)}" ` +
                `childCount=${container.children.length} ` +
                `html="${(container.innerHTML || '').slice(0, 300).replace(/\n/g, ' ')}"`,
        }).catch(() => {});
      } catch {}

      // Strategy 1: data-suggestion attribute.
      container.querySelectorAll('[data-suggestion]').forEach(el => {
        pushUnique(el.getAttribute('data-suggestion') || '');
      });
      if (out.length > 0) break;

      // Strategy 2: known suggestion classes.
      container.querySelectorAll('.s-suggestion, .s-suggestion-text, .suggestion-text').forEach(el => {
        pushUnique(el.textContent || '');
      });
      if (out.length > 0) break;

      // Strategy 3: aria-tagged options / list items.
      container.querySelectorAll('[role="option"], li').forEach(el => {
        pushUnique(el.getAttribute('aria-label') || el.textContent || '');
      });
      if (out.length > 0) break;

      // Strategy 4: direct children with reasonable single-line text.
      for (const child of container.children) {
        const text = (child.textContent || '').trim();
        if (
          text.length >= 2 && text.length <= 120 &&
          !text.includes('\n') &&
          child.children.length <= 5
        ) {
          pushUnique(text);
        }
      }
      if (out.length > 0) break;
    }

    return out.slice(0, 15);
  }

  // ============ Search-results scraping ============
  function scrapeSearchResults() {
    const cards = document.querySelectorAll(
      '[data-component-type="s-search-result"], [data-asin][data-component-type], div.s-result-item[data-asin]'
    );
    const out = [];
    const diagSamples = [];
    cards.forEach((card, idx) => {
      const asin = card.getAttribute('data-asin') || '';
      if (!asin) return; // skip non-product slots
      // Amazon's <h2> typically contains TWO spans — a short "brand snippet"
      // and the longer real product title. Earlier we grabbed the first span
      // and ended up with "Now Foods" instead of "Now Foods Alfalfa 650mg...".
      // Strategy: pick the LONGEST span text inside the card's h2.
      let title = '';
      const h2 = card.querySelector('h2');
      if (h2) {
        let longest = '';
        h2.querySelectorAll('span').forEach(span => {
          const text = (span.textContent || '').trim();
          if (text.length > longest.length) longest = text;
        });
        title = longest || (h2.textContent || '').trim();
      }
      // Known full-title class fallback — only replace if longer than what we have.
      if (!title || title.length < 10) {
        for (const sel of [
          '.a-size-medium.a-color-base.a-text-normal',
          '.a-size-base-plus.a-color-base.a-text-normal',
          'h2 a',
        ]) {
          const el = card.querySelector(sel);
          const t = (el?.textContent || '').trim();
          if (t.length > title.length) title = t;
        }
      }
      // Last-resort fallbacks.
      if (!title) {
        const linkAria = card.querySelector('h2 a, a.a-link-normal')?.getAttribute('aria-label');
        if (linkAria && linkAria.length >= 3) title = linkAria.trim();
      }
      if (!title) {
        const imgAlt = card.querySelector('.s-image, img[data-image-latency="s-product-image"]')?.getAttribute('alt');
        if (imgAlt && imgAlt.length >= 3) title = imgAlt.trim();
      }

      const priceWhole    = (card.querySelector('.a-price .a-price-whole')?.textContent || '').trim();
      const priceFraction = (card.querySelector('.a-price .a-price-fraction')?.textContent || '').trim();
      const priceSymbol   = (card.querySelector('.a-price .a-price-symbol')?.textContent || '₹').trim();
      const price = priceWhole
        ? `${priceSymbol}${priceWhole}${priceFraction ? '.' + priceFraction : ''}`
        : '';
      const origPrice =
        (card.querySelector('.a-price[data-a-strike] .a-offscreen, .a-text-price .a-offscreen')?.textContent || '').trim();

      // Rating: ".a-icon-alt" carries "4.6 out of 5 stars".
      const ratingText = (card.querySelector('.a-icon-alt')?.textContent || '').trim();
      const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
      const rating = ratingMatch ? ratingMatch[1] : '';
      // Review count.
      const reviewEl = card.querySelector(
        '[aria-label*="ratings"], .a-size-base.s-underline-text, a[href*="#customerReviews"]'
      );
      const reviewCount = ((reviewEl?.textContent || '').match(/[\d,]+/) || [''])[0];

      // Brand row / "by X". Best-effort — these classes rotate.
      // Extract from selectors that DON'T overlap the title spans, so the
      // brand field doesn't end up duplicating part of the product name.
      let brand = '';
      for (const sel of [
        '.a-row .a-size-base.a-link-normal',
        '.puis-bold-weight-text',
        '.a-size-base-plus.a-color-base:not(.a-text-normal)',
        '.s-label-popover-default span',
      ]) {
        const el = card.querySelector(sel);
        const t = (el?.textContent || '').trim();
        if (t.length > 2 && t.length < 50) { brand = t; break; }
      }

      const imgEl = card.querySelector('.s-image, img[data-image-latency="s-product-image"]');
      const imgSrc = (imgEl && (imgEl.currentSrc || imgEl.src)) || '';
      const link = card.querySelector('h2 a')?.href || '';
      const sponsored = !!card.querySelector(
        '.puis-label-popover-default, [data-component-type="sp-sponsored-result"]'
      );
      const delivery = (
        card.querySelector('[data-csa-c-delivery-price], .a-color-base.a-text-bold')?.textContent || ''
      ).trim().slice(0, 80);
      const hasPrime = !!card.querySelector('.a-icon-prime, [aria-label*="Prime"]');

      out.push({
        position: idx + 1,
        asin, title, price, origPrice, rating, reviewCount, brand,
        imgSrc, link, sponsored, delivery, hasPrime,
      });

      // Diagnostic — capture first 3 cards so we can verify scraping picked
      // up the right fields (and update selectors when Amazon rotates them).
      if (diagSamples.length < 3) {
        diagSamples.push(
          `card[${idx + 1}] asin=${asin || '?'} title="${(title || '').slice(0, 80)}" price="${price}" brand="${(brand || '').slice(0, 40)}"`
        );
      }
    });
    try {
      chrome.runtime.sendMessage({
        action: 'logFromContent',
        source: 'amazon-reader',
        text: `Amazon scrape: cards=${cards.length} kept=${out.length}\n  ${diagSamples.join('\n  ')}`,
      }).catch(() => {});
    } catch {}
    return out;
  }
})();
