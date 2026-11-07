import { describe, it, expect } from 'vitest';
import { chipModel, usageTables, liveValue, STALE_MS, ringModels, chipRings, entryName } from './usageGauge';
import type { UsageSummary, UsageSummaryProvider } from '../../api/types';

const NOW = Date.UTC(2026, 10, 5, 17, 0);
const H = 3600_000;
const claude = (five: number | null, week: number | null, extra: Record<string, any> = {}, asOf = NOW - 60_000): UsageSummaryProvider => ({
  provider: 'claude-code', asOf, windows: { five_hour: { usedPercent: five, resetsAt: NOW + 2 * H }, seven_day: { usedPercent: week, resetsAt: NOW + 72 * H }, ...extra },
});
const codex = (five: number, week: number): UsageSummaryProvider => ({ provider: 'codex', plan: 'plus', asOf: NOW - 60_000, windows: { five_hour: { usedPercent: five, resetsAt: NOW + H }, seven_day: { usedPercent: week, resetsAt: NOW + 50 * H } } });
const sum = (providers: UsageSummaryProvider[], o: Partial<UsageSummary> = {}): UsageSummary => ({ warnPercent: 80, providers, paused: [], ...o });
const pause = (provider = 'claude-code') => ({ provider, kind: 'session', earliestResetsAt: NOW + H, threads: 1, capped: 0, chat: false, firstTerminalId: 't', firstSessionId: 's', episodeStartedAt: NOW - H, latestStartedAt: NOW - H, activeUntil: NOW + H });

