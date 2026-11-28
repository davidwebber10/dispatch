// The activity condenser (option A): a strip of tool calls folds under one row. Prose and failures
// stay out of the fold, an open call keeps its DOM node and scroll while calls stream in, the open
// state survives a remount, a time shows only when the page saw the strip start, and the OS look
// keeps today's plain strip.
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { MessageScroller } from '@shadcn/react/message-scroller';
import type { ConvItem } from '../../../../api/types';
import { setHostContextForTest } from '../../../../lib/hostContext';
import { renderTimeline, type TimelineExtensions } from './renderTimeline';
import { stepKind, stepPhrase, foldStats, settledLine, foldsActivity } from './activityFold';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});
afterEach(() => { cleanup(); setHostContextForTest({}); vi.useRealTimers(); });

// Ids unique to this file: the open state lives in module maps keyed by tool id.
let n = 0;
const call = (toolName: string, args: Record<string, unknown> = {}, toolId = `af-${++n}`): ConvItem => ({ kind: 'tool', toolId, toolName, toolInput: JSON.stringify(args) });
const res = (toolId: string, text = 'ok', isError = false): ConvItem => ({ kind: 'tool-result', toolId, text, ...(isError ? { isError } : {}) });
const say = (text: string): ConvItem => ({ kind: 'assistant', text, uuid: `a-${text}` });

function View({ items, ext }: { items: ConvItem[]; ext?: TimelineExtensions }) {
  return (
    <MessageScroller.Provider>
      <MessageScroller.Root>
        <MessageScroller.Viewport>
          <MessageScroller.Content>{renderTimeline(items, () => {}, new Set(), undefined, null, undefined, ext)}</MessageScroller.Content>
        </MessageScroller.Viewport>
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}

describe('the words and the counts', () => {
  it.each([
    ['Bash', 'run'], ['Shell', 'run'], ['bash', 'run'], ['run_terminal_command', 'run'], ['run_command', 'run'],
    ['Read', 'read'], ['read_file', 'read'], ['Edit', 'edit'], ['ApplyPatch', 'edit'], ['Write', 'edit'],
    ['Grep', 'search'], ['ToolSearch', 'search'], ['WebSearch', 'search'], ['mcp__dispatch__read_thread', 'mcp'], ['mcp:dispatch/read_thread', 'mcp'],
  ])('%s is a %s step, whatever the provider', (name, kind) => expect(stepKind(name)).toBe(kind));

  it('says a call in plain words, with no raw arguments', () => {
    expect(stepPhrase(call('Read', { file_path: '/a/b/leaves.tsx' }), true)).toBe('Reading leaves.tsx');
    expect(stepPhrase(call('Bash', { command: 'npx vitest run', description: 'Run the chat tests' }), false)).toBe('Run the chat tests');
    expect(stepPhrase(call('Shell', { command: 'cd /x && git status --short' }), true)).toBe('Running git status --short');
    expect(stepPhrase(call('mcp__dispatch__read_thread', { id: 'x' }), false)).toBe('dispatch: read thread');
    expect(stepPhrase(call('mcp:dispatch/read_thread', { id: 'x' }), false)).toBe('dispatch: read thread');
    expect(stepPhrase(call('Read', {}), true)).toBe('Reading a file');
  });

  it('counts only what the data has, and drops a partial edit stat', () => {
    const a = call('Read', { file_path: '/x.ts' });
    const b = call('Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b\nc' });
    const s = foldStats([{ tool: a, result: res(a.toolId!) }, { tool: b, result: res(b.toolId!) }]);
    expect(settledLine(s)).toBe('2 steps · 1 read · 1 edited');
    expect(s.diff).toEqual({ add: 2, del: 1 });
    // A Codex ApplyPatch gives no stat: the strip then shows none, not a sum of half the edits.
    const c = call('ApplyPatch', { patch: '...' });
    expect(foldStats([{ tool: b, result: res(b.toolId!) }, { tool: c, result: res(c.toolId!) }]).diff).toBeNull();
  });
});

