import { render, screen, act, waitFor } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, expect, describe, it } from 'vitest';
import { ProjectSidebar } from './ProjectSidebar';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

beforeEach(() => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([
    { id: 't1', sessionId: 's1', type: 'claude-code', label: 'main', status: 'working' } as any,
  ]);
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
    await new Promise((r) => setTimeout(r, 220));

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
    await new Promise((r) => setTimeout(r, 220));

    // Nothing after the user moved to B may scroll them back to A's row.
    const yankedBack = revealed.some((e) => (e as HTMLElement).dataset.threadId === 't1');
    expect(yankedBack).toBe(false);
  });
});
