import { render, screen, fireEvent, waitFor, within, act, renderHook } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useProjectsView } from '../../stores/projectsView';
import { useMobileNav } from '../../stores/mobileNav';
import { useUI } from '../../stores/ui';
import { useNavigation } from '../../stores/navigation';
import { useThreadStatus } from '../../stores/threadStatus';
import { useSectionCollapse } from '../../stores/sectionCollapse';
import { openNextAttention, __resetAttentionForTest } from '../../lib/attention';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';

// W2-F (2026-11-09): the phone shell's navigation lives in useMobileNavigation, on the navigation
// store. These tests drive it through MobileApp: thread links, back and forward, a reload on a link,
// an id that does not exist, the four former pending intents, and the attention queue.

const t = (id: string, sessionId: string, label: string, over: Record<string, unknown> = {}) =>
  ({ id, sessionId, type: 'shell', label, status: 'waiting', config: {}, archivedAt: null, createdAt: '2026-11-09T10:00:00Z', lastActivityAt: '2026-11-09T10:00:00Z', ...over }) as any;
let lists: Record<string, any[]>;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: window.innerWidth <= 768, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  localStorage.clear();
  useProjectsView.setState({ view: 'projects' });
  useMobileNav.setState({ sub: null });
  useSectionCollapse.setState({ collapsed: {} });
  useThreadStatus.setState({ byTerminal: {}, stalls: {} });
  __resetAttentionForTest();
  useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'waiting' }, { id: 's2', name: 'Other', workingDir: '/tmp/o', provider: 'claude-code', status: 'waiting' }] as any, activeId: null });
  lists = { s1: [t('t1', 's1', 'Fix it'), t('f1', 's1', 'notes.txt', { type: 'file', config: { path: 'notes.txt' } })], s2: [t('t2', 's2', 'Ship it')] };
  useTabs.setState({ byProject: { ...lists }, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockImplementation(async (pid: string) => { if (!lists[pid]) throw new Error('404'); return lists[pid]; });
  vi.spyOn(api, 'getTerminal').mockReturnValue(new Promise(() => {}) as any);
  vi.spyOn(api, 'listStalls').mockResolvedValue([]);
  vi.spyOn(api, 'listPlugins').mockResolvedValue({ plugins: [] } as any);
  vi.spyOn(api, 'listMarketplaces').mockResolvedValue({ marketplaces: [] } as any);
  vi.spyOn(api, 'pluginCatalog').mockResolvedValue({ entries: [] } as any);
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
  window.history.pushState({}, '', '/');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

const level = () => {
  const m = /translateX\(-(\d+)%\)/.exec((screen.getByTestId('mobile-rail') as HTMLElement).style.transform);
  return m ? Number(m[1]) / 100 : -1;
};
const path = () => window.location.pathname;
const go = async (delta: number, expectPath: string) => { act(() => { window.history.go(delta); }); await waitFor(() => expect(path()).toBe(expectPath)); };

describe('a thread link on the phone (/p/:project/t/:thread)', () => {
  it('opens the thread, keeps the address, and back walks thread → project → list; forward walks down again', async () => {
    window.history.pushState({}, '', '/p/s1/t/t1');
    render(<MobileApp />);
    expect(level()).toBe(2);
    expect(path()).toBe('/p/s1/t/t1');
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Fix it');
    expect(useTabs.getState().activeTabId).toBe('t1');
    expect(useProjects.getState().activeId).toBe('s1');
    expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 's1', threadId: 't1' });

    await go(-1, '/p/s1');
    await waitFor(() => expect(level()).toBe(1));
    expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 's1' });
    await go(-1, '/');
    await waitFor(() => expect(level()).toBe(0));
    await go(1, '/p/s1');
    await waitFor(() => expect(level()).toBe(1));
    await go(1, '/p/s1/t/t1');
    await waitFor(() => expect(level()).toBe(2));
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Fix it');
  });

  it('a reload on the link opens the thread again, with the same back stack', async () => {
    window.history.pushState({}, '', '/p/s1/t/t1');
    const first = render(<MobileApp />);
    expect(level()).toBe(2);
    first.unmount(); // the page goes away; the address stays
    expect(path()).toBe('/p/s1/t/t1');
    render(<MobileApp />);
    expect(level()).toBe(2);
    expect(path()).toBe('/p/s1/t/t1');
    expect(history.state).toMatchObject({ nav: 2, tabId: 't1', depth: 2 });
    await go(-1, '/p/s1');
    await waitFor(() => expect(level()).toBe(1));
  });

  it('a link to a thread that does not exist lands on its project', async () => {
    window.history.pushState({}, '', '/p/s1/t/gone');
    render(<MobileApp />);
    await waitFor(() => expect(path()).toBe('/p/s1'));
    await waitFor(() => expect(level()).toBe(1));
    expect(screen.queryByTestId('thread-title')).toBeNull();
  });

  it('a link to a project that does not exist lands on the list', async () => {
    lists.nope = []; // the daemon answers an empty list for an id it does not know
    vi.spyOn(api, 'listSessions').mockResolvedValue(useProjects.getState().sessions as any);
    window.history.pushState({}, '', '/p/nope/t/t9');
    const a = render(<MobileApp />);
    await waitFor(() => expect(path()).toBe('/'));
    await waitFor(() => expect(level()).toBe(0));
    a.unmount();
    window.history.pushState({}, '', '/p/nope');
    render(<MobileApp />);
    await waitFor(() => expect(path()).toBe('/'));
    await waitFor(() => expect(level()).toBe(0));
  });

  it('a link whose project cannot be read stays where it is (offline is not "gone")', async () => {
    window.history.pushState({}, '', '/p/nope/t/t9');
    render(<MobileApp />);
    await act(async () => {});
    expect(path()).toBe('/p/nope/t/t9');
    expect(level()).toBe(2);
  });

  it('a path the app does not know opens the list', () => {
    window.history.pushState({}, '', '/no/such/page');
    render(<MobileApp />);
    expect(level()).toBe(0);
    expect(path()).toBe('/');
  });

  it('an agent link opens the agent pane on the same rail', async () => {
    vi.spyOn(api, 'listRuns').mockResolvedValue([] as any);
    window.history.pushState({}, '', '/p/s1/a/sched-1');
    render(<MobileApp />);
    expect(level()).toBe(2);
    expect(path()).toBe('/p/s1/a/sched-1');
    expect(history.state).toMatchObject({ nav: 2, leaf: 'agent', agentId: 'sched-1' });
  });

  it('the desktop addresses open their tab on the phone', async () => {
    window.history.pushState({}, '', '/settings/dictation');
    const a = render(<MobileApp />);
    await waitFor(() => expect(history.state).toMatchObject({ nav: 1, settingsSection: 'dictation' }));
    expect(level()).toBe(1);
    a.unmount();
    window.history.pushState({}, '', '/chat');
    render(<MobileApp />);
    expect(await screen.findByTestId('chat-mode')).toBeInTheDocument();
    expect(level()).toBe(0);
  });
});

