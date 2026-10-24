import { beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { KeyRegistry } from './principals.js';
import { nullKeyScope, type CallerFacts, type KeyScope } from './key-scope.js';
import { createPrincipalMiddleware } from './request-principal.js';
import {
  POLICY_TAG, configureRefusalLog, keyRoute, ownerOnly, policyKindOf, policyRouter, publicRoute, type Rule,
} from './route-policy.js';

const facts = (over: Partial<CallerFacts> = {}): CallerFacts => ({
  id: 't1', sessionId: 's1', type: 'claude-code', role: 'agent', depth: 1, spawnedBy: null,
  origin: null, roleRun: false, archived: false, overseer: false, ...over,
});

let lines: string[];
let clock: number;
let registry: KeyRegistry;

function build(scope: KeyScope, peerAddress?: string) {
  registry = new KeyRegistry();
  const app = express();
  if (peerAddress) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: peerAddress, configurable: true });
      next();
    });
  }
  app.use(createPrincipalMiddleware({ registry, scope, via: 'test' }));
  app.use(express.json());
  return app;
}

const allow: Rule = () => ({ ok: true });
const deny: Rule = () => ({ ok: false, status: 403, error: 'out_of_scope', message: 'No.' });

beforeEach(() => {
  lines = [];
  clock = 1_000_000;
  configureRefusalLog({ log: (l) => lines.push(l), now: () => clock });
});

