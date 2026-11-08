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

/** A PTY manager stub with just enough surface for spawnTerminal + the switch path. */
class FakePty extends EventEmitter {
  alive = new Set<string>();
  spawns: string[] = [];
  aliveOverride = false;
  isAlive(id: string) { return this.aliveOverride && this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  argvs: string[][] = [];
  spawn(id: string, _c?: string, args: string[] = []) { this.spawns.push(id); this.argvs.push(args); this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

/** A structured manager stub satisfying IStructuredManager (no real process). */
class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  interrupts: string[] = [];
  kills: string[] = [];
  setDefaultEnv() {}
  opts: any[] = [];
  spawn(id: string, o?: any) { this.live.add(id); this.spawns.push(id); this.opts.push(o); return 4321; }
  sendMessage() {}
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt(id: string) { this.interrupts.push(id); setImmediate(() => this.emit('idle', id)); return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  models = new Map<string, string>();
  setModelCalls: Array<[string, string]> = [];
  setModelError: Error | null = null;
  getModel(id: string) { return this.models.get(id); }
  async setModel(id: string, model: string) {
    this.setModelCalls.push([id, model]);
    if (this.setModelError) throw this.setModelError;
    const resolved = model === 'haiku' ? 'claude-haiku-5-5' : model;
    this.models.set(id, resolved);
    return resolved;
  }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.kills.push(id); this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let pty: FakePty;
let structured: FakeStructured;

/** Seed a thread with an explicit type/config/status/external_id. */
function seed(id: string, opts: { type?: string; config?: Record<string, any>; status?: string; externalId?: string | null } = {}) {
  terminalsDb.create(db, {
    id,
    sessionId: 's1',
    type: opts.type ?? 'claude-code',
    label: id,
    workingDir: path.join(dir, 'proj'),
    externalId: opts.externalId === undefined ? 'ext-1' : opts.externalId ?? undefined,
    config: opts.config ?? {},
  });
  if (opts.status) terminalsDb.updateStatus(db, id, opts.status);
}

const cfg = (id: string) => terminalsDb.rowToTerminal(terminalsDb.getById(db, id)!).config;

let origHome: string | undefined;
beforeEach(() => {
  origHome = process.env.HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-switch-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  process.env.HOME = dir;
  clearTranscriptPathCache();
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty();
  structured = new FakeStructured();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  clearTranscriptPathCache();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});


function writeTranscript(sessionId: string, lines: unknown[]) {
  const d = path.join(dir, '.claude', 'projects', path.join(dir, 'proj').replace(/[/.]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}
const turn = (model: string, effort: string, over: Record<string, unknown> = {}) => ({
  type: 'assistant', isSidechain: false, requestedModel: model, effort, message: { model, content: [] }, ...over,
});
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

describe('a model or effort changed inside the thread survives a relaunch', () => {
  it('CLI -> Pretty -> CLI keeps the /model and /effort the owner chose', async () => {
    seed('t1', { config: { model: 'fable' }, status: 'waiting' });
    // The owner ran /model Opus 5.5 and /effort high in the CLI: only the transcript shows it.
    writeTranscript('ext-1', [turn('claude-fable-5-1', 'xhigh'), turn('claude-opus-5-5', 'high')]);

    await svc.switchTransport('t1', 'structured');
    const prettyArgs: string[] = structured.opts[0].args;
    expect(flag(prettyArgs, '--model')).toBe('opus');
    expect(flag(prettyArgs, '--effort')).toBe('high');
    expect(cfg('t1')).toMatchObject({ model: 'opus', effort: 'high', transport: 'structured' });

    structured.live.delete('t1'); // the structured process is gone; PTY respawns on switch back
    await svc.switchTransport('t1', 'pty');
    const cliArgs = pty.argvs[pty.argvs.length - 1];
    expect(flag(cliArgs, '--model')).toBe('opus');
    expect(flag(cliArgs, '--effort')).toBe('high');
  });

  it('a revived Pretty thread (daemon restart) also reads the transcript', () => {
    seed('t2', { config: { model: 'fable', transport: 'structured' }, status: 'waiting' });
    writeTranscript('ext-1', [turn('claude-fable-5-1', 'xhigh'), turn('claude-opus-5-5', 'high')]);
    expect(svc.ensureStructuredAlive('t2')).toBe(true);
    expect(flag(structured.opts[0].args, '--model')).toBe('opus');
    expect(flag(structured.opts[0].args, '--effort')).toBe('high');
  });

  it('a sub-agent turn or a fallback model never replaces the lead model', async () => {
    seed('t1', { config: { model: 'claude-opus-5-5' }, status: 'waiting' });
    writeTranscript('ext-1', [
      turn('claude-opus-5-5', 'high'),
      turn('claude-haiku-5-5', 'low', { isSidechain: true }),
      turn('claude-opus-5-5', 'high', { message: { model: 'claude-sonnet-5-5', content: [] } }),
    ]);
    await svc.switchTransport('t1', 'structured');
    expect(flag(structured.opts[0].args, '--model')).toBe('claude-opus-5-5');
  });

  it('a thread nobody changed keeps its saved model and gets no pinned effort', async () => {
    seed('t1', { config: { model: 'opus', pinned: true }, status: 'waiting' });
    writeTranscript('ext-1', [turn('claude-opus-5-5', 'high'), turn('claude-opus-5-5', 'high')]);
    await svc.switchTransport('t1', 'structured');
    expect(flag(structured.opts[0].args, '--model')).toBe('opus');
    expect(structured.opts[0].args).not.toContain('--effort');
    expect(cfg('t1')).toMatchObject({ model: 'opus', pinned: true });
  });

  it('a thread with no saved model gets the family alias, not a frozen id', async () => {
    seed('t1', { config: {}, status: 'waiting' });
    writeTranscript('ext-1', [turn('claude-sonnet-5-5', 'medium')]);
    await svc.switchTransport('t1', 'structured');
    expect(flag(structured.opts[0].args, '--model')).toBe('sonnet');
  });

  it('leaves a coordinator or agent thread on its policy model', () => {
    seed('t3', { config: { model: 'fable', transport: 'structured', role: 'agent' }, status: 'waiting' });
    writeTranscript('ext-1', [turn('claude-haiku-5-5', 'low')]);
    svc.ensureStructuredAlive('t3');
    expect(flag(structured.opts[0].args, '--model')).toBe('fable');
    expect(structured.opts[0].args).not.toContain('--effort');
  });
});


function writeRollout(sessionId: string, models: Array<{ model: string; at: string }>) {
  const d = path.join(dir, '.codex', 'sessions', '2026', '11', '07');
  fs.mkdirSync(d, { recursive: true });
  const lines = models.map((m) => ({ timestamp: m.at, type: 'turn_context', payload: { turn_id: 't', cwd: path.join(dir, 'proj'), model: m.model } }));
  fs.writeFileSync(path.join(d, `rollout-2026-11-07T10-00-00-${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('Codex: the model the CLI ended on carries over to Pretty and back', () => {
  it('CLI -> Pretty resumes on the /model the owner picked in the CLI, and saves it', async () => {
    svc.setCodexStructuredManager(structured);
    seed('x1', { type: 'codex', config: { model: 'gpt-5.6-sol' }, status: 'waiting', externalId: 'cx-1' });
    writeRollout('cx-1', [{ model: 'gpt-5.6-sol', at: '2026-11-07T10:00:00Z' }, { model: 'gpt-5.6-luna', at: '2026-11-07T10:05:00Z' }]);
    await svc.switchTransport('x1', 'structured');
    expect(structured.opts[0].model).toBe('gpt-5.6-luna');
    expect(cfg('x1')).toMatchObject({ model: 'gpt-5.6-luna', transport: 'structured' });
  });

  it('a Pretty switch the CLI has not run yet is not undone by the older rollout', async () => {
    svc.setCodexStructuredManager(structured);
    seed('x2', { type: 'codex', config: { model: 'gpt-6-astra', modelSetAt: Date.parse('2026-11-07T11:00:00Z') }, status: 'waiting', externalId: 'cx-2' });
    writeRollout('cx-2', [{ model: 'gpt-5.6-sol', at: '2026-11-07T10:00:00Z' }]);
    await svc.switchTransport('x2', 'structured');
    expect(structured.opts[0].model).toBe('gpt-6-astra');
  });
});

describe('Claude: a switcher pick survives a relaunch before any turn ran on it', () => {
  it('the transcript is older than the pick, so the pick wins', async () => {
    seed('t9', { config: { model: 'haiku', modelSetAt: Date.now() + 60_000 }, status: 'waiting' });
    writeTranscript('ext-1', [turn('claude-opus-5-5', 'high', { timestamp: new Date().toISOString() })]);
    await svc.switchTransport('t9', 'structured');
    expect(flag(structured.opts[0].args, '--model')).toBe('haiku');
  });

  it('a /model in the CLI AFTER the pick wins over it', async () => {
    seed('t8', { config: { model: 'haiku', modelSetAt: Date.parse('2026-11-07T10:00:00Z') }, status: 'waiting' });
    writeTranscript('ext-1', [turn('claude-opus-5-5', 'high', { timestamp: '2026-11-07T10:05:00Z' })]);
    await svc.switchTransport('t8', 'structured');
    expect(flag(structured.opts[0].args, '--model')).toBe('opus');
  });
});

describe('setThreadModel — the Pretty model switcher', () => {
  it('switches a live Pretty thread natively and saves the pick', async () => {
    seed('p1', { config: { model: 'opus', transport: 'structured' }, status: 'waiting' });
    structured.live.add('p1');
    const res = await svc.setThreadModel('p1', 'haiku');
    expect(structured.setModelCalls).toEqual([['p1', 'haiku']]);
    expect(structured.kills).toEqual([]); // no restart
    expect(res.model).toBe('claude-haiku-5-5');
    expect(cfg('p1').model).toBe('haiku');
    expect(typeof cfg('p1').modelSetAt).toBe('number');
    expect(svc.activeModel('p1')).toBe('claude-haiku-5-5');
  });

  it('refuses while a turn runs (409), and leaves the config alone', async () => {
    seed('p2', { config: { model: 'opus', transport: 'structured' }, status: 'working' });
    structured.live.add('p2');
    await expect(svc.setThreadModel('p2', 'haiku')).rejects.toMatchObject({ status: 409 });
    expect(cfg('p2').model).toBe('opus');
  });

  it('a refused switch surfaces the harness error and keeps the old model', async () => {
    seed('p3', { config: { model: 'opus', transport: 'structured' }, status: 'waiting' });
    structured.live.add('p3');
    structured.setModelError = new Error('Unknown model bogus');
    await expect(svc.setThreadModel('p3', 'bogus')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Unknown model/) });
    expect(cfg('p3').model).toBe('opus');
  });

  it('a stopped Pretty thread just saves the pick for its next start', async () => {
    seed('p4', { config: { model: 'opus', transport: 'structured' }, status: 'waiting' });
    const res = await svc.setThreadModel('p4', 'sonnet');
    expect(structured.setModelCalls).toEqual([]);
    expect(res.model).toBe('sonnet');
    expect(cfg('p4').model).toBe('sonnet');
  });

  it('refuses a running CLI thread: its model belongs to the CLI (/model)', async () => {
    seed('p5', { config: { model: 'opus' }, status: 'waiting' });
    pty.alive.add('p5'); pty.aliveOverride = true;
    await expect(svc.setThreadModel('p5', 'haiku')).rejects.toMatchObject({ status: 409 });
  });

  it('activeModel falls back to the saved model before the harness reports one', () => {
    seed('p6', { config: { model: 'sonnet', transport: 'structured' }, status: 'waiting' });
    expect(svc.activeModel('p6')).toBe('sonnet');
    structured.live.add('p6'); structured.models.set('p6', 'claude-sonnet-5-5');
    expect(svc.activeModel('p6')).toBe('claude-sonnet-5-5');
  });
});
