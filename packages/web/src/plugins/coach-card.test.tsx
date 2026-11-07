import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { createCoach } from '../../../plugins/coach/web.js';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { fakeD, type FakeD } from './coach-test-utils';

const NOW = new Date(2026, 10, 20, 11, 0);
const SEASONED = emptyCadence(new Date(2026, 10, 1, 9, 0)); // past the first week
const CARD = {
  id: 'idle-wait:t1:x', type: 'idle-wait', measure: 'delegation', terminalId: 't1', projectId: 's1',
  headline: 'Start a second thread while this one runs', why: 'You waited 6 minutes with nothing else running.',
  action: { kind: 'compose', label: 'Try it: draft the next task', text: 'In a new thread: draft the release note.' },
  excerpt: 'run the full test suite and fix failures', reason: 'One thread ran 6 minutes while nothing else ran.', at: '2026-11-20T10:59:00Z',
};

type Slot = (p: Record<string, unknown>) => JSX.Element | null;
async function mount(opts: { cards?: unknown[]; cadence?: unknown; actions?: Record<string, unknown>; value?: string; terminalId?: string; settings?: unknown } = {}) {
  const d: FakeD = fakeD({ docs: { cadence: opts.cadence ?? SEASONED, cards: { items: opts.cards ?? [CARD] } }, actions: opts.actions, settings: opts.settings });
  const requestMore = vi.fn(async () => ({ wrote: CARD.excerpt, better: 'Run the suite in a new thread, and in this one draft the release note.', bullets: ['Two things move at once.', 'Check: read the test summary before you merge.'] }));
  const coach = createCoach(d, { requestMore, now: () => NOW });
  await coach.ready;
  const Card = (d.registered.coach.slots[0] as { Component: Slot }).Component;
  const set = vi.fn();
  const props = { surface: 'thread', terminalId: opts.terminalId ?? 't1', sessionId: 's1', value: opts.value ?? '', set, insert: vi.fn() };
  const view = render(<Card {...props} />);
  return { d, set, requestMore, coach, view, props, Card };
}

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('Coach card (coach plan Task 10)', () => {
  it('shows the headline, the why line, the measure, one action, More, 👍 👎, ⋯ and ✕; a shown card counts once', async () => {
    const { d } = await mount();
    const card = await screen.findByTestId('coach-card');
    expect(card).toHaveTextContent('COACH · DELEGATION');
    expect(card).toHaveTextContent(CARD.headline);
    expect(card).toHaveTextContent(CARD.why);
    for (const name of ['Try it: draft the next task', 'More', 'Helpful', 'Not helpful', 'More options', 'Dismiss (not now)']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    await waitFor(() => expect((d.docs.get('cadence') as { shownToday: number }).shownToday).toBe(1));
    expect((d.docs.get('cardState') as Record<string, { state: string }>)[CARD.id].state).toBe('shown');
  });

  it('✕ hides the card and adds a rest count, no fact', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss (not now)' }));
    await waitFor(() => expect(screen.queryByTestId('coach-card')).toBeNull());
    expect((d.docs.get('cadence') as { dismissCount: Record<string, number> }).dismissCount['idle-wait']).toBe(1);
    expect((d.docs.get('cardState') as Record<string, { state: string }>)[CARD.id].state).toBe('dismissed');
    expect(d.docs.has('memory')).toBe(false);
  });

  it('More calls the large tier once; Use this prompt fills the composer', async () => {
    const { requestMore, set } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(await screen.findByText('Run the suite in a new thread, and in this one draft the release note.')).toBeInTheDocument();
    expect(screen.getByText('YOU WROTE')).toBeInTheDocument();
    expect(screen.getByText('Check: read the test summary before you merge.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Less' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await screen.findByText('YOU WROTE');
    expect(requestMore).toHaveBeenCalledTimes(1);
    expect(requestMore).toHaveBeenCalledWith(expect.objectContaining({ id: CARD.id }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this prompt' }));
    expect(set).toHaveBeenCalledWith('Run the suite in a new thread, and in this one draft the release note.');
  });

  it('More with no answer says so and keeps the card whole', async () => {
    const { requestMore } = await mount();
    requestMore.mockResolvedValueOnce(null as never);
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(await screen.findByText('The Coach could not get more detail just now.')).toBeInTheDocument();
    expect(screen.getByTestId('coach-card')).toHaveTextContent(CARD.headline);
  });

  it('Mute for 1 hour shows the banner with Unmute', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute for 1 hour' }));
    await waitFor(() => expect(screen.queryByTestId('coach-card')).toBeNull());
    expect(screen.getByTestId('coach-muted')).toHaveTextContent(/Coach muted until/);
    expect((d.docs.get('cadence') as { mutedUntil: string }).mutedUntil).toBe(new Date(NOW.getTime() + 3600_000).toISOString());
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    expect(await screen.findByTestId('coach-card')).toBeInTheDocument();
    expect(screen.queryByTestId('coach-muted')).toBeNull();
  });

  it('the ⋯ menu offers every choice; Why am I seeing this? shows the reason; What the Coach knows opens the screen', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Mute for 1 hour', 'Mute for today', 'Mute until I turn it on', 'Fewer tips like this', 'Turn off this type', 'Why am I seeing this?', 'What the Coach knows']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Why am I seeing this?' }));
    expect(screen.getByText(CARD.reason)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'What the Coach knows' }));
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
  });

  it('Try it fills the composer and sends nothing', async () => {
    const { d, set } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try it: draft the next task' }));
    expect(set).toHaveBeenCalledWith('In a new thread: draft the release note.');
    expect(d.assist).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('coach-card')).toBeNull());
    expect((d.docs.get('cardState') as Record<string, { state: string }>)[CARD.id].state).toBe('used');
  });

  it('Try it opens the schedule or the new-thread dialog when the SDK has them, and fills the composer when it does not', async () => {
    const schedule = { ...CARD, id: 'r:1', type: 'repeated-prompt', measure: 'reuse', action: { kind: 'schedule', label: 'Run every Monday', prompt: 'Summarize the pipeline report', cron: '0 8 * * 1' } };
    const openSchedule = vi.fn();
    let m = await mount({ cards: [schedule], actions: { openSchedule } });
    fireEvent.click(await screen.findByRole('button', { name: 'Run every Monday' }));
    expect(openSchedule).toHaveBeenCalledWith({ projectId: 's1', prompt: 'Summarize the pipeline report', cron: '0 8 * * 1', label: 'Run every Monday' });
    expect(m.set).not.toHaveBeenCalled();
    cleanup();
    m = await mount({ cards: [schedule] });
    fireEvent.click(await screen.findByRole('button', { name: 'Run every Monday' }));
    expect(m.set).toHaveBeenCalledWith('Summarize the pipeline report');
    cleanup();
    const split = { ...CARD, id: 's:1', type: 'serial-independent', action: { kind: 'threads', label: 'Split into 3 threads', prompts: ['a', 'b', 'c'] } };
    const openNewThreads = vi.fn();
    m = await mount({ cards: [split], actions: { openNewThreads } });
    fireEvent.click(await screen.findByRole('button', { name: 'Split into 3 threads' }));
    expect(openNewThreads).toHaveBeenCalledWith({ projectId: 's1', prompts: ['a', 'b', 'c'] });
  });

  it('the card waits for the turn to end, and hides while you type', async () => {
    const { d, view, props, Card } = await mount();
    await screen.findByTestId('coach-card');
    act(() => { d.emit({ type: 'thread:prompt', terminalId: 't1', sessionId: 's1', source: 'user', at: NOW.toISOString() }); });
    expect(screen.queryByTestId('coach-card')).toBeNull();
    act(() => { d.emit({ type: 'thread:turn', terminalId: 't1', sessionId: 's1', at: NOW.toISOString(), ms: 1000 }); });
    expect(screen.getByTestId('coach-card')).toBeInTheDocument();
    const box = document.createElement('textarea');
    document.body.appendChild(box); box.focus();
    view.rerender(<Card {...props} value="half a thought" />);
    expect(screen.queryByTestId('coach-card')).toBeNull();
  });

  it('a card for another thread does not show here; nothing shows on the Control Plane chat', async () => {
    await mount({ terminalId: 't2' });
    expect(screen.queryByTestId('coach-card')).toBeNull();
    cleanup();
    const d = fakeD({ docs: { cadence: SEASONED, cards: { items: [CARD] } } });
    const coach = createCoach(d, { now: () => NOW });
    await coach.ready;
    const C = (d.registered.coach.slots[0] as { Component: Slot }).Component;
    render(<C surface="chat" terminalId="t1" value="" set={vi.fn()} />);
    expect(screen.queryByTestId('coach-card')).toBeNull();
  });

  it('a new card respects the daily cap; in the first week only the welcome card shows, once', async () => {
    await mount({ cadence: { ...SEASONED, day: '2026-11-20', shownToday: 3 } });
    expect(screen.queryByTestId('coach-card')).toBeNull();
    cleanup();
    const { d } = await mount({ cadence: emptyCadence(new Date(2026, 10, 18)) });
    const card = await screen.findByTestId('coach-card');
    expect(card).toHaveTextContent('Get one small tip at a time');
    expect(card).not.toHaveTextContent(CARD.headline);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss (not now)' }));
    await waitFor(() => expect(screen.queryByTestId('coach-card')).toBeNull());
    expect((d.docs.get('cadence') as { welcomeDone: boolean }).welcomeDone).toBe(true);
  });

  it('the welcome card comes first, says what the Coach looks at, and has Turn off, which disables the plugin', async () => {
    const { d } = await mount({ cadence: emptyCadence(new Date(2026, 10, 18)) });
    const card = await screen.findByTestId('coach-card');
    expect(card).toHaveTextContent('Get one small tip at a time');
    expect(card).toHaveTextContent('looks at the prompts you send');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(d.api.disablePlugin).toHaveBeenCalledWith('coach'));
  });

  it('the card and the muted banner show icons, never emoji; the feedback buttons are named Helpful and Not helpful', async () => {
    const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    await mount();
    const card = await screen.findByTestId('coach-card');
    expect(card.textContent).not.toMatch(EMOJI);
    expect(card.textContent).not.toContain('✕');
    for (const name of ['Helpful', 'Not helpful', 'More options', 'Dismiss (not now)']) expect(screen.getByRole('button', { name }).querySelector('svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute for 1 hour' }));
    const banner = await screen.findByTestId('coach-muted');
    expect(banner.textContent).not.toMatch(EMOJI);
    expect(banner.querySelector('svg')).not.toBeNull();
  });

  it('the SDK icon map has the icons the Coach uses', async () => {
    const { buildSdk } = await import('./sdk');
    const icons = buildSdk().icons;
    for (const name of ['thumbs-up', 'thumbs-down', 'dots', 'bell-slash', 'x', 'arrow-up', 'arrow-down', 'arrow-right', 'target', 'plus', 'gear']) expect(icons[name]).toBeTruthy();
  });

  it('the mute commands mute and unmute', async () => {
    const { d } = await mount();
    const cmds = d.registered.coach.commands as { id: string; run: () => void }[];
    await act(async () => { cmds.find((c) => c.id === 'mute-coach')!.run(); });
    expect(await screen.findByTestId('coach-muted')).toBeInTheDocument();
    await act(async () => { cmds.find((c) => c.id === 'unmute-coach')!.run(); });
    expect(screen.queryByTestId('coach-muted')).toBeNull();
  });
});

