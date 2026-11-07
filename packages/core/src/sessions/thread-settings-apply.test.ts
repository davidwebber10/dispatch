// Changing a live thread's model and effort from the picker or a typed /model (slash menu, 2026-11-06).
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
import type { IStructuredManager, ApplyResult, ThreadSettingsChange } from '../structured/manager.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  kill() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  applied: { id: string; change: ThreadSettingsChange }[] = [];
  sent: string[] = [];
  turnOpen = false;
  nextResult: ApplyResult = { ok: true };
  /** Per-call answers, first to last; falls back to nextResult. A function lets a test hold an apply open. */
  script: Array<ApplyResult | (() => Promise<ApplyResult>)> = [];
  notices: string[] = [];
  spawnOpts: any[] = [];
  efforts: Record<string, string[]> | null = null;
  postNotice(_id: string, message: string) { this.notices.push(message); }
  modelEfforts() { return this.efforts; }
  async loadModelEfforts() { return this.efforts; }
  setDefaultEnv() {}
  spawn(id: string, o?: any) { this.live.add(id); this.spawnOpts.push(o); return 1; }
  sendMessage(_id: string, content: any) { this.sent.push(typeof content === 'string' ? content : '[blocks]'); }
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
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
  async applySettings(id: string, change: ThreadSettingsChange): Promise<ApplyResult> {
    this.applied.push({ id, change });
    const next = this.script.shift();
    if (typeof next === 'function') return next();
    return next ?? this.nextResult;
  }
  isTurnOpen() { return this.turnOpen; }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let claude: FakeStructured;
let codex: FakeStructured;
let origHome: string | undefined;

function seed(id: string, opts: { type?: string; config?: Record<string, any>; live?: boolean } = {}) {
  terminalsDb.create(db, {
    id, sessionId: 's1', type: opts.type ?? 'claude-code', label: id, workingDir: path.join(dir, 'proj'),
    externalId: 'ext-1', config: { transport: 'structured', ...(opts.config ?? {}) },
  });
  if (opts.live !== false) ((opts.type ?? 'claude-code') === 'codex' ? codex : claude).live.add(id);
}
const cfg = (id: string) => terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!).config as Record<string, any>;

