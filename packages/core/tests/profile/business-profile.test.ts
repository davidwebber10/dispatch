// The business profile, enforced by the daemon (src/profile/business-gate.ts): each refused route
// answers 403 with a plain sentence, the developer profile is unchanged, and reading stays allowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { closeKits, kit, type Kit } from '../daemon/kit.js';
import { BUSINESS_ROUTES } from '../../src/profile/business-routes.js';
import * as terminalsDb from '../../src/db/terminals.js';

// A business person's projects live in ~/projects (the test home: tests/harness/isolated-home.ts).
let dir: string;
beforeEach(() => {
  const root = path.join(os.homedir(), 'projects');
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, 'biz-profile-'));
});
afterEach(() => { closeKits(); fs.rmSync(dir, { recursive: true, force: true }); });

// A hosted kit keeps the token login (DISPATCH_CLAUDE_LOGIN=token): the clean login probes `claude auth status`
// in the background, which would outlive the test's database.
const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ['DISPATCH_PROFILE', 'OS_BASE_URL', 'OS_BOX_TOKEN', 'DISPATCH_BOX_TOKEN', 'OS_PUBLIC_URL', 'DISPATCH_OWNER_EMAIL']) delete env[k];
  return { ...env, ...extra };
};
const business = () => kit({ env: envWith({ DISPATCH_PROFILE: 'business' }) });
const developer = () => kit({ env: envWith({}) });

async function project(k: Kit): Promise<string> {
  const r = await request(await k.server()).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'p' });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

function expectRefused(r: request.Response, rule: string) {
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('not_available_in_profile');
  expect(r.body.rule).toBe(rule);
  // A plain sentence for the page, with no machine words.
  expect(typeof r.body.error).toBe('string');
  expect(r.body.error).not.toMatch(/pty|daemon|container|box\b|profile/i);
}

