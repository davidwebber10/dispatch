import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import * as gaugeSettings from './gauge-settings.js';
import { LimitSnapshots } from './snapshot.js';
import { UsageGauge } from './gauge.js';
import { CHAT_ID } from './service.js';

const ZONE = 'America/Indianapolis';
const T0 = Date.UTC(2026, 10, 5, 4, 0); // 23:00 local, Nov 4
const RESET = Date.UTC(2026, 10, 5, 6, 10); // 1:10 AM local
const WEEK = Date.UTC(2026, 10, 9, 14, 0);
const MIN = 60_000;

let db: Database.Database;
let snaps: LimitSnapshots;
let clock: number;
let account: string;
let events: any[];
let pushes: { title: string; body: string; tag: string }[];
let gauge: UsageGauge;
let refreshed: string[];

const make = () => {
  const g = new UsageGauge({
    db, snapshots: snaps, accountFor: () => account, now: () => clock, zone: ZONE,
    broadcast: (e) => events.push(e),
    push: { notifyAccount: async (i) => { pushes.push(i); } },
    refreshCodex: (id) => refreshed.push(id),
  });
  snaps.addRecordListener((p) => g.onRecord(p));
  return g;
};
const claude = (five: number | null, week: number | null, extra: Record<string, any> = {}) =>
  snaps.record('claude-code', account, { five_hour: { usedPercent: five, resetsAt: RESET }, seven_day: { usedPercent: week, resetsAt: WEEK }, ...extra }, clock);
const thread = (id: string, type = 'claude-code') => {
  if (!sessionsDb.getById(db, 'proj')) sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/tmp/p' });
  terminalsDb.create(db, { id, sessionId: 'proj', type, label: `T ${id}` });
};
const park = (id: string, o: Partial<parksDb.ParkRow> = {}) => parksDb.upsert(db, {
  terminal_id: id, provider: 'claude-code', kind: 'session', resets_at: RESET, wake_at: RESET + 90_000, message: 'm', parsed: 1, attempts: 0, state: 'parked', parked_at: clock, ...o,
}, clock);

beforeEach(() => {
  vi.useFakeTimers();
  db = new Database(':memory:');
  initSchema(db);
  snaps = new LimitSnapshots(db);
  clock = T0; account = 'acct-A'; events = []; pushes = []; refreshed = [];
  gauge = make();
});
afterEach(() => { gauge.stop(); vi.useRealTimers(); db.close(); });

describe('summary', () => {
  it('is empty with no snapshot, and never carries the account id', () => {
    expect(gauge.summary()).toEqual({ type: 'usage-limits', at: T0, warnPercent: 80, pushOnWarn: true, providers: [], paused: [] });
    claude(46.4, 21);
    const s = gauge.summary();
    expect(s.providers).toEqual([{ provider: 'claude-code', plan: undefined, asOf: T0, windows: { five_hour: { usedPercent: 46, resetsAt: RESET }, seven_day: { usedPercent: 21, resetsAt: WEEK } } }]);
    expect(JSON.stringify(s)).not.toContain('acct-A');
  });

  it('shows only the current account', () => {
    claude(46, 21);
    account = 'acct-B';
    expect(gauge.summary().providers).toEqual([]);
  });

  it('groups paused threads by provider: counts, capped, earliest reset, first thread, episode', () => {
    thread('a'); thread('b');
    park('a', { parked_at: T0 + 5, resets_at: RESET + 10 * MIN });
    park('b', { parked_at: T0 + 1, resets_at: RESET });
    park(CHAT_ID, { parked_at: T0 + 9, state: 'capped' });
    park('x', { provider: 'codex', kind: 'weekly', parked_at: T0 + 2 });
    parksDb.upsert(db, { terminal_id: 'w', provider: 'claude-code', kind: 'session', resets_at: RESET, wake_at: RESET, message: 'm', parsed: 1, attempts: 1, state: 'woken', parked_at: T0 }, T0);
    const p = gauge.summary().paused;
    const c = p.find((g) => g.provider === 'claude-code')!;
    expect(c).toEqual({ provider: 'claude-code', kind: 'session', earliestResetsAt: RESET, threads: 3, capped: 1, chat: true, firstTerminalId: 'b', firstSessionId: 'proj', episodeStartedAt: T0 + 1, latestStartedAt: T0 + 9, activeUntil: RESET + 10 * MIN });
    expect(p.find((g) => g.provider === 'codex')).toMatchObject({ kind: 'weekly', threads: 1, firstSessionId: null });
  });

  it('activeUntil is the latest reset (or wake time when none was read) over every row, capped included', () => {
    thread('a'); thread('b');
    park('a', { state: 'capped', resets_at: RESET });
    park('b', { resets_at: null, wake_at: RESET + 3 * 60 * MIN, parsed: 0 });
    expect(gauge.summary().paused[0].activeUntil).toBe(RESET + 3 * 60 * MIN);
    parksDb.remove(db, 'b');
    expect(gauge.summary().paused[0].activeUntil).toBe(RESET);
  });

  it('mixed kinds: weekly beats session', () => {
    thread('a'); thread('b');
    park('a', { kind: 'weekly', parked_at: T0 });
    park('b', { kind: 'session', parked_at: T0 + 10 });
    expect(gauge.summary().paused[0].kind).toBe('weekly');
  });

  it('Chat alone: the first thread is Chat', () => {
    park(CHAT_ID);
    expect(gauge.summary().paused[0]).toMatchObject({ chat: true, threads: 1, firstTerminalId: CHAT_ID, firstSessionId: null });
  });
});

