// The Coach worker (docs/plugins.md, "The worker"; coach spec section 8). The daemon starts it while
// the plugin is enabled and writes its events to stdin, one JSON object per line. It folds the
// thread events into the signals state, runs the detectors when a turn ends, and writes new
// candidates to the plugin's own storage. Coaching then does not depend on an open browser tab.
//
// Documents: `signals` (the rolling state, lib/signals.mjs) and `candidates` ({ items, seen }).
import fs from 'node:fs';
import readline from 'node:readline';
import { withDefaults } from '../lib/settings.mjs';
import { collect, emptyState } from '../lib/signals.mjs';
import { detect, proposeNew } from '../lib/detectors.mjs';

const API = process.env.DISPATCH_API;
const PLUGIN = process.env.DISPATCH_PLUGIN || 'coach';
const key = () => fs.readFileSync(process.env.DISPATCH_PLUGIN_AUTH_FILE, 'utf8').trim();
const SAVE_DELAY_MS = 5_000;

async function call(method, route, body) {
  const res = await fetch(API + route, { method, headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`);
  return res.json().catch(() => null);
}
const getDoc = async (k, fallback) => { const r = await call('GET', `/api/plugins/${PLUGIN}/data/${k}`); return r && r.value !== undefined ? r.value : fallback; };
const putDoc = (k, value) => call('PUT', `/api/plugins/${PLUGIN}/data/${k}`, { value });

let settings = withDefaults(null);
let state = emptyState();
let candidates = { items: [], seen: [] };
let saveTimer = null;
let ready = false;
const backlog = [];

async function loadSettings() {
  try { const r = await call('GET', `/api/plugins/${PLUGIN}/settings`); settings = withDefaults(r && r.value); } catch (err) { console.error('settings:', err.message); }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    putDoc('signals', state).catch((err) => console.error('signals save failed:', err.message));
  }, SAVE_DELAY_MS);
}

async function runDetectors() {
  const found = detect(state, settings, new Date());
  if (!found.length) return;
  const next = proposeNew(candidates, found, new Date());
  if (!next.added.length) return;
  candidates = { items: next.items, seen: next.seen };
  await putDoc('candidates', candidates);
  for (const c of next.added) console.log(`candidate ${c.id}`);
}

function handle(e) {
  if (e.type === 'plugin:settings') { void loadSettings(); return; }
  if (e.type === 'plugin:job' && e.id === 'weekly') return; // the weekly recap (plan Task 12)
  if (typeof e.type !== 'string' || !e.type.startsWith('thread:')) return;
  const next = collect(e, state, settings);
  if (next === state) return;
  state = next;
  saveSoon();
  if (e.type === 'thread:turn') runDetectors().catch((err) => console.error('detect failed:', err.message));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (ready) handle(e); else backlog.push(e);
});
rl.on('close', () => process.exit(0)); // the daemon closed the feed: it is stopping us
process.on('SIGTERM', () => {
  // Keep what was folded since the last save, then go (the daemon kills us 3 s later).
  if (saveTimer) { clearTimeout(saveTimer); putDoc('signals', state).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2_000); } else process.exit(0);
});

(async () => {
  await loadSettings();
  try {
    const saved = await getDoc('signals', null);
    if (saved && saved.v === 1) state = { ...emptyState(), ...saved };
    candidates = await getDoc('candidates', candidates);
  } catch (err) { console.error('load failed:', err.message); }
  ready = true;
  for (const e of backlog.splice(0)) handle(e);
  console.log('coach worker started');
})();