describe('the fold in the timeline', () => {
  it('folds the strip, never the prose, and keeps a failure in sight', () => {
    const a = call('Read', { file_path: '/x.ts' });
    const b = call('Bash', { command: 'tsc', description: 'Typecheck' });
    render(<View items={[say('before'), a, res(a.toolId!), b, res(b.toolId!, 'boom', true), say('after')]} />);
    expect(screen.getAllByTestId('activity-fold')).toHaveLength(1);
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
    expect(screen.getByText('2 steps · 1 read')).toBeInTheDocument();
    expect(screen.getByTestId('activity-fold-errors')).toHaveTextContent('error');
    expect(screen.queryByText(/file_path/)).toBeNull();
  });

  it('a running strip shows the live step and the count, and no time it did not see start', () => {
    const a = call('Read', { file_path: '/x.ts' });
    const b = call('Bash', { command: 'npx vitest run', description: 'Run the chat tests' });
    render(<View items={[a, res(a.toolId!), b]} />);
    const row = screen.getByTestId('activity-fold-row');
    expect(row).toHaveTextContent('Run the chat tests');
    expect(row).toHaveTextContent('2 steps');
    expect(row.textContent).not.toMatch(/\d+s ·/);
  });

  it('a strip seen from its first call counts its time, and keeps it when it settles', () => {
    vi.useFakeTimers();
    const a = call('Bash', { command: 'sleep 5', description: 'Wait' });
    const { rerender } = render(<View items={[a]} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByTestId('activity-fold-row')).toHaveTextContent('5s · 1 step');
    rerender(<View items={[a, res(a.toolId!)]} />);
    expect(screen.getByTestId('activity-fold-row')).toHaveTextContent('Worked 5s · 1 step');
  });

  it('between two calls of a running turn, the last strip stays live and its clock goes on', () => {
    vi.useFakeTimers();
    const a = call('Bash', { command: 'ls', description: 'List the files' });
    const running = { turnRunning: true };
    const { rerender } = render(<View items={[a]} ext={running} />);
    act(() => { vi.advanceTimersByTime(3000); });
    // The call ends; the model picks the next step. Nothing is open, but the turn runs.
    rerender(<View items={[a, res(a.toolId!)]} ext={running} />);
    act(() => { vi.advanceTimersByTime(4000); });
    const row = screen.getByTestId('activity-fold-row');
    expect(screen.getByTestId('activity-fold').dataset.running).toBe('true');
    expect(row).toHaveTextContent('List the files');
    expect(row).toHaveTextContent('7s · 1 step');
    // A strip that prose follows is done, whatever the turn does.
    rerender(<View items={[a, res(a.toolId!), say('done')]} ext={running} />);
    expect(screen.getByTestId('activity-fold').dataset.running).toBeUndefined();
    expect(screen.getByTestId('activity-fold-row')).toHaveTextContent('Worked 7s · 1 step');
  });

  it('opens on a tap; an open call keeps its DOM node and scroll while calls arrive, and the state survives a remount', () => {
    const a = call('Bash', { command: 'ls' }, 'af-keep-1');
    const items1 = [a, res('af-keep-1', Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'))];
    const { rerender, unmount } = render(<View items={items1} />);
    fireEvent.click(screen.getByTestId('activity-fold-row'));
    fireEvent.click(screen.getByText('command: ls').closest('button')!);
    const box = document.querySelector('pre') as HTMLElement;
    expect(box).not.toBeNull();
    box.scrollTop = 200;
    const b = call('Bash', { command: 'pwd' }, 'af-keep-2');
    rerender(<View items={[...items1, b]} />);
    expect(document.querySelector('pre')).toBe(box);
    expect(box.scrollTop).toBe(200);
    const c = call('Bash', { command: 'whoami' }, 'af-keep-3');
    rerender(<View items={[...items1, b, res('af-keep-2'), c]} />);
    expect(document.querySelector('pre')).toBe(box);
    expect(box.scrollTop).toBe(200);
    unmount();
    render(<View items={[...items1, b, res('af-keep-2'), c, res('af-keep-3')]} />);
    expect(screen.getByTestId('activity-fold').dataset.open).toBe('true');
  });

  it('a surface can hold a fold open (Chat: the search focus is inside it)', () => {
    const a = call('Read', { file_path: '/y.ts' });
    render(<View items={[a, res(a.toolId!)]} ext={{ foldOpen: (items) => items.includes(a) }} />);
    expect(screen.getByTestId('activity-fold').dataset.open).toBe('true');
  });

  // Owner 2026-11-27: "OS look as is". askLook.tsx keeps "no collapsed work summaries".
  it('the OS look shows every call as before, with no pill (FOLD_IN_OS_LOOK is off)', () => {
    setHostContextForTest({}, true); // the OS look: the business preview
    expect(foldsActivity()).toBe(false);
    const a = call('Read', { file_path: '/os-a.ts' });
    const b = call('Grep', { pattern: 'needle' });
    const c = call('Bash', { command: 'tsc' });
    render(<View items={[say('first'), a, res(a.toolId!), b, res(b.toolId!), c, res(c.toolId!, 'boom', true), say('last')]} />);
    expect(screen.queryByTestId('activity-fold')).toBeNull();
    expect(screen.queryByTestId('activity-fold-row')).toBeNull();
    // One row for each call, in order, between the two pieces of prose.
    expect(screen.getByText(/os-a\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/needle/)).toBeInTheDocument();
    expect(screen.getByText(/tsc/)).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
  });
});
