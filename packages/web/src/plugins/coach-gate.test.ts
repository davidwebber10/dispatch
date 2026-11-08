import { describe, it, expect, vi } from 'vitest';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { detect } from '../../../plugins/coach/lib/detectors.mjs';
import { DEFAULT_SETTINGS, withDefaults } from '../../../plugins/coach/lib/settings.mjs';
import { judgeCandidate } from '../../../plugins/coach/lib/judge.mjs';
import { confirmPrompt, CONFIRM_SYSTEM } from '../../../plugins/coach/lib/prompts.mjs';
import { emptyMemory } from '../../../plugins/coach/lib/memory.mjs';
import { createEngine } from '../../../plugins/coach/lib/engine.mjs';
import { emptyCadence } from '../../../plugins/coach/lib/cadence.mjs';

// Coach fix T6: the quality gate. Default to silence.
const T0 = Date.parse('2026-11-05T09:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const prompt = (t: string, min: number, text: string) => ({ type: 'thread:prompt', terminalId: t, sessionId: 's1', at: at(min), source: 'user', text });
const fold = (events: Record<string, unknown>[]) => events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());
const types = (events: Record<string, unknown>[], nowMin: number, settings = DEFAULT_SETTINGS) => detect(fold(events), settings, new Date(T0 + nowMin * 60_000)).map((c) => c.type);

const ANSWER = { fit: true, confidence: 0.9, ownWords: true, wouldChange: true, headline: 'Ask for a plan first', why: 'Your prompt had 4 parts and no plan step.', action: { kind: 'compose', label: 'Try it', text: 'Plan first.' } };
const FREE = { usedPercent: 0, capPercent: 3 };
const settings = withDefaults({ thoroughness: 'economy' });
const assistOf = (answer: unknown) => vi.fn(async () => ({ result: { text: JSON.stringify(answer), harness: 'claude' }, budget: FREE, refused: null }));
const cand = (excerpt: string) => ({ id: 'step-by-step:a', type: 'step-by-step', measure: 'ambition', tip: 'prompt', terminalId: 'a', projectId: 's1', evidence: { prompts: 5, minutes: 10, excerpt } });

describe('Coach quality gate (coach fix T6)', () => {
  it('the lowest confidence to show defaults to 0.85', () => {
    expect(DEFAULT_SETTINGS.advanced.minConfidence).toBe(0.85);
  });
  it('a candidate with an empty or non-person excerpt is never judged', async () => {
    for (const ex of ['', '<task-notification>done</task-notification>', '[From thread "x" of project "y" (thread t). This is not a message from the owner.]']) {
      const assist = assistOf(ANSWER);
      const r = await judgeCandidate(cand(ex), { settings, memory: emptyMemory(), budget: FREE, assist });
      expect(r.outcome, ex).toBe('dropped');
      expect(assist).not.toHaveBeenCalled();
    }
  });
  it('confirmPrompt asks whether these are the person\'s own words and whether a tip would change their next prompt', () => {
    expect(CONFIRM_SYSTEM).toContain("Are these the person's own words, and would a specific tip change their next prompt?");
    expect(confirmPrompt(cand('Summarize the pipeline report for the team'), emptyMemory()).system).toContain('"ownWords"');
  });
  it('a card fits only when both answers are yes', async () => {
    const ok = await judgeCandidate(cand('Summarize the pipeline report for the team'), { settings, memory: emptyMemory(), budget: FREE, assist: assistOf(ANSWER) });
    expect(ok.outcome).toBe('card');
    for (const over of [{ ownWords: false }, { wouldChange: false }, { ownWords: undefined }, { wouldChange: undefined }]) {
      const r = await judgeCandidate(cand('Summarize the pipeline report for the team'), { settings, memory: emptyMemory(), budget: FREE, assist: assistOf({ ...ANSWER, ...over }) });
      expect(r.outcome, JSON.stringify(over)).toBe('dropped');
    }
  });
  it('repeated-prompt needs 3 times in 2 threads or more, each 4 words or more', () => {
    const same = [0, 10, 20].map((m) => prompt('a', m, 'Summarize the pipeline report'));
    expect(types(same, 30)).not.toContain('repeated-prompt');
    const threeWords = ['a', 'b', 'c'].map((t, i) => prompt(t, i * 10, 'summarize pipeline report'));
    expect(types(threeWords, 30)).not.toContain('repeated-prompt');
    const good = ['a', 'b', 'a'].map((t, i) => prompt(t, i * 10, 'Summarize the pipeline report'));
    expect(types(good, 30)).toContain('repeated-prompt');
    const lower = withDefaults({ advanced: { thresholds: { repeatedPrompt: { count: 2 } } } });
    expect(types(good.slice(0, 2), 30, lower)).not.toContain('repeated-prompt');
  });
  it('step-by-step needs 5 content prompts, whatever the setting', () => {
    const lower = withDefaults({ advanced: { thresholds: { stepByStep: { prompts: 3 } } } });
    const four = [0, 3, 6, 9].map((m, i) => prompt('a', m, `now change line ${i}`));
    expect(types(four, 10, lower)).not.toContain('step-by-step');
  });
  it('14-day novelty: no new card of a measure and type shown or dismissed in the last 14 days', async () => {
    const NOW = T0 + 30 * 86400_000;
    const BIG = 'Pull last week returns by reason from the warehouse table. Chart them by week and by store. Compare them with the prior month and list the three biggest changes. Then email the summary to Sam with the chart attached. Keep it short and plain for the ops team, who read it on their phones between meetings. '.repeat(2);
    const run = async (cardState: Record<string, unknown>) => {
      const docs = new Map<string, unknown>([
        ['cadence', { ...emptyCadence(new Date(NOW - 20 * 86400_000)), welcomeSeenAt: new Date(NOW - 20 * 86400_000).toISOString() }],
        ['cards', { items: [{ id: 'no-plan-big-task:old', type: 'no-plan-big-task', measure: 'judgment' }], judged: [{ id: 'no-plan-big-task:old', outcome: 'card' }] }],
        ['cardState', cardState],
      ]);
      const assist = assistOf(ANSWER);
      const io = { getDoc: vi.fn(async (k: string, f: unknown) => (docs.has(k) ? JSON.parse(JSON.stringify(docs.get(k))) : f)), putDoc: vi.fn(async (k: string, v: unknown) => { docs.set(k, v); }), getSettings: vi.fn(async () => null), assist, notify: vi.fn(), now: () => new Date(NOW), log: vi.fn() };
      const e = createEngine(io); await e.load();
      await e.handle({ type: 'thread:prompt', terminalId: 't1', sessionId: 's1', at: new Date(NOW).toISOString(), source: 'user', text: BIG });
      await e.handle({ type: 'thread:turn', terminalId: 't1', sessionId: 's1', at: new Date(NOW).toISOString(), ms: 30_000 });
      await e.idle();
      return { assist, cards: docs.get('cards') as { items: unknown[] } };
    };
    const recent = await run({ 'no-plan-big-task:old': { state: 'dismissed', at: new Date(NOW - 3 * 86400_000).toISOString() } });
    expect(recent.assist).not.toHaveBeenCalled();
    expect(recent.cards.items).toHaveLength(1);
    const old = await run({ 'no-plan-big-task:old': { state: 'shown', at: new Date(NOW - 15 * 86400_000).toISOString() } });
    expect(old.assist).toHaveBeenCalled();
    expect(old.cards.items).toHaveLength(2);
  });
});
