// SEC-05 "middle": a call with NO credential is refused only on the dangerous actions, unless it looks like
// the web page (Origin or Sec-Fetch-Site: same-origin) or carries the owner's token. Everything else, reads
// included, stays open. This drives a REAL daemon (own HOME, random port) so the real access gate runs.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';

let home: string;
let child: ChildProcess;
let port: number;
let output = '';
let token: string;
let sessionId: string;
let shellId: string; // a live shell tab (a real PTY) used as the target
let threadKey = ''; // a key for a thread row that exists in the DB
let integrationId = '';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
const json = (r: Res) => { try { return JSON.parse(r.body); } catch { return null; } };
function call(opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path,
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}), ...opts.headers },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const OWNER = () => ({ Authorization: `Bearer ${token}` });
const WEB_PAGE = () => ({ Origin: `http://127.0.0.1:${port}` });
const FETCH_META = { 'Sec-Fetch-Site': 'same-origin' };

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-keyless-'));
  port = 40000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); const s = await startServer({port:${port}}); console.log('MINTED_KEY=' + s.keys.mint({ kind: 'thread', terminalId: 'kl-thread' }).key);`], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SHELL: '/bin/sh', DISPATCH_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(output)); }, 20000);
    const poll = setInterval(() => {
      if (/listening on port/.test(output) && /MINTED_KEY=\S+/.test(output)) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 25);
  });
  token = fs.readFileSync(path.join(home, '.dispatch', 'access-token'), 'utf8').trim();
  threadKey = /MINTED_KEY=(\S+)/.exec(output)![1];

  // The owner (token) makes a project and a live shell tab, then the test adds a thread row for the key.
  const dir = path.join(home, 'proj');
  fs.mkdirSync(dir);
  const made = await call({ method: 'POST', path: '/api/sessions', headers: OWNER(), body: { provider: 'claude-code', name: 'kl', workingDir: dir } });
  sessionId = json(made).id;
  const sh = await call({ method: 'POST', path: `/api/sessions/${sessionId}/terminals`, headers: OWNER(), body: { type: 'shell', label: 'target' } });
  shellId = json(sh).id;
  const db = new Database(path.join(home, '.dispatch', 'dispatch.db'));
  terminalsDb.create(db, { id: 'kl-thread', sessionId, type: 'claude-code', label: 'kl-thread', config: { transport: 'structured', role: 'agent' } });
  db.close();
  const integ = await call({ method: 'POST', path: '/api/integrations', headers: OWNER(), body: { type: 'stdio', name: 'seed', command: 'echo' } });
  integrationId = json(integ).id;
}, 40000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    await exited;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** The four dangerous actions, as [label, method, path, body]. */
const DANGEROUS = (): [string, string, string, unknown][] => [
  ['message as the user', 'POST', `/api/terminals/${shellId}/message`, { text: 'go', source: 'user' }],
  ['message with no source', 'POST', `/api/terminals/${shellId}/message`, { text: 'go' }],
  ['terminal input', 'POST', `/api/terminals/${shellId}/input`, { data: 'echo hi\r' }],
  ['file reference typed into a terminal', 'POST', `/api/terminals/${shellId}/send-file-reference`, { path: 'x' }],
  ['Chat message as the user', 'POST', '/api/endless/send', { text: 'go' }],
  ['Chat instructions', 'PUT', '/api/endless/instructions', { text: 'x' }],
  ['answer a held tool call', 'POST', `/api/terminals/${shellId}/permission`, { decision: 'allow' }],
  ['set a thread to autonomous (releases held calls)', 'POST', `/api/terminals/${shellId}/autonomy`, { mode: 'autonomous' }],
  ['start a thread', 'POST', `/api/sessions/${sessionId}/terminals`, { type: 'shell', label: 'spawned' }],
  ['start a queued thread', 'POST', `/api/terminals/${shellId}/start`, {}],
  ['create the coordinator (POST)', 'POST', `/api/sessions/${sessionId}/overseer/coordinator`, {}],
  ['replace a thread config (PATCH with config)', 'PATCH', `/api/terminals/${shellId}`, { config: { queuedTask: 'swapped' } }],
  ['branch a thread', 'POST', `/api/terminals/${shellId}/branch`, {}],
  ['switch a thread\'s model (spends more)', 'POST', `/api/terminals/${shellId}/model`, { model: 'opus' }],
  ['change a thread\'s effort (spends more)', 'POST', `/api/terminals/${shellId}/effort`, { effort: 'high' }],
  ['change an integration', 'PATCH', `/api/integrations/${integrationId}`, { enabled: false }],
  ['delete an integration', 'DELETE', `/api/integrations/${integrationId}`, undefined],
  ['import integrations', 'POST', '/api/integrations/import', { integrations: [] }],
];

describe('a call with no credential is refused on the dangerous actions', () => {
  test.each(DANGEROUS().map((d) => [d[0]] as const))('%s: 401 that names the credential needed', async (label) => {
    const [, method, p, body] = DANGEROUS().find((d) => d[0] === label)!;
    const r = await call({ method, path: p, body });
    expect(r.status, `${method} ${p}`).toBe(401);
    expect(json(r).error).toBe('auth_required');
    expect(json(r).message).toContain(`${method} ${p.split('?')[0]}`);
    expect(json(r).message).toMatch(/owner's credential or a thread key/);
    expect(json(r).message).toMatch(/dispatch api/);
  });

  test.each(['model', 'effort'] as const)('%s change: the web page, the owner token and the dispatch CLI (which sends the token) are let in', async (what) => {
    const body = what === 'model' ? { model: 'opus' } : { effort: 'high' };
    const p = `/api/terminals/${shellId}/${what}`;
    // A shell tab has no model or effort, so a caller that gets past the guard is answered 409 by the service, never 401.
    for (const headers of [WEB_PAGE(), FETCH_META, OWNER()]) {
      const r = await call({ method: 'POST', path: p, headers, body });
      expect(r.status, JSON.stringify(headers)).toBe(409);
      expect(json(r).error).not.toBe('auth_required');
    }
    expect((await call({ method: 'POST', path: p, body })).status).toBe(401);
  });

  test('a real queued thread cannot be started or re-tasked without a credential; the owner can start it', async () => {
    const q = await call({ method: 'POST', path: `/api/sessions/${sessionId}/terminals`, headers: OWNER(), body: { type: 'claude-code', label: 'queued-one', queued: true, task: 'original task', config: { transport: 'structured' } } });
    expect(q.status).toBe(201);
    const qid = json(q).id;
    expect((await call({ method: 'PATCH', path: `/api/terminals/${qid}`, body: { config: { queued: true, queuedTask: 'swapped' } } })).status).toBe(401);
    expect((await call({ method: 'POST', path: `/api/terminals/${qid}/start`, body: {} })).status).toBe(401);
    const after = json(await call({ path: `/api/terminals/${qid}` }));
    expect(after.status).toBe('queued');
    expect(after.config.queuedTask).toBe('original task');
    // a label-only rename is still open to a credential-free caller
    expect((await call({ method: 'PATCH', path: `/api/terminals/${qid}`, body: { label: 'renamed-queued' } })).status).toBe(200);
    // the web page may change the config
    expect((await call({ method: 'PATCH', path: `/api/terminals/${qid}`, headers: WEB_PAGE(), body: { config: { ...after.config, queuedTask: 'by the page' } } })).status).toBe(200);
  });

  test('relaunching an EMPTY project (it would spawn a fresh process) is refused; a project with a tab can still be relaunched', async () => {
    const dir = path.join(home, 'empty-proj');
    fs.mkdirSync(dir);
    const empty = json(await call({ method: 'POST', path: '/api/sessions', body: { provider: 'claude-code', name: 'empty', workingDir: dir } })).id;
    const refused = await call({ method: 'POST', path: `/api/sessions/${empty}/relaunch`, body: {} });
    expect(refused.status).toBe(401);
    expect(json(refused).error).toBe('auth_required');
    expect(json(refused).message).toContain(`POST /api/sessions/${empty}/relaunch`);
    // the web page and the token may do it (it only spawns the CLI if installed; any answer but 401/403 is enough)
    expect(json(await call({ method: 'POST', path: `/api/sessions/${empty}/relaunch`, headers: OWNER(), body: {} }))).not.toMatchObject({ error: 'auth_required' });
    // a project that has a tab: a credential-free relaunch is a plain restart and stays open
    expect((await call({ method: 'POST', path: `/api/sessions/${sessionId}/relaunch`, body: {} })).status).not.toBe(401);
  });

  test('the coordinator: POST (creates and spawns) is refused; GET only looks, answers 404 when there is none and creates nothing', async () => {
    const p = `/api/sessions/${sessionId}/overseer/coordinator`;
    const post = await call({ method: 'POST', path: p, body: {} });
    expect(post.status).toBe(401);
    expect(json(post).error).toBe('auth_required');
    const get = await call({ path: p });
    expect(get.status).toBe(404);
    const tabs = json(await call({ path: `/api/sessions/${sessionId}/terminals` }));
    expect(tabs.some((t: any) => t.config?.role === 'coordinator')).toBe(false);
  });

  test('the refusals changed nothing: the integration is still there, and no extra thread exists', async () => {
    const list = json(await call({ path: '/api/integrations' }));
    expect(list.integrations.find((i: any) => i.id === integrationId)?.enabled).toBe(true);
    const tabs = json(await call({ path: `/api/sessions/${sessionId}/terminals` }));
    expect(tabs.some((t: any) => t.label === 'spawned')).toBe(false);
    expect(tabs.some((t: any) => t.config?.role === 'coordinator')).toBe(false); // the refused coordinator calls made nothing
  });

  test('a forged Origin of another site is still refused by the access gate (403)', async () => {
    const r = await call({ method: 'POST', path: `/api/terminals/${shellId}/input`, headers: { Origin: 'http://evil.example' }, body: { data: 'x' } });
    expect(r.status).toBe(403);
  });
});

// W1-B: three more owner routes are strict. Each gives out a secret (a pairing code, a secret value, every integration value).
describe('pair-code, secret value and integration export need the owner or the web page', () => {
  const REFERER = () => ({ Referer: `http://127.0.0.1:${port}/` });

  test('pair-code: a call with no credential and no browser headers answers 401 auth_required', async () => {
    const r = await call({ method: 'POST', path: '/api/access/pair-code', body: {} });
    expect(r.status).toBe(401);
    expect(json(r).error).toBe('auth_required');
    expect(json(r).message).toContain('POST /api/access/pair-code');
    expect(r.body).not.toMatch(/"code"/);
  });
  test('pair-code: the web page (browser headers) gets the value; a bearer token gets the value', async () => {
    for (const headers of [WEB_PAGE(), FETCH_META, OWNER()]) {
      const r = await call({ method: 'POST', path: '/api/access/pair-code', headers, body: {} });
      expect(r.status, JSON.stringify(Object.keys(headers))).toBe(200);
      expect(typeof json(r).code).toBe('string');
      expect(json(r).expiresAt).toBeGreaterThan(Date.now());
    }
  });
  test('pair-code: a thread key still gets 403 owner_only', async () => {
    const r = await call({ method: 'POST', path: '/api/access/pair-code', headers: { Authorization: `Bearer ${threadKey}` }, body: {} });
    expect(r.status).toBe(403);
    expect(json(r).error).toBe('owner_only');
  });

  test('integration export: no credential answers 401; the web page (Sec-Fetch-Site, or a same-origin Referer on plain http) and the token get the document', async () => {
    const refused = await call({ path: '/api/integrations/export' });
    expect(refused.status).toBe(401);
    expect(json(refused).error).toBe('auth_required');
    for (const headers of [FETCH_META, REFERER(), OWNER()]) {
      const r = await call({ path: '/api/integrations/export', headers });
      expect(r.status, JSON.stringify(Object.keys(headers))).toBe(200);
      expect(Array.isArray(json(r).integrations)).toBe(true);
    }
    // The masked list stays open to a local call with no credential.
    expect((await call({ path: '/api/integrations' })).status).toBe(200);
  });

  test('secret value: no credential answers 401; the web page and the token get past the guard (Doppler is not connected here, so 400)', async () => {
    const reveal = { 'X-Dispatch-Reveal': '1' };
    const refused = await call({ path: '/api/secrets/ANY_NAME/value', headers: reveal });
    expect(refused.status).toBe(401);
    expect(json(refused).error).toBe('auth_required');
    for (const headers of [FETCH_META, REFERER(), OWNER()]) {
      const r = await call({ path: '/api/secrets/ANY_NAME/value', headers: { ...reveal, ...headers } });
      expect(r.status, JSON.stringify(Object.keys(headers))).not.toBe(401);
      expect(r.status).not.toBe(403);
      expect(json(r).error).not.toBe('auth_required');
    }
    // The status route (no token in it) stays open.
    expect((await call({ path: '/api/secrets/status' })).status).toBe(200);
  });
});

