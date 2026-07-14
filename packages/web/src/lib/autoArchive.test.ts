import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DEFAULT_AUTO_ARCHIVE_MS, toDuration, fromDuration, getAutoArchiveMs, formatRemaining, remainingMs, useMinuteTick,
} from './autoArchive';

describe('toDuration', () => {
  it('picks the largest unit that divides evenly', () => {
    expect(toDuration(43_200_000)).toEqual({ value: 12, unit: 'hours' });
    expect(toDuration(1_800_000)).toEqual({ value: 30, unit: 'minutes' });
    expect(toDuration(172_800_000)).toEqual({ value: 2, unit: 'days' });
  });

  it('falls back to minutes when nothing divides evenly', () => {
    expect(toDuration(90 * 60_000)).toEqual({ value: 90, unit: 'minutes' });
  });
});

describe('fromDuration', () => {
  it('round-trips with toDuration', () => {
    expect(fromDuration(12, 'hours')).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(fromDuration(30, 'minutes')).toBe(1_800_000);
    expect(fromDuration(2, 'days')).toBe(172_800_000);
  });
});

describe('getAutoArchiveMs', () => {
  it('reads an enabled policy', () => {
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 60_000 })).toBe(60_000);
  });
  it('defaults to 12h when enabled with no duration', () => {
    expect(getAutoArchiveMs({ autoArchive: true })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
  });
  it('returns null when not opted in', () => {
    expect(getAutoArchiveMs({})).toBeNull();
    expect(getAutoArchiveMs({ autoArchive: false })).toBeNull();
  });
});

describe('remainingMs', () => {
  it('counts down from the last activity', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const last = '2026-07-14T11:00:00.000Z';                 // 1h ago
    expect(remainingMs(last, 43_200_000, now)).toBe(11 * 3600_000);
  });

  it('clamps to zero once past the deadline', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    expect(remainingMs('2026-07-13T12:00:00.000Z', 3600_000, now)).toBe(0);
  });
});

describe('formatRemaining', () => {
  it('renders a compact countdown', () => {
    expect(formatRemaining(11 * 3600_000)).toBe('11h');
    expect(formatRemaining(90 * 60_000)).toBe('1h');
    expect(formatRemaining(45 * 60_000)).toBe('45m');
    expect(formatRemaining(3 * 24 * 3600_000)).toBe('3d');
  });

  it('shows <1m rather than 0m on the last stretch', () => {
    expect(formatRemaining(30_000)).toBe('<1m');
    expect(formatRemaining(0)).toBe('<1m');
  });
});

describe('useMinuteTick (shared ticker)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounting several active subscribers creates only one interval', () => {
    expect(vi.getTimerCount()).toBe(0);
    const h1 = renderHook(() => useMinuteTick(true));
    const h2 = renderHook(() => useMinuteTick(true));
    const h3 = renderHook(() => useMinuteTick(true));
    expect(vi.getTimerCount()).toBe(1); // one shared interval, not three
    h1.unmount();
    h2.unmount();
    h3.unmount();
  });

  it('an inactive subscriber creates no interval and never re-renders on tick', () => {
    const { result } = renderHook(() => useMinuteTick(false));
    expect(vi.getTimerCount()).toBe(0);
    const before = result.current;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(before); // no re-render triggered
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the shared interval only once the last subscriber unmounts', () => {
    const h1 = renderHook(() => useMinuteTick(true));
    const h2 = renderHook(() => useMinuteTick(true));
    expect(vi.getTimerCount()).toBe(1);
    h1.unmount();
    expect(vi.getTimerCount()).toBe(1); // h2 is still mounted
    h2.unmount();
    expect(vi.getTimerCount()).toBe(0); // last subscriber gone → interval torn down
  });

  it('all active subscribers observe the advanced time after a 60s tick', () => {
    const h1 = renderHook(() => useMinuteTick(true));
    const h2 = renderHook(() => useMinuteTick(true));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const expected = new Date('2026-07-14T12:01:00.000Z').getTime();
    expect(h1.result.current).toBe(expected);
    expect(h2.result.current).toBe(expected);
    h1.unmount();
    h2.unmount();
  });
});
