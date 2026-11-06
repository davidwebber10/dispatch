import { describe, it, expect } from 'vitest';
import { addSamples, forecast, SAMPLE_GAP_MS, type Sample } from './forecast.js';

const H = 3600_000;
const now = Date.UTC(2026, 10, 5, 12);
const reset = now + 48 * H;

describe('run-out forecast', () => {
  it('projects the last 24 h pace of the current window to 100%', () => {
    const samples: Sample[] = [[now - 30 * H, 0, reset], [now - 24 * H, 10, reset], [now - 12 * H, 30, reset]];
    // From 10% 24 h ago to 50% now: 40 points a day, so 50 left takes 30 h.
    expect(forecast(samples, { usedPercent: 50, resetsAt: reset }, now)).toEqual({ runsOutAt: now + 30 * H, lastsUntilReset: false, basisHours: 24 });
  });

  it('lasts until the reset when the pace would not get there first, or is flat', () => {
    expect(forecast([[now - 10 * H, 10, reset]], { usedPercent: 12, resetsAt: reset }, now)!.lastsUntilReset).toBe(true);
    expect(forecast([[now - 10 * H, 12, reset]], { usedPercent: 12, resetsAt: reset }, now)).toEqual({ runsOutAt: null, lastsUntilReset: true, basisHours: 10 });
  });

  it('only measures inside the current window: samples from before a reset do not count', () => {
    const old = now - 2 * H;
    expect(forecast([[now - 20 * H, 90, old]], { usedPercent: 5, resetsAt: reset }, now)).toBeNull();
  });

  it('needs at least 30 minutes of history', () => {
    expect(forecast([[now - 10 * 60_000, 1, reset]], { usedPercent: 2, resetsAt: reset }, now)).toBeNull();
  });

  it('keeps one sample per 5 minutes, and a new account starts over', () => {
    let h = addSamples(undefined, 'a', { seven_day: { usedPercent: 1, resetsAt: reset } }, now);
    h = addSamples(h, 'a', { seven_day: { usedPercent: 2, resetsAt: reset } }, now + SAMPLE_GAP_MS - 1);
    expect(h.windows.seven_day).toEqual([[now + SAMPLE_GAP_MS - 1, 2, reset]]);
    h = addSamples(h, 'a', { seven_day: { usedPercent: 3, resetsAt: reset } }, now + 2 * SAMPLE_GAP_MS);
    expect(h.windows.seven_day).toHaveLength(2);
    expect(addSamples(h, 'b', {}, now).windows).toEqual({});
  });
});
