// The Daily rundown worker (docs/plugins.md, "The worker"). The daemon starts it while the plugin
// is enabled and writes its events to stdin, one JSON object per line. It keeps the turns it hears,
// writes one rundown document when the morning job fires, and answers /health on its socket.
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

const API = process.env.DISPATCH_API;
const PLUGIN = process.env.DISPATCH_PLUGIN;
const key = () => fs.readFileSync(process.env.DISPATCH_PLUGIN_AUTH_FILE, 'utf8').trim();

async function call(method, route, body) {
  const res = await fetch(API + route, { method, headers: { Authorization: `Bearer ${key()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}`);
  return res.json().catch(() => null);
}

const turns = [];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'thread:turn') turns.push({ terminalId: e.terminalId, sessionId: e.sessionId, at: e.at, outcome: e.outcome, summary: e.summary ?? null });
  if (e.type === 'plugin:job' && e.id === 'morning') {
    const day = e.at.slice(0, 10);
    call('PUT', `/api/plugins/${PLUGIN}/data/rundown:${day}`, { value: { day, turns: turns.splice(0) } })
      .then(() => console.log(`rundown for ${day} written`))
      .catch((err) => console.error('rundown failed:', err.message));
  }
});
rl.on('close', () => process.exit(0)); // the daemon closed the feed: it is stopping us

http.createServer((req, res) => {
  // The daemon says who is calling; the owner's browser reaches this through d.worker.fetch.
  if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, pending: turns.length, caller: req.headers['x-dispatch-principal'] })); return; }
  res.statusCode = 404; res.end();
}).listen(process.env.DISPATCH_PLUGIN_SOCKET, () => console.log('rundown worker listening'));

process.on('SIGTERM', () => process.exit(0));
