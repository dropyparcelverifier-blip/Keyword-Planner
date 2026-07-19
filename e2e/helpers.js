// Per-spec manager setup. Each spec that needs a manager calls
// `startManager()` in beforeAll and `stopManager()` in afterAll, then
// hits the returned baseUrl for HTTP + the dashboard page. State is
// isolated by using a temp DB per instance.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// __dirname isn't available in ESM, but Playwright runs specs from the
// repo root so a relative resolve works reliably. No need for
// fileURLToPath / import.meta.url plumbing.
const REPO = resolve(process.cwd());
const SERVER = join(REPO, 'manager/server.js');
const TOKEN = 'e2e-token';

// Ports 19000-20999 (2000 range) is comfortably above the regression
// suite's 18000-19999 to avoid collisions on parallel runs.
function randomPort() {
  return 19000 + Math.floor(Math.random() * 2000);
}

// Spawns a manager instance. Returns { baseUrl, token, stop, dbDir } once
// the server responds to /api/health. Callers are expected to invoke
// stop() in afterAll — it kills the process and deletes the temp DB dir.
export async function startManager() {
  const port = randomPort();
  const dbDir = mkdtempSync(join(tmpdir(), 'adbrain-e2e-'));
  const dbPath = join(dbDir, 'test.db');
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      MANAGER_TOKEN: TOKEN,
      DB: dbPath,
      HOST: '127.0.0.1',
      // Skip the auto-backup cron; not needed for e2e and it clutters temp.
      BACKUP_ENABLE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface real crashes; ignore normal shutdown noise.
  proc.stderr.on('data', d => {
    const s = String(d);
    if (!/EADDRINUSE|SIGTERM/.test(s)) process.stderr.write(`[manager-e2e] ${s}`);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`, { headers: { 'X-Manager-Token': TOKEN } });
      if (r.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const stop = async () => {
    proc.kill();
    await new Promise(r => proc.on('exit', r));
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
  };
  return { baseUrl, token: TOKEN, stop, dbDir };
}

// Convenience wrapper — every dashboard request must carry the token.
export async function post(baseUrl, path, body) {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Manager-Token': TOKEN },
    body: JSON.stringify(body),
  });
  return r.json();
}
export async function get(baseUrl, path) {
  const r = await fetch(baseUrl + path, { headers: { 'X-Manager-Token': TOKEN } });
  return r.json();
}

// The dashboard reads its token from localStorage (adbrainManagerToken).
// We inject it via addInitScript BEFORE the page loads so the first
// dashboard poll succeeds — otherwise every request 401s until the user
// pastes the token in Settings.
export async function bootstrapDashboardAuth(page, token) {
  await page.addInitScript((t) => {
    try { localStorage.setItem('adbrainManagerToken', t); } catch {}
  }, token);
}
