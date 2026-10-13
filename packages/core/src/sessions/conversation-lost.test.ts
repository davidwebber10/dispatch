// #76: a structured Claude thread whose conversation is gone (Claude's transcript cleanup). The
// resume fails with "No conversation found", and every revive used to run the same doomed `-r`
// again. Now the manager's 'conversation-lost' clears the stored id (kept in config for the
// record), so the next revive starts a fresh conversation; and a spawn that throws names its cause.
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
import type { IStructuredManager, StructuredSpawnOpts } from '../structured/manager.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  spawns: string[] = [];
  kills: string[] = [];
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.kills.push(id); if (this.alive.delete(id)) this.emit('exit', id, 0); }
  spawn(id: string) { this.spawns.push(id); this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  spawnOpts: Record<string, StructuredSpawnOpts> = {};
  kills: string[] = [];
  setDefaultEnv() {}
  spawnError: Error | null = null;
  spawn(id: string, opts: StructuredSpawnOpts) { if (this.spawnError) throw this.spawnError; this.live.add(id); this.spawns.push(id); this.spawnOpts[id] = opts; return 4321; }
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
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.kills.push(id); this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let pty: FakePty;
let structured: FakeStructured;

function seed(id: string, opts: { config?: Record<string, any>; externalId?: string | null } = {}) {
  terminalsDb.create(db, {
    id,
    sessionId: 's1',
    type: 'claude-code',
    label: id,
    workingDir: path.join(dir, 'proj'),
    externalId: opts.externalId === undefined ? 'ext-1' : opts.externalId ?? undefined,
    config: opts.config ?? {},
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-conv-lost-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty();
  structured = new FakeStructured();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
  // Deterministic spawn command (and the seam that still appends `-r <id>` on resume).
  svc.setStructuredCommandOverride({ command: 'fake-claude', args: ['--fake'] });
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('a structured thread whose Claude conversation is gone (#76)', () => {
  it('clears the stored id, keeps it in config for the record, and keeps the transport', () => {
    seed('t1', { config: { transport: 'structured' }, externalId: 'gone-1' });
    structured.emit('conversation-lost', 't1', 'gone-1');
    const t = terminalsDb.getById(db, 't1')!;
    expect(t.external_id).toBeNull();
    const config = JSON.parse(t.config || '{}');
    expect(config.transport).toBe('structured');
    expect(config.lostConversation).toMatchObject({ externalId: 'gone-1' });
    expect(typeof config.lostConversation.at).toBe('string');
  });

  it('ignores a lost id that is not the stored one (a newer conversation already replaced it)', () => {
    seed('t2', { config: { transport: 'structured' }, externalId: 'current-2' });
    structured.emit('conversation-lost', 't2', 'gone-1');
    const t = terminalsDb.getById(db, 't2')!;
    expect(t.external_id).toBe('current-2');
    expect(JSON.parse(t.config || '{}').lostConversation).toBeUndefined();
  });

  it('the next send starts a fresh conversation instead of the doomed resume', () => {
    seed('t3', { config: { transport: 'structured' }, externalId: 'gone-3' });
    structured.emit('conversation-lost', 't3', 'gone-3');
    svc.sendStructuredMessage('t3', 'hello');
    expect(structured.spawns).toEqual(['t3']);
    expect(structured.spawnOpts['t3'].args).not.toContain('-r');
    expect(structured.spawnOpts['t3'].args).not.toContain('gone-3');
  });

  it('a spawn that throws: the send error names the cause instead of a bare "no structured session"', () => {
    seed('t4', { config: { transport: 'structured' }, externalId: 'ext-4' });
    structured.spawnError = new Error('spawn fake-claude ENOENT');
    expect(() => svc.sendStructuredMessage('t4', 'hello')).toThrow(/spawn fake-claude ENOENT/);
  });
});
