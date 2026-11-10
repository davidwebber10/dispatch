// The last folder (GET /api/state/last-directory) is the default folder of the new-project picker.
// A thread that runs in a worktree of the project must not change it (W3-B).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as appState from '../../src/db/app-state.js';
import { SessionService } from '../../src/sessions/service.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); }
  killAll() { this.alive.clear(); }
  write() {}
  spawn(id: string) { this.alive.add(id); return 1; }
  setDefaultEnv() {}
}

let tmp: string;
let db: Database.Database;
let svc: SessionService;
const proj = () => path.join(tmp, 'proj');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-last-dir-'));
  for (const d of ['proj/.claude/worktrees/w3-b/packages', 'proj/.worktrees/fix', 'other']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: proj() });
  svc = new SessionService(db, new FakePty() as any, path.join(tmp, 'data', 'mcp.json'));
  appState.set(db, 'last_directory', '/picked/before');
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the last folder and worktree threads', () => {
  it('a thread in a .claude/worktrees worktree keeps the last folder', () => {
    const t = svc.createTerminal('s1', 'claude-code', 'wt', undefined, path.join(proj(), '.claude', 'worktrees', 'w3-b'));
    expect(t.workingDir ?? (t as any).working_dir).toBe(path.join(proj(), '.claude', 'worktrees', 'w3-b'));
    expect(appState.get(db, 'last_directory')).toBe('/picked/before');
  });

  it('a thread in a folder inside a worktree, or in a .worktrees worktree, keeps the last folder', () => {
    svc.createTerminal('s1', 'claude-code', 'deep', undefined, path.join(proj(), '.claude', 'worktrees', 'w3-b', 'packages'));
    svc.createTerminal('s1', 'claude-code', 'dot', undefined, path.join(proj(), '.worktrees', 'fix'));
    expect(appState.get(db, 'last_directory')).toBe('/picked/before');
  });

  it('a runner thread in a worktree keeps the last folder', () => {
    svc.createRunnerTerminal('s1', 'claude-code', 'run', path.join(proj(), '.claude', 'worktrees', 'w3-b'), 'do it');
    expect(appState.get(db, 'last_directory')).toBe('/picked/before');
  });

  it('a thread in a folder that is not a worktree still sets the last folder (unchanged)', () => {
    svc.createTerminal('s1', 'claude-code', 'other', undefined, path.join(tmp, 'other'));
    expect(appState.get(db, 'last_directory')).toBe(path.join(tmp, 'other'));
  });

  it('a folder whose name only looks like a worktree folder still sets the last folder', () => {
    fs.mkdirSync(path.join(tmp, 'my.worktrees-notes'));
    svc.createTerminal('s1', 'claude-code', 'n', undefined, path.join(tmp, 'my.worktrees-notes'));
    expect(appState.get(db, 'last_directory')).toBe(path.join(tmp, 'my.worktrees-notes'));
  });
});
