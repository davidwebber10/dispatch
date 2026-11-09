import { describe, it, expect } from 'vitest';
import { attentionList, nextAttention, type AttentionItem } from './attention';
import type { Terminal } from '../api/types';

const term = (id: string, over: Partial<Terminal> = {}): Terminal => ({
  id, sessionId: 'p1', type: 'claude-code', label: id.toUpperCase(), pid: null, externalId: null, workingDir: null,
  status: 'waiting', createdAt: '2026-11-01T00:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0, ...over,
} as Terminal);
const at = (min: number) => new Date(Date.UTC(2026, 10, 9, 10, min)).toISOString();

describe('attentionList', () => {
  it('orders needs input before error before stalled', () => {
    const byProject = {
      p1: [term('stalled', { status: 'working', lastActivityAt: at(0) }), term('err', { status: 'error', lastActivityAt: at(1) })],
      p2: [term('ask', { sessionId: 'p2', status: 'needs_input', lastActivityAt: at(2) }), term('idle', { sessionId: 'p2' }), term('busy', { sessionId: 'p2', status: 'working' })],
    };
    const list = attentionList({ byProject, status: {}, stalls: { stalled: Date.parse(at(0)) } });
    expect(list.map((i) => [i.terminalId, i.reason, i.projectId])).toEqual([['ask', 'needs_input', 'p2'], ['err', 'error', 'p1'], ['stalled', 'stalled', 'p1']]);
    expect(list[0]).toEqual({ terminalId: 'ask', projectId: 'p2', label: 'ASK', reason: 'needs_input', since: Date.parse(at(2)) });
    expect(list[2].since).toBe(Date.parse(at(0)));
  });

  it('oldest first in a group', () => {
    const byProject = { p1: [
      term('n-new', { status: 'needs_input', lastActivityAt: at(30) }),
      term('n-old', { status: 'needs_input', lastActivityAt: at(5) }),
      term('n-mid', { status: 'needs_input', lastActivityAt: at(10) }),
      term('e-new', { status: 'error', lastActivityAt: at(20) }),
      term('e-old', { status: 'error', lastActivityAt: at(1) }),
    ] };
    expect(attentionList({ byProject, status: {}, stalls: {} }).map((i) => i.terminalId)).toEqual(['n-old', 'n-mid', 'n-new', 'e-old', 'e-new']);
  });

  it('an archived thread is not listed', () => {
    const byProject = { p1: [term('gone', { status: 'needs_input', archivedAt: at(0) }), term('here', { status: 'needs_input' })] };
    expect(attentionList({ byProject, status: {}, stalls: { gone: 1 } }).map((i) => i.terminalId)).toEqual(['here']);
  });

  it('a file tab, a browser tab and the coordinator are not listed', () => {
    const byProject = { p1: [
      term('f', { type: 'file', status: 'needs_input' } as Partial<Terminal>),
      term('b', { type: 'browser', status: 'error' } as Partial<Terminal>),
      term('c', { status: 'needs_input', config: { role: 'coordinator' } }),
    ] };
    expect(attentionList({ byProject, status: {}, stalls: {} })).toEqual([]);
  });

  it('the live status wins over the stored row, in both directions', () => {
    const byProject = { p1: [term('a', { status: 'needs_input' }), term('b', { status: 'waiting' })] };
    const list = attentionList({ byProject, status: { a: { status: 'working', threadStatus: 'working' }, b: { status: 'needs_input' } }, stalls: {} });
    expect(list.map((i) => i.terminalId)).toEqual(['b']);
  });

  it('a stall flag counts only while the thread works, and a thread is listed once', () => {
    const byProject = { p1: [term('idle', { status: 'waiting' }), term('ask', { status: 'needs_input' }), term('busy', { status: 'working' })] };
    const list = attentionList({ byProject, status: {}, stalls: { idle: 5, ask: 5, busy: 7 } });
    expect(list.map((i) => [i.terminalId, i.reason])).toEqual([['ask', 'needs_input'], ['busy', 'stalled']]);
  });

  it('a thread with no activity time uses its creation time', () => {
    const byProject = { p1: [term('a', { status: 'error', createdAt: at(3) })] };
    expect(attentionList({ byProject, status: {}, stalls: {} })[0].since).toBe(Date.parse(at(3)));
  });
});

describe('nextAttention', () => {
  const items = ['a', 'b', 'c'].map((id) => ({ terminalId: id, projectId: 'p', label: id, reason: 'needs_input', since: 0 }) as AttentionItem);
  it('gives the first item when the open thread is not in the list', () => {
    expect(nextAttention(items, null)?.terminalId).toBe('a');
    expect(nextAttention(items, 'zzz')?.terminalId).toBe('a');
  });
  it('gives the item after the open thread, and wraps to the first', () => {
    expect(nextAttention(items, 'a')?.terminalId).toBe('b');
    expect(nextAttention(items, 'c')?.terminalId).toBe('a');
  });
  it('gives nothing for an empty list, and nothing when the open thread is the only item', () => {
    expect(nextAttention([], 'a')).toBeNull();
    expect(nextAttention(items.slice(0, 1), 'a')).toBeNull();
  });
});
