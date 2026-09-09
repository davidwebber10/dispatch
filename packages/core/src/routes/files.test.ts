import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import { createFilesRouter } from './files.js';

const TMP_UPLOAD_DIR = '/tmp/commandcenter-uploads';

function makeApp(workingDir: string) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir });
  const app = express();
  app.use('/api/sessions/:id/files', createFilesRouter(db));
  return app;
}

describe('upload tmp dir resilience', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-files-test-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // macOS deletes idle /tmp entries after ~3 days, so the multer temp dir created
  // once at daemon startup can vanish mid-uptime. Every upload then fails with
  // ENOENT until the daemon restarts. The routes must recreate it per request.
  it('inbox upload succeeds after the tmp dir was deleted', async () => {
    // Build the router FIRST: the daemon constructs it once at startup, and the
    // tmp dir disappears later, mid-uptime.
    const app = makeApp(workDir);
    fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
    const res = await request(app)
      .post('/api/sessions/s1/files/inbox')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(workDir, res.body.path), 'utf8')).toBe('hello');
  });

  it('files upload succeeds after the tmp dir was deleted', async () => {
    const app = makeApp(workDir);
    fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
    const res = await request(app)
      .post('/api/sessions/s1/files/upload')
      .attach('file', Buffer.from('world'), { filename: 'up.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(workDir, 'up.txt'), 'utf8')).toBe('world');
  });
});
