import { render, screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { BoardView } from './BoardView';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';

// A load that never settles — useBoardData's mount effect calls api.listTerminals per
// project and would otherwise race the fixtures seeded directly into useTabs below,
// overwriting them with an empty list. Same trick useBoardData.test.ts uses.
const neverSettles = () => new Promise<never>(() => { /* never resolves */ });

beforeEach(() => {
  useProjects.setState({ sessions: [], activeId: null });
  useTabs.setState({ byProject: {} });
  useThreadStatus.setState({ byTerminal: {} });
  vi.restoreAllMocks();
  vi.spyOn(api, 'listTerminals').mockImplementation(neverSettles);
  vi.spyOn(api, 'setBoardState').mockResolvedValue(undefined);
});

function terminal(id: string, label: string, status: string, config: Record<string, unknown> = {}) {
  return { id, label, status, config, archivedAt: null } as any;
}

// A resting terminal with an explicit `lastActivityAt` — the Resting rail's rollup/expanded
// views group and sort on it, and the plain `terminal()` helper above leaves it unset (so every
// row in a test would tie at '' and fall back on insertion order alone). Status 'waiting' with
// no `lastOutcome` is boardColumn.ts's own "never ran a turn" path straight to Resting.
function restingTerminal(id: string, label: string, lastActivityAt: string) {
  return { id, label, status: 'waiting', config: {}, archivedAt: null, lastActivityAt } as any;
}

test('renders the three real columns in order, plus the Resting rail total, with correct counts', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        terminal('t1', 'Ask One', 'needs_input'),
        terminal('t2', 'Ask Two', 'error'),
        terminal('t3', 'Done One', 'waiting', { lastOutcome: { summary: 'shipped', needsHelp: false, inferred: false, at: '' } }),
        terminal('t4', 'Live One', 'working'),
        terminal('t5', 'Live Two', 'working'),
        terminal('t6', 'Pending One', 'queued'),
        terminal('t7', 'Rest One', 'waiting'),
        terminal('t8', 'Rest Two', 'waiting'),
      ],
    },
  });

  render(<BoardView />);

  // Resting is no longer one of the "real" columns inside board-columns — it's its own rail
  // (see RestingRail.tsx), so only three children now, not four.
  const order = Array.from(screen.getByTestId('board-columns').children).map((el) => el.getAttribute('data-testid'));
  expect(order).toEqual(['board-column-needs_help', 'board-column-complete', 'board-column-working']);

  expect(screen.getByTestId('board-column-count-needs_help')).toHaveTextContent('2');
  expect(screen.getByTestId('board-column-count-complete')).toHaveTextContent('1');
  expect(screen.getByTestId('board-column-count-working')).toHaveTextContent('3');
  expect(screen.getByTestId('board-resting-total')).toHaveTextContent('2');
});

test('a filter chip narrows the board to one project; All projects restores it', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any, { id: 'p2', name: 'Beta' } as any] });
  useTabs.setState({
    byProject: {
      p1: [terminal('t1', 'Alpha Thread', 'working')],
      p2: [terminal('t2', 'Beta Thread', 'working')],
    },
  });

  render(<BoardView />);

  expect(screen.getByText('Alpha Thread')).toBeInTheDocument();
  expect(screen.getByText('Beta Thread')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
  expect(screen.getByText('Alpha Thread')).toBeInTheDocument();
  expect(screen.queryByText('Beta Thread')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
  expect(screen.getByText('Alpha Thread')).toBeInTheDocument();
  expect(screen.getByText('Beta Thread')).toBeInTheDocument();
});

test('an empty column still renders its header and a zero count', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        terminal('t1', 'Ask One', 'needs_input'),
        terminal('t3', 'Live One', 'working'),
      ],
    },
  });

  render(<BoardView />);

  const completeCol = screen.getByTestId('board-column-complete');
  expect(within(completeCol).getByText('COMPLETE')).toBeInTheDocument();
  expect(screen.getByTestId('board-column-count-complete')).toHaveTextContent('0');
});

