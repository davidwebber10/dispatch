import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { parseClaudeRateLimit, parseCodexRateLimits, LimitSnapshots } from './snapshot.js';

const NOW = 1_792_800_000_000;

describe('parseClaudeRateLimit', () => {
  it('reads every window from unifiedWindows, utilization as a percent', () => {
    const w = parseClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1792861200, utilization: 0.98,
      unifiedWindows: { five_hour: { utilization: 0.98, resetsAt: 1792861200 }, seven_day: { utilization: 0.73, resetsAt: 1793062800 }, seven_day_opus: { utilization: 0.1, resetsAt: 1793062800 } } });
    expect(w.session).toEqual({ usedPercent: 98, resetsAt: 1792861200_000 });
    expect(w.weekly).toEqual({ usedPercent: 73, resetsAt: 1793062800_000 });
    expect(w.weeklyOpus).toEqual({ usedPercent: 10, resetsAt: 1793062800_000 });
  });
  it('an allowed event with no utilization gives a reset time and no percent (nothing invented)', () => {
    const w = parseClaudeRateLimit({ status: 'allowed', resetsAt: 1781931600, rateLimitType: 'five_hour' });
    expect(w.session).toEqual({ usedPercent: null, resetsAt: 1781931600_000 });
    expect(w.weekly).toBeUndefined();
  });
  it('maps seven_day_opus and caps an over-limit figure at 100', () => {
    const w = parseClaudeRateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1793062800, utilization: 1.03 });
    expect(w.weeklyOpus).toEqual({ usedPercent: 100, resetsAt: 1793062800_000 });
  });
  it('ignores junk', () => {
    expect(parseClaudeRateLimit(null)).toEqual({});
    expect(parseClaudeRateLimit({ rateLimitType: 'bogus', resetsAt: 5 })).toEqual({});
  });
});

describe('parseCodexRateLimits', () => {
  it('maps the 300-minute window to session and the 10080-minute one to weekly', () => {
    const r = parseCodexRateLimits({ primary: { used_percent: 62.5, window_minutes: 300, resets_at: 1792861200 }, secondary: { used_percent: 24, window_minutes: 10080, resets_at: 1793062800 }, plan_type: 'plus' });
    expect(r.windows.session).toEqual({ usedPercent: 62.5, resetsAt: 1792861200_000 });
    expect(r.windows.weekly).toEqual({ usedPercent: 24, resetsAt: 1793062800_000 });
    expect(r.plan).toBe('plus');
  });
  it('null windows (an unlimited plan) report nothing', () => {
    expect(parseCodexRateLimits({ primary: null, secondary: null, plan_type: 'business' }).windows).toEqual({});
    expect(parseCodexRateLimits(undefined).windows).toEqual({});
  });
});

describe('LimitSnapshots', () => {
  const fresh = () => { const db = new Database(':memory:'); db.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); return { db, s: new LimitSnapshots(db) }; };

  it('keeps the latest window per provider and merges partial events', () => {
    const { s } = fresh();
    s.record('claude-code', 'acct-a', { session: { usedPercent: 50, resetsAt: NOW + 1000 } }, NOW);
    s.record('claude-code', 'acct-a', { weekly: { usedPercent: 20, resetsAt: NOW + 5000 } }, NOW + 10);
    const g = s.get('claude-code', 'acct-a')!;
    expect(g.session?.usedPercent).toBe(50);
    expect(g.weekly?.usedPercent).toBe(20);
    expect(g.asOf).toBe(NOW + 10);
  });
  it('a no-percent event for the same window keeps the earlier percent', () => {
    const { s } = fresh();
    s.record('claude-code', 'a', { session: { usedPercent: 40, resetsAt: NOW + 1000 } }, NOW);
    s.record('claude-code', 'a', { session: { usedPercent: null, resetsAt: NOW + 1000 } }, NOW + 5);
    expect(s.get('claude-code', 'a')!.session?.usedPercent).toBe(40);
    s.record('claude-code', 'a', { session: { usedPercent: null, resetsAt: NOW + 99_000 } }, NOW + 6);
    expect(s.get('claude-code', 'a')!.session?.usedPercent).toBeNull();
  });
  it('a different account replaces the old snapshot and the old one is never shown as current', () => {
    const { s } = fresh();
    s.record('claude-code', 'old', { session: { usedPercent: 99, resetsAt: NOW + 1000 } }, NOW);
    expect(s.get('claude-code', 'new')).toBeNull();
    s.record('claude-code', 'new', { session: { usedPercent: 3, resetsAt: NOW + 1000 } }, NOW + 1);
    expect(s.get('claude-code', 'old')).toBeNull();
    expect(s.get('claude-code', 'new')!.session?.usedPercent).toBe(3);
  });
  it('providers are separate, and the snapshot survives a restart', () => {
    const { db, s } = fresh();
    s.record('codex', 'x', { weekly: { usedPercent: 7, resetsAt: NOW + 1 } }, NOW, 'plus');
    expect(s.get('claude-code', 'x')).toBeNull();
    const again = new LimitSnapshots(db);
    expect(again.get('codex', 'x')).toMatchObject({ plan: 'plus', weekly: { usedPercent: 7 } });
  });
  it('an unknown account id matches whatever is stored', () => {
    const { s } = fresh();
    s.record('codex', '', { weekly: { usedPercent: 7, resetsAt: NOW + 1 } }, NOW);
    expect(s.get('codex', '')).not.toBeNull();
  });
});
