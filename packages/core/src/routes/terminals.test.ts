import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalsRouter } from './terminals.js';
import type { SessionService } from '../sessions/service.js';

function app(getResumeAdvice: () => unknown) {
  const a = express();
  a.use(express.json());
  a.use('/api', createTerminalsRouter({ getResumeAdvice } as unknown as SessionService));
  return a;
}

describe('GET /api/terminals/:id/resume-advice', () => {
  it('returns the service payload', async () => {
    const advice = { shouldPrompt: true, ageMinutes: 180, contextTokens: 124_000 };
    const res = await request(app(() => advice)).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(advice);
  });

  it('answers a benign "no" when there is nothing to advise on', async () => {
    const res = await request(app(() => null)).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  });

  it('surfaces a service throw as 400', async () => {
    const res = await request(app(() => { throw new Error('boom'); })).get('/api/terminals/t1/resume-advice');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('boom');
  });
});
