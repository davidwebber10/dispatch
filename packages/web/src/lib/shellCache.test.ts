import { afterEach, expect, test, vi } from 'vitest';
import { dropSavedShell, reloadFresh } from './shellCache';

afterEach(() => vi.unstubAllGlobals());

function fakeCaches(names: string[]) {
  const deleted: string[] = [];
  vi.stubGlobal('caches', {
    keys: async () => names,
    open: async (name: string) => ({ delete: async (url: string) => { deleted.push(`${name}${url}`); return true; } }),
  });
  return deleted;
}

test('drops the saved shell from every shell cache, and leaves the intent and badge caches alone', async () => {
  const deleted = fakeCaches(['dispatch-dispatch-v6', 'dispatch-dispatch-v7', 'dispatch-intent', 'dispatch-badge']);
  await dropSavedShell();
  expect(deleted.sort()).toEqual(['dispatch-dispatch-v6/', 'dispatch-dispatch-v7/']);
});

test('reloadFresh drops the shell before it reloads', async () => {
  const order: string[] = [];
  vi.stubGlobal('caches', { keys: async () => ['dispatch-dispatch-v7'], open: async () => ({ delete: async () => { order.push('drop'); return true; } }) });
  vi.stubGlobal('location', { reload: () => order.push('reload') });
  await reloadFresh();
  expect(order).toEqual(['drop', 'reload']);
});

test('never throws when the Cache API is missing or fails', async () => {
  vi.stubGlobal('caches', { keys: async () => { throw new Error('blocked'); } });
  await expect(dropSavedShell()).resolves.toBeUndefined();
});
