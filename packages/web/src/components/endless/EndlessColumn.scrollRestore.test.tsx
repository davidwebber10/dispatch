import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { EndlessColumn, resetChatScrollForTest } from './EndlessColumn';
import { ChatMode } from './ChatMode';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';
import type { EndlessMessage } from '../../api/types';

// Chat unmounts when the user opens another view (DesktopShell, MobileApp). Coming back must show
// the place the reader left, not the end (2026-11-27: "If I toggle away from chat and come back
// it's scrolled all the way down").

const ROW = 100; // every row is 100px high
const VIEW = 500; // the viewport is 500px high

const msg = (i: number): EndlessMessage =>
  ({ i, kind: i % 2 ? 'unii' : 'user', text: `message ${i}`, size: 9, project: null, projectName: null, ref: null, media: [], createdAt: 0 });

// jsdom has no layout. This fakes one: the viewport is the scroller's region, its rows are the
// content's children with a message id, stacked ROW px apart under the content's 24px top padding.
const tops = new WeakMap<Element, number>();
const isViewport = (el: Element) => el.getAttribute('role') === 'region' && el.getAttribute('aria-label') === 'Messages';
const viewportOf = (el: Element) => el.closest('[role="region"][aria-label="Messages"]');
const rowsOf = (content: Element) => Array.from(content.children).filter((c) => (c as HTMLElement).dataset.messageId);
const restore: Array<() => void> = [];
function stub<K extends keyof HTMLElement>(name: K, desc: PropertyDescriptor) {
  const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...desc });
  restore.push(() => { if (before) Object.defineProperty(HTMLElement.prototype, name, before); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]; });
}

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  const contentHeight = (vp: Element) => {
    const content = vp.firstElementChild;
    return content ? 24 + rowsOf(content).length * ROW + 24 : 0;
  };
  const maxTop = (vp: Element) => Math.max(0, contentHeight(vp) - VIEW);
  stub('scrollTop', {
    get(this: HTMLElement) { return tops.get(this) ?? 0; },
    set(this: HTMLElement, v: number) { tops.set(this, Math.min(Math.max(0, v), maxTop(this))); },
  });
  stub('scrollHeight', { get(this: HTMLElement) { return isViewport(this) ? Math.max(VIEW, contentHeight(this)) : 0; } });
  stub('clientHeight', { get(this: HTMLElement) { return isViewport(this) ? VIEW : 0; } });
  stub('scrollTo', { value(this: HTMLElement, o: ScrollToOptions) { this.scrollTop = o.top ?? 0; } });
  stub('getBoundingClientRect', {
    value(this: HTMLElement) {
      const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
      if (isViewport(this)) return box(0, VIEW);
      const parent = this.parentElement;
      const vp = parent && viewportOf(parent);
      const at = parent && this.dataset.messageId ? rowsOf(parent).indexOf(this) : -1;
      if (vp && at >= 0 && parent === vp.firstElementChild) return box(24 + at * ROW - vp.scrollTop, ROW);
      return box(0, 0);
    },
  });
});
afterAll(() => { restore.splice(0).reverse().forEach((f) => f()); });

beforeEach(() => {
  vi.restoreAllMocks();
  resetChatScrollForTest();
  useEndless.setState({
    messages: Array.from({ length: 40 }, (_, i) => msg(i)),
    loaded: true, hasMore: false, atTail: true, focus: null, filter: null, liveText: '', liveThinking: '',
    turn: { status: 'idle', error: null }, projects: [], pending: [],
  });
});

const viewport = (c: HTMLElement) => c.querySelector('[role="region"][aria-label="Messages"]') as HTMLElement;
const firstRowOnScreen = (c: HTMLElement) => {
  const vp = viewport(c);
  return rowsOf(vp.firstElementChild!).find((r) => r.getBoundingClientRect().bottom > 0) as HTMLElement;
};

