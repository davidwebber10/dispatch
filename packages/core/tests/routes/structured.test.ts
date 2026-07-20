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
import * as terminalsDb from '../../src/db/terminals.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
const fakeCodex = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-codex-app-server.mjs');
let app: any; let db: Database.Database; let sessionId: string; let dir: string;
// Secondary apps spawned by helpers below (e.g. spawnAgentUnderCoordinator) get their
// structured managers killed + their secretsDir removed in the shared afterEach, mirroring
// the explicit per-test `/stop` + `fs.rmSync(cfgDir, …)` cleanup used elsewhere in this file.
let extraApps: { app: any; cfgDir: string }[] = [];
beforeEach(async () => {
  db = new Database(':memory:'); initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-'));
  // structuredCommand override makes the app spawn the fake instead of real claude (see Task 6 wiring)
  app = createApp({ db, skipPty: true, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 't' });
  sessionId = s.body.id;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  (app as any)?._structuredManager?.killAll?.();
  for (const { app: a, cfgDir } of extraApps) {
    try { (a as any)._structuredManager?.killAll?.(); } catch { /* best effort */ }
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  extraApps = [];
});

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
/**
 * Waits for a manager-level emit `(terminalId, ...rest)` — e.g. 'needs-help'/'idle'/'scheduled'
 * — scoped to one terminal id. Mirrors waitForManagerEvent in tests/structured/manager.test.ts.
 * These are NOT stream-json events (pollEvent's ring), so they can't be polled off getEvents.
 */
function pollManagerEvent(mgr: any, event: string, id: string, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { mgr.off(event, on); reject(new Error(`timeout waiting for manager '${event}'`)); }, timeoutMs);
    const on = (eid: string, ...rest: any[]) => { if (eid === id) { clearTimeout(t); mgr.off(event, on); resolve(rest); } };
    mgr.on(event, on);
  });
}
/** Polls `terminals.status` on the shared `db` until it reaches `status` (or times out). */
async function pollStatus(id: string, status: string, timeoutMs = 3000): Promise<string> {
  const start = Date.now();
  let cur = '';
  while (Date.now() - start < timeoutMs) {
    const row = db.prepare('SELECT status FROM terminals WHERE id = ?').get(id) as { status: string } | undefined;
    cur = row?.status ?? '';
    if (cur === status) return cur;
    await sleep(25);
  }
  throw new Error(`timeout waiting for status='${status}' (last seen '${cur}')`);
}
/** A plain (no-role) structured terminal on the shared `app`/`sessionId`, sent one message. */
async function createStructuredTerminal(opts: { text: string }): Promise<string> {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await request(app).post(`/api/terminals/${id}/message`).send({ text: opts.text });
  return id;
}
/**
 * A coordinator + a typed AGENT under it (own app/secretsDir, mirroring the coordinator
 * tests above), with the agent immediately sent one message. Registered in `extraApps` for
 * afterEach cleanup — killed AFTER the test body runs, so `readEvents` below can still see
 * whatever landed on the coordinator's ring during the test.
 */
