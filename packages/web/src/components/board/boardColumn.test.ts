import { describe, it, expect } from 'vitest';
import { boardColumn } from './boardColumn';

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
