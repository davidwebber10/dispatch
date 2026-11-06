import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { reloadForSignIn } from './signInReload';

const reload = vi.fn();
beforeEach(() => {
  reload.mockReset();
  vi.stubGlobal('location', { reload });
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());
// The reload follows dropping the saved shell (lib/shellCache.ts), a few microtasks later.
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('reloads once, then not again inside the cooldown', async () => {
  reloadForSignIn();
  reloadForSignIn();
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
});

test('reloads again after the cooldown', async () => {
  vi.useFakeTimers();
  reloadForSignIn();
  vi.advanceTimersByTime(11_000);
  reloadForSignIn();
  await settle();
  expect(reload).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
