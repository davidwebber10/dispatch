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
  expect(m.modelDefaultEfforts()).toEqual({ 'gpt-6-astra': 'medium', 'gpt-6-luna': 'low', 'gpt-6.1-sol': 'low' });
  // The service tiers the account has per model come from the same list.
  expect(m.modelServiceTiers()?.['gpt-6.1-sol']).toEqual(['priority']);
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

// ---- Round 4: a refusal that comes late, on the turn that first carries the pick ----
const failed = (id: string) => new Promise<void>((res) => { const on = (eid: string) => { if (eid === id) { m.off('failed', on); res(); } }; m.on('failed', on); });
const refusals = (): any[] => { const out: any[] = []; m.on('settings-refused', (_id: string, info: any) => out.push(info)); return out; };

it('an effort the app-server refuses on turn/start is dropped, not sent again, and the thread says so', async () => {
  await start({}, { CODEX_FAKE_TURN_REJECT: 'effort' });
  const seen = refusals();
  await m.setEffort('t1', 'bad');
  const f = failed('t1');
  m.sendMessage('t1', 'first');            // this turn/start carries the bad effort and is refused
  await f;
  expect(seen).toEqual([{ effort: 'bad' }]);
  expect(m.getEvents('t1').some((e: any) => e.subtype === 'settings_refused' && /effort bad/.test(e.message) && /not be sent again/.test(e.message))).toBe(true);
  await turn('second');                    // the bad value is gone: this one goes through
  const sent = logged('turn/start');
  expect(sent[sent.length - 1].params).not.toHaveProperty('effort');
});

it('a model the app-server refuses on turn/start goes back to the model before it, and is not sent again', async () => {
  await start({ model: 'gpt-6-luna' }, { CODEX_FAKE_TURN_REJECT: 'model' });
  const seen = refusals();
  await m.setModel('t1', 'bad-model');
  expect(m.getModel('t1')).toBe('bad-model');
  const f = failed('t1');
  m.sendMessage('t1', 'first');
  await f;
  expect(seen).toEqual([{ model: 'bad-model', restoredModel: 'gpt-6-luna' }]);
  expect(m.getModel('t1')).toBe('gpt-6-luna');
  // An RPC refusal is not guessed into "This account cannot use": the notice names what was refused, the failed
  // turn says "Codex refused this request" with Codex's words (review F3).
  const events = m.getEvents('t1') as any[];
  expect(events.find((e) => e.subtype === 'settings_refused').message).toBe('Codex refused the model bad-model: unknown model: bad-model. It will not be sent again.');
  expect(events.some((e) => e.type === 'result' && e.is_error && e.result === 'Codex refused this request: unknown model: bad-model')).toBe(true);
  expect(events.some((e) => typeof e.result === 'string' && e.result.startsWith('This account cannot use'))).toBe(false);
  await turn('second');
  const sent = logged('turn/start');
  expect(sent[sent.length - 1].params).not.toHaveProperty('model');
});

it('a refusal that names neither the effort nor the model drops both picks', async () => {
  await start({ model: 'gpt-6-luna' }, { CODEX_FAKE_TURN_REJECT: 'generic' });
  const seen = refusals();
  await m.setModel('t1', 'bad-model');
  await m.setEffort('t1', 'bad');
  const f = failed('t1');
  m.sendMessage('t1', 'first');            // turn/start carries both; the app-server says only "invalid params"
  await f;
  expect(seen).toEqual([{ effort: 'bad', model: 'bad-model', restoredModel: 'gpt-6-luna' }]);
  expect(m.getModel('t1')).toBe('gpt-6-luna');
  await turn('second');
  const sent = logged('turn/start');
  expect(sent[sent.length - 1].params).not.toHaveProperty('effort');
  expect(sent[sent.length - 1].params).not.toHaveProperty('model');
});

it('a good pick is kept, and a turn without picks is untouched', async () => {
  await start({});
  const seen = refusals();
  await m.setEffort('t1', 'high');
  await turn('one');
  await turn('two');
  expect(seen).toEqual([]);
  expect(logged('turn/start')[1].params.effort).toBe('high');
});

// ---- Round 5 ----
it('a transport failure (the app-server dies on the turn) is not a refusal: the saved effort is kept (round 5, item 1)', async () => {
  await start({}, { CODEX_FAKE_EXIT_ON_TURN: '1' });
  const seen = refusals();
  const session = (m as any).sessions.get('t1');
  await m.setEffort('t1', 'high');
  const f = failed('t1');
  m.sendMessage('t1', 'first');
  await f;
  expect(seen).toEqual([]);
  expect(session.pickedEffort).toBe('high');
  expect(m.getEvents('t1').some((e: any) => e.subtype === 'settings_refused')).toBe(false);
});

it('a late rejection that reaches a session that is no longer current changes nothing: no notice, no event for the replacement (round 5, item 1)', async () => {
  await start({ model: 'gpt-6-luna' });
  const seen = refusals();
  const old = (m as any).sessions.get('t1');
  old.pickedEffort = 'bad'; old.nextTurnModel = 'bad-model'; old.modelBeforePick = 'gpt-6-luna';
  m.kill('t1');
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), effort: 'bad', env: { CODEX_FAKE_LOG: logPath } });   // the replacement holds the same value
  const replacement = (m as any).sessions.get('t1');
  const { CodexRpcError } = await import('../../src/structured/codex-manager.js');
  (m as any).dropRefusedPick(old, 'bad-model', 'bad', new CodexRpcError('unsupported reasoning effort: bad'));
  expect(seen).toEqual([]);
  expect(replacement.pickedEffort).toBe('bad');
});

it('a refused model puts the chip back too: the restored model is sent to connected clients as a model frame, without a "switched" line (round 5, item 2)', async () => {
  await start({ model: 'gpt-6-luna' }, { CODEX_FAKE_TURN_REJECT: 'model' });
  const frames: any[] = [];
  m.on('event', (_id: string, e: any) => { if (e.type === 'system' && e.subtype === 'model') frames.push(e); });
  await m.setModel('t1', 'bad-model');
  frames.length = 0;                       // only what the refusal sends
  const f = failed('t1');
  m.sendMessage('t1', 'first');
  await f;
  expect(frames).toEqual([{ type: 'system', subtype: 'model', model: 'gpt-6-luna' }]);
  const ring = m.getEvents('t1').filter((e: any) => e.type === 'system' && e.subtype === 'model');
  expect((ring[ring.length - 1] as any).model).toBe('gpt-6-luna');   // a reconnecting client replays the restored model last
});

it('a new thread whose start Codex refuses fails with "Codex refused this request: <detail>", never on another model', async () => {
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), model: 'gpt-6.1-terra', env: { CODEX_FAKE_LOG: logPath, CODEX_FAKE_START_REJECT_MODEL: 'gpt-6.1-terra' } });
  await until(() => m.getEvents('t1').some((e: any) => e.subtype === 'spawn_error'), 'spawn_error');
  const err = (m.getEvents('t1') as any[]).find((e) => e.subtype === 'spawn_error');
  expect(err.message).toBe("Codex refused this request: The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account.");
  expect(m.getEvents('t1').some((e: any) => e.type === 'system' && e.subtype === 'init')).toBe(false);
});