async function spawnAgentUnderCoordinator(opts: { text: string }): Promise<{ agentId: string; coordinatorId: string }> {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-outcome-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  extraApps.push({ app: a, cfgDir });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'outcome' });
  const coordinatorId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Deploy' } })).body.id;
  await pollExternalId(db, coordinatorId, 'sess-fake'); // coordinator is up before the agent's turn ends
  await request(a).post(`/api/terminals/${agentId}/message`).send({ text: opts.text });
  return { agentId, coordinatorId };
}
/** The event ring for a terminal spawned via spawnAgentUnderCoordinator's app. */
async function readEvents(id: string): Promise<any[]> {
  const { app: a } = extraApps[extraApps.length - 1];
  return (a as any)._structuredManager.getEvents(id);
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
  expect(pending.questions[0]).toMatchObject({ header: 'Choice', question: 'Pick one' }); // header !== question text
  // ... and answer_agent (→ POST /permission with the chosen option) resolves it. The coordinator
  // contract documents answering by HEADER (formatAgentQuestion's example), but the real `claude`
  // CLI's AskUserQuestion result mapper looks up each answer by `question` TEXT — so a header-keyed
  // answer must be remapped onto the question text before it reaches the tool, or the CLI reports
  // "The user did not answer the questions" even though this POST returns 204.
  const ans = await request(a).post(`/api/terminals/${agentId}/permission`).send({ decision: 'allow', answers: { Choice: 'A' } });
  expect(ans.status).toBe(204);
  const echoed = await pollEvent(a, agentId, (e) => e?.type === 'user' && JSON.stringify(e).includes('"answers"'));
  const tr = echoed.message.content[0];
  expect(tr.updatedInput.answers).toEqual({ 'Pick one': 'A' }); // keyed by question TEXT, not header 'Choice'

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

// --- turn-end status truth: a declared/inferred needs-help vs a plain idle ---------------
//
// The 'needs-help' manager event lands on this exact HTTP round-trip (spawn → POST /message
// → fake CLI → result), proving the wiring end-to-end. Routing 'needs-help' onto
// terminals.status (=> 'needs_input') is a later task (StatusService wiring in server.ts) —
// asserted here at the manager-event boundary Task 2 actually owns.

it('a turn ending with a plain-text question (no report_status) emits needs-help, marked inferred', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');
  const mgr = (app as any)._structuredManager;
  const needsHelpP = pollManagerEvent(mgr, 'needs-help', id);
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'I rewired the rail. Does that look right to you?' });
  const [detail] = await needsHelpP;
  expect(detail.inferred).toBe(true);
  expect(detail.ask).toContain('Does that look right to you?');
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('a turn ending with a completion report emits idle, never needs-help', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');
  const mgr = (app as any)._structuredManager;
  const idleP = pollManagerEvent(mgr, 'idle', id);
  let sawNeedsHelp = false;
  const onNeedsHelp = (eid: string) => { if (eid === id) sawNeedsHelp = true; };
  mgr.on('needs-help', onNeedsHelp);
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'Merged to main. 6 commits, all green.' });
  await idleP;
  mgr.off('needs-help', onNeedsHelp);
  expect(sawNeedsHelp).toBe(false);
  await request(app).post(`/api/terminals/${id}/stop`);
});

it('a report_status-style declaration (noteDeclaredStatus) wins over the text heuristic at the result boundary', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');
  const mgr = (app as any)._structuredManager;
  mgr.noteDeclaredStatus(id, { state: 'needs_you', summary: 'need a decision', ask: 'Which provider?' });
  const needsHelpP = pollManagerEvent(mgr, 'needs-help', id);
  // Closing text alone reads as a plain completion report — the declaration must still win.
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'All finished here.' });
  const [detail] = await needsHelpP;
  expect(detail).toEqual({ ask: 'Which provider?', summary: 'need a decision', inferred: false });
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

it('POST /message tags the echoed event with `meta.source`; untagged sends carry no meta', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;

  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'hello' }); // no source
  const untagged = await pollEvent(app, id, (e) => e?.type === 'user' && JSON.stringify(e).includes('hello'));
  expect(untagged.meta).toBeUndefined();

  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'from a human', source: 'user' });
  const userTagged = await pollEvent(app, id, (e) => e?.type === 'user' && JSON.stringify(e).includes('from a human'));
  expect(userTagged.meta).toEqual({ source: 'user' });

  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'from the coordinator', source: 'coordinator' });
  const coordTagged = await pollEvent(app, id, (e) => e?.type === 'user' && JSON.stringify(e).includes('from the coordinator'));
  expect(coordTagged.meta).toEqual({ source: 'coordinator' });

  await request(app).post(`/api/terminals/${id}/stop`);
});

