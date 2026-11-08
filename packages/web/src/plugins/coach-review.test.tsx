import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { planReview, chunkTranscript, reviewPrompt, parseReview, mergeReview, eventsFromTranscript, PERCENT_PER_CHUNK } from '../../../plugins/coach/lib/review.mjs';
import { createEngine } from '../../../plugins/coach/lib/engine.mjs';
import { emptyMemory } from '../../../plugins/coach/lib/memory.mjs';
import { addGoal } from '../../../plugins/coach/lib/goals.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { createCoach } from '../../../plugins/coach/web.js';
import { fakeD, type FakeD } from './coach-test-utils';

const NOW = new Date('2026-11-23T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() - 3 * 86400_000 + min * 60_000).toISOString();
const TRANSCRIPT = [
  { kind: 'user', text: 'fix the null check in parseOrder', ts: at(0) },
  { kind: 'tool', toolName: 'Edit', ts: at(1) },
  { kind: 'assistant', text: 'Fixed parseOrder.', ts: at(2) },
  { kind: 'user', text: 'now fix the same thing in parseInvoice', ts: at(3) },
  { kind: 'assistant', text: 'Fixed parseInvoice.', ts: at(5) },
];

describe('Coach reviews: pure helpers (coach plan Task 12f)', () => {
  it('chunkTranscript writes who said what and cuts at the chunk size', () => {
    const chunks = chunkTranscript(TRANSCRIPT);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Person: fix the null check in parseOrder');
    expect(chunks[0]).toContain('Agent used a tool: Edit');
    expect(chunkTranscript(TRANSCRIPT, 60).length).toBeGreaterThan(1);
  });
  it('planReview estimates before anything runs; over the cap it offers a smaller scope', () => {
    const threads = [{ id: 'a', chunks: 4 }, { id: 'b', chunks: 4 }, { id: 'c', chunks: 4 }];
    const p = planReview({ kind: 'project', ids: ['s1'] }, threads, { usedPercent: 1, capPercent: 3 });
    expect(p).toMatchObject({ threads: ['a', 'b', 'c'], chunks: 12, fits: true });
    expect(p.estPercent).toBeCloseTo(12 * PERCENT_PER_CHUNK);
    const tight = planReview({ kind: 'project', ids: ['s1'] }, threads, { usedPercent: 2.5, capPercent: 3 });
    expect(tight.fits).toBe(false);
    expect(tight.smallerScope).toEqual({ kind: 'thread', ids: ['a', 'b'] });
    expect(planReview({ kind: 'thread', ids: ['a'] }, [{ id: 'a', chunks: 100 }], { usedPercent: 2.9, capPercent: 3 }).smallerScope).toBeUndefined();
  });
  it('planReview with an unknown budget says the cost is unknown, never claims it fits, and offers a smaller scope', () => {
    const threads = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, chunks: 4 }));
    for (const budget of [null, { usedPercent: null, capPercent: 3 }, { usedTokens: 1000, capTokens: 150000 }]) {
      const p = planReview({ kind: 'range', from: '', to: '' }, threads, budget);
      expect(p.fits).not.toBe(true);
      expect(p.costUnknown).toBe(true);
      expect(p.smallerScope).toEqual({ kind: 'thread', ids: ['t0', 't1'] });
    }
    // A small scope with an unknown cost: still not "fits", and no smaller scope to offer.
    const one = planReview({ kind: 'thread', ids: ['t0'] }, [{ id: 't0', chunks: 2 }], null);
    expect(one).toMatchObject({ costUnknown: true, fits: null });
    expect(one.smallerScope).toBeUndefined();
  });
  it('reviewPrompt carries the goals; parseReview keeps only findings that quote the transcript', () => {
    const memory = addGoal(emptyMemory(), { text: 'Hand off whole tasks', measures: ['ambition'], detectors: [], source: 'user' }, NOW).memory;
    const chunk = chunkTranscript(TRANSCRIPT)[0];
    expect(reviewPrompt(chunk, memory).messages[0].content).toContain('Goal: Hand off whole tasks');
    const r = parseReview(JSON.stringify({ findings: [
      { kind: 'handoff', quote: 'now fix the same thing in parseInvoice', note: 'Give it the whole class of bug at once.' },
      { kind: 'plan', quote: 'a sentence nobody wrote', note: 'invented' },
    ], nextSteps: [{ text: 'Ask for every parser at once.', action: { kind: 'new-threads', payload: { prompts: ['x'] } } }] }), chunk)!;
    expect(r.findings.map((f) => f.quote)).toEqual(['now fix the same thing in parseInvoice']);
    expect(r.nextSteps[0].action).toEqual({ kind: 'new-threads', payload: { prompts: ['x'] } });
    expect(parseReview('nope', chunk)).toBeNull();
  });
  it('mergeReview is honest about an empty result', () => {
    expect(mergeReview([], { read: 0 }).summary).toMatch(/no transcript it could read/);
    expect(mergeReview([{ findings: [], nextSteps: [] }], { read: 2 }).summary).toMatch(/found nothing it could tie to a quoted moment/);
  });
  it('eventsFromTranscript makes prompts, tools and turns with their times', () => {
    const ev = eventsFromTranscript('t1', 's1', TRANSCRIPT);
    expect(ev.map((e) => e.type)).toEqual(['thread:prompt', 'thread:tool', 'thread:turn', 'thread:prompt', 'thread:turn']);
    expect(ev[2]).toMatchObject({ at: at(2), ms: 2 * 60_000 });
  });
});

