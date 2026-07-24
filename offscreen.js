// offscreen.js — runs inside offscreen.html.
//
// Thin relay between the background service worker and the sandboxed iframe
// (sandbox.html) that hosts CLIP via @xenova/transformers.
//
// Why split: MV3 extension pages cannot enable 'unsafe-eval', which
// transformers.js / ONNX Runtime Web require. MV3 sandboxed pages CAN have
// 'unsafe-eval' (and 'wasm-unsafe-eval'), but cannot use chrome.* APIs and
// cannot receive chrome.runtime messages directly. This offscreen document
// has chrome.runtime access AND it embeds the sandbox iframe.
//
// Wire protocol with sandbox.js:
//   parent -> sandbox:  { id, action, payload }
//   sandbox -> parent:  { id, ok: true, ...result }  or  { id, ok: false, error }

const TARGET = 'offscreen-image-matcher';

function diagLog(text, kind) {
  try {
    chrome.runtime.sendMessage({
      action: 'logFromContent',
      text: `OFFSCREEN: ${text}`,
      kind: kind || null,
      source: 'offscreen',
    }).catch(() => {});
  } catch {}
}

const sandboxFrame = () => document.getElementById('sandbox');

let resolveReady;
const sandboxReady = new Promise((res) => { resolveReady = res; });

let nextId = 1;
const pending = new Map();

window.addEventListener('message', (event) => {
  if (!sandboxFrame() || event.source !== sandboxFrame().contentWindow) return;
  const msg = event.data || {};
  if (msg.__sandboxReady) {
    diagLog('sandbox iframe ready', 'ok');
    resolveReady();
    return;
  }
  // Sandbox-initiated image fetch. Sandbox posts { __request: 'imgFetch',
  // reqId, url } — we forward to background (which has <all_urls> perms
  // and bypasses CORS), then post the base64 response back to sandbox.
  if (msg.__request === 'imgFetch' && msg.reqId != null) {
    (async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'imgFetch', url: msg.url });
        sandboxFrame().contentWindow.postMessage({ __response: 'imgFetch', reqId: msg.reqId, ...resp }, '*');
      } catch (e) {
        sandboxFrame().contentWindow.postMessage({ __response: 'imgFetch', reqId: msg.reqId, ok: false, error: e.message }, '*');
      }
    })();
    return;
  }
  const { id, ok, error, ...rest } = msg;
  if (!id) return;
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  if (ok) p.resolve(rest);
  else p.reject(new Error(error || 'sandbox error'));
});

// CLIP model init can take 30-90 seconds on first run (~150 MB download).
// Long per-call timeout covers that; once cached in IndexedDB subsequent
// loads finish in a few seconds.
async function callSandbox(action, payload, timeoutMs = 300_000) {
  await sandboxReady;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`sandbox call "${action}" timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      sandboxFrame().contentWindow.postMessage({ id, action, payload }, '*');
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== TARGET) return;
  const { action, payload } = msg;

  (async () => {
    try {
      if (action === 'init') {
        const r = await callSandbox('init', {});
        sendResponse({ ok: true, modelName: r.modelName });
        return;
      }
      if (action === 'embed') {
        const r = await callSandbox('embed', payload);
        sendResponse({ ok: true, embedding: r.embedding });
        return;
      }
      if (action === 'embedReferences') {
        const r = await callSandbox('embedReferences', payload);
        sendResponse({ ok: true, embeddings: r.embeddings, count: r.count });
        return;
      }
      if (action === 'match') {
        const r = await callSandbox('match', payload);
        sendResponse({ ok: true, results: r.results, cacheHits: r.cacheHits, dhashHits: r.dhashHits, clipHits: r.clipHits });
        return;
      }
      sendResponse({ ok: false, error: 'unknown action: ' + action });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
