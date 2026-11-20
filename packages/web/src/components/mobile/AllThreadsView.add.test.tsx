import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { api } from '../../api/client';
import { AllThreadsView } from './AllThreadsView';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useAccounts } from '../../stores/accounts';

// Owner, 2026-11-20: "a green plus button to the right of Filters like it is on Projects ... the normal
// thread add modal but also pick project. The default is the open thread's project (if there is one),
// otherwise the most recent. Desktop and mobile."
const isMobile = vi.hoisted(() => ({ on: false }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => isMobile.on }));
vi.mock('../sidebar/NewThreadModal', () => ({
  NewThreadModal: (p: any) => (
    <div role="dialog" aria-label="New thread">
      <span data-testid="start-project">{p.sessionId}</span>
      <span data-testid="pick">{String(!!p.pickProject)}</span>
      <button type="button" onClick={() => p.onCreated('t-new', 'B')}>fake start</button>
    </div>
  ),
}));

const t = (id: string, sessionId: string, at: string) =>
  ({ id, sessionId, type: 'claude-code', label: id, status: 'idle', config: {}, createdAt: at, lastActivityAt: at, archivedAt: null }) as any;

beforeEach(() => {
  localStorage.clear();
  useProjects.setState({ sessions: [
    { id: 'A', name: 'Alpha', workingDir: '/a', lastActivityAt: '2026-11-19T10:00:00Z', archivedAt: null },
    { id: 'B', name: 'Beta', workingDir: '/b', lastActivityAt: '2026-11-20T09:00:00Z', archivedAt: null },
  ] as any });
  useTabs.setState({ byProject: { A: [t('a1', 'A', '2026-11-19T10:00:00Z')], B: [t('b1', 'B', '2026-11-20T09:00:00Z')] }, loading: {}, activeTabId: null } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
  useAccounts.setState({ view: null, loading: false });
  vi.spyOn(api, 'getAccounts').mockRejectedValue(new Error('no accounts route'));
});

describe.each([['desktop', false], ['phone', true]] as const)('the Threads list + (%s)', (_n, phone) => {
  beforeEach(() => { isMobile.on = phone; });
  // The desktop list has its own search field; the phone's search is in the app header (MobileApp).
  const searchProps = () => (phone ? {} : { query: '', onQueryChange: () => {} });

  it('a green + sits right of Filters and opens the new-thread dialog with a project picker', () => {
    render(<AllThreadsView onOpenThread={() => {}} {...searchProps()} />);
    const filters = screen.getByRole('button', { name: /^Filters/ });
    const plus = screen.getByRole('button', { name: 'New thread' });
    expect(filters.compareDocumentPosition(plus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plus.style.background).toBe('var(--color-accent)');
    // The same height as Filters, so it never touches the line under the row (owner, 2026-11-20).
    expect(plus.style.height).toBe('32px');
    fireEvent.click(plus);
    expect(screen.getByTestId('pick')).toHaveTextContent('true');
  });

  it('starts on the open thread\'s project', () => {
    useTabs.setState({ activeTabId: 'a1' } as any);
    render(<AllThreadsView onOpenThread={() => {}} {...searchProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
    expect(screen.getByTestId('start-project')).toHaveTextContent('A');
  });

  it('with no open thread, starts on the most recent project, and opens the new thread', () => {
    const open = vi.fn();
    render(<AllThreadsView onOpenThread={open} {...searchProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
    expect(screen.getByTestId('start-project')).toHaveTextContent('B');
    fireEvent.click(screen.getByRole('button', { name: 'fake start' }));
    expect(open).toHaveBeenCalledWith('B', 't-new');
    expect(screen.queryByRole('dialog', { name: 'New thread' })).toBeNull();
  });
});
