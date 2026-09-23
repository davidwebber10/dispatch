import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { updateOverseerWorkers } from '../settings/overseer-workers.js';
import { SessionService } from '../sessions/service.js';
import { createSessionsRouter } from './sessions.js';
import { detectProvider } from '../setup/detect.js';

// Detection hits the real filesystem/PATH otherwise — stub it for deterministic shapes,
// same seam routes/setup.test.ts stubs (`../setup/detect.js`). Defaults to "installed and
// signed in" so existing tests keep asserting on harness/model resolution, not CLI presence.
vi.mock('../setup/detect.js', () => ({ detectProvider: vi.fn() }));

// archive()/etc. only touch ptyManager.isAlive/kill; nothing is alive in a test DB.
const fakePty = { isAlive: () => false, kill: () => {} } as any;

beforeEach(() => {
  (detectProvider as unknown as Mock).mockReset().mockResolvedValue({ installed: true, signedIn: true });
});

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  const sessionService = new SessionService(db, fakePty);
  const a = express();
  a.use(express.json());
  a.use('/api/sessions', createSessionsRouter(sessionService, undefined, db));
  return { db, app: a };
}

describe('worker-defaults under a Codex coordinator (M3 block, review N5)', () => {
  it('reports a codex worker unavailable — it could not share the Codex coordinator\'s app-server', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 'm1', provider: 'codex', name: 'm3', workingDir: '/tmp/m3' });
    terminalsDb.create(db, { id: 'c1', sessionId: 'm1', type: 'codex', label: 'Overseer', config: { transport: 'structured', role: 'coordinator' } });

    const res = await request(app).get('/api/sessions/m1/overseer/worker-defaults?agentType=implementer&harness=codex');

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/M3/);
  });

  it('keeps a non-codex worker available under a Codex coordinator', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 'm2', provider: 'codex', name: 'm3b', workingDir: '/tmp/m3b' });
    terminalsDb.create(db, { id: 'c2', sessionId: 'm2', type: 'codex', label: 'Overseer', config: { transport: 'structured', role: 'coordinator' } });

    const res = await request(app).get('/api/sessions/m2/overseer/worker-defaults?agentType=implementer&harness=claude-code');

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });
});

describe('GET /api/sessions/:id/overseer/worker-defaults', () => {
  it('resolves from the matrix when an entry exists for the agent type', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj1', workingDir: '/tmp/proj1' });
    updateOverseerWorkers(db, { byType: { implementer: { harness: 'codex' } } });

    const res = await request(app).get('/api/sessions/s1/overseer/worker-defaults?agentType=implementer');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('codex');
    expect(typeof res.body.available).toBe('boolean');
  });

  it('falls back to the live coordinator\'s config.workerHarness when no matrix entry exists', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'proj2', workingDir: '/tmp/proj2' });
    terminalsDb.create(db, {
      id: 't2', sessionId: 's2', type: 'claude-code', label: 'Overseer',
      config: { transport: 'structured', role: 'coordinator', workerHarness: 'grok' },
    });

    const res = await request(app).get('/api/sessions/s2/overseer/worker-defaults?agentType=implementer');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('grok');
  });

  it('defaults to claude-code and available:true with no matrix and no coordinator', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's3', provider: 'claude-code', name: 'proj3', workingDir: '/tmp/proj3' });

    const res = await request(app).get('/api/sessions/s3/overseer/worker-defaults?agentType=implementer');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ harness: 'claude-code', available: true });
  });

  it('400s for an agentType outside PersonaType', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's4', provider: 'claude-code', name: 'proj4', workingDir: '/tmp/proj4' });

    const res = await request(app).get('/api/sessions/s4/overseer/worker-defaults?agentType=wizard');

    expect(res.status).toBe(400);
  });

  it('available:false with a reason naming the harness when its CLI is not installed', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's5', provider: 'claude-code', name: 'proj5', workingDir: '/tmp/proj5' });
    updateOverseerWorkers(db, { byType: { implementer: { harness: 'codex' } } });
    (detectProvider as unknown as Mock).mockResolvedValue({ installed: false, signedIn: false });

    const res = await request(app).get('/api/sessions/s5/overseer/worker-defaults?agentType=implementer');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('codex');
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/codex/);
    // The detection check runs against the CLI backing the RESOLVED harness (codex -> codex).
    expect(detectProvider).toHaveBeenCalledWith('codex');
  });

  it('available:false with a "not signed in" reason when the CLI is installed but signed out', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's9', provider: 'claude-code', name: 'proj9', workingDir: '/tmp/proj9' });
    updateOverseerWorkers(db, { byType: { implementer: { harness: 'codex' } } });
    (detectProvider as unknown as Mock).mockResolvedValue({ installed: true, signedIn: false });

    const res = await request(app).get('/api/sessions/s9/overseer/worker-defaults?agentType=implementer');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('codex');
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe('codex CLI is not signed in on this server');
  });

  it('available:true when signedIn is "unknown" (an inconclusive probe never blocks)', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's10', provider: 'claude-code', name: 'proj10', workingDir: '/tmp/proj10' });
    updateOverseerWorkers(db, { byType: { implementer: { harness: 'codex' } } });
    (detectProvider as unknown as Mock).mockResolvedValue({ installed: true, signedIn: 'unknown' });

    const res = await request(app).get('/api/sessions/s10/overseer/worker-defaults?agentType=implementer');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('codex');
    expect(res.body.available).toBe(true);
    expect(res.body.reason).toBeUndefined();
  });

  it('an explicit ?harness= query param is treated as the explicit pick, overriding the matrix', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's6', provider: 'claude-code', name: 'proj6', workingDir: '/tmp/proj6' });
    updateOverseerWorkers(db, { byType: { implementer: { harness: 'codex' } } });

    const res = await request(app).get('/api/sessions/s6/overseer/worker-defaults?agentType=implementer&harness=grok');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('grok');
  });

  it('400s for an invalid ?harness= value', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's7', provider: 'claude-code', name: 'proj7', workingDir: '/tmp/proj7' });

    const res = await request(app).get('/api/sessions/s7/overseer/worker-defaults?agentType=implementer&harness=wizard');

    expect(res.status).toBe(400);
  });

  it('an explicit ?harness= whose CLI is missing reports available:false too', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's8', provider: 'claude-code', name: 'proj8', workingDir: '/tmp/proj8' });
    (detectProvider as unknown as Mock).mockImplementation(async (name: string) =>
      name === 'grok' ? { installed: false, signedIn: false } : { installed: true, signedIn: true },
    );

    const res = await request(app).get('/api/sessions/s8/overseer/worker-defaults?agentType=implementer&harness=grok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ harness: 'grok', available: false, reason: expect.stringContaining('grok') });
  });

  it('available:true for opencode even when signedIn is false — the daemon injects OPENROUTER_API_KEY itself', async () => {
    const { db, app } = setup();
    sessionsDb.create(db, { id: 's11', provider: 'claude-code', name: 'proj11', workingDir: '/tmp/proj11' });
    (detectProvider as unknown as Mock).mockResolvedValue({ installed: true, signedIn: false });

    const res = await request(app).get('/api/sessions/s11/overseer/worker-defaults?agentType=implementer&harness=opencode');

    expect(res.status).toBe(200);
    expect(res.body.harness).toBe('opencode');
    expect(res.body.available).toBe(true);
    expect(res.body.reason).toBeUndefined();
  });
});
