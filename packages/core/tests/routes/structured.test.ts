// packages/core/tests/routes/structured.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
let app: any; let db: Database.Database; let sessionId: string; let dir: string;
beforeEach(async () => {
  db = new Database(':memory:'); initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-'));
  // structuredCommand override makes the app spawn the fake instead of real claude (see Task 6 wiring)
  app = createApp({ db, skipPty: true, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 't' });
  sessionId = s.body.id;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('creates a structured thread and accepts a message', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  expect(t.status).toBe(201);
  const msg = await request(app).post(`/api/terminals/${t.body.id}/message`).send({ text: 'hello' });
  expect(msg.status).toBe(204);
});

it('rejects a message with no text', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const res = await request(app).post(`/api/terminals/${t.body.id}/message`).send({});
  expect(res.status).toBe(400);
});

it('a coordinator spawn folds the dispatch agency server into its --mcp-config', async () => {
  // secretsDir controls where the SessionService writes mcp configs, so we can read
  // the per-coordinator config file the structured spawn writes before launch.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cfg-'));
  const coordApp = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(coordApp).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'c' });
  const coordSession = s.body.id;

  const t = await request(coordApp)
    .post(`/api/sessions/${coordSession}/terminals`)
    .send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } });
  expect(t.status).toBe(201);

  const cfgPath = path.join(cfgDir, `coordinator-${t.body.id}.mcp.json`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  expect(cfg.mcpServers.dispatch.command).toBe('node');
  expect(cfg.mcpServers.dispatch.args[0]).toMatch(/agency-mcp\.js$/);
  expect(cfg.mcpServers.dispatch.env.DISPATCH_SESSION).toBe(coordSession);
  expect(cfg.mcpServers.dispatch.env.DISPATCH_PORT).toBe(String(process.env.PORT || 3456));

  await request(coordApp).post(`/api/terminals/${t.body.id}/stop`); // clean up the fake child
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('a non-coordinator structured spawn writes no coordinator config', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noncoord-cfg-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'n' });
  const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  expect(t.status).toBe(201);
  expect(fs.existsSync(path.join(cfgDir, `coordinator-${t.body.id}.mcp.json`))).toBe(false);
  await request(a).post(`/api/terminals/${t.body.id}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});
