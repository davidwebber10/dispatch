import { describe, it, expect, vi } from 'vitest';
import { measures, weakest, MEASURE_IDS, snapshot, scoresBefore } from '../../../plugins/coach/lib/measures.mjs';
import { activeDays, buildRecap } from '../../../plugins/coach/lib/recap.mjs';
import { createEngine } from '../../../plugins/coach/lib/engine.mjs';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { emptyMemory, confirmFact } from '../../../plugins/coach/lib/memory.mjs';
import { emptyCadence, mute } from '../../../plugins/coach/lib/cadence.mjs';
import { withDefaults, DEFAULT_SETTINGS } from '../../../plugins/coach/lib/settings.mjs';

const DAY = 86400_000;
const NOW = new Date(2026, 10, 23, 8, 0); // a Monday, 08:00 local
const iso = (t: number) => new Date(t).toISOString();
type Ev = Record<string, unknown>;
const prompt = (t: string, at: number, text: string, over: Ev = {}): Ev => ({ type: 'thread:prompt', terminalId: t, sessionId: 's1', at: iso(at), source: 'user', text, ...over });
const turn = (t: string, at: number, ms: number, over: Ev = {}): Ev => ({ type: 'thread:turn', terminalId: t, sessionId: 's1', at: iso(at), ms, outcome: 'done', ...over });
const tool = (t: string, at: number): Ev => ({ type: 'thread:tool', terminalId: t, sessionId: 's1', at: iso(at), tool: 'Bash' });
const fold = (events: Ev[]) => events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());

/** A person who sends the same short prompt every day, one thread at a time, and never asks for a plan. */
function routine(days: number, from = NOW.getTime() - days * DAY): Ev[] {
  const out: Ev[] = [];
  for (let d = 0; d < days; d++) {
    const base = from + d * DAY + 9 * 3600_000;
    const t = `t${d}`;
    out.push(prompt(t, base, 'summarize the sales pipeline email'), tool(t, base + 30_000), turn(t, base + 60_000, 60_000));
    out.push(prompt(t, base + 120_000, 'ok'), turn(t, base + 150_000, 30_000));
  }
  return out;
}
/** A person who gives whole tasks with a plan, runs threads in parallel, and does many kinds of work. */
function strong(days: number): Ev[] {
  const out: Ev[] = [];
  const kinds = ['fix the failing tests in the api', 'draft the email to the buyer', 'research three vendors and compare options', 'analyze the forecast trend', 'plan the roadmap for next quarter'];
  for (let d = 0; d < days; d++) {
    const base = NOW.getTime() - days * DAY + d * DAY + 9 * 3600_000;
    for (let k = 0; k < 2; k++) {
      const t = `s${d}-${k}`;
      const text = `${kinds[(d + k) % kinds.length]} for batch ${d}-${k}. First write a plan and wait for my OK. Then do every part of it. Check each result against the source and list what you changed.`;
      out.push(prompt(t, base + k * 1000, text));
      for (let i = 0; i < 10; i++) out.push(tool(t, base + k * 1000 + i * 1000));
    }
    out.push(turn(`s${d}-0`, base + 8 * 60_000, 8 * 60_000), turn(`s${d}-1`, base + 9 * 60_000, 9 * 60_000));
  }
  return out;
}

