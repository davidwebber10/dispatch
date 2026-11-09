// packages/web/scripts/perf/markdown-stream.perf.test.tsx
// Markdown work during a streamed reply (W2-E, plan 1A.3 "Streamed markdown").
// It feeds a reply of about 4,000 tokens to the chat's assistant-text leaf, one token for each
// 12.5 ms of (fake) time: 80 tokens for each second, 50 seconds. It counts the parser calls, the
// characters given to the parser and the sanitizer calls.
//
//   npx vitest run scripts/perf/markdown-stream.perf.test.tsx
//
// PERF_UNTHROTTLED=1 measures the path with no throttle (each delta is parsed in full, as before
// W2-E): the "before" number on the same machine.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { streamDeltas, streamFixture } from './stream-fixture.mjs';

vi.mock('../../src/lib/markdown', async (orig) => {
  const m = await orig<typeof import('../../src/lib/markdown')>();
  // Plain counters: a vi.fn would keep each of the 4,000 texts.
  return { ...m, renderMarkdown: (src: string) => { counts.parserCalls += 1; counts.parserChars += (src ?? '').length; return m.renderMarkdown(src); } };
});
const counts = vi.hoisted(() => ({ parserCalls: 0, parserChars: 0, sanitizeCalls: 0 }));

import { AssistantText } from '../../src/components/tabs/chat/timeline';
import { Markdown } from '../../src/components/Markdown';

const UNTHROTTLED = process.env.PERF_UNTHROTTLED === '1';
const TICK_MS = 12.5;

// setImmediate stays real: the loop below yields with it, so jsdom can free the replaced nodes.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

it('a 4,000-token streamed reply: markdown work for each second of the stream', async () => {
  const text = streamFixture();
  const deltas = streamDeltas(text);
  const realSanitize = DOMPurify.sanitize.bind(DOMPurify);
  (DOMPurify as { sanitize: unknown }).sanitize = (...a: Parameters<typeof realSanitize>) => { counts.sanitizeCalls += 1; return realSanitize(...a); };
  const node = (t: string) => (UNTHROTTLED ? <Markdown source={t} /> : <AssistantText text={t} />);

  const view = render(node(''));
  counts.parserCalls = 0; counts.parserChars = 0; counts.sanitizeCalls = 0;
  const started = performance.now();
  let shown = '';
  for (const [i, d] of deltas.entries()) {
    if (i % 100 === 0) await new Promise((r) => setImmediate(r));
    shown += d;
    view.rerender(node(shown));
    act(() => { vi.advanceTimersByTime(TICK_MS); });
  }
  act(() => { vi.advanceTimersByTime(2000); }); // the stream ended: the last text renders
  const wallMs = performance.now() - started;

  const seconds = (deltas.length * TICK_MS) / 1000;
  (DOMPurify as { sanitize: unknown }).sanitize = realSanitize;
  const report = {
    mode: UNTHROTTLED ? 'unthrottled (before)' : 'throttled (after)',
    tokens: deltas.length,
    streamSeconds: seconds,
    parserCalls: counts.parserCalls,
    parserCallsPerSecond: +(counts.parserCalls / seconds).toFixed(1),
    parserChars: counts.parserChars,
    parserCharsPerSecond: Math.round(counts.parserChars / seconds),
    sanitizeCalls: counts.sanitizeCalls,
    sanitizeCallsPerSecond: +(counts.sanitizeCalls / seconds).toFixed(1),
    wallMsInJsdom: Math.round(wallMs),
  };
  console.log(`markdown-stream ${JSON.stringify(report)}`);

  // The last text is on screen in full.
  expect(view.container.textContent).toContain('That is the full plan.');
  expect(view.container.querySelectorAll('pre').length).toBe(16);
  if (!UNTHROTTLED) {
    // At most one parse pass for each 100 ms, and each pass parses the open block only.
    expect(report.parserCallsPerSecond).toBeLessThanOrEqual(11);
    expect(report.parserCharsPerSecond).toBeLessThan(10_000);
  }
}, 300_000);
