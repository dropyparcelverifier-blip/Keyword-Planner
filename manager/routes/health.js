// Health + manager-version endpoints. Both are cheap GETs used by the
// dashboard topbar poll — the extension pings /api/health every ~10s and
// /api/manager/version every ~30s. Kept trivially simple; no DB writes.
'use strict';

function register(router) {
  router.get('/api/health', ({ res, ctx }) => {
    return ctx.send(res, 200, { ok: true, ts: ctx.now() });
  });

  router.get('/api/manager/version', ({ res, ctx }) => {
    return ctx.send(res, 200, ctx.currentManagerVersion());
  });
}

module.exports = { register };
