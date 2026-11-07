import { describe, it, expect, vi } from 'vitest';
import { createEngine } from '../../../plugins/coach/lib/engine.mjs';
import { emptyCadence, mute } from '../../../plugins/coach/lib/cadence.mjs';

// The worker's engine against a fake daemon: documents in a map, assist a spy.
const T0 = Date.parse('2026-11-20T10:00:00Z');
const BIG = 'Pull last week returns by reason from the warehouse table. Chart them by week and by store. Compare them with the prior month and list the three biggest changes. Then email the summary to Sam with the chart attached. Keep it short and plain for the ops team, who read it on their phones between meetings. '.repeat(2);
const GOOD = { fit: true, confidence: 0.9, headline: 'Ask for a plan first', why: 'Your prompt had 4 parts and no plan step.', action: { kind: 'compose', label: 'Try it: ask for a plan', text: 'Before you start, write a short plan and wait for my OK.' } };

function fakeIo(over: { docs?: Record<string, unknown>; settings?: unknown; answers?: unknown[]; budget?: unknown } = {}) {
  const docs = new Map<string, unknown>(Object.entries(over.docs ?? {}));
  let t = T0;
  const answers = [...(over.answers ?? [GOOD, GOOD])];
  const assist = vi.fn(async () => {
    const a = answers.shift();
    return { result: a === undefined ? null : { text: typeof a === 'string' ? a : JSON.stringify(a), harness: 'claude' }, budget: over.budget ?? { usedPercent: 0.4, capPercent: 3 }, refused: null };
  });
  const io = {
    getDoc: vi.fn(async (k: string, f: unknown) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : f)),
    putDoc: vi.fn(async (k: string, v: unknown) => { docs.set(k, JSON.parse(JSON.stringify(v))); }),
    getSettings: vi.fn(async () => over.settings ?? null),
    assist,
    notify: vi.fn(async () => ({ ok: true })),
    now: () => new Date(t),
    log: vi.fn(),
  };
  return { io, docs, assist, advance: (min: number) => { t += min * 60_000; } };
}
const ev = (type: string, minFromT0: number, over: Record<string, unknown> = {}) => ({ type, terminalId: 't1', sessionId: 's1', at: new Date(T0 + minFromT0 * 60_000).toISOString(), ...over });

describe('Coach worker engine (coach plan Task 9)', () => {
  it('a turn that ends after a big prompt with no plan: a candidate, judged, becomes a card in `cards`; the budget headers are kept', async () => {
    const f = fakeIo();
    const e = createEngine(f.io);
    await e.load();
    await e.handle(ev('thread:prompt', 0, { source: 'user', text: BIG }));
    await e.handle(ev('thread:turn', 0, { ms: 30_000, outcome: 'done' }));
    await e.idle();
    expect((f.docs.get('candidates') as { items: { type: string }[] }).items.map((c) => c.type)).toContain('no-plan-big-task');
    const cards = f.docs.get('cards') as { items: { id: string; headline: string; terminalId: string }[]; judged: { outcome: string }[] };
    expect(cards.items).toHaveLength(1);
    expect(cards.items[0]).toMatchObject({ headline: 'Ask for a plan first', terminalId: 't1' });
    expect(cards.judged.map((j) => j.outcome)).toEqual(['card']);
    expect(f.docs.get('status')).toMatchObject({ budget: { usedPercent: 0.4, capPercent: 3 }, level: 'balanced', stepped: false });
  });

  it('a malformed answer: no card, the candidate is recorded as dropped and not judged again', async () => {
    const f = fakeIo({ answers: ['{"fit": tr'] });
    const e = createEngine(f.io);
    await e.load();
    await e.handle(ev('thread:prompt', 0, { source: 'user', text: BIG }));
    await e.handle(ev('thread:turn', 0, { ms: 30_000 }));
    await e.idle();
    const cards = f.docs.get('cards') as { items: unknown[]; judged: { outcome: string }[] };
    expect(cards.items).toEqual([]);
    expect(cards.judged.map((j) => j.outcome)).toEqual(['dropped']);
    await e.handle(ev('thread:turn', 1, { ms: 1000 }));
    await e.idle();
    expect(f.assist).toHaveBeenCalledTimes(1);
  });

  it('nothing is judged during a mute: nothing queues for later', async () => {
    const f = fakeIo({ docs: { cadence: mute(emptyCadence(new Date(T0 - 86400_000 * 10)), 'hour', new Date(T0)) } });
    const e = createEngine(f.io);
    await e.load();
    await e.handle(ev('thread:prompt', 0, { source: 'user', text: BIG }));
    await e.handle(ev('thread:turn', 0, { ms: 30_000 }));
    await e.idle();
    expect(f.assist).not.toHaveBeenCalled();
    expect((f.docs.get('cards') as { judged: { outcome: string }[] }).judged.map((j) => j.outcome)).toEqual(['muted']);
  });

  it('at the budget cap the judge makes no call; the candidate waits', async () => {
    const f = fakeIo({ docs: { status: { budget: { usedPercent: 3, capPercent: 3 } } } });
    const e = createEngine(f.io);
    await e.load();
    await e.handle(ev('thread:prompt', 0, { source: 'user', text: BIG }));
    await e.handle(ev('thread:turn', 0, { ms: 30_000 }));
    await e.idle();
    expect(f.assist).not.toHaveBeenCalled();
    expect((f.docs.get('cards') ?? { judged: [] }) as object).toMatchObject({ judged: [] });
  });

  it('events from a left-alone project or a non-user source produce no candidate and no call', async () => {
    const f = fakeIo({ settings: { leaveAlone: ['s1'] } });
    const e = createEngine(f.io);
    await e.load();
    await e.handle(ev('thread:prompt', 0, { source: 'user', text: BIG }));
    await e.handle(ev('thread:prompt', 0, { source: 'thread', text: BIG, sessionId: 's2', terminalId: 't2' }));
    await e.handle(ev('thread:turn', 0, { ms: 30_000 }));
    await e.idle();
    expect(f.assist).not.toHaveBeenCalled();
    expect(f.docs.has('cards')).toBe(false);
  });
});
