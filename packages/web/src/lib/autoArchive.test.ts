import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTO_ARCHIVE_MS, toDuration, fromDuration, getAutoArchiveMs, formatRemaining, remainingMs,
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
