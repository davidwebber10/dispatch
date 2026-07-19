import { expect, test, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

afterEach(() => { vi.restoreAllMocks(); delete (window as any).matchMedia; });

function stubMatchMedia(matches: boolean) {
  const listeners: Array<() => void> = [];
  const mq = {
    matches,
    addEventListener: (_: string, cb: () => void) => { listeners.push(cb); },
    removeEventListener: vi.fn(),
  };
  (window as any).matchMedia = vi.fn(() => mq);
  return { mq, fire: (next: boolean) => { mq.matches = next; listeners.forEach((cb) => cb()); } };
}

test('returns false when matchMedia is unavailable (jsdom default)', () => {
  const { result } = renderHook(() => usePrefersReducedMotion());
  expect(result.current).toBe(false);
});

test('returns true when the user prefers reduced motion', () => {
  stubMatchMedia(true);
  const { result } = renderHook(() => usePrefersReducedMotion());
  expect(result.current).toBe(true);
});

test('reacts to a live preference change', () => {
  const { fire } = stubMatchMedia(false);
  const { result } = renderHook(() => usePrefersReducedMotion());
  expect(result.current).toBe(false);
  act(() => fire(true));
  expect(result.current).toBe(true);
});

test('removes its listener on unmount', () => {
  const { mq } = stubMatchMedia(false);
  const { unmount } = renderHook(() => usePrefersReducedMotion());
  unmount();
  expect(mq.removeEventListener).toHaveBeenCalled();
});
