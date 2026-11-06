// Chat's list drawn through the thread view's renderTimeline (timeline.tsx): the Chat-only views
// that ride on its hooks, and the scroll ids search jumps use.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { ChatTimeline } from './timeline';
import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import * as open from './openThread';
import type { EndlessMessage } from '../../api/types';

const m = (i: number, kind: EndlessMessage['kind'], text: string, over: Partial<EndlessMessage> = {}): EndlessMessage => ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0, ...over });

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

beforeEach(() => {
  vi.restoreAllMocks();
  useEndless.setState({ threads: [], projects: [] });
  useThreadStatus.setState({ byTerminal: {} });
});

const draw = (messages: EndlessMessage[], focus: number | null = null) => render(
  <MessageScroller.Provider><MessageScroller.Root><MessageScroller.Viewport><MessageScroller.Content>
    <ChatTimeline messages={messages} focus={focus} />
  </MessageScroller.Content></MessageScroller.Viewport></MessageScroller.Root></MessageScroller.Provider>,
);
const anchor = (key: number) => document.querySelector(`[data-message-id="m${key}"]`);

describe('ChatTimeline scroll ids (search jumps, MemorySearch)', () => {
  it('every message has its m<i> id, also inside a grouped turn; a folded result has none of its own', () => {
    draw([m(0, 'user', 'hi'), m(1, 'unii', 'one'), m(2, 'tool', 'Bash {"command":"ls"}'), m(3, 'echo', 'out'), m(4, 'unii', 'two')]);
    for (const k of [0, 1, 2, 4]) expect(anchor(k)).not.toBeNull();
    expect(anchor(3)).toBeNull();
  });
  it('each call of a same-tool run keeps its own id', () => {
    draw([m(0, 'tool', 'Read {"file_path":"/a"}'), m(1, 'tool', 'Read {"file_path":"/b"}'), m(2, 'echo', 'A'), m(3, 'echo', 'B')]);
    expect(anchor(0)).not.toBeNull();
    expect(anchor(1)).not.toBeNull();
    expect(screen.getByText('×2')).toBeInTheDocument(); // the thread view's ToolGroup
  });
  it('the focus outlines its row; a folded result outlines its call', () => {
    const msgs = [m(0, 'unii', 'one'), m(1, 'tool', 'Bash {}'), m(2, 'echo', 'out')];
    const { unmount } = draw(msgs, 0);
    const outlined = () => [...document.querySelectorAll<HTMLElement>('[data-endless-i]')].filter((e) => e.style.outline.includes('solid')).map((e) => e.dataset.endlessI);
    expect(outlined()).toEqual(['0']);
    unmount();
    draw(msgs, 2);
    expect(outlined()).toEqual(['1']);
  });
});

describe('ChatTimeline Chat-only views', () => {
  it('a user message shows its project, its images as user images and its other files as chips', () => {
    draw([m(0, 'user', 'see these', { project: 's1', projectName: 'salsify', media: ['1-0-abcdef12-shot.png', '1-1-abcdef12-notes.pdf'] })]);
    expect(screen.getByText('salsify')).toBeInTheDocument();
    expect(screen.getByText('see these')).toBeInTheDocument();
    expect(document.querySelector('img[src*="shot.png"]')).not.toBeNull();
    const chip = screen.getByRole('link', { name: /notes\.pdf/ });
    expect(chip.getAttribute('href')).toContain('1-1-abcdef12-notes.pdf');
    expect(screen.queryByText('1-1-abcdef12-notes.pdf')).toBeNull();
  });
  it('a spawn_agent call is the Started card and opens its thread in place', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    draw([
      m(0, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', name: 'Fix PR', task: 'Fix it' })}`),
      m(1, 'echo', JSON.stringify({ agentId: 't9', label: 'Fix PR', project: 'studio', projectId: 's1' })),
    ]);
    expect(screen.getByText('Started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Fix PR/ }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
    expect(screen.queryByText(/agentId/)).toBeNull(); // the result is folded into the card
  });
  it('a zoom call is a recalled line and its result is not drawn', () => {
    draw([m(0, 'tool', 'mcp__memory__zoom {"id":4,"n":2}'), m(1, 'echo', '4+2|secret')]);
    expect(screen.getByText('recalled 4+2')).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).toBeNull();
  });
  it('an imported-memories note folds to one line and opens', () => {
    draw([m(0, 'note', 'remember the **exporter**', { projectName: 'salsify' })]);
    const btn = screen.getByRole('button', { name: /Imported memories — salsify/ });
    expect(screen.queryByText('exporter')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByText('exporter')).toBeInTheDocument();
  });
  it('a lone result (its call not loaded) draws on its own', () => {
    draw([m(0, 'echo', 'stray output', { ref: 'gone' })]);
    expect(screen.getByRole('button', { name: /Output/ })).toBeInTheDocument();
    expect(anchor(0)).not.toBeNull();
  });
});
