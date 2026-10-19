import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { foldRows, parseSpawn } from './EndlessMessageRow';
import { StartedItem } from './StartedItem';
import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import * as open from './openThread';
import type { EndlessMessage } from '../../api/types';

const m = (i: number, kind: EndlessMessage['kind'], text: string): EndlessMessage => ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0 });
const spawnTool = (i: number, name: string) => m(i, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', agentType: 'implementer', name, task: 'Fix it' })}`);
const spawnEcho = (i: number, id: string, label: string) => m(i, 'echo', JSON.stringify({ agentId: id, label, project: 'studio', projectId: 's1', folder: '/w/studio' }));

beforeEach(() => {
  useEndless.setState({ threads: [], projects: [] });
  useThreadStatus.setState({ byTerminal: {} });
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
