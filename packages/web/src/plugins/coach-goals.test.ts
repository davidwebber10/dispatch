import { describe, it, expect, vi } from 'vitest';
import { suggestGoals, addGoal, setGoalStatus, editGoal, mapGoal, keywordMap, rankCandidates, activeGoals, goalProgress, MAX_ACTIVE } from '../../../plugins/coach/lib/goals.mjs';
import { emptyMemory, memoryItems, removeItem, normalizeMemory } from '../../../plugins/coach/lib/memory.mjs';
import { detect } from '../../../plugins/coach/lib/detectors.mjs';
import { collect, emptyState } from '../../../plugins/coach/lib/signals.mjs';
import { buildRecap } from '../../../plugins/coach/lib/recap.mjs';
import { measures } from '../../../plugins/coach/lib/measures.mjs';
import { DEFAULT_SETTINGS, withDefaults } from '../../../plugins/coach/lib/settings.mjs';

const NOW = new Date(2026, 10, 23, 8, 0);
const DAY = 86400_000;
const M = (scores: Record<string, number>, enough = true) => Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v, trend: 0, enough }]));
const ALL = (s: Partial<Record<string, number>>) => M({ ambition: 50, delegation: 50, reuse: 50, judgment: 50, breadth: 50, ...s } as Record<string, number>);

describe('Coach goals: suggestions (coach plan Task 12b)', () => {
  it('suggests at most 3 goals; the weakest measure first', () => {
    const s = suggestGoals(emptyState(), ALL({ reuse: 10, delegation: 30 }), emptyMemory());
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s[0]).toMatchObject({ measures: ['reuse'], detectors: ['repeated-prompt'] });
    expect(s[1].measures).toEqual(['delegation']);
    for (const g of s) expect(g.text.split(/\s+/).length).toBeLessThanOrEqual(8);
  });
  it('the detectors that fire most come next; an active goal is not suggested again', () => {
    const candidates = { items: [{ type: 'no-plan-big-task' }, { type: 'fast-approve' }, { type: 'no-plan-big-task' }] };
    const memory = addGoal(emptyMemory(), { text: 'Automate my Monday work', measures: ['reuse'], detectors: ['repeated-prompt'], source: 'user' }, NOW).memory;
    const s = suggestGoals(emptyState(), ALL({ reuse: 10 }), memory, candidates);
    expect(s.map((g) => g.measures[0])).not.toContain('reuse');
    expect(s[0].measures).toEqual(['judgment']);
  });
  it('with no data the suggestions still read well, and none is a duplicate', () => {
    const s = suggestGoals(emptyState(), null, emptyMemory());
    expect(s).toHaveLength(3);
    expect(new Set(s.map((g) => g.text)).size).toBe(3);
  });
});

describe('Coach goals: the list (coach plan Task 12b)', () => {
  it('at most 3 active goals; a done goal frees a place', () => {
    let m = emptyMemory();
    for (const text of ['One', 'Two', 'Three']) m = addGoal(m, { text, measures: ['ambition'], detectors: [], source: 'user' }, NOW).memory;
    expect(activeGoals(m)).toHaveLength(MAX_ACTIVE);
    const r = addGoal(m, { text: 'Four', measures: ['reuse'], detectors: [], source: 'user' }, NOW);
    expect(r.ok).toBe(false);
    expect(activeGoals(r.memory)).toHaveLength(3);
    m = setGoalStatus(m, activeGoals(m)[0].id, 'done', NOW);
    expect(addGoal(m, { text: 'Four', measures: ['reuse'], detectors: [], source: 'user' }, NOW).ok).toBe(true);
  });
  it('goals are in What the Coach knows, can be edited and deleted, and survive normalizeMemory', () => {
    let m = addGoal(emptyMemory(), { text: 'Run more things at once', measures: ['delegation'], detectors: ['serial-independent'], source: 'suggested' }, NOW).memory;
    m = normalizeMemory(JSON.parse(JSON.stringify(m)));
    const items = memoryItems(m).filter((i) => i.kind === 'goal');
    expect(items).toEqual([expect.objectContaining({ label: 'Goal: Run more things at once', source: 'Suggested by the Coach' })]);
    m = editGoal(m, items[0].key, 'Run three threads at once');
    expect(activeGoals(m)[0].text).toBe('Run three threads at once');
    m = removeItem(m, 'goal', items[0].key);
    expect(m.goals).toEqual([]);
  });
});

