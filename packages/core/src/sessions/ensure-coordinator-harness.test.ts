import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import { SessionService } from './service.js';
import type { IStructuredManager } from '../structured/manager.js';

/** A PTY manager stub — ensureCoordinator always spawns structured, but the stub must
 *  still satisfy the interface in case a code path falls back to PTY unexpectedly. */
class FakePty extends EventEmitter {
  spawns: string[] = [];
  isAlive() { return false; }
  kill() {}
  spawn(id: string) { this.spawns.push(id); return 1234; }
  setDefaultEnv() {}
}

/** A structured manager stub satisfying IStructuredManager (no real process spawned). */
class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); this.spawns.push(id); return 4321; }
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
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let claudeStructured: FakeStructured;
let codexStructured: FakeStructured;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ensure-coordinator-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  claudeStructured = new FakeStructured();
  codexStructured = new FakeStructured();
  svc.setStructuredManager(claudeStructured);
  svc.setCodexStructuredManager(codexStructured);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ensureCoordinator — selectable coordinatorHarness', () => {
  it('defaults to claude-code when no coordinatorHarness is given', () => {
    const terminal = svc.ensureCoordinator('s1', {});
    expect(terminal.type).toBe('claude-code');
    expect(claudeStructured.spawns).toEqual([terminal.id]);
    expect(codexStructured.spawns).toEqual([]);
  });

  it('creates a codex-type coordinator when coordinatorHarness is codex', () => {
    const terminal = svc.ensureCoordinator('s1', { coordinatorHarness: 'codex' });
    expect(terminal.type).toBe('codex');
    expect(codexStructured.spawns).toEqual([terminal.id]);
    expect(claudeStructured.spawns).toEqual([]);
  });

  it('finding an existing coordinator ignores coordinatorHarness (idempotent)', () => {
    const first = svc.ensureCoordinator('s1', { coordinatorHarness: 'codex' });
    const second = svc.ensureCoordinator('s1', { coordinatorHarness: 'claude-code' });
    expect(second.id).toBe(first.id);
    expect(second.type).toBe('codex');
  });
});
