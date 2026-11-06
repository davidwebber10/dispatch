import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import * as gaugeSettings from './gauge-settings.js';
import { LimitSnapshots, parseClaudeRateLimit } from './snapshot.js';
import { UsageGauge } from './gauge.js';
import { CHAT_ID, UsageLimitService } from './service.js';

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
    expect(gauge.summary()).toEqual({ type: 'usage-limits', at: T0, epoch: expect.any(String), rev: expect.any(Number), warnPercent: 80, pushOnWarn: true, providers: [], paused: [] });
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

  it('activeUntil is the latest reset over every row, capped included; null while any row has none read', () => {
    thread('a'); thread('b'); thread('c');
    park('a', { state: 'capped', resets_at: RESET });
    park('c', { resets_at: RESET + 3 * 60 * MIN });
    expect(gauge.summary().paused[0].activeUntil).toBe(RESET + 3 * 60 * MIN);
    parksDb.remove(db, 'c');
    park('b', { resets_at: null, wake_at: RESET + 3 * 60 * MIN, parsed: 0 });
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    parksDb.remove(db, 'b');
    expect(gauge.summary().paused[0].activeUntil).toBe(RESET);
  });

  it('a row with no readable reset has no end time (null) while the limit may still hold, however old its retry time', () => {
    thread('a');
    park('a', { state: 'capped', resets_at: null, wake_at: RESET + 30 * MIN, parsed: 0 });
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    clock = RESET + 24 * 60 * MIN; // a day past the retry time: still unknown
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
  });

  it('fresh figures taken after the pause that show the window under 100% end an unknown-reset pause', () => {
    thread('a');
    park('a', { resets_at: null, parsed: 0, parked_at: T0 });
    // Figures from before the pause (or at the pause) prove nothing.
    snaps.record('claude-code', account, { five_hour: { usedPercent: 40, resetsAt: RESET } }, T0);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    // Fresh figures still at the limit: still active.
    clock = T0 + 5 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 100, resetsAt: RESET } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    // Fresh figures under 100%: the limit cleared, so the chip may leave red (end time = when we learned it).
    clock = T0 + 10 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 12, resetsAt: RESET }, seven_day: { usedPercent: 58, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
    // Another provider's figures say nothing about this one.
  });

  it('no real below-limit figure means unknown: an empty snapshot, only null percentages, or only windows past their reset', () => {
    thread('a');
    park('a', { kind: 'usage', resets_at: null, parsed: 0, parked_at: T0 }); // kind usage: the window is unknown, any window counts
    clock = T0 + 5 * MIN;
    snaps.record('claude-code', account, {}, clock, undefined, true); // a snapshot with no windows
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    snaps.record('claude-code', account, { five_hour: { usedPercent: null, resetsAt: RESET }, seven_day: { usedPercent: null, resetsAt: WEEK } }, clock + 1, undefined, true);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    snaps.record('claude-code', account, { five_hour: { usedPercent: 10, resetsAt: clock - 1 } }, clock + 2, undefined, true); // past its reset: not a live figure
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    // A live figure under 100% on any counted window does clear it.
    snaps.record('claude-code', account, { five_hour: { usedPercent: null, resetsAt: RESET }, seven_day: { usedPercent: 58, resetsAt: WEEK } }, clock + 3, undefined, true);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock + 3);
  });

  it('a null-percentage update after the limit hit does not clear it: the kept 20% is an old reading', () => {
    thread('a');
    snaps.record('claude-code', account, { five_hour: { usedPercent: 20, resetsAt: RESET } }, T0); // last reading, before the limit
    park('a', { resets_at: null, parsed: 0, parked_at: T0 + 10 * MIN, detected_at: T0 + 10 * MIN }); // the limit hits
    clock = T0 + 15 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: null, resetsAt: RESET } }, clock); // a report with a reset time and no figure
    expect(snaps.get('claude-code', account)!.windows.five_hour.usedPercent).toBe(20); // the old figure is kept
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    // Another window's real figure does not turn the old 20% into a new reading either.
    clock = T0 + 16 * MIN;
    snaps.record('claude-code', account, { seven_day: { usedPercent: 100, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    // A genuine new reading under 100% after the detection does clear it, stamped with its own time.
    clock = T0 + 20 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 12, resetsAt: RESET }, seven_day: { usedPercent: 58, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
  });

  it('when the limited window is unknown (kind usage), a new real figure on any window clears it, an old carried one does not', () => {
    thread('a');
    snaps.record('claude-code', account, { five_hour: { usedPercent: 20, resetsAt: RESET } }, T0);
    park('a', { kind: 'usage', resets_at: null, parsed: 0, parked_at: T0 + 10 * MIN, detected_at: T0 + 10 * MIN });
    clock = T0 + 20 * MIN;
    // A new real figure arrives on the weekly window only: it is a genuine new reading under 100%.
    snaps.record('claude-code', account, { seven_day: { usedPercent: 58, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
  });

  it('99.6% is below the limit even though it displays as 100%; 100.0% is not', () => {
    thread('a');
    park('a', { resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
    clock = T0 + MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 100, resetsAt: RESET } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    clock = T0 + 2 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 99.6, resetsAt: RESET } }, clock);
    expect(gauge.summary().providers[0].windows.five_hour.usedPercent).toBe(100); // shown rounded
    expect(gauge.summary().paused[0].activeUntil).toBe(clock); // but it is not at the limit
  });

  describe('a limit with no reset time clears only on the window that hit it', () => {
    const KINDS: [string, string, string][] = [['session', 'five_hour', 'seven_day'], ['weekly', 'seven_day', 'five_hour'], ['opus', 'seven_day_opus', 'five_hour'], ['sonnet', 'seven_day_sonnet', 'five_hour'], ['fable', 'seven_day_overage_included', 'five_hour']];
    it.each(KINDS)('%s limit: a fresh figure under 100%% on %s clears; on %s it does not', (kind, limited, other) => {
      thread('a');
      park('a', { kind: kind as any, resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
      clock = T0 + 5 * MIN;
      snaps.record('claude-code', account, { [other]: { usedPercent: 12, resetsAt: WEEK } }, clock);
      expect(gauge.summary().paused[0].activeUntil).toBeNull(); // another window's reading says nothing about this limit
      clock = T0 + 6 * MIN;
      snaps.record('claude-code', account, { [limited]: { usedPercent: null, resetsAt: WEEK } }, clock);
      expect(gauge.summary().paused[0].activeUntil).toBeNull(); // a blank update is not a reading
      clock = T0 + 7 * MIN;
      snaps.record('claude-code', account, { [limited]: { usedPercent: 12, resetsAt: WEEK } }, clock);
      expect(gauge.summary().paused[0].activeUntil).toBe(clock);
    });
    it('the limited window still at the limit keeps it red, whatever the other windows say', () => {
      thread('a');
      park('a', { kind: 'opus', resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
      clock = T0 + 5 * MIN;
      snaps.record('claude-code', account, { seven_day_opus: { usedPercent: 100, resetsAt: WEEK }, five_hour: { usedPercent: 3, resetsAt: RESET } }, clock);
      expect(gauge.summary().paused[0].activeUntil).toBeNull();
    });
    it('kind usage (the window could not be named) keeps the any-window rule', () => {
      thread('a');
      park('a', { kind: 'usage', resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
      clock = T0 + 5 * MIN;
      snaps.record('claude-code', account, { seven_day: { usedPercent: 12, resetsAt: WEEK } }, clock);
      expect(gauge.summary().paused[0].activeUntil).toBe(clock);
    });
  });

  it('99.96% read through the real Claude parser is below the limit; 100% is not', () => {
    thread('a');
    park('a', { resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
    const ingest = (utilization: number, at: number) => { clock = at; snaps.record('claude-code', account, parseClaudeRateLimit({ unifiedWindows: { five_hour: { utilization, resetsAt: Math.floor(RESET / 1000) } } }), at); };
    ingest(1, T0 + MIN);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    ingest(0.9996, T0 + 2 * MIN);
    expect(gauge.summary().paused[0].activeUntil).toBe(T0 + 2 * MIN);
  });

  it('once cleared it stays cleared: the reading expiring, or a restart, does not turn it red again, and a new detection does', () => {
    thread('a');
    park('a', { resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
    clock = T0 + 5 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 12, resetsAt: RESET } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
    // The clearing reading's window passes its reset, and the snapshot later drops it.
    clock = RESET + 2 * 3600_000;
    snaps.record('claude-code', account, { seven_day: { usedPercent: 3, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(T0 + 5 * MIN);
    // A restart (a new gauge and snapshots over the same db) keeps it too.
    gauge.stop();
    snaps = new LimitSnapshots(db);
    gauge = make();
    expect(gauge.summary().paused[0].activeUntil).toBe(T0 + 5 * MIN);
    // A new detection of the limit starts over: red again until a fresh reading.
    park('a', { resets_at: null, parsed: 0, parked_at: T0, detected_at: clock + MIN });
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
  });

  it('a weekly limit (even one that was really the Opus window) is held while any seven_day window is at 100%', () => {
    thread('a');
    park('a', { kind: 'weekly', resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
    clock = T0 + 5 * MIN;
    // Fresh weekly reading under 100%, but Opus weekly is the one at the limit.
    snaps.record('claude-code', account, { seven_day: { usedPercent: 40, resetsAt: WEEK }, seven_day_opus: { usedPercent: 100, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    clock = T0 + 10 * MIN;
    snaps.record('claude-code', account, { seven_day: { usedPercent: 40, resetsAt: WEEK }, seven_day_opus: { usedPercent: 60, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
  });

  it('an unknown-kind Codex stop keeps the any-window rule', () => {
    thread('c', 'codex');
    park('c', { provider: 'codex', kind: 'usage', resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 });
    clock = T0 + 5 * MIN;
    snaps.record('codex', account, { seven_day: { usedPercent: 12, resetsAt: WEEK } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
  });

  it('figures from before the latest detection do not clear a renewed limit, only newer ones', () => {
    thread('a');
    // The chain began at T0; the limit was detected again at T0 + 10 min (a resume that hit it again).
    park('a', { resets_at: null, parsed: 0, parked_at: T0, detected_at: T0 + 10 * MIN });
    clock = T0 + 5 * MIN;
    snaps.record('claude-code', account, { five_hour: { usedPercent: 12, resetsAt: RESET } }, clock); // newer than the chain, older than the detection
    clock = T0 + 12 * MIN;
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
    snaps.record('claude-code', account, { five_hour: { usedPercent: 12, resetsAt: RESET } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBe(clock);
  });

  it('another provider\'s figures do not clear it', () => {
    thread('a');
    park('a', { resets_at: null, parsed: 0, parked_at: T0 });
    clock = T0 + MIN;
    snaps.record('codex', 'acct-A', { five_hour: { usedPercent: 5, resetsAt: RESET } }, clock);
    expect(gauge.summary().paused[0].activeUntil).toBeNull();
  });

  it('a new figure that clears the pause is broadcast', () => {
    thread('a');
    park('a', { resets_at: null, parsed: 0, parked_at: T0 });
    gauge.pausesChanged();
    const n = events.length;
    clock = T0 + 10 * MIN;
    claude(12, 58);
    vi.advanceTimersByTime(5000);
    expect(events.length).toBe(n + 1);
    expect(events.at(-1).paused[0].activeUntil).toBe(clock);
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

describe('the chip across failed wakes (D1, D2)', () => {
  it('an earlier failed send leaves the chip red (no end time); the last failed send ends it', () => {
    thread('a');
    const svc = new UsageLimitService({
      db, now: () => clock, zone: ZONE,
      wake: () => { throw new Error('no pty'); }, markPaused: () => {}, note: () => {},
    });
    svc.park('a', 'claude-code', { kind: 'session', resetsAt: null, message: 'm' });
    for (let i = 1; i <= 4; i++) {
      clock = parksDb.get(db, 'a')!.wake_at + 1;
      svc.tick();
      expect(gauge.summary().paused[0].activeUntil).toBeNull();
    }
    clock = parksDb.get(db, 'a')!.wake_at + 1;
    svc.tick();
    const g = gauge.summary().paused[0];
    expect(g.capped).toBe(1); // the banner still lists it
    expect(g.activeUntil).toBe(clock); // the chip may leave red
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

  it('still matches an alert key written by the 3.11 rounded format', () => {
    const rounded = Math.round(RESET / (10 * MIN)) * 10 * MIN;
    db.prepare("INSERT INTO app_state (key, value) VALUES ('usage_limit_alerts', ?)").run(JSON.stringify({ [`claude-code|acct-A|five_hour|${rounded}`]: rounded }));
    claude(85, 21);
    expect(pushes).toHaveLength(0);
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
    expect(events).toEqual([{ type: 'usage-limits', at: T0, epoch: expect.any(String), rev: expect.any(Number), warnPercent: 90, pushOnWarn: true, providers: [], paused: [] }]);
  });
});

describe('Codex refresh tick', () => {
  const codex = (id: string, ext: string, at: number, status = 'waiting') =>
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ?, status = ? WHERE id = ?').run(ext, new Date(at).toISOString(), status, id);

  it('refreshes the recently active Codex threads, newest first, only within 10 minutes', () => {
    thread('c1', 'codex'); thread('c2', 'codex'); thread('k', 'claude-code');
    codex('c1', 'e1', T0 - 5 * MIN);
    codex('c2', 'e2', T0 - 2 * MIN);
    db.prepare('UPDATE terminals SET external_id = ?, last_activity_at = ? WHERE id = ?').run('e3', new Date(T0).toISOString(), 'k');
    gauge.tick();
    expect(refreshed).toEqual(['c2', 'c1']);
    clock = T0 + 20 * MIN;
    refreshed = [];
    gauge.tick();
    expect(refreshed).toEqual([]);
  });

  // Review finding 1: a Codex turn longer than 10 minutes writes no activity, and was never polled.
  it('keeps polling a working Codex thread whose last activity is old', () => {
    thread('long', 'codex'); thread('recent', 'codex');
    codex('long', 'eL', T0 - 45 * MIN, 'working');
    codex('recent', 'eR', T0 - 1 * MIN);
    gauge.tick();
    expect(refreshed).toEqual(['long', 'recent']);
  });

  it('refreshes a bounded set', () => {
    for (let i = 0; i < 10; i++) { thread(`c${i}`, 'codex'); codex(`c${i}`, `e${i}`, T0 - i * 1000, 'working'); }
    gauge.tick();
    expect(refreshed).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  // Review of #131: a fixed set of 4 starved the 5th working thread. Least recently polled goes first.
  it('rotates: with 6 working threads, every one is polled within 2 ticks', () => {
    for (let i = 0; i < 6; i++) { thread(`w${i}`, 'codex'); codex(`w${i}`, `e${i}`, T0 - i * 1000, 'working'); }
    gauge.tick();
    expect(refreshed).toEqual(['w0', 'w1', 'w2', 'w3']);
    clock += MIN;
    gauge.tick();
    expect(new Set(refreshed)).toEqual(new Set(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']));
    expect(refreshed.slice(4, 6)).toEqual(['w4', 'w5']);
  });

  it('stuck working rows never crowd out a live thread for more than a few ticks', () => {
    // The stuck rows rank above the live one by activity, so a fixed top 4 never reaches it.
    for (let i = 0; i < 8; i++) { thread(`s${i}`, 'codex'); codex(`s${i}`, `es${i}`, T0 - 20 * MIN - i * 1000, 'working'); }
    thread('live', 'codex'); codex('live', 'eLive', T0 - 90 * MIN, 'working');
    for (let t = 0; t < 3; t++) { gauge.tick(); clock += MIN; }
    expect(refreshed).toContain('live');
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

  it('asks Codex directly only when no Codex thread is a candidate', async () => {
    gauge.stop();
    const polls: number[] = [];
    const g = new UsageGauge({ db, snapshots: snaps, accountFor: () => account, now: () => clock, broadcast: () => {},
      refreshCodex: (id) => { refreshed.push(id); }, pollCodex: async () => { polls.push(clock); return true; } });
    thread('c1', 'codex'); codex('c1', 'e1', T0 - MIN);
    g.tick(); await Promise.resolve();
    expect(refreshed).toEqual(['c1']);
    expect(polls).toEqual([]);
    clock = T0 + 20 * MIN;
    g.tick(); await Promise.resolve();
    expect(polls).toEqual([clock]);
    g.stop();
  });

  it('a refresh that throws does not stop the others or the broadcast', () => {
    thread('c1', 'codex'); thread('c2', 'codex');
    codex('c1', 'e1', T0 - MIN); codex('c2', 'e2', T0 - 2 * MIN);
    gauge.stop();
    const g = new UsageGauge({ db, snapshots: snaps, accountFor: () => account, now: () => clock, broadcast: (e) => events.push(e),
      refreshCodex: (id) => { if (id === 'c1') throw new Error('boom'); refreshed.push(id); } });
    g.tick();
    vi.advanceTimersByTime(5000);
    expect(refreshed).toEqual(['c2']);
    expect(events).toHaveLength(1);
  });
});

// Review finding 4: an account switch changes the summary with no new record. The tick must notice.
describe('account switch', () => {
  it('the next tick broadcasts the new account\'s summary', () => {
    claude(46, 21);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
    account = 'acct-B';
    gauge.tick();
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(2);
    expect(events[1].providers).toEqual([]);
  });

  it('works without a Codex refresher, and an unchanged tick sends nothing', () => {
    snaps = new LimitSnapshots(db);
    const mine: any[] = [];
    const g = new UsageGauge({ db, snapshots: snaps, accountFor: () => account, now: () => clock, broadcast: (e) => mine.push(e) });
    snaps.addRecordListener((p) => g.onRecord(p));
    claude(46, 21);
    vi.advanceTimersByTime(5000);
    g.tick(); vi.advanceTimersByTime(5000);
    expect(mine).toHaveLength(1);
    account = 'acct-B';
    g.tick(); vi.advanceTimersByTime(5000);
    expect(mine).toHaveLength(2);
    g.stop();
  });
});

// Review finding 5: a client must be able to tell an older GET answer from a newer socket event.
describe('summary revision', () => {
  it('rises on every summary, even with the clock standing still, and survives a restart', () => {
    const a = gauge.summary().rev;
    const b = gauge.summary().rev;
    expect(b).toBeGreaterThan(a);
    // A new daemon starts from the clock, so a client holding the old daemon's revision still updates.
    clock += 1000;
    const g2 = make();
    expect(g2.summary().rev).toBeGreaterThan(b);
    g2.stop();
  });

  // Codex re-review of #131: a client tells a restarted daemon apart by its epoch, not its revision.
  it('carries one epoch per daemon instance, the same on every summary', () => {
    const e1 = gauge.summary().epoch;
    expect(e1).toMatch(/^[0-9a-f-]{36}$/);
    expect(gauge.summary().epoch).toBe(e1);
    const g2 = make();
    expect(g2.summary().epoch).not.toBe(e1);
    g2.stop();
  });

  it('is carried on the broadcast but never makes an unchanged payload resend', () => {
    claude(46, 21);
    vi.advanceTimersByTime(5000);
    gauge.pausesChanged();
    expect(events).toHaveLength(1);
    expect(typeof events[0].rev).toBe('number');
  });
});

describe('direct Codex poll and the run-out forecast', () => {
  it('asks Codex itself when no Codex thread was active, at most every 5 minutes', async () => {
    gauge.stop();
    const polls: number[] = [];
    const g = new UsageGauge({ db, snapshots: snaps, accountFor: () => account, now: () => clock, zone: ZONE, broadcast: () => {}, pollCodex: async () => { polls.push(clock); return true; } });
    g.tick();
    await Promise.resolve();
    clock = T0 + 2 * MIN; g.tick(); await Promise.resolve();
    expect(polls).toEqual([T0]);
    clock = T0 + 6 * MIN; g.tick(); await Promise.resolve();
    expect(polls).toEqual([T0, T0 + 6 * MIN]);
    g.stop();
  });

  it('adds a forecast from the recent pace once there is enough history in the window', () => {
    claude(10, 20);
    expect(gauge.summary().providers[0].windows.five_hour.forecast).toBeUndefined(); // one sample is not a pace
    clock = T0 + 60 * MIN;
    claude(30, 22); // 20 points in an hour: 70 left takes 3.5 h, after the 1:10 AM reset
    const f = gauge.summary().providers[0].windows.five_hour.forecast!;
    expect(f.basisHours).toBe(1);
    expect(f.lastsUntilReset).toBe(true);
    expect(f.runsOutAt).toBe(clock + 3.5 * 60 * MIN);
  });
});

describe('background Claude probe', () => {
  const probeGauge = (probes: number[]) => new UsageGauge({ db, snapshots: snaps, accountFor: () => account, now: () => clock, zone: ZONE, broadcast: () => {}, probeClaude: async () => { probes.push(clock); return true; } });
  const activeThread = (at: number) => { thread('k1'); db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(new Date(at).toISOString(), 'k1'); };

  it('probes when the figures are stale and something was active, at most every 5 minutes', async () => {
    gauge.stop();
    const probes: number[] = [];
    const g = probeGauge(probes);
    activeThread(clock - 2 * MIN);
    g.tick(); await Promise.resolve();
    clock += 2 * MIN; g.tick(); await Promise.resolve();
    expect(probes).toEqual([T0]);
    clock = T0 + 6 * MIN; g.tick(); await Promise.resolve();
    expect(probes).toHaveLength(2);
    g.stop();
  });

  it('does not probe while a Pretty thread keeps the figures fresh, or when nothing has been active', async () => {
    gauge.stop();
    const probes: number[] = [];
    const g = probeGauge(probes);
    g.tick(); await Promise.resolve(); // idle machine
    expect(probes).toEqual([]);
    activeThread(clock);
    claude(10, 20); // just reported
    g.tick(); await Promise.resolve();
    expect(probes).toEqual([]);
    g.stop();
  });
});
