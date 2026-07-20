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
});

function terminal(id: string, label: string, status: string, config: Record<string, unknown> = {}) {
  return { id, label, status, config, archivedAt: null } as any;
}

test('renders all four columns, in the specified order, with correct counts', () => {
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

  const order = Array.from(screen.getByTestId('board-columns').children).map((el) => el.getAttribute('data-testid'));
  expect(order).toEqual(['board-column-needs_help', 'board-column-complete', 'board-column-working', 'board-column-resting']);

  expect(screen.getByTestId('board-column-count-needs_help')).toHaveTextContent('2');
  expect(screen.getByTestId('board-column-count-complete')).toHaveTextContent('1');
  expect(screen.getByTestId('board-column-count-working')).toHaveTextContent('3');
  expect(screen.getByTestId('board-column-count-resting')).toHaveTextContent('2');
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
        terminal('t2', 'Done One', 'waiting', { lastOutcome: { summary: 'shipped', needsHelp: false, inferred: false, at: '' } }),
        terminal('t3', 'Live One', 'working'),
      ],
    },
  });

  render(<BoardView />);

  const restingCol = screen.getByTestId('board-column-resting');
  expect(within(restingCol).getByText('RESTING')).toBeInTheDocument();
  expect(screen.getByTestId('board-column-count-resting')).toHaveTextContent('0');
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
