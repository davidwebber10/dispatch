import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, expect, describe, it } from 'vitest';
import { ProjectSidebar } from './ProjectSidebar';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import { useProjectsView } from '../../stores/projectsView';
import { Profiler } from 'react';

/* Render counters (W1-F). ProjectCard and ThreadRow are not mocked: each renders one of these
   two children on every render of its own, and the children are not memoized, so a child's
   count IS its parent's render count. The real child still renders, so every other test in
   this file sees the real sidebar. */
const renders = vi.hoisted(() => ({ card: {} as Record<string, number>, row: {} as Record<string, number> }));
vi.mock('./ArchivedSection', async (orig) => {
  const actual = await orig<typeof import('./ArchivedSection')>();
  return { ...actual, ArchivedSection: (props: any) => { renders.card[props.sessionId] = (renders.card[props.sessionId] ?? 0) + 1; return <actual.ArchivedSection {...props} />; } };
});
vi.mock('./ThreadLabel', async (orig) => {
  const actual = await orig<typeof import('./ThreadLabel')>();
  return { ...actual, ThreadLabel: (props: any) => { renders.row[props.tab.id] = (renders.row[props.tab.id] ?? 0) + 1; return <actual.ThreadLabel {...props} />; } };
});

beforeEach(() => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([
    { id: 't1', sessionId: 's1', type: 'claude-code', label: 'main', status: 'working' } as any,
  ]);
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

test('renders a card per session and its threads', async () => {
  useProjects.setState({
    sessions: [{ id: 's1', name: 'alpha', workingDir: '/srv/repo', status: 'working' } as any],
    activeId: 's1',
  });
  useTabs.setState({
    byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'main', status: 'working' } as any] },
    activeTabId: null,
  });
  render(<ProjectSidebar onSelectTab={() => {}} />);
  expect(await screen.findByText('alpha')).toBeInTheDocument();
  expect(screen.getByText('main')).toBeInTheDocument();
});

/* Keeping the ACTIVE project/thread visible.

   Selecting a tab in the top strip switches the sidebar highlight to that tab's project — but with
   many projects the highlighted row can sit outside the sidebar's vertical scroll, so the user
   picks a tab and the left column appears not to react at all. The sidebar has to scroll to it. */

describe('ProjectSidebar reveals the active row', () => {
  let revealed: Element[];

  beforeEach(() => {
    revealed = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      revealed.push(this);
    });
    useProjects.setState({
      sessions: [
        { id: 's1', name: 'alpha', workingDir: '/a', status: 'idle' } as any,
        { id: 's2', name: 'beta', workingDir: '/b', status: 'idle' } as any,
      ],
      activeId: 's1',
    });
    useTabs.setState({
      byProject: {
        s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any],
        s2: [{ id: 't2', sessionId: 's2', type: 'claude-code', label: 'beta-thread', status: 'idle' } as any],
      },
      openTabIds: ['t1', 't2'],
      activeTabId: 't1',
      tabSession: { t1: 's1', t2: 's2' },
    });
  });

  it('scrolls to the thread of a tab activated from the top strip', async () => {
    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('beta');
    revealed.length = 0;                                     // ignore the mount reveal

    // Exactly what clicking the t2 chip in the tab bar does: focuses t2 AND moves the project
    // highlight to s2 (openTab calls useProjects.setActive).
    act(() => { useTabs.getState().setActiveTab('t2'); });

    await waitFor(() => expect(revealed.length).toBeGreaterThan(0));
    const el = revealed[revealed.length - 1] as HTMLElement;
    // It must be BETA's row — revealing alpha's would scroll to the wrong place entirely.
    expect(el.dataset.threadId === 't2' || el.dataset.projectId === 's2').toBe(true);
  });

  it('falls back to the project card when the thread row is not in the DOM yet', async () => {
    // A project's threads are fetched async on expand, so right after activation the row can be
    // missing. Revealing the card still gets the user to the right place.
    useTabs.setState({ byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any] } });
    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('beta');
    revealed.length = 0;

    act(() => { useProjects.getState().setActive('s2'); useTabs.setState({ activeTabId: 'tX' }); });

    await waitFor(() => expect(revealed.length).toBeGreaterThan(0));
    expect((revealed[revealed.length - 1] as HTMLElement).dataset.projectId).toBe('s2');
  });
});

