// An error response is a status and a message. It never carries a stack trace or a server path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { jsonErrorHandler } from '../../src/http/error-handler.js';

const LEAKS = /node_modules|\bat \S+ \(|\.ts:\d+|\/Users\/|\/var\/folders|\/tmp\//;

describe('server error responses', () => {
  let dir: string;
  let app: any;
  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-handler-'));
    app = createApp({ db, skipPty: true });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a JSON body over the cap is a clean 413: JSON, status and message only', async () => {
    const res = await request(app).post('/api/sessions/none/files/mkdir?path=a').send({ content: 'x'.repeat(1.5 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body).sort()).toEqual(['error']);
    expect(typeof res.body.error).toBe('string');
    expect(res.text).not.toMatch(LEAKS);
    expect(res.text).not.toContain('PayloadTooLargeError');
  });

  it('a body that is not valid JSON is a clean 400', async () => {
    const res = await request(app).post('/api/sessions/none/files/mkdir?path=a').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.text).not.toMatch(LEAKS);
  });
});

describe('jsonErrorHandler', () => {
  const build = (thrown: unknown) => {
    const a = express();
    a.get('/boom', () => { throw thrown; });
    a.use(jsonErrorHandler);
    return a;
  };

  it('an unexpected error is a generic 500 with no message, stack or path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(build(new Error("ENOENT: no such file or directory, open '/Users/someone/secret/file'"))).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(res.text).not.toMatch(/Users|ENOENT|\bat /);
      expect(log).toHaveBeenCalled(); // the detail goes to the daemon log, not the client
    } finally { log.mockRestore(); }
  });

  it('a client error that the library marks as safe keeps its status and message', async () => {
    const err = Object.assign(new Error('request entity too large'), { status: 413, expose: true, stack: 'Error: x\n    at /Users/someone/app.ts:1:1' });
    const res = await request(build(err)).get('/boom');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'request entity too large' });
    expect(res.text).not.toContain('/Users/');
  });

  it('a client error that is not marked safe gets a generic message for its status', async () => {
    const err = Object.assign(new Error("bad path '/Users/someone/x'"), { status: 400 });
    const res = await request(build(err)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
  });
});
