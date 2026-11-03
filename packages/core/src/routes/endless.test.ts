import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEndlessRouter } from './endless.js';

function app(doc: () => Promise<unknown>) {
  const svc = { available: true, docs: { doc } } as any;
  const a = express();
  a.use('/api/endless', createEndlessRouter(svc));
  return a;
}

describe('GET /api/endless/doc', () => {
  it('answers a doc that is too large with a plain sentence, the project-relative path and the size', async () => {
    const res = await request(app(async () => ({ kind: 'too_large', path: 'docs/plan.md', size: 3_000_000 })))
      .get('/api/endless/doc?project=p&path=plan.md');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'This doc is too large to open here.', path: 'docs/plan.md', size: 3_000_000 });
  });
});
