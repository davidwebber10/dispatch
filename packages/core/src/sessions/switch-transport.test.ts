import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import type { IStructuredManager } from '../structured/manager.js';

/** A PTY manager stub with just enough surface for spawnTerminal + the switch path. */
class FakePty extends EventEmitter {
  alive = new Set<string>();
  spawns: string[] = [];
  aliveOverride = false;
  isAlive(id: string) { return this.aliveOverride && this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  spawn(id: string) { this.spawns.push(id); this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

/** A structured manager stub satisfying IStructuredManager (no real process). */
class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  interrupts: string[] = [];
  kills: string[] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); this.spawns.push(id); return 4321; }
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-switch-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty();
  structured = new FakeStructured();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('switchTransport — guards', () => {
  it('rejects a thread with no external_id yet (409)', async () => {
    seed('t1', { config: { transport: 'structured' }, status: 'waiting', externalId: null });
    await expect(svc.switchTransport('t1', 'pty')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a non claude/codex thread (409)', async () => {
    seed('t1', { type: 'shell', config: {}, status: 'waiting' });
    await expect(svc.switchTransport('t1', 'structured')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects switching to structured when the harness has no structured manager (409)', async () => {
    // Codex has no structured manager wired (Phase A) → cannot go Pretty.
    seed('t1', { type: 'codex', config: {}, status: 'waiting' });
    await expect(svc.switchTransport('t1', 'structured')).rejects.toMatchObject({ status: 409 });
  });

  it('is a no-op when already in the target transport', async () => {
    seed('t1', { config: { transport: 'structured', model: 'opus' }, status: 'waiting' });
    await svc.switchTransport('t1', 'structured');
    expect(structured.spawns).toEqual([]); // nothing respawned
    expect(cfg('t1')).toEqual({ transport: 'structured', model: 'opus' });
  });
});

describe('switchTransport — config merge preserves unrelated keys', () => {
  it('structured → pty drops only transport', async () => {
    structured.live.add('t1'); // a live structured session backs it
    seed('t1', { config: { transport: 'structured', model: 'opus', role: 'x', pinned: true }, status: 'waiting' });
    const t = await svc.switchTransport('t1', 'pty');
    expect(cfg('t1')).toEqual({ model: 'opus', role: 'x', pinned: true });
    expect(t.config).toEqual({ model: 'opus', role: 'x', pinned: true });
    expect(pty.spawns).toEqual(['t1']); // respawned as a PTY (resume)
  });

  it('pty → structured adds transport, keeps the rest', async () => {
    seed('t1', { config: { model: 'sonnet', pinned: true }, status: 'waiting' });
    const t = await svc.switchTransport('t1', 'structured');
    expect(cfg('t1')).toEqual({ model: 'sonnet', pinned: true, transport: 'structured' });
    expect(t.config).toEqual({ model: 'sonnet', pinned: true, transport: 'structured' });
    expect(structured.spawns).toEqual(['t1']); // respawned structured (resume)
  });
});

describe('switchTransport — busy handling', () => {
  it('rejects a busy PTY thread (no interruptible session)', async () => {
    seed('t1', { config: {}, status: 'working' });
    await expect(svc.switchTransport('t1', 'structured')).rejects.toMatchObject({ status: 409 });
  });

  it('with force (the user confirmed), a busy PTY thread is stopped and restarted structured (2026-11-06)', async () => {
    seed('t1', { config: { model: 'opus' }, status: 'working' });
    const t = await svc.switchTransport('t1', 'structured', { force: true });
    expect(cfg('t1')).toEqual({ model: 'opus', transport: 'structured' });
    expect(structured.spawns).toEqual(['t1']); // resumed in Pretty
    expect(t.config).toEqual({ model: 'opus', transport: 'structured' });
  });

  it('interrupts a busy structured thread, awaits the turn boundary, then switches', async () => {
    structured.live.add('t1');
    seed('t1', { config: { transport: 'structured' }, status: 'working' });
    const t = await svc.switchTransport('t1', 'pty');
    expect(structured.interrupts).toEqual(['t1']); // interrupt-then-switch
    expect(structured.kills).toContain('t1');
    expect(cfg('t1')).toEqual({});
    expect(pty.spawns).toEqual(['t1']);
    expect(t.config).toEqual({});
  });
});

describe('switchTransport — key revoke order', () => {
  it('stops the old process BEFORE it revokes the thread key (its last status call must still be accepted)', async () => {
    seed('t1', { config: { transport: 'structured' }, status: 'idle' });
    structured.live.add('t1');
    const order: string[] = [];
    const origKill = structured.kill.bind(structured);
    structured.kill = (id: string) => { order.push('kill'); origKill(id); };
    (svc as any).revokeAllKeys = () => { order.push('revoke'); };

    await svc.switchTransport('t1', 'pty');

    expect(order.indexOf('kill')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('revoke')).toBeGreaterThan(order.indexOf('kill'));
  });

  it('also stops the old PTY before the revoke when switching to Pretty', async () => {
    seed('t1', { config: {}, status: 'idle' });
    pty.aliveOverride = true;
    pty.alive.add('t1');
    const order: string[] = [];
    const origKill = pty.kill.bind(pty);
    pty.kill = (id: string) => { order.push('kill'); origKill(id); pty.emit('exit', id, 0); };
    (svc as any).revokeAllKeys = () => { order.push('revoke'); };

    await svc.switchTransport('t1', 'structured');

    expect(order.indexOf('kill')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('revoke')).toBeGreaterThan(order.indexOf('kill'));
  });
});

describe('switchTransport — a failed turn does not block the switch', () => {
  it('switches a PTY thread whose turn ended in error', async () => {
    seed('t1', { config: {}, status: 'error' });
    const t = await svc.switchTransport('t1', 'structured');
    expect(t.config.transport).toBe('structured');
  });
});

describe('structured process restart keeps the stored pid current', () => {
  it('writes the new process number when the manager reports a restart', () => {
    seed('t1', { config: { transport: 'structured' }, status: 'idle' });
    terminalsDb.updatePid(db, 't1', 111);
    structured.emit('process-restarted', 't1', 222);
    expect(terminalsDb.getById(db, 't1')!.pid).toBe(222);
  });

  it('ignores a restart for a thread that no longer exists', () => {
    expect(() => structured.emit('process-restarted', 'gone', 222)).not.toThrow();
  });
});
