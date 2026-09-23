import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { createSessionsRouter } from '../routes/sessions.js';
import type { SessionService } from './service.js';

function app(stub: Partial<SessionService>) {
  const db = new Database(':memory:');
  initSchema(db);
  const a = express();
  a.use(express.json());
  a.use('/api/sessions', createSessionsRouter(stub as unknown as SessionService, undefined, db));
  return a;
}

describe('POST /overseer/coordinator body pass-through', () => {
  it('forwards model + workerHarness to ensureCoordinator', async () => {
    const ensureCoordinator = vi.fn().mockReturnValue({ id: 't1' });
    const res = await request(app({ ensureCoordinator }))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ model: 'opus', workerHarness: 'codex' });
    expect(res.status).toBe(200);
    expect(ensureCoordinator).toHaveBeenCalledWith('s1', { model: 'opus', workerHarness: 'codex' });
  });

  it('rejects an unknown workerHarness with 400', async () => {
    const ensureCoordinator = vi.fn();
    const res = await request(app({ ensureCoordinator }))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ workerHarness: 'shell' });
    expect(res.status).toBe(400);
    expect(ensureCoordinator).not.toHaveBeenCalled();
  });

  it('empty body behaves as today', async () => {
    const ensureCoordinator = vi.fn().mockReturnValue({ id: 't1' });
    const res = await request(app({ ensureCoordinator })).post('/api/sessions/s1/overseer/coordinator');
    expect(res.status).toBe(200);
    expect(ensureCoordinator).toHaveBeenCalledWith('s1', {});
  });
});

describe('POST /overseer/coordinator coordinatorHarness validation', () => {
  it('forwards a coordinator-capable coordinatorHarness (codex) to ensureCoordinator', async () => {
    const ensureCoordinator = vi.fn().mockReturnValue({ id: 't1' });
    const res = await request(app({ ensureCoordinator }))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ coordinatorHarness: 'codex' });
    expect(res.status).toBe(200);
    expect(ensureCoordinator).toHaveBeenCalledWith('s1', { coordinatorHarness: 'codex' });
  });

  it('rejects a coordinatorHarness whose coordinator capability is false (grok) with 400', async () => {
    const ensureCoordinator = vi.fn();
    const res = await request(app({ ensureCoordinator }))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ coordinatorHarness: 'grok' });
    expect(res.status).toBe(400);
    expect(ensureCoordinator).not.toHaveBeenCalled();
  });

  it('rejects a coordinatorHarness that is not an agent type at all with 400', async () => {
    const ensureCoordinator = vi.fn();
    const res = await request(app({ ensureCoordinator }))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ coordinatorHarness: 'wizard' });
    expect(res.status).toBe(400);
    expect(ensureCoordinator).not.toHaveBeenCalled();
  });

  it('empty body still creates claude-code (no coordinatorHarness forwarded)', async () => {
    const ensureCoordinator = vi.fn().mockReturnValue({ id: 't1' });
    const res = await request(app({ ensureCoordinator })).post('/api/sessions/s1/overseer/coordinator');
    expect(res.status).toBe(200);
    expect(ensureCoordinator).toHaveBeenCalledWith('s1', {});
  });
});
