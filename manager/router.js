// Tiny route registry — replaces the previous if-ladder inside server.js.
//
// Handlers are added by section modules (routes/*.js) and dispatched via
// method + exact-path lookup. Exact-match only: every current endpoint is
// exact-path, so we don't pay for regex compilation. If a route needs
// path params later, add a compile step here.
//
// Handler signature: async ({ req, res, url, ctx }) => any
//   - Returning nothing / undefined means the handler already wrote the
//     response (via ctx.send or res.writeHead+res.end).
//   - Handler exceptions bubble to the outer try/catch in server.js which
//     emits a 500. Individual handlers should still return early with
//     ctx.send(res, 4xx, {...}) for expected error paths so the caller
//     sees a proper JSON error body instead of a generic 500.

'use strict';

function createRouter() {
  // Two-level map: method -> path -> handler. O(1) lookup per request.
  // Faster than iterating a route list, and every endpoint is exact-path.
  const table = Object.create(null);
  const api = {
    add(method, path, handler) {
      const M = method.toUpperCase();
      if (!table[M]) table[M] = Object.create(null);
      if (table[M][path]) throw new Error(`router: duplicate ${M} ${path}`);
      table[M][path] = handler;
      return api;
    },
    get:  (p, h) => api.add('GET',    p, h),
    post: (p, h) => api.add('POST',   p, h),
    put:  (p, h) => api.add('PUT',    p, h),
    del:  (p, h) => api.add('DELETE', p, h),
    // Look up a handler for (method, path). Returns null if none.
    find(method, path) {
      const bucket = table[method.toUpperCase()];
      return bucket ? (bucket[path] || null) : null;
    },
    // Full dispatch. Returns true if a route was matched (and the response
    // was handled); false if no match (caller falls through to legacy
    // routing / 404). Any handler exception bubbles up.
    async dispatch(req, res, url, ctx) {
      const h = api.find(req.method, url.pathname);
      if (!h) return false;
      await h({ req, res, url, ctx });
      return true;
    },
    // Introspection — used by tests to verify route coverage without
    // hitting HTTP.
    list() {
      const out = [];
      for (const M of Object.keys(table)) for (const p of Object.keys(table[M])) out.push([M, p]);
      return out;
    },
  };
  return api;
}

module.exports = { createRouter };
