import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { createEngine } from '../../../plugins/coach/lib/engine.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { createCoach } from '../../../plugins/coach/web.js';
import { fakeD, type FakeD } from './coach-test-utils';

// Coach fix T7: a one-off clean of the notes on load. No periodic job.
const NOW = new Date('2026-11-23T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const rec = (t: string, min: number, ex: string, over: Record<string, unknown> = {}) => ({ t, p: 's1', at: ago(min), ex, h: ex, len: ex.length, lines: 1, parts: 1, plan: false, ok: false, gap: null, prev: null, ...over });

const OLD_SIGNALS = {
  v: 1,
  prompts: [
    rec('t1', 50, 'Summarize the pipeline report for the sales team'),
    rec('t1', 40, '<task-notification>\n<summary>done</summary>\n</task-notification>'),
    rec('t1', 30, '[From the overseer of project "web" (thread t9). This is not a message from the owner.]'),
    rec('t1', 20, 'proceed'),
    rec('t2', 10, 'Run the weekly report for the ops team now'),
    rec('t1', 5, '', { len: 400 }),
  ],
  turns: [],
  threads: { t1: { p: 's1', first: ago(50), end: ago(5), kind: 'other', prompts: 5, tools: 0 }, t2: { p: 's1', first: ago(10), end: null, kind: 'other', prompts: 1, tools: 0, auto: 'abc' } },
  open: {},
  last: {},
};
const OLD_CANDIDATES = {
  items: [
    { id: 'repeated-prompt:a', type: 'repeated-prompt', measure: 'reuse', evidence: { excerpt: '[From thread "x" of project "y" (thread t). This is not a message from the owner.]' }, at: ago(5) },
    { id: 'step-by-step:b', type: 'step-by-step', measure: 'ambition', evidence: { excerpt: '' }, at: ago(5) },
    { id: 'no-plan-big-task:c', type: 'no-plan-big-task', measure: 'judgment', evidence: { excerpt: 'Migrate the orders service to the new database client' }, at: ago(5) },
    { id: 'idle-wait:d', type: 'idle-wait', measure: 'delegation', evidence: { minutes: 5 }, at: ago(5) },
  ],
  seen: ['repeated-prompt:a', 'step-by-step:b', 'no-plan-big-task:c', 'idle-wait:d'],
};

function io(docs: Map<string, unknown>) {
  const putDoc = vi.fn(async (k: string, v: unknown) => { docs.set(k, JSON.parse(JSON.stringify(v))); });
  return {
    getDoc: vi.fn(async (k: string, f: unknown) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : f)),
    putDoc,
    listDocs: vi.fn(async () => [...docs.keys()]),
    getSettings: vi.fn(async () => null),
    assist: vi.fn(),
    notify: vi.fn(),
    now: () => NOW,
    log: vi.fn(),
    saveDelayMs: 0,
  };
}
const oldDocs = () => new Map<string, unknown>([
  ['signals', OLD_SIGNALS],
  ['candidates', OLD_CANDIDATES],
  ['cadence', { ...emptyCadence(new Date(NOW.getTime() - 20 * 86400_000)), lookbackAnswered: true }],
  ['reviews:lb', { id: 'lb', scope: { kind: 'range' }, backfill: true, state: 'done', report: { summary: 's', findings: [], nextSteps: [] } }],
  ['reviews:r1', { id: 'r1', scope: { kind: 'thread', ids: ['t1'] }, state: 'done', report: { summary: 's', findings: [], nextSteps: [] } }],
  ['chat', { turns: [] }],
]);

describe('Coach: the one-off clean on load (coach fix T7)', () => {
  it('cleans an old document once and saves it as v2', async () => {
    const docs = oldDocs();
    const e = createEngine(io(docs)); await e.load();
    const s = docs.get('signals') as { v: number; prompts: { ex: string; t: string; ok: boolean; short: boolean }[] };
    expect(s.v).toBe(2);
    // Notices, peer messages and the schedule-started thread (auto) are gone; a prompt with no excerpt stays.
    expect(s.prompts.map((p) => p.ex)).toEqual(['Summarize the pipeline report for the sales team', 'proceed', '']);
    // A go-ahead stays the person's, marked so it is never content.
    expect(s.prompts[1]).toMatchObject({ ok: true, short: true });
    expect(s.prompts[0]).toMatchObject({ ok: false, short: false });
    const c = docs.get('candidates') as { items: { id: string }[]; seen: string[] };
    expect(c.items.map((x) => x.id)).toEqual(['no-plan-big-task:c', 'idle-wait:d']);
    expect(c.seen).toEqual(OLD_CANDIDATES.seen);
    expect(docs.get('reviews:lb')).toMatchObject({ stale: true });
    expect(docs.get('reviews:r1')).not.toHaveProperty('stale');
    expect((docs.get('cadence') as { lookbackAnswered: boolean }).lookbackAnswered).toBe(false);
    const chat = docs.get('chat') as { turns: { role: string; text: string }[] };
    expect(chat.turns.at(-1)).toMatchObject({ role: 'coach', text: 'I cleaned my notes: messages between agents and one-word go-aheads no longer count.' });
  });

  it('a second load changes nothing', async () => {
    const docs = oldDocs();
    await createEngine(io(docs)).load();
    const second = io(docs);
    await createEngine(second).load();
    expect(second.putDoc.mock.calls.map((c) => c[0]).filter((k) => k !== 'status')).toEqual([]);
  });

  it('a fresh install starts at v2 and is not cleaned', async () => {
    const docs = new Map<string, unknown>([['chat', { turns: [] }]]);
    const x = io(docs);
    await createEngine(x).load();
    expect(x.putDoc.mock.calls.map((c) => c[0]).filter((k) => k !== 'status')).toEqual([]);
  });
});

afterEach(() => { cleanup(); });
type Comp = (p: Record<string, unknown>) => JSX.Element | null;

describe('Coach: a stale look back offers Run again (coach fix T7)', () => {
  it('shows the note and Run again asks for a new estimate', async () => {
    const d: FakeD = fakeD({ docs: { cadence: { ...emptyCadence(new Date(2026, 9, 1)), lookbackAnswered: true }, 'reviews:lb': { id: 'lb', at: NOW.toISOString(), scope: { kind: 'range', from: ago(30 * 1440), to: NOW.toISOString() }, backfill: true, state: 'done', stale: true, report: { summary: 'The Coach read 3 threads.', findings: [], nextSteps: [] } } } });
    const coach = createCoach(d.sdk, { now: () => NOW });
    await coach.ready;
    const View = (d.registered.coach as Record<string, { Component: Comp }[]>).views[0].Component;
    render(<View />);
    const panel = await screen.findByTestId('coach-review');
    expect(panel).toHaveTextContent('The Coach cleaned its notes after this look back.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(d.docs.get('reviews:lb')).toMatchObject({ state: 'planning', stale: false }));
  });
});
