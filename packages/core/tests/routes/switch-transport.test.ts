// packages/core/tests/routes/switch-transport.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

let app: any; let db: Database.Database; let sessionId: string; let dir: string;

beforeEach(async () => {
  db = new Database(':memory:'); initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-route-'));
  app = createApp({ db, skipPty: true });
  const s = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 't' });
  sessionId = s.body.id;
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('POST /api/terminals/:id/transport', () => {
  it('rejects an invalid transport value with 400', async () => {
    const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code' });
    const r = await request(app).post(`/api/terminals/${t.body.id}/transport`).send({ transport: 'bogus' });
    expect(r.status).toBe(400);
  });

  it('rejects switching a thread with no external_id yet with 409', async () => {
    // A fresh PTY claude thread never captured a session id (no transcript on disk).
    const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code' });
    const r = await request(app).post(`/api/terminals/${t.body.id}/transport`).send({ transport: 'structured' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/session/i);
  });
});
