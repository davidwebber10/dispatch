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

  it('tapping the collapsed Resting header expands it, revealing the grouped rollup (not its card)', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.queryByText('Rail cleanup')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('board-section-toggle-resting'));
    expect(screen.queryByText('Rail cleanup')).not.toBeInTheDocument();
    const rollup = screen.getByTestId('board-resting-rollup');
    expect(within(rollup).getByText('dispatch')).toBeInTheDocument();
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

describe('BoardMobile — persistent count bar', () => {
  // The core requirement: the bar is a SECOND, always-rendered source for all four counts,
  // independent of `expanded` — collapsing/expanding sections must never hide or blank a tile.
  it('shows all four counts in the bar regardless of which sections are expanded or collapsed', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    // Flip every section's default state — collapse the two that start open, expand the two
    // that start closed — so the bar is checked against the OPPOSITE of the default layout.
    fireEvent.click(screen.getByTestId('board-section-toggle-needs_help'));
    fireEvent.click(screen.getByTestId('board-section-toggle-complete'));
    fireEvent.click(screen.getByTestId('board-section-toggle-working'));
    fireEvent.click(screen.getByTestId('board-section-toggle-resting'));
    expect(screen.getByTestId('board-count-needs_help')).toHaveTextContent('1');
    expect(screen.getByTestId('board-count-complete')).toHaveTextContent('1');
    expect(screen.getByTestId('board-count-working')).toHaveTextContent('1');
    expect(screen.getByTestId('board-count-resting')).toHaveTextContent('1');
  });

  it('shows distinct per-column counts in the bar with no section expanded or collapsed touched', () => {
    // Distinct numbers per column (rather than seedOneOfEach's uniform 1s) so a column-index
    // mix-up in the bar's mapping couldn't hide behind coincidentally-equal counts.
    useProjects.setState({ sessions: [{ id: 'p1', name: 'dispatch' } as any] });
    useTabs.setState({
      byProject: {
        p1: [
          terminal({ id: 'nh-1', label: 'a', status: 'needs_input' }),
          terminal({ id: 'nh-2', label: 'b', status: 'needs_input' }),
          terminal({
            id: 'c-1',
            label: 'c',
            status: 'waiting',
            config: { lastOutcome: { summary: 'done', needsHelp: false, inferred: false, at: '' } },
          }),
          terminal({ id: 'w-1', label: 'd', status: 'working' }),
          terminal({ id: 'w-2', label: 'e', status: 'working' }),
          terminal({ id: 'w-3', label: 'f', status: 'working' }),
        ],
      },
    });
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('board-count-needs_help')).toHaveTextContent('2');
    expect(screen.getByTestId('board-count-complete')).toHaveTextContent('1');
    expect(screen.getByTestId('board-count-working')).toHaveTextContent('3');
    expect(screen.getByTestId('board-count-resting')).toHaveTextContent('0');
  });

  it('shows zero counts in the bar for an empty board rather than omitting a tile', () => {
    useProjects.setState({ sessions: [{ id: 'p1', name: 'dispatch' } as any] });
    useTabs.setState({ byProject: { p1: [] } });
    render(<BoardMobile onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('board-count-needs_help')).toHaveTextContent('0');
    expect(screen.getByTestId('board-count-complete')).toHaveTextContent('0');
    expect(screen.getByTestId('board-count-working')).toHaveTextContent('0');
    expect(screen.getByTestId('board-count-resting')).toHaveTextContent('0');
  });
});