describe('ProjectSidebar does not fight a user who scrolled away', () => {
  let revealed: Element[];

  beforeEach(() => {
    revealed = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      revealed.push(this);
    });
    useProjects.setState({
      sessions: [{ id: 's1', name: 'alpha', workingDir: '/a', status: 'idle' } as any],
      activeId: 's1',
    });
    useTabs.setState({
      byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any] },
      openTabIds: ['t1'],
      activeTabId: 't1',
      tabSession: { t1: 's1' },
    });
  });

  it('re-reveals ONLY when the selection changes — not on every terminal:status tick', async () => {
    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('alpha');
    revealed.length = 0;

    // A status event replaces byProject with a NEW object. This happens constantly as agents flip
    // working<->idle. If it re-revealed, it would yank the sidebar back every few seconds while the
    // user is deliberately looking somewhere else.
    act(() => {
      useTabs.setState({
        byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'working' } as any] },
      });
    });
    act(() => {
      useTabs.setState({
        byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any] },
      });
    });

    expect(revealed).toHaveLength(0);   // selection never changed — do not move the user's scroll
  });

  it('still reveals a thread row that arrives LATE (threads load async on expand)', async () => {
    // The card auto-calls loadTabs() when it expands (ProjectCard). Return NOTHING from it, so the
    // thread genuinely is not in the DOM at mount and the only reveal available is the coarse
    // project card — the exact situation the precise/coarse distinction exists for.
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    useTabs.setState({ byProject: {}, activeTabId: 't1' });

    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('alpha');

    // Mount could only reveal the CARD — the row did not exist.
    await waitFor(() => expect(revealed.length).toBeGreaterThan(0));
    expect((revealed[revealed.length - 1] as HTMLElement).dataset.projectId).toBe('s1');
    revealed.length = 0;

    // Now the threads land. The provisional card reveal must UPGRADE to the precise row.
    act(() => {
      useTabs.setState({
        byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any] },
      });
    });

    await waitFor(() => expect(revealed.length).toBeGreaterThan(0));
    expect((revealed[revealed.length - 1] as HTMLElement).dataset.threadId).toBe('t1');
  });
});

describe('ProjectSidebar does not aim at a row inside a collapsed card', () => {
  let revealed: Element[];

  beforeEach(() => {
    revealed = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      revealed.push(this);
    });
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    useProjects.setState({
      sessions: [
        { id: 's1', name: 'alpha', workingDir: '/a', status: 'idle' } as any,
        { id: 's2', name: 'beta', workingDir: '/b', status: 'idle' } as any,
      ],
      activeId: 's1',
    });
    useTabs.setState({
      byProject: {
        s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any],
        s2: [{ id: 't2', sessionId: 's2', type: 'claude-code', label: 'beta-thread', status: 'idle' } as any],
      },
      openTabIds: ['t1', 't2'],
      activeTabId: 't1',
      tabSession: { t1: 's1', t2: 's2' },
    });
  });

  it('reveals the CARD first while beta is still collapsed, then the ROW once it expands', async () => {
    // beta's rows are in the DOM from the start — the collapse is grid-template-rows: 0fr with
    // overflow:hidden, NOT a conditional render. So querySelector finds a zero-height, invisible
    // row, and scrolling to it lands nowhere useful. The row is only a valid target once its card
    // is actually open.
    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('beta');
    revealed.length = 0;

    act(() => { useTabs.getState().setActiveTab('t2'); });   // activates t2 AND makes s2 the project

    await waitFor(() => expect(revealed.length).toBeGreaterThan(0));

    // The FIRST thing revealed must be beta's card, not its still-collapsed row.
    expect((revealed[0] as HTMLElement).dataset.projectId).toBe('s2');

    // ...and once the auto-expand commits, we upgrade to the precise row.
    await waitFor(() =>
      expect(revealed.some((e) => (e as HTMLElement).dataset.threadId === 't2')).toBe(true),
    );
  });
});

