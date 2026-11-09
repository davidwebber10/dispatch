import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecentlyChanged, useThrottledValue } from './useThrottledValue';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useThrottledValue', () => {
  it('200 changes in one second give at most 11 outputs', () => {
    const outputs: number[] = [];
    const { rerender } = renderHook(({ v }) => { const out = useThrottledValue(v, 100, true); outputs.push(out); return out; }, { initialProps: { v: 0 } });
    for (let i = 1; i <= 200; i++) {
      act(() => { vi.advanceTimersByTime(5); });
      rerender({ v: i });
    }
    act(() => { vi.advanceTimersByTime(5); });
    const distinct = [...new Set(outputs)];
    expect(distinct.length).toBeLessThanOrEqual(11);
    expect(distinct.length).toBeGreaterThanOrEqual(9); // it is a throttle, not a debounce: the text moves during the stream
    expect(distinct).toEqual([...distinct].sort((a, b) => a - b)); // never an older value after a newer one
  });

  it('the last value is delivered when active turns false', () => {
    const { result, rerender } = renderHook(({ v, active }) => useThrottledValue(v, 100, active), { initialProps: { v: 'a', active: true } });
    act(() => { vi.advanceTimersByTime(150); });
    rerender({ v: 'ab', active: true });
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ v: 'abc', active: true });
    expect(result.current).toBe('ab'); // 'abc' waits for the next 100 ms slot
    rerender({ v: 'abc', active: false });
    expect(result.current).toBe('abc'); // in the same render, with no timer
  });

  it('the last value is delivered after the wait when the changes stop', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 100, true), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    rerender({ v: 'abc' });
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe('abc');
  });

  it('inactive passes every value', () => {
    const outputs: number[] = [];
    const { rerender } = renderHook(({ v }) => { const out = useThrottledValue(v, 100, false); outputs.push(out); return out; }, { initialProps: { v: 0 } });
    for (let i = 1; i <= 20; i++) rerender({ v: i });
    expect([...new Set(outputs)]).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a value that turns active starts from the current value, not from an old one', () => {
    const { result, rerender } = renderHook(({ v, active }) => useThrottledValue(v, 100, active), { initialProps: { v: 'a', active: false } });
    rerender({ v: 'abcd', active: false });
    rerender({ v: 'abcd', active: true });
    expect(result.current).toBe('abcd');
  });

  it('removes its timer on unmount', () => {
    const { rerender, unmount } = renderHook(({ v }) => useThrottledValue(v, 100, true), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useRecentlyChanged', () => {
  it('is false for a value that does not change', () => {
    const { result, rerender } = renderHook(({ v }) => useRecentlyChanged(v, 400), { initialProps: { v: 'a' } });
    rerender({ v: 'a' });
    expect(result.current).toBe(false);
  });

  it('is true in the render that sees a change, and false again after the quiet time', () => {
    const { result, rerender } = renderHook(({ v }) => useRecentlyChanged(v, 400), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(300); });
    rerender({ v: 'abc' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe(true); // the second change started a new quiet time
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe(false);
  });
});