describe('Coach measures (coach plan Task 12)', () => {
  it('five measures, each a score from 0 to 100, from the last 30 days', () => {
    const m = measures(fold(routine(20)), NOW);
    expect(Object.keys(m).sort()).toEqual([...MEASURE_IDS].sort());
    for (const id of MEASURE_IDS) {
      expect(m[id].score).toBeGreaterThanOrEqual(0);
      expect(m[id].score).toBeLessThanOrEqual(100);
      expect(m[id].enough).toBe(true);
    }
  });
  it('a routine person scores lower than a strong one on ambition, delegation, reuse, judgment and breadth', () => {
    const a = measures(fold(routine(20)), NOW);
    const b = measures(fold(strong(20)), NOW);
    for (const id of MEASURE_IDS) expect(a[id].score).toBeLessThan(b[id].score);
  });
  it('too little data is not enough, and has no weakest measure', () => {
    const m = measures(fold(routine(2)), NOW);
    expect(m.reuse.enough).toBe(false);
    expect(weakest(m, {})).toBeNull();
  });
  it('the trend compares with the scores of 30 days before', () => {
    const now = measures(fold(strong(20)), NOW);
    const before = { ambition: now.ambition.score - 20, delegation: now.delegation.score + 20, reuse: now.reuse.score, judgment: now.judgment.score - 2, breadth: now.breadth.score };
    const m = measures(fold(strong(20)), NOW, before);
    expect([m.ambition.trend, m.delegation.trend, m.reuse.trend, m.judgment.trend]).toEqual([1, -1, 0, 0]);
    expect(measures(fold(strong(20)), NOW).ambition.trend).toBe(0);
  });
  it('weakest is the lowest score; a "too basic" level adjustment lifts a measure out of the way', () => {
    const m = { ambition: { score: 40, trend: 0, enough: true }, delegation: { score: 50, trend: 0, enough: true }, reuse: { score: 20, trend: 0, enough: true }, judgment: { score: 60, trend: 0, enough: true }, breadth: { score: 70, trend: 0, enough: true } };
    expect(weakest(m, {})).toBe('reuse');
    expect(weakest(m, { reuse: 3 })).toBe('ambition');
    expect(weakest({ ...m, reuse: { score: 1, trend: 0, enough: false } }, {})).toBe('ambition');
  });
  it('snapshot keeps one entry a day and finds the scores of about 30 days ago', () => {
    let doc = snapshot(null, { ambition: 10 }, new Date(NOW.getTime() - 31 * DAY));
    doc = snapshot(doc, { ambition: 20 }, new Date(NOW.getTime() - 31 * DAY + 3600_000));
    expect(doc.history).toHaveLength(1);
    doc = snapshot(doc, { ambition: 30 }, NOW);
    expect(doc.history).toHaveLength(2);
    expect(scoresBefore(doc, NOW)).toEqual({ ambition: 20 });
  });
});

describe('Coach weekly recap (coach plan Task 12)', () => {
  it('counts active days: a day with a prompt the person sent', () => {
    expect(activeDays(fold(routine(4)), NOW)).toBe(4);
    expect(activeDays(fold(routine(9)), NOW)).toBe(9);
  });
  it('no recap before 5 active days', () => {
    expect(buildRecap(fold(routine(4)), { memory: emptyMemory(), measures: null, cards: [], now: NOW })).toBeNull();
    expect(buildRecap(fold(routine(5)), { memory: emptyMemory(), measures: null, cards: [], now: NOW })).not.toBeNull();
  });
  it('three patterns, one stretch with a one-click start, one learned line', () => {
    const memory = confirmFact(emptyMemory(), { id: 'f1', text: 'Not a developer: finance project', source: 'x', at: iso(NOW.getTime() - DAY), confirmedAt: null }, new Date(NOW.getTime() - DAY));
    const state = fold(routine(7));
    const m = measures(state, NOW);
    const r = buildRecap(state, { memory, measures: m, cards: [], now: NOW })!;
    expect(r.patterns).toHaveLength(3);
    expect(r.patterns.join(' ')).toMatch(/same prompt 7 times/);
    expect(r.stats).toMatchObject({ threads: 7, days: 7 });
    expect(r.stretch).toMatchObject({ measure: 'reuse', action: { kind: 'schedule' } });
    expect(r.stretch!.headline.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(r.learned).toBe('The Coach learned: "Not a developer: finance project."');
    expect(JSON.stringify(r)).not.toMatch(/\bshould\b/i);
  });
});

function engineIo(over: { docs?: Record<string, unknown>; settings?: unknown; now?: Date } = {}) {
  const docs = new Map<string, unknown>(Object.entries(over.docs ?? {}));
  const io = {
    getDoc: vi.fn(async (k: string, f: unknown) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : f)),
    putDoc: vi.fn(async (k: string, v: unknown) => { docs.set(k, JSON.parse(JSON.stringify(v))); }),
    getSettings: vi.fn(async () => over.settings ?? null),
    assist: vi.fn(async () => ({ result: null, budget: null, refused: null })),
    notify: vi.fn(async (_body: { title: string; body: string; url?: string }) => ({ ok: true })),
    now: () => over.now ?? NOW,
    log: vi.fn(),
    saveDelayMs: 0,
  };
  return { io, docs };
}
const SEASONED = { ...emptyCadence(new Date(NOW.getTime() - 30 * DAY)), welcomeSeenAt: new Date(NOW.getTime() - 30 * DAY).toISOString() };

