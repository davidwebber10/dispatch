import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema.js';
import * as sessionsDb from '../src/db/sessions.js';
import * as terminalsDb from '../src/db/terminals.js';
import { TerminalMonitor } from '../src/terminal-monitor.js';

const OLD = '2020-01-01T00:00:00.000Z';

describe('TerminalMonitor activity stamping', () => {
  let db: Database.Database;
  let monitor: TerminalMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't' });
    db.prepare('UPDATE sessions SET last_activity_at = ?').run(OLD);
    db.prepare('UPDATE terminals SET last_activity_at = ?').run(OLD);
    monitor = new TerminalMonitor({ broadcast: vi.fn() } as any, db);
  });

  afterEach(() => vi.useRealTimers());

  const sessionActivity = () => (db.prepare("SELECT last_activity_at FROM sessions WHERE id = 's1'").get() as any).last_activity_at;
  const terminalActivity = () => (db.prepare("SELECT last_activity_at FROM terminals WHERE id = 't1'").get() as any).last_activity_at;

  it('does NOT stamp for a sub-busy-threshold burst (cursor blinks, tiny redraws)', () => {
    monitor.onOutput('t1', 'x'.repeat(100));
    vi.advanceTimersByTime(4000); // idle timer (3s) fires
    expect(sessionActivity()).toBe(OLD);
    expect(terminalActivity()).toBe(OLD);
  });

  it('stamps when a burst crosses the busy threshold outside the grace window', () => {
    monitor.onOutput('t1', 'boot');            // starts tracking; connection grace begins
    vi.advanceTimersByTime(6000);              // grace (5s) expires; first idle-fire stamped nothing
    monitor.onOutput('t1', 'y'.repeat(600));   // real work burst (>500 bytes) → busy
    vi.advanceTimersByTime(4000);              // idle timer fires while busy
    expect(sessionActivity()).not.toBe(OLD);
    expect(terminalActivity()).not.toBe(OLD);
  });

  it('suppress() re-arms the grace window so an attach/resize repaint does NOT stamp', () => {
    monitor.onOutput('t1', 'boot');
    vi.advanceTimersByTime(6000);              // well past the spawn grace
    monitor.suppress('t1');                    // client attaches → nudgeRepaint/resize incoming
    monitor.onOutput('t1', 'z'.repeat(2000));  // full-screen repaint, > busy threshold
    vi.advanceTimersByTime(4000);
    expect(sessionActivity()).toBe(OLD);
    expect(terminalActivity()).toBe(OLD);
  });

  it('suppress() on an untracked terminal starts it in the grace window', () => {
    monitor.suppress('t1');                    // attach before any output was ever seen
    monitor.onOutput('t1', 'z'.repeat(2000));
    vi.advanceTimersByTime(4000);
    expect(sessionActivity()).toBe(OLD);
  });
});
