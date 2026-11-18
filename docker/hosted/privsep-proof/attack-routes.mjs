#!/usr/bin/env node
// Part of the attack list (attack.sh runs it AS A WORKLOAD): the routes and features added after the
// first proof. The Inbox routes, the event stream of a company system, the connections refresh, the
// snapshot of a file a thread posts, and the spellings of their paths. One line per attempt:
// PASS (the attempt failed, as it must), FAIL (it succeeded), NOTE (stated, not a verdict).
//
// Input: the environment variables set by attack.sh (no secret among them but the token that the
// proof hands over on purpose, see attack.sh).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const E = process.env;
const HOME = E.HOME || '/home/dispatch';
const PORT = Number(E.A_PORT || 3456);
const BASE = E.A_BASE || '';
const HOSTS = (E.A_HOSTS || '127.0.0.1').split(' ').filter(Boolean);
const KEYS = (E.A_KEYS || '').split(/\s+/).filter(Boolean);
const LEAKED = E.A_LEAKED || '';
const PROFILE = E.A_PROFILE || 'developer';
const SID = E.A_SID || '';
const STATE = '/var/lib/dispatch/state';
const read = (name) => { try { return fs.readFileSync(path.join(HOME, 'proof', name), 'utf8').trim(); } catch { return ''; } };
const DROP = read('drop-id') || '00000000-0000-4000-8000-000000000000';
const FILE = read('file-id') || '00000000-0000-4000-8000-000000000001';
const SECRET_DROP = read('secret-drop-id') || DROP;
const SHAS = { inbound: E.A_IN_SHA || '', outbound: E.A_OUT_SHA || '', secret: E.A_SECRET_SHA || '' };
const LENGTHS = [...new Set([Number(E.A_TOKEN_LEN || 48), Number(E.A_SECRET_LEN || 40)])];

let pass = 0; let fail = 0; let note = 0;
const line = (verdict, name, detail = '') => console.log(`${verdict}  ${name.padEnd(58)} ${detail}`.trimEnd());
const ok = (n, d) => { pass++; line('PASS', n, d); };
const bad = (n, d) => { fail++; line('FAIL', n, d); };
const info = (n, d) => { note++; line('NOTE', n, d); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP request with the request line sent byte for byte (so any spelling of a path goes out as
 * written). Answers the status code, the headers and the first bytes of the body. `stream`: stop at
 * the headers. 0: no answer.
 */
function raw(host, method, target, headers = {}, body = '', opts = {}) {
  return new Promise((resolve) => {
    const h = host.replace(/^\[|\]$/g, '');
    const sock = net.connect({ host: h, port: PORT });
    let data = Buffer.alloc(0);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      sock.destroy();
      const text = data.toString('latin1');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
      const split = text.indexOf('\r\n\r\n');
      resolve({ status, head: split < 0 ? text : text.slice(0, split), body: split < 0 ? '' : text.slice(split + 4) });
    };
    sock.setTimeout(opts.timeoutMs ?? 8000, finish);
    sock.on('error', finish);
    sock.on('close', finish);
    sock.on('connect', () => {
      const all = { Host: `${host}:${PORT}`, Connection: 'close', ...headers };
      if (body) { all['Content-Type'] = 'application/json'; all['Content-Length'] = String(Buffer.byteLength(body)); }
      sock.write(Buffer.from(`${method} ${target} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`, 'utf8'));
    });
    sock.on('data', (d) => {
      data = Buffer.concat([data, d]);
      if (opts.stream && data.includes('\r\n\r\n')) finish();
      if (data.length > 2_000_000) finish();
    });
  });
}
const refused = (s) => [400, 401, 403, 404, 405].includes(s);
const bearer = (k) => ({ Authorization: `Bearer ${k}` });
const SSE = { Accept: 'text/event-stream' };
const local = HOSTS[0];
const kinds = new Map();
for (const k of KEYS) {
  const r = await raw(local, 'GET', `${BASE}/api/whoami`, bearer(k));
  const kind = /"kind":"([a-zA-Z]+)"/.exec(r.body)?.[1];
  if (kind) kinds.set(k, kind);
}
const live = [...kinds.keys()];
const threadKeys = live.filter((k) => kinds.get(k) === 'thread');
const label = (k) => `${kinds.get(k)} key #${live.indexOf(k) + 1}`;

/** Every token-shaped string in `text`, and every window of the known lengths inside a longer one, hashed. */
function hunt(text, found, counter) {
  for (const c of text.match(/[A-Za-z0-9_+/=.~-]{32,400}/g) ?? []) {
    const tries = new Set([c]);
    for (const n of LENGTHS) for (let i = 0; i + n <= c.length && c.length !== n; i++) tries.add(c.slice(i, i + n));
    for (const t of tries) {
      counter.n++;
      const h = crypto.createHash('sha256').update(t).digest('hex');
      for (const [name, sha] of Object.entries(SHAS)) if (sha && h === sha) found.add(name);
    }
  }
}