describe('archived threads and the push switch', () => {
  it('a paused or capped row of an archived thread is not shown', () => {
    thread('a'); thread('b');
    park('a', { state: 'capped' });
    park('b');
    db.prepare("UPDATE terminals SET archived_at = 'x' WHERE id = 'a'").run();
    const g = gauge.summary().paused[0];
    expect(g).toMatchObject({ threads: 1, capped: 0, firstTerminalId: 'b' });
    db.prepare("UPDATE terminals SET archived_at = 'x' WHERE id = 'b'").run();
    expect(gauge.summary().paused).toEqual([]);
    expect(gauge.activePauses('claude-code')).toEqual([]);
  });

  it('the summary carries the push switch, so other devices follow it', () => {
    expect(gauge.summary().pushOnWarn).toBe(true);
    gaugeSettings.set(db, { pushOnWarn: false });
    gauge.settingsChanged();
    expect(events.at(-1)).toMatchObject({ pushOnWarn: false });
  });

  it('the summary is stamped with the time it was built, outside the change check', () => {
    claude(46, 21);
    gauge.pausesChanged();
    const n = events.length;
    clock += 3 * MIN;
    gauge.pausesChanged();
    expect(events).toHaveLength(n); // same figures: no new event just for a new stamp
    expect(gauge.summary().at).toBe(clock);
  });
});

describe('nearLimit and activePauses (for a future spawn guard)', () => {
  it('names the highest counted live window at or above the threshold', () => {
    claude(79, 20);
    expect(gauge.nearLimit('claude-code')).toBeNull();
    claude(80, 20);
    expect(gauge.nearLimit('claude-code')).toEqual({ windowType: 'five_hour', usedPercent: 80, resetsAt: RESET });
    claude(81, 20, { seven_day_opus: { usedPercent: 90, resetsAt: WEEK } });
    expect(gauge.nearLimit('claude-code')?.windowType).toBe('seven_day_opus');
  });
  it('ignores overage, a null figure, and a window past its reset', () => {
    claude(null, 20, { overage: { usedPercent: 99, resetsAt: WEEK } });
    expect(gauge.nearLimit('claude-code')).toBeNull();
    claude(95, 20);
    clock = RESET + 1;
    expect(gauge.nearLimit('claude-code')).toBeNull();
  });
  it('lists the provider\'s paused rows', () => {
    thread('a');
    park('a');
    park('x', { provider: 'codex' });
    expect(gauge.activePauses('claude-code').map((r) => r.terminal_id)).toEqual(['a']);
  });
});

