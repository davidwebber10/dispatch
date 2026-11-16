import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Inspector } from './Inspector';
import { api } from '../../api/client';
import { useUI } from '../../stores/ui';
import { usePluginRegistry } from '../../plugins/registry';

const Ids = ({ terminalId, sessionId }: { terminalId: string | null; sessionId: string | null }) => (
  <div>notes for {String(terminalId)} in {String(sessionId)}</div>
);
const Boom = () => { throw new Error('kaboom'); };

beforeEach(() => {
  vi.spyOn(api, 'getGitStatus').mockResolvedValue({ files: [] } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], commands: [], inspectorTabs: [], promoted: [], manifests: [], status: {}, badges: {} });
  useUI.setState({ inspectorTab: 'details' });
});
afterEach(() => { vi.restoreAllMocks(); });

const tabBar = () => screen.getByRole('tablist', { name: 'Right column' });
const tabNames = () => within(tabBar()).getAllByRole('tab').map((b) => b.textContent);
const show = () => render(<Inspector projectId="s1" terminalId="t1" onOpenFile={() => {}} detailsSlot={<div>details content</div>} />);

describe('Inspector plugin tabs', () => {
  it('a registered plugin tab shows after Details and Files; clicking it renders the component with the thread and project ids', () => {
    usePluginRegistry.getState().register('notes', { inspectorTabs: [{ id: 'n', label: 'Notes', icon: 'note', Component: Ids }] });
    show();
    expect(tabNames()).toEqual(['details', 'files', 'Notes']);
    fireEvent.click(within(tabBar()).getByRole('tab', { name: 'Notes' }));
    expect(useUI.getState().inspectorTab).toBe('plugin:notes:n');
    expect(screen.getByText('notes for t1 in s1')).toBeInTheDocument();
    expect(screen.queryByText('details content')).toBeNull();
  });

  it('plugin tabs order by priority, then plugin id', () => {
    usePluginRegistry.getState().register('zeta', { inspectorTabs: [{ id: 'a', label: 'Zeta', Component: Ids }] });
    usePluginRegistry.getState().register('alpha', { inspectorTabs: [{ id: 'a', label: 'Alpha', Component: Ids }] });
    usePluginRegistry.getState().register('top', { inspectorTabs: [{ id: 'a', label: 'Top', priority: 9, Component: Ids }] });
    show();
    expect(tabNames()).toEqual(['details', 'files', 'Top', 'Alpha', 'Zeta']);
  });

  it("a plugin tab that throws shows the plugin's error card, and the other tabs still work", () => {
    usePluginRegistry.getState().register('bad', { inspectorTabs: [{ id: 'x', label: 'Bad', Component: Boom }] });
    show();
    fireEvent.click(within(tabBar()).getByRole('tab', { name: 'Bad' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The plugin "bad" failed');
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom');
    fireEvent.click(within(tabBar()).getByRole('tab', { name: 'details' }));
    expect(screen.getByText('details content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('unregistering the selected plugin tab falls back to Details', () => {
    usePluginRegistry.getState().register('notes', { inspectorTabs: [{ id: 'n', label: 'Notes', Component: Ids }] });
    show();
    fireEvent.click(within(tabBar()).getByRole('tab', { name: 'Notes' }));
    expect(screen.getByText('notes for t1 in s1')).toBeInTheDocument();
    act(() => usePluginRegistry.getState().unregister('notes'));
    expect(screen.getByText('details content')).toBeInTheDocument();
    expect(useUI.getState().inspectorTab).toBe('details');
    expect(tabNames()).toEqual(['details', 'files']);
  });

  it('keeps the selected plugin tab while that plugin reloads (status loading)', () => {
    usePluginRegistry.getState().register('notes', { inspectorTabs: [{ id: 'n', label: 'Notes', Component: Ids }] });
    show();
    fireEvent.click(within(tabBar()).getByRole('tab', { name: 'Notes' }));
    act(() => {
      usePluginRegistry.getState().unregister('notes');
      usePluginRegistry.getState().setStatus('notes', { state: 'loading', at: 1 });
    });
    expect(useUI.getState().inspectorTab).toBe('plugin:notes:n');
    act(() => usePluginRegistry.getState().register('notes', { inspectorTabs: [{ id: 'n', label: 'Notes', Component: Ids }] }));
    expect(screen.getByText('notes for t1 in s1')).toBeInTheDocument();
  });

  it('passes null ids when no thread is open', () => {
    usePluginRegistry.getState().register('notes', { inspectorTabs: [{ id: 'n', label: 'Notes', Component: Ids }] });
    useUI.setState({ inspectorTab: 'plugin:notes:n' });
    render(<Inspector projectId={null} terminalId={null} onOpenFile={() => {}} />);
    expect(screen.getByText('notes for null in null')).toBeInTheDocument();
  });
});

// Owner, 2026-11-13: the desktop right column's Details tab mirrors the right-click menu.
describe('Details tab: the thread actions', () => {
  it('shows the right-click menu\'s tiles and rows for the open thread', async () => {
    const { useTabs } = await import('../../stores/tabs');
    const { useProjects } = await import('../../stores/projects');
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/x', provider: 'claude-code', status: 'waiting' } as any] });
    useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix login', status: 'idle', config: {}, createdAt: '' } as any] } } as any);
    vi.spyOn(api, 'getTerminal').mockResolvedValue({ id: 't1', workingDir: '/tmp/x', pid: 1, status: 'idle' } as any);
    vi.spyOn(api, 'getGitInfo').mockResolvedValue({ branch: 'main' } as any);
    vi.spyOn(api, 'getUsageLimits').mockResolvedValue(null as any);
    useUI.setState({ inspectorTab: 'details' } as any);
    render(<Inspector projectId="s1" terminalId="t1" onOpenFile={() => {}} />);
    expect(await screen.findByRole('group', { name: 'Quick actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download thread' })).toBeInTheDocument();
  });
});
