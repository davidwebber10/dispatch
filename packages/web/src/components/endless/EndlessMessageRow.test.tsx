import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { foldRows, parseSpawn, EndlessRows } from './EndlessMessageRow';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { useUI } from '../../stores/ui';
import { StartedItem } from './StartedItem';
import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import * as open from './openThread';
import { useDocViewer } from '../../stores/docViewer';
import type { EndlessMessage } from '../../api/types';

const scans = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../lib/docPaths', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/docPaths')>();
  return { ...real, findDocPaths: (t: string) => { scans.n++; return real.findDocPaths(t); } };
});

const m = (i: number, kind: EndlessMessage['kind'], text: string): EndlessMessage => ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0 });
const spawnTool = (i: number, name: string) => m(i, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', agentType: 'implementer', name, task: 'Fix it' })}`);
const spawnEcho = (i: number, id: string, label: string) => m(i, 'echo', JSON.stringify({ agentId: id, label, project: 'studio', projectId: 's1', folder: '/w/studio' }));

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

beforeEach(() => {
  useEndless.setState({ threads: [], projects: [] });
  useThreadStatus.setState({ byTerminal: {} });
  useDocViewer.setState({ open: null, back: [] });
});

describe('foldRows', () => {
  it('pairs a run of tools with the run of results after it, in order', () => {
    const rows = foldRows([m(0, 'tool', 'Read {}'), m(1, 'tool', 'Grep {}'), m(2, 'echo', 'A'), m(3, 'echo', 'B')]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.kind === 'msg' ? r.m.i : [r.tool.i, r.echo?.i]))).toEqual([[0, 2], [1, 3]]);
  });
  it('a tool with no result yet stays alone; the run of 1 is unchanged', () => {
    expect(foldRows([m(0, 'tool', 'Read {}')]).map((r) => r.kind)).toEqual(['tool']);
    const one = foldRows([m(0, 'tool', 'Read {}'), m(1, 'echo', 'A'), m(2, 'unii', 'hi')]);
    expect(one.map((r) => r.kind)).toEqual(['tool', 'msg']);
  });
  it('a spawn_agent call folds into a started row', () => {
    expect(foldRows([spawnTool(0, 'Fix PR #2'), spawnEcho(1, 't9', 'Fix PR #2')])[0].kind).toBe('started');
  });
});

describe('foldRows runs', () => {
  it('a run of 2 tools with 1 echo pairs the first and leaves the second alone', () => {
    const rows = foldRows([m(0, 'tool', 'Read {}'), m(1, 'tool', 'Grep {}'), m(2, 'echo', 'A')]);
    expect(rows.map((r) => (r.kind === 'msg' ? r.m.i : [r.tool.i, r.echo?.i]))).toEqual([[0, 2], [1, undefined]]);
  });
  it('a mixed run keeps the kinds and pairs the echoes in order', () => {
    const rows = foldRows([m(0, 'tool', 'mcp__memory__zoom {}'), spawnTool(1, 'Fix'), m(2, 'tool', 'Read {}'), m(3, 'echo', 'Z'), spawnEcho(4, 't9', 'Fix'), m(5, 'echo', 'R')]);
    expect(rows.map((r) => r.kind)).toEqual(['recall', 'started', 'tool']);
    expect(rows.map((r) => (r.kind === 'msg' ? -1 : r.echo?.i))).toEqual([3, 4, 5]);
  });
});

describe('parseSpawn', () => {
  it('starting, started, failed', () => {
    expect(parseSpawn(spawnTool(0, 'Fix'))).toMatchObject({ kind: 'starting', name: 'Fix', projectName: 'studio' });
    expect(parseSpawn(spawnTool(0, 'Fix'), spawnEcho(1, 't9', 'Fix'))).toMatchObject({ kind: 'started', agentId: 't9', label: 'Fix', projectId: 's1' });
    expect(parseSpawn(spawnTool(0, 'Fix'), m(1, 'echo', 'unknown project: catalog'))).toMatchObject({ kind: 'failed', error: 'unknown project: catalog' });
  });
});

