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

  describe('the Mine / Agents / All filter', () => {
    // Alpha: owner "Fix login", agent "Review login" (Chat), agent "Overseer job". Beta: owner "Ship v2", agent "Fix round 2" (via Ship v2).
    const seed = () => useTabs.setState({ byProject: {
      A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z'),
        t('a2', 'A', 'Review login', '2026-10-28T09:00:00Z', { config: { role: 'agent', origin: 'endless' } }),
        t('a3', 'A', 'Overseer job', '2026-10-28T08:00:00Z', { config: { role: 'agent' } })],
      B: [t('b1', 'B', 'Ship v2', '2026-10-28T11:00:00Z'),
        t('b2', 'B', 'Fix round 2', '2026-10-28T07:00:00Z', { config: { role: 'agent', spawnedBy: 'b1' } })],
    }, loading: {} } as any);
    const seg = (name: RegExp | string) => screen.getByRole('radio', { name });
    const chips = () => within(screen.getByRole('group', { name: 'Project filter' })).getAllByRole('button').map((b) => b.textContent);

    it('is hidden when no thread was started by an agent, and the list shows everything', () => {
      localStorage.setItem('dispatch:mobileThreadsStarter', 'agents');
      useTabs.setState({ byProject: { A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z'), t('a2', 'A', 'Write docs', '2026-10-28T09:00:00Z')] }, loading: {} } as any);
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(screen.queryByRole('radiogroup', { name: 'Started by' })).toBeNull();
      expect(labels()).toEqual(['Fix login', 'Write docs']);
    });

    it('opens on Mine and hides agent threads', () => {
      seed();
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(seg(/^Mine/)).toHaveAttribute('aria-checked', 'true');
      expect(labels()).toEqual(['Ship v2', 'Fix login']);
    });

    it('Agents shows only agent threads, All shows every thread', () => {
      seed();
      render(<AllThreadsView onOpenThread={() => {}} />);
      fireEvent.click(seg(/^Agents/));
      expect(labels()).toEqual(['Review login', 'Overseer job', 'Fix round 2']);
      fireEvent.click(seg(/^All/));
      expect(labels()).toEqual(['Ship v2', 'Fix login', 'Review login', 'Overseer job', 'Fix round 2']);
    });

    it('a Chat thread, a thread with a role mark and a scheduled role run count as Agents', () => {
      useTabs.setState({ byProject: { A: [
        t('x1', 'A', 'Chat made', '2026-10-28T10:00:00Z', { config: { origin: 'endless' } }),
        t('x2', 'A', 'Role run', '2026-10-28T09:00:00Z', { config: { roleRun: 'r1' } }),
        t('x3', 'A', 'Overseer tab', '2026-10-28T08:00:00Z', { config: { role: 'coordinator' } }),
        t('x4', 'A', 'A shell', '2026-10-28T07:00:00Z', { type: 'shell' }),
      ], B: [] } } as any);
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(labels()).toEqual(['Overseer tab', 'A shell']);
      fireEvent.click(seg(/^Agents/));
      expect(labels()).toEqual(['Chat made', 'Role run']);
    });

    it('shows the count on each segment', () => {
      seed();
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(seg(/^Mine/)).toHaveTextContent('Mine 2');
      expect(seg(/^Agents/)).toHaveTextContent('Agents 3');
      expect(seg(/^All/)).toHaveTextContent('All 5');
    });

    it('the counts follow the project chip', () => {
      seed();
      render(<AllThreadsView onOpenThread={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
      expect(seg(/^Mine/)).toHaveTextContent('Mine 1');
      expect(seg(/^Agents/)).toHaveTextContent('Agents 1');
      expect(seg(/^All/)).toHaveTextContent('All 2');
    });

    it('the choice is stored, comes back after a remount, and a bad stored value gives Mine', () => {
      seed();
      const { unmount } = render(<AllThreadsView onOpenThread={() => {}} />);
      fireEvent.click(seg(/^Agents/));
      expect(localStorage.getItem('dispatch:mobileThreadsStarter')).toBe('agents');
      unmount();
      const second = render(<AllThreadsView onOpenThread={() => {}} />);
      expect(seg(/^Agents/)).toHaveAttribute('aria-checked', 'true');
      second.unmount();
      localStorage.setItem('dispatch:mobileThreadsStarter', 'bogus');
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(seg(/^Mine/)).toHaveAttribute('aria-checked', 'true');
    });

    it('the project chips list only projects that have a thread in the current filter', () => {
      useTabs.setState({ byProject: {
        A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z')],
        B: [t('b2', 'B', 'Fix round 2', '2026-10-28T07:00:00Z', { config: { role: 'agent' } })],
      } } as any);
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(chips()).toEqual(['All', 'Alpha']);
      fireEvent.click(seg(/^Agents/));
      expect(chips()).toEqual(['All', 'Beta']);
      fireEvent.click(seg(/^All/));
      expect(chips()).toEqual(['All', 'Alpha', 'Beta']);
    });

    it('search works inside the filter', () => {
      seed();
      const { rerender } = render(<AllThreadsView onOpenThread={() => {}} query="login" />);
      expect(labels()).toEqual(['Fix login']);
      fireEvent.click(seg(/^Agents/));
      expect(labels()).toEqual(['Review login']);
      rerender(<AllThreadsView onOpenThread={() => {}} query="login" />);
      expect(seg(/^Mine/)).toHaveTextContent('Mine 1');
    });

    it('when the filter has no match but the other one does, a button switches to it', async () => {
      seed();
      render(<AllThreadsView onOpenThread={() => {}} query="overseer job" />);
      expect(labels()).toEqual([]);
      fireEvent.click(await screen.findByRole('button', { name: 'Show 1 agent thread' }));
      expect(labels()).toEqual(['Overseer job']);
      expect(seg(/^Agents/)).toHaveAttribute('aria-checked', 'true');
    });

    it('from Agents, the button offers the owner\'s threads', async () => {
      seed();
      localStorage.setItem('dispatch:mobileThreadsStarter', 'agents');
      render(<AllThreadsView onOpenThread={() => {}} query="fix login" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Show 1 of my threads' }));
      expect(labels()).toEqual(['Fix login']);
      expect(seg(/^Mine/)).toHaveAttribute('aria-checked', 'true');
    });

    it('no button when nothing matches in any filter', async () => {
      seed();
      render(<AllThreadsView onOpenThread={() => {}} query="zzz" />);
      expect(await screen.findByText('No threads match.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Show / })).toBeNull();
    });

    it('agent rows say who started them, after the project name', () => {
      seed();
      localStorage.setItem('dispatch:mobileThreadsStarter', 'all');
      render(<AllThreadsView onOpenThread={() => {}} />);
      const row = (id: string) => document.querySelector(`[data-thread-id="${id}"]`)!.textContent;
      expect(row('a2')).toContain('Alpha · Chat');
      expect(row('a3')).toContain('Alpha · Overseer');
      expect(row('b2')).toContain('Beta · via Ship v2');
      expect(row('a1')).not.toContain('Alpha ·');
    });

    it('with a project chip on, the agent row shows only the started-by word', () => {
      seed();
      localStorage.setItem('dispatch:mobileThreadsStarter', 'agents');
      render(<AllThreadsView onOpenThread={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
      const text = document.querySelector('[data-thread-id="b2"]')!.textContent;
      expect(text).toContain('via Ship v2');
      expect(text).not.toContain('Beta');
    });

    it('the filter is hidden on the Archived tab', () => {
      seed();
      vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([] as any);
      render(<AllThreadsView onOpenThread={() => {}} />);
      fireEvent.click(screen.getByRole('tab', { name: 'ARCHIVED' }));
      expect(screen.queryByRole('radiogroup', { name: 'Started by' })).toBeNull();
    });
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

