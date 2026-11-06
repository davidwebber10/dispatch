import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useConnection } from '../../stores/connection';
import { api } from '../../api/client';
import * as sock from '../../api/structured-socket';

// The CLI ⇄ Pretty transport switch was only ever wired into TabHost's DESKTOP floating
// control, so on a phone the header offered just the old View/Terminal `ModeToggle` — and a
// Pretty thread (for which ModeToggle deliberately renders nothing) had no switch at all.
// MobileApp derives its level-2 thread leaf from the URL, so seeding `/p/{project}/t/{tab}`
// mounts it straight onto the thread screen where the header control belongs.

// Also kept outside the store so a getTerminal promise still in flight when the next test
// resets the store resolves benignly instead of rejecting unhandled.
let seeded: Record<string, unknown> | null = null;

function seedThreadAt(path: string, tab: Record<string, unknown>) {
  window.history.pushState({}, '', path);
  seeded = { id: 't1', sessionId: 's1', type: 'claude-code', config: {}, ...tab };
  useTabs.setState({ byProject: { s1: [seeded as any] } });
}

beforeEach(() => {
  // Present as a phone: TabHost gates its own floating desktop TransportToggle on
  // `!isMobile`, so without this jsdom's default 1024px viewport renders BOTH controls and
  // the header assertion below can't tell which one it found.
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: window.innerWidth <= 768,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.restoreAllMocks();
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([] as any);
  // TabHost/TerminalTab re-fetch the thread on mount; answer from the seeded store so the
  // real (unroutable in jsdom) /api/terminals call never fires.
  vi.spyOn(api, 'getTerminal').mockImplementation(async (id: string) => {
    for (const list of Object.values(useTabs.getState().byProject)) {
      const t = list.find((x) => x.id === id);
      if (t) return t as any;
    }
    return (seeded ?? { id, sessionId: 's1', type: 'shell', config: {} }) as any;
  });
  // ChatView (the Pretty thread body) opens a live ws on mount — stub it out.
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation(() => ({ close: () => {} }) as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('MobileApp project header (2026-11-06): the same shape as the thread header', () => {
  it('shows usage then a ⋯ project menu, no Previews button; the menu holds Previews, Rename and Archive', () => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'idle' } as any] });
    window.history.pushState({}, '', '/p/s1');
    render(<MobileApp />);
    expect(screen.queryByRole('button', { name: 'Previews' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thread menu' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Previews');
    expect(menu).toHaveTextContent('Rename project');
    expect(menu).toHaveTextContent('Archive project');
  });
});

describe('MobileApp thread header (2026-11-06, option C)', () => {
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Thread menu' }));

  it('titles the header with the thread, and its project and mode underneath', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', label: 'Fix the login', config: { transport: 'structured' } } as any);
    render(<MobileApp />);
    const title = screen.getByTestId('thread-title');
    expect(title.textContent).toContain('Fix the login');
    expect(title.textContent).toContain('Pretty');
  });

  it('names the account under the thread name once the accounts are known (multi-account)', async () => {
    vi.spyOn(api, 'getAccounts').mockResolvedValue({
      claude: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }, { id: 'work', label: 'Work', isCli: false, addedAt: '2026-11-06' }],
      codex: [{ id: 'cli', label: 'CLI login (this computer)', isCli: true, addedAt: null }],
      defaults: { claude: 'cli', codex: 'cli' },
    } as any);
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', label: 'Fix the login', config: { transport: 'structured', accountId: 'work' } } as any);
    // The mount reloads the project's threads; answer with the seed so the thread stays.
    vi.spyOn(api, 'listTerminals').mockImplementation(async () => [seeded] as any);
    render(<MobileApp />);
    await waitFor(() => expect(screen.getByTestId('thread-title').textContent).toContain('· Work'));
  });

  it('the CLI ⇄ Pretty switch and Previews are in the ⋯ menu, not the header', () => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Proj' } as any] });
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', config: { transport: 'structured' } });
    render(<MobileApp />);
    expect(screen.queryByRole('group', { name: 'Transport' })).not.toBeInTheDocument();
    openMenu();
    expect(screen.getByRole('button', { name: /Switch to CLI/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Previews/ })).toBeInTheDocument();
  });

  it('a CLI thread offers Switch to Pretty', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', config: {} });
    render(<MobileApp />);
    openMenu();
    expect(screen.getByRole('button', { name: /Switch to Pretty/ })).toBeInTheDocument();
  });

  it('a shell thread has no mode to switch', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'shell', externalId: 'e1', config: {} });
    render(<MobileApp />);
    openMenu();
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it('no thread menu on the project list', () => {
    seedThreadAt('/', { type: 'claude-code', externalId: 'e1', config: { transport: 'structured' } });
    render(<MobileApp />);
    expect(screen.queryByRole('button', { name: 'Thread menu' })).not.toBeInTheDocument();
  });
});

