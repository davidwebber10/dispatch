import { describe, it, expect } from 'vitest';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { compactLimits, diskUse, bestEffort } from './fleet-stats.js';
import { HeartbeatService } from './heartbeat.js';

const summary = (providers: Array<{ provider: string; windows: Record<string, { usedPercent: number | null }> }>) =>
  ({ type: 'usage-limits', at: 0, epoch: 'e', rev: 1, warnPercent: 80, pushOnWarn: false, paused: [], providers: providers.map((p) => ({ accountId: 'cli', label: p.provider, asOf: 0, ...p, windows: Object.fromEntries(Object.entries(p.windows).map(([k, w]) => [k, { resetsAt: null, ...w }])) })) }) as never;

describe('heartbeat fleet keys', () => {
  it('usageLimits: the worst account per window, rounded and clamped; null when no account reported it', () => {
    expect(compactLimits(summary([
      { provider: 'claude-code', windows: { seven_day: { usedPercent: 41.6 }, five_hour: { usedPercent: 12 } } },
      { provider: 'codex', windows: { seven_day: { usedPercent: 73.2 }, five_hour: { usedPercent: null } } },
    ]))).toEqual({ weekPercent: 73, sessionPercent: 12 });
    expect(compactLimits(summary([{ provider: 'codex', windows: { seven_day: { usedPercent: 140 } } }]))).toEqual({ weekPercent: 100, sessionPercent: null });
    expect(compactLimits(summary([]))).toEqual({ weekPercent: null, sessionPercent: null });
    expect(compactLimits(null)).toBeUndefined();
  });

  it('disk: used and total bytes of the home; one file system is counted once', () => {
    const statfs = () => ({ bsize: 4096, blocks: 1000, bfree: 250 });
    expect(diskUse(os.tmpdir(), os.tmpdir(), statfs)).toEqual({ usedBytes: 750 * 4096, totalBytes: 1000 * 4096 });
    expect(diskUse(os.tmpdir(), null, () => { throw new Error('no statfs'); })).toBeUndefined();
    const real = diskUse(os.tmpdir(), null);
    expect(real && real.totalBytes > 0 && real.usedBytes >= 0 && real.usedBytes <= real.totalBytes).toBe(true);
  });

  it('a failed reading leaves its key out of the beat; the others are sent', () => {
    const db = new Database(':memory:'); initSchema(db);
    const hb = new HeartbeatService(db, () => ({
      authenticated: true, toolsReachable: true,
      usage24h: { inputTokens: 10, outputTokens: 5, turns: 2 },
      usageLimits: bestEffort(() => { throw new Error('gauge down'); }),
      disk: { usedBytes: 1, totalBytes: 2 },
    }), { baseUrl: 'http://os.invalid', boxToken: 't' });
    const beat = hb.current();
    expect(beat.usage24h).toEqual({ inputTokens: 10, outputTokens: 5, turns: 2 });
    expect(beat.disk).toEqual({ usedBytes: 1, totalBytes: 2 });
    expect('usageLimits' in beat).toBe(false);
  });
});
