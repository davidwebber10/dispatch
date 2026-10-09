import { describe, it, expect } from 'vitest';
import { answerText, formatCardSource, openDecisionCount, outcomeText, sourceTarget } from './ledger';
import { FIXTURE, EMPTY_CARD, N12, N14, cardItem } from './ledger-fixture';

describe('openDecisionCount', () => {
  it('counts the open decisions that need the user now (cards and lines)', () => {
    expect(openDecisionCount(FIXTURE)).toBe(3);
    expect(openDecisionCount(EMPTY_CARD)).toBe(0);
    expect(openDecisionCount(null)).toBe(0);
  });
});

describe('formatCardSource — plan · file name › section · plan ID', () => {
  it('each source kind', () => {
    expect(formatCardSource(N14.source!)).toBe('plan · readiness.md › Owner decisions · LR-6 · from agent "Readiness planner"');
    expect(formatCardSource(N12.source!)).toBe('PR #62');
    expect(formatCardSource({ kind: 'plan', ref: 'docs/plans/a.md', path: null, section: 'Risks', id: 'D3', url: null })).toBe('plan · a.md › Risks · D3');
    expect(formatCardSource({ kind: 'doc', ref: 'docs/notes.md', path: null, section: null, id: null, url: null })).toBe('doc · notes.md');
    expect(formatCardSource({ kind: 'agent', ref: 'Map researcher', path: 'docs/research/map.md', section: null, id: 'Q2', url: null })).toBe('doc · map.md · Q2 · from agent "Map researcher"');
    expect(formatCardSource({ kind: 'agent', ref: 'Map researcher', path: null, section: 'Q2 part', id: null, url: null })).toBe('agent "Map researcher" › Q2 part');
    expect(formatCardSource({ kind: 'thread', ref: 'Scratch', path: null, section: null, id: null, url: null })).toBe('your thread "Scratch"');
    expect(formatCardSource({ kind: 'issue', ref: '#7', path: null, section: null, id: null, url: null })).toBe('issue #7');
    expect(formatCardSource({ kind: 'user', ref: 'switch to live mode soon', path: null, section: null, id: null, url: null })).toBe('your words "switch to live mode soon"');
    expect(formatCardSource({ kind: 'overseer', ref: null, path: null, section: null, id: null, url: null })).toBe('overseer');
  });

  it('a long path shows only its file name, for / and \\ separators; a ref without a separator stays as is', () => {
    const plan = '.claude/worktrees/some-plan/docs/superpowers/plans/2026-10-01-some-plan.md';
    expect(formatCardSource({ kind: 'plan', ref: plan, path: null, section: 'Open owner decisions after v3', id: null, url: null }))
      .toBe('plan · 2026-10-01-some-plan.md › Open owner decisions after v3');
    expect(formatCardSource({ kind: 'doc', ref: 'docs\\notes\\setup.md', path: null, section: null, id: 'S2', url: null })).toBe('doc · setup.md · S2');
    expect(formatCardSource({ kind: 'agent', ref: 'Planner', path: 'docs\\plans\\b.md', section: 'Risks', id: null, url: null })).toBe('plan · b.md › Risks · from agent "Planner"');
    expect(formatCardSource({ kind: 'plan', ref: 'roadmap.md', path: null, section: null, id: null, url: null })).toBe('plan · roadmap.md');
  });

  it('full: the unshortened source, for the hover text', () => {
    expect(formatCardSource(N14.source!, { full: true })).toBe('plan · docs/plans/readiness.md › Owner decisions · LR-6 · from agent "Readiness planner"');
    expect(formatCardSource({ kind: 'doc', ref: 'docs\\notes\\setup.md', path: null, section: null, id: null, url: null }, { full: true })).toBe('doc · docs\\notes\\setup.md');
    expect(formatCardSource(N12.source!, { full: true })).toBe('PR #62');
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

// Titles and source panel spec 2026-10-09, Unit 10.
describe('sourceTarget — what a click on a Source line does', () => {
  const src = (over: Partial<Parameters<typeof sourceTarget>[0]>) =>
    sourceTarget({ kind: 'plan', ref: null, path: null, section: null, id: null, url: null, ...over });
  it('the panel for a plan, a doc and an agent-block item with a file; a link for a PR or issue with an https link; else nothing', () => {
    expect(src({ kind: 'plan', ref: 'docs/plans/a.md' })).toBe('panel');
    expect(src({ kind: 'doc', ref: 'docs/notes.md' })).toBe('panel');
    expect(src({ kind: 'agent', ref: 'Readiness planner', path: 'docs/plans/r.md' })).toBe('panel');
    expect(src({ kind: 'agent', ref: 'Readiness planner' })).toBeNull();
    expect(src({ kind: 'pr', ref: '#62', url: 'https://github.com/owner/repo/pull/62' })).toBe('link');
    expect(src({ kind: 'issue', ref: '#7', url: 'https://github.com/owner/repo/issues/7' })).toBe('link');
    expect(src({ kind: 'pr', ref: '#62' })).toBeNull();
    expect(src({ kind: 'pr', ref: '#62', url: 'javascript:alert(1)' })).toBeNull();
    expect(src({ kind: 'overseer' })).toBeNull();
    expect(src({ kind: 'thread', ref: 'Scratch' })).toBeNull();
  });
});
