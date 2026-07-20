import { expect, test } from 'vitest';
import { sortThreads, sortAgents, THREAD_SORTS, AGENT_SORTS, DEFAULT_THREAD_SORT, DEFAULT_AGENT_SORT } from './listSort';

function th(over: Record<string, unknown>) {
  return { id: 'x', label: 'thread', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', sortOrder: 0, ...over } as any;
}
function ag(over: Record<string, unknown>) {
  return { id: 'x', name: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nextRunAt: null, ...over } as any;
}
const ids = (a: { id: string }[]) => a.map((x) => x.id);

test('option lists carry the exact labels and defaults', () => {
  expect(THREAD_SORTS.map(([v]) => v)).toEqual(['needs', 'active', 'newest', 'oldest', 'name', 'custom']);
  expect(THREAD_SORTS.find(([v]) => v === 'name')![1]).toBe('Name (A–Z)');
  expect(AGENT_SORTS.map(([v]) => v)).toEqual(['next', 'updated', 'newest', 'oldest', 'name']);
  expect(DEFAULT_THREAD_SORT).toBe('custom');
  expect(DEFAULT_AGENT_SORT).toBe('next');
});

test('does not mutate the input array', () => {
  const input = [th({ id: 'b', label: 'b' }), th({ id: 'a', label: 'a' })];
  const snapshot = ids(input);
  sortThreads(input, 'name');
  expect(ids(input)).toEqual(snapshot);
});

test('newest and oldest order by createdAt in opposite directions', () => {
  const items = [
    th({ id: 'mid', createdAt: '2026-02-01T00:00:00.000Z' }),
    th({ id: 'new', createdAt: '2026-03-01T00:00:00.000Z' }),
    th({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
  ];
  expect(ids(sortThreads(items, 'newest'))).toEqual(['new', 'mid', 'old']);
  expect(ids(sortThreads(items, 'oldest'))).toEqual(['old', 'mid', 'new']);
});

test('recently active uses lastActivityAt, falling back to createdAt when absent', () => {
  const items = [
    th({ id: 'stale', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-02T00:00:00.000Z' }),
    th({ id: 'nofield', createdAt: '2026-05-01T00:00:00.000Z' }),           // no lastActivityAt at all
    th({ id: 'fresh', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-06-01T00:00:00.000Z' }),
  ];
  expect(ids(sortThreads(items, 'active'))).toEqual(['fresh', 'nofield', 'stale']);
});

test('needs you first pins needs_input, then orders the rest by activity', () => {
  const items = [
    th({ id: 'busy', status: 'working', lastActivityAt: '2026-06-01T00:00:00.000Z' }),
    th({ id: 'ask1', status: 'needs_input', lastActivityAt: '2026-01-01T00:00:00.000Z' }),
    th({ id: 'quiet', status: 'idle', lastActivityAt: '2026-02-01T00:00:00.000Z' }),
    th({ id: 'ask2', status: 'needs_input', lastActivityAt: '2026-05-01T00:00:00.000Z' }),
  ];
  expect(ids(sortThreads(items, 'needs'))).toEqual(['ask2', 'ask1', 'busy', 'quiet']);
});

test('name sorts case-insensitively and treats digits numerically', () => {
  const items = [th({ id: 'i10', label: 'item10' }), th({ id: 'i2', label: 'item2' }), th({ id: 'A', label: 'apple' })];
  expect(ids(sortThreads(items, 'name'))).toEqual(['A', 'i2', 'i10']);
});

test('custom preserves incoming array order even when sortOrder disagrees', () => {
  // "Custom" means the arrangement already in the array — the daemon returns
  // ORDER BY sort_order ASC, created_at ASC, and useTabs.reorder() maintains
  // array order optimistically on drop without rewriting the sortOrder field.
  // Re-deriving order from that field would ignore the optimistic update and
  // snap a just-dropped row back until the next refetch (the Finding 1 bug).
  const items = [th({ id: 'c', sortOrder: 2 }), th({ id: 'a', sortOrder: 0 }), th({ id: 'b', sortOrder: 1 })];
  expect(ids(sortThreads(items, 'custom'))).toEqual(['c', 'a', 'b']);
});

test('custom preserves array order regardless of createdAt', () => {
  const items = [
    th({ id: 'third', sortOrder: 0, createdAt: '2026-03-01T00:00:00.000Z' }),
    th({ id: 'first', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    th({ id: 'second', sortOrder: 0, createdAt: '2026-02-01T00:00:00.000Z' }),
  ];
  expect(ids(sortThreads(items, 'custom'))).toEqual(['third', 'first', 'second']);
});

test('unparseable and missing dates do not produce NaN comparisons', () => {
  const items = [
    th({ id: 'good', createdAt: '2026-03-01T00:00:00.000Z' }),
    th({ id: 'junk', createdAt: 'not-a-date' }),
    th({ id: 'empty', createdAt: '' }),
  ];
  const out = ids(sortThreads(items, 'newest'));
  expect(out).toHaveLength(3);
  expect(out[0]).toBe('good');                    // real date wins
  expect(out.slice(1).sort()).toEqual(['empty', 'junk']);   // unparseable sink, order between them stable
});

test('ties break deterministically by id', () => {
  const same = { createdAt: '2026-01-01T00:00:00.000Z', label: 'same' };
  const items = [th({ id: 'c', ...same }), th({ id: 'a', ...same }), th({ id: 'b', ...same })];
  expect(ids(sortThreads(items, 'newest'))).toEqual(['a', 'b', 'c']);
  expect(ids(sortThreads(items, 'name'))).toEqual(['a', 'b', 'c']);
});

test('agents: next run sorts ascending with nulls last', () => {
  const items = [
    ag({ id: 'off', nextRunAt: null }),
    ag({ id: 'later', nextRunAt: '2026-08-01T00:00:00.000Z' }),
    ag({ id: 'soon', nextRunAt: '2026-07-21T00:00:00.000Z' }),
  ];
  expect(ids(sortAgents(items, 'next'))).toEqual(['soon', 'later', 'off']);
});

test('agents: recently updated, newest, oldest, and name', () => {
  const items = [
    ag({ id: 'b', name: 'beta', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ag({ id: 'a', name: 'Alpha', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }),
  ];
  expect(ids(sortAgents(items, 'updated'))).toEqual(['a', 'b']);
  expect(ids(sortAgents(items, 'newest'))).toEqual(['a', 'b']);
  expect(ids(sortAgents(items, 'oldest'))).toEqual(['b', 'a']);
  expect(ids(sortAgents(items, 'name'))).toEqual(['a', 'b']);
});

test('agents: does not mutate the input array', () => {
  const input = [ag({ id: 'b', name: 'b' }), ag({ id: 'a', name: 'a' })];
  const snapshot = ids(input);
  sortAgents(input, 'name');
  expect(ids(input)).toEqual(snapshot);
});
