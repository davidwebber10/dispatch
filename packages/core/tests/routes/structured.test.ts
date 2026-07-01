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
async function pollExternalId(database: Database.Database, id: string, expected: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = database.prepare('SELECT external_id FROM terminals WHERE id = ?').get(id) as { external_id: string | null } | undefined;
    if (row && row.external_id === expected) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for external_id to be captured');
}

it('a SUPERVISED agent thread escalates a gated tool: GET shows pending, POST allow resolves it', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', autonomy: 'supervised' } });
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
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', autonomy: 'supervised' } });
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

it('an AUTONOMOUS agent thread does NOT escalate — gated tools auto-allow at spawn', async () => {
  const t = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', autonomy: 'autonomous' } });
  expect(t.status).toBe(201);
  const id = t.body.id;
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  const wrote = await pollEvent(app, id, (e) => JSON.stringify(e).includes('WROTE')); // auto-allowed
  expect(JSON.stringify(wrote)).toContain('WROTE');
  expect((await request(app).get(`/api/terminals/${id}/permission`)).body).toBeNull(); // never pending
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('an agent is autonomous by default: gated tools auto-allow, but AskUserQuestion still surfaces', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent' } });
  const id = t.body.id;
  // A normal gated tool auto-allows — agents run free, no human prompt (the new default).
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  const wrote = await pollEvent(app, id, (e) => JSON.stringify(e).includes('WROTE'));
  expect(JSON.stringify(wrote)).toContain('WROTE');
  expect((await request(app).get(`/api/terminals/${id}/permission`)).body).toBeNull(); // never pended
  // ... but AskUserQuestion can't be auto-allowed, so it STILL surfaces as pending.
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_QUESTION' });
  const pending = await pollPermission(app, id);
  expect(pending.toolName).toBe('AskUserQuestion');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('an agent question escalates UP to the project coordinator (not to the human)', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-q-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'q' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Login' } })).body.id;
  await pollExternalId(db, coordId, 'sess-fake'); // coordinator is up

  await request(a).post(`/api/terminals/${agentId}/message`).send({ text: 'TRIGGER_QUESTION' });

  // The coordinator is told its agent is PAUSED asking (a directive injected into its thread).
  const note = await pollEvent(a, coordId, (e) => e?.type === 'user' && JSON.stringify(e).includes(agentId), 4000);
  expect(JSON.stringify(note)).toContain('PAUSED');
  expect(JSON.stringify(note)).toContain('answer_agent');
  // The agent is genuinely paused (so the coordinator CAN answer it) ...
  const pending = await pollPermission(a, agentId);
  expect(pending.toolName).toBe('AskUserQuestion');
  // ... and answer_agent (→ POST /permission with the chosen option) resolves it.
  const ans = await request(a).post(`/api/terminals/${agentId}/permission`).send({ decision: 'allow', answers: { Choice: 'A' } });
  expect(ans.status).toBe(204);

  await request(a).post(`/api/terminals/${agentId}/stop`);
  await request(a).post(`/api/terminals/${coordId}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('stopping an agent notifies its coordinator (Dispatch is told to check in)', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-life-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'life' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Login' } })).body.id;
  await pollExternalId(db, agentId, 'sess-fake'); // agent is up

  await request(a).post(`/api/terminals/${agentId}/stop`);

  // The coordinator hears that the user stopped its agent (a directive injected into its thread).
  const note = await pollEvent(a, coordId, (e) => e?.type === 'user' && JSON.stringify(e).includes(agentId) && JSON.stringify(e).includes('stopped'), 4000);
  expect(JSON.stringify(note)).toContain('Check in with the user');

  await request(a).post(`/api/terminals/${coordId}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('a structured turn flips status working → idle on the result event (no more stuck "working")', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');
  // A normal message → the fake replies + emits `result` (turn end).
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'investigate' });
  // Status settles to 'waiting' (idle) once the result lands — it no longer stays 'working' forever.
  const start = Date.now();
  let status = '';
  while (Date.now() - start < 3000) {
    status = (db.prepare('SELECT status FROM terminals WHERE id = ?').get(id) as { status: string }).status;
    if (status === 'waiting') break;
    await sleep(25);
  }
  expect(status).toBe('waiting');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('an agent completing a turn pushes an immediate completion notice to its coordinator', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-done-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'done' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'researcher', role: 'agent', mission: 'Repo map' } })).body.id;
  await pollExternalId(db, coordId, 'sess-fake');

  // Seed the agent with a task → it replies + emits `result` (turn end).
  await request(a).post(`/api/terminals/${agentId}/message`).send({ text: 'map the repo' });

  // The coordinator gets an IMMEDIATE "✅ … finished a turn" notice naming the agent, its last
  // output (the summary), and the read_agent pointer — the closed orchestration loop.
  const note = await pollEvent(a, coordId, (e) => e?.type === 'user' && JSON.stringify(e).includes(agentId) && JSON.stringify(e).includes('finished a turn'), 4000);
  expect(JSON.stringify(note)).toContain('read_agent');
  expect(JSON.stringify(note)).toContain('echo:map the repo'); // the agent's last output, folded into the summary

  await request(a).post(`/api/terminals/${agentId}/stop`);
  await request(a).post(`/api/terminals/${coordId}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('POST /autonomy flips a supervised agent to autonomous: resolves the pending + persists config', async () => {
  const t = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', autonomy: 'supervised' } });
  const id = t.body.id;
  // Supervised (explicit) → a gated tool blocks on the membrane.
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  await pollPermission(app, id);

  // Flip to autonomous: the pending request auto-resolves (allow) and config persists.
  const flip = await request(app).post(`/api/terminals/${id}/autonomy`).send({ mode: 'autonomous' });
  expect(flip.status).toBe(200);
  await pollEvent(app, id, (e) => e?.type === 'user' && JSON.stringify(e).includes('WROTE'));
  expect((await request(app).get(`/api/terminals/${id}/permission`)).body).toBeNull();
  const row = db.prepare('SELECT config FROM terminals WHERE id = ?').get(id) as { config: string };
  expect(JSON.parse(row.config).autonomy).toBe('autonomous');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('POST /autonomy rejects an invalid mode (400)', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const r = await request(app).post(`/api/terminals/${t.body.id}/autonomy`).send({ mode: 'banana' });
  expect(r.status).toBe(400);
  await request(app).post(`/api/terminals/${t.body.id}/stop`);
});

it('POST /interrupt sends the interrupt control frame to a live thread (204)', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  const r = await request(app).post(`/api/terminals/${id}/interrupt`);
  expect(r.status).toBe(204);
  const echoed = await pollEvent(app, id, (e) => e?.type === 'system' && e.subtype === 'control_request_received');
  expect(echoed.request.subtype).toBe('interrupt');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('POST /interrupt with no live session → 409', async () => {
  const r = await request(app).post(`/api/terminals/does-not-exist/interrupt`);
  expect(r.status).toBe(409);
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

it('accepts a content-block ARRAY (image) payload → 204 and forwards it verbatim (no top-level text required)', async () => {
  // Regression for the coordinator image-send 400: the route must accept a `content`-only
  // (image block) body, NOT require a top-level `text` string. Pre-1173b32 the validation
  // was `text (string) is required` and rejected this exact shape.
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'what color?' },
  ];
  const res = await request(app).post(`/api/terminals/${id}/message`).send({ content });
  expect(res.status).toBe(204); // NOT 400
  // …and the image block reached the manager (echoed verbatim into the event ring).
  const echoed = await pollEvent(app, id, (e) => e?.type === 'user' && Array.isArray(e?.message?.content) && e.message.content.some((b: any) => b?.type === 'image'));
  expect(echoed.message.content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  await request(app).post(`/api/terminals/${id}/stop`);
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

// --- persistence / resume across a (simulated) daemon restart -------------------

it('captures the init session_id and persists it onto the terminal external_id', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake'); // fake-claude's init session_id is captured + stored
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('lazily resumes a dead AGENT thread with -r <id> and re-applies escalate', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', autonomy: 'supervised' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');

  // Simulate a daemon restart: the process is gone, but the DB row (with external_id) survives.
  const mgr = (app as any)._structuredManager;
  mgr.kill(id);
  expect(mgr.isAlive(id)).toBe(false);

  // A message lazily resumes the SAME claude conversation before delivering.
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'TRIGGER_PERMISSION' });
  expect(mgr.isAlive(id)).toBe(true);

  // The resume applied `-r sess-fake` (surfaced via fake-claude's argv echo).
  const init = await pollEvent(app, id, (e) => e?.type === 'system' && Array.isArray(e.argv) && e.argv.includes('-r'));
  expect(init.argv).toContain('sess-fake');

  // escalate re-applied: the gated tool surfaces (an auto-allow thread would never be pending).
  const pending = await pollPermission(app, id);
  expect(pending.toolName).toBe('Write');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('lazily re-spawns a dead structured thread with NO external_id (fresh, no -r)', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');

  const mgr = (app as any)._structuredManager;
  const svc = (app as any)._sessionService;
  // Simulate a thread whose session id was never captured (e.g. killed before init):
  // kill the process AND null external_id. The bug: such a thread could not be revived,
  // so sendStructuredMessage threw "no structured session" and the message vanished.
  mgr.kill(id);
  db.prepare('UPDATE terminals SET external_id = NULL WHERE id = ?').run(id);
  expect(mgr.isAlive(id)).toBe(false);

  // Fix: revive by spawning FRESH (no -r) rather than silently failing.
  expect(svc.ensureStructuredAlive(id)).toBe(true);
  expect(mgr.isAlive(id)).toBe(true);
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'hello' }); // now delivers

  const init = await pollEvent(app, id, (e) => e?.type === 'system' && Array.isArray(e.argv));
  expect(init.argv).not.toContain('-r'); // fresh, not a resume
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('resuming a coordinator thread re-folds the dispatch agency MCP wiring', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-resume-'));
  const coordApp = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(coordApp).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'cr' });
  const t = await request(coordApp).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');

  const cfgPath = path.join(cfgDir, `coordinator-${id}.mcp.json`);
  expect(fs.existsSync(cfgPath)).toBe(true);

  // Restart + delete the generated config to prove resume regenerates it.
  const mgr = (coordApp as any)._structuredManager;
  mgr.kill(id);
  fs.rmSync(cfgPath);

  await request(coordApp).post(`/api/terminals/${id}/message`).send({ text: 'hello' });
  expect(mgr.isAlive(id)).toBe(true);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); // re-folded on resume
  expect(cfg.mcpServers.dispatch.command).toBe('node');
  await request(coordApp).post(`/api/terminals/${id}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('does not re-spawn a still-alive structured thread (idempotent)', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');

  const mgr = (app as any)._structuredManager;
  const svc = (app as any)._sessionService;
  const pidBefore = (db.prepare('SELECT pid FROM terminals WHERE id = ?').get(id) as { pid: number }).pid;

  expect(svc.ensureStructuredAlive(id)).toBe(true); // no-op while alive
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'hello' });

  const pidAfter = (db.prepare('SELECT pid FROM terminals WHERE id = ?').get(id) as { pid: number }).pid;
  expect(pidAfter).toBe(pidBefore); // same process — never re-spawned
  expect(mgr.isAlive(id)).toBe(true);
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('ensureStructuredAlive is a no-op for non-structured / unknown threads', async () => {
  const svc = (app as any)._sessionService;
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'shell' });
  expect(svc.ensureStructuredAlive(t.body.id)).toBe(false); // shell isn't a resumable structured thread
  expect(svc.ensureStructuredAlive('does-not-exist')).toBe(false);
  await request(app).post(`/api/terminals/${t.body.id}/stop`);
});