describe('business profile: threads', () => {
  test('a shell thread is refused (the CLI sign-in shell too)', async () => {
    const k = business();
    const sid = await project(k);
    const s = await k.server();
    expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'shell' }), 'thread.create');
    expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'shell', config: { signIn: 'codex' } }), 'thread.create');
  });

  test('a browser thread is refused; a notes tab is allowed', async () => {
    const k = business();
    const sid = await project(k);
    const s = await k.server();
    expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'browser' }), 'thread.create');
    expect((await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'notes', label: 'n' })).status).toBe(201);
  });

  test('a harness asked for as a CLI is refused', async () => {
    const k = business();
    const sid = await project(k);
    const r = await request(await k.server()).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', config: { transport: 'pty' } });
    expectRefused(r, 'thread.create');
  });

  test('OpenCode is refused, as a chat thread too (a project file could replace its approval rules); Claude Code and Codex are not', async () => {
    const k = business();
    const sid = await project(k);
    const s = await k.server();
    expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'opencode' }), 'thread.create');
    expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'opencode', config: { transport: 'structured' } }), 'thread.create');
    expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'grok' }), 'thread.create');
    expect((await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', label: 'chat' })).status).toBe(201);
    expect((await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'codex', label: 'chat' })).body.code).toBeUndefined();
  });

  test('a harness with no transport named becomes a structured chat thread with smart approvals', async () => {
    const k = business();
    const sid = await project(k);
    const r = await request(await k.server()).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', label: 'chat' });
    expect(r.status).toBe(201);
    const cfg = JSON.parse(terminalsDb.getById(k.db, r.body.id)!.config ?? "{}");
    expect(cfg.transport).toBe('structured');
    expect(cfg.approvals).toBe('smart');
    expect(cfg.autonomy).toBeUndefined();
  });

  test('a business thread stays on smart approvals', async () => {
    const k = business();
    const s = await k.server();
    expectRefused(await request(s).post('/api/terminals/t1/approvals').send({ mode: 'auto' }), 'thread.approvals');
    expectRefused(await request(s).post('/api/terminals/t1/approvals').send({ mode: 'ask' }), 'thread.approvals');
    const ok = await request(s).post('/api/terminals/t1/approvals').send({ mode: 'smart' });
    expect(ok.body.code).toBeUndefined();
  });

  test('a switch to the CLI is refused; a switch to chat reaches the route', async () => {
    const k = business();
    const s = await k.server();
    expectRefused(await request(s).post('/api/terminals/t1/transport').send({ transport: 'pty' }), 'thread.transport.cli');
    expectRefused(await request(s).post('/api/terminals/t1/transport').send({}), 'thread.transport.cli');
    const ok = await request(s).post('/api/terminals/t1/transport').send({ transport: 'structured' });
    expect(ok.body.code).toBeUndefined();
  });

  test('raw input into a terminal is refused', async () => {
    const k = business();
    expectRefused(await request(await k.server()).post('/api/terminals/t1/input').send({ data: 'ls\n' }), 'thread.pty-input');
  });

  test('the terminal WebSocket is refused', async () => {
    const k = business();
    const port = await k.port();
    const opened = await new Promise<boolean | number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/t1/ws?cols=80&rows=24`);
      ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
      ws.once('open', () => { ws.close(); resolve(true); });
      ws.once('error', () => resolve(false));
    });
    expect(opened).toBe(403);
  });
});

describe('business profile: machine features', () => {
  test('worktree creation is refused; the list is still read', async () => {
    const k = business();
    const sid = await project(k);
    const s = await k.server();
    expectRefused(await request(s).post(`/api/sessions/${sid}/worktrees`).send({}), 'worktree.create');
    expect((await request(s).get(`/api/sessions/${sid}/worktrees`)).body.code).toBeUndefined();
  });

  test.each([
    ['POST', '/api/plugins/install', 'plugin.install'],
    ['POST', '/api/plugins/scaffold', 'plugin.scaffold'],
    ['POST', '/api/plugins/abc/enable', 'plugin.enable'],
    ['POST', '/api/plugins/abc/import', 'plugin.import'],
    ['POST', '/api/plugins/abc/copy', 'plugin.copy'],
    ['POST', '/api/plugins/abc/update', 'plugin.update'],
    ['POST', '/api/plugins/abc/rollback', 'plugin.update'],
    ['POST', '/api/plugins/marketplaces', 'plugin.marketplace.add'],
    ['POST', '/api/skills', 'skill.install'],
    ['POST', '/api/skills/install', 'skill.install'],
    ['POST', '/api/integrations', 'integration.create'],
    ['POST', '/api/integrations/import', 'integration.import'],
    ['PATCH', '/api/integrations/abc', 'integration.update'],
    ['DELETE', '/api/integrations/abc', 'integration.delete'],
  ])('%s %s is refused', async (method, url, rule) => {
    const k = business();
    const s = await k.server();
    const r = await (request(s) as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()](url).send({});
    expectRefused(r, rule);
  });

  test('reading stays allowed', async () => {
    const k = business();
    const s = await k.server();
    for (const url of ['/api/sessions', '/api/plugins', '/api/integrations', '/api/skills']) {
      const r = await request(s).get(url);
      expect(r.status, url).not.toBe(403);
    }
  });

  test('disabling a plugin is not refused (it removes power)', async () => {
    const k = business();
    const r = await request(await k.server()).post('/api/plugins/abc/disable').send({});
    expect(r.body.code).toBeUndefined();
  });
});

describe('business profile: automations and agents (runs with approvals skipped)', () => {
  test('every route that creates, changes, enables or runs one is refused with 403', async () => {
    const k = business();
    const sid = await project(k);
    const s = await k.server();
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['post', '/api/agents/schedules', { projectId: sid, name: 'n', provider: 'claude-code', prompt: 'p' }, 'automation.create'],
      ['patch', '/api/agents/schedules/a1', { enabled: true }, 'automation.update'],
      ['post', '/api/agents/schedules/a1/run-now', {}, 'automation.run'],
      ['post', '/api/roles/reviewer/enable', {}, 'role.enable'],
      ['post', `/api/sessions/${sid}/overseer/coordinator`, {}, 'coordinator.create'],
      ['post', '/api/terminals/t1/start', {}, 'thread.start-queued'],
      ['post', '/api/terminals/t1/autonomy', { mode: 'autonomous' }, 'thread.autonomy'],
      ['patch', '/api/terminals/t1', { config: { transport: 'structured', role: 'agent' } }, 'thread.config'],
      ['patch', '/api/terminals/t1', { config: { transport: 'structured', approvals: 'auto' } }, 'thread.config'],
    ];
    for (const [method, url, body, rule] of cases) {
      const r = await (request(s) as unknown as Record<string, (u: string) => request.Test>)[method](url).send(body);
      expectRefused(r, rule);
    }
    // A thread created as an agent, a runner, a role or a queued agent: refused.
    for (const body of [
      { type: 'claude-code', config: { role: 'agent' } },
      { type: 'claude-code', config: { runner: true, runnerPrompt: 'go' } },
      { type: 'codex', config: { agentType: 'implementer' } },
      { type: 'claude-code', config: { roleAuthority: 'reviewer' } },
      { type: 'claude-code', config: { autonomy: 'autonomous' } },
      { type: 'claude-code', config: { approvals: 'auto' } },
      { type: 'claude-code', queued: true, task: 'x' },
    ]) expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send(body), 'thread.create');
  });

  test('listing, cancelling and deleting stay allowed; a supervised dial and a label rename pass', async () => {
    const k = business();
    const s = await k.server();
    for (const url of ['/api/agents/schedules', '/api/agents/runs', '/api/roles']) expect((await request(s).get(url)).status, url).not.toBe(403);
    expect((await request(s).delete('/api/agents/schedules/a1')).body.code).toBeUndefined();
    expect((await request(s).post('/api/agents/runs/r1/cancel').send({})).body.code).toBeUndefined();
    expect((await request(s).post('/api/terminals/t1/autonomy').send({ mode: 'supervised' })).body.code).toBeUndefined();
    expect((await request(s).patch('/api/terminals/t1').send({ label: 'x', config: { transport: 'structured', approvals: 'smart' } })).body.code).toBeUndefined();
  });

  test('developer: the same routes are not refused by the gate', async () => {
    const k = developer();
    const s = await k.server();
    for (const [method, url] of [['post', '/api/agents/schedules'], ['post', '/api/agents/schedules/a1/run-now'], ['post', '/api/roles/x/enable'], ['post', '/api/terminals/t1/autonomy']] as const) {
      const r = await request(s)[method](url).send({ mode: 'autonomous' });
      expect(r.body.code, url).toBeUndefined();
    }
  });
});

describe('developer profile', () => {
  test('nothing is refused by the profile gate', async () => {
    const k = developer();
    const sid = await project(k);
    const s = await k.server();
    const shell = await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'notes', label: 'x' });
    expect(shell.status).toBe(201);
    for (const [method, url] of [['post', `/api/sessions/${sid}/terminals`], ['post', '/api/terminals/t1/transport'], ['post', '/api/integrations'], ['post', '/api/plugins/install']] as const) {
      const r = await request(s)[method](url).send({ type: 'browser', transport: 'pty' });
      expect(r.body.code, url).toBeUndefined();
    }
  });

  test('a claude thread with no transport keeps the old default (no transport set)', async () => {
    const k = developer();
    const sid = await project(k);
    const r = await request(await k.server()).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', label: 'cli' });
    expect(r.status).toBe(201);
    const cfg = JSON.parse(terminalsDb.getById(k.db, r.body.id)!.config ?? "{}");
    expect(cfg.transport).toBeUndefined();
    expect(cfg.autonomy).toBeUndefined();
    expect(cfg.approvals).toBeUndefined();
  });
});

describe('GET /api/host-context', () => {
  test('a local build: developer, not hosted', async () => {
    const r = await request(await developer().server()).get('/api/host-context');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ profile: 'developer', hosted: false, osBaseUrl: null, ownerEmail: null, capabilities: ['base-path', 'os-tools-proxy', 'profile', 'headless-v1', 'idle-info', 'gate-v2', 'inbox-v1', 'live-tools-v1', 'subagents-v1', 'codex-signout-v1'] });
  });

  test('a business build reports its profile', async () => {
    const r = await request(await business().server()).get('/api/host-context');
    expect(r.body.profile).toBe('business');
  });

  test('the web page carries the context in a meta only when it is not the default', async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-web-'));
    const html = '<!doctype html><html><head><base href="/" /><title>Dispatch</title></head><body></body></html>';
    fs.writeFileSync(path.join(web, 'index.html'), html);
    try {
      const dev = kit({ env: envWith({}), webDist: web });
      const devPage = await request(await dev.server()).get('/').set('Accept', 'text/html');
      expect(devPage.text).toBe(html.replace('<base href="/" />', '<base href="/">')); // the base rewrite is old; nothing else changes
      const biz = kit({ env: envWith({ DISPATCH_PROFILE: 'business' }), webDist: web });
      const bizPage = await request(await biz.server()).get('/').set('Accept', 'text/html');
      expect(bizPage.text).toContain('name="dispatch-host-context"');
      expect(bizPage.text).toContain('&quot;profile&quot;:&quot;business&quot;');
    } finally {
      fs.rmSync(web, { recursive: true, force: true });
    }
  });
});

describe('the table', () => {
  test('every row has a rule name, and a refusal has a plain sentence', () => {
    for (const [id, row] of Object.entries(BUSINESS_ROUTES)) {
      expect(row.rule, id).toMatch(/^[a-z][a-z0-9.-]*$/);
      if (row.business === 'refuse') expect(row.message ?? '', id).not.toMatch(/pty|daemon|container|box\b|profile/i);
    }
  });

  test('a read that the page needs is not refused; a read of a secret or of the machine is', async () => {
    const k = business();
    const s = await k.server();
    expect((await request(s).get('/api/integrations')).status).not.toBe(403);
    expectRefused(await request(s).get('/api/integrations/export'), 'integration.export');
    expectRefused(await request(s).get('/api/secrets/NAME/value'), 'secrets');
    expectRefused(await request(s).get('/api/state/browse?path=/'), 'files.browse');
    expectRefused(await request(s).get('/api/terminals/t1/scrollback'), 'thread.pty-output');
  });
});

describe('one live profile: OS wins, without a restart', () => {
  async function stubOs(): Promise<{ url: string; set: (p: string | null, status?: number) => void; close: () => void }> {
    const http = await import('node:http');
    let profile: string | null = 'business';
    let status = 200;
    const srv = http.createServer((req, res) => {
      if (status !== 200) { res.writeHead(status); return void res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servers: [], env: {}, needsConsent: [], entitled: [], osTools: null, ...(profile ? { profile } : {}) }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, set: (p, s = 200) => { profile = p; status = s; }, close: () => { srv.close(); srv.closeAllConnections(); } };
  }

  test('OS business over env developer; a flip to developer applies; an outage keeps the last value', async () => {
    const os = await stubOs();
    try {
      const k = kit({ env: envWith({ OS_BASE_URL: os.url, OS_BOX_TOKEN: 'x', DISPATCH_PROFILE: 'developer', DISPATCH_CLAUDE_LOGIN: 'token' }) });
      const sid = await project(k);
      const s = await k.server();
      // Before OS answers: the env value.
      expect((await request(s).get('/api/host-context')).body.profile).toBe('developer');
      await k.daemon.services.osConnections.refresh();
      const ctx = (await request(s).get('/api/host-context')).body;
      expect(ctx.profile).toBe('business');
      expect(ctx.capabilities).toEqual(['base-path', 'os-tools-proxy', 'profile', 'headless-v1', 'idle-info', 'gate-v2', 'inbox-v1', 'live-tools-v1', 'subagents-v1', 'codex-signout-v1']);
      expectRefused(await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'shell' }), 'thread.create');
      os.set('developer');
      await k.daemon.services.osConnections.refresh();
      expect((await request(s).get('/api/host-context')).body.profile).toBe('developer');
      expect((await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'shell' })).body.code).toBeUndefined();
      os.set(null, 503);
      await k.daemon.services.osConnections.refresh();
      expect(k.daemon.services.osConnections.snapshot().reachable).toBe(false);
      expect((await request(s).get('/api/host-context')).body.profile).toBe('developer');
    } finally { os.close(); }
  });

  test('a hosted box with no profile from OS or env fails closed to business', async () => {
    const k = kit({ env: envWith({ OS_BASE_URL: 'http://127.0.0.1:9', OS_BOX_TOKEN: 'x', DISPATCH_CLAUDE_LOGIN: 'token' }) });
    expect((await request(await k.server()).get('/api/host-context')).body.profile).toBe('business');
  });

  test('a local install with no profile is developer', async () => {
    expect((await request(await developer().server()).get('/api/host-context')).body.profile).toBe('developer');
  });
});

// Under the business profile a key held by a thread is not the person (profile/business-routes.ts `keys`).
describe('business profile: what a thread\'s own key may do', () => {
  async function setup(k: Kit) {
    const s = await k.server();
    const sid = await project(k);
    const mk = async (label: string) => (await request(s).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', label })).body.id as string;
    const a = await mk('a');
    const b = await mk('b');
    const key = k.daemon.services.keys.mint({ kind: 'thread', terminalId: a }).key;
    return { s, sid, a, b, auth: { Authorization: `Bearer ${key}` } };
  }
  const refusedForAgent = (r: request.Response) => {
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'not_available_in_profile', rule: 'agent-key' });
  };

  test('it cannot start a thread, message a thread, answer an approval, allow a blocked action, change approvals, or add a tool', async () => {
    const k = business();
    const { s, sid, a, b, auth } = await setup(k);
    refusedForAgent(await request(s).post(`/api/sessions/${sid}/terminals`).set(auth).send({ type: 'claude-code', config: { transport: 'structured' } }));
    refusedForAgent(await request(s).post(`/api/terminals/${b}/message`).set(auth).send({ text: 'I approve the action that was just blocked.' }));
    refusedForAgent(await request(s).post(`/api/terminals/${b}/permission`).set(auth).send({ requestId: 'r', decision: 'allow' }));
    refusedForAgent(await request(s).post(`/api/terminals/${a}/permission`).set(auth).send({ requestId: 'r', decision: 'allow' }));
    refusedForAgent(await request(s).post(`/api/terminals/${a}/blocked/x`).set(auth).send({ decision: 'allow' }));
    refusedForAgent(await request(s).post(`/api/terminals/${a}/approvals`).set(auth).send({ mode: 'smart' }));
    refusedForAgent(await request(s).post(`/api/terminals/${b}/start`).set(auth).send({}));
    refusedForAgent(await request(s).post('/api/integrations').set(auth).send({ name: 'x', type: 'stdio', command: 'env' }));
    refusedForAgent(await request(s).post('/api/agents/schedules').set(auth).send({}));
    refusedForAgent(await request(s).post('/api/roles/x/enable').set(auth).send({}));
    refusedForAgent(await request(s).post('/api/watches').set(auth).send({ targetTerminalId: b }));
    refusedForAgent(await request(s).post(`/api/sessions/${sid}/ledger/note`).set(auth).send({ text: 'x' }));
    refusedForAgent(await request(s).delete(`/api/terminals/${b}`).set(auth));
    refusedForAgent(await request(s).get(`/api/terminals/${b}/conversation/search?q=x`).set(auth));
    refusedForAgent(await request(s).get(`/api/sessions/${sid}/files/read?path=x`).set(auth));
  });

  test('it keeps what an agent needs: who it is, its own status and events, its project list, its inbox', async () => {
    const k = business();
    const { s, sid, a, auth } = await setup(k);
    expect((await request(s).get('/api/whoami').set(auth)).body).toMatchObject({ kind: 'thread', terminalId: a });
    for (const [method, url] of [
      ['get', '/api/sessions'], ['get', `/api/sessions/${sid}/terminals`], ['get', `/api/terminals/${a}`], ['get', '/api/plugins'], ['get', '/api/skills'],
      ['post', `/api/terminals/${a}/report-status`], ['post', `/api/events/claude/${a}`], ['get', '/api/plugins/previews/data'],
    ] as const) {
      const r = await request(s)[method](url).set(auth).send(method === 'post' ? {} : undefined);
      expect(r.body?.code, `${method} ${url}`).not.toBe('not_available_in_profile');
    }
  });

  // Owner requirement 2026-11-12: threads read each other. read_thread of the `dispatch` server reads
  // another thread's conversation with the thread's own key; messaging that thread stays refused.
  test('it reads another thread of the owner (read_thread), and still cannot message it', async () => {
    const k = business();
    const { s, b, auth } = await setup(k);
    const r = await request(s).get(`/api/terminals/${b}/conversation?limit=20`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('items');
    refusedForAgent(await request(s).post(`/api/terminals/${b}/message`).set(auth).send({ text: 'hi', source: 'coordinator' }));
  });

  test('developer: the same key keeps every rule it had', async () => {
    const k = developer();
    const { s, sid, b, auth } = await setup(k);
    for (const r of [
      await request(s).post(`/api/sessions/${sid}/terminals`).set(auth).send({ type: 'claude-code', config: { transport: 'structured' } }),
      await request(s).post(`/api/terminals/${b}/message`).set(auth).send({ text: 'hello' }),
      await request(s).post('/api/watches').set(auth).send({ targetTerminalId: b }),
    ]) expect(r.body?.code).toBeUndefined();
  });
});

describe('business profile: what runs', () => {
  test('a thread that is not a chat thread cannot be driven: no message, no restart, no restore; stopping and archiving still work', async () => {
    const k = business();
    const s = await k.server();
    const sid = await project(k);
    const { v4: uuid } = await import('uuid');
    const add = (type: string, config: Record<string, unknown>) => { const id = uuid(); terminalsDb.create(k.db, { id, sessionId: sid, type, label: 't', config }); return id; };
    for (const id of [add('shell', {}), add('claude-code', { transport: 'pty' }), add('claude-code', { transport: 'structured', role: 'agent' }), add('claude-code', { transport: 'structured', approvals: 'auto' }), add('codex', { transport: 'structured', runner: true, runnerPrompt: 'go' }), add('opencode', { transport: 'structured', approvals: 'smart' })]) {
      for (const [method, url, body] of [
        ['post', `/api/terminals/${id}/message`, { text: 'ls', source: 'user' }],
        ['post', `/api/terminals/${id}/relaunch`, {}],
        ['post', `/api/terminals/${id}/restore`, {}],
        ['post', `/api/terminals/${id}/continue`, {}],
        ['post', `/api/terminals/${id}/permission`, { requestId: 'r', decision: 'allow' }],
        ['post', `/api/terminals/${id}/blocked/x`, { decision: 'allow' }],
        ['post', `/api/terminals/${id}/model`, { model: 'x' }],
        ['post', `/api/terminals/${id}/send-file-reference`, { path: 'a' }],
      ] as const) {
        expectRefused(await request(s)[method](url).send(body), 'thread.not-chat');
      }
      expect((await request(s).post(`/api/terminals/${id}/stop`).send({})).body.code).toBeUndefined();
      expect((await request(s).post(`/api/terminals/${id}/interrupt`).send({})).body.code).toBeUndefined();
      expect((await request(s).delete(`/api/terminals/${id}`)).status).toBe(204);
    }
  });

  test('a project folder outside ~/projects is refused; a name alone, or a folder inside it, is accepted', async () => {
    const k = business();
    const s = await k.server();
    for (const workingDir of ['/', '~', '~/.dispatch', os.tmpdir(), '~/projects', '~/projects/../.ssh', '/proc']) {
      expectRefused(await request(s).post('/api/sessions').send({ name: 'x', workingDir }), 'project.folder');
    }
    expect((await request(s).post('/api/sessions').send({ name: 'ok', workingDir: path.join(dir, 'sub') })).status).toBe(201);
    // A link out of the projects folder is followed before the check.
    const link = path.join(os.homedir(), 'projects', `out-${Date.now()}`);
    fs.symlinkSync(os.tmpdir(), link);
    try { expectRefused(await request(s).post('/api/sessions').send({ name: 'x', workingDir: path.join(link, 'p') }), 'project.folder'); }
    finally { fs.unlinkSync(link); }
  });

  test('Chat is off: its turns would run a harness with every tool allowed', async () => {
    const k = kit({ env: envWith({ DISPATCH_PROFILE: 'business' }), endless: { available: true } as never });
    const s = await k.server();
    expectRefused(await request(s).post('/api/endless/send').send({ text: 'hi' }), 'chat');
    expectRefused(await request(s).put('/api/endless/instructions').send({ text: 'x' }), 'chat');
  });
});

describe('a hosted box: who is the owner', () => {
  const hosted = (profile: 'business' | 'developer') => kit({
    auth: 'gate',
    env: envWith({ OS_BASE_URL: 'http://127.0.0.1:9', OS_BOX_TOKEN: 'outbound-secret', DISPATCH_BOX_TOKEN: 'inbound-secret', DISPATCH_PROFILE: profile, DISPATCH_CLAUDE_LOGIN: 'token' }),
  });
  const ownerToken = (k: Kit) => fs.readFileSync(path.join(k.dir, 'access-token'), 'utf8').trim();

  test('business: only the box token admits the owner; the access-token file on the disk admits nobody', async () => {
    const k = hosted('business');
    const s = await k.server();
    expect((await request(s).get('/api/host-context')).status).toBe(401);
    expect((await request(s).get('/api/host-context').set('x-dispatch-box-token', 'inbound-secret')).status).toBe(200);
    // The outbound token is never accepted inbound.
    expect((await request(s).get('/api/host-context').set('x-dispatch-box-token', 'outbound-secret')).status).toBe(401);
    // Make sure the file exists (a local tool may have made it), then try it.
    await request(s).get('/api/host-context').set('Authorization', 'Bearer nothing');
    const token = fs.existsSync(path.join(k.dir, 'access-token')) ? ownerToken(k) : null;
    if (token) expect((await request(s).get('/api/host-context').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect(token).not.toBeNull();
  });

  test('with no token every path gives the same answer, and no answer names the framework', async () => {
    const k = hosted('business');
    const s = await k.server();
    const answers = new Set<string>();
    for (const [method, url] of [
      ['get', '/'], ['get', '/some/page'], ['get', '/api/whoami'], ['get', '/api/host-context'], ['get', '/api/sessions'], ['get', '/api/no-such-route'],
      ['get', '/assets/index.js'], ['get', '/plugins/previews/web.js'], ['get', '/icons/icon-192.png'], ['post', '/api/access/login'], ['post', '/api/sessions/x/terminals'],
    ] as const) {
      const r = await request(s)[method](url);
      expect(r.status, url).toBe(401);
      expect(r.headers['x-powered-by'], url).toBeUndefined();
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
      answers.add(r.text);
    }
    expect([...answers]).toEqual(['{"error":"unauthorized"}']);
    // A path that is not canonical is refused for its form alone, with or without a token: it says nothing else.
    const bad = await request(s).get('/api//whoami');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'bad_path', message: 'The request path is not in canonical form.' });
  });

  test('developer: the access token still works, as before', async () => {
    const k = hosted('developer');
    const s = await k.server();
    await request(s).get('/api/host-context').set('Authorization', 'Bearer nothing');
    expect((await request(s).get('/api/host-context').set('Authorization', `Bearer ${ownerToken(k)}`)).status).toBe(200);
    expect((await request(s).get('/api/host-context').set('x-dispatch-box-token', 'inbound-secret')).status).toBe(200);
  });
});
