// The model a person picks when a thread is created (the OS view sends `config.model` with POST
// /api/sessions/:id/terminals) must reach the harness: Claude Code as `--model`, Codex as `model` on
// thread/start. The box log names both the model asked for and the model the harness reports.
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { setBoxLogForTest } from '../../src/os/box-log.js';
import { modelMatches } from '../../src/structured/model-log.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'structured', 'fake-codex-app-server.mjs');
/** The OS view's create body (box/client.ts createThread). */
const osConfig = (model?: string) => ({ transport: 'structured', approvals: 'smart', ...(model ? { model } : {}) });

class NoPty extends PTYManager {
  override spawn(): number { return 1; }
  override isAlive(): boolean { return false; }
  override kill(): void {}
  override killAll(): void {}
}
class CapturingClaude extends StructuredSessionManager {
  calls: { args: string[]; model?: string }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(_id: string, opts: { command: string; args: string[]; model?: string }): number { this.calls.push({ args: opts.args, model: opts.model }); return 9; }
  override kill(): void {}
}

let sandbox: string; let svc: SessionService; let lines: Record<string, any>[]; let logPath: string;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'model-delivery-'));
  fs.mkdirSync(path.join(sandbox, 'proj'));
  logPath = path.join(sandbox, 'requests.jsonl');
  const db = new Database(':memory:'); initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: path.join(sandbox, 'proj') });
  svc = new SessionService(db, new NoPty(), path.join(sandbox, 'mcp.json'));
  lines = [];
  setBoxLogForTest({ enabled: true, sink: (l) => lines.push(JSON.parse(l)) });
});
afterEach(() => { setBoxLogForTest(); fs.rmSync(sandbox, { recursive: true, force: true }); });

async function until(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const logged = (method: string): any[] => fs.existsSync(logPath)
  ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === method)
  : [];

it('Claude Code: the picked model is the --model of the command, and thread.start names it', () => {
  const m = new CapturingClaude();
  svc.registerStructuredManager('claude-code', m);
  const t = svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, osConfig('sonnet'));
  const args = m.calls[0].args;
  expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  expect(lines.find((l) => l.event === 'thread.start')).toMatchObject({ thread: t.id, harness: 'claude-code', model: 'sonnet' });
});

it('Claude Code with no pick: no --model, and thread.start says null (the CLI default)', () => {
  const m = new CapturingClaude();
  svc.registerStructuredManager('claude-code', m);
  svc.createTerminal('s1', 'claude-code', 'A', false, undefined, undefined, osConfig());
  expect(m.calls[0].args).not.toContain('--model');
  expect(lines.find((l) => l.event === 'thread.start')).toMatchObject({ model: null });
});

it('Codex: the picked model rides thread/start, and thread.model reports what the app-server runs', async () => {
  const real = new CodexStructuredSessionManager();
  svc.registerStructuredManager('codex', real);
  svc.setStructuredCommandOverride({ command: process.execPath, args: [fake] });
  const prev = process.env.CODEX_FAKE_LOG;
  process.env.CODEX_FAKE_LOG = logPath;
  try {
    const t = svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, osConfig('gpt-5.6-terra'));
    await until(() => logged('thread/start').length > 0, 'thread/start');
    expect(logged('thread/start')[0].params.model).toBe('gpt-5.6-terra');
    await until(() => lines.some((l) => l.event === 'thread.model'), 'thread.model');
    expect(lines.find((l) => l.event === 'thread.start')).toMatchObject({ thread: t.id, harness: 'codex', model: 'gpt-5.6-terra' });
    expect(lines.find((l) => l.event === 'thread.model')).toMatchObject({ thread: t.id, harness: 'codex', requested: 'gpt-5.6-terra', reported: 'gpt-5.6-terra', match: true, level: 'info' });
  } finally {
    if (prev === undefined) delete process.env.CODEX_FAKE_LOG; else process.env.CODEX_FAKE_LOG = prev;
    real.killAll();
  }
});

