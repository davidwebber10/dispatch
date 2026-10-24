import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { parseClaudeRateLimit, parseCodexRateLimits, LimitSnapshots } from './snapshot.js';

const NOW = 1_792_800_000_000;

describe('parseClaudeRateLimit', () => {
  it('reads every window from unifiedWindows, utilization as a percent', () => {
    const w = parseClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1792861200, utilization: 0.98,
      unifiedWindows: { five_hour: { utilization: 0.98, resetsAt: 1792861200 }, seven_day: { utilization: 0.73, resetsAt: 1793062800 }, seven_day_opus: { utilization: 0.1, resetsAt: 1793062800 } } });
    expect(w.five_hour).toEqual({ usedPercent: 98, resetsAt: 1792861200_000 });
    expect(w.seven_day).toEqual({ usedPercent: 73, resetsAt: 1793062800_000 });
    expect(w.seven_day_opus).toEqual({ usedPercent: 10, resetsAt: 1793062800_000 });
  });
  it('an allowed event with no utilization gives a reset time and no percent (nothing invented)', () => {
    const w = parseClaudeRateLimit({ status: 'allowed', resetsAt: 1781931600, rateLimitType: 'five_hour' });
    expect(w.five_hour).toEqual({ usedPercent: null, resetsAt: 1781931600_000 });
    expect(w.seven_day).toBeUndefined();
  });
  it('keeps seven_day_opus, seven_day_sonnet, seven_day_overage_included and overage under their own names, unknown types under the raw name; caps an over-limit figure at 100', () => {
    const w = parseClaudeRateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1793062800, utilization: 1.03 });
    expect(w.seven_day_opus).toEqual({ usedPercent: 100, resetsAt: 1793062800_000 });
    const all = parseClaudeRateLimit({ status: 'allowed_warning', unifiedWindows: { seven_day_sonnet: { utilization: 0.2, resetsAt: 1793062800 }, seven_day_overage_included: { utilization: 0.5, resetsAt: 1793062800 }, overage: { utilization: 0.1, resetsAt: 1793062800 }, seven_day_future: { utilization: 0.3, resetsAt: 1793062800 } } });
    expect(Object.keys(all).sort()).toEqual(['overage', 'seven_day_future', 'seven_day_overage_included', 'seven_day_sonnet']);
    expect(parseClaudeRateLimit({ status: 'allowed', rateLimitType: 'seven_day_overage_included', resetsAt: 1793062800 })).toEqual({ seven_day_overage_included: { usedPercent: null, resetsAt: 1793062800_000 } });
  });
  it('ignores junk', () => {
    expect(parseClaudeRateLimit(null)).toEqual({});
    expect(parseClaudeRateLimit({ rateLimitType: 'bogus', resetsAt: 5 })).toEqual({ bogus: { usedPercent: null, resetsAt: 5000 } });
  });
});