beforeEach(() => {
  origHome = process.env.HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-settings-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  process.env.HOME = dir;
  clearTranscriptPathCache();
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  claude = new FakeStructured();
  codex = new FakeStructured();
  svc.setStructuredManager(claude);
  svc.setCodexStructuredManager(codex);
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  clearTranscriptPathCache();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('setThreadSettings', () => {
  it('saves the choice, then applies it to the live Claude thread', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    const r = await svc.setThreadSettings('t1', { model: 'opus', effort: 'high' });
    expect(r.applied).toBe('now');
    expect(claude.applied).toEqual([{ id: 't1', change: { model: 'opus', effort: 'high' } }]);
    expect(cfg('t1')).toMatchObject({ model: 'opus', effort: 'high', transport: 'structured' });
  });

  it('keeps the other config keys', async () => {
    seed('t1', { config: { autonomy: 'supervised', label2: 'x' } });
    await svc.setThreadSettings('t1', { effort: 'low' });
    expect(cfg('t1')).toMatchObject({ autonomy: 'supervised', label2: 'x', effort: 'low' });
  });

  it('a Claude reset (model null) removes the saved model', async () => {
    seed('t1', { config: { model: 'opus' } });
    await svc.setThreadSettings('t1', { model: null });
    expect(cfg('t1').model).toBeUndefined();
    expect(claude.applied[0].change).toEqual({ model: null });
  });

  it('saves for a thread that is not running; the next start uses it', async () => {
    seed('t1', { live: false });
    const r = await svc.setThreadSettings('t1', { model: 'haiku' });
    expect(r.applied).toBe('next-start');
    expect(claude.applied).toEqual([]);
    expect(cfg('t1').model).toBe('haiku');
  });

  it('puts the saved values back when the harness refuses the change', async () => {
    seed('t1', { config: { model: 'sonnet', effort: 'low' } });
    claude.nextResult = { ok: false, error: "Model 'x' not found" };
    await expect(svc.setThreadSettings('t1', { model: 'opus', effort: 'max' })).rejects.toMatchObject({ status: 400, message: "Model 'x' not found" });
    expect(cfg('t1')).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  it('an overseer (coordinator) may change its model; the explicit model is saved', async () => {
    seed('c1', { config: { role: 'coordinator' } });
    await svc.setThreadSettings('c1', { model: 'opus' });
    expect(cfg('c1')).toMatchObject({ role: 'coordinator', model: 'opus' });
  });

  it('Default on an overseer is its tier model, so the live change and the next start agree', async () => {
    seed('c1', { config: { role: 'coordinator', model: 'opus' } });
    await svc.setThreadSettings('c1', { model: null });
    expect(claude.applied[0].change).toEqual({ model: 'sonnet' }); // MODEL_FOR_TYPE.coordinator
    expect(cfg('c1').model).toBe('sonnet');
  });

  it('works on a Codex thread without waiting for a turn', async () => {
    seed('x1', { type: 'codex' });
    codex.turnOpen = true;
    const r = await svc.setThreadSettings('x1', { model: 'gpt-6-luna', effort: 'medium' });
    expect(r.applied).toBe('now');
    expect(codex.applied[0].change).toEqual({ model: 'gpt-6-luna', effort: 'medium' });
  });

  it('refuses Grok and OpenCode, a CLI thread, a missing thread and bad values', async () => {
    seed('g1', { type: 'grok' });
    await expect(svc.setThreadSettings('g1', { model: 'grok-4.5' })).rejects.toMatchObject({ status: 409 });
    seed('p1', { config: { transport: 'pty' } });
    await expect(svc.setThreadSettings('p1', { model: 'opus' })).rejects.toMatchObject({ status: 409 });
    await expect(svc.setThreadSettings('nope', { model: 'opus' })).rejects.toMatchObject({ status: 404 });
    seed('t1');
    await expect(svc.setThreadSettings('t1', { effort: 'bogus' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.setThreadSettings('t1', { model: 'gpt-6-astra' })).rejects.toMatchObject({ status: 400 });
    expect(claude.applied).toEqual([]);
  });

  describe('a Claude thread in the middle of a turn', () => {
    it('saves now and applies when the turn ends; the last choice wins', async () => {
      seed('t1');
      claude.turnOpen = true;
      const r = await svc.setThreadSettings('t1', { model: 'opus' });
      expect(r.applied).toBe('after-turn');
      expect(cfg('t1').model).toBe('opus');
      await svc.setThreadSettings('t1', { effort: 'max' });
      await svc.setThreadSettings('t1', { model: 'haiku' });
      expect(claude.applied).toEqual([]);
      claude.turnOpen = false;
      claude.emit('idle', 't1', { declared: false });
      await new Promise((r2) => setImmediate(r2));
      expect(claude.applied).toEqual([{ id: 't1', change: { model: 'haiku', effort: 'max' } }]);
      claude.emit('idle', 't1', { declared: false }); // a later turn end does not apply it again
      await new Promise((r2) => setImmediate(r2));
      expect(claude.applied).toHaveLength(1);
    });

    it('a refusal after the wait puts the saved values back', async () => {
      seed('t1', { config: { model: 'sonnet' } });
      claude.turnOpen = true;
      await svc.setThreadSettings('t1', { model: 'opus' });
      claude.nextResult = { ok: false, error: 'nope' };
      claude.emit('failed', 't1');
      await new Promise((r2) => setImmediate(r2));
      expect(cfg('t1').model).toBe('sonnet');
    });
  });
});

describe('typed /model and /effort in a Pretty Claude thread', () => {
  it('runs the change itself and sends nothing to the model', async () => {
    seed('t1');
    const t = await svc.handleTypedSlash('t1', '/model opus', 'user');
    expect(t).not.toBeNull();
    expect(claude.sent).toEqual([]);
    expect(cfg('t1').model).toBe('opus');
    await svc.handleTypedSlash('t1', '/effort HIGH', 'user');
    expect(cfg('t1').effort).toBe('high');
  });

  it('answers a bare command or a bad value with a plain error, never sending it', async () => {
    seed('t1');
    await expect(svc.handleTypedSlash('t1', '/model', 'user')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/picker/i) });
    await expect(svc.handleTypedSlash('t1', '/effort turbo', 'user')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/low, medium/) });
    expect(claude.sent).toEqual([]);
  });

  it('leaves everything else alone: other text, the escape, a coordinator, a Codex thread, a CLI thread', async () => {
    seed('t1');
    expect(await svc.handleTypedSlash('t1', 'hello', 'user')).toBeNull();
    expect(await svc.handleTypedSlash('t1', ' /model opus', 'user')).toBeNull();
    expect(await svc.handleTypedSlash('t1', '/compact', 'user')).toBeNull();
    expect(await svc.handleTypedSlash('t1', '/model opus', 'coordinator')).toBeNull();
    expect(await svc.handleTypedSlash('t1', '/model opus', undefined)).toBeNull();
    seed('x1', { type: 'codex' });
    expect(await svc.handleTypedSlash('x1', '/model gpt-6-luna', 'user')).toBeNull();
    seed('p1', { config: { transport: 'pty' } });
    expect(await svc.handleTypedSlash('p1', '/model opus', 'user')).toBeNull();
    expect(claude.applied).toEqual([]);
  });
});

const tick = () => new Promise((r) => setImmediate(r));

// ---- Review round 1 (PR #155) ----

describe('a pick is saved so that the next start keeps it (item 1)', () => {
  it('marks the picked settings as pinned in the config', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    await svc.setThreadSettings('t1', { model: 'opus', effort: 'high' });
    expect(cfg('t1').settingsPinned).toEqual({ model: true, effort: true });
    await svc.setThreadSettings('t1', { effort: 'low' });
    expect(cfg('t1').settingsPinned).toEqual({ model: true, effort: true });
  });
});