describe('threshold push', () => {
  it('sends one push per window, with template copy and a coalescing tag', async () => {
    claude(46, 21);
    expect(pushes).toEqual([]);
    claude(82, 21);
    claude(85, 21);
    clock += 30 * MIN;
    claude(90, 21);
    expect(pushes).toEqual([{ title: 'Claude usage at 82%', body: 'Session (5h) window, resets 1:10 AM.', tag: 'usage-claude-code-five_hour' }]);
  });

  it('treats the threshold exactly as crossed', () => {
    claude(80, 21);
    expect(pushes).toHaveLength(1);
  });

  it('a reset that jitters inside 10 minutes is the same window, a new reset is a new one', () => {
    claude(85, 21);
    snaps.record('claude-code', account, { five_hour: { usedPercent: 86, resetsAt: RESET + 60_000 } }, clock + 1);
    expect(pushes).toHaveLength(1);
    clock = RESET + MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 81, resetsAt: RESET + 5 * 60 * MIN } }, clock);
    expect(pushes).toHaveLength(2);
  });

  it('a reset that jitters across a 10-minute rounding boundary is still the same window', () => {
    const edge = Date.UTC(2026, 10, 5, 6, 5); // exactly between two 10-minute buckets
    snaps.record('claude-code', account, { five_hour: { usedPercent: 85, resetsAt: edge - 1000 } }, clock);
    snaps.record('claude-code', account, { five_hour: { usedPercent: 86, resetsAt: edge + 1000 } }, clock + 1);
    expect(pushes).toHaveLength(1);
  });

  it('a reset that moves 20 minutes is a new window', () => {
    snaps.record('claude-code', account, { five_hour: { usedPercent: 85, resetsAt: RESET } }, clock);
    snaps.record('claude-code', account, { five_hour: { usedPercent: 86, resetsAt: RESET + 20 * MIN } }, clock + 1);
    expect(pushes).toHaveLength(2);
  });

  it('never pushes for overage, and names a weekly day', () => {
    claude(10, 88, { overage: { usedPercent: 99, resetsAt: WEEK } });
    expect(pushes).toEqual([{ title: 'Claude usage at 88%', body: 'Weekly window, resets Mon 9:00 AM.', tag: 'usage-claude-code-seven_day' }]);
  });

  it('does not repeat after a restart (a new instance on the same db)', () => {
    claude(85, 21);
    expect(pushes).toHaveLength(1);
    gauge.stop();
    snaps = new LimitSnapshots(db);
    gauge = make();
    claude(87, 21);
    expect(pushes).toHaveLength(1);
  });

  it('an account switch alerts again in its own window', () => {
    claude(85, 21);
    account = 'acct-B';
    claude(85, 21);
    expect(pushes).toHaveLength(2);
  });

  it('changing the threshold never pushes, and marks windows already over it', () => {
    claude(70, 21);
    gaugeSettings.set(db, { warnPercent: 60 });
    gauge.settingsChanged();
    expect(pushes).toEqual([]);
    claude(72, 21);
    expect(pushes).toEqual([]);
    // Raising it again does not re-arm the window that already counted as alerted.
    gaugeSettings.set(db, { warnPercent: 71 });
    gauge.settingsChanged();
    claude(75, 21);
    expect(pushes).toEqual([]);
  });

  it('push off: the alert key is still written, nothing is sent', () => {
    gaugeSettings.set(db, { pushOnWarn: false });
    claude(85, 21);
    expect(pushes).toEqual([]);
    gaugeSettings.set(db, { pushOnWarn: true });
    claude(86, 21);
    expect(pushes).toEqual([]);
  });

  it('prunes alert keys past their reset', () => {
    claude(85, 21);
    clock = RESET + MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 81, resetsAt: RESET + 5 * 60 * MIN } }, clock);
    const stored = JSON.parse((db.prepare("SELECT value FROM app_state WHERE key = 'usage_limit_alerts'").get() as { value: string }).value);
    expect(Object.keys(stored)).toHaveLength(1);
    expect(Object.keys(stored)[0]).toContain(String(RESET + 5 * 60 * MIN));
  });
});

describe('broadcast', () => {
  it('throttles: 20 records in 5 s give one event, on the trailing edge', () => {
    for (let i = 0; i < 20; i++) { clock += 200; claude(40 + i, 21); }
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('usage-limits');
    expect(events[0].providers[0].windows.five_hour.usedPercent).toBe(59);
  });

  it('skips a payload that did not change after rounding', () => {
    claude(46.1, 21);
    vi.advanceTimersByTime(5000);
    clock += 1000;
    claude(46.3, 21);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
  });

  it('a pause change sends at once', () => {
    thread('a');
    park('a');
    gauge.pausesChanged();
    expect(events).toHaveLength(1);
    expect(events[0].paused[0].threads).toBe(1);
  });

  it('a settings change sends at once with the new threshold', () => {
    gaugeSettings.set(db, { warnPercent: 90 });
    gauge.settingsChanged();
    expect(events).toEqual([{ type: 'usage-limits', at: T0, warnPercent: 90, pushOnWarn: true, providers: [], paused: [] }]);
  });
});

describe('Codex refresh tick', () => {
  it('refreshes from the most recently active Codex thread, only within 10 minutes', () => {
    thread('c1', 'codex'); thread('c2', 'codex'); thread('k', 'claude-code');
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ? WHERE id = ?').run('e1', new Date(T0 - 5 * MIN).toISOString(), 'c1');
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ? WHERE id = ?').run('e2', new Date(T0 - 2 * MIN).toISOString(), 'c2');
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ? WHERE id = ?').run('e3', new Date(T0).toISOString(), 'k');
    gauge.tick();
    expect(refreshed).toEqual(['c2']);
    clock = T0 + 20 * MIN;
    gauge.tick();
    expect(refreshed).toEqual(['c2']);
  });

  it('keeps polling a Codex thread that is still working, however old its last activity', () => {
    thread('c1', 'codex'); thread('c2', 'codex');
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ?, status = ? WHERE id = ?').run('e1', new Date(T0 - 40 * MIN).toISOString(), 'working', 'c1');
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ?, status = ? WHERE id = ?').run('e2', new Date(T0 - 40 * MIN).toISOString(), 'idle', 'c2');
    gauge.tick();
    expect(refreshed).toEqual(['c1']);
  });
  it('does not poll an archived working thread', () => {
    thread('c1', 'codex');
    db.prepare("UPDATE terminals SET external_id = 'e1', status = 'working', archived_at = 'x' WHERE id = 'c1'").run();
    gauge.tick();
    expect(refreshed).toEqual([]);
  });
});