// --- durable source persistence: survives the CLI process exiting -------------
//
// fake-claude.mjs only emits NDJSON over stdout — it never writes an actual transcript
// JSONL to disk the way the real `claude` CLI does. So these tests point HOME at a temp
// dir (same pattern as sessions/kickstart.test.ts) and hand-write the transcript line a
// real CLI would have produced for the turn under test, BEFORE sending it — giving
// findNewestUnresolvedUserUuid / readSessionBackfill / getConversation a real uuid to
// resolve against, exactly like production.
describe('durable source persistence: survives the CLI process exiting', () => {
  const realHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-durable-home-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(workDir: string, transcriptSessionId: string, lines: unknown[]): void {
    const projDir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
    fs.mkdirSync(projDir, { recursive: true });
    // Trailing newline, matching a real transcript: getConversation's `usable` array drops
    // the LAST split('\n') element on the assumption it may be a partial write-in-progress —
    // without a trailing newline here, that logic would wrongly discard our one real line.
    fs.writeFileSync(path.join(projDir, `${transcriptSessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  async function pollMessageSourceRow(database: Database.Database, terminalId: string, timeoutMs = 3000): Promise<{ uuid: string; source: string }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = database.prepare('SELECT uuid, source FROM message_source WHERE terminal_id = ?').get(terminalId) as { uuid: string; source: string } | undefined;
      if (row) return row;
      await sleep(25);
    }
    throw new Error('timeout waiting for a durable message_source row');
  }

  it('a message source survives the CLI process exiting and the thread being lazily revived (backfill ring)', async () => {
    const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
    const id = t.body.id;
    await pollExternalId(db, id, 'sess-fake');

    writeTranscript(dir, 'sess-fake', [
      { type: 'user', uuid: 'coord-msg-uuid', message: { role: 'user', content: [{ type: 'text', text: 'from the coordinator' }] } },
    ]);

    await request(app).post(`/api/terminals/${id}/message`).send({ text: 'from the coordinator', source: 'coordinator' });
    // Turn completes (fake replies + emits `result`) → manager resolves + persists durably.
    await pollEvent(app, id, (e) => e?.type === 'result');
    const row = await pollMessageSourceRow(db, id);
    expect(row).toEqual({ uuid: 'coord-msg-uuid', source: 'coordinator' });

    // Simulate the CLI process exiting (e.g. auto-archive) — the live ring/process is gone.
    const mgr = (app as any)._structuredManager;
    mgr.kill(id);
    expect(mgr.isAlive(id)).toBe(false);

    // Reconnect/reload: a new message lazily revives the thread, seeding the ring PURELY
    // from the on-disk transcript (readSessionBackfill) — this is the exact path that lost
    // the source tag before this fix (the in-memory echo never reached disk).
    await request(app).post(`/api/terminals/${id}/message`).send({ text: 'next turn' });
    expect(mgr.isAlive(id)).toBe(true);

    const revived = mgr.getEvents(id).find((e: any) => e?.uuid === 'coord-msg-uuid');
    expect(revived).toBeTruthy();
    expect(revived.meta).toEqual({ source: 'coordinator' }); // survived the exit + disk re-hydration

    await request(app).post(`/api/terminals/${id}/stop`);
  });

  it('a durable source also survives on the REST conversation endpoint (archived-thread / loadOlder hydration path)', async () => {
    const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
    const id = t.body.id;
    await pollExternalId(db, id, 'sess-fake');

    writeTranscript(dir, 'sess-fake', [
      { type: 'user', uuid: 'coord-msg-uuid-2', message: { role: 'user', content: [{ type: 'text', text: 'from the coordinator' }] } },
    ]);

    await request(app).post(`/api/terminals/${id}/message`).send({ text: 'from the coordinator', source: 'coordinator' });
    await pollEvent(app, id, (e) => e?.type === 'result');
    await pollMessageSourceRow(db, id);

    const conv = await request(app).get(`/api/terminals/${id}/conversation`);
    expect(conv.status).toBe(200);
    const item = conv.body.items.find((it: any) => it.uuid === 'coord-msg-uuid-2');
    expect(item).toBeTruthy();
    expect(item.source).toBe('coordinator');

    await request(app).post(`/api/terminals/${id}/stop`);
  });

  it('an untagged send has no durable row and stays a plain bubble after revival', async () => {
    const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
    const id = t.body.id;
    await pollExternalId(db, id, 'sess-fake');

    writeTranscript(dir, 'sess-fake', [
      { type: 'user', uuid: 'plain-msg-uuid', message: { role: 'user', content: [{ type: 'text', text: 'plain human turn' }] } },
    ]);

    await request(app).post(`/api/terminals/${id}/message`).send({ text: 'plain human turn' }); // no source
    await pollEvent(app, id, (e) => e?.type === 'result');
    await sleep(150); // give a (would-be-incorrect) resolution a chance to land

    expect(db.prepare('SELECT COUNT(*) c FROM message_source WHERE terminal_id = ?').get(id)).toEqual({ c: 0 });

    const mgr = (app as any)._structuredManager;
    mgr.kill(id);
    await request(app).post(`/api/terminals/${id}/message`).send({ text: 'next turn' });
    const revived = mgr.getEvents(id).find((e: any) => e?.uuid === 'plain-msg-uuid');
    expect(revived).toBeTruthy();
    expect(revived.meta).toBeUndefined();

    await request(app).post(`/api/terminals/${id}/stop`);
  });
});

it('a direct user message to an agent (source:"user") notifies its coordinator — bypassing message_agent', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-usermsg-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'usermsg' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Login' } })).body.id;
  await pollExternalId(db, coordId, 'sess-fake');

  await request(a).post(`/api/terminals/${agentId}/message`).send({ text: 'stop that, refactor the auth flow instead', source: 'user' });

  // The coordinator hears that the user went around it directly (a directive injected into its thread).
  const note = await pollEvent(a, coordId, (e) => e?.type === 'user' && JSON.stringify(e).includes(agentId) && JSON.stringify(e).includes('not through you'), 4000);
  expect(JSON.stringify(note)).toContain('💬');
  expect(JSON.stringify(note)).toContain('stop that, refactor the auth flow instead');
  expect(JSON.stringify(note)).toContain('read_agent');

  await request(a).post(`/api/terminals/${agentId}/stop`);
  await request(a).post(`/api/terminals/${coordId}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('an image-only direct user send summarizes as "(sent an image)" in the coordinator notice', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-userimg-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'userimg' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Login' } })).body.id;
  await pollExternalId(db, coordId, 'sess-fake');

  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
  await request(a).post(`/api/terminals/${agentId}/message`).send({ content, source: 'user' });

  const note = await pollEvent(a, coordId, (e) => e?.type === 'user' && JSON.stringify(e).includes(agentId) && JSON.stringify(e).includes('not through you'), 4000);
  expect(JSON.stringify(note)).toContain('(sent an image)');

  await request(a).post(`/api/terminals/${agentId}/stop`);
  await request(a).post(`/api/terminals/${coordId}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('untagged and source:"coordinator" sends to an agent do NOT notify the coordinator (no self-notify)', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-noself-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'noself' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  const agentId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'Login' } })).body.id;
  await pollExternalId(db, coordId, 'sess-fake');

  await request(a).post(`/api/terminals/${agentId}/message`).send({ text: 'keep going' }); // untagged
  await request(a).post(`/api/terminals/${agentId}/message`).send({ text: 'keep going still', source: 'coordinator' });
  await sleep(300); // give an (incorrect) notify a chance to land before asserting its absence

  // The coordinator DOES hear routine "finished a turn" completion notices for its agent
  // (unrelated to this feature) — assert specifically that the direct-user-message notice
  // (unique phrase "not through you") never fires for these untagged/coordinator sends.
  const mgr = (a as any)._structuredManager;
  const coordEvents = mgr.getEvents(coordId) as any[];
  expect(coordEvents.some((e) => e?.type === 'user' && JSON.stringify(e).includes('not through you'))).toBe(false);

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

it('a coordinator spawn folds the dispatch agency server into its --mcp-config, carrying caller identity', async () => {
  // secretsDir controls where the SessionService writes mcp configs, so we can read
  // the config the structured spawn writes before launch — the agency spec rides the
  // standard composeInjection path, but to a PER-TERMINAL file (thread-<id>.mcp.json),
  // not a shared mcp.json — see agency-mcp-injection.test.ts for why (a shared
  // daemon-wide path races another terminal's spawn and can leak its identity).
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-cfg-'));
  const coordApp = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(coordApp).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'c' });
  const coordSession = s.body.id;

  const t = await request(coordApp)
    .post(`/api/sessions/${coordSession}/terminals`)
    .send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } });
  expect(t.status).toBe(201);

  const cfgPath = path.join(cfgDir, `thread-${t.body.id}.mcp.json`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  expect(cfg.mcpServers.dispatch.command).toBe('node');
  expect(cfg.mcpServers.dispatch.args[0]).toMatch(/agency-mcp\.js$/);
  expect(cfg.mcpServers.dispatch.env.DISPATCH_SESSION).toBe(coordSession);
  expect(cfg.mcpServers.dispatch.env.DISPATCH_PORT).toBe(String(process.env.PORT || 3456));
  expect(cfg.mcpServers.dispatch.env.DISPATCH_TERMINAL).toBe(t.body.id);

  await request(coordApp).post(`/api/terminals/${t.body.id}/stop`); // clean up the fake child
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('Task 8 ungate: a typed AGENT (non-coordinator role) structured spawn ALSO writes the dispatch server', async () => {
  // Pre-Task-8 this asserted the dispatch server was ABSENT (the gate was
  // config.role === 'coordinator'). Task 8 flips eligibility to TYPE — any
  // claude-code/codex thread qualifies regardless of role — so a typed agent is
  // exactly as eligible as a plain thread or a coordinator. See
  // packages/core/tests/sessions/agency-mcp-injection.test.ts for the
  // plain-thread and shell-exclusion cases.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noncoord-cfg-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'n' });
  const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  expect(t.status).toBe(201);
  const cfgPath = path.join(cfgDir, `thread-${t.body.id}.mcp.json`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  expect(cfg.mcpServers.dispatch).toBeTruthy();
  expect(cfg.mcpServers.dispatch.env.DISPATCH_TERMINAL).toBe(t.body.id);
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

  const cfgPath = path.join(cfgDir, `thread-${id}.mcp.json`);
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

// --- queue_agent dependsOn (auto-start on a dependency's completion) -----------

it('dependsOn is stored on the queued terminal\'s config, and does NOT auto-start while unmet', async () => {
  const mgr = (app as any)._structuredManager;
  const a = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', label: 'Agent A', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  await pollExternalId(db, a.body.id, 'sess-fake'); // A is alive but hasn't finished a turn yet

  const b = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', label: 'Agent B', queued: true, task: 'do B work', config: { transport: 'structured', agentType: 'implementer', role: 'agent', dependsOn: a.body.id } });
  expect(b.status).toBe(201);
  expect(b.body.status).toBe('queued');

  const cfg = JSON.parse((db.prepare('SELECT config FROM terminals WHERE id = ?').get(b.body.id) as { config: string }).config);
  expect(cfg.dependsOn).toBe(a.body.id);
  expect(cfg.queued).toBe(true);
  expect(cfg.queuedTask).toBe('do B work');
  expect(mgr.isAlive(b.body.id)).toBe(false); // A hasn't produced output yet — B stays queued

  await request(app).post(`/api/terminals/${a.body.id}/stop`);
});

it('auto-starts a queued dependent the moment the agent it depends on finishes, injecting its output as context', async () => {
  const mgr = (app as any)._structuredManager;
  const a = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', label: 'Agent A', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  await pollExternalId(db, a.body.id, 'sess-fake');

  const b = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', label: 'Agent B', queued: true, task: 'do B work', config: { transport: 'structured', agentType: 'implementer', role: 'agent', dependsOn: a.body.id } });
  const bId = b.body.id;
  expect(mgr.isAlive(bId)).toBe(false);

  // A finishes a turn (fake echoes the text back + emits `result`).
  await request(app).post(`/api/terminals/${a.body.id}/message`).send({ text: 'investigate X' });
  await pollEvent(app, a.body.id, (e) => e?.type === 'assistant' && JSON.stringify(e).includes('echo:investigate X'));

  // B auto-starts off A's `idle` event — no start_agent call needed.
  const start = Date.now();
  while (Date.now() - start < 3000 && !mgr.isAlive(bId)) await sleep(25);
  expect(mgr.isAlive(bId)).toBe(true);

  const delivered = await pollEvent(app, bId, (e) => e?.type === 'user' && JSON.stringify(e).includes('do B work'));
  const text = delivered.message.content[0].text;
  expect(text).toContain('The agent you were waiting on ("Agent A") has finished');
  expect(text).toContain('echo:investigate X'); // A's final output, injected as context
  expect(text).toContain('Your task: do B work'); // B's originally parked task, appended

  const cfg = JSON.parse((db.prepare('SELECT config FROM terminals WHERE id = ?').get(bId) as { config: string }).config);
  expect(cfg.dependsOn).toBeUndefined();
  expect(cfg.queued).toBeUndefined();
  expect(cfg.queuedTask).toBeUndefined();

  await request(app).post(`/api/terminals/${a.body.id}/stop`);
  await request(app).post(`/api/terminals/${bId}/stop`);
});

it('start_agent on a terminal with an unmet dependsOn starts it early anyway — original task, no injected context', async () => {
  const mgr = (app as any)._structuredManager;
  const a = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', label: 'Agent A', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  await pollExternalId(db, a.body.id, 'sess-fake'); // A never gets messaged — never finishes

  const b = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', label: 'Agent B', queued: true, task: 'original B task', config: { transport: 'structured', agentType: 'implementer', role: 'agent', dependsOn: a.body.id } });
  const bId = b.body.id;

  const started = await request(app).post(`/api/terminals/${bId}/start`);
  expect(started.status).toBe(200);
  expect(started.body.status).not.toBe('queued');
  expect(mgr.isAlive(bId)).toBe(true);

  const delivered = await pollEvent(app, bId, (e) => e?.type === 'user' && JSON.stringify(e).includes('original B task'));
  expect(delivered.message.content[0].text).toBe('original B task'); // manual override: no injected context

  const cfg = JSON.parse((db.prepare('SELECT config FROM terminals WHERE id = ?').get(bId) as { config: string }).config);
  expect(cfg.dependsOn).toBeUndefined();

  await request(app).post(`/api/terminals/${a.body.id}/stop`);
  await request(app).post(`/api/terminals/${bId}/stop`);
});

it('dependsOn already satisfied at queue time (dependency already finished) auto-starts immediately — no idle event needed', async () => {
  const mgr = (app as any)._structuredManager;
  const a = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', label: 'Agent A', config: { transport: 'structured', agentType: 'researcher', role: 'agent' } });
  await pollExternalId(db, a.body.id, 'sess-fake');
  await request(app).post(`/api/terminals/${a.body.id}/message`).send({ text: 'map the repo' });
  await pollEvent(app, a.body.id, (e) => e?.type === 'assistant' && JSON.stringify(e).includes('echo:map the repo')); // A is already done

  // Only NOW queue B, depending on an agent that already finished — its `idle` event
  // already fired in the past, so B must not be left waiting on one that'll never come.
  const b = await request(app)
    .post(`/api/sessions/${sessionId}/terminals`)
    .send({ type: 'claude-code', label: 'Agent B', queued: true, task: 'do B work', config: { transport: 'structured', agentType: 'implementer', role: 'agent', dependsOn: a.body.id } });
  const bId = b.body.id;

  // Promoted synchronously inside the create call itself.
  expect(b.body.status).not.toBe('queued');
  expect(mgr.isAlive(bId)).toBe(true);

  const delivered = await pollEvent(app, bId, (e) => e?.type === 'user' && JSON.stringify(e).includes('do B work'));
  const text = delivered.message.content[0].text;
  expect(text).toContain('The agent you were waiting on ("Agent A") has finished');
  expect(text).toContain('echo:map the repo');
  expect(text).toContain('Your task: do B work');

  await request(app).post(`/api/terminals/${a.body.id}/stop`);
  await request(app).post(`/api/terminals/${bId}/stop`);
});

// --- Task 5: wire needs-help, persist the outcome -------------------------------

it('an agent that ends by asking does NOT tell its coordinator it finished, but DOES get its own BLOCKED/waiting notice', async () => {
  const { agentId, coordinatorId } = await spawnAgentUnderCoordinator({ text: 'Ready to deploy. Shall I proceed?' });
  await pollStatus(agentId, 'needs_input');
  const coordinatorEvents = await readEvents(coordinatorId);
  const joined = JSON.stringify(coordinatorEvents);
  expect(joined).not.toContain('just finished a turn');
  // Finding 2: a prose question must still escalate to the coordinator — just framed as
  // blocked/waiting, not as a (false) completion. Without this, the agent's question reaches
  // nobody and can stall the whole mission silently.
  expect(joined).toContain('BLOCKED');
  expect(joined).toContain('waiting on you');
  expect(joined).toContain('Ready to deploy. Shall I proceed?'); // the actual question, included verbatim
});

it('a needs-help turn on a non-agent (plain) thread notifies no coordinator at all', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-noagent-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  const s = await request(a).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'noagent' });
  const coordId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  // No `role` at all — a plain thread, not a typed agent.
  const plainId = (await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } })).body.id;
  await pollExternalId(db, coordId, 'sess-fake');

  await request(a).post(`/api/terminals/${plainId}/message`).send({ text: 'Ready to deploy. Shall I proceed?' });
  await sleep(300); // give a (would-be-incorrect) notify a chance to land before asserting its absence

  const mgr = (a as any)._structuredManager;
  const coordEvents = mgr.getEvents(coordId) as any[];
  expect(coordEvents.some((e) => e?.type === 'user' && JSON.stringify(e).includes('BLOCKED'))).toBe(false);

  await request(a).post(`/api/terminals/${plainId}/stop`);
  await request(a).post(`/api/terminals/${coordId}/stop`);
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

it('persists the turn outcome onto the terminal config, marked `inferred: true` — an undeclared completion turn is a GUESS, not a fact', async () => {
  const id = await createStructuredTerminal({ text: 'Merged to main. 6 commits, all green.' });
  await pollStatus(id, 'waiting');
  const cfg = JSON.parse(terminalsDb.getById(db, id)?.config || '{}');
  expect(cfg.lastOutcome?.summary).toContain('Merged to main');
  expect(cfg.lastOutcome?.needsHelp).toBe(false);
  expect(cfg.lastOutcome?.inferred).toBe(true);
});

it('a DECLARED done turn persists `inferred: false` — distinguishable from the undeclared case above', async () => {
  const t = await request(app).post(`/api/sessions/${sessionId}/terminals`).send({ type: 'claude-code', config: { transport: 'structured' } });
  const id = t.body.id;
  await pollExternalId(db, id, 'sess-fake');
  const mgr = (app as any)._structuredManager;
  mgr.noteDeclaredStatus(id, { state: 'done', summary: 'shipped it' });
  await request(app).post(`/api/terminals/${id}/message`).send({ text: 'All done here.' });
  await pollStatus(id, 'waiting');
  const cfg = JSON.parse(terminalsDb.getById(db, id)?.config || '{}');
  expect(cfg.lastOutcome?.needsHelp).toBe(false);
  expect(cfg.lastOutcome?.inferred).toBe(false);
  await request(app).post(`/api/terminals/${id}/stop`);
});

// --- Task 7 (+ the Task 5 review addition): Codex turn-end status truth ----------

it('a Codex idle turn persists ITS OWN completed agent message as the outcome summary — never stale text backfilled from an earlier resumed session', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outcome-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fakeCodex] } });
  try {
    const s = await request(a).post('/api/sessions').send({ provider: 'codex', workingDir: dir, name: 'codex-outcome' });
    const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'codex', config: { transport: 'structured' } });
    const id = t.body.id;
    // Pre-seed an external_id so the first spawn takes the RESUME path: the fake app-server's
    // thread/resume handler backfills a prior turn ('earlier answer') into the ring before the
    // live turn even starts — the exact trap scenario the brief describes (a whole `assistant`
    // text event that only a live Claude turn, never a live Codex one, would otherwise produce).
    terminalsDb.updateExternalId(db, id, 'thread-existing-9');
    await request(a).post(`/api/terminals/${id}/message`).send({ text: 'stream please' });
    await pollStatus(id, 'waiting');
    const cfg = JSON.parse(terminalsDb.getById(db, id)?.config || '{}');
    expect(cfg.lastOutcome?.summary).toBe('Hello world'); // this turn's OWN agentMessage text
    expect(cfg.lastOutcome?.summary).not.toContain('earlier answer'); // NOT the stale backfill
    expect(cfg.lastOutcome?.needsHelp).toBe(false);
    expect(cfg.lastOutcome?.inferred).toBe(true);
  } finally {
    (a as any)._sessionService?.structuredManagerFor('codex')?.killAll();
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

it('a Codex turn whose closing agent message asks a question settles needs-help, not idle — the exact bug this task fixes', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-needshelp-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fakeCodex] } });
  try {
    const s = await request(a).post('/api/sessions').send({ provider: 'codex', workingDir: dir, name: 'codex-needshelp' });
    const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'codex', config: { transport: 'structured' } });
    const id = t.body.id;
    // The fake app-server closes this turn on a question when the input says "needs a decision"
    // (see fake-codex-app-server.mjs). Before this task, Codex Pretty had no turn-end branching
    // at all — every Codex turn, question or not, settled 'idle'/'waiting' and was filed as
    // finished. This is the end-to-end proof it no longer is.
    await request(a).post(`/api/terminals/${id}/message`).send({ text: 'this needs a decision from you' });
    await pollStatus(id, 'needs_input');
    const cfg = JSON.parse(terminalsDb.getById(db, id)?.config || '{}');
    expect(cfg.lastOutcome?.needsHelp).toBe(true);
    expect(cfg.lastOutcome?.inferred).toBe(true);
    expect(cfg.lastOutcome?.summary).toContain('Does that look right to you?');
  } finally {
    (a as any)._sessionService?.structuredManagerFor('codex')?.killAll();
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

it('a Codex turn that completes with NO agentMessage persists an EMPTY outcome summary — never falls through to stale backfilled text (Fix 2)', async () => {
  // The residual stale-text door: a failed turn / an interrupt before any prose / a tool-only
  // turn supplies no completed agentMessage, so the translator's `summary` is ''. Before the
  // fix, server.ts's listener treated '' as "no summary" (a truthiness check) and fell back to
  // the generic Claude-shaped ring walk — which on a RESUMED thread returns the PREVIOUS
  // session's backfilled prose, persisted as this turn's outcome. This proves presence, not
  // truthiness, is now the authority: the empty summary is persisted as-is.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-summary-'));
  const a = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fakeCodex] } });
  try {
    const s = await request(a).post('/api/sessions').send({ provider: 'codex', workingDir: dir, name: 'codex-empty-summary' });
    const t = await request(a).post(`/api/sessions/${s.body.id}/terminals`).send({ type: 'codex', config: { transport: 'structured' } });
    const id = t.body.id;
    // The initial POST /terminals spawn is FRESH (no external_id yet) — sendStructuredMessage
    // only takes the resume path when the manager reports NOT alive (see
    // SessionService.sendStructuredMessage). So kill the live session, THEN seed the
    // external_id, so the next message lazily resumes and backfills 'earlier answer' into the
    // ring BEFORE the live (agentMessage-less) turn runs — the exact trap this test guards against.
    (a as any)._sessionService?.structuredManagerFor('codex')?.kill(id);
    terminalsDb.updateExternalId(db, id, 'thread-existing-9');
    await request(a).post(`/api/terminals/${id}/message`).send({ text: 'no agent message this time' });
    await pollStatus(id, 'waiting');
    const cfg = JSON.parse(terminalsDb.getById(db, id)?.config || '{}');
    expect(cfg.lastOutcome?.summary).toBe(''); // empty, not undefined-and-backfilled
    expect(cfg.lastOutcome?.summary).not.toContain('earlier answer'); // NOT the stale backfill
    expect(cfg.lastOutcome?.needsHelp).toBe(false);
  } finally {
    (a as any)._sessionService?.structuredManagerFor('codex')?.killAll();
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
