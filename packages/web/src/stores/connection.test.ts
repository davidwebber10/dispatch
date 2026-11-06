import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { STATUS_GRACE_MS, useConnection, useShownStatus } from './connection';

beforeEach(() => { vi.useFakeTimers(); useConnection.setState({ status: 'connecting', everOpen: false }); });
afterEach(() => vi.useRealTimers());

test('a short drop still reads as connected; a long one says Reconnecting', () => {
  act(() => useConnection.getState().setStatus('open'));
  const { result } = renderHook(() => useShownStatus());
  act(() => useConnection.getState().setStatus('closed'));
  act(() => useConnection.getState().setStatus('connecting'));
  act(() => { vi.advanceTimersByTime(STATUS_GRACE_MS - 100); });
  expect(result.current).toBe('open');
  act(() => useConnection.getState().setStatus('open'));
  expect(result.current).toBe('open');
  // A long outage that flips closed/connecting on every retry still shows, once the grace is up.
  act(() => useConnection.getState().setStatus('closed'));
  act(() => { vi.advanceTimersByTime(700); });
  act(() => useConnection.getState().setStatus('connecting'));
  act(() => { vi.advanceTimersByTime(900); });
  expect(result.current).toBe('reconnecting');
});

test('the first connect at launch says Connecting, not Reconnecting', () => {
  const { result } = renderHook(() => useShownStatus());
  act(() => { vi.advanceTimersByTime(STATUS_GRACE_MS + 10); });
  expect(result.current).toBe('connecting');
});
