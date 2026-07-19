// SQLite backup endpoints — list snapshots and trigger a new one on
// demand. Backups are also created automatically by a cron in server.js;
// this is the manual button behind the Backups card.
'use strict';

function listBackups({ res, ctx }) {
  const { send, listBackups: listFn, BACKUP_KEEP_N, BACKUP_DIR } = ctx;
  return send(res, 200, {
    ok: true,
    backups: listFn(),
    keepN: BACKUP_KEEP_N,
    dir: BACKUP_DIR,
  });
}

function createBackup({ res, ctx }) {
  const { send, runBackup } = ctx;
  const r = runBackup();
  if (!r.ok) return send(res, 500, r);
  return send(res, 200, r);
}

function register(router) {
  router.get ('/api/backups/list',   listBackups);
  router.post('/api/backups/create', createBackup);
}

module.exports = { register };
