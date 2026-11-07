import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches, nextCronRun } from '../../src/plugins/cron.js';

/** The five-field cron subset plugin jobs use (plugins slice 5). Local time. */
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cron subset', () => {
  it('`0 7 * * 1-5` matches 07:00 on weekdays only', () => {
    const spec = parseCron('0 7 * * 1-5')!;
    expect(spec).not.toBeNull();
    expect(cronMatches(spec, at(2026, 11, 9, 7, 0))).toBe(true);   // Monday
    expect(cronMatches(spec, at(2026, 11, 9, 7, 1))).toBe(false);
    expect(cronMatches(spec, at(2026, 11, 8, 7, 0))).toBe(false);  // Sunday
    expect(cronMatches(spec, at(2026, 11, 13, 7, 0))).toBe(true);  // Friday
  });

  it('steps, lists, ranges, and 7 as Sunday', () => {
    const every15 = parseCron('*/15 9-17 * * *')!;
    expect(cronMatches(every15, at(2026, 11, 9, 9, 0))).toBe(true);
    expect(cronMatches(every15, at(2026, 11, 9, 9, 45))).toBe(true);
    expect(cronMatches(every15, at(2026, 11, 9, 9, 50))).toBe(false);
    expect(cronMatches(every15, at(2026, 11, 9, 18, 0))).toBe(false);
    const twice = parseCron('0 9,13 * * *')!;
    expect(cronMatches(twice, at(2026, 11, 9, 13, 0))).toBe(true);
    expect(cronMatches(twice, at(2026, 11, 9, 12, 0))).toBe(false);
    const sunday = parseCron('30 6 * * 7')!;
    expect(cronMatches(sunday, at(2026, 11, 8, 6, 30))).toBe(true);
    const firstOfMonth = parseCron('0 0 1 * *')!;
    expect(cronMatches(firstOfMonth, at(2026, 12, 1, 0, 0))).toBe(true);
    expect(cronMatches(firstOfMonth, at(2026, 12, 2, 0, 0))).toBe(false);
  });

  it('an invalid expression is null', () => {
    for (const bad of ['', 'every day', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a b c d e', '*/0 * * * *', '5-1 * * * *']) expect(parseCron(bad), bad).toBeNull();
  });

  it('nextCronRun finds the next matching minute after `from`, and null when none within a year', () => {
    const spec = parseCron('0 7 * * 1-5')!;
    expect(nextCronRun(spec, at(2026, 11, 7, 12, 0))).toEqual(at(2026, 11, 9, 7, 0)); // Saturday noon → Monday 07:00
    expect(nextCronRun(spec, at(2026, 11, 9, 7, 0))).toEqual(at(2026, 11, 10, 7, 0)); // the same minute is not "next"
    expect(nextCronRun(parseCron('0 0 31 2 *')!, at(2026, 1, 1, 0, 0))).toBeNull();
  });
});