describe('ProjectSidebar settle pass survives the thread-list reload', () => {
  let revealed: Element[];

  beforeEach(() => {
    revealed = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      revealed.push(this);
    });
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    useProjects.setState({
      sessions: [
        { id: 's1', name: 'alpha', workingDir: '/a', status: 'idle' } as any,
        { id: 's2', name: 'beta', workingDir: '/b', status: 'idle' } as any,
      ],
      activeId: 's1',
    });
    useTabs.setState({
      byProject: {
        s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any],
        s2: [{ id: 't2', sessionId: 's2', type: 'claude-code', label: 'beta-thread', status: 'idle' } as any],
      },
      openTabIds: ['t1', 't2'],
      activeTabId: 't1',
      tabSession: { t1: 's1', t2: 's2' },
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('still fires after byProject changes mid-animation (ProjectCard reloads threads on expand)', async () => {
    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('beta');
    revealed.length = 0;

    act(() => { useTabs.getState().setActiveTab('t2'); });
    await waitFor(() => expect(revealed.some((e) => (e as HTMLElement).dataset.threadId === 't2')).toBe(true));
    const afterFirst = revealed.filter((e) => (e as HTMLElement).dataset.threadId === 't2').length;

    // Expanding the card makes ProjectCard call loadTabs(), which lands a NEW byProject object a few
    // ms later — well inside the 140ms settle window. byProject is in the effect's deps, so the
    // re-run tears down the effect. If the settle timer lives in that teardown, it dies here and the
    // row is left wherever the mid-animation scroll dropped it.
    act(() => {
      useTabs.setState({
        byProject: {
          s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any],
          s2: [{ id: 't2', sessionId: 's2', type: 'claude-code', label: 'beta-thread', status: 'working' } as any],
        },
      });
    });

    // Let the expand transition settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 220)); });

    const afterSettle = revealed.filter((e) => (e as HTMLElement).dataset.threadId === 't2').length;
    expect(afterSettle).toBeGreaterThan(afterFirst);   // the corrective pass MUST still have run
  });
});

describe('ProjectSidebar never yanks back to a superseded selection', () => {
  let revealed: Element[];

  beforeEach(() => {
    revealed = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      revealed.push(this);
    });
    // Per-session: alpha keeps its row (so activating it takes the PRECISE path and schedules a
    // settle pass); beta never yields one (so activating it takes the CARD-ONLY path — the branch
    // that failed to cancel the pending timer). A blanket mockResolvedValue([]) would wipe alpha's
    // row too, since ProjectCard calls loadTabs() the moment it expands.
    vi.spyOn(api, 'listTerminals').mockImplementation(async (id: string) =>
      (id === 's1' ? [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' }] : []) as any,
    );
    useProjects.setState({
      sessions: [
        { id: 's1', name: 'alpha', workingDir: '/a', status: 'idle' } as any,
        { id: 's2', name: 'beta', workingDir: '/b', status: 'idle' } as any,
      ],
      activeId: 's1',
    });
    useTabs.setState({
      byProject: { s1: [{ id: 't1', sessionId: 's1', type: 'claude-code', label: 'alpha-thread', status: 'idle' } as any] },
      openTabIds: ['t1', 't2'],
      activeTabId: null,
      tabSession: { t1: 's1', t2: 's2' },
    });
  });

  it("a pending settle pass must not drag the user back after they pick something else", async () => {
    render(<ProjectSidebar onSelectTab={() => {}} />);
    await screen.findByText('beta');

    // A: alpha's thread — has a row, so this takes the PRECISE path and schedules a settle pass.
    act(() => { useTabs.setState({ activeTabId: 't1' }); useProjects.getState().setActive('s1'); });
    await waitFor(() => expect(revealed.some((e) => (e as HTMLElement).dataset.threadId === 't1')).toBe(true));

    // B, moments later: beta's thread. Its rows are not in the DOM, so this falls to the CARD-only
    // path — which is precisely the branch that did NOT cancel A's pending timer.
    revealed.length = 0;
    act(() => { useTabs.setState({ activeTabId: 't2' }); useProjects.getState().setActive('s2'); });

    // Let A's settle window elapse.
    await act(async () => { await new Promise((r) => setTimeout(r, 220)); });

    // Nothing after the user moved to B may scroll them back to A's row.
    const yankedBack = revealed.some((e) => (e as HTMLElement).dataset.threadId === 't1');
    expect(yankedBack).toBe(false);
  });
});

