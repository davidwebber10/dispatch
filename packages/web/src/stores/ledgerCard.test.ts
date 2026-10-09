import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLedgerCard, useLedgerCardSync } from './ledgerCard';
import { api } from '../api/client';
import type { LedgerCard } from '../api/types';

const card = (updatedAt: string): LedgerCard => ({
  updatedAt, lastRecapAt: null,
  sections: {
    rulesCount: 0, needsYou: { cards: [], lines: [] }, onDefaults: [], actions: [], decidedSince: [],
    untriaged: [], parked: [], counts: { overseerDecisions: 0, reversed: 0 },
  },
  rules: [], index: [],
});

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useLedgerCard.setState({ byProject: {} });
  vi.restoreAllMocks();
});

describe('the pinned card store', () => {
  it('loads one card per project', async () => {
    const get = vi.spyOn(api, 'getLedgerCard').mockImplementation(async (id) => card(`${id}-t1`));
    await useLedgerCard.getState().load('p1');
    await useLedgerCard.getState().load('p2');
    expect(get).toHaveBeenCalledWith('p1');
    expect(useLedgerCard.getState().byProject.p1).toMatchObject({ card: card('p1-t1'), loading: false, error: null });
    expect(useLedgerCard.getState().byProject.p2.card?.updatedAt).toBe('p2-t1');
  });

  it('keeps the last good card while a reload runs, and after a failed one, with an error', async () => {
    vi.spyOn(api, 'getLedgerCard').mockResolvedValueOnce(card('t1'));
    await useLedgerCard.getState().load('p1');
    const next = deferred<LedgerCard>();
    vi.spyOn(api, 'getLedgerCard').mockReturnValueOnce(next.promise);
    const reload = useLedgerCard.getState().load('p1');
    expect(useLedgerCard.getState().byProject.p1).toMatchObject({ card: card('t1'), loading: true });
    next.reject(new Error('GET failed: 502'));
    await reload;
    expect(useLedgerCard.getState().byProject.p1).toMatchObject({ card: card('t1'), loading: false, error: 'GET failed: 502' });
    // The next good load clears the error.
    vi.spyOn(api, 'getLedgerCard').mockResolvedValueOnce(card('t2'));
    await useLedgerCard.getState().load('p1');
    expect(useLedgerCard.getState().byProject.p1).toMatchObject({ card: card('t2'), error: null });
  });

  it('a slow older response never overwrites a newer one', async () => {
    const first = deferred<LedgerCard>();
    const second = deferred<LedgerCard>();
    vi.spyOn(api, 'getLedgerCard').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useLedgerCard.getState().load('p1');
    const b = useLedgerCard.getState().load('p1');
    second.resolve(card('new'));
    await b;
    first.resolve(card('old'));
    await a;
    expect(useLedgerCard.getState().byProject.p1).toMatchObject({ card: card('new'), loading: false });
  });

  it('ledger:changed loads the card of that project again, only when the screen has shown it', async () => {
    const get = vi.spyOn(api, 'getLedgerCard').mockResolvedValue(card('t1'));
    await useLedgerCard.getState().load('p1');
    get.mockClear();
    useLedgerCard.getState().applyEvent({ type: 'ledger:changed', sessionId: 'p1' });
    useLedgerCard.getState().applyEvent({ type: 'ledger:changed', sessionId: 'never-shown' });
    useLedgerCard.getState().applyEvent({ type: 'terminal:status', sessionId: 'p1' });
    expect(get.mock.calls).toEqual([['p1']]);
  });

  it('reloadAll loads every project the screen has shown (a reconnect)', async () => {
    const get = vi.spyOn(api, 'getLedgerCard').mockResolvedValue(card('t1'));
    await useLedgerCard.getState().load('p1');
    await useLedgerCard.getState().load('p2');
    get.mockClear();
    await useLedgerCard.getState().reloadAll();
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2']);
  });
});

describe('useLedgerCardSync — the Control Plane screen loads its project\'s card', () => {
  it('loads on mount and again when the screen shows another project', () => {
    const get = vi.spyOn(api, 'getLedgerCard').mockResolvedValue(card('t1'));
    const { rerender } = renderHook(({ id }) => useLedgerCardSync(id), { initialProps: { id: 'p1' as string | null } });
    expect(get.mock.calls).toEqual([['p1']]);
    rerender({ id: 'p1' });
    expect(get).toHaveBeenCalledTimes(1);
    rerender({ id: 'p2' });
    expect(get.mock.calls).toEqual([['p1'], ['p2']]);
    rerender({ id: null });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
