import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { chatContext, chatPrompt, parseChat, threadObservations, appendTurns, CHAT_KEEP } from '../../../plugins/coach/lib/chat.mjs';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { emptyMemory, confirmFact } from '../../../plugins/coach/lib/memory.mjs';
import { addGoal } from '../../../plugins/coach/lib/goals.mjs';
import { DEFAULT_SETTINGS } from '../../../plugins/coach/lib/settings.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { createCoach } from '../../../plugins/coach/web.js';
import { fakeD, type FakeD } from './coach-test-utils';

const DAY = 86400_000;
const NOW = new Date(2026, 10, 23, 11, 0);
type Ev = Record<string, unknown>;
const prompt = (t: string, at: number, text: string): Ev => ({ type: 'thread:prompt', terminalId: t, sessionId: 's1', at: new Date(at).toISOString(), source: 'user', text });
const turn = (t: string, at: number, ms: number): Ev => ({ type: 'thread:turn', terminalId: t, sessionId: 's1', at: new Date(at).toISOString(), ms });
const fold = (events: Ev[]) => events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());
const days = (n: number) => {
  const out: Ev[] = [];
  for (let d = 0; d < n; d++) { const base = NOW.getTime() - (n - d) * DAY; out.push(prompt(`t${d}`, base, 'summarize the sales pipeline email'), turn(`t${d}`, base + 120_000, 120_000)); }
  return out;
};
const SCORES = { ambition: { score: 30, trend: 0, enough: true }, delegation: { score: 45, trend: 1, enough: true }, reuse: { score: 10, trend: 0, enough: true }, judgment: { score: 60, trend: 0, enough: true }, breadth: { score: 20, trend: 0, enough: false } };
const CARD = { id: 'repeated-prompt:x', type: 'repeated-prompt', measure: 'reuse', terminalId: 't6', projectId: 's1', headline: 'Turn this prompt into a schedule', why: 'You sent it 7 times in 7 days.', action: { kind: 'compose', label: 'Try it', text: 'x' }, excerpt: '', reason: 'You sent the same prompt 7 times in 14 days.', at: NOW.toISOString() };

describe('Coach chat: context and prompt (coach plan Task 12e)', () => {
  it('with too little data: enoughData is false, and the prompt carries the honesty rule and the needs line', () => {
    const ctx = chatContext(fold(days(2)), null, emptyMemory(), [], { now: NOW });
    expect(ctx.enoughData).toBe(false);
    expect(ctx.activeDays).toBe(2);
    expect(ctx.needs).toMatch(/2 active days/);
    expect(ctx.needs).toMatch(/about 3 more/);
    const p = chatPrompt(ctx, [], 'Why do I under-delegate?');
    expect(p.system).toMatch(/only from the observations/i);
    expect(p.system).toMatch(/too little data/i);
    expect(p.system).toMatch(/general advice/i);
    expect(p.messages[0].content).toContain(ctx.needs);
    expect(p.messages[0].content).toContain('Why do I under-delegate?');
  });

  it('with enough data: the observations (measures, cards, goals, facts) reach the prompt', () => {
    let memory = confirmFact(emptyMemory(), { id: 'f', text: 'Works in finance', source: 'x', at: NOW.toISOString(), confirmedAt: null }, NOW);
    memory = addGoal(memory, { text: 'Automate my Monday work', measures: ['reuse'], detectors: ['repeated-prompt'], source: 'user' }, NOW).memory;
    const ctx = chatContext(fold(days(7)), SCORES, memory, [CARD], { now: NOW });
    expect(ctx.enoughData).toBe(true);
    const text = chatPrompt(ctx, [{ role: 'user', text: 'earlier question', at: NOW.toISOString() }], 'What should I automate first?').messages[0].content;
    expect(text).toContain('Reuse: 10 of 100');
    expect(text).toContain('Turn this prompt into a schedule');
    expect(text).toContain('Goal: Automate my Monday work');
    expect(text).toContain('Fact: Works in finance');
    expect(text).toContain('earlier question');
    expect(text).not.toContain('Breadth: 20'); // not enough data for that measure: not an observation
  });

  it('a thread scope adds what the Coach sees in that thread', () => {
    const t = NOW.getTime() - 3600_000;
    const state = fold([prompt('tx', t, 'fix the bug'), turn('tx', t + 6 * 60_000, 6 * 60_000), prompt('tx', t + 7 * 60_000, 'now the tests'), turn('tx', t + 8 * 60_000, 60_000)]);
    const obs = threadObservations(state, 'tx');
    expect(obs).toEqual(expect.arrayContaining(['You sent 2 prompts; the agent worked 7 minutes on its own (the longest stretch 6 minutes).', 'You did not ask for a plan first.']));
    const ctx = chatContext(state, null, emptyMemory(), [], { now: NOW, terminalId: 'tx' });
    expect(ctx.observations.join('\n')).toContain('In this thread: You sent 2 prompts');
    expect(threadObservations(state, 'nope')).toEqual([]);
  });

  it('parseChat reads text and known actions; plain text is an answer too', () => {
    expect(parseChat('{"text": "Start with the Monday report.", "actions": [{"kind": "add-goal", "payload": {"text": "Automate the Monday report"}}, {"kind": "launch-rockets", "payload": {}}]}'))
      .toEqual({ text: 'Start with the Monday report.', actions: [{ kind: 'add-goal', payload: { text: 'Automate the Monday report' } }] });
    expect(parseChat('Just words.')).toEqual({ text: 'Just words.', actions: [] });
    expect(parseChat('')).toBeNull();
  });

  it('the history keeps the newest 200 turns', () => {
    let doc = { turns: [] as unknown[] };
    for (let i = 0; i < 130; i++) doc = appendTurns(doc, [{ role: 'user', text: `q${i}`, at: 'x' }, { role: 'coach', text: `a${i}`, at: 'x' }]);
    expect(CHAT_KEEP).toBe(200);
    expect(doc.turns).toHaveLength(200);
    expect((doc.turns[199] as { text: string }).text).toBe('a129');
  });
});