// ── the worker job, against a fake daemon ─────────────────────────────────────────────────
function daemon(over: { threads?: Record<string, { sessionId: string; items: unknown[]; lastActivityAt?: string; config?: Record<string, unknown>; label?: string }>; answers?: unknown[]; status?: unknown; settings?: unknown } = {}) {
  const docs = new Map<string, unknown>([['cadence', emptyCadence(new Date('2026-10-01T00:00:00Z'))]]);
  if (over.status) docs.set('status', over.status);
  const threads = over.threads ?? { t1: { sessionId: 's1', items: TRANSCRIPT, lastActivityAt: at(5) } };
  const answers = [...(over.answers ?? [])];
  const writes: { key: string; value: Record<string, unknown> }[] = [];
  const io = {
    getDoc: vi.fn(async (k: string, f: unknown) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : f)),
    putDoc: vi.fn(async (k: string, v: unknown) => { docs.set(k, JSON.parse(JSON.stringify(v))); writes.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); }),
    getSettings: vi.fn(async () => over.settings ?? null),
    getJson: vi.fn(async (route: string) => {
      if (route === '/api/sessions') return [...new Set(Object.values(threads).map((t) => t.sessionId))].map((id) => ({ id, name: id }));
      let m = /^\/api\/sessions\/([^/]+)\/terminals$/.exec(route);
      if (m) return Object.entries(threads).filter(([, t]) => t.sessionId === m![1]).map(([id, t]) => ({ id, sessionId: t.sessionId, label: id, lastActivityAt: t.lastActivityAt ?? at(5), createdAt: at(0), config: t.config ?? {} }));
      m = /^\/api\/terminals\/([^/?]+)\/conversation/.exec(route);
      if (m) return { items: threads[m[1]]?.items ?? [] };
      m = /^\/api\/terminals\/([^/?]+)$/.exec(route);
      if (m) return threads[m[1]] ? { id: m[1], sessionId: threads[m[1]].sessionId, label: threads[m[1]].label ?? m[1], lastActivityAt: threads[m[1]].lastActivityAt ?? at(5), config: threads[m[1]].config ?? {} } : null;
      return null;
    }),
    assist: vi.fn(async (_req: unknown) => ({ result: answers.length ? { text: String(answers.shift()), harness: 'claude' } : null, budget: { usedPercent: 0.5, capPercent: 3 }, refused: null })),
    notify: vi.fn(),
    now: () => NOW,
    saveDelayMs: 0,
  };
  return { io, docs, writes };
}
const GOOD = JSON.stringify({ findings: [{ kind: 'handoff', quote: 'now fix the same thing in parseInvoice', note: 'Give it every parser at once.' }], nextSteps: [{ text: 'Ask for all parsers in one prompt.' }] });
async function step(e: ReturnType<typeof createEngine>, key: string) { await e.handle({ type: 'plugin:data', id: 'coach', key }); await e.idle(); }