// ── 10. the Inbox routes and the refresh signal: the owner only, never from inside the box ─────────────────
console.log('== 10. the Inbox routes and the connections refresh (owner only)');
const OWNER_ROUTES = [
  ['GET', '/api/inbox', '', 'list the Inbox'],
  ['GET', '/api/inbox/unread', '', 'read the Inbox counts'],
  ['POST', '/api/inbox/read', '{}', 'mark the Inbox read'],
  ['GET', `/api/inbox/drops/${DROP}`, '', "read another thread's drop"],
  ['POST', `/api/inbox/drops/${DROP}/read`, '', "mark another thread's drop read"],
  ['DELETE', `/api/inbox/drops/${DROP}`, '', "delete another thread's drop"],
  ['GET', `/api/inbox/drops/${DROP}/files/${FILE}`, '', "read the file of another thread's drop"],
  ['GET', `/api/inbox/drops/${SECRET_DROP}/secret`, '', "read a secret drop's value"],
  ['GET', `/api/plugins/previews/files/${FILE}`, '', "read a drop's file through the plugin route"],
  ['POST', '/api/os/connections/refresh', '', 'send the connections refresh signal'],
];
const CREDS = [['no credential', {}], ['wrong box token', { 'x-dispatch-box-token': 'not-the-token' }]];
if (LEAKED) CREDS.push(['LEAKED inbound token', { 'x-dispatch-box-token': LEAKED }], ['LEAKED token as bearer', bearer(LEAKED)]);
for (const host of HOSTS) {
  for (const [cred, headers] of CREDS) {
    for (const [m, p, b, what] of OWNER_ROUTES) {
      const r = await raw(host, m, BASE + p, headers, b);
      (refused(r.status) ? ok : bad)(`${cred} @ ${host}: ${what}`, `HTTP ${r.status}`);
    }
  }
}
for (const k of live) {
  for (const [m, p, b, what] of OWNER_ROUTES) {
    const r = await raw(local, m, BASE + p, bearer(k), b);
    (refused(r.status) ? ok : bad)(`${label(k)}: ${what}`, `HTTP ${r.status}`);
  }
}

