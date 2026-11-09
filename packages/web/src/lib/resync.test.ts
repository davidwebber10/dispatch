import { expect, test, vi, beforeEach } from 'vitest';
import { resyncAfterReconnect } from './resync';
import { useThreadStatus } from '../stores/threadStatus';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { useLedgerCard } from '../stores/ledgerCard';
import { api } from '../api/client';

beforeEach(() => {
  useThreadStatus.setState({ byTerminal: {} });
  useProjects.setState({ sessions: [], activeId: null });
  useTabs.setState({ byProject: {} });
  vi.restoreAllMocks();
});

test('drops the stale live-status overlay so a missed settle no longer pins a card as working', async () => {
  // A thread that finished while we were disconnected: the daemon settled its row to
  // 'waiting', but we never got the working→settled event, so live status is frozen 'working'.
  useThreadStatus.setState({ byTerminal: { t1: { status: 'working', threadStatus: 'working', activity: 'Running' } } });
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);

  await resyncAfterReconnect();

  expect(useThreadStatus.getState().byTerminal).toEqual({});
});

test('re-pulls the authoritative rows for every known project', async () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any, { id: 'p2', name: 'Beta' } as any] });
  const listTerminals = vi.spyOn(api, 'listTerminals').mockResolvedValue([]);

  await resyncAfterReconnect();

  expect(listTerminals).toHaveBeenCalledWith('p1');
  expect(listTerminals).toHaveBeenCalledWith('p2');
});

test('loads the pinned cards again: a ledger:changed missed while the socket was down', async () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  const reloadAll = vi.spyOn(useLedgerCard.getState(), 'reloadAll').mockResolvedValue();

  await resyncAfterReconnect();

  expect(reloadAll).toHaveBeenCalledTimes(1);
});

test('a failing project reload is swallowed so one dead project cannot abort the resync', async () => {
  useProjects.setState({ sessions: [{ id: 'gone', name: 'Gone' } as any, { id: 'ok', name: 'Ok' } as any] });
  const listTerminals = vi.spyOn(api, 'listTerminals').mockImplementation(async (id: string) => {
    if (id === 'gone') throw new Error('404');
    return [];
  });

  await expect(resyncAfterReconnect()).resolves.toBeUndefined();
  expect(listTerminals).toHaveBeenCalledWith('ok');
});

test('loads the stall flags again: a terminal:stall missed while the socket was down', async () => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  useThreadStatus.setState({ stalls: { stale: 1 } });
  const listStalls = vi.spyOn(api, 'listStalls').mockResolvedValue([{ terminalId: 't1', stalledSince: 99, lastFrameAt: null }]);

  await resyncAfterReconnect();

  expect(listStalls).toHaveBeenCalledTimes(1);
  expect(useThreadStatus.getState().stalls).toEqual({ t1: 99 });
});

// W2-H: one request after a reconnect, in place of one for each project.
import { afterEach, describe } from 'vitest';
import { resetBootstrapForTest } from './bootstrap';
import { useUsageLimits } from '../stores/usageLimits';

describe('resyncAfterReconnect with the bootstrap (W2-H)', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `p${i + 1}`);
  const row = (id: string, sessionId: string, status = 'waiting') => ({ id, sessionId, label: id, type: 'claude-code', status, config: {} });
  let calls: string[];
  const network = (boot: unknown, old: Record<string, unknown> = {}) => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/bootstrap')) {
        const b = typeof boot === 'function' ? await (boot as () => unknown)() : boot;
        return b === null ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(b), { status: 200 });
      }
      if (url in old) return new Response(JSON.stringify(old[url]), { status: 200 });
      return new Response('[]', { status: 200 });
    }));
  };
  const boot = () => ({
    terminalsByProject: Object.fromEntries(ids.map((id) => [id, [row(`t-${id}`, id)]])),
    stalls: [{ terminalId: 't-p3', stalledSince: 42, lastFrameAt: null }],
    usageSummary: { type: 'usage-limits', at: 9, epoch: 'e9', rev: 4, warnPercent: 70, providers: [], paused: [] },
  });
  beforeEach(() => {
    resetBootstrapForTest();
    useProjects.setState({ sessions: ids.map((id) => ({ id, name: id }) as any), activeId: null });
    useTabs.setState({ byProject: Object.fromEntries(ids.map((id) => [id, [row(`t-${id}`, id, 'working') as any]])), tabSession: {} });
    useThreadStatus.setState({ byTerminal: { 't-p1': { status: 'working' } }, stalls: { old: 1 } });
    useUsageLimits.setState({ summary: null, epoch: null, retired: [], rev: 0 });
    useLedgerCard.setState({ byProject: {} });
  });
  afterEach(() => { resetBootstrapForTest(); vi.unstubAllGlobals(); });

  test('a reconnect sends one request for 20 projects', async () => {
    network(boot());
    await resyncAfterReconnect();
    expect(calls).toEqual(['/api/bootstrap?parts=terminalsByProject,stalls,usageSummary']);
    // Every project has its rows again, the stall flags and the usage gauge too.
    for (const id of ids) expect(useTabs.getState().byProject[id].map((t) => t.status)).toEqual(['waiting']);
    expect(useThreadStatus.getState().byTerminal).toEqual({});
    expect(useThreadStatus.getState().stalls).toEqual({ 't-p3': 42 });
    expect(useUsageLimits.getState().epoch).toBe('e9');
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(70);
  });

  test('an older daemon (404) gets one list request for each project, as before', async () => {
    network(null);
    await resyncAfterReconnect();
    expect(calls.filter((u) => /\/terminals$/.test(u))).toHaveLength(20);
    expect(calls).toContain('/api/terminals/stalls');
    expect(calls).toContain('/api/usage-limits/summary');
  });

  test('a project that the answer lacks asks for its own list; the others do not', async () => {
    const b = boot();
    delete (b.terminalsByProject as Record<string, unknown>).p7;
    network(b, { '/api/sessions/p7/terminals': [row('t-p7-net', 'p7')] });
    await resyncAfterReconnect();
    expect(calls).toEqual(['/api/bootstrap?parts=terminalsByProject,stalls,usageSummary', '/api/sessions/p7/terminals']);
    expect(useTabs.getState().byProject.p7.map((t) => t.id)).toEqual(['t-p7-net']);
  });

  test('a list that an event asked for while the request was in flight is not replaced by the older answer', async () => {
    // The reconnect request is in flight; an event (thread added to p2) makes the app load p2 from the network.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    network(async () => { await held; return boot(); }, { '/api/sessions/p2/terminals': [row('t-p2', 'p2'), row('t-p2-new', 'p2')] });
    const resync = resyncAfterReconnect();
    await useTabs.getState().loadTabs('p2');
    expect(useTabs.getState().byProject.p2.map((t) => t.id)).toEqual(['t-p2', 't-p2-new']);
    release();
    await resync;
    // p2 keeps the newer list (the resync asked the network for it again); the other 19 came from the one answer.
    expect(useTabs.getState().byProject.p2.map((t) => t.id)).toEqual(['t-p2', 't-p2-new']);
    expect(calls.filter((u) => /\/terminals$/.test(u))).toEqual(['/api/sessions/p2/terminals', '/api/sessions/p2/terminals']);
    expect(useTabs.getState().byProject.p1.map((t) => t.status)).toEqual(['waiting']);
  });
});
