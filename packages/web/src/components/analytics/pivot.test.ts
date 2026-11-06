import { describe, it, expect } from 'vitest';
import { pivot } from './UsageAnalytics';
import { dayRange } from './parts';

const pt = (day: string, key: string, value: number) => ({ day, key, value }) as any;

describe('Usage chart rows', () => {
  it('dayRange walks local days across a month end, inclusive', () => {
    expect(dayRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('gives every day of the range a row, zero on a quiet day, from the range start through today', () => {
    const from = new Date(2026, 10, 1).toISOString(); // local midnight, 1 Nov
    const { rows, keys } = pivot([pt('2026-11-02', 'opus', 5), pt('2026-11-04', 'haiku', 2)], (p) => p.key, from, '2026-11-05');
    expect(keys).toEqual(['haiku', 'opus']);
    expect(rows.map((r) => r.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    expect(rows[2]).toEqual({ day: '2026-11-03', haiku: 0, opus: 0 });
    expect(rows[1]).toEqual({ day: '2026-11-02', haiku: 0, opus: 5 });
  });

  it('all time starts at the first day with data; no data at all stays empty', () => {
    expect(pivot([pt('2026-11-04', 'x', 1)], (p) => p.key, undefined, '2026-11-05').rows.map((r) => r.day)).toEqual(['2026-11-04', '2026-11-05']);
    expect(pivot([], (p) => p.key, new Date(2026, 10, 1).toISOString(), '2026-11-05').rows).toEqual([]);
  });
});
