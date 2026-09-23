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

/** A PTY manager stub that RECORDS spawns — so the test can prove the ungoverned PTY path
 *  is never taken for a coordinator. */
class FakePty extends EventEmitter {
  alive = new Set<string>();
  spawns: string[] = [];
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  spawn(id: string) { this.spawns.push(id); this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

/** Claude structured manager stub (registered), so `structuredManagerFor('claude-code')` is
 *  defined but `structuredManagerFor('codex')` is NOT (no setCodexStructuredManager call). */
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
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let pty: FakePty;

function seed(id: string, opts: { type?: string; config?: Record<string, any> } = {}) {
  terminalsDb.create(db, {
    id,
    sessionId: 's1',
    type: opts.type ?? 'codex',
    label: id,
    workingDir: path.join(dir, 'proj'),
    externalId: 'ext-1',
    config: opts.config ?? {},
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cptyguard-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(new FakeStructured()); // claude only — NO codex structured manager
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('coordinator PTY-bypass guard (B2)', () => {
  it('spawnTerminal throws for a coordinator when no governed structured transport exists', () => {
    seed('t1', { type: 'codex', config: { role: 'coordinator', transport: 'structured' } });
    expect(() => (svc as any).spawnTerminal('t1')).toThrow(/coordinator .* governed structured/i);
    expect(pty.spawns).toEqual([]); // never fell through to the ungoverned PTY path
  });

  it('relaunchTerminal fails closed (status error, no PTY spawn) for such a coordinator', () => {
    seed('t1', { type: 'codex', config: { role: 'coordinator', transport: 'structured' } });
    svc.relaunchTerminal('t1');
    const t = terminalsDb.getById(db, 't1')!;
    expect(t.status).toBe('error');
    expect(pty.spawns).toEqual([]);
  });

  it('a NON-coordinator codex thread still falls through to the PTY path (unchanged)', () => {
    seed('t2', { type: 'codex', config: { transport: 'structured' } }); // no role
    (svc as any).spawnTerminal('t2');
    expect(pty.spawns).toEqual(['t2']); // ordinary threads keep the PTY fallback
  });

  it('switchTransport refuses to move a coordinator to PTY (409, thread left intact)', async () => {
    seed('t3', { type: 'claude-code', config: { role: 'coordinator', transport: 'structured' } });
    await expect(svc.switchTransport('t3', 'pty')).rejects.toMatchObject({ status: 409 });
    const t = terminalsDb.getById(db, 't3')!;
    expect(JSON.parse(t.config || '{}').transport).toBe('structured'); // config untouched
  });
});
