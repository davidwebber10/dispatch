import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { api } from '../../api/client';
import { AllThreadsView } from './AllThreadsView';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useAccounts } from '../../stores/accounts';

// Owner, 2026-11-13: "swipe to archive on mobile should confirm". The Threads list archived at the end
// of a swipe with no question; a project's list already asked first. Now both ask.

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => true }));
// The swipe as a button: the gesture itself is SwipeRow's own test; here only its action matters.
vi.mock('../common/SwipeRow', () => ({
  SwipeRow: ({ actionLabel, onAction, disabled, children }: any) => (
    <div>{children}{!disabled && <button type="button" onClick={onAction}>{`swipe ${actionLabel}`}</button>}</div>
  ),
}));

const t = (id: string, label: string) =>
  ({ id, sessionId: 'A', type: 'claude-code', label, status: 'idle', config: {}, createdAt: '2026-11-13T10:00:00Z', lastActivityAt: '2026-11-13T10:00:00Z', archivedAt: null }) as any;

describe('the Threads list on a phone: swipe to archive asks first', () => {
  let archive: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    useProjects.setState({ sessions: [{ id: 'A', name: 'Alpha', workingDir: '/a' }] as any });
    useTabs.setState({ byProject: { A: [t('a1', 'Fix login')] }, loading: {} } as any);
    vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
    archive = vi.fn().mockResolvedValue(undefined);
    useTabs.setState({ archive } as any);
    useAccounts.setState({ view: null, loading: false });
    vi.spyOn(api, 'getAccounts').mockRejectedValue(new Error('no accounts route'));
  });

  it('a swipe opens "Archive thread?" and archives nothing yet', () => {
    render(<AllThreadsView onOpenThread={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'swipe Archive' }));
    expect(screen.getByText('Archive thread?')).toBeInTheDocument();
    expect(screen.getByText(/“Fix login” will be archived/)).toBeInTheDocument();
    expect(archive).not.toHaveBeenCalled();
  });

  it('Archive in the dialog archives the thread', () => {
    render(<AllThreadsView onOpenThread={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'swipe Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledWith('a1');
  });

  it('Cancel keeps the thread', () => {
    render(<AllThreadsView onOpenThread={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'swipe Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(archive).not.toHaveBeenCalled();
    expect(screen.queryByText('Archive thread?')).toBeNull();
  });
});
