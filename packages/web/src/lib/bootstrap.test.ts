// W2-H: the launch bootstrap. One request gives the stores what about 14 requests gave before; an
// older daemon (404) gets the old requests.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadBootstrap, resetBootstrapForTest, SERVE_AFTER_MS, type BootstrapData } from './bootstrap';
import { api } from '../api/client';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { useAuth } from '../stores/auth';
import { useUpdate } from '../stores/update';
import { useAgents } from '../stores/agents';
import { useUsageLimits } from '../stores/usageLimits';
import { useThreadStatus } from '../stores/threadStatus';
import { useConnection } from '../stores/connection';
import { useSettings, loadSharedSettings } from '../stores/settings';

const term = (id: string, sessionId: string, label = id) => ({ id, sessionId, label, type: 'claude-code', status: 'waiting', config: {} });
const SUMMARY = { type: 'usage-limits', at: 5, epoch: 'e1', rev: 3, warnPercent: 80, providers: [], paused: [] };
const UPDATE = { available: false, version: null, url: null, publishedAt: null, currentVersion: '9.9.9', notes: [], currentNotes: 'note' };
const BOOT: BootstrapData = {
  sessions: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }, { id: 'p3', name: 'Gamma' }],
  terminalsByProject: { p1: [term('t1', 'p1')], p2: [term('t2', 'p2'), term('t3', 'p2')], p3: [] },
  stalls: [{ terminalId: 't2', stalledSince: 77, lastFrameAt: null }],
  authRequests: [{ id: 'a1', url: 'https://x.example' }],
  update: UPDATE,
  usageSummary: SUMMARY,
  sharedSettings: { dictation: { saved: true, provider: 'groq', model: 'whisper-x', secretName: 'K' }, coordinator: { saved: true, name: 'Ops' } },
  plugins: null,
  schedules: [],
};

/** The answers of the old routes, for a daemon with no bootstrap. */
const OLD: Record<string, unknown> = {
  '/api/sessions': [{ id: 'o1', name: 'Old' }],
  '/api/sessions/o1/terminals': [term('ot1', 'o1')],
  '/api/sessions/p1/terminals': [term('t1-net', 'p1')],
  '/api/sessions/p2/terminals': [term('t2-net', 'p2')],
  '/api/terminals/stalls': [{ terminalId: 'ot1', stalledSince: 5, lastFrameAt: null }],
  '/api/auth-requests': [{ id: 'old-a', url: 'https://old.example' }],
  '/api/state/update': { ...UPDATE, currentVersion: '1.0.0' },
  '/api/usage-limits/summary': { ...SUMMARY, epoch: 'old', rev: 1 },
  '/api/settings/dictation': { saved: true, provider: 'openai', model: 'old-model', secretName: '' },
  '/api/settings/coordinator': { saved: true, name: 'OldName' },
  '/api/agents/schedules': [],
  '/api/plugins/updates': { updates: [] },
};

let calls: string[];
/** A fake network. `boot` is the answer of /api/bootstrap: data, a status, or a function. */
function network(boot: BootstrapData | number | (() => Promise<Response>) | unknown) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/bootstrap')) {
      if (typeof boot === 'function') return (boot as () => Promise<Response>)();
      if (typeof boot === 'number') return new Response(JSON.stringify({ error: 'nope' }), { status: boot });
      return new Response(JSON.stringify(boot), { status: 200 });
    }
    if (url in OLD) return new Response(JSON.stringify(OLD[url]), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }));
}

/** What the app does at launch (App.tsx boot effect, the open project card, the first stall badge). */
function launchLoads(projectIds: string[] = ['p1']) {
  return Promise.all([
    useProjects.getState().load(),
    ...projectIds.map((id) => useTabs.getState().loadTabs(id)),
    useAuth.getState().load(),
    useUpdate.getState().load(),
    useAgents.getState().loadSchedules(),
    useUsageLimits.getState().load(),
    loadSharedSettings(),
    useThreadStatus.getState().loadStalls(),
  ]);
}

