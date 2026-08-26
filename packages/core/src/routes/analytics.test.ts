import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { createAnalyticsRouter } from './analytics.js';

function app(d: Database.Database) {
  const a = express();
  a.use(express.json());
  a.use('/api/analytics', createAnalyticsRouter(d));
  return a;
}

describe('analytics routes', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    usageDb.insertClosed(d, {
      id: 'a', terminalId: 'term1', projectId: 'proj1', provider: 'claude-code',
      model: 'claude-opus-5', role: 'agent',
      startedAt: '2026-08-10T10:00:00.000Z', endedAt: '2026-08-10T10:00:30.000Z', outcome: 'idle',
      input: 100, output: 50, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    });
  });

  it('GET /summary returns totals', async () => {
    const res = await request(app(d)).get('/api/analytics/summary');
    expect(res.status).toBe(200);
    expect(res.body.turns).toBe(1);
    expect(res.body.totalTokens).toBe(150);
  });

  it('GET /series validates metric and groupBy', async () => {
    const ok = await request(app(d)).get('/api/analytics/series?metric=tokens&groupBy=model');
    expect(ok.status).toBe(200);
    expect(ok.body[0].key).toBe('claude-opus-5');

    const bad = await request(app(d)).get('/api/analytics/series?metric=DROP&groupBy=model');
    expect(bad.status).toBe(400);
  });

  it('GET /summary?provider filters to that provider only', async () => {
    usageDb.insertClosed(d, {
      id: 'b', terminalId: 'term2', projectId: 'proj1', provider: 'codex',
      model: 'gpt-5-codex', role: 'agent',
      startedAt: '2026-08-10T11:00:00.000Z', endedAt: '2026-08-10T11:00:20.000Z', outcome: 'idle',
      input: 20, output: 10, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    });
    const all = await request(app(d)).get('/api/analytics/summary');
    expect(all.body.turns).toBe(2);

    const res = await request(app(d)).get('/api/analytics/summary?provider=codex');
    expect(res.status).toBe(200);
    expect(res.body.turns).toBe(1);
    expect(res.body.totalTokens).toBe(30);
  });

  it('GET /series?provider narrows the series to that provider', async () => {
    usageDb.insertClosed(d, {
      id: 'b', terminalId: 'term2', projectId: 'proj1', provider: 'codex',
      model: 'gpt-5-codex', role: 'agent',
      startedAt: '2026-08-10T11:00:00.000Z', endedAt: '2026-08-10T11:00:20.000Z', outcome: 'idle',
      input: 20, output: 10, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    });
    const res = await request(app(d)).get('/api/analytics/series?metric=tokens&groupBy=none&provider=codex');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].value).toBe(30);
  });

  it('GET /records returns all-time facts', async () => {
    const res = await request(app(d)).get('/api/analytics/records');
    expect(res.status).toBe(200);
    expect(res.body.totalTurns).toBe(1);
  });

  it('GET /tracking reports a stable tracking start', async () => {
    const res = await request(app(d)).get('/api/analytics/tracking');
    expect(res.status).toBe(200);
    expect(typeof res.body.trackingStartedAt).toBe('string');
    const again = await request(app(d)).get('/api/analytics/tracking');
    expect(again.body.trackingStartedAt).toBe(res.body.trackingStartedAt);
  });

  /*
   * The history import is gone by decision: analytics records live from the
   * moment tracking started, and nothing else, ever. The routes must be fully
   * removed — a surviving POST would quietly re-grow the feature.
   */
  it('the removed /backfill routes return 404', async () => {
    for (const call of [
      request(app(d)).get('/api/analytics/backfill'),
      request(app(d)).post('/api/analytics/backfill'),
      request(app(d)).delete('/api/analytics/backfill'),
    ]) {
      expect((await call).status).toBe(404);
    }
  });
});
