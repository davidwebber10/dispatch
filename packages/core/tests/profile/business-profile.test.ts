// The business profile, enforced by the daemon (src/profile/business-gate.ts): each refused route
// answers 403 with a plain sentence, the developer profile is unchanged, and reading stays allowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { closeKits, kit, type Kit } from '../daemon/kit.js';
import { BUSINESS_RULES, businessDecision } from '../../src/profile/business-gate.js';
import * as terminalsDb from '../../src/db/terminals.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-profile-')); });
afterEach(() => { closeKits(); fs.rmSync(dir, { recursive: true, force: true }); });

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

  test('a harness with no transport named becomes a structured, supervised chat thread', async () => {
    const k = business();
    const sid = await project(k);
    const r = await request(await k.server()).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', label: 'chat' });
    expect(r.status).toBe(201);
    const cfg = JSON.parse(terminalsDb.getById(k.db, r.body.id)!.config ?? "{}");
    expect(cfg.transport).toBe('structured');
    expect(cfg.autonomy).toBe('supervised');
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
  });
});

describe('GET /api/host-context', () => {
  test('a local build: developer, not hosted', async () => {
    const r = await request(await developer().server()).get('/api/host-context');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ profile: 'developer', hosted: false, osBaseUrl: null, ownerEmail: null });
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

describe('the rule list', () => {
  test('every rule has a unique id and refuses only a write method', () => {
    const ids = BUSINESS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of BUSINESS_RULES) expect(['POST', 'PUT', 'PATCH', 'DELETE']).toContain(r.method);
  });

  test('a GET is never refused', () => {
    const req = { method: 'GET', path: '/api/integrations', body: {} } as never;
    expect(businessDecision(req)).toBeNull();
  });
});