beforeEach(() => {
  resetBootstrapForTest();
  localStorage.clear();
  useProjects.setState({ sessions: [], activeId: null });
  useTabs.setState({ byProject: {}, tabSession: {}, openTabIds: [], activeTabId: null });
  useAuth.setState({ requests: [] });
  useUpdate.setState({ currentVersion: null });
  useAgents.setState({ schedules: [], selectedId: null });
  useUsageLimits.setState({ summary: null, epoch: null, retired: [], rev: 0 });
  useThreadStatus.setState({ byTerminal: {}, stalls: {} });
  useConnection.setState({ status: 'connecting', everOpen: false });
});
afterEach(() => { resetBootstrapForTest(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('loadBootstrap (W2-H)', () => {
  test('one request fills the stores', async () => {
    network(BOOT);
    const done = loadBootstrap();
    await launchLoads();
    expect(await done).toBe(true);

    // The one launch request, plus the plugin update check that is not part of the bootstrap.
    expect(calls.filter((u) => u !== '/api/plugins/updates')).toEqual(['/api/bootstrap']);

    expect(useProjects.getState().sessions.map((s) => s.id)).toEqual(['p1', 'p2', 'p3']);
    expect(useProjects.getState().activeId).toBe('p1');
    // The open project came through its own loader; the closed ones were put in directly.
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1']);
    expect(useTabs.getState().byProject.p2.map((t) => t.id)).toEqual(['t2', 't3']);
    expect(useTabs.getState().byProject.p3).toEqual([]);
    expect(useTabs.getState().tabSession).toMatchObject({ t1: 'p1', t2: 'p2', t3: 'p2' });
    expect(useAuth.getState().requests.map((r) => r.id)).toEqual(['a1']);
    expect(useUpdate.getState().currentVersion).toBe('9.9.9');
    expect(useUpdate.getState().currentNotes).toBe('note');
    expect(useUsageLimits.getState().summary).toMatchObject({ warnPercent: 80 });
    expect(useUsageLimits.getState().epoch).toBe('e1');
    expect(useUsageLimits.getState().rev).toBe(3);
    expect(useThreadStatus.getState().stalls).toEqual({ t2: 77 });
    expect(useSettings.getState().sttProvider).toBe('groq');
    expect(useSettings.getState().sttModel).toBe('whisper-x');
    expect(useSettings.getState().coordinatorName).toBe('Ops');
  });

  test('a 404 uses the old calls', async () => {
    network(404);
    const done = loadBootstrap();
    await launchLoads(['o1']);
    expect(await done).toBe(false);
    expect([...calls].sort()).toEqual([
      '/api/agents/schedules', '/api/auth-requests', '/api/bootstrap', '/api/plugins/updates', '/api/sessions', '/api/sessions/o1/terminals',
      '/api/settings/coordinator', '/api/settings/dictation', '/api/state/update', '/api/terminals/stalls', '/api/usage-limits/summary',
    ]);
    expect(useProjects.getState().sessions.map((s) => s.id)).toEqual(['o1']);
    expect(useTabs.getState().byProject.o1.map((t) => t.id)).toEqual(['ot1']);
    expect(useAuth.getState().requests.map((r) => r.id)).toEqual(['old-a']);
    expect(useUpdate.getState().currentVersion).toBe('1.0.0');
    expect(useUsageLimits.getState().epoch).toBe('old');
    expect(useThreadStatus.getState().stalls).toEqual({ ot1: 5 });
    expect(useSettings.getState().coordinatorName).toBe('OldName');
  });

  test('an answer that is not the bootstrap (an array, a page, a network error) uses the old calls', async () => {
    for (const bad of [[], () => Promise.resolve(new Response('<html></html>', { status: 200 })), () => Promise.reject(new TypeError('offline')), 500, 401]) {
      resetBootstrapForTest();
      useProjects.setState({ sessions: [], activeId: null });
      network(bad);
      const done = loadBootstrap();
      await useProjects.getState().load();
      expect(await done).toBe(false);
      expect(calls).toEqual(['/api/bootstrap', '/api/sessions']);
      expect(useProjects.getState().sessions.map((s) => s.id)).toEqual(['o1']);
    }
  });

  test('a part that the daemon left out (null) uses its own call; the other parts do not', async () => {
    network({ ...BOOT, authRequests: null, terminalsByProject: { p2: BOOT.terminalsByProject!.p2 }, sharedSettings: { dictation: null, coordinator: BOOT.sharedSettings!.coordinator } });
    void loadBootstrap();
    await launchLoads(['p1']);
    expect([...calls].filter((u) => u !== '/api/plugins/updates').sort()).toEqual(['/api/auth-requests', '/api/bootstrap', '/api/sessions/p1/terminals', '/api/settings/dictation']);
    expect(useAuth.getState().requests.map((r) => r.id)).toEqual(['old-a']);
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1-net']);
    expect(useSettings.getState().sttModel).toBe('old-model');
    expect(useSettings.getState().coordinatorName).toBe('Ops');
  });

  test('it starts one request, however many times it is called', async () => {
    network(BOOT);
    const a = loadBootstrap();
    const b = loadBootstrap();
    expect(a).toBe(b);
    await a;
    expect(calls).toEqual(['/api/bootstrap']);
  });

  test('once the events socket has opened, a call goes to the network: an event may have told the app of something newer', async () => {
    let release!: (r: Response) => void;
    network(() => new Promise<Response>((r) => { release = r; }));
    const done = loadBootstrap();
    const early = useTabs.getState().loadTabs('p2');      // before the socket: waits for the bootstrap
    useConnection.getState().setStatus('open');
    const late = useTabs.getState().loadTabs('p1');       // after the socket: its own request
    await late;
    expect(calls).toEqual(['/api/bootstrap', '/api/sessions/p1/terminals']);
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1-net']);
    release(new Response(JSON.stringify(BOOT), { status: 200 }));
    await done;
    await early;
    expect(useTabs.getState().byProject.p2.map((t) => t.id)).toEqual(['t2', 't3']);
    // The lists nobody asked for are NOT put in: the socket is open, an event-driven load may be newer.
    expect(useTabs.getState().byProject.p3).toBeUndefined();
    // And the newer network list of p1 is still there.
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1-net']);
  });

  test('a list that a call asked for is not replaced by the direct fill', async () => {
    let release!: (r: Response) => void;
    network(() => new Promise<Response>((r) => { release = r; }));
    const done = loadBootstrap();
    const mine = useTabs.getState().loadTabs('p1');
    release(new Response(JSON.stringify(BOOT), { status: 200 }));
    await done;
    // Right after the answer the fill has run; p1 is left to its loader, which lands a moment later.
    expect(useTabs.getState().byProject.p2).toBeDefined();
    await mine;
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1']);
    expect(calls).toEqual(['/api/bootstrap']);
  });

  test('after the answer, the first call for a part still gets it; a second call, and any call after the window, goes to the network', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    network(BOOT);
    await loadBootstrap();
    // A first launch: the project cards mount only now, and each asks for its list.
    await useTabs.getState().loadTabs('p1');
    await useThreadStatus.getState().loadStalls();
    expect(calls).toEqual(['/api/bootstrap']);
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1']);
    await useTabs.getState().loadTabs('p1');
    expect(calls).toEqual(['/api/bootstrap', '/api/sessions/p1/terminals']);
    expect(useTabs.getState().byProject.p1.map((t) => t.id)).toEqual(['t1-net']);
    // p2 was never asked for; after the window it goes to the network too.
    vi.advanceTimersByTime(SERVE_AFTER_MS + 1);
    await useTabs.getState().loadTabs('p2');
    expect(calls).toEqual(['/api/bootstrap', '/api/sessions/p1/terminals', '/api/sessions/p2/terminals']);
  });

  test('the api object is put back: after the window, and at once when there is no bootstrap', async () => {
    const before = { listSessions: api.listSessions, listTerminals: api.listTerminals, getUsageSummary: api.getUsageSummary };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    network(BOOT);
    const done = loadBootstrap();
    expect(api.listSessions).not.toBe(before.listSessions);
    await done;
    expect(api.listTerminals).not.toBe(before.listTerminals);
    vi.advanceTimersByTime(SERVE_AFTER_MS + 1);
    expect(api.listSessions).toBe(before.listSessions);
    expect(api.listTerminals).toBe(before.listTerminals);
    expect(api.getUsageSummary).toBe(before.getUsageSummary);

    resetBootstrapForTest();
    network(404);
    await loadBootstrap();
    expect(api.listSessions).toBe(before.listSessions);
  });

  test('the schedules of one project are not the bootstrap part', async () => {
    let release!: (r: Response) => void;
    network(() => new Promise<Response>((r) => { release = r; }));
    void loadBootstrap();
    const one = api.listSchedules('p1').catch(() => 'failed');
    await one;
    expect(calls).toEqual(['/api/bootstrap', '/api/agents/schedules?projectId=p1']);
    release(new Response(JSON.stringify(BOOT), { status: 200 }));
  });
});