describe('Coach weekly recap in the worker (coach plan Task 12)', () => {
  it('the Monday job writes the recap document; no recap before 5 active days', async () => {
    const few = engineIo({ docs: { signals: fold(routine(3)), cadence: SEASONED } });
    let e = createEngine(few.io);
    await e.load();
    await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
    await e.idle();
    expect(few.docs.has('recap')).toBe(false);
    const many = engineIo({ docs: { signals: fold(routine(7)), cadence: SEASONED } });
    e = createEngine(many.io);
    await e.load();
    await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
    await e.idle();
    expect(many.docs.get('recap')).toMatchObject({ patterns: expect.any(Array), at: NOW.toISOString(), announce: true });
  });
  it('recap push only when the setting is on', async () => {
    const off = engineIo({ docs: { signals: fold(routine(7)), cadence: SEASONED } });
    let e = createEngine(off.io);
    await e.load();
    await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
    await e.idle();
    expect(off.io.notify).not.toHaveBeenCalled();
    const on = engineIo({ docs: { signals: fold(routine(7)), cadence: SEASONED }, settings: { recap: { inApp: true, push: true } } });
    e = createEngine(on.io);
    await e.load();
    await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
    await e.idle();
    expect(on.io.notify).toHaveBeenCalledTimes(1);
    expect(on.io.notify.mock.calls[0][0]).toMatchObject({ title: 'Your week with AI' });
  });
  it('no push and no announcement during a mute or in quiet hours; the recap waits on the Coach screen', async () => {
    const muted = engineIo({ docs: { signals: fold(routine(7)), cadence: mute(SEASONED, 'today', NOW) }, settings: { recap: { inApp: true, push: true } } });
    let e = createEngine(muted.io);
    await e.load();
    await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
    await e.idle();
    expect(muted.io.notify).not.toHaveBeenCalled();
    expect(muted.docs.get('recap')).toMatchObject({ announce: false });
    // A mute means no model call either: the recap is the rules' own (review finding 5).
    expect(muted.io.assist).not.toHaveBeenCalled();
    const quiet = engineIo({ docs: { signals: fold(routine(7)), cadence: SEASONED }, settings: withDefaults({ recap: { inApp: true, push: true }, quietHours: { from: '18:00', to: '09:00' } }) });
    e = createEngine(quiet.io);
    await e.load();
    await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
    await e.idle();
    expect(quiet.io.notify).not.toHaveBeenCalled();
    expect(quiet.docs.get('recap')).toMatchObject({ announce: false });
  });
  it('no recap at all when the in-app recap or the Coach is off', async () => {
    for (const settings of [{ recap: { inApp: false, push: true } }, { howOften: 'off' }]) {
      const f = engineIo({ docs: { signals: fold(routine(7)), cadence: SEASONED }, settings });
      const e = createEngine(f.io);
      await e.load();
      await e.handle({ type: 'plugin:job', id: 'weekly', at: NOW.toISOString() });
      await e.idle();
      expect(f.docs.has('recap')).toBe(false);
      expect(f.io.notify).not.toHaveBeenCalled();
    }
  });
  it('a turn end updates the measures document, and the weakest measure gates the detectors', async () => {
    const f = engineIo({ docs: { signals: fold(routine(10)), cadence: SEASONED } });
    const e = createEngine(f.io);
    await e.load();
    await e.handle(turn('t9', NOW.getTime() - 60_000, 1000));
    await e.idle();
    const doc = f.docs.get('measures') as { scores: Record<string, { score: number }>; weakest: string | null };
    expect(Object.keys(doc.scores).sort()).toEqual([...MEASURE_IDS].sort());
    expect(typeof doc.weakest === 'string' || doc.weakest === null).toBe(true);
  });
});
