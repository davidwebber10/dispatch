import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('GET /api/sessions/:id/codex-recent', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });

  it('404s for an unknown session', async () => {
    const res = await request(app).get('/api/sessions/nope/codex-recent');
    expect(res.status).toBe(404);
  });

  it('returns an array for a real session', async () => {
    const created = await request(app).post('/api/sessions').send({ provider: 'codex', name: 'cx', workingDir: '/tmp/does-not-exist-xyz' });
    const res = await request(app).get(`/api/sessions/${created.body.id}/codex-recent`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
