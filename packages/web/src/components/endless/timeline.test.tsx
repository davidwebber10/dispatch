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
import { setFoldsOpenForTest } from '../tabs/chat/timeline/activityFold';

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
  // A tool strip folds under one row (activityFold.tsx). These tests are about the rows and ids
  // inside it, so each untouched fold starts open, except where a test says otherwise.
  setFoldsOpenForTest(true);
});

/** Tap open every closed activity fold, as the reader does before opening a call inside one. */
function openFolds() {
  for (const row of screen.queryAllByTestId('activity-fold-row')) {
    if (row.getAttribute('aria-expanded') === 'false') fireEvent.click(row);
  }
}

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
  it('a call inside a closed fold has no id until the fold opens, and a search focus on it opens the fold', () => {
    setFoldsOpenForTest(false);
    const msgs = [m(700, 'unii', 'one'), m(701, 'tool', 'Bash {"command":"ls"}'), m(702, 'echo', 'out'), m(703, 'unii', 'two')];
    const { unmount } = draw(msgs);
    expect(screen.getByTestId('activity-fold')).toBeInTheDocument();
    expect(anchor(700)).not.toBeNull();
    expect(anchor(701)).toBeNull();
    unmount();
    draw(msgs, 702);
    expect(screen.getByTestId('activity-fold').dataset.open).toBe('true');
    expect(anchor(701)).not.toBeNull();
  });
});

describe('ChatTimeline: an open tool call keeps its scroll position when the next call arrives', () => {
  const wrap = (messages: EndlessMessage[]) => (
    <MessageScroller.Provider><MessageScroller.Root><MessageScroller.Viewport><MessageScroller.Content>
      <ChatTimeline messages={messages} focus={null} />
    </MessageScroller.Content></MessageScroller.Viewport></MessageScroller.Root></MessageScroller.Provider>
  );
  const long = Array.from({ length: 80 }, (_, n) => `line ${n}`).join('\n');
  const openBox = (container: HTMLElement) => container.querySelector('pre.hljs') as HTMLElement;
  // With the fold in place: the strip starts folded, and the reader taps it open first.
  beforeEach(() => setFoldsOpenForTest(false));
  // The open state lives in a store keyed by tool id (chat:t<i>): these i values are used by no other test.
  for (const name of ['Bash', 'Read']) {
    const base = name === 'Bash' ? 900 : 950;
    it(`${name} then ${name}: the open box is the same node, with the same scrollTop, and both ids stay reachable`, () => {
      const first = [m(base, 'user', 'go'), m(base + 1, 'tool', `${name} {"command":"one","file_path":"/one"}`), m(base + 2, 'echo', long)];
      const { container, rerender } = render(wrap(first));
      openFolds();
      const row = container.querySelector(`[data-message-id="m${base + 1}"]`) as HTMLElement;
      fireEvent.click(row.querySelector('button') as HTMLElement);
      const box = openBox(container);
      expect(box).not.toBeNull();
      box.scrollTop = 240;

      // The second call of the same tool starts: the lone call becomes a run of two.
      const second = [...first, m(base + 3, 'tool', `${name} {"command":"two","file_path":"/two"}`)];
      rerender(wrap(second));
      expect(openBox(container)).toBe(box);
      expect(box.scrollTop).toBe(240);
      expect(container.querySelector(`[data-message-id="m${base + 1}"]`)).toBe(row);
      expect(anchor(base + 3)).not.toBeNull();

      // Its result lands, then a third call joins the run.
      const third = [...second, m(base + 4, 'echo', 'done'), m(base + 5, 'tool', `${name} {"command":"three","file_path":"/three"}`)];
      rerender(wrap(third));
      expect(openBox(container)).toBe(box);
      expect(box.scrollTop).toBe(240);
      expect(anchor(base + 5)).not.toBeNull();
      // The later ids are overlays inside the unit, not wrappers around it.
      expect(row.contains(anchor(base + 3))).toBe(true);
      expect(anchor(base + 3)?.contains(box)).toBe(false);
    });
  }
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
