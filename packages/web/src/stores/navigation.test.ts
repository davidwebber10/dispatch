import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useNavigation, bootDesktopNavigation, stopDesktopSync, setMobileDriver, storeRoute, __resetNavigationForTest } from './navigation';
import { useUI } from './ui';
import { useTabs, dispatchTabId } from './tabs';
import { useProjects } from './projects';
import { useAgentUI } from './agentUI';
import { useAgents } from './agents';
import { api } from '../api/client';
import type { Terminal } from '../api/types';

const term = (id: string, sessionId: string): Terminal => ({ id, sessionId, type: 'claude-code', label: id, pid: null, externalId: null, workingDir: null, status: 'waiting', createdAt: '2026-11-09T00:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0 } as Terminal);
const thread = (projectId: string, threadId: string) => ({ view: 'workspace' as const, projectId, threadId });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // A push, not a replace: it drops the forward entries an earlier test left, so `history.length` counts pushes again.
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
  vi.spyOn(api, 'listTerminals').mockImplementation(async (pid: string) => (useTabs.getState().byProject[pid] ?? []) as never);
  vi.spyOn(api, 'listRuns').mockResolvedValue([] as never);
  useTabs.setState({ byProject: { A: [term('T1', 'A'), term('T2', 'A')], B: [term('T3', 'B')] }, openTabIds: [], activeTabId: null, tabSession: {} });
  useProjects.setState({ sessions: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] as never, activeId: null });
  useUI.setState({ view: 'workspace' });
  useAgentUI.setState({ focused: false });
  useAgents.setState({ selectedId: null });
  setMobileDriver(null);
  __resetNavigationForTest();
});
afterEach(() => { stopDesktopSync(); setMobileDriver(null); });