describe('the former pending intents on the phone are navigate', () => {
  it('open thread: straight to the thread of another project, one entry above the list', async () => {
    render(<MobileApp />);
    act(() => { useUI.getState().requestOpenThread({ sessionId: 's2', terminalId: 't2' }); });
    expect(level()).toBe(2);
    expect(path()).toBe('/p/s2/t/t2');
    expect(history.state).toMatchObject({ nav: 2, projectId: 's2', tabId: 't2', depth: 1 });
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Ship it');
    await go(-1, '/');
    await waitFor(() => expect(level()).toBe(0));
  });

  it('open tab: a file tab of the project that shows opens on top of the thread', async () => {
    window.history.pushState({}, '', '/p/s1/t/t1');
    render(<MobileApp />);
    act(() => { useUI.getState().requestOpenTab('f1'); });
    expect(path()).toBe('/p/s1/t/f1');
    expect(history.state).toMatchObject({ nav: 2, tabId: 'f1', depth: 3 });
    await go(-1, '/p/s1/t/t1');
    await waitFor(() => expect(screen.getByTestId('thread-title')).toHaveTextContent('Fix it'));
  });

  it('open project: the Projects tab, then the project', async () => {
    render(<MobileApp />);
    fireEvent.click(within(screen.getByTestId('bottom-tabs')).getByRole('button', { name: /^Chat/ }));
    await screen.findByTestId('chat-mode');
    act(() => { useUI.getState().requestOpenProject('s2'); });
    expect(path()).toBe('/p/s2');
    expect(level()).toBe(1);
    expect(screen.queryByTestId('chat-mode')).toBeNull();
  });

  it('open settings: the Settings tab, then the section', async () => {
    window.history.pushState({}, '', '/p/s1/t/t1');
    render(<MobileApp />);
    act(() => { useUI.getState().requestSettings('dictation'); });
    await waitFor(() => expect(history.state).toMatchObject({ nav: 1, settingsSection: 'dictation' }));
    expect(level()).toBe(1);
    expect(path()).toBe('/');
    // Nothing is left pending on the UI store.
    expect(Object.keys(useUI.getState()).filter((k) => k.startsWith('pending'))).toEqual([]);
  });

  it('open settings from the list (no walk back needed) opens the section at once', () => {
    render(<MobileApp />);
    act(() => { useUI.getState().requestSettings('dictation'); });
    expect(history.state).toMatchObject({ nav: 1, settingsSection: 'dictation', depth: 1 });
    expect(level()).toBe(1);
  });

  it('navigate to a view shows that bottom tab at its root', async () => {
    window.history.pushState({}, '', '/p/s1');
    render(<MobileApp />);
    act(() => { useNavigation.getState().navigate({ view: 'chat' }); });
    await screen.findByTestId('chat-mode');
    await waitFor(() => expect(level()).toBe(0));
    expect(path()).toBe('/');
  });

  it('leaving the phone shell hands navigate back to the desktop path', () => {
    const { unmount } = render(<MobileApp />);
    unmount();
    act(() => { useNavigation.getState().navigate({ view: 'workspace', projectId: 's2', threadId: 't2' }); });
    expect(path()).toBe('/p/s2/t/t2');
    expect(history.state).not.toMatchObject({ nav: 2 });
  });
});

