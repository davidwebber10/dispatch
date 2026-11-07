import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { detect, DETECTORS } from '../../../plugins/coach/lib/detectors.mjs';
import { DEFAULT_SETTINGS, DEFAULT_THRESHOLDS, withDefaults } from '../../../plugins/coach/lib/settings.mjs';
import { skillDraftPrompt } from '../../../plugins/coach/lib/prompts.mjs';
import { judgeCandidate } from '../../../plugins/coach/lib/judge.mjs';
import { emptyMemory, confirmFact } from '../../../plugins/coach/lib/memory.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { createCoach } from '../../../plugins/coach/web.js';
import { fakeD } from './coach-test-utils';

const DAY = 86400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const BLOCK = 'When you finish, run the full test suite and fix what fails. Then list every file you changed, with one line on why. Do not touch the generated files under dist, and keep the commit message short.';
const TASKS = ['Add a CSV export to the orders page.', 'Fix the rounding bug in the invoice totals.', 'Rename the customer id field in the API.', 'Make the search box ignore case.'];
type Ev = Record<string, unknown>;
const prompt = (t: string, daysAgo: number, text: string, over: Ev = {}): Ev => ({ type: 'thread:prompt', terminalId: t, sessionId: 's1', at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), source: 'user', text, ...over });
const fold = (events: Ev[]) => events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());
const withBlock = (n: number) => TASKS.slice(0, n).map((task, i) => prompt(`t${i}`, 10 - i, `${task}\n\n${BLOCK}`));

describe('Coach skill-fit detector (coach plan Task 12d)', () => {
  it('is a reuse detector with its thresholds under Advanced', () => {
    expect(DETECTORS['skill-fit']).toEqual({ measure: 'reuse', tip: 'prompt' });
    expect(DEFAULT_THRESHOLDS.skillFit).toEqual({ minThreads: 3, days: 30, minChars: 200 });
  });
  it('fires on the same instruction block in 3 threads, and not in 2', () => {
    const three = detect(fold(withBlock(3)), DEFAULT_SETTINGS, NOW).filter((c) => c.type === 'skill-fit');
    expect(three).toHaveLength(1);
    expect(three[0]).toMatchObject({ measure: 'reuse', evidence: { threads: 3, days: 30 } });
    expect(String(three[0].evidence.text)).toBe(BLOCK);
    expect(detect(fold(withBlock(2)), DEFAULT_SETTINGS, NOW).map((c) => c.type)).not.toContain('skill-fit');
  });
  it('a block typed with different spacing or case is the same block; a whole prompt repeated is not a skill', () => {
    const events = [prompt('a', 9, `${TASKS[0]}\n\n${BLOCK}`), prompt('b', 8, `${TASKS[1]}\n\n${BLOCK.toUpperCase().replace(/ /g, '  ')}`), prompt('c', 7, `${TASKS[2]}\n\n${BLOCK}`)];
    expect(detect(fold(events), DEFAULT_SETTINGS, NOW).map((c) => c.type)).toContain('skill-fit');
    const whole = ['a', 'b', 'c'].map((t, i) => prompt(t, 9 - i, BLOCK));
    expect(detect(fold(whole), DEFAULT_SETTINGS, NOW).map((c) => c.type)).not.toContain('skill-fit');
  });
  it('the block threshold is a setting', () => {
    const s = withDefaults({ advanced: { thresholds: { skillFit: { minChars: 400 } } } });
    const short = withBlock(3).map((e) => ({ ...e, text: String(e.text).split('\n\n')[0] + '\n\nRun the tests when you finish, please, and list the files.' }));
    expect(detect(fold(short), s, NOW).map((c) => c.type)).not.toContain('skill-fit');
  });
  it('the signals keep a repeated block\'s text, but not the tasks around it', () => {
    const s = fold(withBlock(3)) as unknown as { blocks: Record<string, { text: string }> };
    const blocks = JSON.stringify(Object.values(s.blocks));
    expect(blocks).toContain(BLOCK.slice(0, 120));
    expect(blocks).not.toContain('Rename the customer id field');
  });
});

const CAND = { id: 'skill-fit:x', type: 'skill-fit', measure: 'reuse', tip: 'prompt', terminalId: 't2', projectId: 's1', evidence: { threads: 3, days: 30, text: BLOCK, excerpt: BLOCK.slice(0, 200) }, at: NOW.toISOString() };
const CONFIRM = { fit: true, confidence: 0.9, headline: 'Save your finishing steps as a skill', why: 'You pasted the same finishing steps into 3 threads.', action: { kind: 'compose', label: 'x', text: 'x' } };
const DRAFT = { name: 'Finish and report', description: 'Run the tests, fix failures, list the changed files.', body: '# Finish and report\n\n- Run the full test suite and fix what fails.\n- List every changed file.' };

