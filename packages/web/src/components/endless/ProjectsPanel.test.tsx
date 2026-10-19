import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectsPanel, orderProjects, formatStart } from './ProjectsPanel';
import * as open from './openThread';
import { useEndless } from '../../stores/endless';
import { useUI } from '../../stores/ui';
import { useDocViewer } from '../../stores/docViewer';
import { api } from '../../api/client';

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: isMobileMock }));

let saved: ReturnType<typeof useEndless.getState>;

beforeEach(() => {
  saved = useEndless.getState();
  useEndless.setState({ projects: [
    { id: 's1', name: 'rollup', folder: '/w/rollup', live: 2, needsYou: 1, openItems: 3, lastReport: '[Fixer] report: tests pass', messages: 5 },
    { id: 's2', name: 'idle', folder: '/w/idle', live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0 },
  ], threads: [], truncated: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  useEndless.setState(saved, true);
});

describe('ProjectsPanel', () => {
  it('shows live and needs-you counts, open items, and the last report for projects with activity', () => {
    render(<ProjectsPanel />);
    const card = screen.getByTestId('project-s1');
    expect(card).toHaveTextContent('rollup');
    expect(card).toHaveTextContent('2 live · 1 need you · 3 open');
    expect(card).toHaveTextContent('[Fixer] report: tests pass');
    expect(screen.queryByTestId('project-s2')).not.toBeInTheDocument();
  });
  it('refreshes on demand', () => {
    const spy = vi.spyOn(api, 'endlessProjects').mockResolvedValue([]);
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(spy).toHaveBeenCalled();
  });
  it('shows an empty note when there is no activity', () => {
    useEndless.setState({ projects: [], unavailable: false });
    render(<ProjectsPanel />);
    expect(screen.getByText('No project activity yet.')).toBeInTheDocument();
  });
  it('says projects are unavailable instead of empty when the load failed', () => {
    useEndless.setState({ projects: [], unavailable: true });
    render(<ProjectsPanel />);
    expect(screen.getByText('Projects are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No project activity yet.')).not.toBeInTheDocument();
  });
  it('survives a failed refresh', async () => {
    const spy = vi.spyOn(api, 'endlessProjects').mockRejectedValue(new Error('503'));
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(spy).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId('project-s1')).toHaveTextContent('rollup');
  });
});

const row = (id: string, project: string, state: string, o: Partial<Record<string, unknown>> = {}) => ({ id, project, label: `Thread ${id}`, harness: 'claude-code', state, startedBy: 'chat', via: null, startedAt: '2026-10-19T10:42:00.000Z', lastActivityAt: '2026-10-19T11:00:00.000Z', question: null, ...o });
const P = (id: string, name: string, over: Partial<Record<string, number>> = {}) => ({ id, name, folder: `/w/${name}`, live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0, ...over });

describe('ProjectsPanel thread list', () => {
  it('shows a Needs you section first, with the question', () => {
    useEndless.setState({ projects: [P('s1', 'rollup', { needsYou: 1 })], threads: [row('n', 's1', 'needs_you', { question: 'Use the warehouse view?' })] as any });
    render(<ProjectsPanel />);
    const needs = screen.getByTestId('needs-you');
    expect(needs).toHaveTextContent('Thread n');
    expect(needs).toHaveTextContent('Use the warehouse view?');
  });
  it('rows show name, who started it, harness and the start time', () => {
    useEndless.setState({ projects: [P('s1', 'studio', { live: 1 })], threads: [row('w', 's1', 'working', { startedBy: 'thread', via: 'Fix PR #2', harness: 'codex' })] as any });
    render(<ProjectsPanel />);
    const r = screen.getByTestId('thread-w');
    expect(r).toHaveTextContent('Thread w');
    expect(r).toHaveTextContent('via Fix PR #2');
    expect(r).toHaveTextContent('Codex');
  });
  it('folds finished threads under Done today', () => {
    useEndless.setState({ projects: [P('s1', 'studio')], threads: [row('d1', 's1', 'done'), row('d2', 's1', 'done')] as any });
    render(<ProjectsPanel />);
    expect(screen.queryByTestId('thread-d1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done today (2)' }));
    expect(screen.getByTestId('thread-d1')).toBeInTheDocument();
  });
  it('shows 6 rows, then +N more in place', () => {
    useEndless.setState({ projects: [P('s1', 'studio', { live: 8 })], threads: Array.from({ length: 8 }, (_, k) => row(`w${k}`, 's1', 'working')) as any });
    render(<ProjectsPanel />);
    expect(screen.getAllByTestId(/^thread-w/)).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(screen.getAllByTestId(/^thread-w/)).toHaveLength(8);
  });
  it('a row tap closes the sheet first, then opens the thread in place', async () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const onNavigate = vi.fn();
    useEndless.setState({ projects: [P('s1', 'studio', { live: 1 })], threads: [row('w', 's1', 'working')] as any });
    render(<ProjectsPanel onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('thread-w'));
    expect(onNavigate).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('s1', 'w');
  });
  it('orders projects: waiting, then live, then the rest', () => {
    const ps = [P('a', 'a'), P('b', 'b', { live: 1 }), P('c', 'c', { needsYou: 1 })];
    expect(orderProjects(ps as any, []).map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });
  it('the cut note', () => {
    useEndless.setState({ projects: [P('s1', 'studio', { live: 1 })], threads: [row('w', 's1', 'working')] as any, truncated: true });
    render(<ProjectsPanel />);
    expect(screen.getByText('Some threads are not shown')).toBeInTheDocument();
  });
  it('formats the start time', () => {
    const now = Date.parse('2026-10-19T15:00:00');
    expect(formatStart('2026-10-19T14:02:00', now)).toBe('14:02');
    expect(formatStart('2026-10-17T14:02:00', now)).toMatch(/^Sat 14:02$/);
    expect(formatStart('2026-09-01T14:02:00', now)).toBe('1 Sep');
  });
});