// ── 11. the event stream of a company system ───────────────────────────────────────────────────────────────
console.log('== 11. the event stream of a company system');
for (const host of HOSTS) {
  for (const [cred, headers] of CREDS) {
    const r = await raw(host, 'GET', `${BASE}/api/os/mcp/crm`, { ...headers, ...SSE }, '', { stream: true });
    (refused(r.status) ? ok : bad)(`${cred} @ ${host}: open a company system's event stream`, `HTTP ${r.status}`);
  }
}
for (const k of live) {
  if (kinds.get(k) === 'thread') {
    for (const system of ['payroll', 'never-named']) {
      const r = await raw(local, 'GET', `${BASE}/api/os/mcp/${system}`, { ...bearer(k), ...SSE }, '', { stream: true });
      (refused(r.status) ? ok : bad)(`${label(k)}: the stream of a system it was not given (${system})`, `HTTP ${r.status}`);
    }
    for (const host of HOSTS.slice(1)) {
      if (/^(127\.|\[?::1)/.test(host)) continue; // loopback is where a thread's stream belongs
      const r = await raw(host, 'GET', `${BASE}/api/os/mcp/crm`, { ...bearer(k), ...SSE }, '', { stream: true });
      (refused(r.status) ? ok : bad)(`${label(k)}: a stream through the box's own address`, `HTTP ${r.status}`);
    }
  } else {
    const r = await raw(local, 'GET', `${BASE}/api/os/mcp/crm`, { ...bearer(k), ...SSE }, '', { stream: true });
    (refused(r.status) ? ok : bad)(`${label(k)}: open a company system's event stream`, `HTTP ${r.status}`);
  }
}

// ── 12. the two tokens, in every answer of the new routes a key can reach ──────────────────────────────────
console.log('== 12. the tokens and a secret drop, in the answers a key can get');
const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const found = new Set(); const counter = { n: 0 }; let answers = 0;
const secretSeen = new Set(); let otherDrop = 0;
for (const k of live) {
  const got = [];
  got.push(await raw(local, 'GET', `${BASE}/api/whoami`, bearer(k)));
  got.push(await raw(local, 'GET', `${BASE}/api/plugins`, bearer(k)));
  const storage = [
    await raw(local, 'GET', `${BASE}/api/plugins/previews/data?values=1`, bearer(k)),
    await raw(local, 'GET', `${BASE}/api/plugins/previews/data/preview:${SECRET_DROP}`, bearer(k)),
  ];
  const other = await raw(local, 'GET', `${BASE}/api/plugins/previews/data/preview:${DROP}`, bearer(k));
  if (other.status === 200 && other.body.includes(DROP)) otherDrop++;
  got.push(...storage, other);
  if (kinds.get(k) === 'thread') {
    for (const system of ['os', 'crm', 'erp']) {
      got.push(await raw(local, 'POST', `${BASE}/api/os/mcp/${system}`, bearer(k), rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } })));
      got.push(await raw(local, 'POST', `${BASE}/api/os/mcp/${system}`, bearer(k), rpc('tools/list')));
      got.push(await raw(local, 'GET', `${BASE}/api/os/mcp/${system}`, { ...bearer(k), ...SSE }, '', { stream: true, timeoutMs: 1500 }));
    }
    got.push(await raw(local, 'POST', `${BASE}/api/os/mcp/os`, bearer(k), rpc('tools/call', { name: 'refresh', arguments: {} }), { timeoutMs: 20_000 }));
    got.push(await raw(local, 'POST', `${BASE}/api/os/mcp/os`, bearer(k), rpc('tools/call', { name: 'list', arguments: {} }), { timeoutMs: 20_000 }));
    got.push(await raw(local, 'POST', `${BASE}/api/os/mcp/crm`, bearer(k), rpc('tools/call', { name: 'get_customer', arguments: { id: '1' } }), { timeoutMs: 20_000 }));
  }
  for (const r of got) { answers++; hunt(`${r.head}\n${r.body}`, found, counter); }
  const mine = new Set(); const c2 = { n: 0 };
  for (const r of storage) hunt(r.body, mine, c2);
  if (mine.has('secret')) secretSeen.add(kinds.get(k));
}
const leakedTokens = [...found].filter((n) => n !== 'secret');
(leakedTokens.length === 0 ? ok : bad)('neither box token is in any answer of these routes', `${answers} answers, ${counter.n} candidates hashed${leakedTokens.length ? `: ${leakedTokens.join(' ')}` : ''}`);
if (SHAS.secret) {
  if (secretSeen.size === 0) ok("a secret drop's value is in no answer a key can get", `${PROFILE} profile`);
  else if (PROFILE === 'business') bad("a secret drop's value is in no answer a key can get", `read back with a ${[...secretSeen].join(', ')} key`);
  else info("developer profile: a key reads a secret drop's value back", `${[...secretSeen].join(', ')} key, through the plugin's storage route (that profile's design)`);
}
if (otherDrop > 0) info("a key reads the TEXT of another thread's drop", "through the plugin's storage route: threads of one box are not isolated (design, section 12)");

