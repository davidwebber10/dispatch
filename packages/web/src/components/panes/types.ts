// Layout model for grouped (multi-pane) tabs.
//
// A group's layout is a *binary split tree*. This makes "moving a divider
// between two windows only resizes those two windows" fall out for free: every
// divider belongs to exactly one split node and only resizes that node's two
// children.
//
//   dir:'row' -> a | b  (side by side, a VERTICAL divider; ratio = a's WIDTH fraction)
//   dir:'col' -> a / b  (stacked,      a HORIZONTAL divider; ratio = a's HEIGHT fraction)
//
// Default shapes (see defaultLayout):
//   2 panes -> split(row, .5, l0, l1)                                   [left | right]
//   3 panes -> split(col, .5, split(row,.5,l0,l1), l2)                  [two top split, one bottom full]
//   4 panes -> split(col, .5, split(row,.5,l0,l1), split(row,.5,l2,l3)) [2x2 grid; each row's vertical
//                                                                        divider is its own node -> independent]
// Max 4 panes (leaves) per group.

export type PaneNode =
  | { kind: 'leaf'; tabId: string }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode };

export interface Group {
  id: string;
  layout: PaneNode;
  sessionId: string;
}

export const MAX_PANES = 4;

const leaf = (tabId: string): PaneNode => ({ kind: 'leaf', tabId });
const split = (dir: 'row' | 'col', ratio: number, a: PaneNode, b: PaneNode): PaneNode => ({ kind: 'split', dir, ratio, a, b });

/** Build the canonical layout for `tabIds` using the 2/3/4 default shapes.
 *  Extra ids beyond 4 are dropped (a group holds at most MAX_PANES). */
export function defaultLayout(tabIds: string[]): PaneNode {
  const ids = tabIds.slice(0, MAX_PANES);
  switch (ids.length) {
    case 0:
      throw new Error('defaultLayout: needs at least one tabId');
    case 1:
      return leaf(ids[0]);
    case 2:
      return split('row', 0.5, leaf(ids[0]), leaf(ids[1]));
    case 3:
      return split('col', 0.5, split('row', 0.5, leaf(ids[0]), leaf(ids[1])), leaf(ids[2]));
    default:
      return split('col', 0.5, split('row', 0.5, leaf(ids[0]), leaf(ids[1])), split('row', 0.5, leaf(ids[2]), leaf(ids[3])));
  }
}

/** Number of leaves (panes) in the tree. */
export function leafCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : leafCount(node.a) + leafCount(node.b);
}

/** Tab ids of every leaf, in visual order (left-to-right, top-to-bottom). */
export function leafTabIds(node: PaneNode): string[] {
  return node.kind === 'leaf' ? [node.tabId] : [...leafTabIds(node.a), ...leafTabIds(node.b)];
}

/** Remove the leaf for `tabId`, collapsing the now-single-child split into its
 *  surviving child. Returns null if the whole tree was just that leaf. */
export function removeLeaf(node: PaneNode, tabId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.tabId === tabId ? null : node;
  const a = removeLeaf(node.a, tabId);
  const b = removeLeaf(node.b, tabId);
  if (a === null) return b;   // a's leaf was removed -> promote b
  if (b === null) return a;   // b's leaf was removed -> promote a
  return { ...node, a, b };
}

/** Add `tabId` and rebuild to the next default shape, inserting it at
 *  `targetBlockIndex` in the flattened pane order (append if omitted).
 *  No-op (returns the original node) if the tab is already present or the
 *  group is already at MAX_PANES. */
export function addLeaf(node: PaneNode, tabId: string, targetBlockIndex?: number): PaneNode {
  const ids = leafTabIds(node);
  if (ids.includes(tabId)) return node;
  if (ids.length >= MAX_PANES) return node;
  const idx = targetBlockIndex == null ? ids.length : Math.max(0, Math.min(ids.length, targetBlockIndex));
  const next = [...ids.slice(0, idx), tabId, ...ids.slice(idx)];
  return defaultLayout(next);
}

/** Set the ratio of the split node addressed by `path` (a string of 'a'/'b'
 *  steps from the root; '' = the root node itself). Ratio is left as-is here —
 *  the store clamps before calling. */
export function setRatio(node: PaneNode, path: string, ratio: number): PaneNode {
  if (node.kind !== 'split') return node;
  if (path === '') return { ...node, ratio };
  const head = path[0];
  const rest = path.slice(1);
  if (head === 'a') return { ...node, a: setRatio(node.a, rest, ratio) };
  if (head === 'b') return { ...node, b: setRatio(node.b, rest, ratio) };
  return node;
}