describe('chipModel', () => {
  it('is hidden with no data', () => {
    expect(chipModel(null, NOW)).toBeNull();
    expect(chipModel(sum([]), NOW)).toBeNull();
  });

  it('shows the 5-hour and weekly figures, no mark for one provider', () => {
    const m = chipModel(sum([claude(46, 21)]), NOW)!;
    expect(m).toMatchObject({ provider: 'claude-code', mark: null, tone: 'normal', stale: false, five: '46', week: '21', peak: '46%' });
    expect(m.title).toBe('Claude usage, Session (5h) 46%, Weekly 21%');
  });

  it('turns amber at the threshold exactly, not below', () => {
    expect(chipModel(sum([claude(79, 21)]), NOW)!.tone).toBe('normal');
    const m = chipModel(sum([claude(80, 21)]), NOW)!;
    expect(m.tone).toBe('amber');
    expect(m.title).toContain('Session (5h) is past the 80% warning level');
  });

  it('a per-model weekly window counts and shows as the weekly figure', () => {
    const m = chipModel(sum([claude(10, 21, { seven_day_opus: { usedPercent: 85, resetsAt: NOW + H } })]), NOW)!;
    expect(m.tone).toBe('amber');
    expect(m.week).toBe('85');
    expect(m.title).toContain('Opus 85%');
  });

  it('overage never counts', () => {
    expect(chipModel(sum([claude(10, 21, { overage: { usedPercent: 99, resetsAt: NOW + H } })]), NOW)!.tone).toBe('normal');
  });

  it('turns red while that provider is paused, and the paused provider wins the pick', () => {
    const m = chipModel(sum([claude(99, 50), codex(10, 5)], { paused: [pause('codex')] }), NOW)!;
    expect(m).toMatchObject({ provider: 'codex', tone: 'red', mark: 'X' });
  });

  it('is not red once the limit has reset, even if the thread is still stopped', () => {
    const stopped = { ...pause(), capped: 1, activeUntil: NOW - 1 };
    expect(chipModel(sum([claude(10, 20)], { paused: [stopped] }), NOW)!.tone).toBe('normal');
    // ...and the next window's warning shows again.
    expect(chipModel(sum([claude(85, 20)], { paused: [stopped] }), NOW)!.tone).toBe('amber');
    // Still red while the reset is ahead, and when an older daemon sends no end time.
    expect(chipModel(sum([claude(10, 20)], { paused: [{ ...stopped, activeUntil: NOW + 1 }] }), NOW)!.tone).toBe('red');
    expect(chipModel(sum([claude(10, 20)], { paused: [{ ...stopped, activeUntil: null }] }), NOW)!.tone).toBe('red'); // unknown end: red until it clears
    const { activeUntil: _a, ...old } = stopped;
    expect(chipModel(sum([claude(10, 20)], { paused: [old] }), NOW)!.tone).toBe('red');
  });

  it('a provider whose pause is over does not win the pick', () => {
    const m = chipModel(sum([claude(10, 5), codex(30, 5)], { paused: [{ ...pause(), activeUntil: NOW - 1 }] }), NOW)!;
    expect(m.provider).toBe('codex');
  });

  // Review finding 3: a paused provider with no snapshot hid behind a normal chip of another provider.
  it('a paused provider with no figures still wins the pick, red, with unknown percents', () => {
    const m = chipModel(sum([claude(46, 21)], { paused: [pause('codex')] }), NOW)!;
    expect(m).toMatchObject({ provider: 'codex', tone: 'red', mark: 'X', stale: false, five: '–', week: '–', peak: '–' });
    expect(m.title).toBe('Codex usage, Session (5h) –, Weekly –. Agents paused on a limit');
  });

  it('a paused provider whose limit is over does not get a placeholder chip', () => {
    expect(chipModel(sum([], { paused: [{ ...pause('codex'), activeUntil: NOW - 1 }] }), NOW)).toBeNull();
  });

  it('shows a paused provider when no provider has figures at all', () => {
    const m = chipModel(sum([], { paused: [pause('codex')] }), NOW)!;
    expect(m).toMatchObject({ provider: 'codex', tone: 'red', mark: null, peak: '–' });
  });

  it('with two providers, shows the one with the highest counted window, with its mark', () => {
    const m = chipModel(sum([claude(30, 21), codex(10, 60)]), NOW)!;
    expect(m).toMatchObject({ provider: 'codex', mark: 'X', five: '10', week: '60', peak: '60%' });
  });

  it('a window past its reset shows – and does not count', () => {
    const p = claude(95, 21);
    p.windows.five_hour.resetsAt = NOW - 1;
    const m = chipModel(sum([p]), NOW)!;
    expect(m).toMatchObject({ five: '–', tone: 'normal', peak: '21%' });
  });

  it('a null figure (older CLI) shows –', () => {
    expect(chipModel(sum([claude(null, null)]), NOW)!).toMatchObject({ five: '–', week: '–', peak: '–', tone: 'normal' });
  });

  it('dims when the figures are older than 30 minutes', () => {
    expect(chipModel(sum([claude(46, 21, {}, NOW - STALE_MS - 1)]), NOW)!.stale).toBe(true);
    expect(chipModel(sum([claude(46, 21, {}, NOW - STALE_MS + 1000)]), NOW)!.stale).toBe(false);
  });
});

describe('usageTables', () => {
  it('lists every provider with plan, labelled rows in CLI order, and As of', () => {
    const t = usageTables(sum([claude(82, 21, { overage: { usedPercent: 3, resetsAt: NOW + H } }), codex(10, 5)]), NOW, 'UTC');
    expect(t.map((x) => x.name)).toEqual(['Claude', 'Codex']);
    // The overage window is money, shown by the ring sheet's spend line, not a percent row (2026-11-06).
    expect(t[0].rows.map((r) => r.label)).toEqual(['Session (5h)', 'Weekly']);
    expect(t[0].rows[0]).toEqual({ label: 'Session (5h)', value: '82% used, resets 7:00 PM', tone: 'amber' });
    expect(t[0].asOf).toBe('As of 4:59 PM');
    expect(t[1].plan).toBe('plus');
  });
});

describe('liveValue', () => {
  it('rounds and drops past-reset and null figures', () => {
    expect(liveValue({ usedPercent: 46.6, resetsAt: NOW + 1 }, NOW)).toBe(47);
    expect(liveValue({ usedPercent: 46, resetsAt: NOW }, NOW)).toBeNull();
    expect(liveValue({ usedPercent: null, resetsAt: NOW + 1 }, NOW)).toBeNull();
    expect(liveValue(undefined, NOW)).toBeNull();
  });
});