describe('Projects ⇄ Threads on the desktop (2026-11-07)', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectsView.setState({ view: 'projects' });
    useProjects.setState({ sessions: [{ id: 's1', name: 'alpha', workingDir: '/a', status: 'idle' } as any, { id: 's2', name: 'beta', workingDir: '/b', status: 'idle' } as any], activeId: 's1' });
    useTabs.setState({
      byProject: {
        s1: [{ id: 'old', sessionId: 's1', type: 'claude-code', label: 'Older thread', status: 'waiting', lastActivityAt: '2026-11-01T10:00:00Z' } as any],
        s2: [{ id: 'new', sessionId: 's2', type: 'claude-code', label: 'Newest thread', status: 'waiting', lastActivityAt: '2026-11-07T10:00:00Z' } as any],
      },
      activeTabId: null,
    });
    vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
  });

  it('the switch sits above the search line; Threads lists every thread, last active first, and opening one selects it', async () => {
    const onSelectTab = vi.fn();
    render(<ProjectSidebar onSelectTab={onSelectTab} />);
    const tablist = screen.getByRole('tablist', { name: 'Projects view' });
    const search = screen.getByPlaceholderText('Search projects');
    expect(tablist.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(tablist).getByRole('tab', { name: 'Threads' }));
    expect(useProjectsView.getState().view).toBe('threads');
    expect(screen.getByPlaceholderText('Search threads')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sort projects' })).toBeNull();
    const labels = await screen.findAllByText(/thread$/);
    expect(labels.map((l) => l.textContent)).toEqual(['Newest thread', 'Older thread']);
    fireEvent.click(screen.getByText('Newest thread'));
    expect(useProjects.getState().activeId).toBe('s2');
    expect(onSelectTab).toHaveBeenCalledWith('new');
    fireEvent.click(within(tablist).getByRole('tab', { name: 'Projects' }));
    expect(screen.getByPlaceholderText('Search projects')).toBeInTheDocument();
  });

  it('on the desktop: Filters sits right of the search and opens a panel there; archived threads are a folded section at the bottom', async () => {
    (api.listArchivedTerminals as any).mockImplementation(async (sid: string) => (sid === 's1' ? [{ id: 'gone', sessionId: 's1', type: 'claude-code', label: 'An archived thread', status: 'exited', archivedAt: '2026-11-02T10:00:00Z' }] : []));
    useProjectsView.setState({ view: 'threads' });
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    expect(screen.queryByRole('tablist', { name: 'Thread list' })).toBeNull();
    const search = screen.getByPlaceholderText('Search threads');
    const filters = screen.getByRole('button', { name: 'Filters' });
    expect(search.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.closest('[data-testid="sidebar-search-row"]')).toBe(filters.closest('[data-testid="sidebar-search-row"]'));
    fireEvent.click(filters);
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    expect(panel).toHaveAttribute('data-variant', 'popover');
    expect(screen.queryByTestId('sheet-panel')).toBeNull();
    fireEvent.click(filters);
    expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
    const archived = await screen.findByRole('button', { name: 'Toggle archived threads' });
    const newest = screen.getByText('Newest thread');
    expect(newest.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('An archived thread')).toBeNull();
    fireEvent.click(archived);
    expect(await screen.findByText('An archived thread')).toBeInTheDocument();
  });
});


/* W1-F: the sidebar must not render for threads it does not show.

   Before: applyEvent rebuilt every project's array on each terminal:status, ProjectSidebar
   selected all of byProject, and nothing was memoized, so ONE status event rendered every
   ProjectCard and every ThreadRow of every project. */
