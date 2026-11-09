// The effort picker and the "/" menu's model and effort commands, on top of the Pretty model switcher
// (setThreadModel): effort per thread, Codex efforts by model, a refusal shown in the thread, a stop mid-apply,
// one change at a time per thread, a pick that beats the transcript on a relaunch. Rebuild of PR #155 on main 4.3.0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { clearTranscriptPathCache } from './transcript-path.js';
import { SessionService } from './service.js';
import type { IStructuredManager } from '../structured/manager.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  aliveOverride = false;
  argvs: string[][] = [];
  isAlive(id: string) { return this.aliveOverride && this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  spawn(id: string, _c?: string, args: string[] = []) { this.argvs.push(args); this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

/** A structured manager stub. `script` answers the next setModel / setEffort calls; a function holds one open. */
class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  opts: any[] = [];
  models = new Map<string, string>();
  /** What each thread's process runs for effort (set by setEffort), like `models` for the model. */
  effortOf = new Map<string, string>();
  calls: Array<{ kind: 'model' | 'effort'; value: string }> = [];
  notices: string[] = [];
  script: Array<Error | (() => Promise<unknown>) | null> = [];
  efforts: Record<string, string[]> | null = null;
  defaults: Record<string, string> | null = null;
  loadDelays: number[] = [];
  setDefaultEnv() {}
  spawn(id: string, o?: any) { this.live.add(id); this.opts.push(o); return 1; }
  sendMessage() {}
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  getModel(id: string) { return this.models.get(id); }
  /** Bumped when a process ends: an answer from the old process must not change what the replacement runs. */
  incarnation = new Map<string, number>();
  private async next() {
    const n = this.script.shift();
    if (n instanceof Error) throw n;
    if (typeof n === 'function') await n();
  }
  async setModel(id: string, model: string) { this.calls.push({ kind: 'model', value: model }); const inc = this.incarnation.get(id) ?? 0; await this.next(); if ((this.incarnation.get(id) ?? 0) === inc) this.models.set(id, model); return model; }
  async setEffort(id: string, effort: string) { this.calls.push({ kind: 'effort', value: effort }); const inc = this.incarnation.get(id) ?? 0; await this.next(); if ((this.incarnation.get(id) ?? 0) === inc) this.effortOf.set(id, effort); }
  postNotice(_id: string, message: string) { this.notices.push(message); }
  modelEfforts() { return this.efforts; }
  modelDefaultEfforts() { return this.defaults; }
  async loadModelEfforts() {
    const delay = this.loadDelays.shift() ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return this.efforts;
  }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.incarnation.set(id, (this.incarnation.get(id) ?? 0) + 1); this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string; let db: Database.Database; let svc: SessionService;
let pty: FakePty; let claude: FakeStructured; let codex: FakeStructured; let origHome: string | undefined;

function seed(id: string, opts: { type?: string; config?: Record<string, any>; status?: string; live?: boolean } = {}) {
  terminalsDb.create(db, {
    id, sessionId: 's1', type: opts.type ?? 'claude-code', label: id, workingDir: path.join(dir, 'proj'),
    externalId: 'ext-1', config: { transport: 'structured', ...(opts.config ?? {}) },
  });
  terminalsDb.updateStatus(db, id, opts.status ?? 'waiting');
  if (opts.live !== false) ((opts.type ?? 'claude-code') === 'codex' ? codex : claude).live.add(id);
}
const cfg = (id: string) => terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!).config as Record<string, any>;
const tick = () => new Promise((r) => setImmediate(r));
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
function writeTranscript(sessionId: string, lines: unknown[]) {
  const d = path.join(dir, '.claude', 'projects', path.join(dir, 'proj').replace(/[/.]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}
const turn = (model: string, effort: string, timestamp: string) => ({
  type: 'assistant', isSidechain: false, requestedModel: model, effort, timestamp, message: { model, content: [] },
});

beforeEach(() => {
  origHome = process.env.HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-effort-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  process.env.HOME = dir;
  clearTranscriptPathCache();
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty(); claude = new FakeStructured(); codex = new FakeStructured();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(claude);
  svc.setCodexStructuredManager(codex);
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  clearTranscriptPathCache();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('setThreadEffort', () => {
  it('applies the effort to the live thread, saves it for this thread only, and keeps the other keys', async () => {
    seed('t1', { config: { model: 'opus', autonomy: 'supervised' } });
    const r = await svc.setThreadEffort('t1', 'high');
    expect(claude.calls).toEqual([{ kind: 'effort', value: 'high' }]);
    expect(r.effort).toBe('high');
    expect(cfg('t1')).toMatchObject({ effort: 'high', model: 'opus', autonomy: 'supervised' });
    expect(typeof cfg('t1').effortSetAt).toBe('number');
  });

  it('saves for a thread that is not running; the next start uses it', async () => {
    seed('t1', { live: false });
    await svc.setThreadEffort('t1', 'low');
    expect(claude.calls).toEqual([]);
    expect(cfg('t1').effort).toBe('low');
  });

  it('refuses an unknown level, Grok and OpenCode, an agent, a thread mid-turn and a live CLI thread', async () => {
    seed('t1');
    await expect(svc.setThreadEffort('t1', 'bogus')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/low, medium, high, xhigh, max/) });
    seed('g1', { type: 'grok' });
    await expect(svc.setThreadEffort('g1', 'high')).rejects.toMatchObject({ status: 409 });
    seed('o1', { type: 'opencode' });
    await expect(svc.setThreadEffort('o1', 'high')).rejects.toMatchObject({ status: 409 });
    seed('a1', { config: { role: 'agent', agentType: 'implementer' } });
    await expect(svc.setThreadEffort('a1', 'high')).rejects.toMatchObject({ status: 409 });
    seed('w1', { status: 'working' });
    await expect(svc.setThreadEffort('w1', 'high')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/busy/) });
    seed('p1', { config: { transport: 'pty' }, live: false });
    pty.alive.add('p1'); pty.aliveOverride = true;
    await expect(svc.setThreadEffort('p1', 'high')).rejects.toMatchObject({ status: 409 });
    await expect(svc.setThreadEffort('nope', 'high')).rejects.toMatchObject({ status: 404 });
    expect(claude.calls).toEqual([]);
  });

  it('a turn parked on a question (needs_input) is a turn that runs: model and effort are refused like the chip is disabled', async () => {
    seed('q1', { status: 'needs_input', config: { model: 'sonnet' } });
    await expect(svc.setThreadModel('q1', 'opus')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/busy, waiting for your answer/) });
    await expect(svc.setThreadEffort('q1', 'high')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/busy, waiting for your answer/) });
    await expect(svc.handleTypedSlash('q1', '/model opus', 'user')).rejects.toMatchObject({ status: 409 });
    expect(claude.calls).toEqual([]);
    expect(cfg('q1').model).toBe('sonnet');
  });

  it('an overseer may change its model and effort (PS-2): an explicit model wins over the tier', async () => {
    seed('c1', { config: { role: 'coordinator' } });
    await svc.setThreadEffort('c1', 'max');
    await svc.setThreadModel('c1', 'opus');
    expect(cfg('c1')).toMatchObject({ role: 'coordinator', effort: 'max', model: 'opus' });
  });
});

