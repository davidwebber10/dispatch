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

describe('TerminalMonitor onThreadActivity callback (feeds ThreadAutoNamer)', () => {
  let db: Database.Database;
  let onThreadActivity: ReturnType<typeof vi.fn>;
  let monitor: TerminalMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't' });
    onThreadActivity = vi.fn();
    monitor = new TerminalMonitor({ broadcast: vi.fn() } as any, db, undefined, onThreadActivity);
  });

  afterEach(() => vi.useRealTimers());

  it('fires when a busy burst goes idle (crossed threshold outside the grace window)', () => {
    monitor.onOutput('t1', 'boot');            // starts tracking; connection grace begins
    vi.advanceTimersByTime(6000);              // grace (5s) expires
    monitor.onOutput('t1', 'y'.repeat(600));   // real work burst (>500 bytes) -> busy
    vi.advanceTimersByTime(4000);              // idle timer fires while busy
    expect(onThreadActivity).toHaveBeenCalledWith('t1');
  });

  it('does NOT fire for a connection-grace repaint (suppress)', () => {
    monitor.onOutput('t1', 'boot');
    vi.advanceTimersByTime(6000);              // well past the spawn grace
    monitor.suppress('t1');                    // client attaches -> nudgeRepaint/resize incoming
    monitor.onOutput('t1', 'z'.repeat(2000));  // full-screen repaint, > busy threshold
    vi.advanceTimersByTime(4000);
    expect(onThreadActivity).not.toHaveBeenCalled();
  });
});

// W1-E: `terminal:activity` goes out only when the payload differs from the last one sent for that terminal.
describe('TerminalMonitor activity events', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let onActivity: ReturnType<typeof vi.fn>;
  let monitor: TerminalMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    broadcast = vi.fn();
    onActivity = vi.fn();
    monitor = new TerminalMonitor({ broadcast } as any, undefined, onActivity);
  });
  afterEach(() => vi.useRealTimers());

  const events = (id = 't1') => broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:activity' && e.terminalId === id);

  it('two equal updates send one event', () => {
    // A terminal that prints a short line now and then: each idle timer found it idle, with the same HUD values.
    for (let i = 0; i < 5; i++) {
      monitor.onOutput('t1', 'tick');
      vi.advanceTimersByTime(4000); // the 3 s idle timer fires
    }
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ activity: 'idle', model: null });
    // The in-process listener still hears every update (agent runs read it).
    expect(onActivity).toHaveBeenCalledTimes(5);
  });

  it('a model change sends an event', () => {
    monitor.onOutput('t1', 'Opus 4.6 (1M context)');
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ model: 'Opus 4.6', context: '1M' });
    monitor.onOutput('t1', 'Opus 4.6 (1M context)');   // the same status bar again: nothing new
    expect(events()).toHaveLength(1);
    monitor.onOutput('t1', 'Sonnet 4.5 (200k context)');
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ model: 'Sonnet 4.5', context: '200k' });
  });

  it('busy and idle each send one event, and a second terminal has its own last payload', () => {
    monitor.onOutput('t1', 'boot');
    monitor.onOutput('t2', 'boot');
    vi.advanceTimersByTime(6000);                      // past the grace window; both sent one idle event
    expect(events('t1')).toHaveLength(1);
    expect(events('t2')).toHaveLength(1);
    monitor.onOutput('t1', 'y'.repeat(600));           // busy
    monitor.onOutput('t1', 'y'.repeat(600));           // still busy: no second event
    expect(events('t1').map((e: any) => e.activity)).toEqual(['idle', 'busy']);
    vi.advanceTimersByTime(4000);                      // idle again
    expect(events('t1').map((e: any) => e.activity)).toEqual(['idle', 'busy', 'idle']);
    expect(events('t2')).toHaveLength(1);
  });

  it('remove() forgets the last payload, so a new terminal with the same id sends again', () => {
    monitor.onOutput('t1', 'tick');
    vi.advanceTimersByTime(4000);
    expect(events()).toHaveLength(1);
    monitor.remove('t1');
    monitor.onOutput('t1', 'tick');
    vi.advanceTimersByTime(4000);
    expect(events()).toHaveLength(2);
  });
});
