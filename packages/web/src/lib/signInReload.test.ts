import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { reloadForSignIn } from './signInReload';

const reload = vi.fn();
beforeEach(() => {
  reload.mockReset();
  vi.stubGlobal('location', { reload });
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

test('reloads once, then not again inside the cooldown', () => {
  reloadForSignIn();
  reloadForSignIn();
  expect(reload).toHaveBeenCalledTimes(1);
});

test('reloads again after the cooldown', () => {
  vi.useFakeTimers();
  reloadForSignIn();
  vi.advanceTimersByTime(11_000);
  reloadForSignIn();
  expect(reload).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
