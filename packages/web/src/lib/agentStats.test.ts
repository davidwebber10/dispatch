import { expect, test } from 'vitest';
import { deriveKpis, formatDuration, runDurationMs } from './agentStats';

const run = (status: string, startedAt: string | null, completedAt: string | null) =>
  ({ status, startedAt, completedAt } as any);

test('deriveKpis: success rate over finished runs and average duration', () => {
  const runs = [
    run('succeeded', '2026-06-18T00:00:00Z', '2026-06-18T00:00:30Z'), // 30s
    run('failed', '2026-06-18T00:00:00Z', '2026-06-18T00:01:00Z'),    // 60s
    run('working', null, null),                                       // not finished, no duration
  ];
  const k = deriveKpis(runs);
  expect(k.totalRuns).toBe(3);
  expect(k.successRate).toBe(0.5);       // 1 of 2 finished
  expect(k.avgDurationMs).toBe(45000);   // (30000 + 60000) / 2
});

test('runDurationMs returns null without both timestamps', () => {
  expect(runDurationMs(run('working', '2026-06-18T00:00:00Z', null))).toBeNull();
});

test('formatDuration renders seconds and minutes', () => {
  expect(formatDuration(45000)).toBe('45s');
  expect(formatDuration(90000)).toBe('1m 30s');
  expect(formatDuration(null)).toBe('—');
});
