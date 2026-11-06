import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { LimitSnapshots } from './snapshot.js';
import { createCodexPoll } from './codex-poll.js';

// The real `codex app-server` answer to account/rateLimits/read (trimmed), 2026-11-05.
const ANSWER = { rateLimits: { limitId: 'codex', primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1794446912 }, secondary: null, planType: 'unknown' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1794446912 }, secondary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1794000000 }, planType: 'pro' } } };

describe('direct Codex poll', () => {
  it('records the app-server windows as Codex limits (weekly and 5-hour, reset in ms, plan)', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    const poll = createCodexPoll({ snapshots: snaps, accountFor: () => 'acct', env: () => ({}), now: () => 1793900000000, read: async () => ANSWER });
    expect(await poll()).toBe(true);
    const s = snaps.get('codex', 'acct')!;
    expect(s.windows.seven_day).toEqual({ usedPercent: 4, resetsAt: 1794446912000 });
    expect(s.windows.five_hour).toEqual({ usedPercent: 30, resetsAt: 1794000000000 });
    expect(s.plan).toBe('pro');
  });

  it('records nothing when Codex cannot be asked', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    expect(await createCodexPoll({ snapshots: snaps, accountFor: () => 'acct', env: () => ({}), read: async () => null })()).toBe(false);
    expect(snaps.get('codex', 'acct')).toBeNull();
  });

  it('keeps the banked reset count, and spending one reads the limits again', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const snaps = new LimitSnapshots(db);
    let reads = 0;
    const answer = { ...ANSWER, rateLimitResetCredits: { availableCount: 3, credits: [{ id: 'c1', status: 'available', expiresAt: 1800000000 }, { id: 'c2', status: 'available', expiresAt: 1799000000 }] } };
    const keys: string[] = [];
    const picked: (string | null)[] = [];
    const poll = createCodexPoll({ snapshots: snaps, accountFor: () => 'acct', env: () => ({}), read: async () => { reads++; return answer; }, consume: async (k, id) => { keys.push(k); picked.push(id); return { outcome: 'reset' }; } });
    expect(poll.credits()).toBeNull();
    await poll();
    // Soonest to expire first, each with its id, so the sheet can list the expiries.
    expect(poll.credits()).toEqual({ available: 3, nextExpiresAt: 1799000000000, credits: [{ id: 'c2', expiresAt: 1799000000000, title: null }, { id: 'c1', expiresAt: 1800000000000, title: null }] });
    expect(await poll.useCredit()).toBe('reset');
    expect(picked).toEqual(['c2']); // by default, the one that would lapse first
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/); // a fresh idempotency key per attempt
    expect(reads).toBe(2);
  });

  it('spends the reset it is asked for', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const picked: (string | null)[] = [];
    const poll = createCodexPoll({ snapshots: new LimitSnapshots(db), accountFor: () => 'acct', env: () => ({}), read: async () => ANSWER, consume: async (_k, id) => { picked.push(id); return { outcome: 'reset' }; } });
    await poll.useCredit('c9');
    expect(picked).toEqual(['c9']);
  });
});

