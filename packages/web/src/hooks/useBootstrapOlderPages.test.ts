// packages/web/src/hooks/useBootstrapOlderPages.test.ts
import { renderHook } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { useBootstrapOlderPages } from './useBootstrapOlderPages';

// The real scroller measures actual DOM geometry (scrollHeight/clientHeight via
// getBoundingClientRect), which jsdom always reports as 0 — so exercising the "does the
// viewport overflow" signal end-to-end isn't possible in this environment. Mock the
// library's own derived {start, end} state instead (the same "is there anything to scroll
// to in this direction" booleans the vendored primitive computes internally) so the hook's
// LOOP logic — the part this fix actually adds — can be tested directly.
vi.mock('@shadcn/react/message-scroller', () => ({ useMessageScrollerScrollable: vi.fn() }));
import { useMessageScrollerScrollable } from '@shadcn/react/message-scroller';

function mockScrollable(start: boolean, end: boolean) {
  vi.mocked(useMessageScrollerScrollable).mockReturnValue({ start, end });
}

beforeEach(() => {
  vi.mocked(useMessageScrollerScrollable).mockReset();
});

test('does nothing when the viewport already overflows via `start` (reader can scroll for more themselves)', () => {
  mockScrollable(true, false);
  const loadOlder = vi.fn();
  renderHook(() => useBootstrapOlderPages({ hasMore: true, loadingOlder: false, loadOlder }));
  expect(loadOlder).not.toHaveBeenCalled();
});

test('does nothing when the viewport already overflows via `end`', () => {
  mockScrollable(false, true);
  const loadOlder = vi.fn();
  renderHook(() => useBootstrapOlderPages({ hasMore: true, loadingOlder: false, loadOlder }));
  expect(loadOlder).not.toHaveBeenCalled();
});

test('does nothing when hasMore is false', () => {
  mockScrollable(false, false);
  const loadOlder = vi.fn();
  renderHook(() => useBootstrapOlderPages({ hasMore: false, loadingOlder: false, loadOlder }));
  expect(loadOlder).not.toHaveBeenCalled();
});

test('does nothing while a fetch is already in flight', () => {
  mockScrollable(false, false);
  const loadOlder = vi.fn();
  renderHook(() => useBootstrapOlderPages({ hasMore: true, loadingOlder: true, loadOlder }));
  expect(loadOlder).not.toHaveBeenCalled();
});

test('calls loadOlder immediately when the initial content is too short to overflow and hasMore is true', () => {
  mockScrollable(false, false);
  const loadOlder = vi.fn();
  renderHook(() => useBootstrapOlderPages({ hasMore: true, loadingOlder: false, loadOlder }));
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

test('keeps paging in older content across settle cycles until the viewport genuinely overflows', () => {
  const loadOlder = vi.fn();
  mockScrollable(false, false);
  const { rerender } = renderHook(
    ({ loadingOlder }) => useBootstrapOlderPages({ hasMore: true, loadingOlder, loadOlder }),
    { initialProps: { loadingOlder: false } },
  );
  expect(loadOlder).toHaveBeenCalledTimes(1); // mount: content short → first page

  rerender({ loadingOlder: true }); // that page's fetch starts
  expect(loadOlder).toHaveBeenCalledTimes(1); // no re-fire while in flight

  rerender({ loadingOlder: false }); // fetch settles, STILL short → loop continues
  expect(loadOlder).toHaveBeenCalledTimes(2);

  rerender({ loadingOlder: true });
  mockScrollable(true, false); // this page finally overflows the viewport
  rerender({ loadingOlder: false });
  expect(loadOlder).toHaveBeenCalledTimes(2); // loop stops — the reader can scroll for more now
});

test('stops once hasMore goes false mid-loop', () => {
  const loadOlder = vi.fn();
  mockScrollable(false, false);
  const { rerender } = renderHook(
    ({ hasMore }) => useBootstrapOlderPages({ hasMore, loadingOlder: false, loadOlder }),
    { initialProps: { hasMore: true } },
  );
  expect(loadOlder).toHaveBeenCalledTimes(1);
  rerender({ hasMore: false }); // the last page was exhausted
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

test('caps consecutive attempts as a safety valve against a runaway loop', () => {
  const loadOlder = vi.fn();
  mockScrollable(false, false);
  const { rerender } = renderHook(
    ({ loadingOlder }) => useBootstrapOlderPages({ hasMore: true, loadingOlder, loadOlder }),
    { initialProps: { loadingOlder: false } },
  );
  // 50 settle cycles (well past any sane page count) — each false→true→false is one attempt.
  for (let i = 0; i < 50; i++) {
    rerender({ loadingOlder: true });
    rerender({ loadingOlder: false });
  }
  // Bounded well below 51 (mount + 50 cycles) — the exact cap is an implementation detail,
  // the contract under test is just "it stops", not a specific number.
  expect(loadOlder.mock.calls.length).toBeLessThan(51);
  expect(loadOlder.mock.calls.length).toBeGreaterThan(0);
});

test('a new loadOlder identity (thread switch) resets the attempt cap for the incoming thread', () => {
  const loadOlder1 = vi.fn();
  const loadOlder2 = vi.fn();
  mockScrollable(false, false);
  const { rerender } = renderHook(
    ({ loadingOlder, loadOlder }) => useBootstrapOlderPages({ hasMore: true, loadingOlder, loadOlder }),
    { initialProps: { loadingOlder: false, loadOlder: loadOlder1 } },
  );
  // Exhaust loadOlder1's cap.
  for (let i = 0; i < 50; i++) {
    rerender({ loadingOlder: true, loadOlder: loadOlder1 });
    rerender({ loadingOlder: false, loadOlder: loadOlder1 });
  }
  const exhaustedCount = loadOlder1.mock.calls.length;
  rerender({ loadingOlder: true, loadOlder: loadOlder1 });
  rerender({ loadingOlder: false, loadOlder: loadOlder1 }); // one more cycle — the cap holds
  expect(loadOlder1.mock.calls.length).toBe(exhaustedCount);

  // Switch to a new thread (a fresh loadOlder callback identity, same as useStructuredChat
  // produces per terminalId) — the incoming thread must NOT inherit the outgoing one's cap.
  rerender({ loadingOlder: false, loadOlder: loadOlder2 });
  expect(loadOlder2).toHaveBeenCalledTimes(1);
});
