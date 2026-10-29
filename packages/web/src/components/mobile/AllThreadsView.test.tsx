import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

const labels = () => screen.queryAllByTestId('thread-label').map((el) => el.textContent);

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
});