describe('a refusal is shown in the thread and changes nothing (round 1 item 10, round 2 item 4)', () => {
  it('an effort the CLI refuses: a notice in the thread, the old effort stays', async () => {
    seed('t1', { config: { effort: 'low' } });
    claude.script = [new Error('effort refused')];
    await expect(svc.setThreadEffort('t1', 'max')).rejects.toMatchObject({ status: 400, message: 'effort refused' });
    expect(claude.notices).toEqual(['Could not change the effort: effort refused']);
    expect(cfg('t1').effort).toBe('low');
  });

  it('a model the CLI refuses: the same notice, the old model stays', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [new Error("Model 'x' not found")];
    await expect(svc.setThreadModel('t1', 'opus')).rejects.toMatchObject({ status: 400 });
    expect(claude.notices).toEqual(["Could not change the model: Model 'x' not found"]);
    expect(cfg('t1').model).toBe('sonnet');
  });

  it('says nothing when the change worked', async () => {
    seed('t1');
    await svc.setThreadModel('t1', 'opus');
    await svc.setThreadEffort('t1', 'high');
    expect(claude.notices).toEqual([]);
  });
});

describe('a thread that stops while a change is being sent keeps the pick (round 2 item 1)', () => {
  it('model: the stop is not a refusal; the pick is saved for the next start, with no notice', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [async () => { claude.kill('t1'); throw new Error('The thread stopped'); }];
    const r = await svc.setThreadModel('t1', 'opus');
    expect(r.terminal.config).toMatchObject({ model: 'opus' });
    expect(cfg('t1').model).toBe('opus');
    expect(claude.notices).toEqual([]);
  });

  it('effort: the same', async () => {
    seed('t1', { config: { effort: 'low' } });
    claude.script = [async () => { claude.kill('t1'); throw new Error('The thread stopped'); }];
    await svc.setThreadEffort('t1', 'max');
    expect(cfg('t1').effort).toBe('max');
    expect(claude.notices).toEqual([]);
  });
});

