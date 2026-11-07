// The Coach worker (docs/plugins.md, "The worker"; coach spec section 8). The daemon starts it while
// the plugin is enabled and writes its events to stdin, one JSON object per line. The engine
// (lib/engine.mjs) folds the thread events into the signals state, runs the detectors when a turn
// ends, judges new candidates into cards, and runs the weekly recap. This file is only its I/O:
// the plugin key, the daemon's routes, stdin. Coaching then does not depend on an open browser tab.
import fs from 'node:fs';
import readline from 'node:readline';
import { createEngine } from '../lib/engine.mjs';
import { makeAssist } from '../lib/client.mjs';

const API = process.env.DISPATCH_API;
const PLUGIN = process.env.DISPATCH_PLUGIN || 'coach';
const key = () => fs.readFileSync(process.env.DISPATCH_PLUGIN_AUTH_FILE, 'utf8').trim();

async function call(method, route, body) {
  const res = await fetch(API + route, { method, headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`);
  return res.json().catch(() => null);
}
const base = `/api/plugins/${encodeURIComponent(PLUGIN)}`;

const engine = createEngine({
  getDoc: async (k, fallback) => { const r = await call('GET', `${base}/data/${k}`); return r && r.value !== undefined ? r.value : fallback; },
  putDoc: (k, value) => call('PUT', `${base}/data/${k}`, { value }),
  getSettings: async () => { const r = await call('GET', `${base}/settings`); return r && r.value; },
  assist: makeAssist({ fetch, api: API, plugin: PLUGIN, key }),
  notify: async (body) => {
    const res = await fetch(`${API}${base}/notify`, { method: 'POST', headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    return { ok: !!res && res.ok, status: res ? res.status : 0 };
  },
  getJson: (route) => call('GET', route),
  now: () => new Date(),
  log: (...a) => console.log(...a),
});

let ready = false;
const backlog = [];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (ready) void engine.handle(e); else backlog.push(e);
});
rl.on('close', () => process.exit(0)); // the daemon closed the feed: it is stopping us
process.on('SIGTERM', () => {
  // Keep what was folded since the last save, then go (the daemon kills us 3 s later).
  setTimeout(() => process.exit(0), 2_000);
  engine.flush().catch(() => {}).finally(() => process.exit(0));
});

(async () => {
  await engine.load();
  ready = true;
  for (const e of backlog.splice(0)) void engine.handle(e);
  console.log('coach worker started');
})();
