import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalsRouter } from './terminals.js';
import type { SessionService } from '../sessions/service.js';

function app(stub: Partial<SessionService>) {
  const a = express();
  a.use(express.json());
  a.use('/api', createTerminalsRouter(stub as unknown as SessionService));
  return a;
}

describe('GET /api/terminals/:id/resume-advice', () => {
  it('returns the service payload', async () => {
    const advice = { shouldPrompt: true, ageMinutes: 180, contextTokens: 124_000 };
    const res = await request(app({ getResumeAdvice: () => advice })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(advice);
  });

  it('answers a benign "no" when there is nothing to advise on', async () => {
    const res = await request(app({ getResumeAdvice: () => null })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  });

  it('surfaces a service throw as 400', async () => {
    const res = await request(app({ getResumeAdvice: () => { throw new Error('boom'); } })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('boom');
  });
});

describe('POST /api/terminals/:id/report-status', () => {
  it('forwards a valid declaration to the service', async () => {
    const reportStatus = vi.fn().mockReturnValue(true);
    const res = await request(app({ reportStatus }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'needs_you', summary: 'blocked on a decision', ask: 'Which provider?' });
    expect(res.status).toBe(204);
    expect(reportStatus).toHaveBeenCalledWith('t1', { state: 'needs_you', summary: 'blocked on a decision', ask: 'Which provider?' });
  });

  it('rejects an unknown state', async () => {
    const res = await request(app({ reportStatus: vi.fn() }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'vibes', summary: 'x' });
    expect(res.status).toBe(400);
  });

  it('answers 409 when no live structured session backs the thread', async () => {
    const res = await request(app({ reportStatus: vi.fn().mockReturnValue(false) }))
      .post('/api/terminals/t1/report-status')
      .send({ state: 'done', summary: 'shipped' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/terminals/:id/board', () => {
  it('acknowledges a thread', async () => {
    const setBoardState = vi.fn().mockReturnValue(true);
    const res = await request(app({ setBoardState })).post('/api/terminals/t1/board').send({ acknowledged: true });
    expect(res.status).toBe(204);
    expect(setBoardState).toHaveBeenCalledWith('t1', { acknowledged: true });
  });

  it('sets a manual override', async () => {
    const setBoardState = vi.fn().mockReturnValue(true);
    const res = await request(app({ setBoardState })).post('/api/terminals/t1/board').send({ override: 'complete' });
    expect(res.status).toBe(204);
    expect(setBoardState).toHaveBeenCalledWith('t1', { override: 'complete' });
  });

  it('rejects an override of "working" — that is an observed fact, not a judgement', async () => {
    const res = await request(app({ setBoardState: vi.fn() })).post('/api/terminals/t1/board').send({ override: 'working' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown terminal', async () => {
    const res = await request(app({ setBoardState: vi.fn().mockReturnValue(false) })).post('/api/terminals/t1/board').send({ acknowledged: true });
    expect(res.status).toBe(404);
  });
});
