import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as watchesDb from '../../src/db/watches.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

// thread_watches has no FK to terminals (by design — see db/watches.ts), so a deleted
// terminal's watch rows would otherwise accumulate forever. removeTerminal (the daemon's
// only "delete a thread" path — it soft-deletes/archives) must proactively sweep them.
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
  terminalsDb.create(db, { id: 'c', sessionId: 's1', type: 'claude-code', label: 'C' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-remove-terminal-watches-mcp.json');
  return { db, svc };
}

describe('removeTerminal cleans up thread_watches', () => {
  it('deletes watches where the removed terminal is the watcher', () => {
    const { db, svc } = makeService();
    watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });

    svc.removeTerminal('a');

    expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
    expect(watchesDb.listByTarget(db, 'b')).toHaveLength(0);
  });

  it('deletes watches where the removed terminal is the target', () => {
    const { db, svc } = makeService();
    watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });

    svc.removeTerminal('b');

    expect(watchesDb.listByWatcher(db, 'a')).toHaveLength(0);
    expect(watchesDb.listByTarget(db, 'b')).toHaveLength(0);
  });

  it('leaves unrelated watches untouched', () => {
    const { db, svc } = makeService();
    watchesDb.create(db, { watcherTerminalId: 'a', targetTerminalId: 'b', criteria: 'idle' });
    const unrelatedId = watchesDb.create(db, { watcherTerminalId: 'c', targetTerminalId: 'b', criteria: 'error' });

    svc.removeTerminal('a');

    const remaining = watchesDb.listByWatcher(db, 'c');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(unrelatedId);
  });

  it('is a no-op (does not throw) when the terminal has no watches', () => {
    const { svc } = makeService();
    expect(() => svc.removeTerminal('a')).not.toThrow();
  });
});