type Mem = { facts: { id: string; text: string; confirmedAt: string | null }[]; known: string[]; muted: { type: string }[]; weights: Record<string, number>; levelAdjust: Record<string, number> };
const memOf = (d: FakeD) => (d.docs.get('memory') ?? null) as Mem | null;

describe('Coach feedback on the card (coach plan Task 11)', () => {
  it('👎 opens the reason chips; a reason with text asks before it saves a fact, then says what changed, with Edit and Undo', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Not helpful' }));
    for (const chip of ['I already do this', 'Not relevant to my work', 'Too basic', 'Too advanced', 'Wrong about what I did', 'Not now']) expect(screen.getByRole('button', { name: chip })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I already do this' }));
    expect(screen.getByRole('button', { name: 'I already do this' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Why? (optional)' }), { target: { value: 'Ops already sends it to me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const toast = await screen.findByTestId('coach-toast');
    expect(toast).toHaveTextContent('Ops already sends it to me');
    await waitFor(() => expect(memOf(d)!.known).toEqual(['idle-wait']));
    expect(memOf(d)!.facts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(memOf(d)!.facts.map((f) => f.text)).toEqual(['Ops already sends it to me']));
    expect(screen.getByTestId('coach-toast')).toHaveTextContent(/No more tips on this.*I saved: "Ops already sends it to me"/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(d.actions.setView).toHaveBeenCalledWith('plugin:coach:coach');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(memOf(d)).toMatchObject({ known: [], facts: [] }));
  });

  it('a fact the person does not confirm is not saved', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Not helpful' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Why? (optional)' }), { target: { value: 'I am in finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(screen.getByTestId('coach-toast')).toHaveTextContent('Fewer tips like this'));
    expect(memOf(d)!.facts).toEqual([]);
  });

  it('👎 with no reason only lowers the weight: the type is not muted, and the card closes', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Not helpful' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByTestId('coach-toast');
    await waitFor(() => expect(memOf(d)).toMatchObject({ weights: { 'idle-wait': -1 }, muted: [], known: [] }));
    expect((d.docs.get('cardState') as Record<string, { state: string }>)[CARD.id].state).toBe('down');
  });

  it('Not now is a rest only: the memory does not change and the type counts one dismissal', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Not helpful' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('coach-toast')).toHaveTextContent('Paused');
    await waitFor(() => expect((d.docs.get('cadence') as { dismissCount: Record<string, number> }).dismissCount['idle-wait']).toBe(1));
    expect(memOf(d)?.weights ?? {}).toEqual({});
  });

  it('👍 raises the weight and says so; Cancel closes the reasons with no change', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Not helpful' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Too basic' })).toBeNull();
    expect(d.docs.has('memory')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(await screen.findByTestId('coach-toast')).toHaveTextContent('More tips like this');
    await waitFor(() => expect(memOf(d)!.weights['idle-wait']).toBe(1));
  });

  it('Turn off this type mutes it, and other cards of that type stop showing', async () => {
    const other = { ...CARD, id: 'idle-wait:t1:y', at: '2026-11-20T10:58:00Z' };
    const { d } = await mount({ cards: [other, CARD] });
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn off this type' }));
    const toast = await screen.findByTestId('coach-toast');
    expect(toast).toHaveTextContent('This type of tip is off');
    await waitFor(() => expect(memOf(d)!.muted.map((m) => m.type)).toEqual(['idle-wait']));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('coach-toast')).toBeNull());
    expect(screen.queryByTestId('coach-card')).toBeNull();
  });

  it('Fewer tips like this lowers the weight by two', async () => {
    const { d } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fewer tips like this' }));
    await screen.findByTestId('coach-toast');
    await waitFor(() => expect(memOf(d)!.weights['idle-wait']).toBe(-2));
  });

  it('the third dismissal of a type offers to turn it off', async () => {
    const { d } = await mount({ cadence: { ...SEASONED, dismissCount: { 'idle-wait': 2 } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss (not now)' }));
    const offer = await screen.findByTestId('coach-offer');
    expect(offer).toHaveTextContent('Turn off this type?');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(memOf(d)!.muted.map((m) => m.type)).toEqual(['idle-wait']));
  });
});

