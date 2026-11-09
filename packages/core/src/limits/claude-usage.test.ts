import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { LimitSnapshots } from './snapshot.js';
import { parseClaudeUsage, parseClaudeResets, limitKey, createClaudeUsageReader, readClaudeToken, nextReadAfter, USAGE_READ_URL as USAGE_URL, PROFILE_URL } from './claude-usage.js';

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
    expect((await read()).ok).toBe(true);
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
    expect((await none()).ok).toBe(false);
    const denied = createClaudeUsageReader({ snapshots: snaps, accountFor: () => 'a', token: async () => 'tok', fetch: f, log: (l) => log.push(l) });
    expect((await denied()).ok).toBe(false);
    expect((await denied()).ok).toBe(false);
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

// The reset block (`cedar_ember`) answered on 2026-11-09 for an Ultra account, the Fable 5.2 launch resets (shortened).
const grant = (id: string, left: number, o: Record<string, unknown> = {}) => ({
  id, label: `New model launch: ${id}`, resets_total: 1, resets_left: left, starts_at: '2026-11-09T18:00:00+00:00', ends_at: '2027-03-09T07:59:00+00:00',
  clears: ['seven_day_overage_included'], paused: false, usable_now: true, use_requires_limit: false, type: 'full', unavailable_reason: null, gives_back_weekly: true, ...o,
});
const CEDAR = { eligible: true, ineligible_reason: null, at_limit: true, exhausted: ['seven_day_overage_included'], grants: [grant('launch-2610-fable', 1), grant('launch-2610-fable-12mo', 1), grant('launch-2610-fable-6mo', 1)], next_grant_id: 'launch-2610-fable' };

