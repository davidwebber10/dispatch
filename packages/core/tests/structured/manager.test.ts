// packages/core/tests/structured/manager.test.ts
import { it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StructuredSessionManager } from '../../src/structured/manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const spawnFake = (m: StructuredSessionManager, id: string) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd() });

function waitForEvent(m: StructuredSessionManager, id: string, pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    // Check the already-buffered ring first: an event can fire before this listener
    // attaches (the child emits its init line almost immediately after spawn), so a
    // pure live-listener would miss it and hang.
    const buffered = m.getEvents(id).find(pred);
    if (buffered) { resolve(buffered); return; }
    const t = setTimeout(() => { m.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); m.off('event', on); resolve(e); } };
    m.on('event', on);
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timeout');
}

function waitForPermission(m: StructuredSessionManager, id: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { m.off('permission', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, p: any) => { if (eid === id) { clearTimeout(t); m.off('permission', on); resolve(p); } };
    m.on('permission', on);
  });
}

/** Waits for the manager's own (terminalId, ...rest) emit — 'scheduled'/'idle' — for `id`. */
function waitForManagerEvent(m: StructuredSessionManager, event: string, id: string, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { m.off(event, on); reject(new Error(`timeout waiting for '${event}'`)); }, timeoutMs);
    const on = (eid: string, ...rest: any[]) => { if (eid === id) { clearTimeout(t); m.off(event, on); resolve(rest); } };
    m.on(event, on);
  });
}

const spawnFakeEscalate = (m: StructuredSessionManager, id: string) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), escalate: true });

let m: StructuredSessionManager;
beforeEach(() => { m = new StructuredSessionManager(); });
afterEach(() => { m.kill('t1'); m.kill('t2'); });

it('spawns, emits parsed events, and buffers them', async () => {
  spawnFake(m, 't1');
  const init = await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  expect(init.apiKeySource).toBe('none');
  expect(m.isAlive('t1')).toBe(true);
  expect(m.getEvents('t1').some((e: any) => e.type === 'system')).toBe(true);
});

it('sendMessage writes a user turn and assistant events come back', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  m.sendMessage('t1', 'hello');
  const a = await waitForEvent(m, 't1', (e) => e.type === 'assistant');
  expect(JSON.stringify(a)).toContain('echo:hello');
});

it("emits 'message-source' with the tagged source once the turn's result lands (durable-persist trigger)", async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const sourceP = waitForManagerEvent(m, 'message-source', 't1');
  m.sendMessage('t1', 'hello', 'coordinator');
  const [source] = await sourceP;
  expect(source).toBe('coordinator');
});

it("does NOT emit 'message-source' for an untagged send", async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  let emitted = false;
  const on = (eid: string) => { if (eid === 't1') emitted = true; };
  m.on('message-source', on);
  m.sendMessage('t1', 'hello'); // no source
  await waitForEvent(m, 't1', (e) => e.type === 'result');
  await new Promise((r) => setTimeout(r, 50)); // give a stray emit a chance to land
  m.off('message-source', on);
  expect(emitted).toBe(false);
});

it("a later untagged send does not leak a PRIOR turn's source onto the next result", async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const firstSourceP = waitForManagerEvent(m, 'message-source', 't1');
  m.sendMessage('t1', 'hello', 'coordinator');
  await firstSourceP;

  const resultsBefore = m.getEvents('t1').filter((e: any) => e.type === 'result').length;
  let emitted = false;
  const on = (eid: string) => { if (eid === 't1') emitted = true; };
  m.on('message-source', on);
  m.sendMessage('t1', 'a plain follow-up'); // untagged — must clear the pending tag
  await waitFor(() => m.getEvents('t1').filter((e: any) => e.type === 'result').length > resultsBefore);
  await new Promise((r) => setTimeout(r, 50)); // give a stray emit a chance to land after the 2nd result
  m.off('message-source', on);
  expect(emitted).toBe(false);
});

it('sendMessage buffers + emits a synthetic user event for reconnect replay (P0a)', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  // The synthetic user echo is emitted synchronously from sendMessage.
  const echoed = waitForEvent(m, 't1', (e) => e.type === 'user' && Array.isArray(e.message?.content) && e.message.content[0]?.text === 'hello');
  m.sendMessage('t1', 'hello');
  await echoed;
  // …and it lives in the ring so a fresh ws connection replays it.
  const buffered = m.getEvents('t1').find((e: any) => e.type === 'user' && e.message?.content?.[0]?.text === 'hello');
  expect(buffered).toBeTruthy();
});

it('auto-allows can_use_tool control_requests (parity)', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  const result = await waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('WROTE'));
  expect(JSON.stringify(result)).toContain('WROTE'); // allowed, not DENIED
});