// --- queued terminals (create-without-spawn + promote) -------------------------

it('queued create persists status=queued and parks the task WITHOUT spawning a process', async () => {
  const mgr = (app as any)._structuredManager;
  const t = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', queued: true, task: 'do the thing', config: { transport: 'structured', agentType: 'implementer', role: 'agent' } });
  expect(t.status).toBe(201);
  const id = t.body.id;
  expect(t.body.status).toBe('queued');
  // The task is parked and the guard flag is set — but nothing is running.
  const row = db.prepare('SELECT config FROM terminals WHERE id = ?').get(id) as { config: string };
  const cfg = JSON.parse(row.config);
  expect(cfg.queued).toBe(true);
  expect(cfg.queuedTask).toBe('do the thing');
  expect(cfg.agentType).toBe('implementer'); // caller config preserved
  expect(mgr.isAlive(id)).toBe(false); // no process spawned
});

it('ensureStructuredAlive REFUSES to spawn a queued row (the guard)', async () => {
  const svc = (app as any)._sessionService;
  const mgr = (app as any)._structuredManager;
  const t = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', queued: true, task: 'later', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  const id = t.body.id;
  // A drill-in (ws-connect) or stray message routes through ensureStructuredAlive — which
  // must NOT wake a parked row, or the queue would spawn itself the moment anyone looked at it.
  expect(svc.ensureStructuredAlive(id)).toBe(false);
  expect(mgr.isAlive(id)).toBe(false);
});