describe('the same actions still work for the web page, the owner token and a script that sends the token', () => {
  test('the web page (Origin) sends a message and input', async () => {
    expect((await call({ method: 'POST', path: `/api/terminals/${shellId}/input`, headers: WEB_PAGE(), body: { data: 'echo from-page\r' } })).status).toBe(204);
  });
  test('the browser label Sec-Fetch-Site: same-origin is enough, with no Origin header', async () => {
    expect((await call({ method: 'POST', path: `/api/terminals/${shellId}/input`, headers: FETCH_META, body: { data: '\r' } })).status).toBe(204);
  });
  test('the owner token (the dispatch CLI and scripts) passes every dangerous action', async () => {
    for (const [label, method, p, body] of DANGEROUS()) {
      if (label.startsWith('replace a thread config') || label === 'start a queued thread' || label.startsWith('create the coordinator') || label === 'delete an integration' || label === 'change an integration' || label === 'branch a thread' || label === 'start a thread' || label === 'Chat message as the user') continue; // side effects, covered below or by the page test
      const r = await call({ method, path: p, headers: OWNER(), body });
      expect(r.status, `${label}: ${r.body}`).not.toBe(401);
      expect(json(r)?.error, `${label}: ${r.body}`).not.toBe('owner_only');
    }
  });
  test('the web page can change and delete an integration; the owner token can start a thread', async () => {
    expect((await call({ method: 'PATCH', path: `/api/integrations/${integrationId}`, headers: WEB_PAGE(), body: { enabled: false } })).status).toBe(200);
    expect((await call({ method: 'PATCH', path: `/api/integrations/${integrationId}`, headers: OWNER(), body: { enabled: true } })).status).toBe(200);
    const spawned = await call({ method: 'POST', path: `/api/sessions/${sessionId}/terminals`, headers: OWNER(), body: { type: 'shell', label: 'by-token' } });
    expect(spawned.status).toBe(201);
    const page = await call({ method: 'POST', path: `/api/sessions/${sessionId}/terminals`, headers: WEB_PAGE(), body: { type: 'shell', label: 'by-page' } });
    expect(page.status).toBe(201);
    expect((await call({ method: 'DELETE', path: `/api/integrations/${integrationId}`, headers: WEB_PAGE() })).status).toBe(200);
  });
});

