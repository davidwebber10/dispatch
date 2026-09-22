// packages/core/tests/structured/codex-manager.systemprompt.test.ts
//
// A Codex coordinator's persona (system prompt) must reach the model via the app-server's
// TOP-LEVEL, camelCase `developerInstructions` param on `thread/start` — the OpenAI-documented
// `settings.developer_instructions` spelling is silently ignored by codex-cli (verified live on
// codex-cli 0.155.1). `thread/resume` restores an existing thread that already has its
// instructions, so it must NOT carry the field.
//
// Reuses the existing fake-codex-app-server.mjs harness (see codex-manager.test.ts) rather than
// a live `codex` process. The fake is extended (behind an opt-in env var so other tests are
// unaffected) to append every request it receives to a log file, giving the test a way to
// inspect the exact JSON-RPC params the manager sent — the "fake-connection/transport harness"
// referenced in the task brief.
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
  m = new CodexStructuredSessionManager();
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fake-log-')), 'requests.jsonl');
});
afterEach(() => { m.killAll(); });

function readLogged(method: string): any[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.method === method);
}

function waitForEvent(mgr: CodexStructuredSessionManager, id: string, pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const buffered = mgr.getEvents(id).find(pred);
    if (buffered) { resolve(buffered); return; }
    const t = setTimeout(() => { mgr.off('event', on); reject(new Error('timeout')); }, timeoutMs);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); mgr.off('event', on); resolve(e); } };
    mgr.on('event', on);
  });
}

it('sends the persona on thread/start as top-level developerInstructions (not settings.developer_instructions)', async () => {
  m.spawn('t1', {
    command: process.execPath,
    args: [fake],
    workDir: process.cwd(),
    systemPrompt: 'CANARY-PERSONA',
    env: { CODEX_FAKE_LOG: logPath },
  });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');

  const sent = readLogged('thread/start').find((r) => r.params?.developerInstructions === 'CANARY-PERSONA' || r.params);
  expect(sent).toBeDefined();
  expect(sent.params.developerInstructions).toBe('CANARY-PERSONA');
  expect(sent.params.settings?.developer_instructions).toBeUndefined();
});

it('omits developerInstructions from thread/start when no systemPrompt is set', async () => {
  m.spawn('t1', {
    command: process.execPath,
    args: [fake],
    workDir: process.cwd(),
    env: { CODEX_FAKE_LOG: logPath },
  });
  await waitForEvent(m, 't1', (e) => e.type === 'system' && e.subtype === 'init');

  const [sent] = readLogged('thread/start');
  expect(sent).toBeDefined();
  expect(sent.params.developerInstructions).toBeUndefined();
});

it('does NOT carry developerInstructions on thread/resume', async () => {
  m.spawn('t1', {
    command: process.execPath,
    args: [fake],
    workDir: process.cwd(),
    systemPrompt: 'CANARY-PERSONA',
    resumeId: 'thread-existing-9',
    env: { CODEX_FAKE_LOG: logPath },
  });
  await waitForEvent(m, 't1', (e) => e.type === 'assistant' && e.message?.content?.[0]?.text === 'earlier answer');

  const [sent] = readLogged('thread/resume');
  expect(sent).toBeDefined();
  expect(sent.params.developerInstructions).toBeUndefined();
  expect(readLogged('thread/start')).toHaveLength(0);
});
