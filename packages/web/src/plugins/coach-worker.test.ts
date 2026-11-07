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

describe('Coach worker: the budget comes from the daemon, not only from answers (review finding 1)', () => {
  const capped = { usedPercent: 3, capPercent: 3, resetsAt: new Date(T0 + 86400_000).toISOString() };
  const turn = async (e: ReturnType<typeof createEngine>) => {
    await e.handle(ev('thread:prompt', 0, { source: 'user', text: BIG }));
    await e.handle(ev('thread:turn', 0, { ms: 30_000 }));
    await e.idle();
  };

  it('after the window resets, the Coach makes calls again', async () => {
    // The cached figure is from the last window: its reset has passed.
    const f = fakeIo({ docs: { status: { budget: { ...capped, resetsAt: new Date(T0 - 60_000).toISOString() }, budgetAt: new Date(T0 - 60_000).toISOString() } } });
    const e = createEngine(f.io);
    await e.load();
    await turn(e);
    expect(f.assist).toHaveBeenCalled();
  });

  it('raising the budget in settings lets calls resume', async () => {
    let daemonBudget: unknown = capped;
    const f = fakeIo({ docs: { status: { budget: capped, budgetAt: new Date(T0).toISOString() } } });
    const readBudget = vi.fn(async () => daemonBudget);
    const e = createEngine({ ...f.io, readBudget });
    await e.load();
    await turn(e);
    expect(f.assist).not.toHaveBeenCalled();
    // The person raises the budget: the web part saves it, and the settings event follows.
    daemonBudget = { usedPercent: 3, capPercent: 10, resetsAt: capped.resetsAt };
    await e.handle({ type: 'plugin:settings', id: 'coach' });
    await e.idle();
    expect(f.docs.get('status')).toMatchObject({ budget: { capPercent: 10 } });
    f.advance(1);
    await e.handle(ev('thread:prompt', 1, { source: 'user', text: BIG + ' again' }));
    await e.handle(ev('thread:turn', 1, { ms: 30_000 }));
    await e.idle();
    expect(f.assist).toHaveBeenCalled();
  });

  it('a restart re-reads the budget', async () => {
    const f = fakeIo({ docs: { status: { budget: capped, budgetAt: new Date(T0).toISOString() } } });
    const readBudget = vi.fn(async () => ({ usedPercent: 0.5, capPercent: 3, resetsAt: capped.resetsAt }));
    const e = createEngine({ ...f.io, readBudget });
    await e.load();
    expect(readBudget).toHaveBeenCalledTimes(1);
    await turn(e);
    expect(f.assist).toHaveBeenCalled();
  });

  it('the cached budget is read again after 15 minutes, and before the Coach settles on no call', async () => {
    const f = fakeIo({ docs: { status: { budget: capped, budgetAt: new Date(T0 - 16 * 60_000).toISOString() } } });
    const readBudget = vi.fn(async () => capped);
    const e = createEngine({ ...f.io, readBudget });
    await e.load();
    expect(readBudget).toHaveBeenCalledTimes(1);
    f.advance(2);
    await turn(e);
    // At the cap the Coach asks the daemon once more before it decides on no call.
    expect(readBudget).toHaveBeenCalledTimes(2);
    expect(f.assist).not.toHaveBeenCalled();
  });
});
