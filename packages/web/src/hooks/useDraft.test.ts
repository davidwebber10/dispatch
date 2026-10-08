import { renderHook, act } from '@testing-library/react';
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendToDraft, clearStoredDraft, forgetDraftMemory, useDraft } from './useDraft';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test('persists to localStorage and restores on a fresh mount (survives reload)', () => {
  const { result, unmount } = renderHook(() => useDraft('t1'));
  act(() => result.current[1]('half-typed message'));
  expect(localStorage.getItem('dispatch:draft:t1')).toBe('half-typed message');
  unmount(); // simulate the PWA reload/remount on resume
  forgetDraftMemory(); // a reload starts a fresh page: only local storage survives
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
test('appendToDraft adds ", " and the text to an existing draft, never replacing it', () => {
  expect(appendToDraft('p1', 'N17: A')).toBe('N17: A');
  expect(appendToDraft('p1', 'N34: approve')).toBe('N17: A, N34: approve');
  localStorage.setItem('dispatch:draft:p2', 'also check the logs \n');
  expect(appendToDraft('p2', 'N55: done')).toBe('also check the logs, N55: done');
  expect(localStorage.getItem('dispatch:draft:p2')).toBe('also check the logs, N55: done');
});

test('a mounted useDraft shows an append made from outside; another id is untouched', () => {
  const { result } = renderHook(() => useDraft('p1'));
  const other = renderHook(() => useDraft('p2'));
  act(() => result.current[1]('typed'));
  act(() => { appendToDraft('p1', 'N17: A'); });
  expect(result.current[0]).toBe('typed, N17: A');
  expect(other.result.current[0]).toBe('');
});

// Review round 1: storage is best-effort persistence only; the page's own draft is authoritative.
test('with a storage that throws, a card click appends to what the user typed', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  const { result } = renderHook(() => useDraft('p1'));
  act(() => result.current[1]('my own words'));
  act(() => { expect(appendToDraft('p1', 'N17: A')).toBe('my own words, N17: A'); });
  expect(result.current[0]).toBe('my own words, N17: A');
  // A remount on the same page keeps it too.
  const again = renderHook(() => useDraft('p1'));
  expect(again.result.current[0]).toBe('my own words, N17: A');
});

test('with a storage that cannot even be read, drafts still work in memory', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
  const { result } = renderHook(() => useDraft('p1'));
  expect(result.current[0]).toBe('');
  act(() => { appendToDraft('p1', 'N12: approve'); });
  expect(result.current[0]).toBe('N12: approve');
  act(() => clearStoredDraft('p1'));
  expect(renderHook(() => useDraft('p1')).result.current[0]).toBe('');
});