afterEach(() => { cleanup(); });
type Comp = (p: Record<string, unknown>) => JSX.Element | null;
async function boot(over: { docs?: Record<string, unknown>; actions?: Record<string, unknown> } = {}) {
  const d: FakeD = fakeD({ docs: { cadence: emptyCadence(new Date(2026, 10, 1)), signals: fold(days(2)), ...(over.docs ?? {}) }, actions: over.actions });
  const coach = createCoach(d.sdk, { now: () => NOW });
  await coach.ready;
  const reg = d.registered.coach as Record<string, { Component: Comp }[]>;
  return { d, View: reg.views[0].Component, Tab: reg.inspectorTabs[0].Component };
}
const ask = async (q: string) => {
  const chat = await screen.findByTestId('coach-chat');
  fireEvent.change(within(chat).getByRole('textbox', { name: 'Ask the Coach' }), { target: { value: q } });
  fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
  return chat;
};

describe('Coach chat in the app (coach plan Task 12e)', () => {
  it('asks the large tier, shows the answer, and keeps the history in the chat document', async () => {
    const { d, View } = await boot({ docs: { status: { budget: { usedPercent: 0.1, capPercent: 3 }, harness: 'claude' } } });
    d.assist.mockResolvedValueOnce({ text: '{"text": "I have seen 2 active days. I need about 3 more before I can see patterns."}' });
    render(<View />);
    const chat = await ask('Why do I under-delegate?');
    expect(await within(chat).findByText('I have seen 2 active days. I need about 3 more before I can see patterns.')).toBeInTheDocument();
    expect(d.assist.mock.calls[0][0]).toMatchObject({ harness: 'claude', model: 'opus' });
    expect(JSON.stringify(d.assist.mock.calls[0][0])).toMatch(/too little data/i);
    await waitFor(() => expect((d.docs.get('chat') as { turns: { role: string }[] }).turns.map((t) => t.role)).toEqual(['user', 'coach']));
    // Nothing said in the chat becomes a memory fact.
    expect(d.docs.has('memory')).toBe(false);
  });

  it('at the budget cap the chat says so and makes no call', async () => {
    const { d, View } = await boot({ docs: { status: { budget: { usedPercent: 3, capPercent: 3 } } } });
    render(<View />);
    const chat = await ask('Anything?');
    expect(await within(chat).findByText('The Coach has used its budget for this week. The chat comes back when the week resets.')).toBeInTheDocument();
    expect(d.assist).not.toHaveBeenCalled();
  });

  it('actions render as buttons that create nothing until the person confirms', async () => {
    const openSchedule = vi.fn(); const openNewThreads = vi.fn(); const createSkill = vi.fn(async () => null);
    const { d, View } = await boot({ actions: { openSchedule, openNewThreads, createSkill } });
    d.assist.mockResolvedValueOnce({ text: JSON.stringify({ text: 'Here are options.', actions: [
      { kind: 'add-goal', payload: { text: 'Automate the Monday report' } },
      { kind: 'schedule', payload: { prompt: 'Summarize the pipeline', cron: '0 8 * * 1', label: 'Monday pipeline' } },
      { kind: 'create-skill', payload: { name: 'Finish steps', description: 'Tests then the file list.', body: '# Finish' } },
      { kind: 'build-plugin', payload: { plugin: 'A Returns screen', parts: ['view'] } },
      { kind: 'new-threads', payload: { prompts: ['a', 'b'] } },
    ] }) });
    render(<View />);
    const chat = await ask('Help me automate');
    await within(chat).findByText('Here are options.');
    expect(openSchedule).not.toHaveBeenCalled();
    expect(createSkill).not.toHaveBeenCalled();
    expect(openNewThreads).not.toHaveBeenCalled();
    fireEvent.click(within(chat).getByRole('button', { name: 'Add goal: Automate the Monday report' }));
    await waitFor(() => expect(((d.docs.get('memory') as { goals: { text: string }[] }).goals).map((g) => g.text)).toEqual(['Automate the Monday report']));
    fireEvent.click(within(chat).getByRole('button', { name: 'Set up: Monday pipeline' }));
    expect(openSchedule).toHaveBeenCalledWith({ prompt: 'Summarize the pipeline', cron: '0 8 * * 1', label: 'Monday pipeline' });
    fireEvent.click(within(chat).getByRole('button', { name: 'Create skill: Finish steps' }));
    expect(createSkill).toHaveBeenCalledWith({ name: 'Finish steps', description: 'Tests then the file list.', body: '# Finish' });
    fireEvent.click(within(chat).getByRole('button', { name: 'Build the plugin' }));
    expect(openNewThreads.mock.calls[0][0].prompts[0]).toContain('docs/plugins.md');
    fireEvent.click(within(chat).getByRole('button', { name: 'Open 2 new threads' }));
    expect(openNewThreads).toHaveBeenLastCalledWith({ prompts: ['a', 'b'] });
  });

  it('Clear chat and Reset empty the history', async () => {
    const turns = [{ role: 'user', text: 'old question', at: 'x' }, { role: 'coach', text: 'old answer', at: 'x' }];
    const { d, View } = await boot({ docs: { chat: { turns } } });
    render(<View />);
    const chat = await screen.findByTestId('coach-chat');
    expect(within(chat).getByText('old answer')).toBeInTheDocument();
    fireEvent.click(within(chat).getByRole('button', { name: 'Clear chat' }));
    await waitFor(() => expect((d.docs.get('chat') as { turns: unknown[] }).turns).toEqual([]));
    cleanup();
    const second = await boot({ docs: { chat: { turns } } });
    render(<second.View />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    // Reset removes the chat document itself (review finding 7).
    await waitFor(() => expect(second.d.docs.has('chat')).toBe(false));
  });
});

describe('Coach right-column tab: the open thread only (owner, 2026-11-07)', () => {
  const t = NOW.getTime() - 3600_000;
  const signals = fold([prompt('t1', t, 'fix the bug'), turn('t1', t + 6 * 60_000, 6 * 60_000)]);
  const MEASURES = { scores: SCORES, weakest: 'reuse', history: [] };
  it('shows this thread\'s card, what the Coach sees in it, Review this thread, and a chat about this thread; no measure bars', async () => {
    const memory = addGoal(emptyMemory(), { text: 'Plan first', measures: ['judgment'], detectors: ['no-plan-big-task'], source: 'user' }, NOW).memory;
    const other = addGoal(memory, { text: 'Try new kinds of work', measures: ['breadth'], detectors: [], source: 'user' }, NOW).memory;
    const card = { ...CARD, id: 'no-plan:1', type: 'no-plan-big-task', measure: 'judgment', terminalId: 't1', headline: 'Ask for a plan first' };
    const { Tab } = await boot({ docs: { signals, measures: MEASURES, memory: other, cards: { items: [card, CARD] } } });
    render(<Tab terminalId="t1" sessionId="s1" />);
    expect(await screen.findByText('Ask for a plan first')).toBeInTheDocument();
    expect(screen.queryByText('Turn this prompt into a schedule')).toBeNull();
    const sees = screen.getByTestId('coach-thread-sees');
    expect(sees).toHaveTextContent('the agent worked 6 minutes on its own');
    expect(screen.getByText('Working on: Plan first')).toBeInTheDocument();
    expect(screen.queryByText(/Try new kinds of work/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Review this thread' })).toBeInTheDocument();
    const scope = screen.getByRole('radiogroup', { name: 'Chat about' });
    expect(within(scope).getByRole('radio', { name: 'About this thread' })).toHaveAttribute('aria-checked', 'true');
    expect(within(scope).getByRole('radio', { name: 'About me' })).toBeInTheDocument();
    expect(screen.queryByTestId('coach-measures')).toBeNull();
  });
  it('with no thread open it says so and links to the Coach screen', async () => {
    const { Tab, d } = await boot();
    render(<Tab terminalId={null} sessionId={null} />);
    expect(await screen.findByText('Open a thread to see what the Coach sees in it.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the Coach screen' }));
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
  });
});

describe('Coach screen: the measure bars (owner, 2026-11-07)', () => {
  it('show by default, and hide with the setting', async () => {
    const first = await boot({ docs: { measures: { scores: SCORES, weakest: 'reuse', history: [] } } });
    render(<first.View />);
    expect(await screen.findByTestId('coach-measures')).toBeInTheDocument();
    cleanup();
    const d = fakeD({ docs: { cadence: emptyCadence(new Date(2026, 10, 1)), measures: { scores: SCORES, weakest: 'reuse', history: [] } }, settings: { showMeasures: false } });
    const coach = createCoach(d.sdk, { now: () => NOW });
    await coach.ready;
    const View = (d.registered.coach as Record<string, { Component: Comp }[]>).views[0].Component;
    render(<View />);
    await screen.findByTestId('coach-chat');
    expect(screen.queryByTestId('coach-measures')).toBeNull();
  });
});
