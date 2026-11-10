// SessionService.isProcessAlive: one public answer to "does a process back this thread now",
// for a CLI (PTY) thread and for a structured (Pretty) thread (W3-B). The diagnostics route uses it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  isAlive(id: string) { return this.alive.has(id); }
}
class FakeStructured extends EventEmitter {
  live = new Set<string>();
  isAlive(id: string) { return this.live.has(id); }
}

let db: Database.Database;
let pty: FakePty;
let claude: FakeStructured;
let svc: SessionService;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/nowhere' });
  terminalsDb.create(db, { id: 'cli', sessionId: 's1', type: 'claude-code', label: 'cli' });
  terminalsDb.create(db, { id: 'pretty', sessionId: 's1', type: 'claude-code', label: 'pretty', config: { transport: 'structured' } });
  terminalsDb.create(db, { id: 'cx', sessionId: 's1', type: 'codex', label: 'cx', config: { transport: 'structured' } });
  pty = new FakePty();
  claude = new FakeStructured();
  svc = new SessionService(db, pty as any, '/nowhere/mcp.json');
  svc.registerStructuredManager('claude-code', claude as any);
});
afterEach(() => { db.close(); });

describe('SessionService.isProcessAlive', () => {
  it('a CLI thread: true while its PTY lives, false after', () => {
    pty.alive.add('cli');
    expect(svc.isProcessAlive('cli')).toBe(true);
    pty.alive.delete('cli');
    expect(svc.isProcessAlive('cli')).toBe(false);
  });

  it('a Pretty thread: true while its structured process lives, false after', () => {
    claude.live.add('pretty');
    expect(svc.isProcessAlive('pretty')).toBe(true);
    claude.live.delete('pretty');
    expect(svc.isProcessAlive('pretty')).toBe(false);
  });

  it('a thread whose type has no structured manager, and a thread that does not exist: false', () => {
    expect(svc.isProcessAlive('cx')).toBe(false);
    expect(svc.isProcessAlive('missing')).toBe(false);
  });
});
