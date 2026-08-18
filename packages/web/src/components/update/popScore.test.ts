import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readBest, recordBest, readAndClearCelebration, formatBestDate } from './popScore';

// The pop game's persistence contract: BEST survives forever, CELEBRATE is a
// one-shot, freshness-gated baton from the updating page to the post-restart page.
describe('popScore storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('round-trips a best score with its date', () => {
    recordBest(42, 0);
    const best = readBest();
    expect(best?.score).toBe(42);
    expect(Number.isNaN(Date.parse(best!.date))).toBe(false);
  });

  it('returns null when nothing is stored or the payload is garbage', () => {
    expect(readBest()).toBeNull();
    localStorage.setItem('dispatch:rain-pop-best', 'not json{');
    expect(readBest()).toBeNull();
    localStorage.setItem('dispatch:rain-pop-best', JSON.stringify({ score: 0, date: 'x' }));
    expect(readBest()).toBeNull();
  });

  it('celebration is one-shot: first read returns it and clears the flag', () => {
    recordBest(87, 60);
    const c = readAndClearCelebration();
    expect(c).toMatchObject({ score: 87, prev: 60 });
    expect(readAndClearCelebration()).toBeNull();
  });

  it('a stale celebration (older than the freshness window) is dropped, not fired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T10:00:00Z'));
    recordBest(87, 60);
    vi.setSystemTime(new Date('2026-08-15T12:00:01Z')); // 2h later > 1h window
    expect(readAndClearCelebration()).toBeNull();
    // The BEST score itself never goes stale.
    expect(readBest()?.score).toBe(87);
  });

  it('keeps the round-start target as prev across repeated re-breaks', () => {
    // A round that starts against 10 and pops to 12 records prev=10 every time,
    // so the popup says what the ROUND beat, not the last incremental record.
    recordBest(11, 10);
    recordBest(12, 10);
    expect(readAndClearCelebration()).toMatchObject({ score: 12, prev: 10 });
  });

  it('formatBestDate: month+day this year, adds the year for older scores', () => {
    const now = new Date();
    expect(formatBestDate(now.toISOString())).not.toMatch(String(now.getFullYear()));
    expect(formatBestDate('2001-03-09T12:00:00Z')).toMatch('2001');
    expect(formatBestDate('garbage')).toBe('');
  });
});
