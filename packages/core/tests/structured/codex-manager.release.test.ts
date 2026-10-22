// packages/core/tests/structured/codex-manager.release.test.ts
//
// A killed Codex thread must be RELEASED on the shared app-server (thread/unsubscribe), or the
// app-server keeps the thread loaded and its whole MCP tool set (~8 processes, ~0.8 GB) running
// until the daemon restarts. Live-verified on codex-cli 0.163.0 (scripts/codex-release-probe.mjs):
// thread/unsubscribe alone leaves the MCP children up until thread_unload_delay_secs elapses.
// Hermetic: the fake app-server logs every request it receives (CODEX_FAKE_LOG).
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-app-server.mjs');

let m: CodexStructuredSessionManager;
let logPath: string;

beforeEach(() => {
  m = new CodexStructuredSessionManager({ releaseTimeoutMs: 100 });
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-log-')), 'requests.jsonl');
});
afterEach(() => { m.killAll(); });

const spawnFake = (id: string, opts: any = {}) =>
  m.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), ...opts, env: { CODEX_FAKE_LOG: logPath, ...(opts.env ?? {}) } });

const logged = (method: string): any[] => fs.existsSync(logPath)
  ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === method)
  : [];

async function until(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const bound = (id: string) => until(() => !!m.getSessionId(id), `${id} bound`);

it('kill releases the killed thread, and only that one', async () => {
  spawnFake('a', { resumeId: 'thread-a' });
  spawnFake('b', { resumeId: 'thread-b' });
  await bound('a'); await bound('b');
  m.kill('a');
  await until(() => logged('thread/unsubscribe').length === 1, 'unsubscribe');
  expect(logged('thread/unsubscribe')[0].params).toEqual({ threadId: 'thread-a' });
  await new Promise((r) => setTimeout(r, 150));
  expect(logged('thread/unsubscribe')).toHaveLength(1); // thread-b is still live: untouched
});

it('killAll ends every session and closes the shared app-server (that frees all MCP sets at once)', async () => {
  const pid = spawnFake('a', { resumeId: 'thread-a' });
  spawnFake('b', { resumeId: 'thread-b' });
  await bound('a'); await bound('b');
  m.killAll();
  expect(m.isAlive('a')).toBe(false);
  expect(m.isAlive('b')).toBe(false);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'app-server exit');
});

it('a thread killed before its start finished is released once the app-server answers', async () => {
  spawnFake('keep', { resumeId: 'thread-keep' });
  await bound('keep');
  spawnFake('a'); // fresh start: the fake assigns thread-fake-1
  m.kill('a'); // threadId not known yet
  await until(() => logged('thread/unsubscribe').some((e) => e.params.threadId === 'thread-fake-1'), 'late unsubscribe');
  expect(m.getSessionId('a')).toBeUndefined();
});

it('kill is synchronous and swallows an unsubscribe that hangs or errors', async () => {
  for (const mode of ['hang', 'error']) {
    const mgr = new CodexStructuredSessionManager({ releaseTimeoutMs: 50 });
    const lp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-log-')), 'r.jsonl');
    const sp = (id: string, resumeId: string) => mgr.spawn(id, { command: process.execPath, args: [fake], workDir: process.cwd(), resumeId, env: { CODEX_FAKE_LOG: lp, CODEX_FAKE_UNSUB: mode } });
    sp('a', 'thread-a'); sp('b', 'thread-b');
    await until(() => !!mgr.getSessionId('a') && !!mgr.getSessionId('b'), 'bound');
    const exited: string[] = [];
    mgr.on('exit', (id: string) => exited.push(id));
    mgr.kill('a');
    expect(exited).toEqual(['a']); // did not wait for the app-server
    await new Promise((r) => setTimeout(r, 150)); // the timeout/rejection path runs; nothing throws
    expect(mgr.isAlive('b')).toBe(true);
    mgr.killAll();
  }
});

it('crash recovery resumes the live threads and skips the killed one', async () => {
  const pid = spawnFake('a', { resumeId: 'thread-a' });
  spawnFake('b', { resumeId: 'thread-b' });
  await bound('a'); await bound('b');
  m.kill('a');
  expect(logged('thread/resume').map((e) => e.params.threadId).sort()).toEqual(['thread-a', 'thread-b']);
  process.kill(pid, 'SIGKILL'); // the shared app-server dies
  await until(() => logged('thread/resume').length >= 3, 'recovery resume');
  await new Promise((r) => setTimeout(r, 200));
  const resumes = logged('thread/resume').map((e) => e.params.threadId);
  expect(resumes.filter((t) => t === 'thread-b')).toHaveLength(2);
  expect(resumes.filter((t) => t === 'thread-a')).toHaveLength(1); // never resumed again
});

it('respawning a terminal onto the same thread releases then resumes, and the new session stays live', async () => {
  spawnFake('keep', { resumeId: 'thread-keep' });
  spawnFake('a', { resumeId: 'thread-a' });
  await bound('keep'); await bound('a');
  spawnFake('a', { resumeId: 'thread-a' }); // revive: spawn() kills the old session first
  await until(() => logged('thread/resume').filter((e) => e.params.threadId === 'thread-a').length === 2, 'second resume');
  const order = [...logged('thread/unsubscribe'), ...logged('thread/resume').slice(2)];
  expect(order[0].params.threadId).toBe('thread-a');
  expect(logged('thread/unsubscribe')).toHaveLength(1); // the new session is not released by the old one's tail
  expect(m.isAlive('a')).toBe(true);
});
