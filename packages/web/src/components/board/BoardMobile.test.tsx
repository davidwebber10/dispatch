import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BoardMobile } from './BoardMobile';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

// useBoardData's mount-time load races a resolved mock against directly-seeded store state
// (see useBoardData.test.ts) — a promise that never settles keeps `loading: true` forever
// without ever overwriting what this file seeds into useTabs.byProject.
const neverSettles = () => new Promise<never>(() => { /* never resolves */ });

function terminal(overrides: Partial<Terminal>): Terminal {
  return {
    id: 't-default',
    sessionId: 'p1',
    type: 'claude-code',
    label: 'thread',
    pid: null,
    externalId: null,
    workingDir: null,
    status: 'waiting',
    createdAt: '',
    config: {},
    archivedAt: null,
    sortOrder: 0,
    ...overrides,
  } as Terminal;
}

// One terminal per column, so every section renders non-empty in the default fixture.
function seedOneOfEach() {
  useProjects.setState({ sessions: [{ id: 'p1', name: 'dispatch' } as any] });
  useTabs.setState({
    byProject: {
      p1: [
        terminal({ id: 'needs-help-1', label: 'Thread Naming', status: 'needs_input' }),
        terminal({
          id: 'complete-1',
          label: 'Pretty resume + rows',
          status: 'waiting',
          config: { lastOutcome: { summary: 'shipped v2.6.0', needsHelp: false, inferred: false, at: '' } },
        }),
        terminal({ id: 'working-1', label: 'Integrate wave 9', status: 'working' }),
        terminal({
          id: 'resting-1',
          label: 'Rail cleanup',
          status: 'waiting',
          config: {
            lastOutcome: { summary: 'merged', needsHelp: false, inferred: false, at: '' },
            boardState: { acknowledgedAt: '2026-01-01T00:00:00Z' },
          },
        }),
      ],
    },
  });
}

beforeEach(() => {
  useProjects.setState({ sessions: [], activeId: null });
  useTabs.setState({ byProject: {} });
  useThreadStatus.setState({ byTerminal: {} });
  vi.restoreAllMocks();
  vi.spyOn(api, 'listTerminals').mockImplementation(neverSettles);
  vi.spyOn(api, 'setBoardState').mockResolvedValue(undefined);
});

describe('BoardMobile — initial expand/collapse state', () => {
  it('renders Needs Help expanded — its card is in the document', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByText('Thread Naming')).toBeInTheDocument();
  });

  it('renders Complete expanded — its card is in the document', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByText('Pretty resume + rows')).toBeInTheDocument();
  });

  it('renders Working collapsed — its card is NOT in the document', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.queryByText('Integrate wave 9')).not.toBeInTheDocument();
  });

  it('renders Resting collapsed — its card is NOT in the document', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.queryByText('Rail cleanup')).not.toBeInTheDocument();
  });
});

describe('BoardMobile — counts always visible', () => {
  it('shows all four section counts regardless of expansion state', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    // One card seeded per column — every header's count reads "1", whether the section
    // is expanded (Needs Help/Complete) or collapsed (Working/Resting).
    expect(screen.getByTestId('board-section-needs_help')).toHaveTextContent('1');
    expect(screen.getByTestId('board-section-complete')).toHaveTextContent('1');
    expect(screen.getByTestId('board-section-working')).toHaveTextContent('1');
    expect(screen.getByTestId('board-section-resting')).toHaveTextContent('1');
  });

  it('shows a zero count for an empty column rather than hiding the header', () => {
    useProjects.setState({ sessions: [{ id: 'p1', name: 'dispatch' } as any] });
    useTabs.setState({ byProject: { p1: [] } });
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('board-section-needs_help')).toHaveTextContent('0');
    expect(screen.getByTestId('board-section-complete')).toHaveTextContent('0');
    expect(screen.getByTestId('board-section-working')).toHaveTextContent('0');
    expect(screen.getByTestId('board-section-resting')).toHaveTextContent('0');
  });
});

describe('BoardMobile — tapping a header toggles expansion', () => {
  // Each case renders fresh and performs exactly one interaction, per the brief: clicking
  // several headers in one render and asserting afterwards would pass even if the toggle
  // handler were wired to the wrong section.
  it('tapping the collapsed Working header expands it, revealing its card', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.queryByText('Integrate wave 9')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('board-section-toggle-working'));
    expect(screen.getByText('Integrate wave 9')).toBeInTheDocument();
  });

  it('tapping the collapsed Resting header expands it, revealing its card', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.queryByText('Rail cleanup')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('board-section-toggle-resting'));
    expect(screen.getByText('Rail cleanup')).toBeInTheDocument();
  });

  it('tapping the expanded Needs Help header collapses it, hiding its card', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByText('Thread Naming')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('board-section-toggle-needs_help'));
    expect(screen.queryByText('Thread Naming')).not.toBeInTheDocument();
  });

  it('tapping the expanded Complete header collapses it, hiding its card', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByText('Pretty resume + rows')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('board-section-toggle-complete'));
    expect(screen.queryByText('Pretty resume + rows')).not.toBeInTheDocument();
  });

  it('a toggle never affects a different section (only Working expands, not Resting)', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    fireEvent.click(screen.getByTestId('board-section-toggle-working'));
    expect(screen.getByText('Integrate wave 9')).toBeInTheDocument();
    expect(screen.queryByText('Rail cleanup')).not.toBeInTheDocument();
  });
});

describe('BoardMobile — opening a card', () => {
  it('clicking a card calls onOpenThread with its project and terminal id', () => {
    seedOneOfEach();
    const onOpenThread = vi.fn();
    render(<BoardMobile onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByText('Thread Naming'));
    expect(onOpenThread).toHaveBeenCalledWith('p1', 'needs-help-1');
  });
});

describe('BoardMobile — manual override via long-press', () => {
  it('renders no visible ⋯ trigger on mobile — the override menu opens via long-press only', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
  });

  it('a long-press (contextmenu) on a card opens the override menu with the three targets', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText('Thread Naming'));
    const menu = screen.getByTestId('move-to-menu');
    expect(within(menu).getByRole('button', { name: 'Needs help' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Complete' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Resting' })).toBeInTheDocument();
    expect(within(menu).queryByText(/working/i)).not.toBeInTheDocument();
  });

  it('choosing a target from a long-pressed card calls api.setBoardState with that override', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    // 'complete-1' (label "Pretty resume + rows") is in the Complete section, expanded by
    // default — no need to toggle a collapsed section open first.
    fireEvent.contextMenu(screen.getByText('Pretty resume + rows'));
    fireEvent.click(screen.getByRole('button', { name: 'Needs help' }));
    expect(api.setBoardState).toHaveBeenCalledTimes(1);
    expect(api.setBoardState).toHaveBeenCalledWith('complete-1', { override: 'needs_help' });
  });
});
