import { describe, it, expect } from 'vitest';
import {
  shrink, appendToChatView, appendToCompactionView, resetCompactionView, compactionContext,
  renderLine, renderChat, renderChatBlocks, lineSize, PLACEHOLDER, DEFAULT_LIMITS, type ChatView,
} from '../../src/endless/view.js';
import type { Line } from '../../src/endless/tree.js';

// Taelin's rollback push, verbatim from the gist (life stays 0).
type PushList = { keep: number; life: number; state: number; older: PushList } | null;
function push(s: number, states: PushList): NonNullable<PushList> {
  if (states === null) return { keep: 0, life: 0, state: s, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) return { keep: 0, life: 0, state: s, older: { keep: 0, life: life - 1, state, older } };
  return { keep: 0, life, state: s, older: push(state, older) };
}
/** Push's list read as a view: each state starts a line that runs to the next newer state. */
function pushView(list: PushList, t: number): Line[] {
  const states: number[] = [];
  for (let n = list; n; n = n.older) states.push(n.state);
  states.reverse();
  return states.map((start, k) => {
    const end = k + 1 < states.length ? states[k + 1] : t + 1;
    const n = end - start;
    return [Math.log2(n), start / n] as Line;
  });
}

/** Deterministic node texts of 300..511 bytes. */
const textOf = (l: number, i: number) => `n${l}.${i} ` + 'x'.repeat(300 + ((l * 7919 + i * 104729) % 200));

describe('push equivalence', () => {
  it('matches push at every step for t = 0..20,000 when the budget is push\'s list length', () => {
    let list: PushList = null;
    let lines: Line[] = [];
    let mismatches = 0;
    for (let t = 0; t <= 20_000; t++) {
      list = push(t, list);
      const expected = pushView(list, t);
      lines = shrink([...lines, [0, t]], t + 1, () => true, () => 1, expected.length).lines;
      if (JSON.stringify(lines) !== JSON.stringify(expected)) { mismatches++; lines = expected.map(([l, i]) => [l, i] as Line); }
    }
    expect(mismatches).toBe(0);
  });
});

describe('chat view sawtooth', () => {
  it('stays within 64,000–128,000 bytes after the first batch', () => {
    const size = lineSize(textOf);
    let view: ChatView = { lines: [], batching: false };
    let batches = 0;
    for (let T = 1; T <= 3_000; T++) {
      const r = appendToChatView(view, T, () => true, size, DEFAULT_LIMITS);
      view = r.view;
      const total = view.lines.reduce((s, [l, i]) => s + size(l, i), 0);
      expect(total).toBeLessThanOrEqual(DEFAULT_LIMITS.high + 600);
      if (r.merged) {
        batches++;
        expect(total).toBeLessThanOrEqual(DEFAULT_LIMITS.low);
        expect(total).toBeGreaterThan(DEFAULT_LIMITS.low - 1_200);
      }
      if (batches > 0) expect(total).toBeGreaterThan(DEFAULT_LIMITS.low - 1_200);
    }
    expect(batches).toBeGreaterThan(5);
  });

  it('merges only pairs whose parent is built and keeps batching at the next message', () => {
    const size = () => 100;
    const limits = { low: 300, high: 500, compactionLow: 100, compactionHigh: 200 };
    let view: ChatView = { lines: [], batching: false };
    for (let T = 1; T <= 6; T++) view = appendToChatView(view, T, () => false, size, limits).view;
    expect(view.lines).toHaveLength(6);
    expect(view.batching).toBe(true); // nothing could merge
    const next = appendToChatView(view, 7, () => true, size, limits);
    expect(next.merged).toBe(true);
    expect(next.view.lines.length * 100).toBeLessThanOrEqual(300);
    expect(next.view.batching).toBe(false);
  });
});

describe('compaction view', () => {
  const size = () => 100;
  const limits = { low: 1_000, high: 2_000, compactionLow: 300, compactionHigh: 600 };

  it('is merged to the low mark once, then appended, then merged again past the high mark', () => {
    let cv = resetCompactionView([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], 5, () => true, size, limits);
    expect(cv.length * 100).toBeLessThanOrEqual(300);
    for (let T = 6; T <= 9; T++) {
      const r = appendToCompactionView(cv, T, () => true, size, limits);
      cv = r.lines;
    }
    expect(cv.length * 100).toBeLessThanOrEqual(600);
  });

  it('context ends at the target, holds only built lines, and stops at the first unbuilt line', () => {
    const cv: Line[] = [[2, 0], [1, 2], [0, 6], [0, 7], [0, 8], [0, 9]];
    const built = (l: number, i: number) => !(l === 0 && i === 7);
    expect(compactionContext(cv, { l: 0, i: 9 }, built)).toEqual([[2, 0], [1, 2], [0, 6]]);
    expect(compactionContext(cv, { l: 0, i: 6 }, () => true)).toEqual([[2, 0], [1, 2]]);
    expect(compactionContext(cv, { l: 1, i: 3 }, () => true)).toEqual([[2, 0], [1, 2], [0, 6], [0, 7]]);
    // a line that crosses the target's end stops the context
    expect(compactionContext([[2, 0], [2, 1]], { l: 1, i: 0 }, () => true)).toEqual([]);
  });

  it('never renders a placeholder when built only', () => {
    const cv: Line[] = [[0, 0], [0, 1], [0, 2]];
    const text = (l: number, i: number) => (i === 1 ? undefined : `t${i}`);
    const ctx = compactionContext(cv, { l: 0, i: 3 }, (l, i) => text(l, i) !== undefined);
    expect(renderChat(ctx, text)).not.toContain(PLACEHOLDER);
  });
});

describe('rendering', () => {
  it('renders id+n|text with newlines as spaces, and a placeholder when unbuilt', () => {
    expect(renderLine(3, 5, 'a\nb')).toBe('40+8|a b');
    expect(renderLine(0, 9, undefined)).toBe(`9+1|${PLACEHOLDER}`);
  });
  it('renders <chat> in 4-line blocks that join back to the whole view', () => {
    const lines: Line[] = Array.from({ length: 10 }, (_, k) => [0, k] as Line);
    const text = (_l: number, i: number) => `m${i}`;
    const blocks = renderChatBlocks(lines, text);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].startsWith('<chat>\n0+1|m0\n')).toBe(true);
    expect(blocks[2].endsWith('9+1|m9\n</chat>')).toBe(true);
    expect(blocks.join('')).toBe(renderChat(lines, text));
    expect(renderChatBlocks([], text)).toEqual(['<chat>\n</chat>']);
  });
});
