import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { createPrincipalMiddleware } from './request-principal.js';
import { createKeyScope } from './key-scope.js';
import { KeyRegistry } from './principals.js';
import { GATE_VIA } from './access-gate.js';
import { configureRefusalLog, policyKindOf, policyRouter } from './route-policy.js';
import { ownerOnlyStrictRead, sameOriginReferer } from './owner-read-proof.js';

const TOKEN = 'owner-access-token-for-the-test-0123456789';

function appWith(via: 'local' | 'tailscale') {
  const db = new Database(':memory:'); initSchema(db);
  const reg = new KeyRegistry();
  const app = express();
  app.use((req, _res, next) => { (req as any)[GATE_VIA] = via; next(); });
  app.use(createPrincipalMiddleware({ registry: reg, scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
  const r = policyRouter();
  r.get('/value', ownerOnlyStrictRead, (_q, s) => s.json({ value: 'sekret' }));
  app.use('/api', r);
  return { app, reg, db };
}

describe('sameOriginReferer', () => {
  it('is true only when the Referer names the same host and port as the Host header', () => {
    expect(sameOriginReferer({ host: 'mac.tail1.ts.net:3456', referer: 'http://mac.tail1.ts.net:3456/settings' })).toBe(true);
    expect(sameOriginReferer({ host: 'MAC.tail1.ts.net:3456', referer: 'http://mac.tail1.ts.net:3456/' })).toBe(true);
    expect(sameOriginReferer({ host: 'localhost:3456', referer: 'http://localhost:3456/' })).toBe(true);
    expect(sameOriginReferer({ host: 'localhost:3456', referer: 'http://evil.example/' })).toBe(false);
    expect(sameOriginReferer({ host: 'localhost:3456', referer: 'http://localhost:9999/' })).toBe(false);
    expect(sameOriginReferer({ host: 'localhost:3456', referer: 'http://localhost.evil.example:3456/' })).toBe(false);
    expect(sameOriginReferer({ host: 'localhost:3456', referer: 'not a url' })).toBe(false);
    expect(sameOriginReferer({ host: 'localhost:3456' })).toBe(false);
    expect(sameOriginReferer({ referer: 'http://localhost:3456/' })).toBe(false);
  });
});

describe('ownerOnlyStrictRead (a strict owner route that is a GET)', () => {
  beforeEach(() => configureRefusalLog({ log: () => {} }));

  it('carries the owner policy tag', () => {
    expect(policyKindOf(ownerOnlyStrictRead)).toBe('owner');
  });

  for (const via of ['local', 'tailscale'] as const) {
    it(`via ${via}: a call with no credential and no browser headers answers 401 auth_required`, async () => {
      const res = await request(appWith(via).app).get('/api/value');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('auth_required');
      expect(res.text).not.toContain('sekret');
    });

    it(`via ${via}: the web page passes by Sec-Fetch-Site, by Origin, or (a plain http page) by a same-origin Referer; the owner token passes`, async () => {
      const { app } = appWith(via);
      expect((await request(app).get('/api/value').set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
      expect((await request(app).get('/api/value').set('Origin', 'http://localhost:3456')).status).toBe(200);
      expect((await request(app).get('/api/value').set('Host', 'mac.tail1.ts.net:3456').set('Referer', 'http://mac.tail1.ts.net:3456/')).status).toBe(200);
      expect((await request(app).get('/api/value').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(200);
    });

    it(`via ${via}: a Referer of another site does not pass`, async () => {
      const res = await request(appWith(via).app).get('/api/value').set('Host', 'localhost:3456').set('Referer', 'http://evil.example/page');
      expect(res.status).toBe(401);
    });
  }

  it('a thread key gets 403 owner_only, with or without a same-origin Referer', async () => {
    const { app, reg, db } = appWith('local');
    sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't', sessionId: 'S', type: 'claude-code', label: 't', config: { transport: 'structured', role: 'agent' } });
    const key = reg.mint({ kind: 'thread', terminalId: 't' }).key;
    for (const referer of [undefined, 'http://localhost:3456/']) {
      let r = request(app).get('/api/value').set('Host', 'localhost:3456').set('Authorization', `Bearer ${key}`);
      if (referer) r = r.set('Referer', referer);
      const res = await r;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('owner_only');
    }
  });
});
