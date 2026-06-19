import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('static serving + SPA fallback', () => {
  let app: any;
  let dist: string;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
    process.env.DISPATCH_WEB_DIST = dist;
    app = createApp({ db, skipPty: true });
  });
  afterEach(() => { delete process.env.DISPATCH_WEB_DIST; });

  it('serves index.html at the root', () =>
    request(app).get('/').expect(200).then((r) => expect(r.text).toContain('<title>app</title>')));

  it('falls back to index.html for client routes', () =>
    request(app).get('/projects/s1').expect(200).then((r) => expect(r.text).toContain('app')));

  it('does NOT shadow /api routes', () =>
    request(app).get('/api/sessions').expect(200).then((r) => expect(Array.isArray(r.body)).toBe(true)));
});