describe('one change at a time per thread (round 2 items 2 and 3)', () => {
  it('a second change waits for the first, and sees what it left', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    let release!: () => void;
    claude.script = [() => new Promise<void>((res) => { release = res; })];
    const first = svc.setThreadModel('t1', 'opus');
    await tick();
    const second = svc.setThreadModel('t1', 'haiku');
    await tick();
    expect(claude.calls.map((c) => c.value)).toEqual(['opus']); // the second is still waiting its turn
    release();
    await first; await second;
    expect(claude.calls.map((c) => c.value)).toEqual(['opus', 'haiku']);
    expect(cfg('t1').model).toBe('haiku'); // last in, last saved: saved and live agree
  });

  it('a refused first change does not leave its value for the second to undo', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [new Error('nope'), null];
    const a = svc.setThreadModel('t1', 'opus').catch(() => 'refused');
    const b = svc.setThreadModel('t1', 'opus');
    expect(await a).toBe('refused');
    await b;
    expect(cfg('t1').model).toBe('opus'); // the process runs Opus and the config says Opus
  });
});

describe('Codex efforts depend on the model (round 1 item 9)', () => {
  const luna = ['low', 'medium', 'high', 'xhigh', 'max'];
  const astra = [...luna, 'ultra'];
  beforeEach(() => { codex.efforts = { 'gpt-6-luna': luna, 'gpt-6-astra': astra }; });

  it('refuses an effort the thread\'s model does not take, before anything is sent', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-luna' } });
    await expect(svc.setThreadEffort('x1', 'ultra')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/gpt-6-luna does not take that effort.*low, medium, high, xhigh, max/) });
    expect(codex.calls).toEqual([]);
    expect(cfg('x1').effort).toBeUndefined();
    await svc.setThreadEffort('x1', 'max');
    expect(codex.calls).toEqual([{ kind: 'effort', value: 'max' }]);
  });

  it('accepts ultra on a model that has it', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    await svc.setThreadEffort('x1', 'ultra');
    expect(cfg('x1').effort).toBe('ultra');
  });

  it('a thread with no saved model is checked against the model it runs (round 2 item 6)', async () => {
    seed('x1', { type: 'codex', config: {} });
    codex.models.set('x1', 'gpt-6-luna');
    await expect(svc.setThreadEffort('x1', 'ultra')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/gpt-6-luna/) });
    codex.models.set('x1', 'gpt-6-astra');
    await svc.setThreadEffort('x1', 'ultra');
    expect(cfg('x1').effort).toBe('ultra');
  });

  it('without a live list it uses the built-in table (Luna has no ultra)', async () => {
    codex.efforts = null;
    seed('x1', { type: 'codex', config: { model: 'gpt-6-luna' } });
    await expect(svc.setThreadEffort('x1', 'ultra')).rejects.toMatchObject({ status: 400 });
    seed('x2', { type: 'codex', config: { model: 'gpt-5.6-sol' } });
    await svc.setThreadEffort('x2', 'ultra');
    expect(cfg('x2').effort).toBe('ultra');
  });

  it('a model switch replaces a saved effort the new model cannot take with the new model\'s default, and says so (round 2 item 4)', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'ultra' } });
    codex.models.set('x1', 'gpt-6-astra');
    const r = await svc.setThreadModel('x1', 'gpt-6-luna');
    // Not left out: a Codex thread keeps the effort of its last turn when the model changes (live check, codex-cli 0.166).
    expect(codex.calls).toEqual([{ kind: 'model', value: 'gpt-6-luna' }, { kind: 'effort', value: 'medium' }]);
    expect(cfg('x1').model).toBe('gpt-6-luna');
    expect(cfg('x1').effort).toBeUndefined(); // the dropped pick is gone; the model's default is sent but is not a pick (round 4)
    expect(r.clearedEffort).toBe('ultra');
    expect(r.effortNow).toBe('medium');
  });

  it('uses the default the app-server reports for that model', async () => {
    codex.defaults = { 'gpt-6-luna': 'low' };
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'ultra' } });
    codex.models.set('x1', 'gpt-6-astra');
    const r = await svc.setThreadModel('x1', 'gpt-6-luna');
    expect(r.effortNow).toBe('low');
    expect(codex.calls[1]).toEqual({ kind: 'effort', value: 'low' });
  });

  it('a switch with no saved effort also sends the new model\'s default (round 3 item 5), without a cleared effort to report', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    codex.models.set('x1', 'gpt-6-astra');
    const r = await svc.setThreadModel('x1', 'gpt-6-luna');
    expect(codex.calls[1]).toEqual({ kind: 'effort', value: 'medium' });
    expect(cfg('x1').effort).toBeUndefined(); // sent, but not saved as if the owner had picked it (round 4)
    expect(r.effortNow).toBe('medium');
    expect(r.clearedEffort).toBeUndefined();
  });

  it('leaves the effort alone for the same model, for a saved effort the new model takes, and on a Claude thread', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    codex.models.set('x1', 'gpt-6-astra');
    await svc.setThreadModel('x1', 'gpt-6-astra');
    expect(codex.calls).toEqual([{ kind: 'model', value: 'gpt-6-astra' }]);
    seed('x2', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'high' } });
    codex.models.set('x2', 'gpt-6-astra');
    const r = await svc.setThreadModel('x2', 'gpt-6-luna');
    expect(r.effortNow).toBeUndefined();
    expect(cfg('x2').effort).toBe('high');
    seed('t1', { config: { model: 'sonnet' } });
    expect((await svc.setThreadModel('t1', 'opus')).effortNow).toBeUndefined();
  });

  it('a start sends the saved effort to the app-server (max and ultra too), and drops one the model lost; after a restart the new default applies', () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'ultra' }, live: false });
    svc.ensureStructuredAlive('x1');
    expect(codex.opts[0].effort).toBe('ultra');
    seed('x2', { type: 'codex', config: { model: 'gpt-6-luna', effort: 'ultra' }, live: false });
    svc.ensureStructuredAlive('x2');
    expect(codex.opts[1].effort).toBeUndefined();
  });
});

