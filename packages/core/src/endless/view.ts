/**
 * Endless Chat view rules (spec 2026-10-13 section 4; the gist section 3). Pure.
 * The chat view grows one line per message and batch-merges from >128,000 to ≤64,000 bytes.
 * The compaction view is the chat view merged further, a 16–32 KB sawtooth.
 */
import { mostDuePair, nodeName, lastMessage, type IsBuilt, type Line, type NodeRef } from './tree.js';
import { byteLength, oneLine } from './text.js';

export interface ViewLimits { low: number; high: number; compactionLow: number; compactionHigh: number }
export const DEFAULT_LIMITS: ViewLimits = { low: 64_000, high: 128_000, compactionLow: 16_000, compactionHigh: 32_000 };
export const PLACEHOLDER = '(not summarized yet: zoom it)';

export type NodeText = (l: number, i: number) => string | undefined;
export type LineSize = (l: number, i: number) => number;
export interface ChatView { lines: Line[]; batching: boolean }

export function renderLine(l: number, i: number, text: string | undefined): string {
  return `${nodeName(l, i)}|${oneLine(text ?? PLACEHOLDER)}`;
}

/** A line's size in the rendered view: its UTF-8 bytes plus the newline after it. */
export function lineSize(text: NodeText): LineSize {
  return (l, i) => byteLength(renderLine(l, i, text(l, i))) + 1;
}

const sum = (lines: readonly Line[], size: LineSize): number => lines.reduce((s, [l, i]) => s + size(l, i), 0);

/** Merge the most due pairs (parent built) until the total is at most `limit`, or none is left. */
export function shrink(lines: readonly Line[], T: number, isBuilt: IsBuilt, size: LineSize, limit: number): { lines: Line[]; total: number; merges: number } {
  const out: Line[] = lines.map(([l, i]) => [l, i]);
  let total = sum(out, size);
  let merges = 0;
  while (total > limit) {
    const k = mostDuePair(out, T, isBuilt);
    if (k < 0) break;
    const [l, i] = out[k];
    total -= size(l, i) + size(l, i + 1);
    out.splice(k, 2, [l + 1, i / 2]);
    total += size(l + 1, i / 2);
    merges++;
  }
  return { lines: out, total, merges };
}

/** Message T-1 was just logged (T messages in all). Append its line; batch per the sawtooth. */
export function appendToChatView(view: ChatView, T: number, isBuilt: IsBuilt, size: LineSize, limits: ViewLimits = DEFAULT_LIMITS): { view: ChatView; merged: boolean } {
  const lines: Line[] = [...view.lines.map(([l, i]) => [l, i] as Line), [0, T - 1]];
  const batching = view.batching || sum(lines, size) > limits.high;
  if (!batching) return { view: { lines, batching: false }, merged: false };
  const r = shrink(lines, T, isBuilt, size, limits.low);
  return { view: { lines: r.lines, batching: r.total > limits.low }, merged: r.merges > 0 };
}

/** The chat's new line goes on the compaction view too; past the high mark it merges to the low mark. */
export function appendToCompactionView(lines: readonly Line[], T: number, isBuilt: IsBuilt, size: LineSize, limits: ViewLimits = DEFAULT_LIMITS): { lines: Line[]; merged: boolean } {
  const next: Line[] = [...lines.map(([l, i]) => [l, i] as Line), [0, T - 1]];
  if (sum(next, size) <= limits.compactionHigh) return { lines: next, merged: false };
  const r = shrink(next, T, isBuilt, size, limits.compactionLow);
  return { lines: r.lines, merged: r.merges > 0 };
}

/** The chat view merged further, down to the compaction low mark (at start and whenever the chat view merges). */
export function resetCompactionView(chatLines: readonly Line[], T: number, isBuilt: IsBuilt, size: LineSize, limits: ViewLimits = DEFAULT_LIMITS): Line[] {
  return shrink(chatLines, T, isBuilt, size, limits.compactionLow).lines;
}

/**
 * The compaction view for building `target`: the lines before the message (level 0), or the
 * lines up to the merge's last message. Stops at the first unbuilt line or at a line that
 * runs past the end, so no call sees a placeholder or half a message.
 */
export function compactionContext(lines: readonly Line[], target: NodeRef, isBuilt: IsBuilt): Line[] {
  const end = target.l === 0 ? target.i - 1 : lastMessage(target.l, target.i);
  const out: Line[] = [];
  for (const [l, i] of lines) {
    if (lastMessage(l, i) > end) break;
    if (!isBuilt(l, i)) break;
    out.push([l, i]);
  }
  return out;
}

export function renderChat(lines: readonly Line[], text: NodeText): string {
  return renderChatBlocks(lines, text).join('');
}

/** `<chat>` in blocks of 4 lines (the gist's cache-mark unit). The blocks join to the whole view. */
export function renderChatBlocks(lines: readonly Line[], text: NodeText): string[] {
  if (lines.length === 0) return ['<chat>\n</chat>'];
  const rendered = lines.map(([l, i]) => renderLine(l, i, text(l, i)));
  const blocks: string[] = [];
  for (let k = 0; k < rendered.length; k += 4) {
    const last = k + 4 >= rendered.length;
    blocks.push(`${k === 0 ? '<chat>\n' : ''}${rendered.slice(k, k + 4).join('\n')}${last ? '\n</chat>' : '\n'}`);
  }
  return blocks;
}