describe('Claude limit resets (2026-11-09: the Fable 5.2 launch resets)', () => {
  it('counts every reset left on the grants that are not paused, soonest expiry first', () => {
    const r = parseClaudeResets({ ...BODY, cedar_ember: { ...CEDAR, grants: [...CEDAR.grants, grant('used-up', 0), grant('paused', 1, { paused: true }), grant('early', 2, { ends_at: '2026-12-01T00:00:00+00:00' })] } });
    expect(r!.available).toBe(5);
    expect(r!.nextExpiresAt).toBe(Date.parse('2026-12-01T00:00:00+00:00'));
    expect(r!.credits).toHaveLength(5);
    expect(r!.credits[0]).toEqual({ id: 'early', expiresAt: Date.parse('2026-12-01T00:00:00+00:00'), title: 'New model launch: early' });
  });

  it('none when the account is not eligible, has no block, or no reset left', () => {
    expect(parseClaudeResets(BODY)).toBeNull();
    expect(parseClaudeResets({ cedar_ember: { eligible: false, ineligible_reason: 'surface', grants: [] } })).toBeNull();
    expect(parseClaudeResets({ cedar_ember: { ...CEDAR, grants: [grant('x', 0)] } })).toBeNull();
  });

  it('the reader asks for the reset block as Claude Code does and keeps the resets per account', async () => {
    const seen: { url: string; ua: string }[] = [];
    const f = (async (url: string, init: any) => {
      seen.push({ url, ua: init.headers['User-Agent'] });
      return { status: 200, text: async () => JSON.stringify(url.startsWith(USAGE_URL) ? { ...BODY, cedar_ember: CEDAR } : {}) } as any;
    }) as unknown as typeof fetch;
    const db = new Database(':memory:'); initSchema(db);
    const read = createClaudeUsageReader({ snapshots: new LimitSnapshots(db), accountFor: () => 'acct', token: async () => 'tok', fetch: f, log: () => {} });
    expect((await read('work')).ok).toBe(true);
    expect(seen[0].url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1');
    expect(seen[0].ua).toMatch(/^claude-cli\/\S+ \(external, cli\)$/); // anything else is answered "ineligible: surface"
    expect(read.credits('work')?.available).toBe(3);
    expect(read.credits('cli')).toBeNull();
  });
});

// W1-H (2026-11-09): the read says WHY it failed, so the gauge can back off and the card can say what to do.
// The 403 body is the one Anthropic answered for a `claude setup-token` token on 2026-11-09.
const SCOPE_403 = { type: 'error', error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement any_of(user:profile, user:office)', details: { required_scopes: ['user:profile', 'user:office'], match: 'any', error_visibility: 'user_facing', error_code: 'oauth_scope_insufficient' } }, request_id: 'req_x' };
describe('the typed usage read result (W1-H)', () => {
  const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET';
  const reader = (status: number, body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    const log: string[] = [];
    const f = (async (url: string) => {
      if (status === 0) throw new Error(`connect failed for ${TOKEN}`);
      const ok = url.startsWith(PROFILE_URL) ? { status: 200, body: {} } : { status, body };
      return { status: ok.status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(ok.body) } as any;
    }) as unknown as typeof fetch;
    return { snaps, log, read: createClaudeUsageReader({ snapshots: snaps, accountFor: () => 'acct', token: async () => token, fetch: f, now: () => 5_000_000, log: (l) => log.push(l) }) };
  };

  it('a 403 returns forbidden with the status', async () => {
    const scope = await reader(403, SCOPE_403).read('w1');
    expect(scope).toMatchObject({ ok: false, reason: 'forbidden', status: 403, detail: 'scope' });
    const revoked = await reader(403, { error: { type: 'permission_error', message: 'OAuth token has been revoked.' } }).read('w1');
    expect(revoked).toMatchObject({ ok: false, reason: 'forbidden', status: 403, detail: 'expired' });
    const other = await reader(403, { error: { type: 'permission_error', message: 'Not allowed.' } }).read('w1');
    expect(other).toEqual({ ok: false, reason: 'forbidden', status: 403 });
  });

  it('a 401 returns unauthorized', async () => {
    expect(await reader(401, { error: { type: 'authentication_error', message: 'OAuth token has expired.' } }).read()).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
  });

  it('a 429 with Retry-After returns the wait in milliseconds', async () => {
    expect(await reader(429, { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }, { 'retry-after': '120' }).read()).toEqual({ ok: false, reason: 'rate-limited', status: 429, retryAfterMs: 120_000 });
    // No header (or one that is not a number of seconds): no wait is named, the back-off steps apply.
    expect(await reader(429, {}).read()).toEqual({ ok: false, reason: 'rate-limited', status: 429 });
    expect(await reader(429, {}, { 'retry-after': 'soon' }).read()).toEqual({ ok: false, reason: 'rate-limited', status: 429 });
  });

  it('a 5xx is server, no answer is network, no token is no-token', async () => {
    expect(await reader(503, {}).read()).toEqual({ ok: false, reason: 'server', status: 503 });
    expect(await reader(0, {}).read()).toEqual({ ok: false, reason: 'network' });
    expect(await reader(200, BODY, {}, null).read()).toEqual({ ok: false, reason: 'no-token' });
  });

  it('the log line holds the status and the error type and never the token', async () => {
    const r = reader(403, { error: { type: 'permission_error', message: `Token ${TOKEN} does not meet scope requirement` } });
    await r.read('w1');
    await r.read('w1');
    expect(r.log).toHaveLength(1); // said once, not on every read
    expect(r.log[0]).toContain('(w1)');
    expect(r.log[0]).toContain('HTTP 403');
    expect(r.log[0]).toContain('permission_error');
    expect(r.log[0]).toContain('does not meet scope requirement');
    expect(r.log[0]).not.toContain(TOKEN);
    expect(r.log[0]).not.toContain('SECRET');
    const net = reader(0, {});
    await net.read();
    expect(net.log.join('\n')).not.toContain('SECRET');
  });

  it('a 200 returns ok and records the windows as before', async () => {
    const r = reader(200, BODY);
    expect(await r.read()).toEqual({ ok: true });
    expect(r.snaps.get('claude-code', 'acct')!.windows.seven_day_fable.usedPercent).toBe(18);
    expect(r.log).toEqual([]);
  });
});

describe('nextReadAfter (W1-H): one wait rule for every failed read', () => {
  const MIN = 60_000;
  const now = 1_000_000_000;
  const after = (r: Parameters<typeof nextReadAfter>[0], n: number) => (nextReadAfter(r, n, now) - now) / MIN;
  it('a 429 waits for Retry-After when the header is there; else 4, 8, 16, 32 and at most 60 minutes', () => {
    expect(after({ ok: false, reason: 'rate-limited', status: 429, retryAfterMs: 659_000 }, 1)).toBeCloseTo(659 / 60);
    expect([1, 2, 3, 4, 5, 6, 30].map((n) => after({ ok: false, reason: 'rate-limited', status: 429 }, n))).toEqual([4, 8, 16, 32, 60, 60, 60]);
  });
  it('forbidden and unauthorized wait 6 hours', () => {
    expect(after({ ok: false, reason: 'forbidden', status: 403 }, 1)).toBe(360);
    expect(after({ ok: false, reason: 'unauthorized', status: 401 }, 7)).toBe(360);
  });
  it('server and network wait 4, 8, 16 and at most 30 minutes; a good read waits for nothing', () => {
    expect([1, 2, 3, 4, 9].map((n) => after({ ok: false, reason: 'server', status: 500 }, n))).toEqual([4, 8, 16, 30, 30]);
    expect([1, 4].map((n) => after({ ok: false, reason: 'network' }, n))).toEqual([4, 30]);
    expect(after({ ok: true }, 0)).toBe(0);
  });
});
