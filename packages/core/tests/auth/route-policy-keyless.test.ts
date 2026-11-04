import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { createPrincipalMiddleware } from '../../src/auth/request-principal.js';
import { createKeyScope } from '../../src/auth/key-scope.js';
import { KeyRegistry } from '../../src/auth/principals.js';
import { GATE_VIA } from '../../src/auth/access-gate.js';
import { configureRefusalLog, keyRoute, looksLikeBrowser, ownerOnlyStrict, policyRouter, requireOwnerProof } from '../../src/auth/route-policy.js';
import { allowRule } from '../../src/auth/key-rules.js';

const TOKEN = 'owner-access-token-for-the-test-0123456789';

function appWith(via: 'local' | 'tailscale' | 'test' | null) {
  const db = new Database(':memory:'); initSchema(db);
  const reg = new KeyRegistry();
  const app = express();
  // What the access gate does: it tags the request before the principal middleware runs.
  app.use((req, _res, next) => { if (via && via !== 'test') (req as any)[GATE_VIA] = via; next(); });
  app.use(createPrincipalMiddleware({ registry: reg, scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
  app.use(express.json());
  const r = policyRouter();
  r.post('/strict', ownerOnlyStrict, (_q, s) => s.json({ ok: true }));
  r.post('/keyed', keyRoute({ thread: allowRule }), requireOwnerProof, (_q, s) => s.json({ ok: true }));
  r.get('/plain', (_q, s) => s.json({ ok: true }));
  app.use('/api', r);
  return { app, reg, db };
}

describe('SEC-05 middle: credential-free callers', () => {
  beforeEach(() => configureRefusalLog({ log: () => {} }));

  it('looksLikeBrowser: an Origin header or Sec-Fetch-Site same-origin counts; nothing, cross-site and an empty Origin do not', () => {
    expect(looksLikeBrowser({ origin: 'http://localhost:3456' })).toBe(true);
    expect(looksLikeBrowser({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(looksLikeBrowser({})).toBe(false);
    expect(looksLikeBrowser({ origin: '  ' })).toBe(false);
    expect(looksLikeBrowser({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(looksLikeBrowser({ 'sec-fetch-site': 'none' })).toBe(false);
  });

  for (const via of ['local', 'tailscale'] as const) {
    it(`via ${via}: refused with 401 auth_required, naming the method, the route and the credential`, async () => {
      const { app } = appWith(via);
      for (const path of ['/api/strict', '/api/keyed']) {
        const res = await request(app).post(path).send({});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('auth_required');
        expect(res.body.message).toContain(`POST ${path}`);
        expect(res.body.message).toMatch(/owner's credential or a thread key/);
        expect(res.body.message).toMatch(/only this action/);
      }
    });
    it(`via ${via}: the web page, and the owner token, pass; reads stay open`, async () => {
      const { app } = appWith(via);
      expect((await request(app).post('/api/strict').set('Origin', 'http://localhost:3456').send({})).status).toBe(200);
      expect((await request(app).post('/api/keyed').set('Sec-Fetch-Site', 'same-origin').send({})).status).toBe(200);
      expect((await request(app).post('/api/strict').set('Authorization', `Bearer ${TOKEN}`).send({})).status).toBe(200);
      expect((await request(app).get('/api/plain')).status).toBe(200);
    });
  }

  it('a unit-test app (no gate tag, via test) passes, like the web page', async () => {
    const { app } = appWith('test');
    expect((await request(app).post('/api/strict').send({})).status).toBe(200);
  });

  it('a key is judged by its own rule, not by this check: keyRoute allow passes, ownerOnlyStrict gives owner_only', async () => {
    const { app, reg, db } = appWith('local');
    sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't', sessionId: 'S', type: 'claude-code', label: 't', config: { transport: 'structured', role: 'agent' } });
    const key = reg.mint({ kind: 'thread', terminalId: 't' }).key;
    expect((await request(app).post('/api/keyed').set('Authorization', `Bearer ${key}`).send({})).status).toBe(200);
    const strict = await request(app).post('/api/strict').set('Authorization', `Bearer ${key}`).send({});
    expect(strict.status).toBe(403);
    expect(strict.body.error).toBe('owner_only');
  });

  it('the refusal log line names the route and never a token', async () => {
    const lines: string[] = [];
    configureRefusalLog({ log: (l) => lines.push(l) });
    const { app } = appWith('local');
    await request(app).post('/api/strict').send({});
    expect(lines.some((l) => /refused keyless caller POST \/api\/strict: auth_required/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
