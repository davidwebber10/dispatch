import { describe, it, expect } from 'vitest';
import { boardColumn, toBoardCard } from './boardColumn';

const t = (config: any = {}, status = 'waiting') => ({ id: 'x', status, config, archivedAt: null } as any);

describe('boardColumn', () => {
  it('needs_input lands in needs help', () => {
    expect(boardColumn(t({}, 'needs_input'))).toBe('needs_help');
  });

  it('a live turn is working', () => {
    expect(boardColumn(t({}, 'working'))).toBe('working');
  });

  it('queued and scheduled are working — they proceed without you', () => {
    expect(boardColumn(t({}, 'queued'))).toBe('working');
    expect(boardColumn(t({}, 'scheduled'))).toBe('working');
  });

  it('a finished, unacknowledged turn is complete', () => {
    expect(boardColumn(t({ lastOutcome: { summary: 'merged', needsHelp: false, inferred: false } }, 'waiting'))).toBe('complete');
  });

  // The regression that motivated this whole fix: before core carried `declaredState`, a
  // declared `blocked` outcome and a genuinely finished `done` outcome were BOTH just "idle,
  // inferred: false" on the wire — indistinguishable — so a thread waiting on another agent
  // filed as Complete, reading as finished work when it was actually queued behind something.
  it('a declared blocked outcome is Working, pending — NOT Complete', () => {
    const term = t(
      { lastOutcome: { summary: 'x', needsHelp: false, inferred: false, declaredState: 'blocked', blocker: 'Sync SKU catalog' } },
      'waiting'
    );
    expect(boardColumn(term)).toBe('working');
    expect(boardColumn(term)).not.toBe('complete');
    const card = toBoardCard(term, 'p1', 'proj');
    expect(card.column).toBe('working');
    expect(card.pending).toBe(true);
  });

  it('a declared done outcome still maps to complete', () => {
    expect(
      boardColumn(t({ lastOutcome: { summary: 'merged', needsHelp: false, inferred: false, declaredState: 'done' } }, 'waiting'))
    ).toBe('complete');
  });

  it('an outcome with no declaredState (an old row) maps exactly as it did before — no behaviour change for existing data', () => {
    const oldRow = t({ lastOutcome: { summary: 'merged', needsHelp: false, inferred: false } }, 'waiting');
    expect(boardColumn(oldRow)).toBe('complete');
    expect(toBoardCard(oldRow, 'p1', 'proj').pending).toBe(false);
  });

  it('acknowledging a finished turn moves it to resting', () => {
    expect(boardColumn(t({ lastOutcome: { summary: 'merged' }, boardState: { acknowledgedAt: '2026-07-20T00:00:00Z' } }, 'waiting'))).toBe('resting');
  });

  it('a thread that never ran a turn is resting, not complete', () => {
    expect(boardColumn(t({}, 'waiting'))).toBe('resting');
  });

  it('an archived thread is resting', () => {
    expect(boardColumn({ ...t(), archivedAt: '2026-01-01' } as any)).toBe('resting');
  });

  it('a manual override wins over the derived column', () => {
    expect(boardColumn(t({ boardState: { override: 'needs_help' } }, 'waiting'))).toBe('needs_help');
  });

  it('live status beats the persisted row', () => {
    expect(boardColumn(t({}, 'waiting'), { status: 'working', threadStatus: 'working' } as any)).toBe('working');
  });
});
