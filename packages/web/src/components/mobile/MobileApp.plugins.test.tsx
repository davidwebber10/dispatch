import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';
import { useProjects } from '../../stores/projects';

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: window.innerWidth <= 768, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([] as any);
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
  localStorage.clear();
  window.history.pushState({}, '', '/');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tabLabels = () => within(screen.getByTestId('bottom-tabs')).getAllByRole('button').map((b) => b.textContent);

describe('MobileApp plugin screens (2026-11-07)', () => {
  it('with no plugin views the tab bar has four tabs', () => {
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Settings']);
  });

  it('with a plugin view the Plugins tab appears and lists it; tapping opens the view', () => {
    usePluginRegistry.getState().register('daily-rundown', { views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', Component: () => <div>rundown screen</div> }] });
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Plugins', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    const row = screen.getByRole('button', { name: /Rundown/ });
    expect(row).toHaveTextContent('daily-rundown');
    fireEvent.click(row);
    expect(screen.getByText('rundown screen')).toBeInTheDocument();
  });

  it('the Plugins tab says where to find plugins when none has a screen but a plugin exists', () => {
    usePluginRegistry.getState().register('only-settings', { settings: [{ id: 's', label: 'S', Component: () => null }] });
    usePluginRegistry.setState({ manifests: [{ id: 'only-settings', name: 'Only settings', version: '1', enabled: true, stamp: 1, install: null }] });
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Plugins', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(screen.getByText(/No plugin screens yet/)).toBeInTheDocument();
  });

  it('a promoted view gets its own tab before Plugins; at most two', () => {
    const reg = usePluginRegistry.getState().register;
    reg('a', { views: [{ id: 'v', label: 'Alpha', Component: () => <div>alpha screen</div> }] });
    reg('b', { views: [{ id: 'v', label: 'Beta', Component: () => null }] });
    reg('c', { views: [{ id: 'v', label: 'Gamma', Component: () => null }] });
    usePluginRegistry.getState().setPromoted(['plugin:a:v', 'plugin:b:v', 'plugin:c:v']);
    render(<MobileApp />);
    expect(tabLabels()).toEqual(['Projects', 'Chat', 'Analytics', 'Alpha', 'Beta', 'Plugins', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(screen.getByText('alpha screen')).toBeInTheDocument();
  });

  it('a badge on a promoted view shows its count on that tab and dots the Plugins tab for an unpromoted one', () => {
    const reg = usePluginRegistry.getState().register;
    reg('a', { views: [{ id: 'v', label: 'Alpha', Component: () => null }] });
    reg('b', { views: [{ id: 'v', label: 'Beta', Component: () => null }] });
    usePluginRegistry.getState().setPromoted(['plugin:a:v']);
    usePluginRegistry.getState().setBadge('plugin:a:v', 4);
    usePluginRegistry.getState().setBadge('plugin:b:v', 1);
    render(<MobileApp />);
    const tabs = screen.getByTestId('bottom-tabs');
    expect(within(tabs).getByRole('button', { name: /Alpha/ })).toHaveTextContent('4');
    expect(within(within(tabs).getByRole('button', { name: /Plugins/ })).getByRole('status', { name: 'Plugin news' })).toBeInTheDocument();
    expect(within(within(tabs).getByRole('button', { name: /Alpha/ })).queryByRole('status')).toBeNull();
  });
});

describe('MobileApp plugin slots (plugins slice 4)', () => {
  it('project.header.actions renders before the project ⋯ with the session; app.overlay renders at the root', () => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' } as any] });
    usePluginRegistry.getState().register('previews', { slots: [
      { id: 'eye', slot: 'project.header.actions', Component: ({ session }: any) => <button type="button">eye for {session?.name}</button> },
      { id: 'sheet', slot: 'app.overlay', Component: () => <div>the sheet</div> },
    ] });
    window.history.pushState({}, '', '/p/s1');
    render(<MobileApp />);
    const eye = screen.getByRole('button', { name: 'eye for Proj' });
    const menu = screen.getByRole('button', { name: 'Project menu' });
    expect(eye.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('the sheet')).toBeInTheDocument();
  });

  it('thread.header.actions renders before the thread ⋯ with the terminal', () => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' } as any] });
    useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix it', config: { transport: 'structured' } } as any] } });
    vi.spyOn(api, 'getTerminal').mockResolvedValue({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix it', config: { transport: 'structured' } } as any);
    usePluginRegistry.getState().register('previews', { slots: [
      { id: 'eye', slot: 'thread.header.actions', Component: ({ terminal }: any) => <button type="button">eye for {terminal?.label}</button> },
    ] });
    window.history.pushState({}, '', '/p/s1/t/t1');
    render(<MobileApp />);
    const eye = screen.getByRole('button', { name: 'eye for Fix it' });
    const menu = screen.getByRole('button', { name: 'Thread menu' });
    expect(eye.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('MobileApp plugin right-column tabs (inspectorTabs)', () => {
  it("the thread's ⋯ menu lists each plugin tab; tapping one opens its component in a sheet with the thread and project ids", () => {
    const t1 = { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix it', config: { transport: 'structured' } };
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' } as any] });
    useTabs.setState({ byProject: { s1: [t1 as any] } });
    vi.spyOn(api, 'getTerminal').mockResolvedValue(t1 as any);
    vi.spyOn(api, 'listTerminals').mockResolvedValue([t1] as any);
    usePluginRegistry.getState().register('notes', { inspectorTabs: [{ id: 'n', label: 'Notes', icon: 'note', Component: ({ terminalId, sessionId }) => <div>notes for {terminalId} in {sessionId}</div> }] });
    window.history.pushState({}, '', '/p/s1/t/t1');
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Thread menu' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Notes/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    const sheet = screen.getByTestId('sheet-panel');
    expect(sheet).toHaveAttribute('aria-label', 'Notes');
    expect(within(sheet).getByText('notes for t1 in s1')).toBeInTheDocument();
  });

  it('a plugin tab that throws in the sheet shows the plugin error card', () => {
    const t1 = { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix it', config: { transport: 'structured' } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' } as any] });
    useTabs.setState({ byProject: { s1: [t1 as any] } });
    vi.spyOn(api, 'getTerminal').mockResolvedValue(t1 as any);
    vi.spyOn(api, 'listTerminals').mockResolvedValue([t1] as any);
    usePluginRegistry.getState().register('bad', { inspectorTabs: [{ id: 'x', label: 'Bad', Component: () => { throw new Error('kaboom'); } }] });
    window.history.pushState({}, '', '/p/s1/t/t1');
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Thread menu' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Bad/ }));
    expect(within(screen.getByTestId('sheet-panel')).getByRole('alert')).toHaveTextContent('The plugin "bad" failed');
    expect(screen.getByTestId('thread-title')).toHaveTextContent('Fix it');
  });
});