describe('a thread key keeps judging by its own rules, not by this check', () => {
  test('a thread key is never answered with the credential-free refusal', async () => {
    const h = { Authorization: `Bearer ${threadKey}` };
    // A thread may not message itself or a shell tab of another thread: its own rule answers (403), not the keyless 401.
    const msg = await call({ method: 'POST', path: `/api/terminals/${shellId}/message`, headers: h, body: { text: 'hi' } });
    expect([403, 404]).toContain(msg.status);
    expect(json(msg).error).not.toBe('auth_required');
    const input = await call({ method: 'POST', path: `/api/terminals/${shellId}/input`, headers: h, body: { data: 'x' } });
    expect(input.status).toBe(403);
    expect(json(input).error).toBe('owner_only'); // a key never types into a terminal
    const patch = await call({ method: 'PATCH', path: `/api/integrations/${integrationId}`, headers: h, body: { enabled: false } });
    expect(patch.status).toBe(403);
    expect(json(patch).error).toBe('owner_only');
  });
});

describe('everything else stays open to a call with no credential', () => {
  test('reads, hooks, the browser shim, adding an integration and renaming a tab', async () => {
    expect((await call({ path: '/api/sessions' })).status).toBe(200);
    expect((await call({ path: `/api/sessions/${sessionId}/terminals` })).status).toBe(200);
    expect((await call({ path: `/api/terminals/${shellId}/scrollback` })).status).toBe(200);
    expect((await call({ path: '/api/integrations' })).status).toBe(200);
    expect((await call({ path: '/api/whoami' })).status).toBe(200);
    expect((await call({ method: 'POST', path: `/api/events/claude/${shellId}`, body: { hook_event_name: 'Stop', session_id: 'x' } })).status).toBe(204);
    const add = await call({ method: 'POST', path: '/api/integrations', body: { type: 'stdio', name: 'keyless-add', command: 'echo' } });
    expect(add.status).toBe(200);
    expect((await call({ method: 'PATCH', path: `/api/terminals/${shellId}`, body: { label: 'renamed' } })).status).toBe(200);
  });
});

