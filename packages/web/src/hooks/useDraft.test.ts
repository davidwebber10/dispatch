import { renderHook, act } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { appendToStoredDraft, useDraft } from './useDraft';

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

// Pinned card spec 2026-10-08, Unit 8: a card click appends to a project's draft from outside.
test('appendToStoredDraft adds ", " and the text to an existing draft, never replacing it', () => {
  expect(appendToStoredDraft('p1', 'N17: A')).toBe('N17: A');
  expect(appendToStoredDraft('p1', 'N34: approve')).toBe('N17: A, N34: approve');
  localStorage.setItem('dispatch:draft:p2', 'also check the logs \n');
  expect(appendToStoredDraft('p2', 'N55: done')).toBe('also check the logs, N55: done');
  expect(localStorage.getItem('dispatch:draft:p2')).toBe('also check the logs, N55: done');
});

test('a mounted useDraft shows an append made from outside; another id is untouched', () => {
  const { result } = renderHook(() => useDraft('p1'));
  const other = renderHook(() => useDraft('p2'));
  act(() => result.current[1]('typed'));
  act(() => { appendToStoredDraft('p1', 'N17: A'); });
  expect(result.current[0]).toBe('typed, N17: A');
  expect(other.result.current[0]).toBe('');
});
