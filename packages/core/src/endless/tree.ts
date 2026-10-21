/**
 * Endless Chat tree math (spec 2026-10-13 section 4; the gist sections 2-3). Pure.
 * node(l, i) covers the 2^l messages from i·2^l on and is named `id+n`.
 */

export const NODE_BYTES = 512;

export interface NodeRef { l: number; i: number }
export type IsBuilt = (l: number, i: number) => boolean;
/** A view line: [level, index]. */
export type Line = [number, number];

export const firstMessage = (l: number, i: number): number => i * 2 ** l;
export const lastMessage = (l: number, i: number): number => (i + 1) * 2 ** l - 1;
export const nodeName = (l: number, i: number): string => `${firstMessage(l, i)}+${2 ** l}`;
export const nodeKey = (l: number, i: number): string => `${l}:${i}`;
export const parentOf = (l: number, i: number): NodeRef => ({ l: l + 1, i: Math.floor(i / 2) });
export const siblingOf = (l: number, i: number): NodeRef => ({ l, i: i % 2 === 0 ? i + 1 : i - 1 });

export function childrenOf(l: number, i: number): [NodeRef, NodeRef] {
  if (l === 0) throw new Error('a message node has no children');
  return [{ l: l - 1, i: 2 * i }, { l: l - 1, i: 2 * i + 1 }];
}

/** `id+n` → node, or null when n is not a power of 2 or id is not a multiple of n. */
export function fromName(id: number, n: number): NodeRef | null {
  if (!Number.isInteger(id) || !Number.isInteger(n) || id < 0 || n < 1) return null;
  const l = Math.log2(n);
  if (!Number.isInteger(l) || id % n !== 0) return null;
  return { l, i: id / n };
}

/**
 * How due the sibling pair (l, i), (l, i+1) is to merge, with T messages in the chat:
 * (T - last) / 2^l, where `last` is the pair's LAST message. Never measure from the first.
 */
export function pairDue(l: number, i: number, T: number): number {
  return (T - lastMessage(l + 1, Math.floor(i / 2))) / 2 ** l;
}

/**
 * Index k of the most due sibling pair (lines k and k+1) whose parent is built, or -1.
 * Lines are oldest first, so a strict comparison keeps the oldest of equally due pairs.
 */
export function mostDuePair(lines: readonly (readonly [number, number])[], T: number, isBuilt: IsBuilt): number {
  let best = -1;
  let bestDue = -Infinity;
  for (let k = 0; k + 1 < lines.length; k++) {
    const [l, i] = lines[k];
    const [l2, i2] = lines[k + 1];
    if (l !== l2 || i % 2 !== 0 || i2 !== i + 1) continue;
    if (!isBuilt(l + 1, i / 2)) continue;
    const due = pairDue(l, i, T);
    if (due > bestDue) { best = k; bestDue = due; }
  }
  return best;
}
