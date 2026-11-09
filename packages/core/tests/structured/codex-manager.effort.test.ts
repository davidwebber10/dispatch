// The effort picker on a live Codex thread (slash menu): the effort rides on EVERY turn/start, the efforts each model
// takes come from the app-server's model/list, and a silent app-server cannot hold a caller for ever.
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
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-log-')), 'requests.jsonl');
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
const start = async (opts: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath, ...env }, ...opts });
  await until(() => m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init'), 'init');
};
const turn = async (text: string) => { const done = idle('t1'); m.sendMessage('t1', text); await done; };

it('setEffort: every turn/start carries the picked effort; before a pick none is sent', async () => {
  await start();
  await turn('one');
  expect(logged('turn/start')[0].params).not.toHaveProperty('effort');
  await m.setEffort('t1', 'high');
  await turn('two');
  await turn('three');
  expect(logged('turn/start')[1].params.effort).toBe('high');
  expect(logged('turn/start')[2].params.effort).toBe('high'); // sent again: a resume forgets it (live check, codex-cli 0.166)
});

it('a model switch and its default effort ride together on the next turn', async () => {
  await start({ effort: 'ultra' });
  await m.setModel('t1', 'gpt-6-luna');
  await m.setEffort('t1', 'medium');
  await turn('hello');
  const p = logged('turn/start')[0].params;
  expect(p.model).toBe('gpt-6-luna');
  expect(p.effort).toBe('medium'); // never the old ultra
});

it('a start effort (the saved pick after a CLI switch or a restart) rides on the first turn', async () => {
  await start({ effort: 'max' });
  await turn('hello');
  expect(logged('turn/start')[0].params.effort).toBe('max');
});

it('setEffort on a thread that is not running says so', async () => {
  await expect(m.setEffort('nope', 'high')).rejects.toThrow(/not running/);
});

it('loadModelEfforts reads each model\'s efforts and default effort from the app-server, and caches them', async () => {
  await start();
  expect(m.modelEfforts()).toBeNull();
  const map = await m.loadModelEfforts();
  expect(map?.['gpt-6-luna']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(map?.['gpt-6-astra']).toContain('ultra');
  expect(m.modelDefaultEfforts()).toEqual({ 'gpt-6-astra': 'medium', 'gpt-6-luna': 'low' });
  await m.loadModelEfforts();
  expect(logged('model/list')).toHaveLength(1);
});

it('loadModelEfforts is null when no app-server is running', async () => {
  expect(await m.loadModelEfforts()).toBeNull();
});

it('loadModelEfforts gives up on an app-server that never answers initialize, instead of waiting for ever (round 3 item 2)', async () => {
  const slow = new CodexStructuredSessionManager({ modelListTimeoutMs: 150 });
  try {
    slow.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_INIT_HANG: '1' } });
    const t0 = Date.now();
    expect(await slow.loadModelEfforts()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  } finally { slow.killAll(); }
});

it('postNotice puts a line in the thread', async () => {
  await start();
  m.postNotice('t1', 'Could not change the effort: nope');
  expect(m.getEvents('t1').some((e: any) => e.subtype === 'settings_refused' && e.message === 'Could not change the effort: nope')).toBe(true);
});
