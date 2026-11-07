import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { detect, DETECTORS } from '../../../plugins/coach/lib/detectors.mjs';
import { DEFAULT_SETTINGS, DEFAULT_THRESHOLDS, withDefaults } from '../../../plugins/coach/lib/settings.mjs';
import { judgeCandidate } from '../../../plugins/coach/lib/judge.mjs';
import { confirmPrompt, buildPluginPrompt } from '../../../plugins/coach/lib/prompts.mjs';
import { emptyMemory } from '../../../plugins/coach/lib/memory.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';
import { createCoach } from '../../../plugins/coach/web.js';
import { fakeD } from './coach-test-utils';

const DAY = 86400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const STEPS = ['pull the returns export from the warehouse portal', 'clean the export and drop the test orders', 'chart returns by reason and by store', 'email the chart and a short summary to the ops team'];
type Ev = Record<string, unknown>;
/** One run of the 4-step workflow in its own thread, `daysAgo` days back. */
function run(t: string, daysAgo: number, first: { source?: string } = {}): Ev[] {
  const base = NOW.getTime() - daysAgo * DAY;
  const out: Ev[] = [];
  STEPS.forEach((text, i) => {
    const at = base + i * 10 * 60_000;
    out.push({ type: 'thread:prompt', terminalId: t, sessionId: 's1', at: new Date(at).toISOString(), source: i === 0 && first.source ? first.source : 'user', text });
    out.push({ type: 'thread:turn', terminalId: t, sessionId: 's1', at: new Date(at + 60_000).toISOString(), ms: 60_000 });
  });
  return out;
}
const fold = (events: Ev[]) => events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());
const types = (events: Ev[], settings = DEFAULT_SETTINGS) => detect(fold(events), settings, NOW).map((c) => c.type);

describe('Coach plugin-fit detector (coach plan Task 12c)', () => {
  it('is a reuse detector with its thresholds under Advanced', () => {
    expect(DETECTORS['plugin-fit']).toEqual({ measure: 'reuse', tip: 'thinkBigger' });
    expect(DEFAULT_THRESHOLDS.pluginFit).toEqual({ minRepeats: 3, days: 30, minSteps: 3 });
  });

  it('fires on the same 4-step workflow 3 times in 30 days, and the repeated steps do not also fire as repeated prompts', () => {
    const events = [...run('a', 20), ...run('b', 10), ...run('c', 2)];
    const found = detect(fold(events), DEFAULT_SETTINGS, NOW);
    const fit = found.find((c) => c.type === 'plugin-fit')!;
    expect(fit).toMatchObject({ measure: 'reuse', projectId: 's1', terminalId: 'c', evidence: { steps: 4, repeats: 3, days: 30 } });
    expect(String(fit.evidence.excerpt)).toContain('pull the returns export');
    expect(found.map((c) => c.type)).not.toContain('repeated-prompt');
  });

  it('does not fire twice, nor older than the window, nor with fewer steps', () => {
    expect(types([...run('a', 20), ...run('b', 10)])).not.toContain('plugin-fit');
    expect(types([...run('a', 50), ...run('b', 40), ...run('c', 2)])).not.toContain('plugin-fit');
    expect(types([...run('a', 20), ...run('b', 10), ...run('c', 2)], withDefaults({ advanced: { thresholds: { pluginFit: { minSteps: 5 } } } }))).not.toContain('plugin-fit');
  });

  it('does not fire when a schedule already covers the workflow', () => {
    // A thread a schedule started (its first prompt was not the person's) runs the same first step.
    const events = [...run('a', 20), ...run('b', 10), ...run('c', 2), ...run('sched', 1, { source: 'daemon' })];
    expect(types(events)).not.toContain('plugin-fit');
  });
});

const CAND = { id: 'plugin-fit:x', type: 'plugin-fit', measure: 'reuse', tip: 'thinkBigger', terminalId: 'c', projectId: 's1', evidence: { steps: 4, repeats: 3, days: 30, excerpt: STEPS[0] }, at: NOW.toISOString() };
const ANSWER = { fit: true, confidence: 0.9, headline: 'Build a returns report plugin', why: 'A screen updates itself; a schedule only sends the same email.', plugin: 'A Returns screen that pulls, cleans and charts the export.', parts: ['view', 'worker', 'nonsense'] };

