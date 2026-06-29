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
    const t = setTimeout(() => { m.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); m.off('event', on); resolve(e); } };
    m.on('event', on);
  });
}

function waitForPermission(m: StructuredSessionManager, id: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { m.off('permission', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, p: any) => { if (eid === id) { clearTimeout(t); m.off('permission', on); resolve(p); } };
    m.on('permission', on);
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