describe('Chat keeps its scroll position across a view switch', () => {
  it('opens at the end the first time (a reload)', () => {
    const { container } = render(<EndlessColumn />);
    const vp = viewport(container);
    expect(vp.scrollTop).toBe(vp.scrollHeight - VIEW);
  });

  it('a reader who scrolled up comes back to the same message at the same place', () => {
    const first = render(<EndlessColumn />);
    const vp = viewport(first.container);
    act(() => { vp.scrollTop = 1230; vp.dispatchEvent(new Event('scroll')); });
    const row = firstRowOnScreen(first.container);
    const where = row.getBoundingClientRect().top;
    const id = row.dataset.messageId;
    first.unmount();

    const back = render(<EndlessColumn />);
    const again = firstRowOnScreen(back.container);
    expect(again.dataset.messageId).toBe(id);
    expect(again.getBoundingClientRect().top).toBe(where);
    expect(viewport(back.container).scrollTop).toBe(1230);
  });

  it('messages that arrived while away do not move the restored place', () => {
    const first = render(<EndlessColumn />);
    const vp = viewport(first.container);
    act(() => { vp.scrollTop = 800; });
    const id = firstRowOnScreen(first.container).dataset.messageId;
    first.unmount();
    act(() => { useEndless.setState({ messages: [...useEndless.getState().messages, msg(40), msg(41), msg(42)] }); });

    const back = render(<EndlessColumn />);
    expect(firstRowOnScreen(back.container).dataset.messageId).toBe(id);
    expect(viewport(back.container).scrollTop).toBe(800);
  });

  it('through ChatMode: the older pages the reader scrolled up through stay, and so does the place', async () => {
    // The store holds 0..39 (the tail page 10..39 plus one older page); the tail page is what the server returns.
    vi.spyOn(api, 'endlessProjects').mockResolvedValue({ projects: [], threads: [], truncated: false } as never);
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null } } as never);
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: Array.from({ length: 30 }, (_, k) => msg(k + 10)), hasMore: true, hasMoreAfter: false } as never);
    const first = render(<ChatMode />);
    await act(async () => {});
    const vp = viewport(first.container);
    act(() => { vp.scrollTop = 520; }); // row 5: on the older page
    const id = firstRowOnScreen(first.container).dataset.messageId;
    first.unmount();

    const back = render(<ChatMode />);
    await act(async () => {});
    expect(useEndless.getState().messages).toHaveLength(40);
    expect(firstRowOnScreen(back.container).dataset.messageId).toBe(id);
    expect(viewport(back.container).scrollTop).toBe(520);
  });

  it('a reader at the end comes back at the end', () => {
    const first = render(<EndlessColumn />);
    first.unmount();
    act(() => { useEndless.setState({ messages: [...useEndless.getState().messages, msg(40), msg(41)] }); });

    const back = render(<EndlessColumn />);
    const vp = viewport(back.container);
    expect(vp.scrollTop).toBe(vp.scrollHeight - VIEW);
  });
});

describe('refreshTail (Chat mount)', () => {
  it('keeps the older pages the reader loaded and adds only newer messages', async () => {
    useEndless.setState({ messages: Array.from({ length: 30 }, (_, i) => msg(i)), hasMore: false });
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(25), msg(26), msg(27), msg(28), msg(29), msg(30)], hasMore: true, hasMoreAfter: false } as never);
    await useEndless.getState().refreshTail();
    const s = useEndless.getState();
    expect(s.messages.map((m) => m.i)).toEqual(Array.from({ length: 31 }, (_, i) => i));
    expect(s.hasMore).toBe(false);
  });

  it('takes the page when it does not overlap what is shown', async () => {
    useEndless.setState({ messages: [msg(0), msg(1)] });
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(50), msg(51)], hasMore: true, hasMoreAfter: false } as never);
    await useEndless.getState().refreshTail();
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([50, 51]);
    expect(useEndless.getState().hasMore).toBe(true);
  });

  it('leaves a search window as it is', async () => {
    useEndless.setState({ messages: [msg(5), msg(6)], atTail: false, focus: 5 });
    const spy = vi.spyOn(api, 'endlessMessages');
    await useEndless.getState().refreshTail();
    expect(spy).not.toHaveBeenCalled();
    expect(useEndless.getState().focus).toBe(5);
  });

  it('loads the tail the first time', async () => {
    useEndless.setState({ messages: [], loaded: false });
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(1)], hasMore: false, hasMoreAfter: false } as never);
    await useEndless.getState().refreshTail();
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([1]);
  });
});