describe('the attention queue on the phone', () => {
  beforeEach(() => {
    lists.s1 = [t('t1', 's1', 'Fix it'), t('ask', 's1', 'Which database?', { status: 'needs_input', lastActivityAt: '2026-11-09T09:00:00Z' })];
    lists.s2 = [t('t2', 's2', 'Ship it', { status: 'error', lastActivityAt: '2026-11-09T08:00:00Z' })];
    useTabs.setState({ byProject: { ...lists } });
  });

  it('"Needs you" heads the project list; a row opens the thread; there is no Answer button and nothing inside the thread', async () => {
    render(<MobileApp />);
    const section = screen.getByRole('region', { name: 'Needs you' });
    expect(section).toHaveTextContent('Needs you (2)');
    expect(within(section).getAllByRole('listitem').map((r) => r.getAttribute('data-attention-id'))).toEqual(['ask', 't2']);
    expect(within(section).queryByRole('button', { name: /answer/i })).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: /Which database/ }));
    expect(level()).toBe(2);
    expect(path()).toBe('/p/s1/t/ask');
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Which database?');
    // The thread screen has no strip and no Answer shortcut for the question.
    expect(screen.queryByText(/asking you/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^answer/i })).toBeNull();
    await go(-1, '/');
    await waitFor(() => expect(level()).toBe(0));
  });

  it('"next" opens the first item, then the one after it', async () => {
    render(<MobileApp />);
    act(() => { openNextAttention(); });
    expect(path()).toBe('/p/s1/t/ask');
    act(() => { openNextAttention(); });
    expect(path()).toBe('/p/s2/t/t2');
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Ship it');
  });

  it('the Threads list has the Status filter on the phone', async () => {
    useProjectsView.setState({ view: 'threads' });
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: /^Needs you/ }));
    const rows = () => Array.from(document.querySelectorAll('[data-thread-id]')).map((r) => r.getAttribute('data-thread-id')).sort();
    await waitFor(() => expect(rows()).toEqual(['ask', 't2']));
  });
});

describe('the base path prefix on the phone', () => {
  afterEach(() => { document.querySelector('base')?.remove(); vi.resetModules(); });

  it('a prefixed thread link opens the thread, and every entry keeps the prefix', async () => {
    const base = document.createElement('base');
    base.href = '/u/dw/dispatch/';
    document.head.appendChild(base);
    vi.resetModules();
    const { useMobileNavigation } = await import('./useMobileNavigation');
    const tabs = (await import('../../stores/tabs')).useTabs;
    const apiMod = (await import('../../api/client')).api;
    vi.spyOn(apiMod, 'listTerminals').mockResolvedValue(lists.s1);
    tabs.setState({ byProject: { ...lists }, openTabIds: [], activeTabId: null, tabSession: {} });
    window.history.pushState({}, '', '/u/dw/dispatch/p/s1/t/t1');
    const { result, unmount } = renderHook(() => useMobileNavigation());
    expect(result.current.level).toBe(2);
    expect(result.current.leafTabId).toBe('t1');
    expect(path()).toBe('/u/dw/dispatch/p/s1/t/t1');
    await go(-1, '/u/dw/dispatch/p/s1');
    await waitFor(() => expect(result.current.level).toBe(1));
    await go(-1, '/u/dw/dispatch/');
    await waitFor(() => expect(result.current.level).toBe(0));
    act(() => { result.current.openThreadFromList('s2', 't2'); });
    expect(path()).toBe('/u/dw/dispatch/p/s2/t/t2');
    unmount();
  });
});