describe('Coach plugin-fit card (coach plan Task 12c)', () => {
  it('the confirm prompt asks for the plugin parts', () => {
    expect(confirmPrompt(CAND, emptyMemory()).system).toMatch(/"parts"/);
    expect(confirmPrompt(CAND, emptyMemory()).system).toMatch(/view, button, worker, hook/);
  });

  it('the card says what the plugin would do, keeps only known parts, and its action is the build prompt', async () => {
    const assist = vi.fn().mockResolvedValueOnce({ result: { text: JSON.stringify(ANSWER), harness: 'claude' }, budget: null, refused: null });
    const r = await judgeCandidate(CAND, { settings: withDefaults({ thoroughness: 'economy' }), memory: emptyMemory(), budget: null, assist, now: NOW });
    expect(r.card).toMatchObject({ type: 'plugin-fit', plugin: ANSWER.plugin, parts: ['view', 'worker'], action: { kind: 'plugin', label: 'Try it: build the plugin' } });
    const prompt = (r.card!.action as { prompt: string }).prompt;
    expect(prompt).toContain('docs/plugins.md');
    expect(prompt).toContain(ANSWER.plugin);
    expect(prompt).toMatch(/disabled/);
    expect(prompt).toContain(STEPS[0]);
  });

  it('an answer without parts or a plugin line is dropped', async () => {
    const assist = vi.fn().mockResolvedValueOnce({ result: { text: JSON.stringify({ ...ANSWER, parts: [] }), harness: 'claude' }, budget: null, refused: null });
    const r = await judgeCandidate(CAND, { settings: withDefaults({ thoroughness: 'economy' }), memory: emptyMemory(), budget: null, assist, now: NOW });
    expect(r.outcome).toBe('dropped');
  });

  it('buildPluginPrompt asks for the fewest permissions and a disabled plugin to review', () => {
    const p = buildPluginPrompt({ plugin: 'A Returns screen', parts: ['view'], excerpt: 'pull the export' });
    expect(p).toMatch(/fewest permissions/);
    expect(p).toMatch(/Plugins page/);
  });
});

afterEach(() => { cleanup(); });

describe('Coach plugin-fit: Try it (coach plan Task 12c)', () => {
  it('opens the new-thread dialog with the plugin prompt and creates nothing', async () => {
    const card = { id: 'plugin-fit:x', type: 'plugin-fit', measure: 'reuse', terminalId: 't1', projectId: 's1', headline: 'Build a returns report plugin', why: ANSWER.why, plugin: ANSWER.plugin, parts: ['view', 'worker'], action: { kind: 'plugin', label: 'Try it: build the plugin', prompt: 'Build a Dispatch plugin for me.' }, excerpt: '', reason: 'r', at: NOW.toISOString() };
    const openNewThreads = vi.fn();
    const openSchedule = vi.fn();
    const d = fakeD({ docs: { cadence: emptyCadence(new Date(2026, 10, 1)), cards: { items: [card] } }, actions: { openNewThreads, openSchedule } });
    const coach = createCoach(d, { now: () => new Date(2026, 10, 23, 13, 0) });
    await coach.ready;
    const Card = (d.registered.coach.slots[0] as { Component: (p: Record<string, unknown>) => JSX.Element | null }).Component;
    const set = vi.fn();
    render(<Card surface="thread" terminalId="t1" sessionId="s1" value="" set={set} insert={vi.fn()} />);
    const el = await screen.findByTestId('coach-card');
    expect(el).toHaveTextContent('The plugin: A Returns screen that pulls, cleans and charts the export. Parts: a screen, a worker.');
    fireEvent.click(screen.getByRole('button', { name: 'Try it: build the plugin' }));
    expect(openNewThreads).toHaveBeenCalledWith({ projectId: 's1', prompts: ['Build a Dispatch plugin for me.'] });
    expect(set).not.toHaveBeenCalled();
    expect(openSchedule).not.toHaveBeenCalled();
    expect(d.assist).not.toHaveBeenCalled();
    await waitFor(() => expect((d.docs.get('cardState') as Record<string, { state: string }>)[card.id].state).toBe('used'));
  });
});
