// A model or effort picked on a live Codex thread (slash menu, 2026-11-06) rides on the next turn/start.
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
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-log-')), 'requests.jsonl');
});
afterEach(() => { m.killAll(); });

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
const idle = (id: string) => new Promise<void>((res) => { const on = (eid: string) => { if (eid === id) { m.off('idle', on); res(); } }; m.on('idle', on); });

it('applySettings keeps the values; the next turn/start carries them; an unset one stays off the wire', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath } });
  await until(() => m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init'), 'init');

  // First turn: nothing picked, so neither field is sent.
  let done = idle('t1');
  m.sendMessage('t1', 'hello');
  await done;
  expect(logged('turn/start')[0].params).not.toHaveProperty('effort');
  expect(logged('turn/start')[0].params).not.toHaveProperty('model');

  const r = await m.applySettings('t1', { model: 'gpt-6-luna', effort: 'medium' });
  expect(r).toEqual({ ok: true });
  // The status row learns the model at once.
  const inits = m.getEvents('t1').filter((e: any) => e.type === 'system' && e.subtype === 'init');
  expect((inits[inits.length - 1] as any).model).toBe('gpt-6-luna');

  done = idle('t1');
  m.sendMessage('t1', 'hello again');
  await done;
  const second = logged('turn/start')[1].params;
  expect(second.model).toBe('gpt-6-luna');
  expect(second.effort).toBe('medium');

  // An effort-only change keeps the model.
  await m.applySettings('t1', { effort: 'high' });
  done = idle('t1');
  m.sendMessage('t1', 'third');
  await done;
  const third = logged('turn/start')[2].params;
  expect(third.model).toBe('gpt-6-luna');
  expect(third.effort).toBe('high');
});

it('applySettings on a thread that is not running says so', async () => {
  expect(await m.applySettings('nope', { model: 'gpt-6-luna' })).toEqual({ ok: false, error: 'This thread is not running.', stopped: true });
});

it('a start effort (the saved pick after a CLI switch or a restart) rides on the first turn', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), effort: 'max', env: { CODEX_FAKE_LOG: logPath } });
  await until(() => m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init'), 'init');
  const done = idle('t1');
  m.sendMessage('t1', 'hello');
  await done;
  expect(logged('turn/start')[0].params.effort).toBe('max');
});

it('loadModelEfforts reads each model\'s efforts and default effort from the app-server, and caches them', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath } });
  await until(() => m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init'), 'init');
  expect(m.modelEfforts()).toBeNull();
  const map = await m.loadModelEfforts();
  expect(map?.['gpt-6-luna']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(map?.['gpt-6-astra']).toContain('ultra');
  expect(m.modelDefaultEfforts()).toEqual({ 'gpt-6-astra': 'medium', 'gpt-6-luna': 'low' });
  expect(m.currentModel('t1')).toBeTruthy();
  await m.loadModelEfforts();
  expect(logged('model/list')).toHaveLength(1);
  expect(m.modelEfforts()).toEqual(map);
});

it('loadModelEfforts is null when no app-server is running', async () => {
  expect(await m.loadModelEfforts()).toBeNull();
});

it('postNotice puts a line in the thread', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath } });
  await until(() => m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init'), 'init');
  m.postNotice('t1', 'Could not change the effort.');
  expect(m.getEvents('t1').some((e: any) => e.subtype === 'settings_refused' && e.message === 'Could not change the effort.')).toBe(true);
});


// ---- Review round 3 (PR #155) ----

it('loadModelEfforts gives up on an app-server that never answers initialize, instead of waiting for ever', async () => {
  const slow = new CodexStructuredSessionManager({ modelListTimeoutMs: 150 });
  try {
    slow.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_INIT_HANG: '1' } });
    const t0 = Date.now();
    const map = await slow.loadModelEfforts();
    expect(map).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  } finally { slow.killAll(); }
});
