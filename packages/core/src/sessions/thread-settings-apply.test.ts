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
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); return 1; }
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
  async applySettings(id: string, change: ThreadSettingsChange): Promise<ApplyResult> { this.applied.push({ id, change }); return this.nextResult; }
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
