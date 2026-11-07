import { describe, it, expect } from 'vitest';
import { collect, emptyState, classify } from '../../../plugins/coach/lib/signals.mjs';
import { detect, DETECTORS, proposeNew } from '../../../plugins/coach/lib/detectors.mjs';
import { DEFAULT_SETTINGS, withDefaults } from '../../../plugins/coach/lib/settings.mjs';

// A clock and event builders: every event carries terminalId, sessionId (the project) and at.
const T0 = Date.parse('2026-11-05T09:00:00Z');
const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
const prompt = (t: string, min: number, text: string, over: Record<string, unknown> = {}) => ({ type: 'thread:prompt', terminalId: t, sessionId: 's1', harness: 'claude-code', at: at(min), source: 'user', text, textLength: text.length, ...over });
const turn = (t: string, endMin: number, ms: number, over: Record<string, unknown> = {}) => ({ type: 'thread:turn', terminalId: t, sessionId: 's1', harness: 'claude-code', at: at(endMin), ms, inputTokens: 1, outputTokens: 1, costUsd: null, outcome: 'done', ...over });
const fold = (events: Record<string, unknown>[], settings = DEFAULT_SETTINGS) => events.reduce((s, e) => collect(e, s, settings), emptyState());
const types = (events: Record<string, unknown>[], nowMin: number, settings = DEFAULT_SETTINGS, ctx = {}) =>
  detect(fold(events, settings), settings, new Date(T0 + nowMin * 60_000), ctx).map((c) => c.type);

describe('Coach signals: collect (coach plan Task 8)', () => {
  it('keeps prompts the person sent, as a 200-char excerpt and features, never the full text', () => {
    const long = 'Build the quarterly report. '.repeat(40) + 'SECRET-TAIL';
    const s = fold([prompt('t1', 0, long), prompt('t1', 1, 'from a peer', { source: 'thread' }), prompt('t1', 2, 'from the coordinator', { source: 'coordinator' })]);
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0].ex.length).toBeLessThanOrEqual(200);
    expect(s.prompts[0].len).toBe(long.length);
    expect(JSON.stringify(s)).not.toContain('SECRET-TAIL');
  });

  it('a turn records its start, end and length; the thread is busy between its prompt and its turn end', () => {
    let s = fold([prompt('t1', 0, 'fix it')]);
    expect(s.open.t1).toBe(at(0));
    s = collect(turn('t1', 4, 240_000), s, DEFAULT_SETTINGS);
    expect(s.open.t1).toBeUndefined();
    expect(s.turns[0]).toMatchObject({ t: 't1', p: 's1', ms: 240_000, end: at(4) });
  });

  it('classifies the kind of work from the first prompt', () => {
    expect(classify('fix the null check in parseOrder')).toBe('code');
    expect(classify('write the follow-up email to the buyer')).toBe('writing');
    expect(classify('research the top three vendors for pallets')).toBe('research');
    expect(classify('reconcile the month-end spreadsheet')).toBe('data');
  });
});

