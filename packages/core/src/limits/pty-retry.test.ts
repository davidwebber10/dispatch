import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import { UsageLimitService } from './service.js';
import { PtyLimitWatcher } from './pty-watch.js';

// A CLI thread whose banner names no reset time is retried after 30 minutes. The watcher ignores a
// banner with the same text for 35 minutes (repaints), so a thread that hits the limit AGAIN right
// after the wake would be missed unless the wake clears the watcher's memory of that thread.
const MIN = 60_000;
const cases = [
  { name: 'Claude, no-time wording', type: 'claude-code', text: "  ⎿  You've hit your usage limit\r\n" },
  { name: 'Codex, no-time wording', type: 'codex', text: "■ You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits\r\n" },
];

describe.each(cases)('a repeat stop after a wake ($name)', ({ type, text }) => {
  let db: Database.Database;
  let svc: UsageLimitService;
  let w: PtyLimitWatcher;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 24, 4, 31));
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/tmp/p' });
    terminalsDb.create(db, { id: 't1', sessionId: 'proj', type, label: 'T', config: {} });
    terminalsDb.updateStatus(db, 't1', 'scheduled');
    svc = new UsageLimitService({ db, wake: () => {}, markPaused: () => {}, note: () => {} });
    w = new PtyLimitWatcher({
      isIdle: () => true,
      providerOf: () => type,
      onLimit: (id, limit, provider) => svc.park(id, provider, limit),
      confirmMs: 5000,
    });
    // The server wiring: a wake clears the watcher's memory of that thread, the service keeps its attempt count.
    svc.addWakeListener((id) => w.forget(id));
  });
  afterEach(() => { w.forget('t1'); svc.stop(); db.close(); vi.useRealTimers(); });

  it('is parked again with the attempt count kept', () => {
    w.feed('t1', text);
    vi.advanceTimersByTime(5000);
    expect(parksDb.get(db, 't1')).toMatchObject({ state: 'parked', attempts: 0, parsed: 0 });
    // The retry: 30 minutes plus the buffer.
    vi.advanceTimersByTime(32 * MIN);
    svc.tick();
    expect(parksDb.get(db, 't1')).toMatchObject({ state: 'woken', attempts: 1 });
    // The thread hits the same limit again, 2 minutes after the wake.
    vi.advanceTimersByTime(2 * MIN);
    w.feed('t1', text);
    vi.advanceTimersByTime(5000);
    expect(parksDb.get(db, 't1')).toMatchObject({ state: 'parked', attempts: 1 });
  });
  it('a repaint of the banner before any wake is still one stop', () => {
    w.feed('t1', text);
    vi.advanceTimersByTime(5000);
    const first = parksDb.get(db, 't1')!;
    vi.advanceTimersByTime(2 * MIN);
    w.feed('t1', text);
    vi.advanceTimersByTime(5000);
    expect(parksDb.get(db, 't1')!.parked_at).toBe(first.parked_at);
    expect(parksDb.get(db, 't1')).toMatchObject({ state: 'parked', attempts: 0 });
  });
});