describe('What the Coach knows (coach plan Task 11)', () => {
  async function screenWith(memory: unknown) {
    const d = fakeD({ docs: { cadence: SEASONED, memory, signals: { v: 1 }, cards: { items: [CARD] }, candidates: { items: [{ id: 'c', evidence: { excerpt: 'my words' } }], seen: ['c'] } } });
    const coach = createCoach(d, { now: () => NOW });
    await coach.ready;
    const View = (d.registered.coach.views[0] as unknown as { Component: () => JSX.Element }).Component;
    render(<View />);
    return d;
  }
  const MEM = {
    facts: [{ id: 'f1', text: 'Not a developer', source: 'Feedback on "X"', at: '2026-11-01T00:00:00Z', confirmedAt: '2026-11-01T00:00:00Z' }],
    known: ['repeated-prompt'], levelAdjust: { reuse: 1 }, muted: [{ type: 'idle-wait', until: null, reason: 'off', at: '2026-11-02T00:00:00Z' }], weights: {}, bad: [], dates: { 'known:repeated-prompt': '2026-11-03T00:00:00Z', 'level:reuse': '2026-11-04T00:00:00Z' },
  };

  it('lists every item with its source, and each has Delete; a fact has Edit', async () => {
    const d = await screenWith(MEM);
    const list = await screen.findByTestId('coach-knows');
    expect(list).toHaveTextContent('Not a developer');
    expect(list).toHaveTextContent('You already do this: Repeated prompts');
    expect(list).toHaveTextContent('Off: Waiting on one thread');
    expect(list).toHaveTextContent('aim higher');
    expect(list).toHaveTextContent('You said "Too basic"');
    expect(screen.getAllByRole('button', { name: /^Delete/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Not a developer' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Fact' }), { target: { value: 'Finance, not a developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(memOf(d)!.facts[0].text).toBe('Finance, not a developer'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Off: Waiting on one thread' }));
    await waitFor(() => expect(memOf(d)!.muted).toEqual([]));
  });

  it('Pause mutes the Coach until you turn it on; Reset clears the memory and the excerpts after you confirm', async () => {
    const d = await screenWith(MEM);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect((d.docs.get('cadence') as { mutedUntil: string }).mutedUntil).toMatch(/^9999/));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() => expect(memOf(d)).toMatchObject({ facts: [], known: [], muted: [] }));
    await waitFor(() => expect(JSON.stringify(d.docs.get('cards'))).not.toContain(CARD.excerpt));
    expect(JSON.stringify(d.docs.get('candidates'))).not.toContain('my words');
    expect(d.docs.has('signals')).toBe(false);
    expect(await screen.findByText('The Coach knows nothing about you yet.')).toBeInTheDocument();
  });

  it('a fact older than 6 months asks Still true?; a type muted 75 days ago asks Show these again? once', async () => {
    const d = await screenWith({ ...MEM, facts: [{ ...MEM.facts[0], confirmedAt: '2026-04-01T00:00:00Z' }], muted: [{ type: 'idle-wait', until: null, reason: 'off', at: '2026-08-20T00:00:00Z' }] });
    expect(await screen.findByText('Still true?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, still true' }));
    await waitFor(() => expect(memOf(d)!.facts[0].confirmedAt).toBe(NOW.toISOString()));
    expect(screen.getByTestId('coach-review')).toHaveTextContent('You turned off "Waiting on one thread" in August. Show these again?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep off' }));
    await waitFor(() => expect(screen.queryByTestId('coach-review')).toBeNull());
    expect((memOf(d)!.muted[0] as { reviewedAt?: string }).reviewedAt).toBeTruthy();
  });
});