test('the Working column separates live cards from pending, with the divider between', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        terminal('t1', 'Live One', 'working'),
        terminal('t2', 'Live Two', 'working'),
        terminal('t3', 'Pending One', 'queued'),
        terminal('t4', 'Pending Two', 'scheduled'),
      ],
    },
  });

  render(<BoardView />);

  const col = screen.getByTestId('board-column-working');
  const text = col.textContent ?? '';
  const liveOneIdx = text.indexOf('Live One');
  const liveTwoIdx = text.indexOf('Live Two');
  const dividerIdx = text.indexOf('WAITING — RESUMES ON ITS OWN');
  const pendingOneIdx = text.indexOf('Pending One');
  const pendingTwoIdx = text.indexOf('Pending Two');

  expect(liveOneIdx).toBeGreaterThan(-1);
  expect(liveTwoIdx).toBeGreaterThan(liveOneIdx);
  expect(dividerIdx).toBeGreaterThan(liveTwoIdx);
  expect(pendingOneIdx).toBeGreaterThan(dividerIdx);
  expect(pendingTwoIdx).toBeGreaterThan(pendingOneIdx);
});

test('only the Complete column header renders a "Clear all" control', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        terminal('t1', 'Ask One', 'needs_input'),
        terminal('t2', 'Done One', 'waiting', { lastOutcome: { summary: 'shipped', needsHelp: false, inferred: false, at: '' } }),
        terminal('t3', 'Live One', 'working'),
        terminal('t4', 'Rest One', 'waiting'),
      ],
    },
  });

  render(<BoardView />);

  expect(within(screen.getByTestId('board-column-complete')).getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
  expect(within(screen.getByTestId('board-column-needs_help')).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  expect(within(screen.getByTestId('board-column-working')).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  expect(within(screen.getByTestId('board-resting-rail')).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
});

test('an empty Complete column renders no "Clear all" control', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({ byProject: { p1: [terminal('t1', 'Live One', 'working')] } });

  render(<BoardView />);

  expect(within(screen.getByTestId('board-column-complete')).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
});

test('Clear all acknowledges every card in the Complete column — call count matches card count, not just "was called"', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        terminal('t1', 'Done One', 'waiting', { lastOutcome: { summary: 'shipped', needsHelp: false, inferred: false, at: '' } }),
        terminal('t2', 'Done Two', 'waiting', { lastOutcome: { summary: 'merged', needsHelp: false, inferred: false, at: '' } }),
        terminal('t3', 'Done Three', 'waiting', { lastOutcome: { summary: 'reconciled', needsHelp: false, inferred: false, at: '' } }),
        // A non-Complete card in the mix — Clear all must not touch it.
        terminal('t4', 'Still Working', 'working'),
      ],
    },
  });

  render(<BoardView />);

  fireEvent.click(within(screen.getByTestId('board-column-complete')).getByRole('button', { name: 'Clear all' }));

  expect(api.setBoardState).toHaveBeenCalledTimes(3);
  expect(api.setBoardState).toHaveBeenCalledWith('t1', { acknowledged: true });
  expect(api.setBoardState).toHaveBeenCalledWith('t2', { acknowledged: true });
  expect(api.setBoardState).toHaveBeenCalledWith('t3', { acknowledged: true });
  expect(api.setBoardState).not.toHaveBeenCalledWith('t4', { acknowledged: true });
});

test('each card renders a "Move to…" trigger that opens a menu offering the three override targets, never Working', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({ byProject: { p1: [terminal('t1', 'Ask One', 'needs_input')] } });

  render(<BoardView />);

  fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
  const menu = screen.getByTestId('move-to-menu');
  expect(within(menu).getByRole('button', { name: 'Needs help' })).toBeInTheDocument();
  expect(within(menu).getByRole('button', { name: 'Complete' })).toBeInTheDocument();
  expect(within(menu).getByRole('button', { name: 'Resting' })).toBeInTheDocument();
  expect(within(menu).queryByText(/working/i)).not.toBeInTheDocument();
});

test('choosing a target from the card menu calls api.setBoardState with that override', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({ byProject: { p1: [terminal('t1', 'Stuck Working', 'working')] } });

  render(<BoardView />);

  fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Complete' }));

  expect(api.setBoardState).toHaveBeenCalledTimes(1);
  expect(api.setBoardState).toHaveBeenCalledWith('t1', { override: 'complete' });
});

