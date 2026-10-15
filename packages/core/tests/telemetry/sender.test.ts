import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { checkTelemetryOnce, setTelemetryEnabled, telemetryEnabled, startTelemetryLoop } from '../../src/telemetry/sender.js';

function setup() {
  const db = new Database(':memory:'); initSchema(db);
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  let now = new Date('2026-10-15T10:00:00Z');
  const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, env: {} as NodeJS.ProcessEnv, version: '3.0.0', platform: 'darwin' as const, url: 'https://example.test/v1/ping' };
  return { db, fetchImpl, deps, setNow: (d: string) => { now = new Date(d); } };
}
const body = (f: ReturnType<typeof vi.fn>, k = -1) => JSON.parse((f.mock.calls.at(k)![1] as RequestInit).body as string);

describe('telemetry sender', () => {
  it('is on by default; the setting and DISPATCH_TELEMETRY=0 turn it off', () => {
    const { db } = setup();
    expect(telemetryEnabled(db, {})).toBe(true);
    expect(telemetryEnabled(db, { DISPATCH_TELEMETRY: '0' })).toBe(false);
    setTelemetryEnabled(db, false);
    expect(telemetryEnabled(db, {})).toBe(false);
  });

  it('sends on the first check, skips within 6 h, sends again after 6 h', async () => {
    const t = setup();
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.fetchImpl.mock.calls[0][0]).toBe('https://example.test/v1/ping');
    t.setNow('2026-10-15T15:59:00Z');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('skipped');
    t.setNow('2026-10-15T16:01:00Z');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
  });

  it('the first check of a new UTC day sends at once and carries yesterday; a gap day carries no yesterday', async () => {
    const t = setup();
    t.setNow('2026-10-15T22:00:00Z');
    await checkTelemetryOnce(t.db, t.deps);
    t.setNow('2026-10-16T00:30:00Z');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
    expect(body(t.fetchImpl).days.map((d: { day: string }) => d.day)).toEqual(['2026-10-15', '2026-10-16']);
    t.setNow('2026-10-18T09:00:00Z'); // off all of 10-17
    await checkTelemetryOnce(t.db, t.deps);
    expect(body(t.fetchImpl).days.map((d: { day: string }) => d.day)).toEqual(['2026-10-18']);
  });

  it('makes no request when off (setting or env), and the next check obeys a fresh toggle', async () => {
    const t = setup();
    setTelemetryEnabled(t.db, false);
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('disabled');
    expect(await checkTelemetryOnce(t.db, { ...t.deps, env: { DISPATCH_TELEMETRY: '0' } })).toBe('disabled');
    expect(t.fetchImpl).not.toHaveBeenCalled();
    setTelemetryEnabled(t.db, true);
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
  });

  it('a failing or throwing fetch returns failed, never throws, and retries on the next check', async () => {
    const t = setup();
    t.fetchImpl.mockRejectedValueOnce(new Error('offline'));
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('failed');
    t.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('failed');
    expect(await checkTelemetryOnce(t.db, t.deps)).toBe('sent');
  });

  it('the loop checks after the boot delay, then every hour, and stops', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const loop = startTelemetryLoop(t.db, { ...t.deps, bootDelayMs: 60_000, intervalMs: 3_600_000 });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(t.fetchImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.fetchImpl).toHaveBeenCalledTimes(1);
      loop.stop();
      await vi.advanceTimersByTimeAsync(10 * 3_600_000);
      expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
