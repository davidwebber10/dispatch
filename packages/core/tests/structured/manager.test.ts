// packages/core/tests/structured/manager.test.ts
import { it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StructuredSessionManager } from '../../src/structured/manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const spawnFake = (m: StructuredSessionManager, id: string) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd() });

function waitForEvent(m: StructuredSessionManager, id: string, pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { m.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); m.off('event', on); resolve(e); } };
    m.on('event', on);
  });
}

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

it('auto-allows can_use_tool control_requests (parity)', async () => {
  spawnFake(m, 't1');
  await waitForEvent(m, 't1', (e) => e.type === 'system');
  m.sendMessage('t1', 'TRIGGER_PERMISSION');
  const result = await waitForEvent(m, 't1', (e) => e.type === 'user' && JSON.stringify(e).includes('WROTE'));
  expect(JSON.stringify(result)).toContain('WROTE'); // allowed, not DENIED
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