describe('a pick made mid-turn survives the thread ending (item 2)', () => {
  it('keeps the saved pick when the thread exits first, and does not apply or roll back', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.turnOpen = true;
    await svc.setThreadSettings('t1', { model: 'opus' });
    claude.live.delete('t1');
    claude.emit('exit', 't1', 0);
    await tick();
    expect(claude.applied).toEqual([]);
    expect(cfg('t1').model).toBe('opus');
    expect(claude.notices).toEqual([]);
    // The next start asks for it; a later pick on the new process starts from a clean state.
    claude.live.add('t1');
    claude.turnOpen = false;
    await svc.setThreadSettings('t1', { effort: 'low' });
    expect(claude.applied).toEqual([{ id: 't1', change: { effort: 'low' } }]);
  });

  it('a pick queued before a failed turn (the process stays up) is still applied', async () => {
    seed('t1');
    claude.turnOpen = true;
    await svc.setThreadSettings('t1', { model: 'opus' });
    claude.emit('failed', 't1');
    await tick();
    expect(claude.applied).toEqual([{ id: 't1', change: { model: 'opus' } }]);
  });
});

describe('overlapping changes never bring back a rejected value (item 3)', () => {
  it('a queued change that fails and a second one that also fails both end on the value the process runs', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.turnOpen = true;
    await svc.setThreadSettings('t1', { model: 'opus' }); // waits for the turn
    let release!: (r: ApplyResult) => void;
    claude.script = [() => new Promise<ApplyResult>((res) => { release = res; }), { ok: false, error: 'no haiku' }];
    claude.turnOpen = false;
    claude.emit('idle', 't1', { declared: false }); // the queued 'opus' starts to apply and is held open
    await tick();
    const second = svc.setThreadSettings('t1', { model: 'haiku' }); // arrives while it is in flight
    await tick();
    expect(claude.applied.map((a) => a.change)).toEqual([{ model: 'opus' }]); // the second waits its turn
    release({ ok: false, error: 'no opus' });
    await expect(second).rejects.toMatchObject({ status: 400, message: 'no haiku' });
    expect(claude.applied.map((a) => a.change)).toEqual([{ model: 'opus' }, { model: 'haiku' }]);
    expect(cfg('t1').model).toBe('sonnet'); // never the rejected 'opus'
  });

  it('a queued change that fails does not undo a newer one that succeeds', async () => {
    seed('t1', { config: { model: 'sonnet' } });
    claude.turnOpen = true;
    await svc.setThreadSettings('t1', { model: 'opus' });
    let release!: (r: ApplyResult) => void;
    claude.script = [() => new Promise<ApplyResult>((res) => { release = res; }), { ok: true }];
    claude.turnOpen = false;
    claude.emit('idle', 't1', { declared: false });
    await tick();
    const second = svc.setThreadSettings('t1', { model: 'haiku' });
    await tick();
    release({ ok: false, error: 'no opus' });
    await second;
    expect(cfg('t1').model).toBe('haiku');
  });
});

