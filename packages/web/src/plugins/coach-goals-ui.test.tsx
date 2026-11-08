import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { createCoach } from '../../../plugins/coach/web.js';
import { createEngine } from '../../../plugins/coach/lib/engine.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { addGoal } from '../../../plugins/coach/lib/goals.mjs';
import { emptyMemory } from '../../../plugins/coach/lib/memory.mjs';
import { fakeD, type FakeD } from './coach-test-utils';

const NOW = new Date(2026, 10, 23, 11, 0);
const SEASONED = emptyCadence(new Date(2026, 10, 1, 9, 0));
type Comp = (p: Record<string, unknown>) => JSX.Element | null;
type Goal = { id: string; text: string; measures: string[]; detectors: string[]; source: string; status: string };
const goalsOf = (d: FakeD) => ((d.docs.get('memory') as { goals?: Goal[] } | undefined)?.goals ?? []);
const MEASURES = { at: NOW.toISOString(), weakest: 'reuse', history: [], scores: {}, suggestions: [
  { text: 'Automate the work I repeat each week', measures: ['reuse'], detectors: ['repeated-prompt'] },
  { text: 'Run more things at once', measures: ['delegation'], detectors: ['serial-independent', 'idle-wait'] },
] };

async function boot(over: { docs?: Record<string, unknown> } = {}) {
  const d: FakeD = fakeD({ docs: { cadence: SEASONED, measures: MEASURES, ...(over.docs ?? {}) } });
  const coach = createCoach(d, { now: () => NOW });
  await coach.ready;
  const reg = d.registered.coach as Record<string, { Component: Comp }[]>;
  return { d, View: reg.views[0].Component, Tab: reg.inspectorTabs[0].Component, Card: reg.slots[0].Component };
}
afterEach(() => { cleanup(); });

