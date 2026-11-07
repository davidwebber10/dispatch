import { describe, it, expect } from 'vitest';
import { emptyMemory, applyFeedback, confirmFact, editFact, removeItem, allows, factsToReconfirm, dueForReview, reviewMuted, resetMemory, stripExcerpts, memoryItems, REASONS } from '../../../plugins/coach/lib/memory.mjs';

const NOW = new Date('2026-11-20T11:00:00Z');
const DAY = 86400_000;
const fb = (reason: string, over: Record<string, unknown> = {}) => ({ cardType: 'repeated-prompt', measure: 'reuse', reason, ...over });
const cand = (type = 'repeated-prompt', id = `${type}:abc`) => ({ id, type });

describe('Coach memory: feedback with one exact effect (coach plan Task 11)', () => {
  it('the reasons are the six chips', () => {
    expect(Object.values(REASONS)).toEqual(['I already do this', 'Not relevant to my work', 'Too basic', 'Too advanced', 'Wrong about what I did', 'Not now']);
  });

  it('I already do this marks the skill known: no more tips on it', () => {
    const r = applyFeedback(emptyMemory(), fb('already'), NOW);
    expect(r.memory.known).toEqual(['repeated-prompt']);
    expect(r.effect).toMatch(/No more tips on this/);
    expect(allows(r.memory, cand(), NOW)).toBe(false);
    expect(allows(r.memory, cand('idle-wait'), NOW)).toBe(true);
  });

  it('Not relevant to my work suppresses this tip type', () => {
    const r = applyFeedback(emptyMemory(), fb('not-relevant'), NOW);
    expect(r.memory.muted).toEqual([{ type: 'repeated-prompt', until: null, reason: 'not-relevant', at: NOW.toISOString() }]);
    expect(allows(r.memory, cand(), NOW)).toBe(false);
  });

  it('Too basic raises the level for the measure; Too advanced lowers it', () => {
    let m = applyFeedback(emptyMemory(), fb('too-basic'), NOW).memory;
    expect(m.levelAdjust.reuse).toBe(1);
    m = applyFeedback(m, fb('too-advanced'), NOW).memory;
    m = applyFeedback(m, fb('too-advanced'), NOW).memory;
    expect(m.levelAdjust.reuse).toBe(-1);
    expect(applyFeedback(emptyMemory(), fb('too-basic'), NOW).effect).toMatch(/aim higher/);
  });

  it('Wrong about what I did marks the detection bad for that situation only', () => {
    const r = applyFeedback(emptyMemory(), fb('wrong', { situation: 'repeated-prompt:abc' }), NOW);
    expect(r.memory.bad).toEqual([{ type: 'repeated-prompt', situation: 'repeated-prompt:abc', at: NOW.toISOString() }]);
    expect(allows(r.memory, cand('repeated-prompt', 'repeated-prompt:abc'), NOW)).toBe(false);
    expect(allows(r.memory, cand('repeated-prompt', 'repeated-prompt:xyz'), NOW)).toBe(true);
  });

  it("'not-now' is a rest only: the memory does not change", () => {
    const before = emptyMemory();
    const r = applyFeedback(before, fb('not-now'), NOW);
    expect(r.memory).toEqual(before);
    expect(r.rest).toBe(true);
    expect(r.effect).toMatch(/Paused/);
  });

  it('one 👎 without a reason never mutes a whole type: it only lowers the weight, even five times', () => {
    let m = emptyMemory();
    for (let i = 0; i < 5; i++) m = applyFeedback(m, fb('down'), NOW).memory;
    expect(m.weights['repeated-prompt']).toBe(-5);
    expect(m.muted).toEqual([]);
    expect(m.known).toEqual([]);
    expect(allows(m, cand(), NOW)).toBe(true);
    expect(applyFeedback(emptyMemory(), fb('up'), NOW).memory.weights['repeated-prompt']).toBe(1);
  });

  it('Fewer tips like this lowers the weight; Turn off this type mutes it with that reason', () => {
    expect(applyFeedback(emptyMemory(), fb('fewer'), NOW).memory.weights['repeated-prompt']).toBe(-2);
    const off = applyFeedback(emptyMemory(), fb('off'), NOW);
    expect(off.memory.muted[0]).toMatchObject({ type: 'repeated-prompt', until: null, reason: 'off' });
    expect(off.effect).toMatch(/What the Coach knows/);
  });

  it('Undo restores the memory as it was', () => {
    const start = applyFeedback(emptyMemory(), fb('too-basic'), NOW).memory;
    const r = applyFeedback(start, fb('already'), NOW);
    expect(r.undo).toEqual(start);
    expect(r.memory).not.toEqual(start);
  });

  it('free text becomes a proposed fact; nothing is saved until it is confirmed', () => {
    const r = applyFeedback(emptyMemory(), fb('already', { text: '  Ops already sends it to me  ', headline: 'Make this a weekly routine' }), NOW);
    expect(r.memory.facts).toEqual([]);
    expect(r.proposedFact).toMatchObject({ text: 'Ops already sends it to me', source: 'Feedback on "Make this a weekly routine"', at: NOW.toISOString(), confirmedAt: null });
    const m = confirmFact(r.memory, r.proposedFact!, NOW);
    expect(m.facts).toEqual([{ ...r.proposedFact, confirmedAt: NOW.toISOString() }]);
    const edited = editFact(m, r.proposedFact!.id, 'Gets the pipeline report from Ops.', NOW);
    expect(edited.facts[0].text).toBe('Gets the pipeline report from Ops.');
    expect(applyFeedback(emptyMemory(), fb('down', { text: '   ' }), NOW).proposedFact).toBeUndefined();
  });

  it('facts older than 180 days are flagged for re-confirmation', () => {
    let m = confirmFact(emptyMemory(), { id: 'f1', text: 'Finance project', source: 'x', at: '2026-01-01T00:00:00Z', confirmedAt: null }, new Date(NOW.getTime() - 181 * DAY));
    m = confirmFact(m, { id: 'f2', text: 'Not a developer', source: 'x', at: '2026-01-01T00:00:00Z', confirmedAt: null }, new Date(NOW.getTime() - 10 * DAY));
    expect(factsToReconfirm(m, NOW).map((f) => f.id)).toEqual(['f1']);
    const again = confirmFact(m, m.facts[0], NOW);
    expect(factsToReconfirm(again, NOW)).toEqual([]);
    expect(again.facts).toHaveLength(2);
  });

  it('a muted type comes back once for review after 75 days', () => {
    const m = applyFeedback(emptyMemory(), fb('off'), new Date(NOW.getTime() - 74 * DAY)).memory;
    expect(dueForReview(m, NOW)).toEqual([]);
    expect(dueForReview(m, new Date(NOW.getTime() + DAY)).map((x) => x.type)).toEqual(['repeated-prompt']);
    const kept = reviewMuted(m, 'repeated-prompt', false, new Date(NOW.getTime() + DAY));
    expect(dueForReview(kept, new Date(NOW.getTime() + 200 * DAY))).toEqual([]);
    expect(allows(kept, cand(), NOW)).toBe(false);
    const shown = reviewMuted(m, 'repeated-prompt', true, new Date(NOW.getTime() + DAY));
    expect(shown.muted).toEqual([]);
    expect(allows(shown, cand(), NOW)).toBe(true);
  });

  it('every item is listed with its source and date, and each can be deleted', () => {
    let m = applyFeedback(emptyMemory(), fb('already'), NOW).memory;
    m = applyFeedback(m, fb('too-basic'), NOW).memory;
    m = applyFeedback(m, fb('off', { cardType: 'idle-wait', measure: 'delegation' }), NOW).memory;
    m = confirmFact(m, { id: 'f1', text: 'Finance project', source: 'Feedback on "X"', at: NOW.toISOString(), confirmedAt: null }, NOW);
    const items = memoryItems(m);
    expect(items.map((i) => [i.kind, i.key])).toEqual([['fact', 'f1'], ['known', 'repeated-prompt'], ['level', 'reuse'], ['muted', 'idle-wait']]);
    for (const i of items) { expect(i.label).toBeTruthy(); expect(i.source).toBeTruthy(); expect(i.at).toBeTruthy(); }
    let left = m;
    for (const i of items) left = removeItem(left, i.kind, i.key);
    expect(memoryItems(left)).toEqual([]);
  });

  it('Reset clears facts, known skills, levels, mutes and weights; the card history loses its excerpts', () => {
    expect(resetMemory()).toEqual(emptyMemory());
    const cards = { items: [{ id: 'a', excerpt: 'what I wrote', more: { wrote: 'what I wrote', better: 'b', bullets: [] }, headline: 'h' }] };
    const stripped = stripExcerpts(cards);
    expect(JSON.stringify(stripped)).not.toContain('what I wrote');
    expect(stripped.items[0]).toMatchObject({ id: 'a', headline: 'h', more: { better: 'b' } });
    const cands = { items: [{ id: 'c', evidence: { excerpt: 'what I wrote', count: 3 } }], seen: ['c'] };
    expect(JSON.stringify(stripExcerpts(cands))).not.toContain('what I wrote');
    expect(stripExcerpts(cands).seen).toEqual(['c']);
  });
});