describe('ProjectSidebar render counts on a status event (W1-F)', () => {
  const term = (id: string, sessionId: string, status = 'working') => ({ id, sessionId, type: 'shell', label: id, status, config: {}, createdAt: '2026-11-01T00:00:00Z' }) as any;
  const statusEvent = (terminalId: string, status: string) => act(() => { useTabs.getState().applyEvent({ type: 'terminal:status', terminalId, status }); });
  const sum = (o: Record<string, number>, keep: (k: string) => boolean) => Object.entries(o).reduce((n, [k, v]) => n + (keep(k) ? v : 0), 0);

  function seed(projects: number, threadsEach: number) {
    const sessions = Array.from({ length: projects }, (_, p) => ({ id: `P${p}`, name: `project-${p}`, workingDir: `/p${p}`, status: 'working' }) as any);
    const byProject: Record<string, any[]> = {};
    for (const s of sessions) byProject[s.id] = Array.from({ length: threadsEach }, (_, i) => term(`${s.id}-t${i}`, s.id));
    // Every card loads its threads when it opens; answer what is already in the store.
    (api.listTerminals as any).mockImplementation(async (sid: string) => useTabs.getState().byProject[sid] ?? []);
    useProjectsView.setState({ view: 'projects' });
    useProjects.setState({ sessions, activeId: 'P0' });
    useTabs.setState({ byProject, openTabIds: [], activeTabId: null, tabSession: {}, loading: {} });
    return sessions;
  }
  /** Mount, open every card (as a user who expanded them), and let each card's loadTabs land. */
  async function mountOpen(sessions: { id: string; name: string }[], onRender: (id: string, phase: string, actualDuration: number) => void = () => {}) {
    const stable = () => {};
    const view = render(<Profiler id="sidebar" onRender={onRender}><ProjectSidebar onSelectTab={stable} /></Profiler>);
    await screen.findByText(sessions[0].name);
    for (const s of sessions.slice(1)) fireEvent.click(screen.getByText(s.name));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    return view;
  }

  it('a status event for project A does not render the ProjectCard of project B', async () => {
    const sessions = seed(2, 2);
    await mountOpen(sessions);
    const before = { ...renders.card };
    const rowsBefore = { ...renders.row };

    statusEvent('P0-t0', 'waiting');

    expect(screen.getByText('P1-t0')).toBeInTheDocument();
    expect(renders.card.P1).toBe(before.P1);                    // project B: no render at all
    expect(renders.row['P1-t0']).toBe(rowsBefore['P1-t0']);     // nor any of its rows
    expect(renders.row['P1-t1']).toBe(rowsBefore['P1-t1']);
    expect(renders.card.P0).toBeGreaterThan(before.P0);         // project A did update
    expect(renders.row['P0-t0']).toBeGreaterThan(rowsBefore['P0-t0']);
    expect(renders.row['P0-t1']).toBe(rowsBefore['P0-t1']);     // the sibling row in A: untouched
  });

  it('a session:status for project A does not render the ProjectCard of project B', async () => {
    const sessions = seed(2, 2);
    await mountOpen(sessions);
    const before = { ...renders.card };
    act(() => { useProjects.getState().applyEvent({ type: 'session:status', sessionId: 'P0', status: 'idle', lastActivityAt: '2026-11-09T10:00:00Z' }); });
    expect(renders.card.P1).toBe(before.P1);
    expect(renders.card.P0).toBeGreaterThan(before.P0);
  });

  it('a status event still updates the row and the project header it belongs to', async () => {
    const sessions = seed(2, 1);
    useProjects.setState({ sessions: sessions.map((s) => ({ ...s, status: 'idle' })) });
    await mountOpen(sessions);
    statusEvent('P1-t0', 'needs_input');
    const card = document.querySelector('[data-project-id="P1"]') as HTMLElement;
    // One dot on the row, one on the project header.
    expect(within(card).getAllByLabelText('status-needs_input').length).toBe(2);
    expect(within(document.querySelector('[data-project-id="P0"]') as HTMLElement).queryByLabelText('status-needs_input')).toBeNull();
  });

  // The 1A.3 number: 30 working threads (6 projects x 5), 60 status events spread over them
  // (each thread flips idle then back to working). Logged so the hand-off can quote it.
  it('30 working threads: unrelated cards and rows do not render (perf numbers)', async () => {
    const sessions = seed(6, 5);
    const prof = { commits: 0, ms: 0 };
    await mountOpen(sessions, (_id, _phase, actualDuration) => { prof.commits++; prof.ms += actualDuration; });
    prof.commits = 0; prof.ms = 0;
    const cardBefore = { ...renders.card }; const rowBefore = { ...renders.row };
    const ids = sessions.flatMap((s) => Array.from({ length: 5 }, (_, i) => `${s.id}-t${i}`));
    for (const id of ids) { statusEvent(id, 'waiting'); statusEvent(id, 'working'); }
    const events = ids.length * 2;
    const cardRenders = sum(renders.card, () => true) - sum(cardBefore, () => true);
    const rowRenders = sum(renders.row, () => true) - sum(rowBefore, () => true);
    // eslint-disable-next-line no-console
    console.log(`[W1-F perf] sidebar, 30 working threads in 6 projects, ${events} status events: ProjectCard renders=${cardRenders} (per event ${(cardRenders / events).toFixed(2)}), ThreadRow renders=${rowRenders} (per event ${(rowRenders / events).toFixed(2)}), React commits=${prof.commits}, render time=${prof.ms.toFixed(1)}ms`);
    expect(cardRenders).toBeLessThanOrEqual(events);            // at most the one card that holds the thread
    expect(rowRenders).toBeLessThanOrEqual(events);             // at most the one row
  });
});