it('escalate=true surfaces a gated tool (pending + permission emit) instead of auto-allowing', async () => {
  spawnFakeEscalate(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const pendingP = waitForPermission(m, 't1');
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  const pending = await pendingP;
  expect(pending).toMatchObject({ requestId: 'req-1', toolName: 'Write', toolUseId: 'tu-1' });
  expect(m.getPending('t1')).toMatchObject({ requestId: 'req-1', toolName: 'Write' });
  // No auto-allow: the fake only emits its WROTE/DENIED tool_result AFTER a
  // control_response, so within a short window we must NOT see one.
  let sawResult = false;
  const on = (eid: string, e: any) => { if (eid === 't1' && /WROTE|DENIED/.test(JSON.stringify(e))) sawResult = true; };
  m.on('event', on);
  await new Promise((r) => setTimeout(r, 150));
  m.off('event', on);
  expect(sawResult).toBe(false);
});

it('answerPermission allow writes the control_response with updatedInput (answers map) and clears pending', async () => {
  spawnFakeEscalate(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const pendingP = waitForPermission(m, 't1');
  m.sendMessage('t1', 'TRIGGER_QUESTION');
  const pending = await pendingP;
  expect(pending.questions?.[0]?.question).toBe('Pick one'); // AskUserQuestion shape
  const resolved = waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('WROTE'));
  const ok = m.answerPermission('t1', pending.requestId, {
    behavior: 'allow',
    updatedInput: { questions: pending.questions, answers: { 'Pick one': 'A' } },
  });
  expect(ok).toBe(true);
  const ev = await resolved;
  const tr = ev.message.content[0];
  expect(tr.updatedInput.answers).toEqual({ 'Pick one': 'A' });
  expect(tr.updatedInput.questions[0].question).toBe('Pick one');
  expect(m.getPending('t1')).toBeNull(); // cleared after answering
});

it('answerPermission deny writes a deny control_response with a message', async () => {
  spawnFakeEscalate(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const pendingP = waitForPermission(m, 't1');
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  const pending = await pendingP;
  const resolved = waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('DENIED'));
  expect(m.answerPermission('t1', pending.requestId, { behavior: 'deny', message: 'nope' })).toBe(true);
  const ev = await resolved;
  expect(ev.message.content[0].message).toBe('nope');
  expect(m.getPending('t1')).toBeNull();
});

it('answerPermission returns false when nothing is pending', async () => {
  spawnFakeEscalate(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  expect(m.answerPermission('t1', 'whatever', { behavior: 'allow' })).toBe(false);
});

it('escalate defaults to false: still auto-allows (parity)', async () => {
  spawnFake(m, 't1'); // no escalate flag
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  let emitted = false;
  m.on('permission', () => { emitted = true; });
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  const result = await waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('WROTE'));
  expect(JSON.stringify(result)).toContain('WROTE'); // auto-allowed
  expect(emitted).toBe(false); // no escalation
  expect(m.getPending('t1')).toBeNull();
});

it('setEscalate(false) auto-allows a currently-pending request and future ones (autonomy dial)', async () => {
  spawnFakeEscalate(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  // A gated tool is surfaced (supervised) and blocks on the membrane.
  const pendingP = waitForPermission(m, 't1');
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  await pendingP;
  expect(m.getPending('t1')).toBeTruthy();

  // Flip to autonomous: the in-flight request resolves with allow immediately.
  const wrote = waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('WROTE'));
  expect(m.setEscalate('t1', false)).toBe(true);
  await wrote;
  expect(m.getPending('t1')).toBeNull();

  // Future gated tools auto-allow too — never go pending.
  const before = m.getEvents('t1').length;
  let escalated = false;
  const onPerm = () => { escalated = true; };
  m.on('permission', onPerm);
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  await waitFor(() => m.getEvents('t1').slice(before).some((e: any) => JSON.stringify(e).includes('WROTE')));
  m.off('permission', onPerm);
  expect(escalated).toBe(false);
  expect(m.getPending('t1')).toBeNull();
});

it('interrupt sends the interrupt control frame on stdin (graceful — process stays alive)', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  const echoed = waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'control_request_received');
  expect(m.interrupt('t1')).toBe(true);
  const ev = await echoed;
  expect(ev.request.subtype).toBe('interrupt'); // {type:'control_request', request:{subtype:'interrupt'}}
  expect(typeof ev.request_id).toBe('string');
  expect(m.isAlive('t1')).toBe(true); // NOT killed
});

it('interrupt / setEscalate return false when there is no live session', () => {
  expect(m.interrupt('nope')).toBe(false);
  expect(m.setEscalate('nope', false)).toBe(false);
});