describe('Coach card: More through the judge plan (coach plan Task 9)', () => {
  async function mountReal(over: { docs?: Record<string, unknown>; settings?: unknown } = {}) {
    const d: FakeD = fakeD({ docs: { cadence: SEASONED, cards: { items: [CARD] }, ...(over.docs ?? {}) }, settings: over.settings });
    const coach = createCoach(d, { now: () => NOW });
    await coach.ready;
    const Card = (d.registered.coach.slots[0] as { Component: Slot }).Component;
    render(<Card surface="thread" terminalId="t1" sessionId="s1" value="" set={vi.fn()} insert={vi.fn()} />);
    return d;
  }

  it('More asks the large tier on the harness the worker last used, with the memory in the prompt', async () => {
    const d = await mountReal({ docs: { status: { budget: { usedPercent: 0.2, capPercent: 3 }, harness: 'codex' }, memory: { facts: [{ id: 'f1', text: 'Works in finance', source: 'x', at: '2026-11-01T00:00:00Z', confirmedAt: '2026-11-01T00:00:00Z' }] } } });
    d.assist.mockResolvedValueOnce({ text: '{"better": "Plan it, then run it in two threads.", "bullets": ["Two at once."]}' });
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(await screen.findByText('Plan it, then run it in two threads.')).toBeInTheDocument();
    expect(d.assist).toHaveBeenCalledTimes(1);
    const req = d.assist.mock.calls[0][1];
    expect(req).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol' });
    expect(JSON.stringify(req.messages)).toContain('Works in finance');
  });

  it('More at the budget cap makes no call and says so; the card stays whole', async () => {
    const d = await mountReal({ docs: { status: { budget: { usedPercent: 3, capPercent: 3 } } } });
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(await screen.findByText('The Coach has used its budget for this week. More detail comes back when the week resets.')).toBeInTheDocument();
    expect(d.assist).not.toHaveBeenCalled();
    expect(screen.getByTestId('coach-card')).toHaveTextContent(CARD.headline);
  });

  it('More with a malformed answer shows no half-filled detail', async () => {
    const d = await mountReal();
    d.assist.mockResolvedValueOnce({ text: '{"better": ' });
    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(await screen.findByText('The Coach could not get more detail just now.')).toBeInTheDocument();
    expect(screen.queryByText('TRY')).toBeNull();
  });
});
