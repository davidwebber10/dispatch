import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCodexRateLimits } from './codex-frames.js';

const line = (ts: string, rl: unknown) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });

describe('readCodexRateLimits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rl-'));
  it('returns the newest non-empty rate_limits with its time', () => {
    const f = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(f, [
      line('2026-10-24T10:00:00.000Z', { primary: { used_percent: 10, window_minutes: 300, resets_at: 1 } }),
      line('2026-10-24T11:00:00.000Z', { primary: { used_percent: 62, window_minutes: 300, resets_at: 2 }, secondary: { used_percent: 24, window_minutes: 10080, resets_at: 3 } }),
      line('2026-10-24T12:00:00.000Z', { primary: null, secondary: null }),
      'not json',
    ].join('\n'));
    const r = readCodexRateLimits(f)!;
    expect((r.rateLimits as any).primary.used_percent).toBe(62);
    expect(r.at).toBe(Date.parse('2026-10-24T11:00:00.000Z'));
  });
  it('a missing file or no rate_limits gives null, and a small tail cap bounds the read', () => {
    expect(readCodexRateLimits(path.join(tmp, 'nope.jsonl'))).toBeNull();
    const f = path.join(tmp, 'b.jsonl');
    fs.writeFileSync(f, line('2026-10-24T10:00:00.000Z', { primary: { used_percent: 1, window_minutes: 300, resets_at: 1 } }) + '\n' + 'x'.repeat(5000));
    expect(readCodexRateLimits(f, 1000)).toBeNull();
    expect(readCodexRateLimits(f, 100000)).not.toBeNull();
  });
});
