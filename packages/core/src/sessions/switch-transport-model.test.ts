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
