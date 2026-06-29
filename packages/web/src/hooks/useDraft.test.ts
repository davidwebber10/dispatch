import { renderHook, act } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { useDraft } from './useDraft';

beforeEach(() => localStorage.clear());

test('persists to localStorage and restores on a fresh mount (survives reload)', () => {
  const { result, unmount } = renderHook(() => useDraft('t1'));
  act(() => result.current[1]('half-typed message'));
  expect(localStorage.getItem('dispatch:draft:t1')).toBe('half-typed message');
  unmount(); // simulate the PWA reload/remount on resume
  const { result: r2 } = renderHook(() => useDraft('t1'));
  expect(r2.current[0]).toBe('half-typed message');
});

test('clear() removes the draft and resets the value', () => {
  const { result } = renderHook(() => useDraft('t2'));
  act(() => result.current[1]('x'));
  act(() => result.current[2]());
  expect(result.current[0]).toBe('');
  expect(localStorage.getItem('dispatch:draft:t2')).toBeNull();
});

test('setting empty removes the key (no stale empty drafts)', () => {
  const { result } = renderHook(() => useDraft('t3'));
  act(() => result.current[1]('y'));
  act(() => result.current[1](''));
  expect(localStorage.getItem('dispatch:draft:t3')).toBeNull();
});

test('drafts are isolated per id', () => {
  localStorage.setItem('dispatch:draft:a', 'A draft');
  const { result } = renderHook(() => useDraft('b'));
  expect(result.current[0]).toBe('');
});
