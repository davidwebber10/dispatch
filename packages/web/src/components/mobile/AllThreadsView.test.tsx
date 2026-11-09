import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { api } from '../../api/client';
import { AllThreadsView } from './AllThreadsView';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useAccounts } from '../../stores/accounts';
import { act } from '@testing-library/react';

// Render counter (W1-F): ThreadRow renders the real ThreadLabel once per render of its own.
const rowRenders = vi.hoisted(() => ({} as Record<string, number>));
vi.mock('../sidebar/ThreadLabel', async (orig) => {
  const actual = await orig<typeof import('../sidebar/ThreadLabel')>();
  return { ...actual, ThreadLabel: (props: any) => { rowRenders[props.tab.id] = (rowRenders[props.tab.id] ?? 0) + 1; return <actual.ThreadLabel {...props} />; } };
});

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
  // An older daemon has no accounts route: the Account section stays away unless a test adds one.
  useAccounts.setState({ view: null, loading: false });
  vi.spyOn(api, 'getAccounts').mockRejectedValue(new Error('no accounts route'));
});

// The filters sit behind the Filters button (2026-11-06): every render here opens the panel, so the
// tests below can reach the Started-by switch and the project chips.
const openFilters = () => { const b = screen.queryByRole('button', { name: /^Filters/ }); if (b && b.getAttribute('aria-expanded') !== 'true') fireEvent.click(b); };
// The sheet's sections start folded (2026-11-06); a section's header names it and its current pick.
const openSection = (title: string) => { const b = screen.queryByRole('button', { name: new RegExp(`^${title}: `) }); if (b && b.getAttribute('aria-expanded') !== 'true') fireEvent.click(b); };
const render = (ui: React.ReactElement) => { const r = rtlRender(ui); openFilters(); openSection('Project'); return r; };

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
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
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
    // The maintenance rows (Copy thread ID, Reload) sit behind the sheet's More (2026-11-07).
    fireEvent.click(within(menu).getByRole('button', { name: 'More' }));
    for (const name of ['Thread details', 'Rename thread', 'Copy thread ID', 'Branch thread', 'Reload thread', 'Archive thread']) {
      expect(within(menu).getByRole('button', { name })).toBeInTheDocument();
    }
    vi.unstubAllGlobals();
  });

  it('Copy thread ID puts the id on the clipboard and says so (2026-11-06)', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    useTabs.setState({ byProject: { A: [t('c1', 'A', 'Codex work', '2026-10-28T10:00:00Z', { type: 'codex' })], B: [] } } as any);
    render(<AllThreadsView onOpenThread={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thread options' }));
    // On a phone the row sits behind the sheet's More (2026-11-07); a desktop menu lists it directly.
    const more = within(screen.getByRole('menu')).queryByRole('button', { name: 'More' });
    if (more) fireEvent.click(more);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Copy thread ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('c1'));
    const { useHint } = await import('../../stores/hint');
    await waitFor(() => expect(useHint.getState().msg).toBe('Thread ID copied'));
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
    // Scoped to its own group since W2-F: the Status filter is a second segmented switch with an All.
    const seg = (name: RegExp | string) => within(screen.getByRole('radiogroup', { name: 'Started by' })).getByRole('radio', { name });
    // These tests start from a saved Mine; the default (All) has its own test.
    beforeEach(() => { localStorage.setItem('dispatch:mobileThreadsStarter:v2', 'mine'); });
    const chips = () => within(screen.getByRole('group', { name: 'Project filter' })).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);

    it('is hidden when no thread was started by an agent, and the list shows everything', () => {
      localStorage.setItem('dispatch:mobileThreadsStarter:v2', 'agents');
      useTabs.setState({ byProject: { A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z'), t('a2', 'A', 'Write docs', '2026-10-28T09:00:00Z')] }, loading: {} } as any);
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(screen.queryByRole('radiogroup', { name: 'Started by' })).toBeNull();
      expect(labels()).toEqual(['Fix login', 'Write docs']);
    });

    it('with nothing saved it opens on All, and the Filters button shows no count', () => {
      localStorage.removeItem('dispatch:mobileThreadsStarter:v2');
      seed();
      rtlRender(<AllThreadsView onOpenThread={() => {}} />);
      expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('applied-filters')).toBeNull();
      expect(labels()).toEqual(['Ship v2', 'Fix login', 'Review login', 'Overseer job', 'Fix round 2']);
    });

    it('a filter that is on shows as a pill while the panel is closed, and × removes it', () => {
      seed();
      rtlRender(<AllThreadsView onOpenThread={() => {}} />);
      expect(screen.getByRole('button', { name: 'Filters, 1 on' })).toBeInTheDocument();
      const applied = screen.getByTestId('applied-filters');
      expect(applied.textContent).toContain('Started byMine');
      fireEvent.click(within(applied).getByRole('button', { name: 'Remove Started by filter' }));
      expect(screen.queryByTestId('applied-filters')).toBeNull();
      expect(labels()).toHaveLength(5);
    });

    it('a saved Mine hides agent threads', () => {
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

    it('the choice is stored, comes back after a remount, and a bad stored value gives All', () => {
      seed();
      const { unmount } = render(<AllThreadsView onOpenThread={() => {}} />);
      fireEvent.click(seg(/^Agents/));
      expect(localStorage.getItem('dispatch:mobileThreadsStarter:v2')).toBe('agents');
      unmount();
      const second = render(<AllThreadsView onOpenThread={() => {}} />);
      expect(seg(/^Agents/)).toHaveAttribute('aria-checked', 'true');
      second.unmount();
      localStorage.setItem('dispatch:mobileThreadsStarter:v2', 'bogus');
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(seg(/^All/)).toHaveAttribute('aria-checked', 'true');
    });

    it('the project chips list only projects that have a thread in the current filter', () => {
      useTabs.setState({ byProject: {
        A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z')],
        B: [t('b2', 'B', 'Fix round 2', '2026-10-28T07:00:00Z', { config: { role: 'agent' } })],
      } } as any);
      render(<AllThreadsView onOpenThread={() => {}} />);
      expect(chips()).toEqual(['All projects', 'Alpha']);
      fireEvent.click(seg(/^Agents/));
      expect(chips()).toEqual(['All projects', 'Beta']);
      fireEvent.click(seg(/^All/));
      expect(chips()).toEqual(['All projects', 'Alpha', 'Beta']);
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
      rtlRender(<AllThreadsView onOpenThread={() => {}} query="overseer job" />);
      expect(labels()).toEqual([]);
      fireEvent.click(await screen.findByRole('button', { name: 'Show 1 agent thread' }));
      expect(labels()).toEqual(['Overseer job']);
      openFilters();
      expect(seg(/^Agents/)).toHaveAttribute('aria-checked', 'true');
    });

    it('from Agents, the button offers the owner\'s threads', async () => {
      seed();
      localStorage.setItem('dispatch:mobileThreadsStarter:v2', 'agents');
      rtlRender(<AllThreadsView onOpenThread={() => {}} query="fix login" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Show 1 of my threads' }));
      expect(labels()).toEqual(['Fix login']);
      openFilters();
      expect(seg(/^Mine/)).toHaveAttribute('aria-checked', 'true');
    });

    it('no button when nothing matches in any filter', async () => {
      seed();
      rtlRender(<AllThreadsView onOpenThread={() => {}} query="zzz" />);
      expect(await screen.findByText('No threads match.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Show / })).toBeNull();
    });

    it('agent rows say who started them, after the project name', () => {
      seed();
      localStorage.setItem('dispatch:mobileThreadsStarter:v2', 'all');
      render(<AllThreadsView onOpenThread={() => {}} />);
      const row = (id: string) => document.querySelector(`[data-thread-id="${id}"]`)!.textContent;
      expect(row('a2')).toContain('Alpha · Chat');
      expect(row('a3')).toContain('Alpha · Overseer');
      expect(row('b2')).toContain('Beta · via Ship v2');
      expect(row('a1')).not.toContain('Alpha ·');
    });

    it('with a project chip on, the agent row shows only the started-by word', () => {
      seed();
      localStorage.setItem('dispatch:mobileThreadsStarter:v2', 'agents');
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


describe('the filter sheet (2026-11-06): folded sections for Project, Account, Harness and Model', () => {
  const rows = (title: string) => within(screen.getByRole('group', { name: `${title} filter` })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
  const seed = () => useTabs.setState({ byProject: {
    A: [t('a1', 'A', 'Fix login', '2026-10-28T10:00:00Z', { config: { model: 'opus', accountId: 'work' } }),
      t('a2', 'A', 'Codex work', '2026-10-28T09:00:00Z', { type: 'codex' })],
    B: [t('b1', 'B', 'Ship v2', '2026-10-28T11:00:00Z', { type: 'codex', config: { model: 'gpt-6-astra' } })],
  } } as any);

  it('sections start folded and name the current pick; tapping one opens its list with a count per choice', () => {
    seed();
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    openFilters();
    const header = screen.getByRole('button', { name: 'Project: All projects' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Project filter' })).toBeNull();
    fireEvent.click(header);
    expect(rows('Project')).toEqual(['All projects', 'Alpha', 'Beta']);
    expect(screen.getByRole('button', { name: 'Alpha' }).textContent).toContain('2');
    expect(screen.getByRole('button', { name: 'Harness: All harnesses' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Model: All models' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Account: / })).toBeNull(); // no accounts route
  });

  it('Harness filters by the thread type, shows as a pill, and the header names the pick', () => {
    seed();
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    openFilters();
    openSection('Harness');
    expect(rows('Harness')).toEqual(['All harnesses', 'Codex', 'Claude Code']);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(labels()).toEqual(['Ship v2', 'Codex work']);
    expect(screen.getByRole('button', { name: 'Harness: Codex' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Filters, 1 on' }));
    const applied = screen.getByTestId('applied-filters');
    expect(applied.textContent).toContain('HarnessCodex');
    fireEvent.click(within(applied).getByRole('button', { name: 'Remove Harness filter' }));
    expect(labels()).toHaveLength(3);
  });

  it('Model lists the catalog names, Default for a thread without one, and is remembered', () => {
    seed();
    const { unmount } = rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    openFilters();
    openSection('Model');
    expect(rows('Model')).toEqual(['All models', '6 Astra', 'Default', 'Opus']);
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }));
    expect(labels()).toEqual(['Fix login']);
    expect(JSON.parse(localStorage.getItem('dispatch:mobileThreadsFacets')!)).toEqual({ account: null, harness: null, model: 'opus' });
    unmount();
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    expect(labels()).toEqual(['Fix login']);
  });

  it('Account appears once the accounts are known and filters by the account a thread runs on', async () => {
    seed();
    vi.spyOn(api, 'getAccounts').mockResolvedValue({
      claude: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'work', label: 'Work', isCli: false, addedAt: '2026-11-06' }],
      codex: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }],
      defaults: { claude: 'cli', codex: 'cli' },
    } as any);
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    openFilters();
    fireEvent.click(await screen.findByRole('button', { name: 'Account: All accounts' }));
    expect(rows('Account')).toEqual(['All accounts', 'CLI login', 'Work']);
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(labels()).toEqual(['Fix login']);
    expect(screen.getByRole('button', { name: 'Account: Work' })).toBeInTheDocument();
  });

  it('counts are faceted: a harness pick narrows what the project rows count', () => {
    seed();
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    openFilters();
    openSection('Harness');
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    openSection('Project');
    expect(screen.getByRole('button', { name: 'Alpha' }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: 'Beta' }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: /^Show 2 threads$/ })).toBeInTheDocument();
  });

  it('Clear clears every filter at once', () => {
    seed();
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    openFilters();
    openSection('Harness');
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    openSection('Project');
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(labels()).toEqual(['Ship v2']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(labels()).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });
});


// W1-F: this view needs every project, so it does render on each status event; but only the row
// of the thread that changed may render with it.
describe('<AllThreadsView> render counts (W1-F)', () => {
  it('a status event renders the row of that thread only, and the row shows the new status', () => {
    rtlRender(<AllThreadsView onOpenThread={() => {}} />);
    const before = { ...rowRenders };
    act(() => { useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'a1', status: 'needs_input' }); });
    expect(rowRenders.b1).toBe(before.b1);
    expect(rowRenders.a2).toBe(before.a2);
    expect(rowRenders.a1).toBe(before.a1 + 1);
    const row = document.querySelector('[data-thread-id="a1"]') as HTMLElement;
    expect(within(row).getByLabelText('status-needs_input')).toBeInTheDocument();
  });

  it('a row still opens, with the latest onOpenThread, after the parent passed a new function', () => {
    const first = vi.fn(); const second = vi.fn();
    const { rerender } = rtlRender(<AllThreadsView onOpenThread={first} />);
    rerender(<AllThreadsView onOpenThread={second} />);
    fireEvent.click(document.querySelector('[data-thread-id="b1"]') as HTMLElement);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('B', 'b1');
  });
});

// Active within (2026-11-09): one filter keeps the threads active in the last hour, today, this week or this month.
describe('Active within filter', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const MIN = 60_000, DAY = 86_400_000;
  const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 12, 15, 0, 0)); // Thursday 12 November 2026, 15:00 local
    useTabs.setState({ byProject: {
      A: [t('a1', 'A', 'Ten minutes', ago(10 * MIN)), t('a2', 'A', 'This morning', new Date(startOfDay() + 8 * 3600_000).toISOString())],
      B: [t('b1', 'B', 'Monday', new Date(2026, 10, 9, 10).toISOString()), t('b2', 'B', 'Last week', new Date(2026, 10, 6, 10).toISOString()), t('b3', 'B', 'Last month', ago(40 * DAY))],
    }, loading: {} } as any);
  });
  afterEach(() => { vi.useRealTimers(); });
  const pick = (name: RegExp) => { openSection('Active within'); fireEvent.click(screen.getByRole('button', { name })); };

  it('Last hour, Today, This week and This month each keep the right threads; Any time shows all', () => {
    render(<AllThreadsView onOpenThread={() => {}} />);
    expect(labels()).toHaveLength(5);
    pick(/^Last hour/); expect(labels()).toEqual(['Ten minutes']);
    pick(/^Today/); expect(labels()).toEqual(['Ten minutes', 'This morning']);
    pick(/^This week/); expect(labels()).toEqual(['Ten minutes', 'This morning', 'Monday']);
    pick(/^This month/); expect(labels()).toEqual(['Ten minutes', 'This morning', 'Monday', 'Last week']);
    pick(/^Any time/); expect(labels()).toHaveLength(5);
  });

  it('the choice is remembered', () => {
    const { unmount } = render(<AllThreadsView onOpenThread={() => {}} />);
    pick(/^Today/);
    unmount();
    render(<AllThreadsView onOpenThread={() => {}} />);
    expect(labels()).toEqual(['Ten minutes', 'This morning']);
  });
});