describe('navigate (desktop)', () => {
  it('navigate pushes one history entry and sets the active tab', () => {
    const before = window.history.length;
    useNavigation.getState().navigate(thread('A', 'T1'));
    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname).toBe('/p/A/t/T1');
    expect(useTabs.getState().activeTabId).toBe('T1');
    expect(useProjects.getState().activeId).toBe('A');
    expect(useNavigation.getState().route).toEqual(thread('A', 'T1'));
  });

  it('popstate restores the earlier thread, and forward goes to the later one again', async () => {
    const nav = useNavigation.getState();
    nav.navigate(thread('A', 'T1'));
    nav.navigate(thread('B', 'T3'));
    expect(useTabs.getState().activeTabId).toBe('T3');
    nav.back();
    await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T1'));
    expect(useProjects.getState().activeId).toBe('A');
    expect(window.location.pathname).toBe('/p/A/t/T1');
    expect(useNavigation.getState().route).toEqual(thread('A', 'T1'));
    window.history.forward();
    await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T3'));
    expect(useProjects.getState().activeId).toBe('B');
    expect(useNavigation.getState().route).toEqual(thread('B', 'T3'));
  });

  it('replace does not add an entry', () => {
    useNavigation.getState().navigate(thread('A', 'T1'));
    const before = window.history.length;
    useNavigation.getState().navigate(thread('A', 'T2'), { replace: true });
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe('/p/A/t/T2');
    expect(useTabs.getState().activeTabId).toBe('T2');
  });

  it('a second navigate to the address that is open adds no entry', () => {
    useNavigation.getState().navigate(thread('A', 'T1'));
    const before = window.history.length;
    useNavigation.getState().navigate(thread('A', 'T1'));
    expect(window.history.length).toBe(before);
  });

  it('a route to a thread that does not exist falls back to its project', async () => {
    const before = window.history.length;
    useNavigation.getState().navigate(thread('A', 'gone'));
    await waitFor(() => expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 'A' }));
    expect(window.location.pathname).toBe('/p/A');
    expect(useProjects.getState().activeId).toBe('A');
    expect(useTabs.getState().activeTabId).toBeNull();
    expect(window.history.length).toBe(before + 1); // the entry of the navigate, with its address corrected
  });

  it('a route to a thread of a project that does not exist falls back to the root', async () => {
    vi.spyOn(api, 'listTerminals').mockRejectedValue(new Error('404'));
    useNavigation.getState().navigate(thread('nope', 'T9'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(useNavigation.getState().route).toEqual({ view: 'workspace' });
    expect(useProjects.getState().activeId).toBeNull();
  });

  // The daemon answers an empty thread list (200) for a project id it does not know, so the project list decides.
  it('an unknown project id falls back to the root, for a thread route and for a project route', async () => {
    const sessions = useProjects.getState().sessions;
    vi.spyOn(api, 'listSessions').mockResolvedValue(sessions as never);
    vi.spyOn(api, 'listTerminals').mockResolvedValue([] as never);
    useNavigation.getState().navigate(thread('nope', 'T9'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(useNavigation.getState().route).toEqual({ view: 'workspace' });
    expect(useProjects.getState().activeId).not.toBe('nope');
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'nope' });
    expect(window.location.pathname).toBe('/p/nope');
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(useProjects.getState().activeId).toBe('A'); // the first project, not the id that names nothing
    // With the address sync on (the running app), the root then gets the address of what shows.
    await bootDesktopNavigation();
    expect(window.location.pathname).toBe('/p/A');
  });

  it('a project that arrives with the list (the list was not loaded yet) is kept', async () => {
    useProjects.setState({ sessions: [], activeId: null });
    vi.spyOn(api, 'listSessions').mockResolvedValue([{ id: 'B', name: 'Beta' }] as never);
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'B' });
    await tick(); await tick();
    expect(window.location.pathname).toBe('/p/B');
    expect(useProjects.getState().activeId).toBe('B');
  });

  it('offline (the project list cannot be read), an unknown project id is kept', async () => {
    vi.spyOn(api, 'listSessions').mockRejectedValue(new Error('offline'));
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'later' });
    await tick(); await tick();
    expect(window.location.pathname).toBe('/p/later');
    expect(useProjects.getState().activeId).toBe('later');
  });

  it('a thread that this client has not loaded yet opens after its project loads', async () => {
    useTabs.setState({ byProject: {} });
    vi.spyOn(api, 'listTerminals').mockResolvedValue([term('T7', 'B')] as never);
    useNavigation.getState().navigate(thread('B', 'T7'));
    await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T7'));
    expect(window.location.pathname).toBe('/p/B/t/T7');
  });

  it('a slow load of an older navigate does not override a newer one', async () => {
    let release: (v: Terminal[]) => void = () => {};
    vi.spyOn(api, 'listTerminals').mockImplementation(() => new Promise<Terminal[]>((r) => { release = r; }) as never);
    useNavigation.getState().navigate(thread('A', 'slow'));
    useNavigation.getState().navigate(thread('B', 'T3'));
    expect(useTabs.getState().activeTabId).toBe('T3');
    release([term('slow', 'A')]);
    await tick(); await tick();
    expect(useTabs.getState().activeTabId).toBe('T3');
    expect(window.location.pathname).toBe('/p/B/t/T3');
  });

  it('every view has an address, and the view store follows', () => {
    const nav = useNavigation.getState();
    nav.navigate({ view: 'settings', section: 'secrets' });
    expect(window.location.pathname).toBe('/settings/secrets');
    expect(useUI.getState().view).toBe('settings');
    nav.navigate({ view: 'chat' });
    expect([window.location.pathname, useUI.getState().view]).toEqual(['/chat', 'chat']);
    nav.navigate({ view: 'analytics' });
    expect([window.location.pathname, useUI.getState().view]).toEqual(['/analytics', 'analytics']);
    nav.navigate({ view: 'plugin:previews:history' });
    expect([window.location.pathname, useUI.getState().view]).toEqual(['/x/previews:history', 'plugin:previews:history']);
    nav.navigate({ view: 'workspace', projectId: 'B' });
    expect([window.location.pathname, useUI.getState().view, useProjects.getState().activeId]).toEqual(['/p/B', 'workspace', 'B']);
  });

  it('an agent route selects the agent in its project', () => {
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'B', agentId: 'sched-1' });
    expect(window.location.pathname).toBe('/p/B/a/sched-1');
    expect(useProjects.getState().activeId).toBe('B');
    expect(useAgents.getState().selectedId).toBe('sched-1');
    expect(useAgentUI.getState().focused).toBe(true);
  });

  it('a thread route leaves the agent pane', () => {
    useAgentUI.setState({ focused: true });
    useNavigation.getState().navigate(thread('A', 'T1'));
    expect(useAgentUI.getState().focused).toBe(false);
  });

  it('a project route shows the coordinator tab of that project when it is open', () => {
    useTabs.getState().openDispatch('B');
    useTabs.getState().setActiveTab('T1');
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'B' });
    expect(useTabs.getState().activeTabId).toBe(dispatchTabId('B'));
  });
});