/* W2-F (2026-11-09): the attention queue in the navigation. A filter in the Threads list and one
   "Needs you" section above the projects. It is a list: a row opens the thread. It is never a strip
   in a thread and it has no Answer button (lib/noAskStrip.test.ts). */
describe('the attention queue in the sidebar (W2-F)', () => {
  const th = (id: string, sessionId: string, label: string, status: string, lastActivityAt: string, over: Record<string, unknown> = {}) =>
    ({ id, sessionId, type: 'claude-code', label, status, config: {}, createdAt: lastActivityAt, lastActivityAt, archivedAt: null, ...over }) as any;
  beforeEach(async () => {
    localStorage.clear();
    useProjectsView.setState({ view: 'projects' });
    useProjects.setState({ sessions: [{ id: 's1', name: 'alpha', workingDir: '/a', status: 'waiting' } as any, { id: 's2', name: 'beta', workingDir: '/b', status: 'waiting' } as any], activeId: 's1' });
    useTabs.setState({
      byProject: {
        s1: [
          th('ask-new', 's1', 'Asks a new question', 'needs_input', '2026-11-09T10:30:00Z'),
          th('busy', 's1', 'Works on it', 'working', '2026-11-09T10:40:00Z'),
          th('quiet', 's1', 'Rests', 'waiting', '2026-11-09T10:50:00Z'),
          th('archived', 's1', 'Archived question', 'needs_input', '2026-11-09T09:00:00Z', { archivedAt: '2026-11-09T09:30:00Z' }),
        ],
        s2: [
          th('broke', 's2', 'Broke down', 'error', '2026-11-09T08:00:00Z'),
          th('ask-old', 's2', 'Asks an old question', 'needs_input', '2026-11-09T07:00:00Z'),
          th('stuck', 's2', 'Sends nothing', 'working', '2026-11-09T10:45:00Z'),
        ],
      },
      activeTabId: null,
    });
    vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
    vi.spyOn(api, 'listStalls').mockResolvedValue([]);
    const { useThreadStatus } = await import('../../stores/threadStatus');
    const { useSectionCollapse } = await import('../../stores/sectionCollapse');
    useSectionCollapse.setState({ collapsed: {} });
    useThreadStatus.setState({ byTerminal: {}, stalls: { stuck: Date.parse('2026-11-09T10:45:00Z') } });
  });
  const rowLabels = () => Array.from(document.querySelectorAll('[data-thread-id]')).map((row) => row.querySelector('span[aria-label]')?.getAttribute('aria-label'));
  const pickStatus = (name: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    const header = screen.getByRole('button', { name: /^Status: / });
    if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name }));
  };

  it('the Needs you filter shows only threads that need input or have an error', async () => {
    useProjectsView.setState({ view: 'threads' });
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    await waitFor(() => expect(rowLabels()).toHaveLength(6));
    pickStatus(/^Needs you/);
    expect(rowLabels().sort()).toEqual(['Asks a new question', 'Asks an old question', 'Broke down']);
    // The choice names its count, and the closed panel shows it as a pill.
    expect(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: /^Needs you/ })).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    expect(screen.getByTestId('applied-filters')).toHaveTextContent('Status');
    expect(screen.getByTestId('applied-filters')).toHaveTextContent('Needs you');
  });

  it('the Working filter shows only the threads that work, and All shows every thread again', async () => {
    useProjectsView.setState({ view: 'threads' });
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    await waitFor(() => expect(rowLabels()).toHaveLength(6));
    pickStatus(/^Working/);
    expect(rowLabels().sort()).toEqual(['Sends nothing', 'Works on it']);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: /^All/ }));
    expect(rowLabels()).toHaveLength(6);
  });

  it('the status filter follows a live status event', async () => {
    useProjectsView.setState({ view: 'threads' });
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    await waitFor(() => expect(rowLabels()).toHaveLength(6));
    pickStatus(/^Needs you/);
    act(() => { useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'quiet', status: 'needs_input' } as any); });
    expect(rowLabels()).toContain('Rests');
    act(() => { useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'broke', status: 'working' } as any); });
    expect(rowLabels()).not.toContain('Broke down');
  });

  it('the Needs you section lists the queue across projects, above the projects: needs input, error, stalled; oldest first', async () => {
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    const section = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(section).getByRole('button', { name: /needs you/i })).toHaveTextContent('Needs you (4)');
    const rows = within(section).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-attention-id'))).toEqual(['ask-old', 'ask-new', 'broke', 'stuck']);
    expect(rows[0]).toHaveTextContent('Asks an old question');
    expect(rows[0]).toHaveTextContent('beta');
    expect(rows[0]).toHaveTextContent('Needs input');
    expect(rows[2]).toHaveTextContent('Error');
    expect(rows[3]).toHaveTextContent('No output');
    // Above the project cards.
    const card = document.querySelector('[data-project-id="s1"]')!;
    expect(section.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // An archived thread is not in it.
    expect(section).not.toHaveTextContent('Archived question');
  });

  it('the Needs you section has no button with the name Answer', async () => {
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    const section = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(section).queryByRole('button', { name: /answer/i })).toBeNull();
    expect(section).not.toHaveTextContent(/answer/i);
    expect(section).not.toHaveTextContent(/asking you/i);
    // One control per row (the row itself), plus the fold of the section.
    expect(within(section).getAllByRole('button')).toHaveLength(1 + 4);
  });

  it('a row of the Needs you section opens the thread in its project', async () => {
    const onSelectTab = vi.fn();
    render(<ProjectSidebar onSelectTab={onSelectTab} />);
    const section = await screen.findByRole('region', { name: 'Needs you' });
    fireEvent.click(within(section).getByRole('button', { name: /Asks an old question/ }));
    expect(useProjects.getState().activeId).toBe('s2');
    expect(onSelectTab).toHaveBeenCalledWith('ask-old');
  });

  it('the Needs you section folds, remembers that, and is absent when nothing waits', async () => {
    const { unmount } = render(<ProjectSidebar onSelectTab={vi.fn()} />);
    const section = await screen.findByRole('region', { name: 'Needs you' });
    const fold = within(section).getByRole('button', { name: /needs you/i });
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
    expect(fold).toHaveTextContent('Needs you (4)'); // the count stays while folded
    unmount();
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    expect(within(await screen.findByRole('region', { name: 'Needs you' })).getByRole('button', { name: /needs you/i })).toHaveAttribute('aria-expanded', 'false');
    act(() => { useTabs.setState({ byProject: { s1: [th('quiet', 's1', 'Rests', 'waiting', '2026-11-09T10:50:00Z')] } }); });
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  });

  it('the Needs you section does not render the project cards on a status event (W1-F stays true)', async () => {
    render(<ProjectSidebar onSelectTab={vi.fn()} />);
    await screen.findByRole('region', { name: 'Needs you' });
    const before = { ...renders.card };
    act(() => { useTabs.getState().applyEvent({ type: 'terminal:status', terminalId: 'ask-new', status: 'working' } as any); });
    expect(within(screen.getByRole('region', { name: 'Needs you' })).getAllByRole('listitem')).toHaveLength(3);
    expect(renders.card.s2).toBe(before.s2);
  });
});
