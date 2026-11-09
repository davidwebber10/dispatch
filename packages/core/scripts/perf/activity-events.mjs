// Perf check for W1-E item 4 (plan section 1A.3, "Activity events").
// Counts `terminal:activity` frames on the events socket of an ISOLATED daemon for 60 s, with 10 shell
// terminals that print all the time: 5 print a short line each 4 s (below the busy threshold), 5 print a
// 700-byte line each 4 s (busy, then idle, again and again).
// Run:  node packages/core/scripts/perf/activity-events.mjs <port> <owner header file> [seconds]
// The header file holds one line, `Authorization: Bearer <token of the fake HOME>`, so no secret is in argv.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire(import.meta.url)('ws');

const port = Number(process.argv[2]);
const headerFile = process.argv[3];
const seconds = Number(process.argv[4] ?? 60);
if (!port || port === 3456 || !headerFile) { console.error('usage: activity-events.mjs <port, never 3456> <owner header file> [seconds]'); process.exit(2); }
const auth = fs.readFileSync(headerFile, 'utf8').trim().replace(/^Authorization:\s*/i, '');
const headers = { Authorization: auth, 'Content-Type': 'application/json' };
const base = `http://127.0.0.1:${port}`;
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = await post('/api/sessions', { provider: 'claude-code', name: 'activity-perf', workingDir: '/tmp' });
const terminals = [];
for (let i = 0; i < 10; i++) terminals.push((await post(`/api/sessions/${session.id}/terminals`, { type: 'shell', label: `sh-${i}` })).id);

const sockets = [];
for (const [i, id] of terminals.entries()) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers: { Authorization: auth } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', () => {});
  sockets.push(ws);
  const cmd = i < 5
    ? "while :; do echo tick; sleep 4; done\n"
    : "while :; do head -c 700 /dev/zero | tr '\\0' x; echo; sleep 4; done\n";
  await sleep(300);
  ws.send(cmd);
}
await sleep(7000); // past the 5 s grace window of the monitor

const events = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { Authorization: auth } });
await new Promise((res, rej) => { events.on('open', res); events.on('error', rej); });
let frames = 0; let bytes = 0;
const perTerminal = new Map();
events.on('message', (data) => {
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.type !== 'terminal:activity' || !terminals.includes(m.terminalId)) return;
  frames++; bytes += data.length;
  perTerminal.set(m.terminalId, (perTerminal.get(m.terminalId) ?? 0) + 1);
});
await sleep(seconds * 1000);
events.close();
for (const ws of sockets) ws.close();
await post(`/api/sessions/${session.id}/stop`).catch(() => {});

const counts = terminals.map((id) => perTerminal.get(id) ?? 0);
console.log(JSON.stringify({
  seconds, terminals: terminals.length, extensions: events.extensions || '(none)',
  activityFrames: frames, framesPerMinute: +(frames * 60 / seconds).toFixed(1), payloadBytes: bytes,
  quietTerminals: counts.slice(0, 5), burstTerminals: counts.slice(5),
}, null, 2));
process.exit(0);