describe('the address follows the app (desktop)', () => {
  it('the first read of the app replaces the entry; a later thread change pushes one', async () => {
    useTabs.getState().setActiveTab('T1');
    const before = window.history.length;
    await bootDesktopNavigation();
    expect(window.location.pathname).toBe('/p/A/t/T1');
    expect(window.history.length).toBe(before);
    useTabs.getState().setActiveTab('T2'); // a click in the sidebar or the tab bar
    expect(window.location.pathname).toBe('/p/A/t/T2');
    expect(window.history.length).toBe(before + 1);
    expect(useNavigation.getState().route).toEqual(thread('A', 'T2'));
    useNavigation.getState().back();
    await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T1'));
    expect(window.history.length).toBe(before + 1); // back and its restore add nothing
  });

  it('a view change from the rail pushes one entry, and back returns to the thread', async () => {
    useTabs.getState().setActiveTab('T1');
    await bootDesktopNavigation();
    const before = window.history.length;
    useUI.getState().setView('analytics');
    expect(window.location.pathname).toBe('/analytics');
    expect(window.history.length).toBe(before + 1);
    useNavigation.getState().back();
    await waitFor(() => expect(useUI.getState().view).toBe('workspace'));
    expect(window.location.pathname).toBe('/p/A/t/T1');
  });

  it('navigate pushes once, not once more through the sync', async () => {
    await bootDesktopNavigation();
    const before = window.history.length;
    useNavigation.getState().navigate(thread('A', 'T1'));
    await tick();
    expect(window.history.length).toBe(before + 1);
  });

  it('the first project after an empty root replaces the entry', async () => {
    await bootDesktopNavigation();
    const before = window.history.length;
    expect(window.location.pathname).toBe('/');
    useProjects.getState().setActive('A'); // the project list arrived
    expect(window.location.pathname).toBe('/p/A');
    expect(window.history.length).toBe(before);
  });

  it('the coordinator tab reads as its project', () => {
    useTabs.getState().openDispatch('B');
    expect(storeRoute()).toEqual({ view: 'workspace', projectId: 'B' });
  });

  it('a settings section stays in the address while Settings shows', async () => {
    await bootDesktopNavigation();
    useNavigation.getState().navigate({ view: 'settings', section: 'secrets' });
    await tick();
    useProjects.getState().setActive('B'); // unrelated store change
    expect(window.location.pathname).toBe('/settings/secrets');
  });
});

describe('boot on a deep link (desktop)', () => {
  it('opens the thread of the address and adds no entry; a reload does the same', async () => {
    for (let reload = 0; reload < 2; reload++) {
      __resetNavigationForTest();
      useTabs.setState({ activeTabId: 'T1', openTabIds: ['T1'] }); // the tab restored from the last visit
      window.history.replaceState({}, '', '/p/B/t/T3');
      const before = window.history.length;
      await bootDesktopNavigation();
      expect(useTabs.getState().activeTabId).toBe('T3');
      expect(useProjects.getState().activeId).toBe('B');
      expect(window.location.pathname).toBe('/p/B/t/T3');
      expect(window.history.length).toBe(before);
      stopDesktopSync();
    }
  });

  it('an unknown thread id lands on its project, an unknown path on what the app shows', async () => {
    window.history.replaceState({}, '', '/p/A/t/nope');
    await bootDesktopNavigation();
    expect(window.location.pathname).toBe('/p/A');
    stopDesktopSync(); __resetNavigationForTest();
    useTabs.getState().setActiveTab('T2');
    window.history.replaceState({}, '', '/no/such/page');
    await bootDesktopNavigation();
    expect(window.location.pathname).toBe('/p/A/t/T2');
  });

  it('a settings address opens Settings at the section', async () => {
    window.history.replaceState({}, '', '/settings/secrets');
    await bootDesktopNavigation();
    expect(useUI.getState().view).toBe('settings');
    expect(useNavigation.getState().route).toEqual({ view: 'settings', section: 'secrets' });
  });
});

