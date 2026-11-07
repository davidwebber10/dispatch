// The Coach worker (docs/plugins.md, "The worker"; coach spec section 8). The daemon starts it while
// the plugin is enabled and writes its events to stdin, one JSON object per line. Coaching then
// does not depend on a browser tab being open.
import fs from 'node:fs';
import readline from 'node:readline';
import { withDefaults } from '../lib/settings.mjs';

const API = process.env.DISPATCH_API;
const PLUGIN = process.env.DISPATCH_PLUGIN || 'coach';
const key = () => fs.readFileSync(process.env.DISPATCH_PLUGIN_AUTH_FILE, 'utf8').trim();

async function call(method, route, body) {
  const res = await fetch(API + route, { method, headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`);
  return res.json().catch(() => null);
}

let settings = withDefaults(null);
async function loadSettings() {
  try { const r = await call('GET', `/api/plugins/${PLUGIN}/settings`); settings = withDefaults(r && r.value); } catch (err) { console.error('settings:', err.message); }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'plugin:settings') void loadSettings();
});
rl.on('close', () => process.exit(0)); // the daemon closed the feed: it is stopping us
process.on('SIGTERM', () => process.exit(0));

void loadSettings().then(() => console.log('coach worker started'));