describe('a model accepted but an effort refused keeps the picker and the process in step (item 4)', () => {
  it('puts the old model back on the process and in the config', async () => {
    seed('t1', { config: { model: 'sonnet', effort: 'low' } });
    claude.script = [{ ok: false, error: 'effort refused', partial: { model: true } }, { ok: true }];
    await expect(svc.setThreadSettings('t1', { model: 'opus', effort: 'max' })).rejects.toMatchObject({ status: 400, message: 'effort refused' });
    expect(claude.applied.map((a) => a.change)).toEqual([{ model: 'opus', effort: 'max' }, { model: 'sonnet' }]);
    expect(cfg('t1')).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  it('resets to the default when no model was saved', async () => {
    seed('t1', {});
    claude.script = [{ ok: false, error: 'effort refused', partial: { model: true } }, { ok: true }];
    await expect(svc.setThreadSettings('t1', { model: 'opus', effort: 'max' })).rejects.toThrow();
    expect(claude.applied[1].change).toEqual({ model: null });
    expect(cfg('t1').model).toBeUndefined();
  });

  it('when the old model cannot be put back, the config follows the process and the error says so', async () => {
    seed('t1', { config: { model: 'sonnet', effort: 'low' } });
    claude.script = [{ ok: false, error: 'effort refused', partial: { model: true } }, { ok: false, error: 'gone' }];
    await expect(svc.setThreadSettings('t1', { model: 'opus', effort: 'max' })).rejects.toMatchObject({ message: expect.stringMatching(/effort refused.*model did change to opus/i) });
    expect(cfg('t1')).toMatchObject({ model: 'opus', effort: 'low' });
  });
});

describe('Codex efforts depend on the model (items 5 and 9)', () => {
  const luna = ['low', 'medium', 'high', 'xhigh', 'max'];
  const astra = [...luna, 'ultra'];
  beforeEach(() => { codex.efforts = { 'gpt-6-luna': luna, 'gpt-6-astra': astra }; });

  it('rejects an effort the model does not support, before anything is sent', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-luna' } });
    await expect(svc.setThreadSettings('x1', { effort: 'ultra' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/gpt-6-luna.*low, medium, high, xhigh, max/) });
    expect(codex.applied).toEqual([]);
    expect(cfg('x1').effort).toBeUndefined();
    await svc.setThreadSettings('x1', { effort: 'max' }); // every model has max
    expect(codex.applied[0].change).toEqual({ effort: 'max' });
  });

  it('accepts ultra on a model that has it', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    await svc.setThreadSettings('x1', { effort: 'ultra' });
    expect(cfg('x1').effort).toBe('ultra');
  });

  it('checks a model and an effort picked together against the NEW model', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra' } });
    await expect(svc.setThreadSettings('x1', { model: 'gpt-6-luna', effort: 'ultra' })).rejects.toMatchObject({ status: 400 });
  });

  it('a model switch clears a saved effort the new model cannot take, and says so', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'ultra' } });
    const r = await svc.setThreadSettings('x1', { model: 'gpt-6-luna' });
    expect(codex.applied[0].change).toEqual({ model: 'gpt-6-luna', effort: null });
    expect(cfg('x1').effort).toBeUndefined();
    expect(r.clearedEffort).toBe('ultra');
  });

  it('a model switch keeps an effort the new model also has', async () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'high' } });
    const r = await svc.setThreadSettings('x1', { model: 'gpt-6-luna' });
    expect(codex.applied[0].change).toEqual({ model: 'gpt-6-luna' });
    expect(cfg('x1').effort).toBe('high');
    expect(r.clearedEffort).toBeUndefined();
  });

  it('without a live list it uses the built-in table (Luna has no ultra)', async () => {
    codex.efforts = null;
    seed('x1', { type: 'codex', config: { model: 'gpt-6-luna' } });
    await expect(svc.setThreadSettings('x1', { effort: 'ultra' })).rejects.toMatchObject({ status: 400 });
    seed('x2', { type: 'codex', config: { model: 'gpt-5.6-sol' } });
    await svc.setThreadSettings('x2', { effort: 'ultra' });
    expect(cfg('x2').effort).toBe('ultra');
  });

  it('a start sends the saved effort to the app-server, including max and ultra, and drops one the model lost', () => {
    seed('x1', { type: 'codex', config: { model: 'gpt-6-astra', effort: 'ultra' }, live: false });
    svc.ensureStructuredAlive('x1');
    expect(codex.spawnOpts[0].effort).toBe('ultra');
    seed('x2', { type: 'codex', config: { model: 'gpt-6-luna', effort: 'ultra' }, live: false });
    svc.ensureStructuredAlive('x2');
    expect(codex.spawnOpts[1].effort).toBeUndefined();
  });
});