describe('BoardMobile — Resting grouped rollup', () => {
  it('expanding Resting shows one rollup row per project, not individual cards', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    fireEvent.click(screen.getByTestId('board-section-toggle-resting'));
    const rollup = screen.getByTestId('board-resting-rollup');
    expect(within(rollup).getByText('dispatch')).toBeInTheDocument();
    expect(within(rollup).getByText('1')).toBeInTheDocument();
    // The individual card's own label never renders, and no board-card element exists inside
    // the Resting section at all — the rollup fully replaces the per-card list.
    expect(screen.queryByText('Rail cleanup')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('board-section-resting')).queryByTestId('board-card')).not.toBeInTheDocument();
  });

  it('groups resting threads from different projects into separate rollup rows with their own counts', () => {
    const restingOutcome = { lastOutcome: { summary: 'done', needsHelp: false, inferred: false, at: '' }, boardState: { acknowledgedAt: '2026-01-01T00:00:00Z' } };
    useProjects.setState({ sessions: [{ id: 'p1', name: 'Dispatch' } as any, { id: 'p2', name: 'OS' } as any] });
    useTabs.setState({
      byProject: {
        p1: [
          terminal({ id: 'r1', label: 'one', status: 'waiting', config: restingOutcome }),
          terminal({ id: 'r2', label: 'two', status: 'waiting', config: restingOutcome }),
        ],
        p2: [
          terminal({ id: 'r3', label: 'three', status: 'waiting', config: restingOutcome }),
        ],
      },
    });
    render(<BoardMobile onOpenThread={vi.fn()} />);
    fireEvent.click(screen.getByTestId('board-section-toggle-resting'));
    const rollup = screen.getByTestId('board-resting-rollup');
    expect(within(rollup).getByTestId('board-resting-rollup-row-Dispatch')).toHaveTextContent('2');
    expect(within(rollup).getByTestId('board-resting-rollup-row-OS')).toHaveTextContent('1');
  });
});

describe('BoardMobile — swipe-to-acknowledge on Complete only', () => {
  it('swiping a Complete card left calls api.setBoardState with acknowledged: true', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    const card = within(screen.getByTestId('board-section-complete')).getByTestId('board-card');
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(card);
    expect(api.setBoardState).toHaveBeenCalledWith('complete-1', { acknowledged: true });
  });

  it('a swipe on a Complete card does not fire onOpenThread even if a click follows it', () => {
    seedOneOfEach();
    const onOpenThread = vi.fn();
    render(<BoardMobile onOpenThread={onOpenThread} />);
    const card = within(screen.getByTestId('board-section-complete')).getByTestId('board-card');
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(card);
    fireEvent.click(card);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('a plain tap with no swipe still opens the Complete card (tap-to-open stays intact)', () => {
    seedOneOfEach();
    const onOpenThread = vi.fn();
    render(<BoardMobile onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByText('Pretty resume + rows'));
    expect(onOpenThread).toHaveBeenCalledWith('p1', 'complete-1');
  });

  it('a swipe gesture on a Needs Help card neither acknowledges nor blocks tap-to-open', () => {
    seedOneOfEach();
    const onOpenThread = vi.fn();
    render(<BoardMobile onOpenThread={onOpenThread} />);
    const card = within(screen.getByTestId('board-section-needs_help')).getByTestId('board-card');
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(card);
    fireEvent.click(card);
    expect(api.setBoardState).not.toHaveBeenCalledWith('needs-help-1', { acknowledged: true });
    expect(onOpenThread).toHaveBeenCalledWith('p1', 'needs-help-1');
  });

  it('a swipe gesture on a Working card neither acknowledges nor blocks tap-to-open', () => {
    seedOneOfEach();
    const onOpenThread = vi.fn();
    render(<BoardMobile onOpenThread={onOpenThread} />);
    fireEvent.click(screen.getByTestId('board-section-toggle-working'));
    const card = within(screen.getByTestId('board-section-working')).getByTestId('board-card');
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(card);
    fireEvent.click(card);
    expect(api.setBoardState).not.toHaveBeenCalledWith('working-1', { acknowledged: true });
    expect(onOpenThread).toHaveBeenCalledWith('p1', 'working-1');
  });

  it('Resting never renders an individual board-card to swipe at all — the rollup replaces it', () => {
    seedOneOfEach();
    render(<BoardMobile onOpenThread={vi.fn()} />);
    fireEvent.click(screen.getByTestId('board-section-toggle-resting'));
    expect(within(screen.getByTestId('board-section-resting')).queryByTestId('board-card')).not.toBeInTheDocument();
  });
});
