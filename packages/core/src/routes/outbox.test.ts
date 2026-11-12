import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { DeliveryOutbox } from '../delivery/outbox.js';
import { createOutboxRouter } from './outbox.js';
import { policyHandlerOf, policyKindOf } from '../auth/route-policy.js';

function app() {
  const db = new Database(':memory:');
  initSchema(db);
  const alive = new Set<string>(['a']);
  const outbox = new DeliveryOutbox({ db, deliver: (to) => (alive.has(to) ? 'delivered' : 'not-alive') });
  outbox.enqueue({ targetId: 'a', sourceId: 'w', kind: 'notice', body: 'one', dedupKey: 'k1' });
  outbox.enqueue({ targetId: 'b', sourceId: 'w', kind: 'watch', body: 'two', dedupKey: 'k2' });
  const router = createOutboxRouter(outbox);
  // The policy handler is tested on its own (auth/route-policy); here the handler after it.
  const handlers = (router as any).stack[0].route.stack.map((l: any) => l.handle);
  const e = express();
  e.get('/api/outbox', handlers[handlers.length - 1]);
  return { e, policy: policyKindOf(policyHandlerOf((router as any).stack[0].route)) };
}

describe('GET /api/outbox', () => {
  it('is owner only', () => {
    expect(app().policy).toBe('owner');
  });

  it('lists the rows, newest first', async () => {
    const res = await request(app().e).get('/api/outbox');
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => [r.body, r.state, r.kind])).toEqual([['two', 'pending', 'watch'], ['one', 'delivered', 'notice']]);
  });

  it('filters by thread and by state', async () => {
    const { e } = app();
    expect((await request(e).get('/api/outbox?terminalId=a')).body.map((r: any) => r.body)).toEqual(['one']);
    expect((await request(e).get('/api/outbox?state=pending')).body.map((r: any) => r.body)).toEqual(['two']);
    expect((await request(e).get('/api/outbox?limit=1')).body).toHaveLength(1);
  });

  it('refuses an unknown state', async () => {
    expect((await request(app().e).get('/api/outbox?state=lost')).status).toBe(400);
  });
});