describe('Docs fold', () => {
  const docRow = (k: number, o: Partial<Record<string, unknown>> = {}) => ({ path: `docs/specs/d${k}.md`, name: `d${k}.md`, status: 'draft', source: 'worktree', worktree: 'chat-visibility-spec', worktreeRel: '.worktrees/chat-visibility-spec', branch: 'spec/chat-thread-visibility', vsMain: 'not_on_main', modifiedAt: '2026-10-19T11:00:00Z', copies: 1, writer: { id: 't1', label: 'Plan' }, ...o });
  afterEach(() => { useDocViewer.setState({ open: null, back: [] }); useUI.setState({ pendingOpenProject: null }); isMobileMock.mockReturnValue(false); });
  it('is hidden at a count of 0', () => {
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 0 } } as any);
    render(<ProjectsPanel />);
    expect(screen.queryByRole('button', { name: /^Docs/ })).not.toBeInTheDocument();
  });
  it('an in-progress doc alone does not make a project show', () => {
    useEndless.setState({ projects: [P('s1', 'dispatch')], threads: [], docCounts: { s1: 4 } } as any);
    render(<ProjectsPanel />);
    expect(screen.queryByTestId('project-s1')).not.toBeInTheDocument();
  });
  it('closed by default; opens once; at most 5 rows; +N more opens the project in Threads', async () => {
    const spy = vi.spyOn(api, 'endlessDocs').mockResolvedValue({ rows: [0, 1, 2, 3, 4].map((k) => docRow(k)), total: 7 } as any);
    const ask = vi.spyOn(useUI.getState(), 'requestOpenProject');
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 7 } } as any);
    render(<ProjectsPanel />);
    expect(screen.queryAllByTestId(/^doc-row-/)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Docs (7)' }));
    expect(await screen.findAllByTestId(/^doc-row-/)).toHaveLength(5);
    expect(screen.getAllByText('worktree chat-visibility-spec')[0]).toBeInTheDocument();
    expect(screen.getAllByText('worktree chat-visibility-spec')[0]).toHaveAttribute('title', 'worktree chat-visibility-spec on spec/chat-thread-visibility');
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(ask).toHaveBeenCalledWith('s1');
    fireEvent.click(screen.getByRole('button', { name: 'Docs (7)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs (7)' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('a row opens the viewer, the writer opens the thread, and other copies show', async () => {
    vi.spyOn(api, 'endlessDocs').mockResolvedValue({ rows: [docRow(0, { copies: 2 }), docRow(1, { source: 'branch', worktree: null, branch: 'origin/spec/t', vsMain: 'changed', writer: null })], total: 2 } as any);
    const thread = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const onNavigate = vi.fn();
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 2 } } as any);
    render(<ProjectsPanel onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs (2)' }));
    const first = await screen.findByTestId('doc-row-docs/specs/d0.md');
    expect(first).toHaveTextContent('+1 copy');
    expect(first).toHaveTextContent('not on main');
    expect(screen.getByText('branch origin/spec/t')).toHaveAttribute('title', 'branch origin/spec/t, as of the last fetch');
    expect(screen.getByTestId('doc-row-docs/specs/d1.md')).toHaveTextContent('changed here');
    expect(screen.queryByRole('button', { name: /more$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(thread).toHaveBeenCalledWith('s1', 't1');
    expect(useDocViewer.getState().open).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /d1\.md/ }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/specs/d1.md', branch: 'origin/spec/t' });
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
  it('a worktree row opens its worktree copy by its path in the project', async () => {
    vi.spyOn(api, 'endlessDocs').mockResolvedValue({ rows: [docRow(0)], total: 1 } as any);
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 1 } } as any);
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs (1)' }));
    fireEvent.click(await screen.findByRole('button', { name: /d0\.md/ }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/specs/d0.md', branch: null, worktree: '.worktrees/chat-visibility-spec' });
  });
  it('opened again after the count changed, it loads the rows again', async () => {
    const spy = vi.spyOn(api, 'endlessDocs').mockResolvedValue({ rows: [docRow(0)], total: 1 } as any);
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 1 } } as any);
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs (1)' }));
    await screen.findByTestId('doc-row-docs/specs/d0.md');
    fireEvent.click(screen.getByRole('button', { name: 'Docs (1)' }));
    spy.mockResolvedValue({ rows: [docRow(0), docRow(1)], total: 2 } as any);
    act(() => { useEndless.setState({ docCounts: { s1: 2 } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Docs (2)' }));
    expect(await screen.findByTestId('doc-row-docs/specs/d1.md')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('on mobile the writer button and the row are 44 px tap targets', async () => {
    isMobileMock.mockReturnValue(true);
    vi.spyOn(api, 'endlessDocs').mockResolvedValue({ rows: [docRow(0)], total: 1 } as any);
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 1 } } as any);
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs (1)' }));
    const writer = await screen.findByRole('button', { name: 'Plan' });
    expect(writer.style.minHeight).toBe('44px');
    expect(writer.style.display).toBe('inline-flex');
    expect(writer.style.alignItems).toBe('center');
    expect(screen.getByRole('button', { name: /d0\.md/ }).style.minHeight).toBe('44px');
  });
});
