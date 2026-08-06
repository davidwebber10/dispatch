// restartTerminal for STRUCTURED threads — regression test for the silent no-op:
// the old implementation killed only via ptyManager, so a live structured thread was
// never killed and spawnStructured bailed on `manager.isAlive` — relaunch did nothing.
// The coordinator "Restart session" menu action rides this path, and a respawn is what
// re-reads the MCP config (a structured process loads its tools once, at spawn).
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
  spawn(id: string, opts: StructuredSpawnOpts) { this.live.add(id); this.spawns.push(id); this.spawnOpts[id] = opts; return 4321; }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-restart-'));
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

describe('restartTerminal — structured thread (the coordinator Restart action)', () => {
  it('kills the LIVE structured session, then respawns it resuming the same conversation', async () => {
    seed('t1', { config: { transport: 'structured', role: 'coordinator' } });
    structured.live.add('t1'); // a live structured process backs the thread

    const out = await svc.restartTerminal('t1');

    expect(structured.kills).toEqual(['t1']);              // the old process died…
    expect(structured.spawns).toEqual(['t1']);             // …and a fresh one spawned
    expect(structured.spawnOpts['t1'].args).toContain('-r');
    expect(structured.spawnOpts['t1'].args).toContain('ext-1'); // same conversation
    expect(out?.id).toBe('t1');
  });

  it('respawns a DEAD structured thread too (restart never strands a stopped coordinator)', async () => {
    seed('t2', { config: { transport: 'structured', role: 'coordinator' } });
    // not in structured.live — process already gone (e.g. stopped via /stop)

    await svc.restartTerminal('t2');

    expect(structured.spawns).toEqual(['t2']);
    expect(structured.spawnOpts['t2'].args).toContain('-r');
  });

  it('still restarts a plain PTY thread through the PTY manager (unchanged behavior)', async () => {
    seed('t3', { config: {} });
    pty.alive.add('t3');

    await svc.restartTerminal('t3');

    expect(pty.kills).toContain('t3');
    expect(pty.spawns).toEqual(['t3']);
    expect(structured.spawns).toEqual([]); // structured manager untouched
  });
});
