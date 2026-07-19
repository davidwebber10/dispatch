import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as watchesDb from '../../src/db/watches.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

// thread_watches has no FK to terminals (by design — see db/watches.ts). archive() bulk
// hard-deletes every terminal in a session via terminalsDb.removeBySession, a SEPARATE
// delete path from removeTerminal (single-thread deletion). removeTerminal already sweeps
// thread_watches (see remove-terminal-watches.test.ts); archive() must do the same, before
// its bulk delete, or watch rows survive pointing at terminals that no longer exist.
class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'A' });
  terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'B' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-archive-watches-mcp.json');
  return { db, svc };
}

describe('archive cleans up thread_watches', () => {
  it('deletes watches for terminals in the archived session (watcher side)', () => {
    const { db, svc } = makeService();
    watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });

    svc.archive('s1');

    expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
    expect(watchesDb.listByTarget(db, 'b')).toHaveLength(0);
  });

  it('deletes watches for terminals in the archived session (target side, cross-session watcher)', () => {
    const { db, svc } = makeService();
    // A watcher living in a different session, watching a target inside s1.
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'q', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'c', sessionId: 's2', type: 'claude-code', label: 'C' });
    watchesDb.create(db, { watcherTerminalId: 'c', targetTerminalId: 'a', criteria: 'idle' });

    svc.archive('s1');

    expect(watchesDb.listByWatcher(db, 'c')).toHaveLength(0);
    expect(watchesDb.listByTarget(db, 'a')).toHaveLength(0);
  });

  it('is a no-op (does not throw) when the session has no watches', () => {
    const { svc } = makeService();
    expect(() => svc.archive('s1')).not.toThrow();
  });
});
