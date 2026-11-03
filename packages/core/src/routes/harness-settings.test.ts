import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { createHarnessSettingsRouter } from './harness-settings.js';

function app() {
  const db = new Database(':memory:');
  initSchema(db);
  const a = express();
  a.use(express.json());
  a.use('/api/settings/harnesses', createHarnessSettingsRouter(db));
  return a;
}

describe('overseer workers via harness settings routes', () => {
  it('GET payload includes overseerWorkers', async () => {
    const res = await request(app()).get('/api/settings/harnesses');
    expect(res.status).toBe(200);
    expect(res.body.overseerWorkers).toEqual({ byType: {} });
  });

  it('PUT /overseer-workers stores and returns the clean matrix', async () => {
    const a = app();
    const res = await request(a)
      .put('/api/settings/harnesses/overseer-workers')
      .send({ byType: { implementer: { harness: 'codex' } } });
    expect(res.status).toBe(200);
    expect(res.body.byType.implementer).toEqual({ harness: 'codex' });
    const after = await request(a).get('/api/settings/harnesses');
    expect(after.body.overseerWorkers.byType.implementer).toEqual({ harness: 'codex' });
  });
});

describe('GET /opencode/catalog when OpenRouter cannot be reached', () => {
  it('names no server path in the 502 message', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const a = express();
    a.use('/api/settings/harnesses', createHarnessSettingsRouter(db, undefined, undefined, {
      fetchImpl: (async () => { throw Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/.certs/ca.pem'"), { code: 'ENOENT' }); }) as any,
    }));
    const res = await request(a).get('/api/settings/harnesses/opencode/catalog?q=x');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Could not reach the OpenRouter catalog: /);
    expect(res.body.error).not.toContain('/Users/');
  });
});