describe('Coach skill draft (coach plan Task 12d)', () => {
  it('the draft prompt gets only the repeated text: no memory, no other prompt content', () => {
    const p = skillDraftPrompt(CAND);
    const all = JSON.stringify(p);
    expect(all).toContain(BLOCK);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].content).toBe(`The repeated instructions:\n\n${BLOCK}`);
  });
  it('the judge confirms, then the large model drafts; the card carries the draft and a Create skill action', async () => {
    const memory = confirmFact(emptyMemory(), { id: 'f', text: 'SECRET FACT', source: 'x', at: NOW.toISOString(), confirmedAt: null });
    const assist = vi.fn()
      .mockResolvedValueOnce({ result: { text: JSON.stringify(CONFIRM), harness: 'claude' }, budget: null, refused: null })
      .mockResolvedValueOnce({ result: { text: JSON.stringify(DRAFT), harness: 'claude' }, budget: null, refused: null });
    const r = await judgeCandidate(CAND, { settings: withDefaults({ thoroughness: 'economy' }), memory, budget: null, assist, now: NOW });
    expect(assist).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(assist.mock.calls[1][0])).not.toContain('SECRET FACT');
    expect(assist.mock.calls[1][0]).toMatchObject({ harness: 'claude', model: 'opus' });
    expect(r.card).toMatchObject({ type: 'skill-fit', skill: DRAFT, action: { kind: 'skill', label: 'Create skill' } });
  });
  it('a malformed draft drops the candidate', async () => {
    const assist = vi.fn()
      .mockResolvedValueOnce({ result: { text: JSON.stringify(CONFIRM), harness: 'claude' }, budget: null, refused: null })
      .mockResolvedValueOnce({ result: { text: '{"name": "x"}', harness: 'claude' }, budget: null, refused: null });
    const r = await judgeCandidate(CAND, { settings: withDefaults({ thoroughness: 'economy' }), memory: emptyMemory(), budget: null, assist, now: NOW });
    expect(r.outcome).toBe('dropped');
  });
});

afterEach(() => { cleanup(); });

describe('Coach skill card: Create skill (coach plan Task 12d)', () => {
  const card = { id: 'skill-fit:x', type: 'skill-fit', measure: 'reuse', terminalId: 't1', projectId: 's1', headline: CONFIRM.headline, why: CONFIRM.why, skill: DRAFT, action: { kind: 'skill', label: 'Create skill' }, excerpt: '', reason: 'r', at: NOW.toISOString() };
  async function mount(createSkill: unknown) {
    const d = fakeD({ docs: { cadence: emptyCadence(new Date(2026, 10, 1)), cards: { items: [card] } }, actions: { createSkill } });
    const coach = createCoach(d, { now: () => new Date(2026, 10, 23, 13, 0) });
    await coach.ready;
    const Card = (d.registered.coach.slots[0] as { Component: (p: Record<string, unknown>) => JSX.Element | null }).Component;
    const set = vi.fn();
    render(<Card surface="thread" terminalId="t1" sessionId="s1" value="" set={set} insert={vi.fn()} />);
    return { d, set };
  }
  it('shows the skill\'s name and one line; Create skill opens the review sheet and writes nothing itself', async () => {
    const createSkill = vi.fn(async () => ({ id: 'finish-and-report' }));
    const { d, set } = await mount(createSkill);
    const el = await screen.findByTestId('coach-card');
    expect(el).toHaveTextContent('The skill: Finish and report. Run the tests, fix failures, list the changed files.');
    fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
    expect(createSkill).toHaveBeenCalledWith({ name: DRAFT.name, description: DRAFT.description, body: DRAFT.body, projectId: 's1' });
    expect(set).not.toHaveBeenCalled();
    await waitFor(() => expect((d.docs.get('cardState') as Record<string, { state: string }>)[card.id].state).toBe('used'));
    expect(d.hint).toHaveBeenCalledWith('Skill created. Every thread gets it now.');
  });
  it('Cancel in the sheet keeps the card', async () => {
    const createSkill = vi.fn(async () => null);
    const { d } = await mount(createSkill);
    fireEvent.click(await screen.findByRole('button', { name: 'Create skill' }));
    await waitFor(() => expect(createSkill).toHaveBeenCalled());
    expect((d.docs.get('cardState') as Record<string, { state: string }> | undefined)?.[card.id]?.state).not.toBe('used');
    expect(screen.getByTestId('coach-card')).toBeInTheDocument();
  });
});