describe('a refused change is reported in the thread and the web reloads (items 6 and 10)', () => {
  it('posts a notice and tells the listener, for an immediate refusal', async () => {
    const changed: string[] = [];
    svc.setTerminalChangedListener((sid) => changed.push(sid));
    seed('t1', { config: { model: 'sonnet' } });
    claude.nextResult = { ok: false, error: "Model 'x' not found" };
    await expect(svc.setThreadSettings('t1', { model: 'opus' })).rejects.toThrow();
    expect(claude.notices).toHaveLength(1);
    expect(claude.notices[0]).toMatch(/model/i);
    expect(claude.notices[0]).toMatch(/not found/);
    expect(changed).toEqual(['s1']);
  });

  it('posts a notice and tells the listener, for a refusal after the wait', async () => {
    const changed: string[] = [];
    svc.setTerminalChangedListener((sid) => changed.push(sid));
    seed('t1', { config: { model: 'sonnet' } });
    claude.turnOpen = true;
    await svc.setThreadSettings('t1', { model: 'opus' });
    claude.nextResult = { ok: false, error: 'nope' };
    claude.emit('idle', 't1', { declared: false });
    await tick(); await tick();
    expect(cfg('t1').model).toBe('sonnet');
    expect(claude.notices).toHaveLength(1);
    expect(changed).toEqual(['s1']);
  });

  it('says nothing when the change worked', async () => {
    seed('t1');
    await svc.setThreadSettings('t1', { model: 'opus' });
    expect(claude.notices).toEqual([]);
  });
});
