import type { ConvItem } from '../api/types';

/**
 * The last rendered items of the threads this page showed, in memory only (W2-I).
 *
 * A thread open or a tab switch opens a new socket, and the replay needs 3 to 4 round trips before the
 * first item: on a remote link the view was empty for half a second or more each time. The chat hook
 * shows these items at once, marked stale, and the first replay replaces them.
 *
 * Bounds: 20 threads (the least recently used one goes first), 300 items for each (the newest). Nothing
 * is written to storage: a transcript can hold secrets, and a reload gets the truth from the daemon.
 */
export const MAX_THREADS = 20;
export const MAX_ITEMS = 300;

const store = new Map<string, ConvItem[]>(); // insertion order = age; a get or a put moves the id to the end

export const threadViewCache = {
  /** The stored items (the same array on each call, until the next put), or undefined. */
  get(id: string): ConvItem[] | undefined {
    const items = store.get(id);
    if (!items) return undefined;
    store.delete(id); store.set(id, items);
    return items;
  },
  /** Stores a copy of the newest items. A bubble that waits for its echo (`localId`) is left out. An empty list removes the entry. */
  put(id: string, items: ConvItem[]): void {
    const keep = items.filter((it) => !it.localId).slice(-MAX_ITEMS);
    store.delete(id);
    if (!keep.length) return;
    store.set(id, keep);
    while (store.size > MAX_THREADS) store.delete(store.keys().next().value as string);
  },
  remove(id: string): void { store.delete(id); },
  clear(): void { store.clear(); },
  size(): number { return store.size; },
};