describe('the four intents are navigate now', () => {
  it('the pending fields no longer exist on the UI store', () => {
    const s = useUI.getState() as unknown as Record<string, unknown>;
    for (const k of ['pendingOpenTab', 'pendingOpenThread', 'pendingOpenProject', 'pendingSettingsSection', 'clearOpenTab', 'clearOpenThread', 'clearOpenProject', 'clearSettingsRequest']) expect(k in s).toBe(false);
  });

  it('requestOpenThread opens the thread at its address', () => {
    useUI.getState().requestOpenThread({ sessionId: 'B', terminalId: 'T3' });
    expect(window.location.pathname).toBe('/p/B/t/T3');
    expect(useTabs.getState().activeTabId).toBe('T3');
  });

  it('requestOpenTab finds the project of the tab', () => {
    useUI.getState().requestOpenTab('T3');
    expect(window.location.pathname).toBe('/p/B/t/T3');
    expect(useTabs.getState().activeTabId).toBe('T3');
  });

  it('requestOpenProject opens the project in the Threads view', () => {
    useUI.setState({ view: 'chat' });
    useUI.getState().requestOpenProject('B');
    expect(window.location.pathname).toBe('/p/B');
    expect(useProjects.getState().activeId).toBe('B');
    expect(useUI.getState().view).toBe('workspace');
  });

  it('requestSettings opens Settings at the section', () => {
    useUI.getState().requestSettings('dictation');
    expect(window.location.pathname).toBe('/settings/dictation');
    expect(useUI.getState().view).toBe('settings');
    expect(useNavigation.getState().route).toEqual({ view: 'settings', section: 'dictation' });
  });
});

describe('the phone shell drives the same store', () => {
  it('navigate and popstate go to the driver, and the desktop path stays off', async () => {
    const driver = { navigate: vi.fn(), onPop: vi.fn() };
    setMobileDriver(driver);
    const before = window.history.length;
    useNavigation.getState().navigate(thread('A', 'T1'));
    expect(driver.navigate).toHaveBeenCalledWith(thread('A', 'T1'), undefined);
    expect(window.history.length).toBe(before);
    expect(useTabs.getState().activeTabId).toBeNull();
    window.history.pushState({ nav: 1, projectId: 'A', depth: 1 }, '', '/p/A');
    window.history.pushState({ nav: 2, depth: 2 }, '', '/p/A/t/T1');
    window.history.back();
    await waitFor(() => expect(driver.onPop).toHaveBeenCalledTimes(1));
    expect(driver.onPop.mock.calls[0][0]).toMatchObject({ nav: 1, projectId: 'A' });
    expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 'A' });
  });
});

describe('the base path prefix', () => {
  afterEach(() => { document.querySelector('base')?.remove(); vi.resetModules(); });

  it('is added to every address and removed from the address read at boot', async () => {
    const base = document.createElement('base');
    base.href = '/u/dw/dispatch/';
    document.head.appendChild(base);
    vi.resetModules();
    const nav = await import('./navigation');
    const tabs = (await import('./tabs')).useTabs;
    const projects = (await import('./projects')).useProjects;
    const apiMod = (await import('../api/client')).api;
    vi.spyOn(apiMod, 'listTerminals').mockResolvedValue([term('T3', 'B')] as never);
    tabs.setState({ byProject: { A: [term('T1', 'A')], B: [term('T3', 'B')] }, openTabIds: [], activeTabId: null, tabSession: {} });

    nav.useNavigation.getState().navigate(thread('A', 'T1'));
    expect(window.location.pathname).toBe('/u/dw/dispatch/p/A/t/T1');
    expect(tabs.getState().activeTabId).toBe('T1');

    nav.__resetNavigationForTest();
    window.history.replaceState({}, '', '/u/dw/dispatch/p/B/t/T3');
    await nav.bootDesktopNavigation();
    expect(tabs.getState().activeTabId).toBe('T3');
    expect(projects.getState().activeId).toBe('B');
    expect(window.location.pathname).toBe('/u/dw/dispatch/p/B/t/T3');
    nav.stopDesktopSync();
  });
});
