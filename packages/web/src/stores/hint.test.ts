import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useHint } from './hint';

beforeEach(() => { vi.useFakeTimers(); useHint.setState({ msg: null }); });
afterEach(() => { vi.useRealTimers(); });

describe('useHint', () => {
  it('shows a message and auto-dismisses after 4s', () => {
    useHint.getState().show('hello');
    expect(useHint.getState().msg).toBe('hello');
    vi.advanceTimersByTime(4000);
    expect(useHint.getState().msg).toBeNull();
  });

  it('a newer message resets the dismiss timer', () => {
    useHint.getState().show('first');
    vi.advanceTimersByTime(3000);
    useHint.getState().show('second');
    vi.advanceTimersByTime(3000);
    expect(useHint.getState().msg).toBe('second'); // first's timer must not clear it
    vi.advanceTimersByTime(1000);
    expect(useHint.getState().msg).toBeNull();
  });
});