describe('concurrent Codex changes are checked one after the other (round 2 item 3, round 3 item 3)', () => {
  beforeEach(() => {
    codex.efforts = { 'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'], 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
    // The FIRST caller waits longest for the list: without the lock the second one validates and saves before it.
    codex.loadDelays = [30, 5];
  });

  it('a model change and an effort that the NEW model cannot take, sent together: the effort is refused', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    codex.models.set('x1', 'gpt-6-astra');
    const a = svc.setThreadModel('x1', 'gpt-6-luna');
    const b = svc.setThreadEffort('x1', 'ultra');
    await a;
    await expect(b).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/gpt-6-luna does not take that effort/) });
    expect(cfg('x1').model).toBe('gpt-6-luna');
    expect(cfg('x1').effort).toBeUndefined(); // the switch sent Luna's own default (never ultra) without saving it as a pick
  });

  it('an effort and then a model change that cannot take it: the model switch brings its own default', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    codex.models.set('x1', 'gpt-6-astra');
    const a = svc.setThreadEffort('x1', 'ultra');
    const b = svc.setThreadModel('x1', 'gpt-6-luna');
    await a;
    const rb = await b;
    expect(rb.clearedEffort).toBe('ultra');
    expect(cfg('x1').model).toBe('gpt-6-luna');
    expect(cfg('x1').effort).toBeUndefined();
  });
});

