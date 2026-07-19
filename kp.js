// kp.js — content script for https://ads.google.com/aw/keywordplanner/*
//
// USER-INITIATED automation of the user's own Google Ads Keyword Planner.
// Drives the "Discover new keywords" flow with human-like timing so the page
// hydrates / animates between each interaction.
//
// Brittle by nature — Google updates KP UI strings. If the flow starts failing,
// update the SELECTORS constant below.

(function () {
  if (window.__adbrainKPReady) return;
  window.__adbrainKPReady = true;

  const SELECTORS = {
    discoverCardTexts: ['Discover new keywords', 'Find new keywords'],
    // Substrings — case-insensitive — used by findSeedInput across aria-label,
    // placeholder, and nearby label text. Add new strings here if Google
    // changes the copy.
    seedInputHints: [
      'enter products or services',
      'enter keywords',
      'enter a product',
      'meal delivery',
      'leather boots',
      'try with a few keywords',
      'keyword input',
      'add another keyword',
    ],
    seedDialogHeadings: ['discover new keywords', 'find new keywords', 'start with keywords'],
    getResultsButtonTexts: ['Get results', 'Get keyword ideas'],
    // "Get search volume and forecasts for your keywords" card on the KP home.
    // Used by the metrics-backfill flow (KP_GET_METRICS) to look up avg
    // monthly searches / competition / bid range for keywords that did NOT
    // come from KP's Discover flow (autosuggest, PAA, related, amazon).
    forecastCardTexts: [
      'Get search volume and forecasts',
      'Search volume and forecasts',
      'Get search volume',
    ],
    // Tab/nav item that switches the forecasts tool to the historical-metrics
    // table (the view that carries the same columns as the ideas grid).
    historicalMetricsTabTexts: ['Historical metrics', 'Historical plan metrics'],
    // Placeholder / aria-label hints for the multi-keyword paste box.
    metricsPasteHints: [
      'enter keywords', 'one keyword per line', 'copy and paste',
      'enter or paste', 'add keywords', 'paste keywords',
    ],
    getStartedButtonTexts: ['Get started', 'Get results'],
    // Text on the results page that returns to the input pane. We try these
    // in order between seeds when the chip-input isn't immediately findable.
    backToInputTexts: [
      'New search', 'Start over', 'Edit search', 'Modify search',
      'Back to search', 'Change keywords', 'Start new search',
      'Edit keywords',
    ],
  };

  // ----- live logging back to background (which persists + broadcasts) -----
  function kpLog(action, kind) {
    try {
      chrome.runtime.sendMessage({
        action: 'logFromContent',
        text: `KP: ${action}`,
        kind: kind || null,
        source: 'kp',
      }).catch(() => {});
    } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'KP_PING') { sendResponse({ ok: true, ready: true }); return false; }
    if (msg?.type === 'KP_GET_IDEAS') {
      // Accept either `seed` (single string) or `seeds` (array). When multiple
      // seeds are provided, the flow opens KP once and pastes each seed in
      // sequence — much faster than reopening KP for each seed.
      const seeds = Array.isArray(msg.seeds)
        ? msg.seeds.filter(s => typeof s === 'string' && s.trim())
        : (msg.seed ? [msg.seed] : []);
      runKPFlow(seeds, msg.maxResults || 200, msg.hydrateTimeoutMs || 45000, msg.tableTimeoutMs || 60000)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err.message, keywords: [] }));
      return true;
    }
    if (msg?.type === 'KP_GET_IDEAS_WEBSITE') {
      // "Start with a website" flow run on a freshly-loaded KP page. The
      // engine navigates the tab to /ideas/new before sending this so we
      // start from a clean shell rather than trying to reopen Discover
      // Keywords from the results view.
      const productUrl = typeof msg.productUrl === 'string' ? msg.productUrl.trim() : '';
      if (!productUrl) {
        sendResponse({ ok: false, error: 'no productUrl provided', keywords: [] });
        return false;
      }
      runKPWebsiteFlow(productUrl, msg.maxResults || 200, msg.hydrateTimeoutMs || 45000, msg.tableTimeoutMs || 60000)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err.message, keywords: [] }));
      return true;
    }
    if (msg?.type === 'KP_GET_METRICS') {
      // Backfill flow — paste a batch of keywords into "Get search volume and
      // forecasts", switch to Historical metrics, scrape the metric columns.
      const keywords = Array.isArray(msg.keywords)
        ? msg.keywords.filter(k => typeof k === 'string' && k.trim())
        : [];
      if (keywords.length === 0) {
        sendResponse({ ok: false, error: 'no keywords provided', keywords: [] });
        return false;
      }
      runKPMetricsFlow(keywords, msg.maxResults || (keywords.length + 50), msg.hydrateTimeoutMs || 45000, msg.tableTimeoutMs || 90000)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err.message, keywords: [] }));
      return true;
    }
  });

  // ----- helpers -----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand  = (a, b) => a + Math.random() * (b - a);

  function jitter(baseMs, variancePct = 0.35) {
    const v = baseMs * variancePct;
    return Math.max(50, Math.round(baseMs + rand(-v, v)));
  }
  const humanPause = (baseMs, v) => sleep(jitter(baseMs, v));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function findByText(selector, texts) {
    const els = Array.from(document.querySelectorAll(selector));
    for (const el of els) {
      if (!visible(el)) continue;
      const t = (el.textContent || '').trim();
      for (const target of texts) {
        if (t.toLowerCase() === target.toLowerCase()) return el;
        if (t.toLowerCase().includes(target.toLowerCase()) && t.length < target.length + 60) return el;
      }
    }
    return null;
  }

  // Robust seed-input finder — tries placeholder, aria-label, dialog scoping,
  // and finally locates by the visible label text "Enter products or services".
  function findSeedInput() {
    const hints = SELECTORS.seedInputHints.map(h => h.toLowerCase());

    // Strategy 1: any input/textarea whose aria-label or placeholder matches a hint
    const all = Array.from(document.querySelectorAll(
      'input, textarea, [role="combobox"], [contenteditable="true"]'
    ));
    for (const el of all) {
      if (!visible(el)) continue;
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      const p = (el.getAttribute('placeholder') || '').toLowerCase();
      const blob = `${a} ${p}`;
      if (hints.some(h => blob.includes(h))) return el;
    }

    // Strategy 2: inside the "Discover new keywords" dialog/modal, take the
    // first visible text input
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], material-dialog, .modal'));
    for (const d of dialogs) {
      const txt = (d.textContent || '').toLowerCase();
      if (!SELECTORS.seedDialogHeadings.some(h => txt.includes(h))) continue;
      const inputs = d.querySelectorAll(
        'input[type="text"], input:not([type]), textarea, [role="combobox"]'
      );
      for (const el of inputs) if (visible(el)) return el;
    }

    // Strategy 3: locate visible label text and walk up to find a nearby input
    const labelLike = Array.from(document.querySelectorAll('div, span, label, h2, h3')).filter(el => {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 100) return false;
      return /enter products or services/i.test(t);
    });
    for (const label of labelLike) {
      let scan = label.parentElement;
      for (let i = 0; i < 6 && scan; i++) {
        const input = scan.querySelector('input[type="text"], input:not([type]), textarea');
        if (input && visible(input)) return input;
        scan = scan.parentElement;
      }
    }

    return null;
  }

  async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 300, name = 'element' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { const out = predicate(); if (out) return out; } catch {}
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${name}`);
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function humanType(input, text) {
    input.focus();
    setNativeValue(input, '');
    await humanPause(180);
    let buf = '';
    for (let i = 0; i < text.length; i++) {
      buf += text[i];
      setNativeValue(input, buf);
      await sleep(Math.round(rand(55, 175)));
      if (Math.random() < 0.10) await sleep(Math.round(rand(220, 520)));
      if (text[i] === ' ' && Math.random() < 0.5) await sleep(Math.round(rand(80, 180)));
    }
    await humanPause(220);
  }

  async function humanClick(el) {
    if (!el) throw new Error('null click target');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await humanPause(350);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width  * rand(0.3, 0.7);
    const y = r.top  + r.height * rand(0.3, 0.7);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    await humanPause(140);
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(Math.round(rand(45, 130)));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    await humanPause(260);
  }

  async function humanScrollTo(targetY) {
    const startY = window.scrollY;
    const distance = targetY - startY;
    if (Math.abs(distance) < 40) { window.scrollTo(0, targetY); return; }
    const direction = distance > 0 ? 1 : -1;
    const steps = Math.round(rand(8, 16));
    const baseStep = Math.abs(distance) / steps;
    let y = startY;
    for (let i = 0; i < steps; i++) {
      y += baseStep * rand(0.6, 1.4) * direction;
      window.scrollTo(0, Math.round(y));
      await sleep(Math.round(rand(60, 170)));
      if (Math.random() < 0.12) await sleep(Math.round(rand(280, 750)));
    }
    window.scrollTo(0, Math.round(targetY));
    await humanPause(220);
  }

  // ----- flow -----
  function isOnIdeasPage() {
    return !!(findByText('button, [role="button"]', SELECTORS.getResultsButtonTexts)
              || findSeedInput());
  }

  async function waitForReact(timeoutMs) {
    kpLog(`landed on ${location.href.slice(0, 120)}`);
    kpLog('waiting for shell to hydrate');
    await waitFor(() => document.querySelectorAll('button, [role="button"]').length > 5,
      { timeoutMs, name: 'KP shell hydration' });
    const buttons = document.querySelectorAll('button, [role="button"]').length;
    const inputs  = document.querySelectorAll('input, textarea').length;
    const dialogs = document.querySelectorAll('[role="dialog"]').length;
    kpLog(`shell hydrated (buttons:${buttons} inputs:${inputs} dialogs:${dialogs})`, 'ok');
    await humanPause(600, 0.4);
  }

  function findDiscoverCard() {
    // Prefer specific interactive roles. Walk up to a clickable ancestor if the
    // matched node is just a text span inside the actual card.
    const exact = SELECTORS.discoverCardTexts.map(s => s.toLowerCase());
    const candidates = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], material-card, [jsname]'
    ));
    for (const el of candidates) {
      if (!visible(el)) continue;
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (exact.some(s => t === s || t.includes(s))) return el;
    }
    // Fallback: any element with matching text — climb up to a clickable parent
    const all = Array.from(document.querySelectorAll('span, div, h2, h3'));
    for (const el of all) {
      if (!visible(el)) continue;
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (t.length > 60) continue;
      if (!exact.some(s => t === s || t.includes(s))) continue;
      let scan = el;
      for (let i = 0; i < 6 && scan; i++) {
        const r = scan.getAttribute && scan.getAttribute('role');
        const tag = scan.tagName?.toLowerCase();
        if (tag === 'a' || tag === 'button' || r === 'button' || r === 'link' || scan.onclick) return scan;
        scan = scan.parentElement;
      }
      return el; // last resort
    }
    return null;
  }

  // Conservative overlay dismissal — only targets things that are clearly
  // snackbars / notifications / banners, NOT random buttons whose label happens
  // to contain "close". Previous broader version was clobbering legitimate
  // KP UI elements between click attempts.
  async function dismissOverlays() {
    const candidates = Array.from(document.querySelectorAll(
      'material-snackbar button, [role="alert"] button, .snackbar button, ' +
      'material-snackbar [role="button"], [aria-live] button, ' +
      'button[aria-label*="dismiss" i], button[aria-label*="install" i], ' +
      'button[aria-label*="get the google ads app" i]'
    )).filter(visible);
    let dismissed = 0;
    for (const btn of candidates.slice(0, 4)) {
      try { btn.click(); dismissed++; } catch {}
    }
    if (dismissed) {
      kpLog(`dismissed ${dismissed} snackbar/notification(s)`);
      await humanPause(400);
    }
  }

  // Find what's actually under the click point. Material/Angular pages
  // routinely place loading spinners and progress indicators on top of cards
  // while the page hydrates; those overlays absorb clicks. If we see one,
  // ignore it and click the card directly instead.
  function isLoadingOverlay(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'ipl-progress-indicator') return true;
    if (tag === 'material-spinner' || tag === 'mat-spinner') return true;
    if (el.getAttribute && el.getAttribute('role') === 'progressbar') return true;
    if (el.closest && el.closest('ipl-progress-indicator, material-spinner, mat-spinner, [role="progressbar"]')) return true;
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
    if (typeof cls === 'string' && /\b(loading|spinner|progress)\b/i.test(cls)) return true;
    return false;
  }

  function findRealClickTarget(card) {
    if (!card) return null;
    // Prefer nested interactive elements over the container. Material cards
    // often wrap the real handler on a nested <button>/<a> — clicking the
    // outer <div role=button> can no-op if the wrapper only exists for
    // styling. Reduced the "Auto-click failed" recurrences: log showed
    // clicks landing on the outer role=button div, which Material's ripple
    // handler ignored.
    const inner = card.querySelector?.('button, a[role="button"], a[href], [role="link"][tabindex], material-button, mat-button');
    if (inner && visible(inner)) {
      // Only use the inner element if it's actually inside the card's
      // hit box (avoid grabbing an unrelated sibling nav button).
      const cr = card.getBoundingClientRect();
      const ir = inner.getBoundingClientRect();
      const centerInCard = ir.left >= cr.left && ir.right <= cr.right && ir.top >= cr.top && ir.bottom <= cr.bottom;
      if (centerInCard) return inner;
    }
    const r = card.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return card;
    // Spinner/overlay on top — click the card itself.
    if (isLoadingOverlay(hit)) return card;
    // Hit is the card or a child of it — click the card.
    if (hit === card || card.contains(hit)) return card;
    // Some OTHER element covers the card — return it as the actual target.
    return hit;
  }

  // Wait until any page-level loading overlay (ipl-progress-indicator etc.)
  // is no longer rendered/visible. KP hydrates progressively; clicking before
  // the spinner clears makes Material's click handlers no-op.
  async function waitForLoadingOverlayToClear(maxWaitMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const overlays = Array.from(document.querySelectorAll(
        'ipl-progress-indicator, material-spinner, mat-spinner, [role="progressbar"]'
      ));
      const stillVisible = overlays.some(o => {
        const rect = o.getBoundingClientRect();
        const style = getComputedStyle(o);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (!stillVisible) return true;
      await sleep(400);
    }
    return false;
  }

  // Multi-strategy click: pointer events + mouse events + native .click() +
  // Space+Enter keys. For Angular Material and React apps that ignore some
  // event types. Focus + delay BEFORE dispatch so Material's state machine
  // registers focus first (some ripple handlers no-op if focus arrives in the
  // same tick as mousedown). Explicit 'click' MouseEvent added — 'mousedown'
  // + 'mouseup' alone does NOT synthesize 'click' on most Material widgets
  // (previously the biggest reason auto-click failed on Discover).
  async function aggressiveClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    await humanPause(250);
    // Focus first, brief pause. Google Ads' Material buttons use a state
    // machine that treats "focus first, then mousedown" as a trusted-ish
    // pattern. Focusing in the same tick as mousedown loses the click.
    try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch {}
    await humanPause(80);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, composed: true };
    try {
      el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup',   { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    // Explicit 'click' MouseEvent — separate from mousedown+mouseup. Some
    // Material button variants ONLY listen for click; without this the ripple
    // fires but the routed action doesn't.
    el.dispatchEvent(new MouseEvent('click', opts));
    try { el.click(); } catch {}
    // Keyboard activation as final backup — Space for buttons, Enter for
    // links / role=button. Some Material components respond to keyboard
    // events even when they ignore synthetic mouse clicks entirely.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { key: ' ', code: 'Space', keyCode: 32, bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
  }

  // Wait for the ACTUALLY-interactive "Discover new keywords" card to appear.
  // KP hydrates progressively — initially a parent card with placeholder text
  // ("Discover new keywords Get keyword ideas") renders behind a loading
  // overlay, but it's not actually clickable. After ~10-30s of hydration the
  // real interactive element renders with "Start with keyword" sub-text. That
  // one IS clickable on first try. Polling for the right element saves us
  // from a 4-minute "click wrong element, fail, retry" loop.
  async function waitForInteractiveDiscoverCard(maxWaitMs = 45000) {
    const start = Date.now();
    let lastSeen = null;
    while (Date.now() - start < maxWaitMs) {
      // Prefer the fully-hydrated variant with "Start with keyword" sub-text.
      const all = Array.from(document.querySelectorAll(
        'a, button, [role="button"], [role="link"], material-card, [jsname], div'
      ));
      for (const el of all) {
        if (!visible(el)) continue;
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (t.length === 0 || t.length > 100) continue;
        if (t.includes('discover new keywords') && t.includes('start with keyword')) {
          return el; // fully hydrated, ready to click
        }
      }
      // Track the placeholder as a fallback in case the hydrated variant
      // never appears (some KP UI variants don't show the sub-text).
      const card = findDiscoverCard();
      if (card) lastSeen = card;
      await sleep(500);
    }
    return lastSeen; // fall through with whatever we found, even if placeholder
  }

  async function openDiscoverKeywords() {
    if (isOnIdeasPage()) {
      kpLog('Discover Keywords pane already open', 'ok');
      return;
    }
    await dismissOverlays();

    kpLog('waiting for interactive "Discover new keywords" card to hydrate');
    const card = await waitForInteractiveDiscoverCard(45000);
    if (card) {
      // Build a candidate list — nested button/anchor first (usually the real
      // handler), then the target from findRealClickTarget (spatial), then
      // the card itself. Cycling through candidates on retry is much more
      // effective than clicking the same wrong element three times.
      const candidates = [];
      const inner = card.querySelector?.('button, a[role="button"], a[href], [role="link"][tabindex], material-button, mat-button');
      if (inner && visible(inner)) candidates.push({ el: inner, why: 'nested-clickable' });
      const spatial = findRealClickTarget(card);
      if (spatial && !candidates.some(c => c.el === spatial)) candidates.push({ el: spatial, why: 'spatial-hit' });
      if (!candidates.some(c => c.el === card)) candidates.push({ el: card, why: 'card-container' });
      let opened = false;
      for (let i = 0; i < candidates.length && !opened; i++) {
        const { el, why } = candidates[i];
        const desc = `<${el.tagName?.toLowerCase()}>${el.getAttribute?.('role') ? `[role=${el.getAttribute('role')}]` : ''} "${(el.innerText || el.textContent || '').trim().slice(0, 40)}" (${why})`;
        kpLog(`click attempt ${i + 1}/${candidates.length}: ${desc}`);
        await aggressiveClick(el);
        await humanPause(2500, 0.3);
        if (isOnIdeasPage()) {
          kpLog(`Discover Keywords pane opened via ${why}`, 'ok');
          await humanPause(600);
          opened = true;
          return;
        }
      }
    } else {
      kpLog('interactive Discover card did not appear within 45s', 'warn');
    }

    // ----- Manual fallback -----
    // Synthetic clicks may be ignored by Material's isTrusted checks. Activate
    // the KP tab so the user can click the card themselves; we wait for them.
    // Short 30s window — R2 KP runs after the tab has sat idle for 20+ min
    // and the Google Ads session often expires; waiting the full 2 min × N
    // seeds wastes 10+ min per stale-session run. The engine has its own
    // session-dead detection that skips the remaining R2 seeds once the
    // first one times out, so failing fast here is correct.
    kpLog(`Auto-click failed. ACTIVATING the KP tab — please click "Discover new keywords" within 30s; otherwise the engine will skip this seed.`, 'err');
    try {
      chrome.runtime.sendMessage({ action: 'activateMyTab' }).catch(() => {});
    } catch {}

    try {
      await waitFor(isOnIdeasPage, { timeoutMs: 30000, intervalMs: 1000, name: 'manual user click on Discover card' });
      kpLog('Discover Keywords pane opened (thanks for the manual click!)', 'ok');
      await humanPause(900);
    } catch (e) {
      const dialogs = document.querySelectorAll('[role="dialog"]').length;
      const inputs  = document.querySelectorAll('input, textarea').length;
      const btnText = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(visible)
        .slice(0, 8)
        .map(b => (b.innerText || '').trim().slice(0, 20))
        .filter(Boolean)
        .join(' | ');
      kpLog(`gave up — dialogs:${dialogs} inputs:${inputs}; visible buttons: [${btnText}]`, 'err');
      throw e;
    }
  }

  // Recovery path used between multi-seed runs when findSeedInput fails on
  // the results page. The results page only exposes the "+ Add another
  // keyword" chip-input when results are non-sparse; for a 1-result KP run
  // that input is hidden and findSeedInput times out. Walk through several
  // strategies to return to a page where the seed input exists again.
  async function navigateBackToInputPane() {
    // Strategy 1: aria-label hint for an edit / modify / back affordance.
    const editBtn = Array.from(document.querySelectorAll(
      '[aria-label*="edit" i], [aria-label*="back" i], [aria-label*="modify" i], ' +
      'button[aria-label*="change" i], [data-tooltip*="edit" i]'
    )).find(visible);
    if (editBtn) {
      kpLog(`clicking edit/back affordance "${(editBtn.getAttribute('aria-label') || '').slice(0, 40)}"`);
      await aggressiveClick(editBtn);
      await humanPause(1500, 0.3);
      if (findSeedInput()) return true;
    }

    // Strategy 2: text button matching "New search" / "Start over" / etc.
    const txtBtn = findByText('button, [role="button"], a', SELECTORS.backToInputTexts);
    if (txtBtn) {
      kpLog(`clicking "${(txtBtn.innerText || '').trim().slice(0, 30)}" to return to input`);
      await aggressiveClick(txtBtn);
      await humanPause(1500, 0.3);
      if (findSeedInput()) return true;
    }

    // Strategy 3: dismiss the existing seed chip — sometimes collapses the
    // results pane and exposes the input.
    const chipDismiss = Array.from(document.querySelectorAll(
      '.mdc-chip__icon--trailing, [aria-label*="Remove" i], [aria-label*="remove" i], ' +
      '.mdc-evolution-chip__action--trailing, button[aria-label*="delete" i]'
    )).find(visible);
    if (chipDismiss) {
      kpLog('dismissing existing seed chip to reset view');
      try { chipDismiss.click(); } catch {}
      await humanPause(1200, 0.3);
      if (findSeedInput()) return true;
    }

    // Strategy 4 (last resort): reload the KP ideas URL. This drops us back
    // onto a clean Discover Keywords pane, but pays a ~5s page-load cost.
    try {
      const u = new URL(location.href);
      const fresh = `${u.origin}${u.pathname.replace(/\/ideas\/.*/, '/ideas/new')}${u.search}`;
      kpLog(`reloading KP ideas page to recover input: ${fresh.slice(0, 80)}`);
      location.href = fresh;
    } catch {
      location.reload();
    }
    await sleep(3500);
    await waitFor(() => document.querySelectorAll('button, [role="button"]').length > 5,
      { timeoutMs: 30000, name: 'KP shell re-hydration' });
    await humanPause(800);
    try {
      await openDiscoverKeywords();
    } catch (e) {
      kpLog(`re-open Discover failed after reload: ${e.message}`, 'err');
    }
    return !!findSeedInput();
  }

  // Clear any existing chips in the seed input — needed when running KP
  // for a second/third seed without reopening the panel.
  async function clearExistingChips() {
    const chipBtns = Array.from(document.querySelectorAll(
      '.mdc-chip__icon--trailing, [aria-label="Remove"], [aria-label*="remove" i], ' +
      'material-chip [aria-label*="dismiss" i], mat-chip [aria-label*="remove" i]'
    )).filter(visible);
    let removed = 0;
    for (const b of chipBtns.slice(0, 8)) {
      try { b.click(); removed++; } catch {}
    }
    if (removed > 0) {
      kpLog(`cleared ${removed} existing chip(s) from seed input`);
      await humanPause(200);
    }
  }

  async function enterSeedAndSubmit(seedText, opts = {}) {
    kpLog('searching for seed input');
    // First seed: 25s. Subsequent seeds: 60s — after a results table renders,
    // the chip-input takes longer to become visible/interactive again.
    const tmo = opts.subsequentSeed ? 60000 : 25000;
    const input = await waitFor(findSeedInput, { timeoutMs: tmo, name: 'KP seed input' });
    kpLog(`seed input found (placeholder="${(input.getAttribute('placeholder') || '').slice(0, 40)}")`, 'ok');

    await clearExistingChips();
    await humanClick(input);
    kpLog(`pasting seed: "${seedText}"`);
    // Native value set (much faster than per-char typing). Angular Material
    // reacts to the InputEvent the setter dispatches.
    setNativeValue(input, seedText);

    await humanPause(150);
    kpLog('pressing Enter to commit chip');
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
    await humanPause(250);

    kpLog('looking for "Get results" button');
    const btn = await waitFor(
      () => {
        const b = findByText('button, [role="button"]', SELECTORS.getResultsButtonTexts);
        if (!b) return null;
        // Skip the button when it's still disabled (no chip committed yet)
        if (b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true') return null;
        return b;
      },
      { timeoutMs: 15000, name: 'enabled Get results button' }
    );
    kpLog('clicking Get results', 'ok');
    await humanClick(btn);
  }

  // Specific phrases Google uses when no keyword ideas are returned (not just
  // help text mentioning "no results" in passing).
  const NO_RESULTS_PHRASES = [
    'no keyword ideas',
    'no results found',
    'no results to display',
    'no results to show',
    'no data to show',
    "we couldn't find",
    'we could not find',
    'try different keywords',
    'try changing your',
    'try modifying your',
    'no keywords found',
    '0 keyword ideas',
    'no data available',
  ];

  function pageHasNoResultsBanner() {
    const text = (document.body.innerText || '').toLowerCase();
    return NO_RESULTS_PHRASES.find(p => text.includes(p)) || null;
  }

  async function scrapeIdeasTable(maxResults, tableTimeoutMs) {
    kpLog('waiting for results or a "no results" banner');
    let outcome = null;
    try {
      outcome = await waitFor(() => {
        const noResultsPhrase = pageHasNoResultsBanner();
        if (noResultsPhrase) return { kind: 'no-results', phrase: noResultsPhrase };

        const rows = document.querySelectorAll('[role="row"], tr, material-row').length;
        const loaders = Array.from(document.querySelectorAll(
          '[role="progressbar"], material-spinner, mat-spinner'
        )).filter(visible);

        // Plenty of rows already — results visibly rendered. Accept regardless
        // of whether some loader is still spinning somewhere on the page.
        if (rows > 8) return { kind: 'has-rows', rows };

        // Few rows but no spinners — results are done loading (or never came).
        if (loaders.length === 0 && rows > 3) return { kind: 'has-rows', rows };

        return false;
      }, { timeoutMs: tableTimeoutMs, intervalMs: 700, name: 'KP results or no-results' });
    } catch (e) {
      // Soft-fail: if we have ANY rows, attempt a partial scrape instead of bailing.
      const rows = document.querySelectorAll('[role="row"], tr, material-row').length;
      const dump = {
        url:    location.href.slice(0, 120),
        grids:  document.querySelectorAll('[role="grid"]').length,
        tables: document.querySelectorAll('table').length,
        rows,
        trs:    document.querySelectorAll('tr').length,
        loaders: document.querySelectorAll('[role="progressbar"], material-spinner, mat-spinner').length,
      };
      // Diagnostic-only — logged at 'warn' so it lands in the manager's
      // activity log without pumping the Errors card. If we ended up
      // taking the partial-scrape path this is expected noise, not a
      // failure. Only the terminal throw() below counts as a real error.
      kpLog(`table diag: ${JSON.stringify(dump)}`, 'warn');
      if (rows > 3) {
        kpLog(`timeout but ${rows} rows present — attempting partial scrape`, 'warn');
        outcome = { kind: 'has-rows', rows };
      } else if (dump.loaders === 0 && dump.grids >= 1 && rows <= 3) {
        // Loader is DONE but grid has only header rows — Google finished
        // computing and this seed has genuinely no expansion. Treat as
        // no-results instead of hard-failing. Matches Aveeno-style seeds
        // where KP metrics returned an empty result set silently (no
        // "no results" banner, just a computed-but-empty grid).
        kpLog(`timeout — loader stopped, grid present, ≤3 rows — treating as empty result set`, 'info');
        return [];
      } else {
        // Also check no-results one more time in case banner just appeared
        const phrase = pageHasNoResultsBanner();
        if (phrase) {
          // Late-arriving "no results" banner — this IS the answer, not
          // an error. Google confirmed the seed produced 0 ideas.
          kpLog(`timeout — found "no results" phrase late: "${phrase}" (empty result is legitimate)`, 'info');
          return [];
        }
        throw e;
      }
    }

    if (outcome.kind === 'no-results') {
      // This is Google's legitimate answer — a niche seed with no
      // expansion ideas. NOT an error, so we log at info level so the
      // manager's Errors card doesn't fill with these.
      kpLog(`Google returned no keyword ideas for this seed ("${outcome.phrase}") — moving on`, 'info');
      return []; // empty result, but not an error — product will be marked done
    }
    kpLog(`results loaded (${outcome.rows} initial <row> elements on page; paginating + scrolling for all)`, 'ok');

    await humanPause(1200, 0.3);

    // Try to bump rows-per-page to max so we get more per page (fewer page-clicks needed)
    await trySetRowsPerPageMax();

    const grid = findKeywordIdeasGrid();
    if (!grid) {
      kpLog('keyword ideas grid not found among ' + document.querySelectorAll('[role="grid"], table, material-list').length + ' candidate grids', 'err');
      return [];
    }

    const keywords = [];
    const seen = new Set(); // dedupe within this scrape (Map at report level also dedupes globally)
    const reasons = {};
    const MAX_PAGES = 50;
    let pageNum = 0;

    while (keywords.length < maxResults && pageNum < MAX_PAGES) {
      pageNum++;
      const before = keywords.length;
      await extractCurrentViewport(grid, keywords, seen, reasons, maxResults);
      kpLog(`page ${pageNum}: extracted ${keywords.length - before} new (total: ${keywords.length})`);

      if (keywords.length >= maxResults) {
        kpLog(`hit kpMaxPerProduct cap (${maxResults}) — raise the cap in Settings if KP has more`, 'err');
        break;
      }

      // Try to advance to next page. If no enabled "next" button, we're done.
      const next = findNextPageButton();
      if (!next) {
        kpLog(`no enabled next-page button — all pages scraped after page ${pageNum}`, 'ok');
        break;
      }
      kpLog(`going to next page (${pageNum + 1})`);
      try { next.click(); } catch {}
      await sleep(1500);
      await humanPause(500, 0.3);
    }

    const rejectedDesc = Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(', ') || 'none';
    kpLog(`accepted ${keywords.length} unique keywords across ${pageNum} page(s) (rejected: ${rejectedDesc})`, 'ok');
    return keywords;
  }

  // Find and click the rows-per-page selector, pick the largest numeric option.
  async function trySetRowsPerPageMax() {
    try {
      const paginators = Array.from(document.querySelectorAll(
        'mat-paginator, [class*="paginator"], [aria-label*="pagination" i]'
      ));
      for (const p of paginators) {
        const select = p.querySelector('select, mat-select, [role="combobox"], [role="listbox"] button');
        if (!select || !visible(select)) continue;
        kpLog('found rows-per-page selector — opening');
        try { select.click(); } catch {}
        await sleep(800);
        const opts = Array.from(document.querySelectorAll(
          'mat-option, [role="option"], option, [role="menuitem"]'
        )).filter(visible);
        let maxOpt = null, maxNum = 0;
        for (const o of opts) {
          const txt = (o.innerText || o.textContent || o.value || '').trim();
          const n = parseInt(txt, 10);
          if (!isNaN(n) && n > maxNum) { maxNum = n; maxOpt = o; }
        }
        if (maxOpt && maxNum > 10) {
          kpLog(`setting rows-per-page to ${maxNum}`);
          try { maxOpt.click(); } catch {}
          await sleep(2500); // re-render
          return true;
        }
      }
    } catch (e) {
      kpLog(`rows-per-page setter skipped: ${e.message}`);
    }
    return false;
  }

  // Find an enabled "next page" button (Material paginator pattern + generics).
  function findNextPageButton() {
    const candidates = Array.from(document.querySelectorAll(
      'mat-paginator button[aria-label*="next" i], ' +
      'button[aria-label*="next page" i], ' +
      'button[aria-label="Next"], ' +
      '[role="button"][aria-label*="next" i]'
    )).filter(visible).filter(b =>
      !b.hasAttribute('disabled') &&
      b.getAttribute('aria-disabled') !== 'true' &&
      !b.classList.contains('mat-mdc-paginator-navigation-disabled')
    );
    return candidates[0] || null;
  }

  // Find the ACTUAL scroll container for the keyword table. KP uses Angular
  // CDK virtual scrolling — only ~10 rows are in the DOM at any time. We must
  // scroll the right element to bring new rows into existence.
  function findScrollViewport(grid) {
    // 1. Angular CDK virtual scroll viewport — most likely on KP
    const cdk =
      grid.querySelector('cdk-virtual-scroll-viewport') ||
      grid.closest('cdk-virtual-scroll-viewport') ||
      document.querySelector('cdk-virtual-scroll-viewport');
    if (cdk) return cdk;

    // 2. Look for a scrollable descendant of the grid (table wrapper with overflow)
    const desc = Array.from(grid.querySelectorAll('*')).find(el => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 50;
    });
    if (desc) return desc;

    // 3. Scrollable ancestor of the grid
    let scan = grid.parentElement;
    for (let i = 0; i < 8 && scan; i++) {
      const s = getComputedStyle(scan);
      if (/(auto|scroll)/.test(s.overflowY) && scan.scrollHeight > scan.clientHeight + 50) return scan;
      scan = scan.parentElement;
    }

    // 4. Grid itself
    if (grid.scrollHeight > grid.clientHeight + 10) return grid;

    return null;
  }

  // Extract all keyword rows by stepping through the virtual-scroll viewport
  // in viewport-height chunks, waiting for each chunk to render before reading.
  async function extractCurrentViewport(grid, keywords, seen, reasons, maxResults) {
    const viewport = findScrollViewport(grid);
    const usingViewport = !!viewport;
    const targetName = viewport
      ? `${viewport.tagName?.toLowerCase()}${viewport.className ? '.' + (viewport.className.split(' ')[0] || '') : ''}`
      : 'window';
    const scrollH = viewport ? viewport.scrollHeight : document.documentElement.scrollHeight;
    const clientH = viewport ? viewport.clientHeight : window.innerHeight;
    kpLog(`scroll target: ${targetName} (scrollH=${scrollH}, clientH=${clientH})`);

    const extractNow = () => {
      const rows = Array.from(grid.querySelectorAll('[role="row"], tr, material-row'));
      let added = 0;
      for (const row of rows) {
        const extracted = extractKeywordFromRow(row);
        const { kw, reason } = extracted;
        if (!kw) {
          reasons[reason] = (reasons[reason] || 0) + 1;
          continue;
        }
        const k = kw.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        // Push the full extracted object so the engine can store volume,
        // competition, and bid-range alongside the keyword itself. Backward-
        // compatible callers that only read `.kw` still work.
        keywords.push({
          kw,
          monthlySearches: extracted.monthlySearches || '',
          competition:     extracted.competition     || '',
          bidLow:          extracted.bidLow          || '',
          bidHigh:         extracted.bidHigh         || '',
        });
        added++;
        if (keywords.length >= maxResults) return -1;
      }
      return added;
    };

    // Reset to top so we start fresh
    if (usingViewport) viewport.scrollTop = 0;
    else window.scrollTo(0, 0);
    await sleep(800);

    // Step through with viewport-height jumps (or larger). Virtual scroll
    // needs a real pixel move + wait to render the next batch.
    const step = Math.max(400, Math.floor((clientH || 600) * 0.85));
    const maxPos = (usingViewport ? viewport.scrollHeight : document.documentElement.scrollHeight) + step;

    let pos = 0;
    let stallCount = 0;
    const MAX_STALL = 4;
    const MAX_ITER = 80;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const added = extractNow();
      if (added === -1) return; // maxResults hit

      if (added === 0) stallCount++;
      else stallCount = 0;

      if (stallCount >= MAX_STALL) break;

      // Advance scroll
      const beforeScroll = usingViewport ? viewport.scrollTop : window.scrollY;
      pos = beforeScroll + step;
      if (usingViewport) {
        viewport.scrollTop = pos;
      } else {
        window.scrollTo(0, pos);
      }
      const afterScroll = usingViewport ? viewport.scrollTop : window.scrollY;

      // If we couldn't scroll any further AND nothing new came in, we're at the end
      if (afterScroll === beforeScroll && added === 0) {
        // Try one more tactic: dispatch a wheel event to nudge virtual scrollers
        const targetForWheel = usingViewport ? viewport : grid;
        try {
          targetForWheel.dispatchEvent(new WheelEvent('wheel', {
            deltaY: step, bubbles: true, cancelable: true,
          }));
        } catch {}
      }

      await sleep(700); // give virtual scroller time to render new rows

      if (afterScroll === beforeScroll) stallCount++; // didn't move
    }

    // Final pass after a longer wait — last virtual rows can take a bit
    await sleep(800);
    extractNow();
  }

  function findKeywordIdeasGrid() {
    const grids = Array.from(document.querySelectorAll('[role="grid"], table, material-list'));
    // First pass: a grid whose text contains both "keyword" header AND a metric column header
    for (const g of grids) {
      const t = (g.innerText || '').toLowerCase();
      if (t.includes('keyword') && (t.includes('competition') || t.includes('monthly searches'))) return g;
    }
    // Fallback: the grid with the most rows
    let best = null, bestRows = 0;
    for (const g of grids) {
      const r = g.querySelectorAll('[role="row"], tr, material-row').length;
      if (r > bestRows) { best = g; bestRows = r; }
    }
    return best;
  }

  // Returns { kw, reason } so callers can count rejections by type.
  // Text-based extraction: works regardless of whether KP renders rows as
  // <td>/role=gridcell/material-cell/flexbox divs. The first non-empty line
  // of a row's innerText is the keyword; subsequent lines are search-volume,
  // competition, bid range, etc.
  function extractKeywordFromRow(row) {
    const text = (row.innerText || row.textContent || '').trim();
    if (!text) return { kw: null, reason: 'empty' };

    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return { kw: null, reason: 'empty' };

    const firstLine = lines[0];
    if (firstLine.length < 2 || firstLine.length > 100) return { kw: null, reason: 'length' };

    // Header row
    if (/^keyword( \(by relevance\))?$/i.test(firstLine)) return { kw: null, reason: 'header' };

    // UI control labels that sometimes get role="row" too
    const lower = firstLine.toLowerCase();
    const UI_BLACKLIST = new Set([
      'add', 'exclude adult ideas', 'add filter', 'refine keywords',
      'add to plan', 'select all', 'broaden this search', 'narrow this search',
      'segment', 'sort', 'columns', 'download', 'more', 'view', 'edit',
      'broaden', 'narrow', 'show similar', 'hide similar',
      'keyword (by relevance)', 'keyword',
    ]);
    if (UI_BLACKLIST.has(lower)) return { kw: null, reason: 'ui' };

    // Numeric-only line (search-volume row that lost its keyword cell?)
    if (/^\d[\d,.\s%₹€$\-–]*$/.test(firstLine)) return { kw: null, reason: 'numeric' };

    // Metric column header text
    if (/^(Low|Medium|High|Avg\. monthly searches|Competition|Top of page|—)$/i.test(firstLine)) {
      return { kw: null, reason: 'metric' };
    }

    // Pull volume / competition / bid range from the remaining lines. KP's
    // grid renders all cell values inline, so subsequent lines hold:
    //   "100 – 1K"   (Avg. monthly searches; can be "—", or "1K – 10K", etc.)
    //   "+50%"       (3-month change — ignored)
    //   "Low|Medium|High|—" (Competition)
    //   "₹5.50"      (Top of page bid, low)
    //   "₹50.00"     (Top of page bid, high)
    // Order varies and some cells may be empty. We pattern-match each value
    // independently rather than relying on position.
    let monthlySearches = '';
    let competition = '';
    const bids = [];
    const VOLUME_RE     = /^(?:\d[\d,]*[KMB]?|\d[\d,]*[KMB]?\s*[–\-]\s*\d[\d,]*[KMB]?)$/i;
    const COMP_RE       = /^(Low|Medium|High)$/i;
    const BID_RE        = /^[₹$€£¥]\s?\d[\d,]*(?:\.\d+)?$/;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].replace(/\s+/g, ' ').trim();
      if (!l || l === '—' || l === '-') continue;
      if (!monthlySearches && VOLUME_RE.test(l.replace(/\s/g, ''))) { monthlySearches = l; continue; }
      if (!competition && COMP_RE.test(l)) { competition = l; continue; }
      if (BID_RE.test(l) && bids.length < 2) { bids.push(l); continue; }
    }

    return {
      kw: firstLine,
      monthlySearches,
      competition,
      bidLow:  bids[0] || '',
      bidHigh: bids[1] || '',
      reason: null,
    };
  }

  // Runs the KP flow for a SINGLE seed. The engine drives multi-seed runs by
  // navigating the KP tab between seeds (one fresh kp.js injection per seed),
  // so this function only ever deals with one seed at a time. The earlier
  // in-content-script seed loop broke because reloading the KP page mid-run
  // killed the message channel.
  async function runKPFlow(seedOrSeeds, maxResults, hydrateTimeoutMs, tableTimeoutMs) {
    const seed = Array.isArray(seedOrSeeds)
      ? (seedOrSeeds.find(s => typeof s === 'string' && s.trim()) || '')
      : (typeof seedOrSeeds === 'string' ? seedOrSeeds : '');
    if (!seed) return { ok: false, error: 'no seed provided', keywords: [] };

    try {
      kpLog(`starting flow for seed: "${seed.slice(0, 60)}"`);
      await waitForReact(hydrateTimeoutMs);
      await openDiscoverKeywords();
      await enterSeedAndSubmit(seed);
      const keywords = await scrapeIdeasTable(maxResults, tableTimeoutMs);
      kpLog(`seed "${seed.slice(0, 40)}" → ${keywords.length} ideas`, 'ok');
      return { ok: true, keywords };
    } catch (e) {
      kpLog(`FAILED: ${e.message}`, 'err');
      return { ok: false, error: e.message, keywords: [] };
    }
  }

  // Driver for the "Start with a website" flow. Runs on a freshly-loaded KP
  // tab — the engine navigates the tab to /ideas/new before invoking this,
  // so we begin from a clean shell rather than trying to recover from the
  // results view of a previous keyword search.
  async function runKPWebsiteFlow(productUrl, maxResults, hydrateTimeoutMs, tableTimeoutMs) {
    try {
      kpLog(`starting website flow for URL: "${productUrl.slice(0, 80)}"`);
      await waitForReact(hydrateTimeoutMs);
      await openDiscoverKeywords();
      const keywords = await tryKPWebsiteFallback(productUrl, maxResults, tableTimeoutMs);
      kpLog(`website flow → ${keywords.length} ideas`, 'ok');
      return { ok: true, keywords };
    } catch (e) {
      kpLog(`website flow FAILED: ${e.message}`, 'err');
      return { ok: false, error: e.message, keywords: [] };
    }
  }

  // ----- "Start with a website" flow -----
  //
  // Runs on a freshly-loaded KP page with the Discover Keywords pane already
  // open (the caller — runKPWebsiteFlow — handles waitForReact +
  // openDiscoverKeywords). The engine navigates the tab fresh before
  // dispatching KP_GET_IDEAS_WEBSITE rather than trying to recover from the
  // results view of an earlier seed search, because reopening Discover
  // Keywords from the results pane is unreliable (the interactive card
  // doesn't reliably re-hydrate within the 45s budget).
  //
  // Steps:
  //   1. Click the "Start with a website" tab.
  //   2. Paste the product URL into the URL input.
  //   3. Pick "Use only this page" (we want this product's keywords, not
  //      the whole site's).
  //   4. Click "Get results".
  //   5. Scrape via the existing scrapeIdeasTable (URL analysis takes
  //      longer than keyword analysis, so a longer timeout is used).
  async function tryKPWebsiteFallback(productUrl, maxResults, tableTimeoutMs) {
    await humanPause(700);

    // Step 1: click the "Start with a website" tab.
    const websiteTab = await waitFor(
      () => findByText('[role="tab"], button, a, div[tabindex], span[tabindex]', ['Start with a website']),
      { timeoutMs: 15000, name: '"Start with a website" tab' }
    );
    kpLog('clicking "Start with a website" tab');
    await aggressiveClick(websiteTab);
    await humanPause(1500, 0.3);

    // Step 2: find the URL input. Anchor on the descriptive label text above
    // the input ("Enter a website or a page…") — attribute-based matchers
    // also match the Google Ads top-bar search field (aria-label contains
    // "page"), and because querySelectorAll returns elements in document
    // order the top-bar wins. Without this anchor the URL gets pasted into
    // the global search bar and the KP "Get results" button stays disabled.
    const NOT_IN_HEADER = i => !i.closest('header, [role="banner"], nav, [role="navigation"]');
    const urlInput = await waitFor(() => {
      const labelHints = ['enter a website or a page', 'enter a website', 'enter a domain'];
      const labels = Array.from(document.querySelectorAll('label, span, div'))
        .filter(visible)
        .filter(el => {
          const t = (el.textContent || '').toLowerCase().trim();
          if (t.length === 0 || t.length > 140) return false;
          return labelHints.some(s => t.includes(s));
        });
      for (const label of labels) {
        let scope = label;
        for (let i = 0; i < 6 && scope; i++) {
          const input = scope.querySelector?.('input[type="text"], input[type="url"], input:not([type])');
          if (input && visible(input) && NOT_IN_HEADER(input)) return input;
          scope = scope.parentElement;
        }
      }
      // Fallback: attribute/placeholder match, but exclude the top app bar.
      const direct = Array.from(document.querySelectorAll(
        'input[aria-label*="website" i], input[aria-label*="url" i], ' +
        'input[placeholder*="http" i], input[placeholder^="https://" i], ' +
        'input[placeholder^="www." i]'
      )).filter(visible).find(NOT_IN_HEADER);
      if (direct) return direct;
      // Last-ditch: scan every visible non-header input for URL-y placeholders.
      const candidates = Array.from(document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])'))
        .filter(visible).filter(NOT_IN_HEADER);
      for (const i of candidates) {
        const p = (i.placeholder || '').toLowerCase();
        if (p.includes('http') || p.includes('website') || p === 'url' || p.startsWith('www.')) return i;
      }
      return null;
    }, { timeoutMs: 15000, name: 'KP URL input' });
    kpLog(`URL input found (placeholder="${(urlInput.getAttribute('placeholder') || '').slice(0, 40)}")`, 'ok');

    // Step 3: paste the product URL via native setter so KP's Angular form
    // reacts to the InputEvent.
    await humanClick(urlInput);
    setNativeValue(urlInput, '');
    await humanPause(150);
    setNativeValue(urlInput, productUrl);
    await humanPause(300);
    kpLog(`pasted URL: "${productUrl.slice(0, 80)}"`);

    // Step 4: pick the "Use only this page" radio. Try a label-text search
    // first (cleaner click target). Fall back to the second radio (KP
    // renders "Use the entire site" first, "Use only this page" second).
    let pageRadio = null;
    const pageLabel = findByText(
      'label, span, div, [role="radio"]',
      ['Use only this page', 'only this page']
    );
    if (pageLabel) {
      kpLog('clicking "Use only this page" label');
      await aggressiveClick(pageLabel);
      pageRadio = pageLabel;
    } else {
      const radios = Array.from(document.querySelectorAll('input[type="radio"], [role="radio"]')).filter(visible);
      if (radios.length >= 2) {
        kpLog('clicking second visible radio (assumed "Use only this page")');
        await aggressiveClick(radios[1]);
        pageRadio = radios[1];
      } else {
        kpLog('"Use only this page" radio not found — proceeding with default selection');
      }
    }
    await humanPause(400);

    // Step 5: click "Get results".
    const getBtn = await waitFor(
      () => {
        const b = findByText('button, [role="button"]', SELECTORS.getResultsButtonTexts);
        if (!b) return null;
        if (b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true') return null;
        return b;
      },
      { timeoutMs: 20000, name: 'enabled Get results button (website mode)' }
    );
    kpLog('clicking "Get results" for website analysis', 'ok');
    await humanClick(getBtn);

    // Step 5: scrape — URL analysis routinely takes longer than keyword
    // analysis, so bump the table timeout.
    const websiteTimeout = Math.max(tableTimeoutMs || 60000, 90000);
    const keywords = await scrapeIdeasTable(maxResults, websiteTimeout);
    kpLog(`website fallback scraped ${keywords.length} keyword(s)`, 'ok');
    return keywords;
  }

  // ----- "Get search volume and forecasts" (metrics backfill) flow -----
  //
  // Runs on a freshly-loaded KP home shell. Pastes a batch of keywords into
  // the "Get search volume and forecasts" tool, switches to the Historical
  // metrics view, and scrapes avg-monthly-searches / competition / bid range
  // using the SAME table extractor as the ideas flow (identical columns).
  //
  // Brittle by nature — same caveat as the Discover flow. If Google changes
  // the card / tab / paste-box copy, update the SELECTORS added above.
  async function runKPMetricsFlow(keywords, maxResults, hydrateTimeoutMs, tableTimeoutMs) {
    const list = Array.isArray(keywords)
      ? keywords.map(k => String(k || '').trim()).filter(Boolean)
      : [];
    if (list.length === 0) return { ok: false, error: 'no keywords provided', keywords: [] };
    try {
      kpLog(`starting metrics flow for ${list.length} keyword(s)`);
      await waitForReact(hydrateTimeoutMs);
      await openSearchVolumeForecasts(list);
      await switchToHistoricalMetrics();
      // Metrics flow is much slower than Discover — Google has to compute
      // avg-searches + competition + bid for EVERY pasted keyword before
      // showing the table. Discover shows ideas as they stream in; metrics
      // waits for the plan to fully compute. Scale the timeout by list
      // size: 2s per keyword, floored at 120s, capped at 300s. For a 100-
      // keyword paste that's 200s (3.3 min) — enough to cover the slow
      // compute path and the "still spinning" case the user hit.
      const scaled = Math.min(300000, Math.max(120000, list.length * 2000));
      const timeout = Math.max(tableTimeoutMs || 0, scaled);
      kpLog(`metrics flow timeout: ${Math.round(timeout / 1000)}s (scaled to ${list.length} keyword(s))`);
      const out = await scrapeIdeasTable(maxResults, timeout);
      kpLog(`metrics flow → ${out.length} row(s) scraped`, 'ok');
      return { ok: true, keywords: out };
    } catch (e) {
      // Metrics backfill failure is an ENRICHMENT miss, not a data loss.
      // The underlying keyword rows (autosuggest / PAA / related-search)
      // still exist and get pushed — they just won't have kp_volume /
      // kp_competition columns filled. Downgraded to 'warn' so the
      // manager's Errors card doesn't crowd with these while workers are
      // producing thousands of legitimate rows.
      kpLog(`metrics flow degraded (${e.message}) — keyword rows still produced, just no kp_* metric columns`, 'warn');
      return { ok: false, error: e.message, keywords: [] };
    }
  }

  async function openSearchVolumeForecasts(list) {
    await dismissOverlays();

    // Step 1: click the "Get search volume and forecasts" card.
    kpLog('looking for "Get search volume and forecasts" card');
    const card = await waitFor(
      () => findByText(
        'a, button, [role="button"], [role="link"], material-card, [jsname], span, div',
        SELECTORS.forecastCardTexts
      ),
      { timeoutMs: 30000, name: '"Search volume and forecasts" card' }
    );
    const target = findRealClickTarget(card) || card;
    kpLog(`clicking "${(target.innerText || target.textContent || '').trim().slice(0, 50)}"`);
    await aggressiveClick(target);
    await humanPause(2000, 0.3);

    // Step 2: find the multi-keyword paste box and paste the list. Prefer a
    // <textarea> (the tool accepts one keyword per line); fall back to any
    // visible input whose label/placeholder hints at keyword entry.
    kpLog('looking for keyword paste input');
    const input = await waitFor(() => {
      const els = Array.from(document.querySelectorAll(
        'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="combobox"]'
      )).filter(visible).filter(el => !el.closest('header, [role="banner"], nav, [role="navigation"]'));
      const ta = els.find(el => el.tagName === 'TEXTAREA');
      if (ta) return ta;
      const hints = SELECTORS.metricsPasteHints;
      for (const el of els) {
        const blob = `${(el.getAttribute('aria-label') || '')} ${(el.getAttribute('placeholder') || '')}`.toLowerCase();
        if (hints.some(h => blob.includes(h))) return el;
      }
      return null;
    }, { timeoutMs: 20000, name: 'KP keyword paste input' });

    await humanClick(input);
    setNativeValue(input, '');
    await humanPause(150);
    // One keyword per line — the tool's canonical multi-keyword format.
    setNativeValue(input, list.join('\n'));
    await humanPause(300);
    kpLog(`pasted ${list.length} keyword(s) into metrics input`);
    // Some variants need an Enter to commit before the button enables.
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    });
    await humanPause(300);

    // Step 3: click "Get started" (a.k.a. "Get results").
    const btn = await waitFor(
      () => {
        const b = findByText('button, [role="button"]', SELECTORS.getStartedButtonTexts);
        if (!b) return null;
        if (b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true') return null;
        return b;
      },
      { timeoutMs: 20000, name: 'enabled Get started button (metrics mode)' }
    );
    kpLog('clicking "Get started" for metrics', 'ok');
    await humanClick(btn);
    await humanPause(1800, 0.3);
  }

  async function switchToHistoricalMetrics() {
    // The forecasts tool opens on the Forecast view; the avg-monthly-searches
    // / competition / bid columns live under the "Historical metrics" tab.
    const tab = findByText(
      '[role="tab"], a, button, div[tabindex], span[tabindex], span, div',
      SELECTORS.historicalMetricsTabTexts
    );
    if (tab) {
      kpLog('switching to "Historical metrics" tab');
      await aggressiveClick(findRealClickTarget(tab) || tab);
      await humanPause(1800, 0.3);
    } else {
      // Not an error — this is the graceful fallback path. Downgraded from
      // 'err' to 'warn' so the manager's Errors card doesn't fill with
      // these (they don't cause data loss, the current view is scraped).
      kpLog('"Historical metrics" tab not found — scraping current view (may already be historical)', 'warn');
    }
  }
})();