it('modelMatches: an alias matches its family, a context suffix is ignored, no request always matches', () => {
  expect(modelMatches('sonnet', 'claude-sonnet-4-5-20250929')).toBe(true);
  expect(modelMatches('opus', 'claude-sonnet-4-5-20250929')).toBe(false);
  expect(modelMatches('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true);
  expect(modelMatches('gpt-5.6-sol', 'gpt-5.6-terra')).toBe(false);
  expect(modelMatches(null, 'gpt-5.6-sol')).toBe(true);
});

it('F4: the hosted Sol default effort is low, another word is used only when the model takes it, OFF leaves the default', () => {
  const saved = { a: process.env.OS_BASE_URL, b: process.env.OS_BOX_TOKEN, c: process.env.DISPATCH_CODEX_SOL_EFFORT };
  Object.assign(process.env, { OS_BASE_URL: 'https://os.example.com', OS_BOX_TOKEN: 'box-token-for-test' });
  try {
    const effort = (v?: string) => {
      if (v === undefined) delete process.env.DISPATCH_CODEX_SOL_EFFORT; else process.env.DISPATCH_CODEX_SOL_EFFORT = v;
      return (svc as any).codexEffortFor({}, 'gpt-6.1-sol');
    };
    expect(effort()).toBe('low');
    expect(effort('medium')).toBe('medium');
    expect(effort('turbo')).toBeUndefined();
    expect(effort('off')).toBeUndefined();
    expect(effort('0')).toBeUndefined();
    expect((svc as any).codexEffortFor({ effort: 'high' }, 'gpt-6.1-sol')).toBe('high');
  } finally {
    for (const [k, v] of [['OS_BASE_URL', saved.a], ['OS_BOX_TOKEN', saved.b], ['DISPATCH_CODEX_SOL_EFFORT', saved.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

it('the owner\'s default (2026-11-13): a hosted Codex thread with no pick runs gpt-6.1-sol; a pick wins; a local install keeps Codex\'s own default', async () => {
  const { hostedCodexDefaultModel } = await import('../../src/structured/codex-fast.js');
  const { resolveSpawnModel } = await import('../../src/overseer/spawn-model.js');
  const HOSTED = { OS_BASE_URL: 'https://os.example.com', OS_BOX_TOKEN: 'box-token-for-test' };
  expect(hostedCodexDefaultModel({ ...HOSTED }, true)).toBe('gpt-6.1-sol');
  expect(hostedCodexDefaultModel({ DISPATCH_CODEX_DEFAULT_MODEL: 'gpt-6-luna' }, true)).toBe('gpt-6-luna');
  expect(hostedCodexDefaultModel({ DISPATCH_CODEX_DEFAULT_MODEL: 'off' }, true)).toBeUndefined();
  expect(hostedCodexDefaultModel({}, false)).toBeUndefined();
  expect(resolveSpawnModel({ harness: 'codex', config: {}, codexDefault: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol');
  expect(resolveSpawnModel({ harness: 'codex', config: { model: 'gpt-6.1-terra' }, codexDefault: 'gpt-6.1-sol' })).toBe('gpt-6.1-terra');
  expect(resolveSpawnModel({ harness: 'codex', config: {}, codexDefault: 'sonnet' })).toBeUndefined();

  const saved = { a: process.env.OS_BASE_URL, b: process.env.OS_BOX_TOKEN, c: process.env.DISPATCH_PROFILE };
  // A hosted developer box (a business box also needs the standard image's strict harness policy files).
  Object.assign(process.env, HOSTED, { DISPATCH_PROFILE: 'developer' });
  const real = new CodexStructuredSessionManager();
  svc.registerStructuredManager('codex', real);
  svc.setStructuredCommandOverride({ command: process.execPath, args: [fake] });
  const prev = process.env.CODEX_FAKE_LOG;
  process.env.CODEX_FAKE_LOG = logPath;
  try {
    svc.createTerminal('s1', 'codex', 'C', false, undefined, undefined, osConfig());
    await until(() => logged('thread/start').length > 0, 'thread/start');
    expect(logged('thread/start')[0].params.model).toBe('gpt-6.1-sol');
  } finally {
    real.killAll();
    if (prev === undefined) delete process.env.CODEX_FAKE_LOG; else process.env.CODEX_FAKE_LOG = prev;
    for (const [k, v] of [['OS_BASE_URL', saved.a], ['OS_BOX_TOKEN', saved.b], ['DISPATCH_PROFILE', saved.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