describe('StartedItem', () => {
  it('shows Started with the label and opens the thread in place', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    render(<StartedItem tool={spawnTool(0, 'Fix PR #2')} echo={spawnEcho(1, 't9', 'Fix PR #2')} />);
    expect(screen.getByText('Started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Fix PR #2/ }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
  });
  it('Starting is not a button; Could not start shows the error', () => {
    const { rerender } = render(<StartedItem tool={spawnTool(0, 'Fix')} />);
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<StartedItem tool={spawnTool(0, 'Fix')} echo={m(1, 'echo', 'unknown project: catalog')} />);
    expect(screen.getByText('Could not start')).toBeInTheDocument();
    expect(screen.getByText(/unknown project: catalog/)).toBeInTheDocument();
  });
  it('Starting is aria-busy; Could not start is an alert', () => {
    const { container, rerender } = render(<StartedItem tool={spawnTool(0, 'Fix')} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    rerender(<StartedItem tool={spawnTool(0, 'Fix')} echo={m(1, 'echo', 'unknown project: catalog')} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  it('the chip follows a terminal:status event with no reload', () => {
    useEndless.setState({ threads: [{ id: 't9', project: 's1', label: 'Fix', harness: 'claude-code', state: 'working', startedBy: 'chat', via: null, startedAt: '', lastActivityAt: null, question: null }] });
    render(<StartedItem tool={spawnTool(0, 'Fix')} echo={spawnEcho(1, 't9', 'Fix')} />);
    expect(screen.getByText('working')).toBeInTheDocument();
    act(() => { useThreadStatus.getState().applyEvent({ type: 'terminal:status', terminalId: 't9', status: 'needs_input' }); });
    expect(screen.getByText('needs you')).toBeInTheDocument();
  });
});

describe('report card', () => {
  it('opens the thread in place and stays in Chat', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const setView = vi.fn();
    useUI.setState({ setView } as any);
    const work = { ...m(0, 'work', '[Fix] report: done'), project: 's1', ref: 't9' };
    render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    fireEvent.click(screen.getByRole('button', { name: /\[Fix\] report: done|Fix/ }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
    expect(setView).not.toHaveBeenCalled();
  });
});

describe('doc links in chat', () => {
  it('a report card path opens the doc viewer with the report project', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const work = { ...m(0, 'work', '[Plan] report: done. Doc: docs/specs/x.md (branch spec/x)'), project: 's1', ref: 't1' };
    render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'x.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/specs/x.md', branch: 'spec/x' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('a folded report shows chips in its preview and its open body', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const long = `[Plan] report: Doc: /w/studio/docs/specs/y.md\n${'more words here. '.repeat(20)}`;
    useEndless.setState({ projects: [{ id: 's7', name: 'studio', folder: '/w/studio' }] as any });
    const work = { ...m(0, 'work', long), project: 's1', ref: 't1' };
    render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's7', path: '/w/studio/docs/specs/y.md', branch: null });
    const header = screen.getByRole('button', { name: /Plan/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // A real button: the browser turns Enter into a click (jsdom does not, so the test clicks).
    fireEvent.click(header);
    // The same element opens (no remount, so the keyboard focus stays).
    expect(screen.getByRole('button', { name: /Plan/ })).toBe(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('button', { name: 'y.md' })).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
  it('a Dispatch reply path opens the doc viewer with the message project', () => {
    const reply = { ...m(0, 'unii', 'The plan is in `docs/plans/p.md`.'), project: 's1' };
    render(<MessageScroller.Provider><EndlessRows messages={[reply]} focus={null} /></MessageScroller.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'p.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/plans/p.md', branch: null });
  });
  it('a relative path with no project is not a link; tool rows stay plain', () => {
    render(<MessageScroller.Provider><EndlessRows messages={[m(0, 'unii', 'See docs/a.md'), m(1, 'tool', 'Read {"file_path":"/w/studio/docs/a.md"}')]} focus={null} /></MessageScroller.Provider>);
    expect(screen.queryByRole('button', { name: 'a.md' })).toBeNull();
  });
  it('a Started card shows up to 2 doc links from its task', () => {
    const tool = m(0, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', name: 'Plan', task: 'Read docs/a.md, docs/b.md and docs/c.md' })}`);
    render(<StartedItem tool={tool} echo={spawnEcho(1, 't9', 'Plan')} />);
    expect(screen.getAllByRole('button', { name: /\.md$/ })).toHaveLength(2);
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    fireEvent.click(screen.getByRole('button', { name: 'b.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/b.md', branch: null });
    expect(spy).not.toHaveBeenCalled();
  });

});

describe('report cards do not nest buttons', () => {
  const nested = (c: HTMLElement) => c.querySelectorAll('button button, [role=button] button').length;
  it('a short report: the header button opens the thread, a chip opens the doc viewer only', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const work = { ...m(0, 'work', '[Plan] report: done. Doc: docs/specs/x.md'), project: 's1', ref: 't1' };
    const { container } = render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    expect(nested(container)).toBe(0);
    expect(container.querySelector('[role=button]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'x.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/specs/x.md', branch: null });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread Plan' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('s1', 't1');
  });
  it('a folded report: the header button opens the card, a chip opens the doc viewer only', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const long = `[Plan] report: Doc: docs/specs/y.md\n${'more words here. '.repeat(20)}`;
    const work = { ...m(0, 'work', long), project: 's1', ref: 't1' };
    const { container } = render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    expect(nested(container)).toBe(0);
    expect(container.querySelector('[role=button]')).toBeNull();
    const header = screen.getByRole('button', { name: /Plan/ });
    expect(header.tagName).toBe('BUTTON');
    fireEvent.click(screen.getByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/specs/y.md', branch: null });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(nested(container)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
  it('the keyboard order is the header button, then each chip', () => {
    const work = { ...m(0, 'work', '[Plan] report: see docs/a.md and docs/b.md'), project: 's1', ref: 't1' };
    const { container } = render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    const stops = [...container.querySelectorAll<HTMLElement>('button, [tabindex]')].filter((e) => e.tabIndex >= 0);
    expect(stops.map((e) => e.getAttribute('aria-label'))).toEqual(['Open thread Plan', 'a.md', 'b.md']);
  });
  it('a report card scans its text once, and not again when nothing changed', () => {
    const work = { ...m(0, 'work', '[Plan] report: done. Doc: docs/specs/x.md'), project: 's1', ref: 't1' };
    scans.n = 0;
    const { rerender } = render(<MessageScroller.Provider><EndlessRows messages={[work]} focus={null} /></MessageScroller.Provider>);
    expect(scans.n).toBe(1);
    rerender(<MessageScroller.Provider><EndlessRows messages={[work]} focus={0} /></MessageScroller.Provider>);
    expect(scans.n).toBe(1);
  });
});
