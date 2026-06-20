import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('terminal routes', () => {
  let app: any;
  let db: Database.Database;
  let sessionId: string;
  let tmpDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcenter-terminal-test-'));
    fs.writeFileSync(path.join(tmpDir, 'context.txt'), 'use me');

    // Create a session (no auto-terminal now)
    const res = await request(app)
      .post('/api/sessions')
      .send({ provider: 'claude-code', workingDir: tmpDir, name: 'test' });
    sessionId = res.body.id;
  });

  it('GET /api/sessions/:id/terminals lists terminals (empty initially)', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/terminals`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('GET /api/sessions/:id/terminals excludes agent runner terminals (config.runner)', async () => {
    terminalsDb.create(db, { id: 'normal-1', sessionId, type: 'claude-code', label: 'thread', skipPermissions: false });
    terminalsDb.create(db, { id: 'runner-1', sessionId, type: 'claude-code', label: 'agent run', skipPermissions: true, config: { runner: true, runnerPrompt: 'go' } });

    const list = await request(app).get(`/api/sessions/${sessionId}/terminals`);
    expect(list.status).toBe(200);
    const ids = list.body.map((t: any) => t.id);
    expect(ids).toContain('normal-1');
    expect(ids).not.toContain('runner-1');
  });

  it('POST /api/sessions/:id/terminals creates a shell terminal', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', label: 'My Shell', workingDir: '/tmp' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('shell');
    expect(res.body.label).toBe('My Shell');
    expect(res.body.sessionId).toBe(sessionId);

    const list = await request(app).get(`/api/sessions/${sessionId}/terminals`);
    expect(list.body).toHaveLength(1);
  });

  it('POST /api/sessions/:id/terminals rejects invalid type', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('POST /api/terminals/:terminalId/stop stops a terminal', async () => {
    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: '/tmp' });
    const terminalId = create.body.id;

    const res = await request(app).post(`/api/terminals/${terminalId}/stop`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/terminals/:terminalId removes a terminal', async () => {
    const c1 = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: '/tmp' });
    const c2 = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: '/tmp' });

    const res = await request(app).delete(`/api/terminals/${c1.body.id}`);
    expect(res.status).toBe(204);

    const list = await request(app).get(`/api/sessions/${sessionId}/terminals`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(c2.body.id);
  });

  it('POST /api/terminals/:terminalId/send-file-reference sends context for an alive terminal', async () => {
    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: tmpDir });

    const res = await request(app)
      .post(`/api/terminals/${create.body.id}/send-file-reference`)
      .send({ path: 'context.txt', mode: 'agent-context' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      sentText: `Use this file as context: ${path.join(tmpDir, 'context.txt')}\r`,
    });
  });

  it('POST /api/terminals/:terminalId/send-file-reference resolves inbox paths from the session root', async () => {
    const terminalDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(terminalDir);
    const inboxDir = path.join(tmpDir, '.dispatch', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'foo.txt'), 'uploaded');

    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: terminalDir });

    const res = await request(app)
      .post(`/api/terminals/${create.body.id}/send-file-reference`)
      .send({ path: '.dispatch/inbox/foo.txt', mode: 'agent-context' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      sentText: `Use this file as context: ${path.join(tmpDir, '.dispatch', 'inbox', 'foo.txt')}\r`,
    });
  });

  it('POST /api/terminals/:terminalId/send-file-reference shell-escapes paths and appends a trailing space', async () => {
    const filename = "weird file 'quote' $(touch nope);.txt";
    const absolutePath = path.join(tmpDir, filename);
    fs.writeFileSync(absolutePath, 'shell path');
    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: tmpDir });

    const res = await request(app)
      .post(`/api/terminals/${create.body.id}/send-file-reference`)
      .send({ path: filename, mode: 'shell-path' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      sentText: `'${absolutePath.replace(/'/g, `'\\''`)}' `,
    });
    expect(res.body.sentText.endsWith(' ')).toBe(true);
  });

  it('POST /api/terminals/:terminalId/send-file-reference returns 404 for missing terminals', async () => {
    const res = await request(app)
      .post('/api/terminals/missing-terminal/send-file-reference')
      .send({ path: 'context.txt', mode: 'agent-context' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Terminal not found');
  });

  it('POST /api/terminals/:terminalId/send-file-reference returns 409 for stopped terminals', async () => {
    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: tmpDir });
    await request(app).post(`/api/terminals/${create.body.id}/stop`);

    const res = await request(app)
      .post(`/api/terminals/${create.body.id}/send-file-reference`)
      .send({ path: 'context.txt', mode: 'agent-context' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Terminal process is not running');
  });

  it('POST /api/terminals/:terminalId/send-file-reference returns 409 for non-PTY tabs', async () => {
    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'notes', label: 'Notes' });

    const res = await request(app)
      .post(`/api/terminals/${create.body.id}/send-file-reference`)
      .send({ path: 'context.txt', mode: 'agent-context' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Terminal process is not running');
  });

  it('POST /api/terminals/:terminalId/send-file-reference rejects path traversal', async () => {
    const create = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', workingDir: tmpDir });

    const res = await request(app)
      .post(`/api/terminals/${create.body.id}/send-file-reference`)
      .send({ path: '../../etc/passwd', mode: 'agent-context' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Path traversal not allowed');
  });
});