// ── 13. a link where the snapshot of a posted file is read ─────────────────────────────────────────────────
console.log('== 13. a link where the Inbox snapshot reads');
const project = path.join(HOME, 'projects', 'proj1');
const NAMES = ['accounts.json', 'plugins.json', 'settings.json', 'installer.json', 'push.json'];
const MARK = 'AGENT-OWN-FILE';
const poster = live.find((k) => kinds.get(k) === 'thread') ?? live.find((k) => kinds.get(k) === 'plugin');
if (!poster || !fs.existsSync(project)) {
  info('no key that may post a file could be collected', 'the snapshot rows did not run');
} else {
  const post = (p) => raw(local, 'POST', `${BASE}/api/plugins/previews/files`, bearer(poster), JSON.stringify({ path: p, sessionId: SID }));
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } };
  // (a) a link as the file itself; (b) a linked folder on the way.
  const linkFile = path.join(project, 'snap-link.json'); rm(linkFile);
  try { fs.symlinkSync(path.join(STATE, 'accounts.json'), linkFile); } catch { /* reported by the post */ }
  let r = await post(linkFile);
  (refused(r.status) ? ok : bad)("post a link to the daemon's state as a drop file", `HTTP ${r.status}`);
  const linkDir = path.join(project, 'snapdir'); rm(linkDir);
  try { fs.symlinkSync(STATE, linkDir); } catch { /* reported by the post */ }
  r = await post(path.join(linkDir, 'accounts.json'));
  (refused(r.status) ? ok : bad)("post a file through a folder linked to the daemon's state", `HTTP ${r.status}`);
  rm(linkFile); rm(linkDir);
  // (c) the race: a real folder with the agent's own files that becomes a link to the state root
  // between the daemon's check of the path and its read. The daemon must never copy a file the agent
  // could not read itself. Every accepted post is counted; the proof script (outside the box) reads
  // the copies and fails the row when one does not carry the agent's own marker.
  const race = path.join(project, 'race'); const real = path.join(project, 'race.real');
  rm(race); rm(real);
  fs.mkdirSync(real);
  for (const n of NAMES) fs.writeFileSync(path.join(real, n), JSON.stringify({ marker: MARK }));
  fs.renameSync(real, race);
  const flip = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const [dir, bak, target] = process.argv.slice(1); const end = Date.now() + 7000;
    while (Date.now() < end) {
      try { fs.renameSync(dir, bak); fs.symlinkSync(target, dir); } catch {}
      try { fs.unlinkSync(dir); fs.renameSync(bak, dir); } catch {}
    }
    try { if (fs.lstatSync(dir).isSymbolicLink()) { fs.unlinkSync(dir); fs.renameSync(bak, dir); } } catch {}
  `, race, real, STATE], { stdio: 'ignore' });
  let accepted = 0; let tried = 0;
  const until = Date.now() + 6500;
  while (Date.now() < until) {
    const batch = await Promise.all(NAMES.map((n) => post(path.join(race, n))));
    for (const b of batch) { tried++; if (b.status === 201) accepted++; }
  }
  await new Promise((res) => flip.on('close', res));
  fs.writeFileSync(path.join(HOME, 'proof', `race-${PROFILE}.count`), `${accepted} ${tried}\n`);
  info('posts accepted while a folder was swapped for a link', `${accepted} of ${tried}; the proof script reads every copy from outside the box`);
  rm(race); rm(real);
}

// ── 14. twenty spellings of each new path ──────────────────────────────────────────────────────────────────
console.log('== 14. twenty spellings of each new path');
/** Twenty other spellings of `/api/<rest>` (the list of the route-gate work): none may reach the route. */
function spellings(p) {
  const segs = p.split('/'); // ['', 'api', ...]
  const last = segs.length - 1;
  const word = segs[2];
  const tail = segs.slice(3).join('/');
  const rest = (w) => `/api/${w}${tail ? `/${tail}` : ''}`;
  return [
    `/API/${segs.slice(2).join('/')}`,
    rest(word[0].toUpperCase() + word.slice(1)),
    rest(word.toUpperCase()),
    `/api//${segs.slice(2).join('/')}`,
    `/${p}`,
    `/api/./${segs.slice(2).join('/')}`,
    `/api/x/../${segs.slice(2).join('/')}`,
    `/api/%2e/${segs.slice(2).join('/')}`,
    `/api/%2e%2e/api/${segs.slice(2).join('/')}`,
    `/api%2f${segs.slice(2).join('/')}`,
    `/api%2F${segs.slice(2).join('/')}`,
    `/api%5c${segs.slice(2).join('/')}`,
    `/api\\${segs.slice(2).join('/')}`,
    `${p}/`,
    `${p}//`,
    `${p}%00`,
    `${p};a=b`,
    rest(`%${word.charCodeAt(0).toString(16)}${word.slice(1)}`),
    `${p}/.`,
    `${segs.slice(0, last).join('/')}/${String.fromCharCode(0xff00 + segs[last].charCodeAt(0) - 0x20)}${segs[last].slice(1)}`,
  ];
}
const SPELLED = [
  ['GET', '/api/inbox', {}],
  ['GET', `/api/inbox/drops/${SECRET_DROP}/secret`, {}],
  ['GET', `/api/inbox/drops/${DROP}/files/${FILE}`, {}],
  ['POST', '/api/os/connections/refresh', {}],
  ['GET', '/api/os/mcp/crm', SSE],
];
const SPELL_CREDS = [['no credential', {}]];
if (LEAKED) SPELL_CREDS.push(['LEAKED inbound token', { 'x-dispatch-box-token': LEAKED }]);
for (const k of live) SPELL_CREDS.push([label(k), bearer(k)]);
for (const [m, p, extra] of SPELLED) {
  for (const [cred, headers] of SPELL_CREDS) {
    const seen = {}; const through = [];
    for (const s of spellings(p)) {
      const r = await raw(local, m, BASE + s, { ...headers, ...extra }, '', { stream: true, timeoutMs: 4000 });
      seen[r.status] = (seen[r.status] ?? 0) + 1;
      if ((r.status >= 200 && r.status < 300) || r.status === 101) through.push(s); // a handler answered
    }
    const summary = Object.entries(seen).map(([s, n]) => `${n}x${s}`).join(' ');
    (through.length === 0 ? ok : bad)(`${cred}: 20 spellings of ${m} ${p.replace(DROP, '<drop>').replace(SECRET_DROP, '<drop>').replace(FILE, '<file>')}`, through.length ? `reached: ${through[0]}` : summary);
  }
}

console.log(`== routes result: ${pass} passed, ${fail} FAILED, ${note} notes`);
await sleep(50);
process.exit(fail === 0 ? 0 : 1);
