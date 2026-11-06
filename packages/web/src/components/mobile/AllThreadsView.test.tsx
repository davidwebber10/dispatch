import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { api } from '../../api/client';
import { AllThreadsView } from './AllThreadsView';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';

const t = (id: string, sessionId: string, label: string, lastActivityAt: string, over: Record<string, unknown> = {}) =>
  ({ id, sessionId, type: 'claude-code', label, status: 'idle', config: {}, createdAt: lastActivityAt, lastActivityAt, archivedAt: null, ...over }) as any;

beforeEach(() => {
  localStorage.clear();
  useProjects.setState({ sessions: [{ id: 'A', name: 'Alpha', workingDir: '/a' }, { id: 'B', name: 'Beta', workingDir: '/b' }] as any });
  useTabs.setState({ byProject: {
    A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z'), t('a2', 'A', 'Old notes', '2026-10-01T10:00:00Z'), t('af', 'A', 'readme.md', '2026-10-28T12:00:00Z', { type: 'file' })],
    B: [t('b1', 'B', 'Ship v2', '2026-10-28T11:00:00Z'), t('b2', 'B', 'Archived', '2026-10-28T13:00:00Z', { archivedAt: 'x' })],
  }, loading: {} } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

// Rows are the project view's ThreadRow (data-thread-id); its label carries the name as aria-label.
const labels = () => Array.from(document.querySelectorAll('[data-thread-id]')).map((row) => row.querySelector('span[aria-label]')?.getAttribute('aria-label'));

describe('<AllThreadsView>', () => {
  it('lists every thread of every project, newest activity first, without file tabs or archived threads', () => {
    render(<AllThreadsView onOpenThread={() => {}} />);
    expect(labels()).toEqual(['Ship v2', 'Fix login', 'Old notes']);
    expect(screen.queryByText('readme.md')).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('the project chips filter the list and the choice is remembered', () => {
    const { unmount } = render(<AllThreadsView onOpenThread={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(labels()).toEqual(['Ship v2']);
    expect(localStorage.getItem('dispatch:mobileThreadsProject')).toBe('B');
    unmount();
    render(<AllThreadsView onOpenThread={() => {}} />);
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(labels()).toHaveLength(3);
  });

  it('the search box matches thread labels and project names', () => {
    const { rerender } = render(<AllThreadsView onOpenThread={() => {}} query="old" />);
    expect(labels()).toEqual(['Old notes']);
    rerender(<AllThreadsView onOpenThread={() => {}} query="beta" />);
    expect(labels()).toEqual(['Ship v2']);
  });

  it('tapping a row opens the thread in its project', () => {
    const open = vi.fn();
    render(<AllThreadsView onOpenThread={open} />);
    fireEvent.click(screen.getByText('Ship v2'));
    expect(open).toHaveBeenCalledWith('B', 'b1');
  });

  it('rows carry the same ⋯ menu as a project, with Branch, Reload and Thread details for agent threads', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    useTabs.setState({ byProject: { A: [t('c1', 'A', 'Codex work', '2026-10-28T10:00:00Z', { type: 'codex' })], B: [] } } as any);
    render(<AllThreadsView onOpenThread={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thread options' }));
    const menu = screen.getByRole('menu');
    for (const name of ['Thread details', 'Rename thread', 'Branch thread', 'Reload thread', 'Archive thread']) {
      expect(within(menu).getByRole('button', { name })).toBeInTheDocument();
    }
    vi.unstubAllGlobals();
  });

  it('the Archived tab lists every project\'s archived threads, newest first, and Restore reopens one', async () => {
    const archived = (id: string, sessionId: string, label: string, at: string) => ({ ...t(id, sessionId, label, at), archivedAt: at });
    vi.spyOn(api, 'listArchivedTerminals').mockImplementation(async (sid: string) => (sid === 'A'
      ? [archived('x1', 'A', 'Old login fix', '2026-10-20T10:00:00Z')]
      : [archived('x2', 'B', 'Shipped v1', '2026-10-25T10:00:00Z')]) as any);
    vi.spyOn(api, 'restoreTerminal').mockResolvedValue({ id: 'x1' } as any);
    const open = vi.fn();
    render(<AllThreadsView onOpenThread={open} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ARCHIVED' }));
    const list = await screen.findByTestId('archived-threads');
    expect([...list.querySelectorAll('[data-archived-id]')].map((r) => r.getAttribute('data-archived-id'))).toEqual(['x2', 'x1']);
    expect(list.textContent).toContain('Beta · archived');
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old login fix' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('A', 'x1'));
  });
});