describe('Coach goals: mapping free text (coach plan Task 12b)', () => {
  it('the keyword fallback maps the owner\'s examples', () => {
    expect(keywordMap('I want to hand off whole reports').measures).toContain('ambition');
    expect(keywordMap('I want to automate my Monday work')).toMatchObject({ measures: ['reuse'], detectors: ['repeated-prompt'] });
    expect(keywordMap('I want to run more things at once').measures).toEqual(['delegation']);
    expect(keywordMap('Check the numbers before I send them').measures).toEqual(['judgment']);
    expect(keywordMap('something else entirely').measures).toEqual(['ambition']);
  });
  it('mapGoal without a model uses the keywords', async () => {
    expect(await mapGoal('I want to automate my Monday work', { assist: null, settings: DEFAULT_SETTINGS, budget: null })).toMatchObject({ measures: ['reuse'], via: 'keywords' });
  });
  it('mapGoal asks the small tier and keeps only known measures and detectors; a bad answer falls back', async () => {
    const assist = vi.fn().mockResolvedValueOnce({ text: '{"measures": ["delegation", "nonsense"], "detectors": ["idle-wait", "made-up"]}' });
    const r = await mapGoal('Keep busy while agents run', { assist, settings: DEFAULT_SETTINGS, budget: null });
    expect(assist.mock.calls[0][0]).toMatchObject({ harness: 'auto' });
    expect(r).toEqual({ measures: ['delegation'], detectors: ['idle-wait'], via: 'model' });
    const bad = vi.fn().mockResolvedValueOnce({ text: 'no' });
    expect(await mapGoal('automate my weekly report', { assist: bad, settings: DEFAULT_SETTINGS, budget: null })).toMatchObject({ measures: ['reuse'], via: 'keywords' });
    const never = vi.fn();
    expect(await mapGoal('automate my weekly report', { assist: never, settings: DEFAULT_SETTINGS, budget: { usedPercent: 3, capPercent: 3 } })).toMatchObject({ via: 'keywords' });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('Coach goals steer the cards (coach plan Task 12b)', () => {
  const c = (type: string, measure: string) => ({ id: `${type}:1`, type, measure, tip: 'prompt', terminalId: 't1', projectId: 's1', evidence: {} });
  it('a goal-serving candidate outranks a higher-weight one, and is tagged with its goal', () => {
    let m = addGoal(emptyMemory(), { text: 'Plan first', measures: ['judgment'], detectors: ['no-plan-big-task'], source: 'user' }, NOW).memory;
    m = { ...m, weights: { 'idle-wait': 5 } };
    const ranked = rankCandidates([c('idle-wait', 'delegation'), c('no-plan-big-task', 'judgment')], m);
    expect(ranked.map((x) => x.type)).toEqual(['no-plan-big-task', 'idle-wait']);
    expect(ranked[0].goal).toBe(activeGoals(m)[0].id);
    expect(ranked[1].goal).toBeUndefined();
    // Without goals, the weights rank.
    expect(rankCandidates([c('no-plan-big-task', 'judgment'), c('idle-wait', 'delegation')], { ...emptyMemory(), weights: { 'idle-wait': 5 } }).map((x) => x.type)).toEqual(['idle-wait', 'no-plan-big-task']);
  });
  it('the gate still drops ambition and delegation when judgment is weakest, even for a goal', () => {
    const T0 = NOW.getTime() - 3600_000;
    const ev = (type: string, t: string, min: number, over: Record<string, unknown> = {}) => ({ type, terminalId: t, sessionId: 's1', at: new Date(T0 + min * 60_000).toISOString(), ...over });
    const events = [ev('thread:prompt', 't1', 0, { source: 'user', text: 'run the tests' }), ev('thread:turn', 't1', 6, { ms: 6 * 60_000 })];
    const state = events.reduce((s, e) => collect(e, s, DEFAULT_SETTINGS), emptyState());
    const m = addGoal(emptyMemory(), { text: 'Run more things at once', measures: ['delegation'], detectors: ['idle-wait'], source: 'user' }, NOW).memory;
    const settings = withDefaults({});
    expect(rankCandidates(detect(state, settings, NOW, { weakest: null }), m).map((x) => x.type)).toContain('idle-wait');
    expect(rankCandidates(detect(state, settings, NOW, { weakest: 'judgment' }), m).map((x) => x.type)).not.toContain('idle-wait');
  });
});

describe('Coach goals in the weekly recap (coach plan Task 12b)', () => {
  const state = (() => {
    let s = emptyState();
    for (let d = 0; d < 7; d++) {
      const base = NOW.getTime() - 7 * DAY + d * DAY + 9 * 3600_000;
      for (const e of [
        { type: 'thread:prompt', terminalId: `t${d}`, sessionId: 's1', at: new Date(base).toISOString(), source: 'user', text: 'summarize the sales pipeline email' },
        { type: 'thread:turn', terminalId: `t${d}`, sessionId: 's1', at: new Date(base + 60_000).toISOString(), ms: 60_000 },
      ]) s = collect(e, s, DEFAULT_SETTINGS);
    }
    return s;
  })();
  it('goalProgress says what moved and one next step', () => {
    const goal = { id: 'g1', text: 'Automate my Monday work', measures: ['reuse'], detectors: ['repeated-prompt'], source: 'user' as const, addedAt: NOW.toISOString(), status: 'active' as const };
    const up = goalProgress(goal, { reuse: { score: 40, trend: 1, enough: true } });
    expect(up.progress).toBe('Reuse went up this month.');
    expect(up.next.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(goalProgress(goal, null).progress).toBe('Not enough data yet to see a change.');
  });
  it('the recap reports each active goal, and asks Keep, Done or Change once a month', () => {
    let memory = addGoal(emptyMemory(), { text: 'Automate my Monday work', measures: ['reuse'], detectors: ['repeated-prompt'], source: 'user' }, new Date(NOW.getTime() - 40 * DAY)).memory;
    const r = buildRecap(state, { memory, measures: measures(state, NOW), now: NOW })!;
    expect(r.goals).toEqual([expect.objectContaining({ text: 'Automate my Monday work', progress: expect.any(String), next: expect.any(String) })]);
    expect(r.askGoals).toBe(true);
    memory = { ...memory, dates: { ...memory.dates, 'goals:asked': new Date(NOW.getTime() - 10 * DAY).toISOString() } };
    expect(buildRecap(state, { memory, measures: measures(state, NOW), now: NOW })!.askGoals).toBe(false);
    expect(buildRecap(state, { memory: emptyMemory(), measures: null, now: NOW })!.goals).toEqual([]);
  });
});
