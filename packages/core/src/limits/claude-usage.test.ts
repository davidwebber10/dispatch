import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { LimitSnapshots } from './snapshot.js';
import { parseClaudeUsage, limitKey, createClaudeUsageReader, readClaudeToken, USAGE_URL, PROFILE_URL } from './claude-usage.js';

// The shape api.anthropic.com/api/oauth/usage answered on 2026-11-06 (figures shortened).
const BODY = {
  five_hour: null,
  seven_day: { utilization: 12.0, resets_at: '2026-11-10T08:00:00.855661+00:00' },
  seven_day_opus: null, seven_day_sonnet: null,
  extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 251.0, utilization: 0.251, currency: 'USD', decimal_places: 2 },
  limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: '2026-11-10T08:00:00.855661+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 18, resets_at: '2026-11-10T08:00:00.855849+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
};
const RESET = Date.parse('2026-11-10T08:00:00.855661+00:00');

describe('parseClaudeUsage', () => {
  it('reads the legacy windows, the limits[] array (Fable as seven_day_fable) and the extra-usage spend', () => {
    const { windows, extras } = parseClaudeUsage(BODY);
    expect(windows.seven_day).toEqual({ usedPercent: 12, resetsAt: RESET });
    expect(windows.seven_day_fable).toEqual({ usedPercent: 18, resetsAt: Date.parse('2026-11-10T08:00:00.855849+00:00') });
    expect(windows.five_hour).toBeUndefined();
    expect(windows.overage).toEqual({ usedPercent: 0.251, resetsAt: null });
    expect(extras.spend).toEqual({ usedMinor: 251, limitMinor: 100000, currency: 'USD' });
  });
  it('limits[] overrides a legacy field, names scoped windows by model, and skips an unnamed scope', () => {
    expect(limitKey({ kind: 'weekly_all' })).toBe('seven_day');
    expect(limitKey({ kind: 'weekly_scoped', scope: { model: { id: 'claude-opus-5-5', display_name: 'Opus' } } })).toBe('seven_day_opus');
    expect(limitKey({ kind: 'weekly_scoped', scope: { model: { id: null, display_name: null } } })).toBeNull();
    const { windows } = parseClaudeUsage({ seven_day: { utilization: 5, resets_at: '2026-11-10T08:00:00Z' }, limits: [{ kind: 'weekly_all', percent: 7, resets_at: '2026-11-10T08:00:00Z' }] });
    expect(windows.seven_day.usedPercent).toBe(7);
  });
  it('tolerates junk', () => {
    expect(parseClaudeUsage(null)).toEqual({ windows: {}, extras: {} });
    expect(parseClaudeUsage({ seven_day: 'x', limits: 'y', extra_usage: { is_enabled: false } })).toEqual({ windows: {}, extras: {} });
  });
});

describe('createClaudeUsageReader', () => {
  const setup = (responses: Record<string, { status: number; body: unknown }>) => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    const calls: string[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push(`${url} ${init.headers.Authorization}`);
      const r = responses[url] ?? { status: 404, body: {} };
      return { status: r.status, text: async () => JSON.stringify(r.body) } as any;
    });
    return { db, snaps, calls, f: f as unknown as typeof fetch };
  };

  it('records every window as a replacing report, with the plan from the profile (read once an hour)', async () => {
    const { snaps, calls, f } = setup({ [USAGE_URL]: { status: 200, body: BODY }, [PROFILE_URL]: { status: 200, body: { organization: { plan_display_name: 'Ultra' } } } });
    let now = 1_000_000;
    const read = createClaudeUsageReader({ snapshots: snaps, accountFor: () => 'acct', token: async () => 'tok', fetch: f, now: () => now, log: () => {} });
    expect(await read()).toBe(true);
    const s = snaps.get('claude-code', 'acct')!;
    expect(s.plan).toBe('Ultra');
    expect(s.windows.seven_day_fable.usedPercent).toBe(18);
    expect(s.spend).toEqual({ usedMinor: 251, limitMinor: 100000, currency: 'USD' });
    expect(calls).toEqual([`${USAGE_URL} Bearer tok`, `${PROFILE_URL} Bearer tok`]);
    now += 60_000;
    await read();
    expect(calls).toHaveLength(3); // the usage again, not the profile
  });

  it('is false, and records nothing, without a token, on a 401, and on a body with no windows', async () => {
    const { snaps, f } = setup({ [USAGE_URL]: { status: 401, body: { error: 'x' } } });
    const log: string[] = [];
    const none = createClaudeUsageReader({ snapshots: snaps, accountFor: () => 'a', token: async () => null, fetch: f, log: (l) => log.push(l) });
    expect(await none()).toBe(false);
    const denied = createClaudeUsageReader({ snapshots: snaps, accountFor: () => 'a', token: async () => 'tok', fetch: f, log: (l) => log.push(l) });
    expect(await denied()).toBe(false);
    expect(await denied()).toBe(false);
    expect(log).toEqual(['[usage] Claude usage read failed (cli): HTTP 401']); // said once, not every 2 minutes
    expect(snaps.get('claude-code', 'a')).toBeNull();
  });
});

describe('readClaudeToken', () => {
  it('prefers the saved login, else the later-expiring live credential from the file or the keychain', async () => {
    expect(await readClaudeToken({ saved: () => 'saved', keychain: async () => ({ token: 'kc', expiresAt: null }) })).toBe('saved');
    const home = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'cu-'));
    const fs = await import('node:fs'); const path = await import('node:path');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'file', expiresAt: 2_000 } }));
    expect(await readClaudeToken({ home, env: {}, now: () => 1_000, keychain: async () => ({ token: 'kc', expiresAt: 3_000 }) })).toBe('kc');
    expect(await readClaudeToken({ home, env: {}, now: () => 1_000, keychain: async () => ({ token: 'kc', expiresAt: 1_500 }) })).toBe('file');
    // Both expired: still hand back one (the read fails cleanly and the probe takes over), rather than nothing.
    expect(await readClaudeToken({ home, env: {}, now: () => 5_000, keychain: async () => null })).toBe('file');
    expect(await readClaudeToken({ home: path.join(home, 'none'), env: {}, keychain: async () => null })).toBeNull();
  });
});