describe('Coach detectors (coach plan Task 8)', () => {
  it('lists the v1 detectors (seven, and plugin-fit from Task 12c), each with its measure and tip type', () => {
    expect(Object.keys(DETECTORS).sort()).toEqual(['fast-approve', 'idle-wait', 'narrow-breadth', 'no-plan-big-task', 'plugin-fit', 'repeated-prompt', 'serial-independent', 'step-by-step']);
    expect(DETECTORS['repeated-prompt']).toMatchObject({ measure: 'reuse', tip: 'thinkBigger' });
    expect(DETECTORS['fast-approve']).toMatchObject({ measure: 'judgment', tip: 'prompt' });
  });

  it('repeated-prompt: the same prompt 3 times in 14 days fires; twice does not; a higher threshold does not', () => {
    const ev = [prompt('t1', 0, 'Summarize the pipeline  report'), prompt('t2', 60 * 24 * 3, 'summarize the pipeline report'), prompt('t3', 60 * 24 * 6, 'Summarize the pipeline report.')];
    const now = 60 * 24 * 6 + 5;
    expect(types(ev, now)).toContain('repeated-prompt');
    expect(types(ev.slice(0, 2), now)).not.toContain('repeated-prompt');
    const strict = withDefaults({ advanced: { thresholds: { repeatedPrompt: { count: 4 } } } });
    expect(types(ev, now, strict)).not.toContain('repeated-prompt');
    const old = [prompt('t1', 0, 'Summarize the pipeline report'), prompt('t2', 60 * 24 * 10, 'Summarize the pipeline report'), prompt('t3', 60 * 24 * 20, 'Summarize the pipeline report')];
    expect(types(old, 60 * 24 * 20 + 5)).not.toContain('repeated-prompt');
  });

  it('serial-independent: 3 short threads in one project, one after another, fires; overlapping threads do not', () => {
    const serial = [prompt('a', 0, 'fix the login bug'), turn('a', 10, 600_000), prompt('b', 12, 'add the export button'), turn('b', 20, 480_000), prompt('c', 22, 'update the readme'), turn('c', 30, 480_000)];
    expect(types(serial, 31)).toContain('serial-independent');
    const overlap = [prompt('a', 0, 'fix the login bug'), prompt('b', 2, 'add the export button'), turn('a', 10, 600_000), prompt('c', 12, 'update the readme'), turn('b', 20, 1_080_000), turn('c', 30, 1_080_000)];
    expect(types(overlap, 31)).not.toContain('serial-independent');
    const long = [prompt('a', 0, 'fix the login bug'), turn('a', 40, 2_400_000), prompt('b', 42, 'add the export button'), turn('b', 50, 480_000), prompt('c', 52, 'update the readme'), turn('c', 60, 480_000)];
    expect(types(long, 61)).not.toContain('serial-independent');
  });

  it('idle-wait: one thread busy over 3 minutes, nothing else running and nothing sent, fires; a parallel thread stops it', () => {
    const idle = [prompt('a', 0, 'run the full test suite and fix failures'), turn('a', 5, 300_000)];
    expect(types(idle, 6)).toContain('idle-wait');
    const parallel = [prompt('a', 0, 'run the full test suite and fix failures'), prompt('b', 1, 'draft the release note'), turn('b', 3, 120_000), turn('a', 5, 300_000)];
    expect(types(parallel, 6)).not.toContain('idle-wait');
    const short = [prompt('a', 0, 'run the tests'), turn('a', 2, 120_000)];
    expect(types(short, 3)).not.toContain('idle-wait');
  });

  it('step-by-step: 5 one-line prompts in one thread within 30 minutes fires; 4 does not; a long prompt breaks the run', () => {
    const steps = [0, 3, 6, 9, 12].map((m, i) => prompt('a', m, `now change line ${i}`));
    expect(types(steps, 13)).toContain('step-by-step');
    expect(types(steps.slice(0, 4), 13)).not.toContain('step-by-step');
    const spread = [0, 10, 20, 30, 40].map((m, i) => prompt('a', m, `now change line ${i}`));
    expect(types(spread, 41)).not.toContain('step-by-step');
  });

  it('no-plan-big-task: a long prompt with 3+ parts and no plan ask fires; the same with "plan first" does not', () => {
    const big = 'Migrate the orders service to the new database client and keep the old API working for one release. '
      + 'Update every query in src/orders to use parameterized statements and remove the string building. '
      + 'Add integration tests for create, update and cancel against a disposable database. '
      + 'Then update the deployment manifest, bump the version, and write a short migration note for the operations team and the support desk.';
    expect(big.length).toBeGreaterThan(400);
    expect(types([prompt('a', 0, big)], 1)).toContain('no-plan-big-task');
    expect(types([prompt('a', 0, `Make a plan first and wait for my OK. ${big}`)], 1)).not.toContain('no-plan-big-task');
    expect(types([prompt('a', 0, 'Fix the typo in the header.')], 1)).not.toContain('no-plan-big-task');
  });

  it('fast-approve: "looks good" within 10 s of a long turn fires; after a short turn or a slow read it does not', () => {
    const fast = [prompt('a', 0, 'refactor the billing module'), turn('a', 5, 300_000), { ...prompt('a', 5, 'looks good, ship it'), at: at(5, 6) }];
    expect(types(fast, 6)).toContain('fast-approve');
    const slow = [prompt('a', 0, 'refactor the billing module'), turn('a', 5, 300_000), { ...prompt('a', 5, 'looks good, ship it'), at: at(5, 50) }];
    expect(types(slow, 6)).not.toContain('fast-approve');
    const shortTurn = [prompt('a', 0, 'rename x'), turn('a', 0.5, 30_000), { ...prompt('a', 0.5, 'lgtm'), at: at(0, 33) }];
    expect(types(shortTurn, 1)).not.toContain('fast-approve');
  });

  it('narrow-breadth: over 90% of 30-day threads of one kind fires (with at least 10 threads); a mix does not', () => {
    const writing = Array.from({ length: 12 }, (_, i) => prompt(`w${i}`, i * 60, `write a reply email to customer ${i}`));
    expect(types(writing, 13 * 60)).toContain('narrow-breadth');
    const mixed = [...writing.slice(0, 8), ...Array.from({ length: 4 }, (_, i) => prompt(`c${i}`, 800 + i, `fix the failing test in module ${i}`))];
    expect(types(mixed, 13 * 60)).not.toContain('narrow-breadth');
    expect(types(writing.slice(0, 5), 13 * 60)).not.toContain('narrow-breadth');
  });

  it('a candidate carries an id, its type, measure, thread, project and evidence; the same situation gives the same id', () => {
    const ev = [prompt('t1', 0, 'Summarize the pipeline report'), prompt('t2', 10, 'Summarize the pipeline report'), prompt('t3', 20, 'Summarize the pipeline report')];
    const s = fold(ev);
    const [c] = detect(s, DEFAULT_SETTINGS, new Date(T0 + 21 * 60_000)).filter((x) => x.type === 'repeated-prompt');
    expect(c).toMatchObject({ type: 'repeated-prompt', measure: 'reuse', tip: 'thinkBigger', terminalId: 't3', projectId: 's1' });
    expect(c.evidence).toMatchObject({ count: 3 });
    expect(c.id).toBe(detect(s, DEFAULT_SETTINGS, new Date(T0 + 30 * 60_000)).find((x) => x.type === 'repeated-prompt')!.id);
  });

  it('the gate: while judgment is the weakest measure, ambition and delegation candidates are dropped', () => {
    const ev = [prompt('a', 0, 'run the full test suite and fix failures'), turn('a', 5, 300_000), ...[6, 7, 8, 9, 10].map((m, i) => prompt('b', m, `now change line ${i}`))];
    expect(types(ev, 11)).toEqual(expect.arrayContaining(['idle-wait', 'step-by-step']));
    expect(types(ev, 11, DEFAULT_SETTINGS, { weakest: 'judgment' })).toEqual([]);
    expect(types(ev, 11, DEFAULT_SETTINGS, { weakest: 'reuse' })).toEqual(expect.arrayContaining(['idle-wait', 'step-by-step']));
  });

  it('a tip type turned off, or How often set to Off, gives no candidates of it', () => {
    const ev = [prompt('a', 0, 'run the full test suite and fix failures'), turn('a', 5, 300_000), { ...prompt('a', 5, 'looks good'), at: at(5, 4) }];
    expect(types(ev, 6)).toEqual(expect.arrayContaining(['idle-wait', 'fast-approve']));
    expect(types(ev, 6, withDefaults({ tipTypes: { thinkBigger: false } }))).toEqual(['fast-approve']);
    expect(types(ev, 6, withDefaults({ tipTypes: { prompt: false } }))).toEqual(['idle-wait']);
    expect(types(ev, 6, withDefaults({ howOften: 'off' }))).toEqual([]);
  });

  it('events from a left-alone project or a non-user source produce no candidate', () => {
    const leave = withDefaults({ leaveAlone: ['s1'] });
    const ev = [prompt('a', 0, 'run the full test suite and fix failures'), turn('a', 5, 300_000), ...[6, 7, 8, 9, 10].map((m, i) => prompt('b', m, `now change line ${i}`))];
    expect(types(ev, 11, leave)).toEqual([]);
    // Folded without the setting (an older state), the detector still drops the project.
    expect(detect(fold(ev), leave, new Date(T0 + 11 * 60_000))).toEqual([]);
    const fromPeers = [0, 1, 2, 3, 4].map((m, i) => prompt('b', m, `now change line ${i}`, { source: 'thread' }));
    const fromDaemon = [0, 1, 2].map((m) => prompt(`t${m}`, m, 'Summarize the pipeline report', { source: 'daemon' }));
    expect(types([...fromPeers, ...fromDaemon], 6)).toEqual([]);
  });
});

describe('Coach worker: candidates are proposed once (coach plan Task 8)', () => {
  const c = (id: string) => ({ id, type: 'idle-wait' as const, measure: 'delegation' as const, tip: 'thinkBigger' as const, terminalId: 't', projectId: 's1', evidence: {} });
  it('a new candidate joins the list with its time; one seen before is not proposed again, even after it left the list', () => {
    const now = new Date('2026-11-07T10:00:00Z');
    let doc = proposeNew({ items: [], seen: [] }, [c('a'), c('b')], now);
    expect(doc.added.map((x) => x.id)).toEqual(['a', 'b']);
    expect(doc.items[0]).toMatchObject({ id: 'a', at: now.toISOString() });
    doc = proposeNew({ items: [], seen: doc.seen }, [c('a'), c('c')], now);
    expect(doc.added.map((x) => x.id)).toEqual(['c']);
  });
  it('the list and the seen ids are capped', () => {
    const many = Array.from({ length: 80 }, (_, i) => c(`x${i}`));
    const doc = proposeNew(null, many, new Date());
    expect(doc.items.length).toBe(50);
    expect(doc.items[49].id).toBe('x79');
    expect(doc.seen.length).toBe(80);
  });
});
