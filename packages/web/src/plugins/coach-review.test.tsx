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
function daemon(over: { threads?: Record<string, { sessionId: string; items: unknown[]; lastActivityAt?: string; config?: Record<string, unknown> }>; answers?: unknown[]; status?: unknown; settings?: unknown } = {}) {
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
      if (m) return threads[m[1]] ? { id: m[1], sessionId: threads[m[1]].sessionId, lastActivityAt: threads[m[1]].lastActivityAt ?? at(5), config: threads[m[1]].config ?? {} } : null;
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
    expect(f.writes.find((w) => w.key === 'reviews:r1' && w.value.state === 'reading')!.value.progress).toEqual({ done: 0, total: 1 });
    const done = f.docs.get('reviews:r1') as { report: { findings: { quote: string }[]; summary: string } };
    expect(done.report.findings[0].quote).toBe('now fix the same thing in parseInvoice');
    expect(f.io.assist.mock.calls[0][0]).toMatchObject({ harness: 'claude', model: 'opus' });
    expect((f.docs.get('chat') as { turns: { role: string; text: string }[] }).turns.at(-1)!.text).toContain('review');
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

  it('the thread menu has Review this thread', async () => {
    const { d } = await boot();
    const menu = (d.registered.coach as Record<string, { id: string; label: string; onPick: (x: unknown) => void }[]>).threadMenu;
    expect(menu.map((m) => m.label)).toEqual(['Review this thread']);
    menu[0].onPick({ tab: { id: 't4' } });
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
    await waitFor(() => expect([...d.docs.values()].some((v) => (v as { scope?: { ids?: string[] } }).scope?.ids?.[0] === 't4')).toBe(true));
  });
});
