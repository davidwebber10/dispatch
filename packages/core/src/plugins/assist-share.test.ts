import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as pluginData from '../db/plugin-data.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { estimateShare, pickHarness } from './assist-share.js';
import type { UsageSummary, SummaryProvider } from '../limits/gauge.js';

/** A plugin's share of a usage limit, and the automatic harness (coach plan, Task 3). */
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const H = 3_600_000;

function summary(providers: Partial<SummaryProvider>[]): UsageSummary {
  return {
    type: 'usage-limits', at: NOW, epoch: 'e', rev: 1, warnPercent: 80, pushOnWarn: false, paused: [],
    providers: providers.map((p) => ({ provider: 'claude-code', accountId: 'cli', label: 'x', asOf: NOW, windows: {}, ...p })),
  };
}
const win = (usedPercent: number | null, resetsInMs: number) => ({ usedPercent, resetsAt: NOW + resetsInMs });

describe('estimateShare', () => {
  let db: Database.Database;
  const turn = (id: string, terminal: string, model: string, input: number, output: number, at = new Date(NOW - H).toISOString(), provider = 'claude-code') =>
    db.prepare('INSERT INTO usage_turns (id, terminal_id, project_id, provider, model, started_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, terminal, 'p', provider, model, at, input, output);
  const term = (id: string, config: Record<string, unknown>, type = 'claude-code') =>
    terminalsDb.create(db, { id, sessionId: 's', type, label: id, config });
  const call = (pluginId: string, model: string, input: number, output: number, accountId = 'cli', at = new Date(NOW - H).toISOString(), harness = 'claude') =>
    pluginData.recordAssist(db, pluginId, { at, model, harness, accountId, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: null, ms: 1, ok: true });

  beforeEach(() => {
    db = new Database(':memory:'); initSchema(db);
    sessionsDb.create(db, { id: 's', provider: 'claude-code', name: 'S', workingDir: '/tmp' });
  });

  it("share is the plugin's weighted token fraction of the account's window, times the used percent", () => {
    term('t1', {});
    turn('u1', 't1', 'claude-opus-5', 3000, 600);
    call('coach', 'claude-opus-5', 1000, 200);
    // Another plugin's call counts toward the account, not toward this plugin.
    call('other', 'claude-opus-5', 1000, 200);
    // Outside the window, or another account: not counted.
    call('coach', 'claude-opus-5', 50_000, 50_000, 'cli', new Date(NOW - 6 * H).toISOString());
    call('coach', 'claude-opus-5', 50_000, 50_000, 'work');
    const s = summary([{ windows: { five_hour: win(40, 4 * H), seven_day: win(20, 3 * 24 * H) } }]);
    const five = estimateShare(db, s, { pluginId: 'coach', accountId: 'cli', window: 'five_hour', now: NOW })!;
    // Opus all round: weights are proportional to tokens. 1200 of 6000 weighted tokens = 1/5 of 40%.
    expect(five.pluginPercent).toBeCloseTo(8, 6);
    expect(five.usedPercent).toBe(40);
    expect(five.pluginTokens).toBe(1200);
    expect(five.accountTokens).toBe(6000);
    expect(five.resetsAt).toBe(new Date(NOW + 4 * H).toISOString());
    // The weekly window reaches back further, so the old call counts there.
    const week = estimateShare(db, s, { pluginId: 'coach', accountId: 'cli', window: 'seven_day', now: NOW })!;
    expect(week.pluginTokens).toBe(101_200);
    // An unknown window or account is null, not 0.
    expect(estimateShare(db, s, { pluginId: 'coach', accountId: 'nobody', window: 'five_hour', now: NOW })).toBeNull();
    expect(estimateShare(db, summary([{ windows: { five_hour: win(null, H) } }]), { pluginId: 'coach', accountId: 'cli', window: 'five_hour', now: NOW })).toBeNull();
    expect(estimateShare(db, null, { pluginId: 'coach', accountId: 'cli', window: 'five_hour', now: NOW })).toBeNull();
  });

  it('a thread pinned to another account, and one on the default account, count where they belong', () => {
    term('pinned', { accountId: 'work' });
    term('plain', {});
    turn('u1', 'pinned', 'claude-opus-5', 1000, 0);
    turn('u2', 'plain', 'claude-opus-5', 1000, 0);
    call('coach', 'claude-opus-5', 1000, 0, 'work');
    const s = summary([{ accountId: 'work', windows: { five_hour: win(50, H) } }]);
    // `work` is the default: the plain thread is on it too.
    expect(estimateShare(db, s, { pluginId: 'coach', accountId: 'work', window: 'five_hour', now: NOW, defaultAccountId: 'work' })!.accountTokens).toBe(3000);
    expect(estimateShare(db, s, { pluginId: 'coach', accountId: 'work', window: 'five_hour', now: NOW })!.accountTokens).toBe(2000);
  });

  it('Haiku tokens weigh less than Opus tokens', () => {
    term('t1', {});
    turn('u1', 't1', 'claude-opus-5', 1000, 1000);
    call('coach', 'claude-haiku-5-5', 1000, 1000);
    const s = summary([{ windows: { five_hour: win(30, H) } }]);
    const r = estimateShare(db, s, { pluginId: 'coach', accountId: 'cli', window: 'five_hour', now: NOW })!;
    // Same tokens, but Haiku costs a fifth of Opus: 1 / (1 + 5) of 30%.
    expect(r.pluginTokens).toBe(r.accountTokens / 2);
    expect(r.pluginPercent).toBeCloseTo(5, 6);
  });

  it('codex accounts read the codex provider and codex threads', () => {
    term('c1', {}, 'codex');
    turn('u1', 'c1', 'gpt-5.6-sol', 900, 100, undefined, 'codex');
    call('coach', 'gpt-5.6-terra', 900, 100, 'cli', undefined, 'codex');
    const s = summary([{ provider: 'codex', windows: { seven_day: win(10, 24 * H) } }]);
    const r = estimateShare(db, s, { pluginId: 'coach', accountId: 'cli', harness: 'codex', window: 'seven_day', now: NOW })!;
    expect(r.pluginPercent).toBeCloseTo(5, 6);
  });
});

describe('pickHarness', () => {
  const signedIn = [
    { harness: 'claude' as const, accountId: 'cli' },
    { harness: 'claude' as const, accountId: 'work' },
    { harness: 'codex' as const, accountId: 'cli' },
  ];

  it('auto picks the account with the most weekly room', () => {
    const s = summary([
      { accountId: 'cli', windows: { five_hour: win(10, H), seven_day: win(70, 24 * H) } },
      { accountId: 'work', windows: { five_hour: win(10, H), seven_day: win(20, 24 * H) } },
      { provider: 'codex', accountId: 'cli', windows: { five_hour: win(10, H), seven_day: win(50, 24 * H) } },
    ]);
    expect(pickHarness(s, signedIn, NOW)).toMatchObject({ harness: 'claude', accountId: 'work' });
  });

  it('auto skips an account at 90% of its 5-hour window', () => {
    const s = summary([
      { accountId: 'cli', windows: { five_hour: win(10, H), seven_day: win(70, 24 * H) } },
      { accountId: 'work', windows: { five_hour: win(90, H), seven_day: win(5, 24 * H) } },
      { provider: 'codex', accountId: 'cli', windows: { five_hour: win(95, H), seven_day: win(1, 24 * H) } },
    ]);
    const pick = pickHarness(s, signedIn, NOW)!;
    expect(pick).toMatchObject({ harness: 'claude', accountId: 'cli' });
    // Every subscription at its floor and no key: nothing to run on.
    const full = summary([
      { accountId: 'cli', windows: { five_hour: win(91, H) } },
      { accountId: 'work', windows: { five_hour: win(99, H) } },
      { provider: 'codex', accountId: 'cli', windows: { five_hour: win(90, H) } },
    ]);
    expect(pickHarness(full, signedIn, NOW)).toBeNull();
    // ...but an OpenRouter key has no limit to protect.
    expect(pickHarness(full, [...signedIn, { harness: 'openrouter', accountId: 'openrouter' }], NOW)).toMatchObject({ harness: 'openrouter' });
  });

  it('auto with no usage summary falls back to the first signed-in harness and says why', () => {
    expect(pickHarness(null, signedIn, NOW)).toEqual({ harness: 'claude', accountId: 'cli', reason: 'no usage data' });
    // A summary that knows none of the accounts (no Claude login read yet, Codex poll gap after restart): the same.
    expect(pickHarness(summary([]), signedIn, NOW)).toEqual({ harness: 'claude', accountId: 'cli', reason: 'no usage data' });
    // A known account beats an unknown one; a window whose reset has passed counts as empty.
    const s = summary([{ provider: 'codex', accountId: 'cli', windows: { five_hour: win(99, -H), seven_day: win(99, -H) } }]);
    expect(pickHarness(s, signedIn, NOW)).toMatchObject({ harness: 'codex', accountId: 'cli' });
    // Nothing signed in: null, never a dead account.
    expect(pickHarness(null, [], NOW)).toBeNull();
  });
});
