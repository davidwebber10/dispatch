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
  it('the kill switch: off, OFF, empty, 0, false, none, default send none; another id is sent as it is', () => {
    for (const v of ['off', '  OFF ', '', '0', 'false', 'none', 'default']) expect(codexServiceTier('gpt-6.1-sol', () => null, { DISPATCH_CODEX_SERVICE_TIER: v }, true), v).toBeUndefined();
    expect(codexServiceTier('gpt-6.1-sol', () => null, { DISPATCH_CODEX_SERVICE_TIER: 'ultrafast' }, true)).toBe('ultrafast');
  });
  it('a hosted Sol thread with no pick runs at low (or DISPATCH_CODEX_SOL_EFFORT); other models and local installs keep their default', () => {
    expect(codexDefaultEffort('gpt-6.1-sol', {}, true)).toBe('low');
    expect(codexDefaultEffort('gpt-6.1-sol', { DISPATCH_CODEX_SOL_EFFORT: 'medium' }, true)).toBe('medium');
    // F4: the same OFF values leave Codex's own default; a value that is not a word is no default.
    for (const v of ['off', '', '0', 'false', 'default', 'none']) expect(codexDefaultEffort('gpt-6.1-sol', { DISPATCH_CODEX_SOL_EFFORT: v }, true), v).toBeUndefined();
    expect(codexDefaultEffort('gpt-6.1-sol', { DISPATCH_CODEX_SOL_EFFORT: 'lo w' }, true)).toBeUndefined();
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

  it('thread/start carries serviceTier priority, and the box log names the tier the app-server REPORTS', async () => {
    await start();
    expect(logged('thread/start')[0].params).toMatchObject({ model: 'gpt-6.1-sol', serviceTier: 'priority' });
    expect(lines.find((l) => l.event === 'thread.model')).toMatchObject({ harness: 'codex', serviceTier: 'priority', serviceTierAsked: 'priority' });
  });

  it('a tier the account does not offer is dropped by Codex without an error: logged as refused, reported null', async () => {
    await start({ CODEX_FAKE_NO_TIER: '1' });
    expect(lines.find((l) => l.event === 'thread.fast.refused')).toMatchObject({ level: 'warn', tier: 'priority', reported: null });
    expect(lines.find((l) => l.event === 'thread.model')).toMatchObject({ serviceTier: null, serviceTierAsked: 'priority' });
  });

  it('an answer with no tier field is not a refusal (thread.fast.unreported, info)', async () => {
    await start({ CODEX_FAKE_OMIT_TIER: '1' });
    await until(() => lines.some((l) => l.event === 'thread.fast.unreported'), 'thread.fast.unreported');
    expect(lines.some((l) => l.event === 'thread.fast.refused')).toBe(false);
    expect(lines.find((l) => l.event === 'thread.fast.unreported')).toMatchObject({ level: 'info', tier: 'priority' });
  });

  it('the box log names the tiers the account offers per model (codex.tiers), read before the first start', async () => {
    await start();
    expect(lines.find((l) => l.event === 'codex.tiers')).toMatchObject({ level: 'info', tiers: { 'gpt-6.1-sol': ['priority'] } });
  });

  it('an account whose model/list offers no fast tier for the model: the tier is not asked for, and nothing is refused', async () => {
    await start({ CODEX_FAKE_NO_FAST_TIER: '1' });
    expect(logged('model/list').length).toBeGreaterThan(0);
    expect(logged('thread/start')[0].params).not.toHaveProperty('serviceTier');
    expect(lines.some((l) => l.event === 'thread.fast.refused')).toBe(false);
  });

  it('a tier Codex drops for a model the account offers it for: refused, with the plain reason', async () => {
    await start({ CODEX_FAKE_NO_TIER: '1' });
    expect(lines.find((l) => l.event === 'thread.fast.refused')).toMatchObject({ tier: 'priority', reported: null, reason: 'Codex did not apply the tier' });
  });

  it('F2: switched off, a RESUMED thread asks for the standard tier explicitly (an omitted field keeps a saved priority)', async () => {
    process.env.DISPATCH_CODEX_SERVICE_TIER = 'off';
    m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), model: 'gpt-6.1-sol', resumeId: 'cx-thread-1', env: { CODEX_FAKE_LOG: logPath, CODEX_FAKE_SAVED_TIER: 'priority' } });
    await until(() => lines.some((l) => l.event === 'thread.model'), 'thread.model');
    expect(logged('thread/resume')[0].params.serviceTier).toBe('default');
    expect(lines.find((l) => l.event === 'thread.model')).toMatchObject({ serviceTier: 'default', serviceTierAsked: 'default' });
  });

  it('N5: a resume refused at the standard tier gets one more try with no tier field, so the thread still starts', async () => {
    process.env.DISPATCH_CODEX_SERVICE_TIER = 'off';
    m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), model: 'gpt-6.1-sol', resumeId: 'cx-thread-1', env: { CODEX_FAKE_LOG: logPath, CODEX_FAKE_REJECT_DEFAULT_TIER: '1' } });
    await until(() => lines.some((l) => l.event === 'thread.model'), 'thread.model');
    const resumes = logged('thread/resume');
    expect(resumes).toHaveLength(2);
    expect(resumes[0].params.serviceTier).toBe('default');
    expect(resumes[1].params).not.toHaveProperty('serviceTier');
    expect(lines.find((l) => l.event === 'thread.fast.refused')).toMatchObject({ tier: 'default' });
    expect(m.getEvents('t1').some((e: any) => e.subtype === 'spawn_error')).toBe(false);
  });

  it('switched on, a resume asks for priority again', async () => {
    m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), model: 'gpt-6.1-sol', resumeId: 'cx-thread-1', env: { CODEX_FAKE_LOG: logPath } });
    await until(() => lines.some((l) => l.event === 'thread.model'), 'thread.model');
    expect(logged('thread/resume')[0].params.serviceTier).toBe('priority');
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
    expect(lines.find((l) => l.event === 'thread.fast.refused')).toMatchObject({ level: 'warn', tier: 'priority', reason: 'request rejected' });
    expect(m.getEvents('t1').some((e: any) => e.subtype === 'spawn_error')).toBe(false);
  });
});