describe('typed /model and /effort in a Pretty Claude thread', () => {
  it('runs the change itself and sends nothing to the model', async () => {
    seed('t1');
    expect(await svc.handleTypedSlash('t1', '/model opus', 'user')).not.toBeNull();
    expect(cfg('t1').model).toBe('opus');
    await svc.handleTypedSlash('t1', '/effort HIGH', 'user');
    expect(cfg('t1').effort).toBe('high');
  });

  it('answers a bare command or a bad value with a plain error', async () => {
    seed('t1');
    await expect(svc.handleTypedSlash('t1', '/model', 'user')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/picker/i) });
    await expect(svc.handleTypedSlash('t1', '/effort turbo', 'user')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/low, medium/) });
    await expect(svc.handleTypedSlash('t1', '/model default', 'user')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Unknown model/) });
  });

  it('mid-turn it fails like the chip: 409, nothing changed (the text stays in the box)', async () => {
    seed('t1', { status: 'working', config: { model: 'sonnet' } });
    await expect(svc.handleTypedSlash('t1', '/model opus', 'user')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/busy/) });
    expect(cfg('t1').model).toBe('sonnet');
  });

  it('leaves everything else alone: other text, the escape, a coordinator\'s message, a Codex or CLI thread', async () => {
    seed('t1');
    expect(await svc.handleTypedSlash('t1', 'hello', 'user')).toBeNull();
    expect(await svc.handleTypedSlash('t1', ' /model opus', 'user')).toBeNull();
    expect(await svc.handleTypedSlash('t1', '/compact', 'user')).toBeNull();
    expect(await svc.handleTypedSlash('t1', '/model opus', 'coordinator')).toBeNull();
    expect(await svc.handleTypedSlash('t1', '/model opus', undefined)).toBeNull();
    seed('x1', { type: 'codex' });
    expect(await svc.handleTypedSlash('x1', '/model gpt-6-luna', 'user')).toBeNull();
    seed('p1', { config: { transport: 'pty' }, live: false });
    expect(await svc.handleTypedSlash('p1', '/model opus', 'user')).toBeNull();
    expect(claude.calls).toEqual([]);
  });
});

describe('a picked effort beats the transcript on a relaunch (round 1 item 1)', () => {
  it('restart, /cli and update before the next turn keep the pick; a later /effort in the CLI is followed again', async () => {
    seed('t1', { config: { model: 'opus', effort: 'low' }, live: false });
    writeTranscript('ext-1', [turn('claude-opus-5-5', 'high', '2026-11-07T10:00:00Z')]); // the last turn ran at high
    await svc.setThreadEffort('t1', 'low');                                                // picked now, after that turn
    expect(svc.ensureStructuredAlive('t1')).toBe(true);
    expect(flag(claude.opts[0].args, '--effort')).toBe('low');
    expect(cfg('t1').effort).toBe('low');
    // The pick took hold (a turn ran on it); the owner then ran /effort high in the CLI: followed again.
    writeTranscript('ext-1', [turn('claude-opus-5-5', 'low', new Date(Date.now() + 5000).toISOString()), turn('claude-opus-5-5', 'high', new Date(Date.now() + 9000).toISOString())]);
    claude.live.delete('t1');
    expect(svc.ensureStructuredAlive('t1')).toBe(true);
    expect(flag(claude.opts[1].args, '--effort')).toBe('high');
  });

  it('Pretty -> CLI: the Codex CLI starts with the picked effort (-c) and the model', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'max' }, live: false });
    pty.aliveOverride = false;
    await svc.switchTransport('x1', 'pty');
    const argv = pty.argvs[pty.argvs.length - 1];
    expect(argv).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="max"', '--model', 'gpt-6-astra']));
    expect(argv.indexOf('model_reasoning_effort="max"')).toBeLessThan(argv.indexOf('resume'));
  });
});

describe('a pick the harness refused late is taken out of the config (round 4)', () => {
  it('the saved effort and model go back, and the web is told', () => {
    const changed: string[] = [];
    svc.setTerminalChangedListener((sid) => changed.push(sid));
    seed('x1', { type: 'codex', config: { model: 'bad-model', modelSetAt: 5, effort: 'bad', effortSetAt: 6 } });
    codex.emit('settings-refused', 'x1', { model: 'bad-model', restoredModel: 'gpt-6-luna', effort: 'bad' });
    expect(cfg('x1')).toMatchObject({ model: 'gpt-6-luna' });
    expect(cfg('x1').effort).toBeUndefined();
    expect(cfg('x1').effortSetAt).toBeUndefined();
    expect(cfg('x1').modelSetAt).toBeUndefined();
    expect(changed).toEqual(['s1']);
  });

  it('a model with nothing before it is simply removed', () => {
    seed('x1', { type: 'codex', config: { model: 'bad-model', modelSetAt: 5 } });
    codex.emit('settings-refused', 'x1', { model: 'bad-model' });
    expect(cfg('x1').model).toBeUndefined();
  });

  it('a newer pick that replaced the refused value is left alone, and nobody is told', () => {
    const changed: string[] = [];
    svc.setTerminalChangedListener((sid) => changed.push(sid));
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'high' } });
    codex.emit('settings-refused', 'x1', { model: 'bad-model', restoredModel: 'gpt-6-luna', effort: 'bad' });
    expect(cfg('x1')).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    expect(changed).toEqual([]);
  });
});