describe('MobileApp — connection label on a thread', () => {
  it('a healthy connection shows no label', () => {
    useConnection.setState({ status: 'open', everOpen: true } as any);
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', config: {} });
    render(<MobileApp />);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('a real drop shows Reconnecting, but not on a Grok thread', () => {
    vi.useFakeTimers();
    try {
      useConnection.setState({ status: 'closed', everOpen: true } as any);
      seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', config: {} });
      const { unmount } = render(<MobileApp />);
      act(() => { vi.advanceTimersByTime(1600); });
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
      unmount();
      seedThreadAt('/p/s1/t/t1', { type: 'grok', externalId: 'e1', config: {} });
      render(<MobileApp />);
      act(() => { vi.advanceTimersByTime(1600); });
      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

// Settings moved off the header gear (a modal, which on a phone left the sections
// cramped inside a 520px box) and onto the bottom rail as a real destination, so it
// drills down like every other mobile screen.
describe('MobileApp — Settings as a bottom-rail destination', () => {
  it('offers Settings as a bottom tab', () => {
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('no longer renders the header gear button', () => {
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    // The old control was a 32px icon button carrying title="Settings"; the bottom
    // tab is a labelled button, so the title lookup is what distinguishes them.
    expect(screen.queryByTitle('Settings')).not.toBeInTheDocument();
  });

  it('shows the section list on the Settings tab, and drills into a section', () => {
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    fireEvent.click(screen.getByText('Settings'));
    // The list is the level-0 screen: every section is offered.
    expect(screen.getByText('Dictation')).toBeInTheDocument();
    expect(screen.getByText('Secrets')).toBeInTheDocument();
    // Grouped as YOU / AGENTS / THIS MAC.
    for (const g of ['YOU', 'AGENTS', 'THIS MAC']) expect(screen.getByRole('region', { name: g })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Dictation'));
    // Drilling in pushes a history entry so back / edge-swipe walk out of it, and the
    // back button labels the screen it returns TO (iOS convention).
    expect(history.state).toMatchObject({ nav: 1, settingsSection: 'dictation' });
  });
});

// The old per-device "mobile view" setting (Threads vs Board) is gone. A Board choice saved
// before it was removed must not change what the Projects tab shows.
describe('MobileApp — an old saved Board view preference', () => {
  afterEach(() => { localStorage.removeItem('dispatch:mobileViewMode'); });

  it("threads mode (default): renders the projects list, not the board", () => {
    useProjects.setState({ sessions: [] });
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    expect(screen.getByPlaceholderText('Search projects')).toBeInTheDocument();
    expect(screen.queryByTestId('board-section-needs_help')).not.toBeInTheDocument();
  });

  it('a saved board preference falls back to the projects list', () => {
    localStorage.setItem('dispatch:mobileViewMode', JSON.stringify('board'));
    useProjects.setState({ sessions: [] });
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    expect(screen.queryByTestId('board-section-needs_help')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search projects')).toBeInTheDocument();
  });

  it('a saved board preference still allows opening a thread through Projects', () => {
    localStorage.setItem('dispatch:mobileViewMode', JSON.stringify('board'));
    useProjects.setState({ sessions: [{ id: 's1', name: 'dispatch' } as any] });
    seedThreadAt('/', { type: 'shell', config: {} });
    useTabs.setState({
      byProject: {
        s1: [{ id: 't1', sessionId: 's1', type: 'shell', label: 'one', status: 'needs_input', config: {}, archivedAt: null } as any],
      },
    });
    render(<MobileApp />);
    fireEvent.click(screen.getByText('dispatch'));
    fireEvent.click(screen.getByText('one'));
    expect(history.state).toMatchObject({ nav: 2, projectId: 's1', leaf: 'tab', tabId: 't1' });
  });
});

describe('MobileApp bottom tab — follows the Projects ⇄ Threads switch', () => {
  it('reads "Projects" on the projects view and "Threads" once switched', () => {
    localStorage.removeItem('dispatch:mobileProjectsView');
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    const bar = () => screen.getAllByRole('button').filter((b) => !b.getAttribute('role'));
    expect(bar().some((b) => b.textContent === 'Projects')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }));
    expect(bar().some((b) => b.textContent === 'Threads')).toBe(true);
    expect(bar().some((b) => b.textContent === 'Projects')).toBe(false);
    localStorage.removeItem('dispatch:mobileProjectsView');
  });
});

describe('MobileApp bottom tab bar on a thread', () => {
  const tab = (name: string) => screen.getAllByRole('button').find((b) => b.textContent === name)!;

  it('stays on the thread screen, and another tab goes all the way back to the root', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'shell', config: {} });
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    render(<MobileApp />);
    fireEvent.click(tab('Chat'));
    expect(go).toHaveBeenCalledWith(-2); // thread and project entries above the root
  });

  it('Projects walks back one screen at a time: thread → its project → the list', () => {
    localStorage.removeItem('dispatch:mobileProjectsView');
    seedThreadAt('/p/s1/t/t1', { type: 'shell', config: {} });
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    render(<MobileApp />);
    fireEvent.click(tab('Projects'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('with the Threads view on, the tab goes straight back to the thread list', () => {
    localStorage.setItem('dispatch:mobileProjectsView', 'threads');
    seedThreadAt('/p/s1/t/t1', { type: 'shell', config: {} });
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    render(<MobileApp />);
    fireEvent.click(tab('Threads'));
    expect(go).toHaveBeenCalledWith(-2);
    expect(back).not.toHaveBeenCalled();
    localStorage.removeItem('dispatch:mobileProjectsView');
  });

  it('Thread → Chat → Threads comes back to that thread, with its project under it in the back history', () => {
    localStorage.removeItem('dispatch:mobileProjectsView');
    seedThreadAt('/p/s1/t/t1', { type: 'shell', config: {} });
    vi.spyOn(history, 'go').mockImplementation(() => {});
    render(<MobileApp />);
    fireEvent.click(tab('Chat'));
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: { nav: 0, depth: 0 } })); }); // the walk back landed
    const push = vi.spyOn(history, 'pushState');
    fireEvent.click(tab('Projects'));
    expect(push.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ nav: 1, projectId: 's1' }),
      expect.objectContaining({ nav: 2, projectId: 's1', leaf: 'tab', tabId: 't1' }),
    ]);
  });
});