it('setDefaultEnv: env vars reach child process', async () => {
  m.setDefaultEnv({ DISPATCH_TEST_ENV: 'xyz' });
  spawnFake(m, 't1');
  const init = await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  expect(init.testEnv).toBe('xyz');
});

it('killAll: terminates all active sessions', async () => {
  spawnFake(m, 't1');
  spawnFake(m, 't2');
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  await waitForEvent(m, 't2', (e) => e.type === 'system' && e.subtype === 'init');
  m.killAll();
  expect(m.isAlive('t1')).toBe(false);
  expect(m.isAlive('t2')).toBe(false);
});

it("captures the init session_id: emits 'session' and exposes getSessionId", async () => {
  const sessionP = new Promise<string>((resolve) => m.once('session', (_id: string, sid: string) => resolve(sid)));
  spawnFake(m, 't1');
  const sid = await sessionP;
  expect(sid).toBe('sess-fake'); // from fake-claude's init event
  expect(m.getSessionId('t1')).toBe('sess-fake');
});

it('seedEvents: prior history is pushed into the ring and replays via getEvents', async () => {
  const history = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } },
  ];
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });
  // The seeded history is at the FRONT of the ring, before any live init event.
  const ev = m.getEvents('t1');
  expect(ev[0]).toMatchObject({ type: 'user' });
  expect(JSON.stringify(ev[0])).toContain('old prompt');
  expect(JSON.stringify(ev[1])).toContain('old reply');
  // …and live events still land after the backfill.
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');
  expect(m.getEvents('t1').some((e: any) => e.type === 'system')).toBe(true);
});

it('getEventsTail returns only the last N ring events, preserving order', async () => {
  const history = Array.from({ length: 50 }, (_, i) => ({ type: 'user', message: { content: [{ type: 'text', text: `msg-${i}` }] } }));
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });

  const tail = m.getEventsTail('t1', 10);
  expect(tail).toHaveLength(10);
  expect(JSON.stringify(tail[0])).toContain('msg-40');
  expect(JSON.stringify(tail[9])).toContain('msg-49');

  // Full history matches getEvents() when n exceeds the ring size.
  expect(m.getEventsTail('t1', 10_000)).toEqual(m.getEvents('t1'));
});

it("emits 'scheduled' (not 'idle') when the turn's last tool call was ScheduleWakeup, carrying its `reason` as the activity", async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const scheduledP = waitForManagerEvent(m, 'scheduled', 't1');
  let sawIdle = false;
  const onIdle = (eid: string) => { if (eid === 't1') sawIdle = true; };
  m.on('idle', onIdle);
  m.sendMessage('t1', 'TRIGGER_SCHEDULE');
  const [activity] = await scheduledP;
  expect(activity).toContain('watching CI run');
  m.off('idle', onIdle);
  expect(sawIdle).toBe(false); // the agent hasn't finished — must not settle as idle
});

it("emits 'scheduled' for CronCreate too, falling back to its cron expression (no `reason` field on that tool)", async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const scheduledP = waitForManagerEvent(m, 'scheduled', 't1');
  m.sendMessage('t1', 'TRIGGER_CRON');
  const [activity] = await scheduledP;
  expect(activity).toContain('*/5 * * * *');
});

it("still emits 'idle' (not 'scheduled') for an ordinary turn with no tool calls", async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const idleP = waitForManagerEvent(m, 'idle', 't1');
  let sawScheduled = false;
  const onScheduled = (eid: string) => { if (eid === 't1') sawScheduled = true; };
  m.on('scheduled', onScheduled);
  m.sendMessage('t1', 'hello');
  await idleP;
  m.off('scheduled', onScheduled);
  expect(sawScheduled).toBe(false);
});

it('resets the wake-tool memo after each turn: ScheduleWakeup then a plain turn ends the SECOND one on idle, not a stale scheduled', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  const firstScheduled = waitForManagerEvent(m, 'scheduled', 't1');
  m.sendMessage('t1', 'TRIGGER_SCHEDULE');
  await firstScheduled;
  const idleP = waitForManagerEvent(m, 'idle', 't1');
  m.sendMessage('t1', 'hello'); // a fresh turn with no tool call — must NOT reuse the prior memo
  await idleP;
});

it('re-spawn: old child exit does not evict the replacement session (Fix 1 regression)', async () => {
  // First spawn — wait for init so the child is running
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');

  // Re-spawn the same id: kill() is called inside spawn(), then a new child is inserted
  spawnFake(m, 't1');

  // Give the OLD child's 'exit' event time to fire (it was killed, so it exits quickly)
  await new Promise((r) => setTimeout(r, 200));

  // The new (replacement) session must still be alive — the stale exit handler must
  // not have deleted it from the map
  expect(m.isAlive('t1')).toBe(true);
});
