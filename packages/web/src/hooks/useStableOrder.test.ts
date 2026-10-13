import { expect, test } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStableOrder } from './useStableOrder';

type P = { id: string; name: string; lastActivityAt?: string; updatedAt?: string };
const p = (id: string, at: string, name = id): P => ({ id, name, lastActivityAt: at });
const ids = (l: P[]) => l.map((x) => x.id);

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('recent: alternating lastActivityAt does not swap two projects', () => {
  const { result, rerender } = renderHook(({ l }) => useStableOrder(l, 'recent'), {
    initialProps: { l: [p('a', '2026-01-02'), p('b', '2026-01-01')] },
  });
  expect(ids(result.current)).toEqual(['a', 'b']);
  rerender({ l: [p('a', '2026-01-02'), p('b', '2026-01-03')] });
  expect(ids(result.current)).toEqual(['a', 'b']);
  rerender({ l: [p('a', '2026-01-04'), p('b', '2026-01-03')] });
  expect(ids(result.current)).toEqual(['a', 'b']);
  // content still live
  expect(result.current[0].lastActivityAt).toBe('2026-01-04');
});

test('recent: an added project goes on top, others keep order', () => {
  const { result, rerender } = renderHook(({ l }) => useStableOrder(l, 'recent'), {
    initialProps: { l: [p('a', '2026-01-03'), p('b', '2026-01-02'), p('c', '2026-01-01')] },
  });
  // c became the most recent but must not move
  rerender({ l: [p('a', '2026-01-03'), p('b', '2026-01-02'), p('c', '2026-01-09')] });
  expect(ids(result.current)).toEqual(['a', 'b', 'c']);
  rerender({ l: [p('a', '2026-01-03'), p('b', '2026-01-02'), p('c', '2026-01-09'), p('d', '2020-01-01')] });
  expect(ids(result.current)).toEqual(['d', 'a', 'b', 'c']);
});

test('recent: a removed project drops out, others keep order', () => {
  const { result, rerender } = renderHook(({ l }) => useStableOrder(l, 'recent'), {
    initialProps: { l: [p('a', '2026-01-03'), p('b', '2026-01-02'), p('c', '2026-01-01')] },
  });
  rerender({ l: [p('a', '2026-01-01'), p('c', '2026-01-05')] });
  expect(ids(result.current)).toEqual(['a', 'c']);
});

test('changing sort re-sorts', () => {
  const { result, rerender } = renderHook(({ l, s }) => useStableOrder(l, s), {
    initialProps: { l: [p('a', '2026-01-02'), p('b', '2026-01-01')], s: 'recent' as 'recent' | 'alpha' | 'custom' },
  });
  rerender({ l: [p('a', '2026-01-02'), p('b', '2026-01-05')], s: 'recent' });
  expect(ids(result.current)).toEqual(['a', 'b']);
  rerender({ l: [p('a', '2026-01-02'), p('b', '2026-01-05')], s: 'custom' });
  expect(ids(result.current)).toEqual(['a', 'b']);
  rerender({ l: [p('a', '2026-01-02'), p('b', '2026-01-05')], s: 'recent' });
  expect(ids(result.current)).toEqual(['b', 'a']);
});

test('visibilitychange to visible re-sorts; hidden does not', () => {
  const { result, rerender } = renderHook(({ l }) => useStableOrder(l, 'recent'), {
    initialProps: { l: [p('a', '2026-01-02'), p('b', '2026-01-01')] },
  });
  rerender({ l: [p('a', '2026-01-02'), p('b', '2026-01-05')] });
  expect(ids(result.current)).toEqual(['a', 'b']);
  act(() => setVisibility('hidden'));
  expect(ids(result.current)).toEqual(['a', 'b']);
  act(() => setVisibility('visible'));
  expect(ids(result.current)).toEqual(['b', 'a']);
});

test('alpha sorts by name every render', () => {
  const { result, rerender } = renderHook(({ l }) => useStableOrder(l, 'alpha'), {
    initialProps: { l: [p('1', '2026-01-01', 'bob'), p('2', '2026-01-01', 'amy')] },
  });
  expect(ids(result.current)).toEqual(['2', '1']);
  rerender({ l: [p('1', '2026-01-01', 'abe'), p('2', '2026-01-01', 'amy')] });
  expect(ids(result.current)).toEqual(['1', '2']);
});

test('custom preserves the server order', () => {
  const { result, rerender } = renderHook(({ l }) => useStableOrder(l, 'custom'), {
    initialProps: { l: [p('b', '2026-01-01'), p('a', '2026-01-09')] },
  });
  expect(ids(result.current)).toEqual(['b', 'a']);
  rerender({ l: [p('a', '2026-01-09'), p('b', '2026-01-01')] });
  expect(ids(result.current)).toEqual(['a', 'b']);
});
