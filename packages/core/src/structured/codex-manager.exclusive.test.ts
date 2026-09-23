// packages/core/src/structured/codex-manager.exclusive.test.ts
//
// M3 BLOCK (independent review of PR #47, finding N5). Every Codex thread shares ONE app-server
// child, and that child's argv/env — which carry the per-thread `dispatch` MCP identity
// (DISPATCH_TERMINAL / DISPATCH_SESSION / DISPATCH_SPAWN_DEPTH) — belong to whichever thread
// spawned it first. Until per-thread MCP identity lands (the M3 follow-up), a Codex COORDINATOR
// must never share that child: its spawn_agent / report_status would act as another thread, or
// another thread would act as the coordinator. `exclusiveConnection` enforces that both ways.
import { it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from './codex-manager.js';

const fake = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'tests', 'structured', 'fake-codex-app-server.mjs',
);
const spawnFake = (m: CodexStructuredSessionManager, id: string, opts: any = {}) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), ...opts });

let m: CodexStructuredSessionManager;
beforeEach(() => { m = new CodexStructuredSessionManager(); });
afterEach(() => { m.killAll(); });

it('refuses an exclusive (coordinator) spawn while another Codex thread is live, and leaves that thread alone', () => {
  spawnFake(m, 'worker');
  expect(() => spawnFake(m, 'coord', { exclusiveConnection: true })).toThrow(/M3|share/i);
  expect(m.isAlive('worker')).toBe(true);
  expect(m.isAlive('coord')).toBe(false);
});

it('refuses any other Codex spawn while an exclusive thread is live', () => {
  spawnFake(m, 'coord', { exclusiveConnection: true });
  expect(() => spawnFake(m, 'worker')).toThrow(/M3|share/i);
  expect(() => spawnFake(m, 'coord2', { exclusiveConnection: true })).toThrow(/M3|share/i);
  expect(m.isAlive('coord')).toBe(true);
  expect(m.isAlive('worker')).toBe(false);
});

it('lets an exclusive thread re-spawn ITSELF (relaunch / resume)', () => {
  spawnFake(m, 'coord', { exclusiveConnection: true });
  expect(() => spawnFake(m, 'coord', { exclusiveConnection: true, resumeId: 'thread-fake-1' })).not.toThrow();
  expect(m.isAlive('coord')).toBe(true);
});

it('after the exclusive thread exits, the next thread gets a FRESH app-server (never the coordinator\'s identity)', () => {
  const coordPid = spawnFake(m, 'coord', { exclusiveConnection: true, env: { DISPATCH_TERMINAL: 'coord' } });
  m.kill('coord');
  const workerPid = spawnFake(m, 'worker', { env: { DISPATCH_TERMINAL: 'worker' } });
  expect(workerPid).not.toBe(coordPid);
});
