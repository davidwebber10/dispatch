import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectsPanel, orderProjects, formatStart } from './ProjectsPanel';
import * as open from './openThread';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

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
    expect(screen.getByText('Some projects are not shown')).toBeInTheDocument();
  });
  it('formats the start time', () => {
    const now = Date.parse('2026-10-19T15:00:00');
    expect(formatStart('2026-10-19T14:02:00', now)).toBe('14:02');
    expect(formatStart('2026-10-17T14:02:00', now)).toMatch(/^Sat 14:02$/);
    expect(formatStart('2026-09-01T14:02:00', now)).toBe('1 Sep');
  });
});