describe('the usage read\'s windows and money (2026-11-06)', () => {
  it('ringModels shows Fable from seven_day_fable, hides the CLI\'s seven_day_overage_included, and carries spend and credits', () => {
    const p = claude(10, 11, { seven_day_fable: { usedPercent: 18, resetsAt: NOW + H }, seven_day_overage_included: { usedPercent: 11, resetsAt: NOW + H } });
    (p as any).spend = { usedMinor: 251, limitMinor: 100000, currency: 'USD' };
    const c = codex(2, 0);
    (c as any).creditBalance = { balance: 83272.63, unlimited: false };
    const m = ringModels(sum([p, c]), NOW, 'UTC');
    expect(m[0].rows.map((r) => r.label)).toEqual(expect.arrayContaining(['5-hour', 'weekly', 'Fable weekly']));
    expect(m[0].rows.map((r) => r.type)).not.toContain('seven_day_overage_included');
    expect(m[0].spend).toBe('Extra usage $2.51 of $1,000.00 this month');
    expect(m[1].creditBalance).toBe('83,273 credits');
    expect(m[1].spend).toBeNull();
  });
  it('a provider with only money and no live window still gets a card', () => {
    const c = codex(2, 0);
    c.windows = {};
    (c as any).creditBalance = { balance: 5, unlimited: false };
    const m = ringModels(sum([c]), NOW, 'UTC');
    expect(m).toHaveLength(1);
    expect(m[0].rows).toEqual([]);
    expect(m[0].creditBalance).toBe('5 credits');
  });
});

describe('accounts (multi-account spec 2026-11-06)', () => {
  it('names an entry by tool alone, or by tool and account when the tool has several; rings and cards get one entry each', () => {
    const a = { ...claude(10, 20), accountId: 'cli', label: 'CLI login' };
    const b = { ...claude(30, 40), accountId: 'w1', label: 'Work' };
    const c = { ...codex(5, 6), accountId: 'cli', label: 'CLI login' };
    const s = sum([a, b, c]);
    expect(entryName(a, s.providers)).toBe('Claude · CLI login');
    expect(entryName(c, s.providers)).toBe('Codex');
    expect(ringModels(s, NOW, 'UTC').map((m) => [m.accountId, m.name])).toEqual([['cli', 'Claude · CLI login'], ['w1', 'Claude · Work'], ['cli', 'Codex']]);
    expect(chipRings(s, NOW).map((r) => `${r.provider}|${r.accountId}`)).toEqual(['claude-code|cli', 'claude-code|w1', 'codex|cli']);
    expect(usageTables(s, NOW, 'UTC').map((t) => t.name)).toEqual(['Claude · CLI login', 'Claude · Work', 'Codex']);
  });
});

describe('the ring ignores a model window the thread does not use (2026-11-07)', () => {
  const W = (p: number) => ({ usedPercent: p, resetsAt: NOW + 50 * H });
  const s = () => sum([{ provider: 'claude-code', asOf: NOW - 60_000, windows: { five_hour: W(20), seven_day: W(67), seven_day_fable: W(100) } } as UsageSummaryProvider]);
  it('with no model: the 5-hour and weekly windows only (Fable at 100% does not fill the ring)', () => {
    const [r] = chipRings(s(), NOW);
    expect(r.used).toBe(67);
    expect(r.type).toBe('seven_day');
    expect(r.title).toContain('Fable weekly 100% used'); // the tooltip still lists it
  });
  it('a thread on Fable: its model window counts', () => {
    expect(chipRings(s(), NOW, undefined, { model: 'claude-fable-5-1' })[0].used).toBe(100);
    expect(chipRings(s(), NOW, undefined, { model: 'fable' })[0].used).toBe(100);
  });
  it('a thread on Opus: the Fable window does not count', () => {
    expect(chipRings(s(), NOW, undefined, { model: 'claude-opus-5-5' })[0].used).toBe(67);
  });
});
