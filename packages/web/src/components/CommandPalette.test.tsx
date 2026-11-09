import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { usePluginRegistry } from '../plugins/registry';
import { useUI } from '../stores/ui';

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], commands: [], promoted: [], manifests: [], status: {}, badges: {} });
  useUI.setState({ view: 'workspace' });
});

describe('the command palette (plugins slice 6)', () => {
  it('⌘K opens it; typing filters; Enter runs a plugin command; Escape closes', () => {
    const run = vi.fn();
    usePluginRegistry.getState().register('p', { commands: [{ id: 'sync', label: 'Sync the rundown', run }, { id: 'other', label: 'Other thing', run: () => {} }] });
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Commands' });
    expect(dialog).toHaveTextContent('Analytics');
    expect(dialog).toHaveTextContent('Sync the rundown');
    fireEvent.change(screen.getByRole('combobox', { name: 'Command' }), { target: { value: 'rund' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Sync the rundown']);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    expect(run).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
  });

  it('a built-in row opens a view', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    fireEvent.click(screen.getByRole('option', { name: 'Analytics' }));
    expect(useUI.getState().view).toBe('analytics');
  });

  it('the shortcut inside the terminal does nothing (Ctrl+K is the shell\'s)', () => {
    render(<div className="xterm"><textarea aria-label="Terminal input" /></div>);
    render(<CommandPalette />);
    const ta = screen.getByLabelText('Terminal input');
    ta.focus();
    fireEvent.keyDown(ta, { key: 'k', metaKey: true, ctrlKey: true, bubbles: true });
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
  });
});

// ── W1-G (2026-11-09): the palette opens projects and threads ────────────────────────────────
import { afterEach } from 'vitest';
import { act, within } from '@testing-library/react';
import type { Session, Terminal } from '../api/types';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { useSettings } from '../stores/settings';
import { usePickerRequest } from '../stores/pickerRequest';
import { useThreadStatus } from '../stores/threadStatus';
import { useNavigation, __resetNavigationForTest } from '../stores/navigation';
import { useHint } from '../stores/hint';
import { waitFor } from '@testing-library/react';

// The real dialog loads harness data. The palette only has to show it; a stub proves that.
vi.mock('./sidebar/NewThreadModal', () => ({
  NewThreadModal: ({ sessionId, onClose }: { sessionId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="New thread"><span>new thread in {sessionId}</span><button onClick={onClose}>Close picker</button></div>
  ),
}));

const session = (id: string, name: string): Session => ({ id, provider: 'claude-code', name, notes: '', status: 'waiting', workingDir: `/tmp/${id}`, tags: [], pid: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', lastActivityAt: '2026-11-01T00:00:00Z', archivedAt: null });
const thread = (id: string, sessionId: string, label: string, status: Terminal['status'], lastActivityAt: string, extra: Partial<Terminal> = {}): Terminal => ({ id, sessionId, type: 'claude-code', label, pid: null, externalId: null, workingDir: null, status, createdAt: '2026-11-01T00:00:00Z', lastActivityAt, config: {}, archivedAt: null, sortOrder: 0, ...extra });

describe('the command palette opens projects and threads (W1-G)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [], text: async () => '[]' });
    vi.stubGlobal('fetch', fetchMock);
    useProjects.setState({ sessions: [session('p1', 'Website'), session('p2', 'Billing')], activeId: 'p1' });
    useTabs.setState({
      byProject: {
        p1: [
          thread('t1', 'p1', 'Fix the login form', 'waiting', '2026-11-09T10:00:00Z'),
          thread('t2', 'p1', 'Write release notes', 'working', '2026-11-09T09:00:00Z'),
          thread('f1', 'p1', 'README.md', 'waiting', '2026-11-09T12:00:00Z', { type: 'file' }),
          thread('c1', 'p1', 'coordinator', 'waiting', '2026-11-09T12:00:00Z', { config: { role: 'coordinator' } }),
        ],
        p2: [
          thread('t3', 'p2', 'Invoice export', 'needs_input', '2026-11-08T08:00:00Z'),
          thread('t4', 'p2', 'Tax rounding', 'error', '2026-11-09T11:00:00Z'),
          thread('t5', 'p2', 'Old thread', 'waiting', '2026-11-09T11:30:00Z', { archivedAt: '2026-11-09T11:40:00Z' }),
        ],
      },
      openTabIds: [], activeTabId: null,
    });
    useSettings.setState({ coordinatorName: 'Control Plane' });
    usePickerRequest.setState({ owner: null });
    useUI.setState({ view: 'workspace' });
    useThreadStatus.setState({ byTerminal: {}, stalls: {} });
    window.history.pushState({}, '', '/');
    __resetNavigationForTest();
  });
  afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

  const open = () => { render(<CommandPalette />); fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true }); };
  const type = (value: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Command' }), { target: { value } });
  const labels = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));

  it('typing part of a thread label lists the thread with its project', () => {
    open();
    type('login');
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveAttribute('aria-label', 'Fix the login form');
    expect(first).toHaveTextContent('Website');
    expect(within(first).getByLabelText('status-idle')).toBeInTheDocument();
  });

  it('Enter opens the thread', () => {
    useUI.setState({ view: 'settings' });
    open();
    type('invoice');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    // W2-F: the thread opens at its address, and Back returns to the screen before.
    expect(window.location.pathname).toBe('/p/p2/t/t3');
    expect(useTabs.getState().activeTabId).toBe('t3');
    expect(useProjects.getState().activeId).toBe('p2');
    expect(useUI.getState().view).toBe('workspace'); // the thread shows in the Threads view
    expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
  });

  it('threads that need input come first with an empty query', () => {
    open();
    // needs input, error, working, then the most recent activity. No file tab, no coordinator row, no archived thread.
    expect(labels().slice(0, 4)).toEqual(['Invoice export', 'Tax rounding', 'Write release notes', 'Fix the login form']);
    expect(labels()).not.toContain('README.md');
    expect(labels()).not.toContain('Old thread');
    expect(labels()).not.toContain('coordinator');
  });

  it('a project row opens the project', () => {
    open();
    type('billing');
    expect(labels()[0]).toBe('Billing');
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(useProjects.getState().activeId).toBe('p2');
    expect(window.location.pathname).toBe('/p/p2');
  });

  it('New thread opens the picker and creates nothing', () => {
    open();
    type('new thread bill');
    expect(labels()[0]).toBe('New thread in Billing');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    expect(usePickerRequest.getState().owner).toBe('new-thread:p2');
    expect(screen.getByRole('dialog', { name: 'New thread' })).toHaveTextContent('new thread in p2');
    expect(fetchMock).not.toHaveBeenCalled(); // no API call: the person creates the thread in the picker
    expect(Object.values(useTabs.getState().byProject).flat()).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Close picker' }));
    expect(usePickerRequest.getState().owner).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'New thread' })).toBeNull();
  });

  it('the virtual tab row shows the coordinator name from settings', () => {
    useSettings.setState({ coordinatorName: 'Houston' });
    open();
    type('houston');
    const rows = screen.getAllByRole('option');
    expect(rows.map((o) => o.getAttribute('aria-label'))).toEqual(['Houston', 'Houston']); // one for each project
    expect(rows[0]).toHaveTextContent('Website');
    fireEvent.click(rows[1]);
    expect(useTabs.getState().activeTabId).toBe('dispatch:p2');
    expect(useProjects.getState().activeId).toBe('p2');
  });

  it('a blank coordinator name shows as Control Plane', () => {
    useSettings.setState({ coordinatorName: '  ' });
    open();
    type('control pl');
    expect(labels().slice(0, 2)).toEqual(['Control Plane', 'Control Plane']);
  });

  it('Up and Down move the active option, and the input names it (aria-activedescendant)', () => {
    open();
    const input = screen.getByRole('combobox', { name: 'Command' });
    const rows = screen.getAllByRole('option');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant', rows[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', rows[1].id);
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', rows[0].id);
  });

  it('the active thread has stop, restart and archive rows; archive asks first', async () => {
    useTabs.setState({ activeTabId: 't2' });
    open();
    type('write release');
    expect(labels()).toEqual(expect.arrayContaining(['Stop “Write release notes”', 'Restart “Write release notes”', 'Archive “Write release notes”']));
    fireEvent.click(screen.getByRole('option', { name: 'Archive “Write release notes”' }));
    expect(fetchMock).not.toHaveBeenCalled(); // nothing happens before the confirmation
    const confirm = screen.getByRole('alertdialog', { name: 'Archive thread?' });
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' })); });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/api/terminals/t2') && init?.method === 'DELETE')).toBe(true);
  });

  it('no thread action rows without an active thread', () => {
    open();
    expect(labels().some((l) => l?.startsWith('Archive '))).toBe(false);
  });

  it('a project whose threads are not loaded yet is loaded when the palette opens', async () => {
    useTabs.setState({ byProject: { p1: [] } });
    const loadTabs = vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue();
    open();
    await act(async () => {});
    expect(loadTabs).toHaveBeenCalledWith('p2');
    expect(loadTabs).not.toHaveBeenCalledWith('p1');
    loadTabs.mockRestore();
  });

  // ── W2-F (2026-11-09): addresses and the attention queue ───────────────────────────────────
  it('Back after a thread opened from the palette returns to the earlier thread', async () => {
    open();
    type('login');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    expect(window.location.pathname).toBe('/p/p1/t/t1');
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    type('invoice');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    expect(window.location.pathname).toBe('/p/p2/t/t3');
    act(() => { window.history.back(); });
    await waitFor(() => expect(useTabs.getState().activeTabId).toBe('t1'));
    expect(window.location.pathname).toBe('/p/p1/t/t1');
  });

  it('a settings row and a view row open at their address', () => {
    open();
    type('secrets');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    expect(window.location.pathname).toBe('/settings/secrets');
    expect(useUI.getState().view).toBe('settings');
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    fireEvent.click(screen.getByRole('option', { name: 'Chat' }));
    expect(window.location.pathname).toBe('/chat');
    expect(useUI.getState().view).toBe('chat');
  });

  it('the row "Next thread that needs you" goes through the queue: needs input, then the error, then round again', () => {
    const next = () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
      type('next thread that needs');
      expect(labels()[0]).toBe('Next thread that needs you');
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command' }), { key: 'Enter' });
    };
    render(<CommandPalette />);
    next();
    expect(window.location.pathname).toBe('/p/p2/t/t3'); // needs input
    next();
    expect(window.location.pathname).toBe('/p/p2/t/t4'); // the error
    next();
    expect(window.location.pathname).toBe('/p/p2/t/t3'); // round again; the working thread is not in the queue
    expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 'p2', threadId: 't3' });
  });

  it('the row shows in the list before a query is typed, with its shortcut', () => {
    open();
    const row = screen.getByRole('option', { name: 'Next thread that needs you' });
    expect(row).toHaveTextContent('Alt+N');
  });

  it('with nothing in the queue the row says so and opens nothing', () => {
    useTabs.setState({ byProject: { p1: [thread('t1', 'p1', 'Fix the login form', 'waiting', '2026-11-09T10:00:00Z')] } });
    open();
    fireEvent.click(screen.getByRole('option', { name: 'Next thread that needs you' }));
    expect(useHint.getState().msg).toBe('No thread needs you.');
    expect(window.location.pathname).toBe('/');
  });
});