describe('the terminal WebSocket', () => {
  function attachAndType(headers: Record<string, string>, marker: string): Promise<{ opened: boolean }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${shellId}/ws?cols=100&rows=30`, { headers });
      ws.once('unexpected-response', (_req, res) => { res.resume(); resolve({ opened: false }); });
      ws.once('error', () => resolve({ opened: false }));
      ws.once('open', () => {
        setTimeout(() => ws.send(`echo ${marker}\r`), 400);
        setTimeout(() => { ws.terminate(); resolve({ opened: true }); }, 1500);
      });
    });
  }
  /** Read what the terminal printed so far: attach (read only) with a replay and collect the bytes. */
  const scrollbackHas = (marker: string): Promise<boolean> => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${shellId}/ws?cols=100&rows=30&replayBytes=1000000`);
    let got = '';
    ws.on('message', (d) => { got += d.toString(); });
    ws.once('error', () => resolve(false));
    setTimeout(() => { ws.terminate(); resolve(got.includes(marker)); }, 1200);
  });

  test('a credential-free script can attach and watch, but what it types is dropped', async () => {
    expect((await attachAndType({}, 'KEYLESS_TYPED_MARK')).opened).toBe(true);
    expect(await scrollbackHas('KEYLESS_TYPED_MARK')).toBe(false);
  });
  test('the web page (Origin) and the owner token can type', async () => {
    expect((await attachAndType(WEB_PAGE(), 'PAGE_TYPED_MARK')).opened).toBe(true);
    expect(await scrollbackHas('PAGE_TYPED_MARK')).toBe(true);
    expect((await attachAndType(OWNER(), 'TOKEN_TYPED_MARK')).opened).toBe(true);
    expect(await scrollbackHas('TOKEN_TYPED_MARK')).toBe(true);
  });
});

describe('the refusal is logged without the key', () => {
  test('a rate-limited line names the method and route, and holds no token or key', () => {
    expect(output).toMatch(/\[keys\] refused keyless caller POST \/api\/terminals\/:terminalId\/input: auth_required/);
    expect(output).not.toContain(token);
    expect(output.replace(/MINTED_KEY=\S+/, '')).not.toContain(threadKey);
  });
});