describe('a change that waits for the Codex model list is checked again afterwards (round 4)', () => {
  beforeEach(() => {
    codex.efforts = { 'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'], 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
    codex.loadDelays = [40];
  });

  it('a turn that starts while the list loads: the effort is refused as busy, nothing is sent or saved', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    const p = svc.setThreadEffort('x1', 'ultra');
    p.catch(() => {});
    await tick();
    terminalsDb.updateStatus(db, 'x1', 'working');     // the owner sent a message meanwhile
    await expect(p).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/busy/) });
    expect(codex.calls).toEqual([]);
    expect(cfg('x1').effort).toBeUndefined();
  });

  it('a turn that starts while the list loads: the model switch is refused too', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    codex.models.set('x1', 'gpt-6-astra');
    const p = svc.setThreadModel('x1', 'gpt-6-luna');
    p.catch(() => {});
    await tick();
    terminalsDb.updateStatus(db, 'x1', 'needs_input');
    await expect(p).rejects.toMatchObject({ status: 409 });
    expect(codex.calls).toEqual([]);
    expect(cfg('x1').model).toBe('gpt-6-astra');
  });

  it('a switch to the CLI while the list loads: refused, the CLI owns the model now', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    const p = svc.setThreadEffort('x1', 'high');
    p.catch(() => {});
    await tick();
    const row = terminalsDb.getById(db, 'x1')!;
    terminalsDb.writeConfigRaw(db, 'x1', { ...JSON.parse(row.config || '{}'), transport: undefined });
    pty.alive.add('x1'); pty.aliveOverride = true;
    await expect(p).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/CLI/) });
    expect(codex.calls).toEqual([]);
  });
});

describe('exit during a change (round 4: the reviewers disagreed)', () => {
  it('the thread stops and a replacement process is already running when the answer comes back: the pick is kept AND applied to the replacement (round 5, item 3)', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.models.set('t1', 'sonnet');                 // the replacement was started from the config before the pick
    claude.script = [async () => { claude.kill('t1'); claude.live.add('t1'); throw new Error('The thread stopped'); }]; // exit, then a new spawn
    await svc.setThreadModel('t1', 'opus');
    expect(cfg('t1').model).toBe('opus');
    expect(claude.notices).toEqual([]);
    expect(claude.models.get('t1')).toBe('opus');       // what the replacement RUNS, not only what is saved
    expect(claude.calls.map((c) => c.value)).toEqual(['opus', 'opus']);
  });

  it('the same for an effort', async () => {
    seed('t1', { config: { effort: 'low' } });
    claude.effortOf.set('t1', 'low');
    claude.script = [async () => { claude.kill('t1'); claude.live.add('t1'); throw new Error('The thread stopped'); }];
    await svc.setThreadEffort('t1', 'max');
    expect(cfg('t1').effort).toBe('max');
    expect(claude.notices).toEqual([]);
    expect(claude.effortOf.get('t1')).toBe('max');
  });

  it('a replacement that refuses the pick is a refusal: a notice, the old values stay, 400', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [async () => { claude.kill('t1'); claude.live.add('t1'); throw new Error('The thread stopped'); }, new Error('Model not found')];
    await expect(svc.setThreadModel('t1', 'opus')).rejects.toMatchObject({ status: 400, message: 'Model not found' });
    expect(claude.notices).toEqual(['Could not change the model: Model not found']);
    expect(cfg('t1').model).toBe('sonnet');
  });

  it('a thread that is gone for good (no replacement) just keeps the pick for its next start', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [async () => { claude.kill('t1'); throw new Error('The thread stopped'); }];
    await svc.setThreadModel('t1', 'opus');
    expect(cfg('t1').model).toBe('opus');
    expect(claude.calls).toHaveLength(1);
  });

  it('a real refusal while the same process lives is still a refusal', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [new Error('Model not found')];
    await expect(svc.setThreadModel('t1', 'opus')).rejects.toMatchObject({ status: 400 });
    expect(claude.notices).toHaveLength(1);
    expect(cfg('t1').model).toBe('sonnet');
  });
});