it('POST /start promotes a queued terminal: strips the markers, spawns, delivers the parked task', async () => {
  const mgr = (app as any)._structuredManager;
  const t = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', queued: true, task: 'map the repo', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  const id = t.body.id;
  expect(mgr.isAlive(id)).toBe(false);

  const started = await request(app).post(`/api/terminals/${id}/start`);
  expect(started.status).toBe(200);
  expect(started.body.status).not.toBe('queued');
  expect(mgr.isAlive(id)).toBe(true); // now running

  // The queued markers are stripped from the persisted config; original config survives.
  const cfg = JSON.parse((db.prepare('SELECT config FROM terminals WHERE id = ?').get(id) as { config: string }).config);
  expect(cfg.queued).toBeUndefined();
  expect(cfg.queuedTask).toBeUndefined();
  expect(cfg.transport).toBe('structured');
  expect(cfg.agentType).toBe('researcher');

  // …and the parked task is delivered to the freshly-spawned thread (fake echoes it back).
  const echoed = await pollEvent(app, id, (e) => JSON.stringify(e).includes('echo:map the repo'));
  expect(JSON.stringify(echoed)).toContain('echo:map the repo');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('POST /start on a non-queued terminal is a no-op (200, unchanged); unknown id → 404', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  expect((await request(app).post(`/api/terminals/${id}/start`)).status).toBe(200);
  expect((await request(app).post(`/api/terminals/does-not-exist/start`)).status).toBe(404);
  await request(app).post(`/api/terminals/${id}/stop`);
});
