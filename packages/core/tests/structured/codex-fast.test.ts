// Codex fast mode on a hosted box: the fast tier on every thread/start, Sol at low effort, a fleet-wide
// kill switch in the environment, and a refused tier that falls back to standard speed.
import { it, expect, describe, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { codexServiceTier, codexDefaultEffort, CODEX_FAST_TIER } from '../../src/structured/codex-fast.js';
import { setBoxLogForTest } from '../../src/os/box-log.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-app-server.mjs');
const HOSTED = { OS_BASE_URL: 'https://os.example.com', OS_BOX_TOKEN: 'box-token-for-test' };

describe('codexServiceTier / codexDefaultEffort', () => {
  it('hosted: the fast tier (priority) for any model that offers it; a local install asks for none', () => {
    expect(codexServiceTier('gpt-6.1-sol', () => null, {}, true)).toBe(CODEX_FAST_TIER);
    expect(codexServiceTier(undefined, () => null, {}, true)).toBe('priority');
    expect(codexServiceTier('gpt-6.1-sol', () => ['priority', 'ultrafast'], {}, true)).toBe('priority');
    expect(codexServiceTier('gpt-x', () => [], {}, true)).toBeUndefined();
    expect(codexServiceTier('gpt-6.1-sol', () => null, {}, false)).toBeUndefined();
  });
  it('the kill switch: DISPATCH_CODEX_SERVICE_TIER=off (or empty) sends none; another id is sent as it is', () => {
    expect(codexServiceTier('gpt-6.1-sol', () => null, { DISPATCH_CODEX_SERVICE_TIER: 'off' }, true)).toBeUndefined();
    expect(codexServiceTier('gpt-6.1-sol', () => null, { DISPATCH_CODEX_SERVICE_TIER: '' }, true)).toBeUndefined();
    expect(codexServiceTier('gpt-6.1-sol', () => null, { DISPATCH_CODEX_SERVICE_TIER: 'ultrafast' }, true)).toBe('ultrafast');
  });
  it('a hosted Sol thread with no pick runs at low (or DISPATCH_CODEX_SOL_EFFORT); other models and local installs keep their default', () => {
    expect(codexDefaultEffort('gpt-6.1-sol', {}, true)).toBe('low');
    expect(codexDefaultEffort('gpt-6.1-sol', { DISPATCH_CODEX_SOL_EFFORT: 'medium' }, true)).toBe('medium');
    expect(codexDefaultEffort('gpt-6.1-terra', {}, true)).toBeUndefined();
    expect(codexDefaultEffort('gpt-6.1-sol', {}, false)).toBeUndefined();
  });
});

describe('the Codex manager on a hosted box', () => {
  let m: CodexStructuredSessionManager; let logPath: string; let lines: Record<string, any>[]; const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [...Object.keys(HOSTED), 'DISPATCH_CODEX_SERVICE_TIER']) saved[k] = process.env[k];
    Object.assign(process.env, HOSTED);
    delete process.env.DISPATCH_CODEX_SERVICE_TIER;
    m = new CodexStructuredSessionManager();
    logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fast-')), 'requests.jsonl');
    lines = [];
    setBoxLogForTest({ enabled: true, sink: (l) => lines.push(JSON.parse(l)) });
  });
  afterEach(() => {
    m.killAll();
    setBoxLogForTest();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const logged = (method: string): any[] => fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === method) : [];
  async function until(pred: () => boolean, what: string): Promise<void> {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > 5000) throw new Error(`timeout waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
  }
  const start = (env: Record<string, string> = {}) => {
    m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), model: 'gpt-6.1-sol', env: { CODEX_FAKE_LOG: logPath, ...env } });
    return until(() => m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init'), 'init');
  };

  it('thread/start carries serviceTier priority, and the box log names it', async () => {
    await start();
    expect(logged('thread/start')[0].params).toMatchObject({ model: 'gpt-6.1-sol', serviceTier: 'priority' });
    expect(lines.find((l) => l.event === 'thread.model')).toMatchObject({ harness: 'codex', serviceTier: 'priority' });
  });

  it('with the kill switch off, no tier is sent', async () => {
    process.env.DISPATCH_CODEX_SERVICE_TIER = 'off';
    await start();
    expect(logged('thread/start')[0].params).not.toHaveProperty('serviceTier');
  });

  it('a refused tier: the thread starts again at standard speed, and the log warns', async () => {
    await start({ CODEX_FAKE_REJECT_TIER: '1' });
    const starts = logged('thread/start');
    expect(starts).toHaveLength(2);
    expect(starts[0].params.serviceTier).toBe('priority');
    expect(starts[1].params).not.toHaveProperty('serviceTier');
    expect(lines.find((l) => l.event === 'thread.fast.refused')).toMatchObject({ level: 'warn', tier: 'priority' });
    expect(m.getEvents('t1').some((e: any) => e.subtype === 'spawn_error')).toBe(false);
  });
});
