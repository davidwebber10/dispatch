import { describe, it, expect } from 'vitest';
import { answerText, formatCardSource, openDecisionCount, outcomeText } from './ledger';
import { FIXTURE, EMPTY_CARD, N12, N14, cardItem } from './ledger-fixture';

describe('openDecisionCount', () => {
  it('counts the open decisions that need the user now (cards and lines)', () => {
    expect(openDecisionCount(FIXTURE)).toBe(3);
    expect(openDecisionCount(EMPTY_CARD)).toBe(0);
    expect(openDecisionCount(null)).toBe(0);
  });
});

describe('formatCardSource — plan · path › section · plan ID', () => {
  it('each source kind', () => {
    expect(formatCardSource(N14.source!)).toBe('plan · docs/plans/readiness.md › Owner decisions · LR-6 · from agent "Readiness planner"');
    expect(formatCardSource(N12.source!)).toBe('PR #62');
    expect(formatCardSource({ kind: 'plan', ref: 'docs/plans/a.md', path: null, section: 'Risks', id: 'D3' })).toBe('plan · docs/plans/a.md › Risks · D3');
    expect(formatCardSource({ kind: 'doc', ref: 'docs/notes.md', path: null, section: null, id: null })).toBe('doc · docs/notes.md');
    expect(formatCardSource({ kind: 'agent', ref: 'Map researcher', path: 'docs/research/map.md', section: null, id: 'Q2' })).toBe('doc · docs/research/map.md · Q2 · from agent "Map researcher"');
    expect(formatCardSource({ kind: 'agent', ref: 'Map researcher', path: null, section: 'Q2 part', id: null })).toBe('agent "Map researcher" › Q2 part');
    expect(formatCardSource({ kind: 'thread', ref: 'Scratch', path: null, section: null, id: null })).toBe('your thread "Scratch"');
    expect(formatCardSource({ kind: 'issue', ref: '#7', path: null, section: null, id: null })).toBe('issue #7');
    expect(formatCardSource({ kind: 'user', ref: 'switch to live mode soon', path: null, section: null, id: null })).toBe('your words "switch to live mode soon"');
    expect(formatCardSource({ kind: 'overseer', ref: null, path: null, section: null, id: null })).toBe('overseer');
  });
});

describe('answerText — what a click adds to the message box', () => {
  it('a decide option adds its answerKey; a go item approve; a do item done', () => {
    expect(answerText(N14, N14.options[0])).toBe('N14: A');
    expect(answerText(N14, N14.options[1])).toBe('N14: B');
    expect(answerText(N12)).toBe('N12: approve');
    expect(answerText(cardItem({ seq: 55, kind: 'do', text: 'Check staging.' }))).toBe('N55: done');
  });
});

describe('outcomeText — what happened to an item', () => {
  it('each status', () => {
    expect(outcomeText(N14)).toBeNull();
    expect(outcomeText(cardItem({ default: 'abort above 1%.', onDefaultSince: '2026-10-01T09:00:00.000Z' }))).toMatch(/^Running on the default "abort above 1%" since \S+ \d+$/);
    expect(outcomeText(cardItem({ status: 'answered', quote: 'N3: A' }))).toBe('Your answer: "N3: A"');
    expect(outcomeText(cardItem({ status: 'answered', choice: 'Monday', quote: 'reverse N8, use Tuesday' }))).toBe('You reversed the overseer\'s choice "Monday": "reverse N8, use Tuesday"');
    expect(outcomeText(cardItem({ status: 'answered', origin: 'imported' }))).toBe('Imported, not checked');
    expect(outcomeText(cardItem({ kind: 'statement', status: 'answered', quote: 'never deploy on Fridays' }))).toBe('Noted');
    expect(outcomeText(cardItem({ status: 'parked', quote: 'later' }))).toBe('Parked: "later"');
    expect(outcomeText(cardItem({ status: 'withdrawn', reason: 'moot' }))).toBe('Withdrawn: moot');
    expect(outcomeText(cardItem({ status: 'decided_by_overseer', choice: 'the existing one' }))).toBe('Decided by overseer: the existing one');
    // Review round 1: the overseer's own reason sits next to its choice.
    expect(outcomeText(cardItem({ status: 'decided_by_overseer', choice: 'the existing one.', reason: 'it covers this case' })))
      .toBe('Decided by overseer: the existing one. Reason: it covers this case');
    expect(outcomeText(cardItem({ status: 'superseded' }))).toBe('Superseded');
    expect(outcomeText(cardItem({ status: 'proposed' }))).toBe('Not yet triaged');
  });
});
