import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { updateOverseerWorkers } from '../settings/overseer-workers.js';
import { SessionService } from '../sessions/service.js';
import { createSessionsRouter } from './sessions.js';

// archive()/etc. only touch ptyManager.isAlive/kill; nothing is alive in a test DB.
const fakePty = { isAlive: () => false, kill: () => {} } as any;

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  const sessionService = new SessionService(db, fakePty);
  const a = express();
  a.use(express.json());
  a.use('/api/sessions', createSessionsRouter(sessionService, undefined, db));
  return { db, app: a };
}

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
});