describe('Coach goals on the Coach screen (coach plan Task 12b)', () => {
  it('adds a goal in the person\'s own words; with no model it maps by keywords', async () => {
    const { d, View } = await boot();
    d.assist.mockRejectedValue(new Error('no model'));
    render(<View />);
    const box = await screen.findByTestId('coach-goals');
    fireEvent.change(within(box).getByRole('textbox', { name: 'A goal, in your own words' }), { target: { value: 'I want to automate my Monday work' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add goal' }));
    await waitFor(() => expect(goalsOf(d)).toHaveLength(1));
    expect(goalsOf(d)[0]).toMatchObject({ text: 'I want to automate my Monday work', measures: ['reuse'], source: 'user', status: 'active' });
    expect(within(box).getByText('I want to automate my Monday work')).toBeInTheDocument();
  });

  it('a suggested goal has Add; Edit puts it in the box to change before adding', async () => {
    const { d, View } = await boot();
    render(<View />);
    const box = await screen.findByTestId('coach-goals');
    expect(within(box).getByText('Automate the work I repeat each week')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'Add: Run more things at once' }));
    await waitFor(() => expect(goalsOf(d)).toHaveLength(1));
    expect(goalsOf(d)[0]).toMatchObject({ text: 'Run more things at once', measures: ['delegation'], source: 'suggested' });
    fireEvent.click(within(box).getByRole('button', { name: 'Edit: Automate the work I repeat each week' }));
    expect(within(box).getByRole('textbox', { name: 'A goal, in your own words' })).toHaveValue('Automate the work I repeat each week');
  });

  it('Done and Delete; at 3 active goals the box says why it cannot add more', async () => {
    let memory = emptyMemory();
    for (const text of ['Plan first and check the results', 'Run more things at once', 'Use AI for a new kind of work']) memory = addGoal(memory, { text, measures: ['judgment'], detectors: [], source: 'user' }, NOW).memory;
    const { d, View } = await boot({ docs: { memory } });
    render(<View />);
    const box = await screen.findByTestId('coach-goals');
    expect(within(box).getByRole('button', { name: 'Add goal' })).toBeDisabled();
    expect(box).toHaveTextContent('You have 3 goals. Mark one done to add another.');
    fireEvent.click(within(box).getByRole('button', { name: 'Done: Run more things at once' }));
    await waitFor(() => expect(goalsOf(d).find((g) => g.text === 'Run more things at once')!.status).toBe('done'));
    await waitFor(() => expect(within(box).getByRole('textbox', { name: 'A goal, in your own words' })).not.toBeDisabled());
    expect(box).not.toHaveTextContent('Mark one done to add another.');
    fireEvent.click(within(box).getByRole('button', { name: 'Delete goal: Use AI for a new kind of work' }));
    await waitFor(() => expect(goalsOf(d).map((g) => g.text)).not.toContain('Use AI for a new kind of work'));
  });

  it('the recap reports each goal and asks Keep, Done or Change once a month', async () => {
    const memory = addGoal(emptyMemory(), { text: 'Automate my Monday work', measures: ['reuse'], detectors: ['repeated-prompt'], source: 'user' }, NOW).memory;
    const g = memory.goals[0];
    const recap = { at: '2026-11-23T08:00:00Z', announce: false, stats: { threads: 9, days: 5, parallel: 1 }, patterns: ['a', 'b', 'c'], stretch: null, learned: null, goals: [{ id: g.id, text: g.text, progress: 'Reuse went up this month.', next: 'Turn one repeated prompt into a schedule.' }], askGoals: true };
    const { d, View } = await boot({ docs: { memory, recap } });
    render(<View />);
    const r = await screen.findByTestId('coach-recap');
    expect(r).toHaveTextContent('Automate my Monday work');
    expect(r).toHaveTextContent('Reuse went up this month. Next: Turn one repeated prompt into a schedule.');
    expect(r).toHaveTextContent('Is this goal still right?');
    fireEvent.click(within(r).getByRole('button', { name: 'Done: Automate my Monday work' }));
    await waitFor(() => expect(goalsOf(d)[0].status).toBe('done'));
    expect((d.docs.get('memory') as { dates: Record<string, string> }).dates['goals:asked']).toBe(NOW.toISOString());
  });
});

describe('Coach goals in the tab and on the card (coach plan Task 12b)', () => {
  it('the tab shows a "Working on" line for a goal this thread touches', async () => {
    const memory = addGoal(emptyMemory(), { text: 'Run more things at once', measures: ['delegation'], detectors: [], source: 'user' }, NOW).memory;
    const card = { id: 'idle-wait:1', type: 'idle-wait', measure: 'delegation', terminalId: 't1', projectId: 's1', headline: 'Start a second thread while this runs', why: 'w', action: { kind: 'compose', label: 'Try it', text: 'x' }, excerpt: '', reason: 'r', at: NOW.toISOString() };
    const { Tab } = await boot({ docs: { memory, cards: { items: [card] } } });
    render(<Tab terminalId="t1" sessionId="s1" />);
    expect(await screen.findByText('Working on: Run more things at once')).toBeInTheDocument();
  });

  it('a card that serves a goal shows before a newer card that does not', async () => {
    const memory = addGoal(emptyMemory(), { text: 'Plan first', measures: ['judgment'], detectors: ['no-plan-big-task'], source: 'user' }, NOW).memory;
    const base = { terminalId: 't1', projectId: 's1', why: 'w', action: { kind: 'compose', label: 'Try it', text: 'x' }, excerpt: '', reason: 'r' };
    const cards = { items: [
      { ...base, id: 'no-plan-big-task:1', type: 'no-plan-big-task', measure: 'judgment', headline: 'Ask for a plan first', goal: memory.goals[0].id, at: '2026-11-23T09:00:00Z' },
      { ...base, id: 'idle-wait:1', type: 'idle-wait', measure: 'delegation', headline: 'Start a second thread while this runs', at: '2026-11-23T10:00:00Z' },
    ] };
    const { Card } = await boot({ docs: { memory, cards } });
    render(<Card surface="thread" terminalId="t1" sessionId="s1" value="" set={vi.fn()} insert={vi.fn()} />);
    expect(await screen.findByTestId('coach-card')).toHaveTextContent('Ask for a plan first');
  });
});

describe('Coach goals in the worker (coach plan Task 12b)', () => {
  it('the measures document carries up to 3 suggested goals', async () => {
    const docs = new Map<string, unknown>([['cadence', SEASONED]]);
    const e = createEngine({
      getDoc: async (k, f) => (docs.has(k) ? docs.get(k) : f), putDoc: async (k, v) => { docs.set(k, JSON.parse(JSON.stringify(v))); },
      getSettings: async () => null, assist: vi.fn(async () => ({ result: null, budget: null, refused: null })), now: () => NOW, saveDelayMs: 0,
    });
    await e.load();
    await e.handle({ type: 'thread:prompt', terminalId: 't1', sessionId: 's1', at: NOW.toISOString(), source: 'user', text: 'hi' });
    await e.handle({ type: 'thread:turn', terminalId: 't1', sessionId: 's1', at: NOW.toISOString(), ms: 1000 });
    await e.idle();
    const m = docs.get('measures') as { suggestions: { text: string }[] };
    expect(m.suggestions.length).toBeGreaterThan(0);
    expect(m.suggestions.length).toBeLessThanOrEqual(3);
  });

  it('a goal-serving candidate is judged first', async () => {
    const memory = addGoal(emptyMemory(), { text: 'Plan first', measures: ['judgment'], detectors: ['no-plan-big-task'], source: 'user' }, NOW).memory;
    const at = NOW.toISOString();
    const docs = new Map<string, unknown>([['cadence', { ...SEASONED, welcomeSeenAt: SEASONED.firstSeenAt }], ['memory', memory], ['candidates', { seen: [], items: [
      { id: 'no-plan-big-task:1', type: 'no-plan-big-task', measure: 'judgment', tip: 'prompt', terminalId: 't1', projectId: 's1', evidence: { parts: 4, chars: 500, excerpt: 'Migrate the orders service to the new database client and keep the old API working' }, at },
      { id: 'idle-wait:1', type: 'idle-wait', measure: 'delegation', tip: 'thinkBigger', terminalId: 't1', projectId: 's1', evidence: { minutes: 5 }, at },
    ] }]]);
    const assist = vi.fn(async (_req: { messages: { content: string }[] }) => ({ result: null, budget: null, refused: null }));
    const e = createEngine({ getDoc: async (k, f) => (docs.has(k) ? docs.get(k) : f), putDoc: async (k, v) => { docs.set(k, v); }, getSettings: async () => null, assist, now: () => NOW, saveDelayMs: 0 });
    await e.load();
    await e.handle({ type: 'thread:turn', terminalId: 't1', sessionId: 's1', at, ms: 1000 });
    await e.idle();
    expect(assist.mock.calls[0][0].messages[0].content).toContain('Big tasks without a plan');
  });
});
