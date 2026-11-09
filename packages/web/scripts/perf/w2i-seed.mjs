// W2-I perf: seeds an ISOLATED daemon (fake HOME, fake claude on PATH) for the latency checks.
// Run:  BASE=http://localhost:4129 TOKEN_FILE=<fake home>/.dispatch/access-token WORKDIR=<temp dir> node packages/web/scripts/perf/w2i-seed.mjs
// Never run it on a real daemon. It creates a project, three Pretty threads and one shell terminal.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire(new URL('../../../core/package.json', import.meta.url))('ws');

const BASE = process.env.BASE ?? 'http://localhost:4129';
if (/:3456\b/.test(BASE)) { console.error('refusing to seed the real daemon'); process.exit(2); }
const token = fs.readFileSync(process.env.TOKEN_FILE, 'utf8').trim();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const project = await call('POST', '/api/sessions', { provider: 'claude-code', name: 'Latency', workingDir: process.env.WORKDIR });
const thread = async (label, messages) => {
  const t = await call('POST', `/api/sessions/${project.id}/terminals`, { type: 'claude-code', label, config: { transport: 'structured' } });
  await sleep(1500); // the fake CLI starts
  for (let i = 0; i < messages; i++) {
    await call('POST', `/api/terminals/${t.id}/message`, { text: `${label} question ${i}: what does step ${i} of the plan do, and which file holds it?`, source: 'user' });
    await sleep(40);
  }
  return t.id;
};
const alpha = await thread('Alpha', 70);   // 70 turns: over 200 ring events
const beta = await thread('Beta', 4);
const doomed = [];
for (const n of ['one', 'two', 'three', 'four', 'five', 'six']) doomed.push(await thread(`Doomed ${n}`, 1)); // one for each archive run

// A shell terminal with more than 4 MB of scrollback.
const shell = await call('POST', `/api/sessions/${project.id}/terminals`, { type: 'shell', label: 'Shell' });
await sleep(1000);
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/terminals/${shell.id}/ws?replayBytes=1000`, { headers: { Authorization: `Bearer ${token}` } });
await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
ws.send("clear; seq 1 760000 | awk '{ print \"\\033[32mline\\033[0m\", $1, \"of the build log: compiled module\", $1 % 977, \"in\", $1 % 89, \"ms\" }' | head -c 4600000; echo; echo SEED-DONE\r");
let tail = '';
await new Promise((resolve) => { ws.on('message', (d) => { tail = (tail + d.toString()).slice(-400); if (/SEED-DONE\r?\n/.test(tail)) resolve(); }); setTimeout(resolve, 60_000); });
ws.close();
const size = await call('GET', `/api/terminals/${shell.id}/scrollback`).catch((e) => String(e));
console.log(JSON.stringify({ project: project.id, alpha, beta, doomed, shell: shell.id, scrollback: size }, null, 2));
