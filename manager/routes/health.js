// Health + manager-version endpoints. Both are cheap GETs used by the
// dashboard topbar poll — the extension pings /api/health every ~10s and
// /api/manager/version every ~30s. Kept trivially simple; no DB writes.
'use strict';

function register(router) {
  router.get('/api/health', ({ res, ctx }) => {
    return ctx.send(res, 200, { ok: true, ts: ctx.now() });
  });

  router.get('/api/manager/version', ({ res, ctx }) => {
    // Merge the live git-HEAD data with the boot-time commit hash so the
    // dashboard can detect 'code on disk changed but process not restarted'.
    // boot_commit is captured ONCE at module load in server.js.
    const live = ctx.currentManagerVersion();
    return ctx.send(res, 200, { ...live, boot_commit: ctx.bootCommit || null, needs_restart: !!(live.commit && ctx.bootCommit && live.commit !== ctx.bootCommit) });
  });
}

module.exports = { register };