describe('Coach reviews in the worker (coach plan Task 12f)', () => {
  it('planning writes the estimate and makes no model call; nothing runs until Start', async () => {
    const f = daemon({ answers: [GOOD], status: { budget: { usedPercent: 0.5, capPercent: 3 } } });
    f.docs.set('reviews:r1', { id: 'r1', scope: { kind: 'thread', ids: ['t1'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:r1');
    expect(f.docs.get('reviews:r1')).toMatchObject({ state: 'estimate', plan: { threads: ['t1'], chunks: 1, fits: true } });
    expect(f.io.assist).not.toHaveBeenCalled();
  });

  it('after Start it reads with progress, quotes the transcript, writes the report, and posts it to the chat', async () => {
    const f = daemon({ answers: [GOOD] });
    f.docs.set('reviews:r1', { id: 'r1', scope: { kind: 'thread', ids: ['t1'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:r1');
    f.docs.set('reviews:r1', { ...(f.docs.get('reviews:r1') as object), state: 'queued' });
    await step(e, 'reviews:r1');
    const states = f.writes.filter((w) => w.key === 'reviews:r1').map((w) => w.value.state);
    expect(states).toEqual(expect.arrayContaining(['reading', 'writing', 'done']));
    expect(f.writes.find((w) => w.key === 'reviews:r1' && w.value.state === 'reading')!.value.progress).toMatchObject({ done: 0, total: 1 });
    const done = f.docs.get('reviews:r1') as { report: { findings: { quote: string }[]; summary: string } };
    expect(done.report.findings[0].quote).toBe('now fix the same thing in parseInvoice');
    expect(f.io.assist.mock.calls[0][0]).toMatchObject({ harness: 'claude', model: 'opus' });
    expect((f.docs.get('chat') as { turns: { role: string; text: string }[] }).turns.at(-1)!.text).toContain('review');
  });

  it('reports progress after each part: the thread label, the part, and the totals (owner: "stuck on the first chat")', async () => {
    // A long thread: about 3 parts. Each item is near the 800-character cap.
    const LONG = Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `${i} ${'x'.repeat(780)}`, ts: at(i) }));
    const longParts = chunkTranscript(LONG).length;
    expect(longParts).toBeGreaterThan(2);
    const threads = { t1: { sessionId: 's1', items: LONG, lastActivityAt: at(60), label: 'Fix the parsers' }, t2: { sessionId: 's1', items: TRANSCRIPT, lastActivityAt: at(5), label: 'Ship the release' } };
    const f = daemon({ threads, answers: Array(10).fill(GOOD) });
    f.docs.set('reviews:p1', { id: 'p1', scope: { kind: 'project', ids: ['s1'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:p1');
    const startedAt = new Date(NOW.getTime() - 60_000).toISOString();
    f.docs.set('reviews:p1', { ...(f.docs.get('reviews:p1') as object), state: 'queued', startedAt });
    await step(e, 'reviews:p1');
    type P = { done: number; total: number; chunksDone: number; chunksTotal: number; startedAt: string; thread?: { id: string; label: string | null; chunk: number; chunks: number } };
    const progress = f.writes.filter((w) => w.key === 'reviews:p1' && w.value.state === 'reading').map((w) => w.value.progress as P);
    const total = longParts + 1;
    // One write per part (a 20-second model call each), with the thread's own name.
    const perPart = progress.filter((p) => p.thread && p.thread.chunk > 0);
    expect(perPart.map((p) => [p.thread!.id, p.thread!.chunk, p.chunksDone])).toEqual([
      ...Array.from({ length: longParts }, (_, i) => ['t1', i + 1, i]),
      ['t2', 1, longParts],
    ]);
    expect(perPart[1]).toMatchObject({ done: 0, total: 2, chunksTotal: total, startedAt, thread: { id: 't1', label: 'Fix the parsers', chunk: 2, chunks: longParts } });
    expect(perPart.at(-1)).toMatchObject({ done: 1, total: 2, thread: { id: 't2', label: 'Ship the release', chunk: 1, chunks: 1 } });
    // Writing the report: every part is read.
    const writing = f.writes.find((w) => w.key === 'reviews:p1' && w.value.state === 'writing')!.value.progress as P;
    expect(writing).toMatchObject({ done: 2, total: 2, chunksDone: total, chunksTotal: total });
    expect((f.docs.get('reviews:p1') as { state: string }).state).toBe('done');
  });

  it("a skipped or empty thread advances the progress at once, and the plan's part count is corrected", async () => {
    const threads = { t1: { sessionId: 's1', items: TRANSCRIPT }, t2: { sessionId: 's1', items: [] }, t3: { sessionId: 's1', items: TRANSCRIPT } };
    const f = daemon({ threads, answers: [GOOD, GOOD] });
    // The plan said 3 + 4 + 3 parts; each thread really has 1, 0 and 1.
    f.docs.set('reviews:p2', { id: 'p2', scope: { kind: 'project', ids: ['s1'] }, state: 'queued', plan: { threads: ['t1', 't2', 't3'], chunks: 10, parts: { t1: 3, t2: 4, t3: 3 }, estPercent: 0.5, fits: true } });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:p2');
    type P = { done: number; chunksDone: number; chunksTotal: number; thread?: { id: string; chunk: number } };
    const progress = f.writes.filter((w) => w.key === 'reviews:p2' && w.value.state === 'reading').map((w) => w.value.progress as P);
    expect(progress[0]).toMatchObject({ done: 0, chunksDone: 0, chunksTotal: 10 });
    // t1 has 1 part, not 3: the total drops to 8 when it is read.
    expect(progress.find((p) => p.thread && p.thread.id === 't1' && p.thread.chunk === 1)).toMatchObject({ chunksDone: 0, chunksTotal: 8 });
    // t2 is empty: the next write is at thread 3 already, without its 4 parts.
    expect(progress.find((p) => p.done === 2)).toMatchObject({ chunksDone: 1, chunksTotal: 4 });
    const writing = f.writes.find((w) => w.key === 'reviews:p2' && w.value.state === 'writing')!.value.progress as P;
    expect(writing).toMatchObject({ done: 3, chunksDone: 2, chunksTotal: 2 });
    expect(f.io.assist).toHaveBeenCalledTimes(2);
  });

  it("the estimate keeps each thread's part count, so the progress can correct it", async () => {
    const f = daemon({ answers: [GOOD], status: { budget: { usedPercent: 0.5, capPercent: 3 } } });
    f.docs.set('reviews:r1', { id: 'r1', scope: { kind: 'thread', ids: ['t1'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:r1');
    expect(f.docs.get('reviews:r1')).toMatchObject({ plan: { parts: { t1: 1 } } });
  });

  it('Cancel stops further model calls', async () => {
    const threads = { t1: { sessionId: 's1', items: TRANSCRIPT }, t2: { sessionId: 's1', items: TRANSCRIPT }, t3: { sessionId: 's1', items: TRANSCRIPT } };
    const f = daemon({ threads, answers: [GOOD, GOOD, GOOD] });
    f.docs.set('reviews:r2', { id: 'r2', scope: { kind: 'project', ids: ['s1'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:r2');
    f.docs.set('reviews:r2', { ...(f.docs.get('reviews:r2') as object), state: 'queued' });
    // The person presses Cancel while the first thread is read.
    f.io.assist.mockImplementationOnce(async () => { f.docs.set('reviews:r2', { ...(f.docs.get('reviews:r2') as object), state: 'cancelled', cancel: true }); return { result: { text: GOOD, harness: 'claude' }, budget: { usedPercent: 0.5, capPercent: 3 }, refused: null }; });
    await step(e, 'reviews:r2');
    expect(f.io.assist).toHaveBeenCalledTimes(1);
    expect((f.docs.get('reviews:r2') as { state: string }).state).toBe('cancelled');
  });

  it('a review with no readable threads reports that honestly, and makes no call', async () => {
    const f = daemon({ threads: { t1: { sessionId: 's1', items: [] } } });
    f.docs.set('reviews:r3', { id: 'r3', scope: { kind: 'thread', ids: ['t1'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:r3');
    f.docs.set('reviews:r3', { ...(f.docs.get('reviews:r3') as object), state: 'queued' });
    await step(e, 'reviews:r3');
    expect(f.io.assist).not.toHaveBeenCalled();
    expect(f.docs.get('reviews:r3')).toMatchObject({ state: 'done', report: { findings: [] } });
    expect((f.docs.get('reviews:r3') as { report: { summary: string } }).report.summary).toMatch(/no transcript it could read/);
  });

  it('the look back (a backfill range review) seeds the signals and the measures', async () => {
    const f = daemon({ answers: [GOOD] });
    f.docs.set('reviews:lb', { id: 'lb', scope: { kind: 'range', from: new Date(NOW.getTime() - 30 * 86400_000).toISOString(), to: NOW.toISOString() }, backfill: true, state: 'queued', plan: { threads: ['t1'], chunks: 1, estPercent: 0.05, fits: true } });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:lb');
    const signals = f.docs.get('signals') as { prompts: { t: string }[] };
    expect(signals.prompts.map((p) => p.t)).toEqual(['t1', 't1']);
    expect(f.docs.get('measures')).toMatchObject({ scores: expect.any(Object) });
  });
});

describe('Coach reviews skip what the person left alone, and what a schedule started (review finding 4)', () => {
  const conversations = (f: ReturnType<typeof daemon>) => f.io.getJson.mock.calls.map((c) => String(c[0])).filter((r) => r.includes('/conversation'));

  it("a leave-alone project's transcript is never fetched, in a range, a project or a thread review", async () => {
    const threads = { t1: { sessionId: 's1', items: TRANSCRIPT }, t2: { sessionId: 's2', items: TRANSCRIPT } };
    const f = daemon({ threads, settings: { leaveAlone: ['s2'] }, status: { budget: { usedPercent: 0.5, capPercent: 3 } } });
    const range = { kind: 'range', from: new Date(NOW.getTime() - 30 * 86400_000).toISOString(), to: NOW.toISOString() };
    f.docs.set('reviews:a', { id: 'a', scope: range, state: 'planning' });
    f.docs.set('reviews:b', { id: 'b', scope: { kind: 'project', ids: ['s2'] }, state: 'planning' });
    f.docs.set('reviews:c', { id: 'c', scope: { kind: 'thread', ids: ['t2'] }, state: 'planning' });
    const e = createEngine(f.io); await e.load();
    for (const k of ['reviews:a', 'reviews:b', 'reviews:c']) await step(e, k);
    expect(conversations(f).some((r) => r.includes('/t2/'))).toBe(false);
    expect((f.docs.get('reviews:a') as { plan: { threads: string[] } }).plan.threads).toEqual(['t1']);
    expect((f.docs.get('reviews:b') as { plan: { threads: string[] } }).plan.threads).toEqual([]);
    expect((f.docs.get('reviews:c') as { plan: { threads: string[] } }).plan.threads).toEqual([]);
  });

  it('a schedule-started thread yields no candidate: the look back does not read it as the person', async () => {
    const threads = { t1: { sessionId: 's1', items: TRANSCRIPT, config: { runner: true, runnerPrompt: 'x' } }, t2: { sessionId: 's1', items: TRANSCRIPT, config: { roleRun: 'triage' } } };
    const f = daemon({ threads, answers: [GOOD, GOOD] });
    f.docs.set('reviews:lb', { id: 'lb', scope: { kind: 'range', from: new Date(NOW.getTime() - 30 * 86400_000).toISOString(), to: NOW.toISOString() }, backfill: true, state: 'queued', plan: { threads: ['t1', 't2'], chunks: 2, estPercent: 0.1, fits: true } });
    const e = createEngine(f.io); await e.load();
    await step(e, 'reviews:lb');
    const signals = f.docs.get('signals') as { prompts: unknown[] } | undefined;
    expect(signals ? signals.prompts : []).toEqual([]);
    expect(f.io.assist).not.toHaveBeenCalled();
  });

  it('a live prompt a schedule sent (source "schedule") yields no candidate', async () => {
    const f = daemon({ answers: [JSON.stringify({ fit: true, confidence: 0.9, headline: 'Ask for a plan first', why: 'x', action: { kind: 'compose', label: 'Try', text: 'y' } })] });
    const e = createEngine(f.io); await e.load();
    const BIGP = 'Pull last week returns by reason from the warehouse table. Chart them by week and by store. Compare them with the prior month and list the three biggest changes. Then email the summary to Sam with the chart attached. '.repeat(3);
    await e.handle({ type: 'thread:prompt', terminalId: 't9', sessionId: 's1', at: NOW.toISOString(), source: 'schedule', text: BIGP });
    await e.handle({ type: 'thread:turn', terminalId: 't9', sessionId: 's1', at: NOW.toISOString(), ms: 30_000 });
    await e.idle();
    expect(f.docs.has('candidates')).toBe(false);
  });
});

// ── the web part ──────────────────────────────────────────────────────────────────────────
afterEach(() => { cleanup(); });
type Comp = (p: Record<string, unknown>) => JSX.Element | null;
async function boot(docs: Record<string, unknown> = {}) {
  const d: FakeD = fakeD({ docs: { cadence: emptyCadence(new Date(2026, 9, 1)), ...docs } });
  const coach = createCoach(d, { now: () => NOW });
  await coach.ready;
  const reg = d.registered.coach as Record<string, { Component: Comp }[]>;
  return { d, View: reg.views[0].Component, Tab: reg.inspectorTabs[0].Component };
}

describe('Coach reviews in the app (coach plan Task 12f)', () => {
  it('Review this thread asks for an estimate; the estimate shows Start and Cancel; nothing runs until Start', async () => {
    const { d, Tab } = await boot();
    render(<Tab terminalId="t1" sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review this thread' }));
    await waitFor(() => expect([...d.docs.keys()].some((k) => k.startsWith('reviews:'))).toBe(true));
    const key = [...d.docs.keys()].find((k) => k.startsWith('reviews:'))!;
    expect(d.docs.get(key)).toMatchObject({ state: 'planning', scope: { kind: 'thread', ids: ['t1'] } });
    expect(await screen.findByText('Working out what this review costs…')).toBeInTheDocument();
    // The worker writes the estimate.
    d.docs.set(key, { ...(d.docs.get(key) as object), state: 'estimate', plan: { threads: ['t1'], chunks: 2, estPercent: 0.1, fits: true } });
    d.emit({ type: 'plugin:data', id: 'coach', key });
    const panel = await screen.findByTestId('coach-review');
    await within(panel).findByText('This review reads 1 thread (2 parts): about 0.1% of your weekly limit, an estimate.');
    expect((d.docs.get(key) as { state: string }).state).toBe('estimate');
    fireEvent.click(within(panel).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect((d.docs.get(key) as { state: string }).state).toBe('queued'));
    expect(d.assist).not.toHaveBeenCalled();
  });

  it('over the cap it says so and offers the smaller scope; progress and the report show', async () => {
    const plan = { threads: ['a', 'b', 'c'], chunks: 30, estPercent: 1.5, fits: false, smallerScope: { kind: 'thread', ids: ['a'] } };
    const { d, View } = await boot({ 'reviews:r9': { id: 'r9', at: NOW.toISOString(), scope: { kind: 'project', ids: ['s1'] }, state: 'estimate', plan } });
    render(<View />);
    const panel = await screen.findByTestId('coach-review');
    expect(panel).toHaveTextContent('That is more than the budget has left this week.');
    expect(within(panel).getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Review the newest 1 thread instead' }));
    await waitFor(() => expect([...d.docs.values()].some((v) => (v as { state?: string; scope?: { ids?: string[] } }).state === 'planning' && (v as { scope: { ids: string[] } }).scope.ids?.[0] === 'a')).toBe(true));
    cleanup();
    const reading = await boot({ 'reviews:r8': { id: 'r8', at: NOW.toISOString(), scope: { kind: 'project', ids: ['s1'] }, state: 'reading', progress: { done: 3, total: 8 }, plan } });
    render(<reading.View />);
    expect(await screen.findByText('Reading 3 of 8 threads…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }));
    await waitFor(() => expect(reading.d.docs.get('reviews:r8')).toMatchObject({ state: 'cancelled', cancel: true }));
    cleanup();
    const done = await boot({ 'reviews:r7': { id: 'r7', at: NOW.toISOString(), scope: { kind: 'thread', ids: ['t1'] }, state: 'done', report: { summary: 'The Coach read 1 thread.', findings: [{ kind: 'handoff', quote: 'now fix parseInvoice', note: 'Give it every parser at once.' }], nextSteps: [{ text: 'Ask for all parsers at once.' }] } } });
    render(<done.View />);
    const report = await screen.findByTestId('coach-review');
    expect(report).toHaveTextContent('"now fix parseInvoice"');
    expect(report).toHaveTextContent('Give it every parser at once.');
    expect(report).toHaveTextContent('Ask for all parsers at once.');
  });

  const runningPlan = { threads: Array.from({ length: 27 }, (_, i) => `t${i}`), chunks: 60, estPercent: 3, fits: true };
  const running = (p: Record<string, unknown>, scope: Record<string, unknown> = { kind: 'range', from: '', to: '' }) => ({ 'reviews:rr': { id: 'rr', at: NOW.toISOString(), scope, backfill: true, state: 'reading', plan: runningPlan, startedAt: p.startedAt, progress: p } });

  it('a running review shows a bar by parts, the thread it reads, and no estimate before 2 parts', async () => {
    const { View } = await boot(running({ done: 2, total: 27, chunksDone: 1, chunksTotal: 60, thread: { id: 't2', label: 'Fix the parsers', chunk: 2, chunks: 12 }, startedAt: new Date(NOW.getTime() - 30_000).toISOString(), at: new Date(NOW.getTime() - 5_000).toISOString() }));
    render(<View />);
    const panel = await screen.findByTestId('coach-review');
    const bar = within(panel).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '60');
    expect(panel).toHaveTextContent('Reading Fix the parsers');
    expect(panel).toHaveTextContent('part 2 of 12');
    expect(panel).toHaveTextContent('thread 3 of 27');
    expect(panel).toHaveTextContent('0:30 elapsed');
    expect(panel).not.toHaveTextContent(/left/);
    expect(within(panel).getByRole('button', { name: 'Cancel review' })).toBeInTheDocument();
  });

  it('after 2 parts it estimates the time left from the average part', async () => {
    // 4 parts in 100 seconds: 25 s a part, 56 parts left, about 23 minutes.
    const { View } = await boot(running({ done: 1, total: 27, chunksDone: 4, chunksTotal: 60, thread: { id: 't1', label: 'Ship the release', chunk: 5, chunks: 20 }, startedAt: new Date(NOW.getTime() - 100_000).toISOString(), at: NOW.toISOString() }));
    render(<View />);
    const panel = await screen.findByTestId('coach-review');
    expect(panel).toHaveTextContent('1:40 elapsed');
    expect(panel).toHaveTextContent('about 23 minutes left');
    expect(panel).toHaveTextContent('4 of 60 parts');
  });

  it('the Coach tab shows a running project or range review compactly, with a way to the Coach screen', async () => {
    const { d, Tab } = await boot(running({ done: 1, total: 27, chunksDone: 4, chunksTotal: 60, thread: { id: 't1', label: 'Ship the release', chunk: 5, chunks: 20 }, startedAt: new Date(NOW.getTime() - 100_000).toISOString(), at: NOW.toISOString() }));
    render(<Tab terminalId="t9" sessionId="s1" />);
    const strip = await screen.findByTestId('coach-review-compact');
    expect(within(strip).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
    expect(strip).toHaveTextContent('Look back');
    expect(strip).toHaveTextContent('part 5 of 20');
    expect(strip).toHaveTextContent('about 23 minutes left');
    fireEvent.click(within(strip).getByRole('button', { name: 'Open' }));
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
  });

  it('an estimate with an unknown cost shows "Cost unknown" and asks for the smaller scope first', async () => {
    const plan = { threads: ['a', 'b', 'c'], chunks: 30, estPercent: 1.5, fits: null, costUnknown: true, smallerScope: { kind: 'thread', ids: ['a'] } };
    const { View } = await boot({ 'reviews:r6': { id: 'r6', at: NOW.toISOString(), scope: { kind: 'project', ids: ['s1'] }, state: 'estimate', plan } });
    render(<View />);
    const panel = await screen.findByTestId('coach-review');
    expect(panel).toHaveTextContent('Cost unknown');
    expect(panel).not.toHaveTextContent('about 1.5% of your weekly limit');
    expect(within(panel).getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Review the newest 1 thread instead' })).toBeInTheDocument();
  });

  it('the look back is offered once on the Coach screen; Start-first: it asks for an estimate', async () => {
    const { d, View } = await boot();
    render(<View />);
    const offer = await screen.findByTestId('coach-lookback');
    expect(offer).toHaveTextContent('Look back at your last 30 days');
    fireEvent.click(within(offer).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect((d.docs.get('cadence') as { lookbackAnswered?: boolean }).lookbackAnswered).toBe(true));
    expect(screen.queryByTestId('coach-lookback')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Look back at the last 30 days' }));
    await waitFor(() => expect([...d.docs.values()].some((v) => (v as { backfill?: boolean; state?: string }).backfill === true && (v as { state: string }).state === 'planning')).toBe(true));
  });

  it('Reset removes every review document (their quotes) and the chat document', async () => {
    const done = { id: 'r1', at: NOW.toISOString(), scope: { kind: 'thread', ids: ['t1'] }, state: 'done', report: { summary: 'x', findings: [{ kind: 'handoff', quote: 'my private words', note: 'n' }], nextSteps: [] } };
    const { d, View } = await boot({ 'reviews:r1': done, 'reviews:r2': { ...done, id: 'r2' }, chat: { turns: [{ role: 'user', text: 'secret', at: 'x' }] } });
    render(<View />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() => expect([...d.docs.keys()].filter((k) => k.startsWith('reviews:'))).toEqual([]));
    await waitFor(() => expect(d.docs.has('chat')).toBe(false));
    expect(JSON.stringify([...d.docs.values()])).not.toContain('my private words');
  });

  it('the 21st review prunes the oldest: at most 20 are kept', async () => {
    const docs: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) docs[`reviews:old${String(i).padStart(2, '0')}`] = { id: `old${i}`, at: new Date(NOW.getTime() - (40 - i) * 3600_000).toISOString(), scope: { kind: 'thread', ids: ['t1'] }, state: 'done', report: { summary: 'x', findings: [], nextSteps: [] } };
    const { d, Tab } = await boot(docs);
    render(<Tab terminalId="t1" sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review this thread' }));
    await waitFor(() => expect([...d.docs.keys()].filter((k) => k.startsWith('reviews:'))).toHaveLength(20));
    expect(d.docs.has('reviews:old00')).toBe(false);
    expect(d.docs.has('reviews:old19')).toBe(true);
    expect([...d.docs.values()].some((v) => (v as { state?: string }).state === 'planning')).toBe(true);
  });

  it('a review stopped by a restart offers Run again, which asks for a new estimate', async () => {
    const { d, View } = await boot({ 'reviews:r5': { id: 'r5', at: NOW.toISOString(), scope: { kind: 'thread', ids: ['t1'] }, state: 'failed', error: 'Stopped when the Coach restarted — Run again', restartable: true, plan: { threads: ['t1'], chunks: 1, estPercent: 0.05, fits: true } } });
    render(<View />);
    const panel = await screen.findByTestId('coach-review');
    expect(panel).toHaveTextContent('Stopped when the Coach restarted');
    fireEvent.click(within(panel).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(d.docs.get('reviews:r5')).toMatchObject({ state: 'planning' }));
  });

  it('the thread menu has Review this thread', async () => {
    const { d } = await boot();
    const menu = (d.registered.coach as Record<string, { id: string; label: string; onPick: (x: unknown) => void }[]>).threadMenu;
    expect(menu.map((m) => m.label)).toEqual(['Review this thread']);
    menu[0].onPick({ tab: { id: 't4' } });
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
    await waitFor(() => expect([...d.docs.values()].some((v) => (v as { scope?: { ids?: string[] } }).scope?.ids?.[0] === 't4')).toBe(true));
  });
});