describe('policyRouter default deny', () => {
  test('a plain route refuses a thread key and serves owner-less (none) callers', async () => {
    const app = build({ ...nullKeyScope, caller: () => facts() });
    const r = policyRouter();
    r.get('/plain', (_req, res) => res.json({ ok: true }));
    app.use('/api', r);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });

    const refused = await request(app).get('/api/plain').set('Authorization', `Bearer ${key}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('owner_only');
    expect(refused.body.message).toContain('owner only');

    expect((await request(app).get('/api/plain')).status).toBe(200);
  });

  test('every verb is wrapped, and use() middleware is not touched', async () => {
    const app = build({ ...nullKeyScope, caller: () => facts() });
    const r = policyRouter();
    let used = 0;
    r.use((_req, _res, next) => { used++; next(); });
    r.post('/p', (_req, res) => res.json({}));
    r.put('/p', (_req, res) => res.json({}));
    r.patch('/p', (_req, res) => res.json({}));
    r.delete('/p', (_req, res) => res.json({}));
    r.all('/a', (_req, res) => res.json({}));
    app.use('/api', r);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const auth = { Authorization: `Bearer ${key}` };
    for (const call of [
      request(app).post('/api/p').set(auth), request(app).put('/api/p').set(auth),
      request(app).patch('/api/p').set(auth), request(app).delete('/api/p').set(auth),
      request(app).get('/api/a').set(auth),
    ]) expect((await call).status).toBe(403);
    expect(used).toBe(5);
  });

  test('a route that starts with a tagged handler is not wrapped twice', () => {
    const r = policyRouter();
    r.get('/x', publicRoute, (_req, res) => res.end());
    const layer = (r as unknown as { stack: { route?: { stack: { handle: unknown }[] } }[] }).stack[0];
    expect(layer.route!.stack).toHaveLength(2);
    expect(policyKindOf(layer.route!.stack[0].handle)).toBe('public');
  });

  test('the tags are set', () => {
    expect(policyKindOf(ownerOnly)).toBe('owner');
    expect(policyKindOf(publicRoute)).toBe('public');
    expect(policyKindOf(keyRoute({ thread: allow }))).toBe('key');
    expect(policyKindOf(() => {})).toBeUndefined();
    expect(typeof POLICY_TAG).toBe('symbol');
  });
});

describe('keyRoute', () => {
  function mount(rules: Parameters<typeof keyRoute>[0], scope: KeyScope) {
    const app = build(scope);
    const r = policyRouter();
    r.get('/k', keyRoute(rules), (_req, res) => res.json({ served: true }));
    app.use('/api', r);
    return app;
  }

  test('a thread rule runs and serves the key; owner and none pass untouched', async () => {
    let ran = 0;
    const app = mount({ thread: () => { ran++; return { ok: true }; } }, { ...nullKeyScope, caller: () => facts() });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const ok = await request(app).get('/api/k').set('Authorization', `Bearer ${key}`);
    expect(ok.status).toBe(200);
    expect(ran).toBe(1);
    expect((await request(app).get('/api/k')).status).toBe(200);
    expect(ran).toBe(1);
  });

  test('a failed rule refuses with its code', async () => {
    const app = mount({ thread: deny }, { ...nullKeyScope, caller: () => facts() });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    const res = await request(app).get('/api/k').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'out_of_scope', message: 'No.' });
  });

  test('a role run uses roleRun only, with no fallback to thread', async () => {
    const scope: KeyScope = { ...nullKeyScope, caller: () => facts({ roleRun: true }) };
    const onlyThread = mount({ thread: allow }, scope);
    const k1 = registry.mint({ kind: 'thread', terminalId: 't1' }).key;
    const res = await request(onlyThread).get('/api/k').set('Authorization', `Bearer ${k1}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');

    const both = mount({ thread: deny, roleRun: allow }, scope);
    const k2 = registry.mint({ kind: 'thread', terminalId: 't1' }).key;
    expect((await request(both).get('/api/k').set('Authorization', `Bearer ${k2}`)).status).toBe(200);
  });

  test('Chat keys: summarizer rule for a summarizer, chat rule otherwise, owner_only when missing', async () => {
    const app = mount({ chat: allow, summarizer: deny }, nullKeyScope);
    const chat = registry.mint({ kind: 'chat', startedBy: 'user' }).key;
    const summ = registry.mint({ kind: 'chat', startedBy: 'summarizer' }).key;
    expect((await request(app).get('/api/k').set('Authorization', `Bearer ${chat}`)).status).toBe(200);
    expect((await request(app).get('/api/k').set('Authorization', `Bearer ${summ}`)).body.error).toBe('out_of_scope');

    const none = mount({ thread: allow }, nullKeyScope);
    const c2 = registry.mint({ kind: 'chat', startedBy: 'user' }).key;
    expect((await request(none).get('/api/k').set('Authorization', `Bearer ${c2}`)).body.error).toBe('owner_only');
  });

  test('a missing or archived caller row gives 401 auth_required', async () => {
    const missing = mount({ thread: allow }, nullKeyScope);
    const k1 = registry.mint({ kind: 'thread', terminalId: 't1' }).key;
    const r1 = await request(missing).get('/api/k').set('Authorization', `Bearer ${k1}`);
    expect(r1.status).toBe(401);
    expect(r1.body.error).toBe('auth_required');

    const archived = mount({ thread: allow }, { ...nullKeyScope, caller: () => facts({ archived: true }) });
    const k2 = registry.mint({ kind: 'thread', terminalId: 't1' }).key;
    expect((await request(archived).get('/api/k').set('Authorization', `Bearer ${k2}`)).status).toBe(401);
  });

  test('a shell key uses the shell rule', async () => {
    const app = mount({ shell: allow }, { ...nullKeyScope, caller: () => facts({ type: 'shell' }) });
    const { key } = registry.mint({ kind: 'shell', terminalId: 't1' });
    expect((await request(app).get('/api/k').set('Authorization', `Bearer ${key}`)).status).toBe(200);
  });

  test('the rule receives the caller facts and the principal', async () => {
    let seen: unknown;
    const app = mount({ thread: (_req, ctx) => { seen = [ctx.principal.kind, ctx.caller?.id]; return { ok: true }; } },
      { ...nullKeyScope, caller: () => facts({ id: 't9' }) });
    const { key } = registry.mint({ kind: 'thread', terminalId: 't9' });
    await request(app).get('/api/k').set('Authorization', `Bearer ${key}`);
    expect(seen).toEqual(['thread', 't9']);
  });
});

describe('refusal log', () => {
  test('one rate-limited line, with a count after the window, and never the key', async () => {
    const app = build({ ...nullKeyScope, caller: () => facts() });
    const r = policyRouter();
    r.get('/plain', (_req, res) => res.end());
    app.use('/api', r);
    const { key } = registry.mint({ kind: 'thread', terminalId: 't1' });
    for (let i = 0; i < 20; i++) await request(app).get('/api/plain').set('Authorization', `Bearer ${key}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('thread t1');
    expect(lines[0]).toContain('GET /api/plain');
    expect(lines[0]).toContain('owner_only');
    expect(lines.join('\n')).not.toContain(key);
    clock += 61_000;
    await request(app).get('/api/plain').set('Authorization', `Bearer ${key}`);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('(20 more)');
  });
});

describe('peer address normalisation', () => {
  test('a mapped IPv4 loopback peer is treated as loopback', async () => {
    const { isLoopbackAddress } = await import('../files/reveal.js');
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:192.168.1.9')).toBe(false);
  });
});
