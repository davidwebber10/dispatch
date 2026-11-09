import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { createKeyScope } from '../auth/key-scope.js';
import { KeyRegistry } from '../auth/principals.js';
import { GATE_VIA } from '../auth/access-gate.js';
import { configureRefusalLog } from '../auth/route-policy.js';
import { createThreadSecretsRouter } from './thread-secrets.js';

// W1-C: PUT /api/terminals/:id/secrets-env turns the Doppler token on or off for one thread.
const TOKEN = 'owner-access-token-for-the-test-0123456789';
const CONFIG = { transport: 'structured', role: 'agent', model: 'opus', alertsEnabled: true, accountId: 'acct-1', nested: { wakeAt: 5, list: [1, 2] } };

function appWith(via: 'local' | 'test') {
  const db = new Database(':memory:'); initSchema(db);
  sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 't1', sessionId: 'S', type: 'claude-code', label: 't', config: CONFIG });
  const reg = new KeyRegistry();
  const events: unknown[] = [];
  const app = express();
  app.use((req, _res, next) => { if (via !== 'test') (req as any)[GATE_VIA] = via; next(); });
  app.use(createPrincipalMiddleware({ registry: reg, scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
  app.use(express.json());
  app.use('/api', createThreadSecretsRouter(db, { broadcast: (e) => events.push(e) }));
  const config = () => JSON.parse(terminalsDb.getById(db, 't1')!.config as string);
  return { app, db, reg, events, config };
}

describe('PUT /api/terminals/:id/secrets-env', () => {
  beforeEach(() => configureRefusalLog({ log: () => {} }));

  it('changes only secretsEnv and keeps every other config key', async () => {
    const { app, config, events } = appWith('test');
    const on = await request(app).put('/api/terminals/t1/secrets-env').send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ id: 't1', secretsEnv: true, appliesAt: 'next-spawn' });
    expect(on.body.message).toMatch(/next start/i);
    expect(config()).toEqual({ ...CONFIG, secretsEnv: true });
    expect(events).toEqual([{ type: 'session:tabs-changed', sessionId: 'S' }]);

    const off = await request(app).put('/api/terminals/t1/secrets-env').send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.secretsEnv).toBe(false);
    // Off removes the key: the config is exactly what it was before the switch existed.
    expect(config()).toEqual(CONFIG);
  });

  it('reads the config fresh: a key written by another writer just before the call is kept', async () => {
    const { app, db, config } = appWith('test');
    terminalsDb.updateConfig(db, 't1', { ...CONFIG, scheduledWake: '2026-11-10T00:00:00Z' });
    await request(app).put('/api/terminals/t1/secrets-env').send({ enabled: true }).expect(200);
    expect(config()).toEqual({ ...CONFIG, scheduledWake: '2026-11-10T00:00:00Z', secretsEnv: true });
  });

  it('refuses a call with no credential and no browser headers', async () => {
    const { app, config } = appWith('local');
    const res = await request(app).put('/api/terminals/t1/secrets-env').send({ enabled: true });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth_required');
    expect(config()).toEqual(CONFIG);
    // The web page and the owner token pass.
    expect((await request(app).put('/api/terminals/t1/secrets-env').set('Origin', 'http://localhost:3456').send({ enabled: true })).status).toBe(200);
    expect((await request(app).put('/api/terminals/t1/secrets-env').set('Authorization', `Bearer ${TOKEN}`).send({ enabled: false })).status).toBe(200);
  });

  it('refuses a thread key: a thread cannot give itself the token', async () => {
    const { app, reg, config } = appWith('local');
    const key = reg.mint({ kind: 'thread', terminalId: 't1' }).key;
    const res = await request(app).put('/api/terminals/t1/secrets-env').set('Authorization', `Bearer ${key}`).send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
    expect(config()).toEqual(CONFIG);
  });

  it('answers 400 for a body with no boolean and 404 for an unknown thread', async () => {
    const { app, config } = appWith('test');
    expect((await request(app).put('/api/terminals/t1/secrets-env').send({ enabled: 'yes' })).status).toBe(400);
    expect((await request(app).put('/api/terminals/t1/secrets-env').send({})).status).toBe(400);
    expect((await request(app).put('/api/terminals/nope/secrets-env').send({ enabled: true })).status).toBe(404);
    expect(config()).toEqual(CONFIG);
  });
});