test('Resting renders collapsed by default, showing per-project rollup rows and a total — not individual thread cards', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        restingTerminal('t1', 'Rest One', '2024-01-01T00:00:00Z'),
        restingTerminal('t2', 'Rest Two', '2024-01-02T00:00:00Z'),
        restingTerminal('t3', 'Rest Three', '2024-01-03T00:00:00Z'),
      ],
    },
  });

  render(<BoardView />);

  // Individual threads never render — only the rollup.
  expect(screen.queryByText('Rest One')).not.toBeInTheDocument();
  expect(screen.queryByText('Rest Two')).not.toBeInTheDocument();
  expect(screen.queryByText('Rest Three')).not.toBeInTheDocument();

  const collapsed = screen.getByTestId('board-resting-collapsed');
  expect(within(collapsed).getByText('Alpha')).toBeInTheDocument();
  expect(within(collapsed).getByText('threads at rest')).toBeInTheDocument();
  expect(screen.getByTestId('board-resting-total')).toHaveTextContent('3');

  expect(screen.queryByTestId('board-resting-expanded')).not.toBeInTheDocument();
});

test('clicking the Resting header expands it; groups appear newest-first and capped, with a "more in <project>" affordance', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        restingTerminal('t1', 'Rest One', '2024-01-01T00:00:00Z'),
        restingTerminal('t2', 'Rest Two', '2024-01-02T00:00:00Z'),
        restingTerminal('t3', 'Rest Three', '2024-01-03T00:00:00Z'),
        restingTerminal('t4', 'Rest Four', '2024-01-04T00:00:00Z'),
        restingTerminal('t5', 'Rest Five', '2024-01-05T00:00:00Z'),
      ],
    },
  });

  render(<BoardView />);

  fireEvent.click(screen.getByTestId('board-resting-toggle'));

  const rows = screen.getAllByTestId('board-resting-thread-row');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent('Rest Five');
  expect(rows[1]).toHaveTextContent('Rest Four');
  expect(rows[2]).toHaveTextContent('Rest Three');

  expect(screen.getByRole('button', { name: /2 more in Alpha/ })).toBeInTheDocument();
});

test('only projects with non-resting activity get a filter chip; an all-resting project does not get one', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any, { id: 'p2', name: 'Beta' } as any] });
  useTabs.setState({
    byProject: {
      p1: [terminal('t1', 'Alpha Thread', 'working')],
      p2: [
        restingTerminal('t2', 'Beta Rest One', '2024-01-01T00:00:00Z'),
        restingTerminal('t3', 'Beta Rest Two', '2024-01-02T00:00:00Z'),
      ],
    },
  });

  render(<BoardView />);

  expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument();
});

test('the Needs Help empty state renders its headline when that column is empty', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({ byProject: { p1: [terminal('t1', 'Live One', 'working')] } });

  render(<BoardView />);

  expect(within(screen.getByTestId('board-column-needs_help')).getByText("Nobody's waiting on you")).toBeInTheDocument();
});

test('the whole-board-idle state renders when nothing is in Needs Help / Complete / Working', () => {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'Alpha' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        restingTerminal('t1', 'Rest One', '2024-01-01T00:00:00Z'),
        restingTerminal('t2', 'Rest Two', '2024-01-02T00:00:00Z'),
      ],
    },
  });

  render(<BoardView />);

  expect(screen.getByText('Nothing running')).toBeInTheDocument();
  expect(screen.queryByTestId('board-column-needs_help')).not.toBeInTheDocument();
  expect(screen.queryByTestId('board-column-complete')).not.toBeInTheDocument();
  expect(screen.queryByTestId('board-column-working')).not.toBeInTheDocument();

  // The rail stays put — the idle copy points at it ("wake a resting thread").
  expect(screen.getByTestId('board-resting-rail')).toBeInTheDocument();
  expect(screen.getByTestId('board-resting-total')).toHaveTextContent('2');
});
