import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useProjectsView } from '../../stores/projectsView';
import { useMobileNav } from '../../stores/mobileNav';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';

// The phone's bottom tabs keep their place (2026-11-07, iOS tab-bar style): each tab remembers the
// screen you left it on, a tap on another tab brings that screen back, and a tap on the tab you are
// on goes back to its root (Projects: one level per tap).

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: window.innerWidth <= 768, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  localStorage.clear();
  useProjectsView.setState({ view: 'projects' });
  useMobileNav.setState({ settingsPluginId: null });
  useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' } as any] });
  const t1 = { id: 't1', sessionId: 's1', type: 'shell', label: 'Fix it', config: {}, archivedAt: null };
  useTabs.setState({ byProject: { s1: [t1 as any] }, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([t1] as any);
  vi.spyOn(api, 'getTerminal').mockReturnValue(new Promise(() => {}) as any);
  vi.spyOn(api, 'listPlugins').mockResolvedValue({ plugins: [{ id: 'coach', name: 'Coach', version: '1.0.0', web: 'web.js', enabled: true, stamp: 1, install: null }] } as any);
  vi.spyOn(api, 'listMarketplaces').mockResolvedValue({ marketplaces: [] } as any);
  vi.spyOn(api, 'pluginCatalog').mockResolvedValue({ entries: [] } as any);
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
  window.history.replaceState({}, '', '/');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

const tab = (name: string) => within(screen.getByTestId('bottom-tabs')).getByRole('button', { name: new RegExp(`^${name}`) });
const level = () => {
  const m = /translateX\(-(\d+)%\)/.exec((screen.getByTestId('mobile-rail') as HTMLElement).style.transform);
  return m ? Number(m[1]) / 100 : -1;
};

describe('MobileApp bottom tabs remember their place', () => {
  it('Settings → a section; Chat; Settings again → back on that section', async () => {
    render(<MobileApp />);
    fireEvent.click(tab('Settings'));
    fireEvent.click(screen.getByText('Dictation'));
    expect(level()).toBe(1);
    fireEvent.click(tab('Chat'));
    await waitFor(() => expect(level()).toBe(0));
    await screen.findByTestId('chat-mode');
    fireEvent.click(tab('Settings'));
    await waitFor(() => expect(history.state).toMatchObject({ nav: 1, settingsSection: 'dictation' }));
    expect(level()).toBe(1);
  });

  it('a tap on Settings while in a section goes back to the Settings list, and the next visit starts there', async () => {
    render(<MobileApp />);
    fireEvent.click(tab('Settings'));
    fireEvent.click(screen.getByText('Dictation'));
    fireEvent.click(tab('Settings'));
    await waitFor(() => expect(level()).toBe(0));
    expect(history.state?.depth ?? 0).toBe(0);
    fireEvent.click(tab('Chat'));
    fireEvent.click(tab('Settings'));
    await new Promise((r) => setTimeout(r, 30));
    expect(level()).toBe(0);
  });

  it('Plugins → a plugin screen; Projects; Plugins again → back on that screen; a tap on Plugins → the list', async () => {
    usePluginRegistry.getState().register('coach', { views: [{ id: 'v', label: 'Coach', Component: () => <div>coach screen</div> }] });
    render(<MobileApp />);
    fireEvent.click(tab('Plugins'));
    fireEvent.click(screen.getByRole('button', { name: /^Coach/ }));
    expect(screen.getByTestId('plugin-title')).toBeInTheDocument();
    fireEvent.click(tab('Projects'));
    await waitFor(() => expect(level()).toBe(0));
    expect(screen.queryByTestId('plugin-title')).toBeNull();
    fireEvent.click(tab('Plugins'));
    await waitFor(() => expect(screen.getByTestId('plugin-title')).toBeInTheDocument());
    expect(level()).toBe(1);
    expect(screen.getByText('coach screen')).toBeInTheDocument();
    expect(history.state).toMatchObject({ nav: 1, pluginView: 'plugin:coach:v' });
    fireEvent.click(tab('Plugins'));
    await waitFor(() => expect(level()).toBe(0));
    expect(screen.queryByTestId('plugin-title')).toBeNull();
  });

  it("Projects → a project's thread list; Settings; Projects again → back in that project", async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByText('Proj'));
    expect(level()).toBe(1);
    fireEvent.click(tab('Settings'));
    await waitFor(() => expect(level()).toBe(0));
    fireEvent.click(tab('Projects'));
    await waitFor(() => expect(history.state).toMatchObject({ nav: 1, projectId: 's1' }));
    expect(level()).toBe(1);
    expect(screen.getByRole('button', { name: 'Project menu' })).toBeInTheDocument();
  });

  it('Projects → a thread; Settings → a section; Projects → back in the thread; Settings → back on the section', async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByText('Proj'));
    fireEvent.click(await screen.findByText('Fix it'));
    expect(level()).toBe(2);
    fireEvent.click(tab('Settings'));
    await waitFor(() => expect(level()).toBe(0));
    fireEvent.click(screen.getByText('Dictation'));
    expect(level()).toBe(1);
    fireEvent.click(tab('Projects'));
    await waitFor(() => expect(level()).toBe(2));
    expect(history.state).toMatchObject({ nav: 2, tabId: 't1', depth: 2 });
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Fix it');
    fireEvent.click(tab('Settings'));
    await waitFor(() => expect(history.state).toMatchObject({ nav: 1, settingsSection: 'dictation', depth: 1 }));
    expect(level()).toBe(1);
  });

  it('a tap on Projects while on it goes up one level per tap: thread → project → the list', async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByText('Proj'));
    fireEvent.click(await screen.findByText('Fix it'));
    fireEvent.click(tab('Projects'));
    await waitFor(() => expect(level()).toBe(1));
    fireEvent.click(tab('Projects'));
    await waitFor(() => expect(level()).toBe(0));
  });

  it('Settings → Plugins → a plugin page; Chat; Settings → back on the plugin page; back → the plugins list', async () => {
    render(<MobileApp />);
    fireEvent.click(tab('Settings'));
    fireEvent.click(screen.getByText('Plugins'));
    const item = await screen.findByTestId('plugin-row-coach');
    fireEvent.click(within(item).getByRole('button', { name: /^Open / }));
    await screen.findByTestId('plugin-detail-coach');
    // The page shows in the Settings screen, under the app header, with the tab bar still there.
    expect(screen.getByRole('button', { name: 'Back to Plugins' }).closest('header')).toBeInTheDocument();
    expect(history.state).toMatchObject({ nav: 1, settingsSection: 'plugins', pluginDetail: 'coach' });
    fireEvent.click(tab('Chat'));
    await waitFor(() => expect(level()).toBe(0));
    await screen.findByTestId('chat-mode');
    expect(screen.queryByTestId('plugin-detail-coach')).toBeNull();
    fireEvent.click(tab('Settings'));
    await screen.findByTestId('plugin-detail-coach');
    expect(history.state).toMatchObject({ nav: 1, settingsSection: 'plugins', pluginDetail: 'coach', depth: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Plugins' }));
    await waitFor(() => expect(screen.queryByTestId('plugin-detail-coach')).toBeNull());
    expect(await screen.findByTestId('plugin-row-coach')).toBeInTheDocument();
    expect(level()).toBe(1);
  });

  it('a tap on Settings while on a plugin page goes to the Settings list', async () => {
    render(<MobileApp />);
    fireEvent.click(tab('Settings'));
    fireEvent.click(screen.getByText('Plugins'));
    const item = await screen.findByTestId('plugin-row-coach');
    fireEvent.click(within(item).getByRole('button', { name: /^Open / }));
    await screen.findByTestId('plugin-detail-coach');
    fireEvent.click(tab('Settings'));
    await waitFor(() => expect(level()).toBe(0));
    expect(screen.queryByTestId('plugin-detail-coach')).toBeNull();
    expect(useMobileNav.getState().settingsPluginId).toBeNull();
  });

  it('a tap on a promoted plugin tab while on it scrolls it back to the top', async () => {
    usePluginRegistry.getState().register('a', { views: [{ id: 'v', label: 'Alpha', Component: () => <div data-testid="alpha-scroll" style={{ overflowY: 'auto' }}>alpha</div> }] });
    usePluginRegistry.getState().setPromoted(['plugin:a:v']);
    render(<MobileApp />);
    fireEvent.click(tab('Alpha'));
    const box = screen.getByTestId('alpha-scroll');
    box.scrollTop = 120;
    expect(box.scrollTop).toBe(120);
    fireEvent.click(tab('Alpha'));
    expect(box.scrollTop).toBe(0);
  });
});