describe('a model switch\'s default effort is not a pick (round 4, small item)', () => {
  it('it is not saved, so a later switch to a model that takes the old default is not held to it', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    codex.models.set('x1', 'gpt-6-astra');
    await svc.setThreadModel('x1', 'gpt-6-luna');                 // sends Luna's default, saves none
    expect(cfg('x1').effort).toBeUndefined();
    expect(cfg('x1').effortSetAt).toBeUndefined();
    codex.defaults = { 'gpt-6-astra': 'high' };
    const r = await svc.setThreadModel('x1', 'gpt-6-astra');       // back: Astra's own default, not Luna's
    expect(codex.calls[codex.calls.length - 1]).toEqual({ kind: 'effort', value: 'high' });
    expect(r.effortNow).toBe('high');
  });
});

describe('a saved effort with no saved model is kept at spawn (round 4, small item)', () => {
  it('ultra survives the start of a thread whose model is the app-server default', () => {
    seed('x1', { type: 'codex', config: { effort: 'ultra' }, live: false });
    svc.ensureStructuredAlive('x1');
    expect(codex.opts[0].effort).toBe('ultra');
  });
  it('an unknown level is still dropped', () => {
    seed('x1', { type: 'codex', config: { effort: 'turbo' }, live: false });
    svc.ensureStructuredAlive('x1');
    expect(codex.opts[0].effort).toBeUndefined();
  });
});

describe('the old request SUCCEEDS but its process is replaced before the service resumes (round 6)', () => {
  /** The old process answers "ok", then dies; a replacement started from the OLD config is already running. */
  const exitThenReplace = (id: string, setReplacement: () => void) => async () => { claude.kill(id); claude.live.add(id); setReplacement(); };

  it('model: the saved pick is applied to the replacement, whose live model is then the pick', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.models.set('t1', 'sonnet');
    claude.script = [exitThenReplace('t1', () => claude.models.set('t1', 'sonnet'))];     // the replacement runs the old model
    await svc.setThreadModel('t1', 'opus');
    expect(cfg('t1').model).toBe('opus');
    expect(claude.models.get('t1')).toBe('opus');                                        // what the replacement RUNS
    expect(claude.calls.map((c) => c.value)).toEqual(['opus', 'opus']);
    expect(claude.notices).toEqual([]);
  });

  it('effort: the same, and the replacement runs the picked effort', async () => {
    seed('t1', { config: { effort: 'low' } });
    claude.effortOf.set('t1', 'low');
    claude.script = [exitThenReplace('t1', () => claude.effortOf.set('t1', 'low'))];
    await svc.setThreadEffort('t1', 'max');
    expect(cfg('t1').effort).toBe('max');
    expect(claude.effortOf.get('t1')).toBe('max');
    expect(claude.notices).toEqual([]);
  });

  it('model: a replacement that refuses the pick is a refusal (notice, 400, the saved model goes back)', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.models.set('t1', 'sonnet');
    claude.script = [exitThenReplace('t1', () => claude.models.set('t1', 'sonnet')), new Error('Model not found')];
    await expect(svc.setThreadModel('t1', 'opus')).rejects.toMatchObject({ status: 400, message: 'Model not found' });
    expect(claude.notices).toEqual(['Could not change the model: Model not found']);
    expect(cfg('t1').model).toBe('sonnet');
    expect(claude.models.get('t1')).toBe('sonnet');
  });

  it('effort: a replacement that refuses is a refusal too', async () => {
    seed('t1', { config: { effort: 'low' } });
    claude.effortOf.set('t1', 'low');
    claude.script = [exitThenReplace('t1', () => claude.effortOf.set('t1', 'low')), new Error('effort refused')];
    await expect(svc.setThreadEffort('t1', 'max')).rejects.toMatchObject({ status: 400, message: 'effort refused' });
    expect(cfg('t1').effort).toBe('low');
    expect(claude.notices).toEqual(['Could not change the effort: effort refused']);
  });

  it('the old process succeeds and ends with no replacement: the pick stays saved for the next start, nothing more is sent', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.script = [async () => { claude.kill('t1'); }];
    await svc.setThreadModel('t1', 'opus');
    expect(cfg('t1').model).toBe('opus');
    expect(claude.calls).toHaveLength(1);
  });

  it('an old request that succeeds with its process still the same one is not applied twice', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    await svc.setThreadModel('t1', 'opus');
    await svc.setThreadEffort('t1', 'high');
    expect(claude.calls).toEqual([{ kind: 'model', value: 'opus' }, { kind: 'effort', value: 'high' }]);
  });
});
