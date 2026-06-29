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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pollPermission(a: any, id: string, timeoutMs = 3000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await request(a).get(`/api/terminals/${id}/permission`);
    if (r.body) return r.body;
    await sleep(25);
  }
  throw new Error('timeout waiting for pending permission');
}
async function pollEvent(a: any, id: string, pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
  const mgr = (a as any)._structuredManager;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ev = mgr.getEvents(id).find(pred);
    if (ev) return ev;
    await sleep(25);
  }
  throw new Error('timeout waiting for event');
}

it('an AGENT thread escalates a gated tool: GET shows pending, POST allow resolves it', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent' } });
  expect(t.status).toBe(201);
  const id = t.body.id;
  expect((await request(app).get(`/api/terminals/${id}/permission`)).body).toBeNull(); // nothing yet
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  const pending = await pollPermission(app, id);
  expect(pending).toMatchObject({ toolName: 'Write', requestId: 'req-1' });
  const ans = await request(app).post(`/api/terminals/${id}/permission`).send({ decision: 'allow' });
  expect(ans.status).toBe(204);
  expect((await request(app).get(`/api/terminals/${id}/permission`)).body).toBeNull(); // cleared
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('answers map shape: POST allow with answers folds {questions, answers} into the tool updatedInput', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'planner', role: 'agent' } });
  const id = t.body.id;
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_QUESTION' });
  const pending = await pollPermission(app, id);
  expect(pending.questions[0].question).toBe('Pick one');
  const ans = await request(app).post(`/api/terminals/${id}/permission`).send({ decision: 'allow', answers: { 'Pick one': 'A' } });
  expect(ans.status).toBe(204);
  const echoed = await pollEvent(app, id, (e) => e?.type === 'user' && JSON.stringify(e).includes('"answers"'));
  const tr = echoed.message.content[0];
  expect(tr.updatedInput.answers).toEqual({ 'Pick one': 'A' });
  expect(tr.updatedInput.questions[0].question).toBe('Pick one');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('POST permission deny resolves with a message', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent' } });
  const id = t.body.id;
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  await pollPermission(app, id);
  const ans = await request(app).post(`/api/terminals/${id}/permission`).send({ decision: 'deny', message: 'nope' });
  expect(ans.status).toBe(204);
  const echoed = await pollEvent(app, id, (e) => e?.type === 'user' && JSON.stringify(e).includes('DENIED'));
  expect(echoed.message.content[0].message).toBe('nope');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('POST permission with no pending → 404; bad decision → 400', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'reviewer', role: 'agent' } });
  const id = t.body.id;
  expect((await request(app).post(`/api/terminals/${id}/permission`).send({ decision: 'allow' })).status).toBe(404);
  expect((await request(app).post(`/api/terminals/${id}/permission`).send({ decision: 'maybe' })).status).toBe(400);
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('a plain structured thread (no role) auto-allows gated tools — no escalation', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  const wrote = await pollEvent(app, id, (e) => JSON.stringify(e).includes('WROTE')); // auto-allowed
  expect(JSON.stringify(wrote)).toContain('WROTE');
  expect((await request(app).get(`/api/terminals/${id}/permission`)).body).toBeNull(); // never pending
  await request(app).post(`/api/terminals/${id}/stop`);
});

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