describe('parseCodexRateLimits', () => {
  it('maps the 300-minute window to session and the 10080-minute one to weekly', () => {
    const r = parseCodexRateLimits({ primary: { used_percent: 62.5, window_minutes: 300, resets_at: 1792861200 }, secondary: { used_percent: 24, window_minutes: 10080, resets_at: 1793062800 }, plan_type: 'plus' });
    expect(r.windows.five_hour).toEqual({ usedPercent: 62.5, resetsAt: 1792861200_000 });
    expect(r.windows.seven_day).toEqual({ usedPercent: 24, resetsAt: 1793062800_000 });
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
    s.record('claude-code', 'acct-a', { five_hour: { usedPercent: 50, resetsAt: NOW + 1000 } }, NOW);
    s.record('claude-code', 'acct-a', { seven_day: { usedPercent: 20, resetsAt: NOW + 5000 } }, NOW + 10);
    const g = s.get('claude-code', 'acct-a')!;
    expect(g.windows.five_hour?.usedPercent).toBe(50);
    expect(g.windows.seven_day?.usedPercent).toBe(20);
    expect(g.asOf).toBe(NOW + 10);
  });
  it('a no-percent event for the same window keeps the earlier percent', () => {
    const { s } = fresh();
    s.record('claude-code', 'a', { five_hour: { usedPercent: 40, resetsAt: NOW + 1000 } }, NOW);
    s.record('claude-code', 'a', { five_hour: { usedPercent: null, resetsAt: NOW + 1000 } }, NOW + 5);
    expect(s.get('claude-code', 'a')!.windows.five_hour?.usedPercent).toBe(40);
    s.record('claude-code', 'a', { five_hour: { usedPercent: null, resetsAt: NOW + 99_000 } }, NOW + 6);
    expect(s.get('claude-code', 'a')!.windows.five_hour?.usedPercent).toBeNull();
  });
  it('a different account replaces the old snapshot and the old one is never shown as current', () => {
    const { s } = fresh();
    s.record('claude-code', 'old', { five_hour: { usedPercent: 99, resetsAt: NOW + 1000 } }, NOW);
    expect(s.get('claude-code', 'new')).toBeNull();
    s.record('claude-code', 'new', { five_hour: { usedPercent: 3, resetsAt: NOW + 1000 } }, NOW + 1);
    expect(s.get('claude-code', 'old')).toBeNull();
    expect(s.get('claude-code', 'new')!.windows.five_hour?.usedPercent).toBe(3);
  });
  it("an unknown account ('') is an account of its own: it never matches a known one", () => {
    const { s } = fresh();
    s.record('claude-code', '', { seven_day: { usedPercent: 95, resetsAt: NOW + 1000 } }, NOW);
    expect(s.get('claude-code', 'acct-b')).toBeNull();
    s.record('claude-code', 'acct-b', { five_hour: { usedPercent: 1, resetsAt: NOW + 1000 } }, NOW + 1);
    expect(s.get('claude-code', 'acct-b')!.windows.seven_day).toBeUndefined(); // nothing carried across
    expect(s.get('claude-code', '')).toBeNull();
  });
  it('a report older than the stored one is ignored (an idle thread must not undo newer figures)', () => {
    const { s } = fresh();
    s.record('codex', 'a', { five_hour: { usedPercent: 80, resetsAt: NOW + 1000 } }, NOW, undefined, true);
    s.record('codex', 'a', { five_hour: { usedPercent: 20, resetsAt: NOW + 1000 } }, NOW - 7200_000, undefined, true);
    expect(s.get('codex', 'a')!.windows.five_hour?.usedPercent).toBe(80);
    expect(s.get('codex', 'a')!.asOf).toBe(NOW);
  });
  it('replace (Codex): a newer report with fewer windows, or none (unlimited plan), clears the old ones', () => {
    const { s } = fresh();
    s.record('codex', 'a', { five_hour: { usedPercent: 80, resetsAt: NOW + 1000 }, seven_day: { usedPercent: 50, resetsAt: NOW + 1000 } }, NOW, 'plus', true);
    s.record('codex', 'a', { five_hour: { usedPercent: 10, resetsAt: NOW + 5000 } }, NOW + 10, undefined, true);
    expect(Object.keys(s.get('codex', 'a')!.windows)).toEqual(['five_hour']);
    s.record('codex', 'a', {}, NOW + 20, 'business', true);
    expect(s.get('codex', 'a')!.windows).toEqual({});
  });
  it('a window type reported once does not linger more than an hour past its reset', () => {
    const { s } = fresh();
    s.record('claude-code', 'a', { overage: { usedPercent: 3, resetsAt: NOW + 1000 } }, NOW);
    s.record('claude-code', 'a', { five_hour: { usedPercent: 4, resetsAt: NOW + 5 * 3600_000 } }, NOW + 2 * 3600_000);
    expect(Object.keys(s.get('claude-code', 'a')!.windows)).toEqual(['five_hour']);
  });
  it('providers are separate, and the snapshot survives a restart', () => {
    const { db, s } = fresh();
    s.record('codex', 'x', { seven_day: { usedPercent: 7, resetsAt: NOW + 1 } }, NOW, 'plus');
    expect(s.get('claude-code', 'x')).toBeNull();
    expect(new LimitSnapshots(db).get('codex', 'x')).toMatchObject({ plan: 'plus', windows: { seven_day: { usedPercent: 7 } } });
  });
});
