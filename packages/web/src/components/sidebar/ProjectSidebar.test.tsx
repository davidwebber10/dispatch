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
