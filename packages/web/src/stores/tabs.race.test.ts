// Finding 1: the per-project epoch guard in loadTabs() (added to stop a superseded response
// from regressing byProject) originally worked by returning early:
//
//   if (loadEpoch[projectId] !== epoch) return;
//
// That silently breaks loadTabs()'s promise contract: ~20 call sites do
// `await loadTabs(x); <read state>` and assume state has been applied once the await
// resolves. A superseded call now resolves having applied nothing. hydrate() is the worst
// case — see the first test below for the exact reproduction.
//
// The fix makes a superseded call await the winning in-flight call instead of returning
// early, so "await loadTabs()" still means "state reflects at least as fresh a response as
// the one I awaited" everywhere, while still never letting a stale response become `prev`
// or overwrite byProject (covered below too).
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { useTabs } from './tabs';
import { api } from '../api/client';

const STORAGE_KEY = 'dispatch:tabs';

function term(over: Record<string, unknown> = {}) {
  return { id: 't1', sessionId: 's1', label: 'Fix login bug', labelSource: 'auto', ...over } as any;
}

beforeEach(() => {
  useTabs.setState({
    byProject: {}, openTabIds: [], activeTabId: null, tabSession: {}, loading: {}, dirtyTabs: {}, autoNamed: {},
  } as any);
  localStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

test('Finding 1 (C1): a hydrate() reload superseded by a concurrent loadTabs() must not wipe openTabIds or truncate persisted storage', async () => {
  // Cold boot: one previously-open tab (t1, project s1) survived on disk from last session.
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    openTabIds: ['t1'], activeTabId: 't1', tabSession: { t1: 's1' },
  }));

  let resolveEpoch1!: (v: unknown) => void;
  let resolveEpoch2!: (v: unknown) => void;
  const fetch1 = new Promise((r) => { resolveEpoch1 = r; });
  const fetch2 = new Promise((r) => { resolveEpoch2 = r; });
  const spy = vi.spyOn(api, 'listTerminals');
  spy.mockImplementationOnce(() => fetch1 as any); // hydrate's own loadTabs('s1') — epoch 1, issued first
  spy.mockImplementationOnce(() => fetch2 as any); // ProjectSidebar auto-expand's loadTabs('s1') — epoch 2

  // 1. Boot: hydrate() fires its loadTabs('s1') — epoch 1, still in flight.
  const hydratePromise = useTabs.getState().hydrate();
  // 2. useProjects.load() resolves → ProjectSidebar auto-expands the active card →
  //    ProjectCard calls loadTabs('s1') — epoch 2, still in flight, supersedes epoch 1.
  const cardCall = useTabs.getState().loadTabs('s1');

  // 3. Epoch 1's response — issued first — lands first, while epoch 2 is still in flight.
  resolveEpoch1([term()]);
  // Give hydrate() every chance to run all the way to completion on epoch 1 alone — exactly
  // like the real (network-timed) repro, where epoch 2 genuinely hasn't come back yet.
  await new Promise((r) => setTimeout(r, 0));

  // 4. Epoch 2's response lands a little later, same as in the real repro.
  resolveEpoch2([term()]);
  await Promise.all([hydratePromise, cardCall]);

  const { openTabIds, activeTabId } = useTabs.getState();
  expect(openTabIds).toEqual(['t1']);
  expect(activeTabId).toBe('t1');

  const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  expect(persisted.openTabIds).toEqual(['t1']); // must NOT have been truncated to []
});

test('contract: awaiting a superseded loadTabs() resolves only once the winning response has been applied', async () => {
  let resolveOld!: (v: unknown) => void;
  let resolveNew!: (v: unknown) => void;
  const oldFetch = new Promise((r) => { resolveOld = r; });
  const newFetch = new Promise((r) => { resolveNew = r; });
  const spy = vi.spyOn(api, 'listTerminals');
  spy.mockImplementationOnce(() => oldFetch as any);
  spy.mockImplementationOnce(() => newFetch as any);

  const old = useTabs.getState().loadTabs('s1');   // epoch 1, issued first
  const fresh = useTabs.getState().loadTabs('s1'); // epoch 2, issued second — supersedes epoch 1

  let oldSettled = false;
  old.then(() => { oldSettled = true; });

  resolveOld([term({ label: 'stale' })]);      // the superseded (epoch 1) response lands first
  await new Promise((r) => setTimeout(r, 0));   // flush microtasks — the winning call is still open

  // The superseded call must NOT resolve while the winning call is still in flight: a caller
  // awaiting loadTabs() has to be able to trust that state is applied once it resolves.
  expect(oldSettled).toBe(false);
  expect(useTabs.getState().byProject['s1']).toBeUndefined();

  resolveNew([term({ label: 'fresh', labelSource: 'auto' })]); // the winning (epoch 2) response lands
  await old;

  expect(oldSettled).toBe(true);
  expect(useTabs.getState().byProject['s1']).toEqual([term({ label: 'fresh', labelSource: 'auto' })]);
  await fresh;
});

test('anti-replay guarantee: a stale response, even once it resolves, never overwrites byProject with older data', async () => {
  useTabs.setState({ byProject: { s1: [term({ label: 'prev' })] } } as any);
  let resolveOld!: (v: unknown) => void;
  const oldFetch = new Promise((r) => { resolveOld = r; });
  const spy = vi.spyOn(api, 'listTerminals');
  spy.mockImplementationOnce(() => oldFetch as any);
  spy.mockImplementationOnce(() => Promise.resolve([term({ label: 'fresh', labelSource: 'auto' })]));

  const old = useTabs.getState().loadTabs('s1');   // epoch 1, issued first
  const fresh = useTabs.getState().loadTabs('s1'); // epoch 2, resolves first
  await fresh;
  expect(useTabs.getState().byProject['s1']).toEqual([term({ label: 'fresh', labelSource: 'auto' })]);

  resolveOld([term({ label: 'even-older-stale' })]); // the stale response finally lands
  await old;

  // The stale response must never have replaced the fresher one, even though it did eventually settle.
  expect(useTabs.getState().byProject['s1']).toEqual([term({ label: 'fresh', labelSource: 'auto' })]);
});
