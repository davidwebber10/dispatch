import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The parser, wrapped to count its calls. It still is the real parser.
vi.mock('../../../../lib/markdown', async (orig) => {
  const m = await orig<typeof import('../../../../lib/markdown')>();
  return { ...m, renderMarkdown: vi.fn(m.renderMarkdown) };
});

import { renderMarkdown } from '../../../../lib/markdown';
import { AssistantText } from './leaves';
import { Markdown } from '../../../Markdown';

const parser = vi.mocked(renderMarkdown);
beforeEach(() => { vi.useFakeTimers(); parser.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

const html = (c: HTMLElement) => [...c.querySelectorAll('.md-view')].map((e) => e.innerHTML).join('|');

it('a message from history is parsed once, in one pass', () => {
  const text = 'One.\n\nTwo.\n\n```ts\nconst a = 1;\n```\n';
  const view = render(<AssistantText text={text} />);
  expect(parser).toHaveBeenCalledTimes(1);
  expect(parser.mock.calls[0][0]).toBe(text);
  view.rerender(<AssistantText text={text} />);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(parser).toHaveBeenCalledTimes(1);
});

it('a text that grows renders at most 11 times a second, and the final HTML is the one-shot HTML', () => {
  const view = render(<AssistantText text="Start." />);
  parser.mockClear();
  let text = 'Start.';
  for (let i = 0; i < 200; i++) { // 200 deltas in one second
    text += i % 40 === 39 ? '\n\nNext paragraph' : ' word';
    view.rerender(<AssistantText text={text} />);
    act(() => { vi.advanceTimersByTime(5); });
  }
  // One parser call for each render pass (the open block), plus one for each of the 5 paragraphs
  // at the time it closed. 200 deltas gave 200 full parses before W2-E.
  expect(parser.mock.calls.length).toBeLessThanOrEqual(11 + 5);
  expect(parser.mock.calls.length).toBeGreaterThanOrEqual(8);
  expect(parser.mock.calls.filter((c) => !String(c[0]).startsWith('Start.')).length).toBeLessThanOrEqual(11); // the passes, less the first block's
  // The stream stops: with no new prop the last text shows, then one full pass replaces the block HTML.
  parser.mockClear();
  act(() => { vi.advanceTimersByTime(2000); });
  expect(parser.mock.calls.at(-1)![0]).toBe(text);
  expect(parser.mock.calls.length).toBeLessThanOrEqual(2);
  const want = render(<Markdown source={text} />);
  expect(html(view.container)).toBe(html(want.container));
  expect(vi.getTimerCount()).toBe(0);
});

it('an insight block in a streamed text keeps its own rendering', () => {
  const view = render(<AssistantText text="Before." />);
  const full = 'Before.\n\n`★ Insight ─────────────────────────────────────`\nA note.\n`─────────────────────────────────────────────────`\n\nAfter the insight.';
  for (let n = 10; n <= full.length + 10; n += 10) {
    view.rerender(<AssistantText text={full.slice(0, n)} />);
    act(() => { vi.advanceTimersByTime(30); });
  }
  act(() => { vi.advanceTimersByTime(2000); });
  const want = render(<AssistantText text={full} />);
  expect(view.container.innerHTML).toBe(want.container.innerHTML);
  expect(view.container.querySelector('[data-testid="insight-rail"]')).not.toBeNull();
});
