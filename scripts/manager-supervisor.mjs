// manager-supervisor.mjs
//
// Zero-dependency watchdog for the AdBrain manager. Runs `node manager/server.js`
// as a child process, watches manager/server.js + manager/routes/ + manager/router.js
// for changes, and gracefully restarts the child when any file mtime changes.
//
// Purpose: eliminate the "operator has to Stop-Process and re-Start-Process the
// manager after every push" friction. Point this supervisor at the manager once
// and every future `git pull` on the manager machine auto-reloads it within
// seconds. Combined with the chrome-watchdog auto-update on worker PCs, the
// operator has zero manual reinstall / reload steps for either side.
//
// Usage (on the manager PC):
//   node scripts/manager-supervisor.mjs
//
// It replaces `node manager/server.js`. Same env, same port, same behaviour —
// just adds file-change auto-restart.

import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT      = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ENTRY     = join(ROOT, 'manager', 'server.js');
const WATCH_DIRS = [
  join(ROOT, 'manager'),           // server.js, router.js
  join(ROOT, 'manager', 'routes'), // any route module
];
const POLL_MS       = 2000;   // stat files every 2s — cheap on 5-10 files
const RESTART_DEBOUNCE_MS = 1500;   // don't restart more than once per 1.5s
const IGNORE_RE     = /(\.db(-shm|-wal)?|\.log|backups\/)$/;

let child = null;
let lastRestartAt = 0;
let restartPending = false;
const knownMtimes = new Map();

function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[supervisor] ${t} ${msg}`);
}

function collectFiles() {
  const files = [];
  for (const dir of WATCH_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (IGNORE_RE.test(p)) continue;
      try {
        const st = statSync(p);
        if (st.isFile()) files.push(p);
      } catch {}
    }
  }
  return files;
}

function seedMtimes() {
  for (const f of collectFiles()) {
    try { knownMtimes.set(f, statSync(f).mtimeMs); } catch {}
  }
  log(`Watching ${knownMtimes.size} file(s) across ${WATCH_DIRS.length} dir(s).`);
}

function detectChanges() {
  const changed = [];
  const current = new Set();
  for (const f of collectFiles()) {
    current.add(f);
    try {
      const mt = statSync(f).mtimeMs;
      const prev = knownMtimes.get(f);
      if (prev == null || prev !== mt) {
        changed.push({ f, prev, mt });
        knownMtimes.set(f, mt);
      }
    } catch {}
  }
  // Detect deletions too (rarer but worth restarting on)
  for (const f of knownMtimes.keys()) {
    if (!current.has(f)) {
      changed.push({ f, deleted: true });
      knownMtimes.delete(f);
    }
  }
  return changed;
}

function startChild() {
  if (child) {
    log(`Child already running (pid=${child.pid}), skipping start.`);
    return;
  }
  log(`Starting: node ${ENTRY}`);
  child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  const startedPid = child.pid;
  child.on('exit', (code, signal) => {
    log(`Child pid=${startedPid} exited (code=${code}, signal=${signal})`);
    // Only clear `child` if this exit belongs to the CURRENT tracked child —
    // during a restart we spawn a new one before the old one has finished
    // dying, and we don't want that new one clobbered.
    if (child && child.pid === startedPid) child = null;
    // If the exit wasn't due to a restart signal, wait a bit then relaunch.
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      log(`Unexpected exit — restarting in 2s`);
      setTimeout(() => { if (!child) startChild(); }, 2000);
    }
  });
}

function restartChild(reason) {
  const now = Date.now();
  if (now - lastRestartAt < RESTART_DEBOUNCE_MS) {
    if (!restartPending) {
      restartPending = true;
      setTimeout(() => { restartPending = false; restartChild(reason); }, RESTART_DEBOUNCE_MS);
    }
    return;
  }
  lastRestartAt = now;
  log(`Restart: ${reason}`);
  if (child) {
    const dying = child;
    child = null;
    dying.kill('SIGTERM');
    // Give it 1.5s to exit gracefully, then hard-kill
    setTimeout(() => {
      try { if (!dying.killed) dying.kill('SIGKILL'); } catch {}
    }, 1500);
    // Start new child after brief pause so port + WAL settle
    setTimeout(() => startChild(), 500);
  } else {
    startChild();
  }
}

// SIGINT / SIGTERM → clean shutdown
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    log(`Received ${sig} — shutting down child + supervisor.`);
    if (child) { try { child.kill('SIGTERM'); } catch {} }
    setTimeout(() => process.exit(0), 500);
  });
}

log(`AdBrain manager supervisor started.`);
log(`Root: ${ROOT}`);
log(`Watching: ${WATCH_DIRS.join(', ')}`);
log(`Poll: every ${POLL_MS}ms. Restart debounce: ${RESTART_DEBOUNCE_MS}ms.`);

seedMtimes();
startChild();

setInterval(() => {
  const changes = detectChanges();
  if (changes.length === 0) return;
  const summary = changes
    .slice(0, 3)
    .map(c => c.deleted ? `deleted ${c.f.split(/[/\\]/).pop()}` : `${c.f.split(/[/\\]/).pop()}`)
    .join(', ');
  const extra = changes.length > 3 ? ` (+${changes.length - 3} more)` : '';
  restartChild(`${changes.length} file(s) changed: ${summary}${extra}`);
}, POLL_MS);
