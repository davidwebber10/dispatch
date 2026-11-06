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
  expect(await m.applySettings('nope', { model: 'gpt-6-luna' })).toEqual({ ok: false, error: 'This thread is not running.' });
});
