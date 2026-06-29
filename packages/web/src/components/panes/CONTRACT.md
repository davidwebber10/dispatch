# panes/ — multi-pane tab grouping (foundation)

Shared core for grouping tabs into split / grid views. **Operator mode only**, gated
by the `multiPane` setting (default `true`). A "tab" is a `Terminal`
(`api/types.ts`); panes render tab content by reusing `<TabHost terminalId>`.

This module is the FOUNDATION. The interaction layers built on top of it
(merge-on-drag in the TabBar, the merged-tab chip with unmerge/close, the
reorganize-drag overlay, and the App.tsx wiring that renders a group instead of
a single `<TabHost/>`) are NOT in here — they consume the API below.

Files: `types.ts` (model + pure helpers), `store.ts` (zustand `useGroups`),
`Splitter.tsx`, `PaneFrame.tsx`, `PaneTree.tsx`.

---

## Layout model (`types.ts`)

```ts
type PaneNode =
  | { kind: 'leaf'; tabId: string }
  | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode };

interface Group { id: string; layout: PaneNode; sessionId: string }

const MAX_PANES = 4;
```

A group's layout is a **binary split tree** — this is what makes "moving a
divider between two windows only resizes those two windows" fall out for free:
every divider belongs to exactly one split node and only resizes that node's two
children.

- `dir:'row'` → `a | b` side by side. Vertical divider. `ratio` = **a's width** fraction.
- `dir:'col'` → `a / b` stacked. Horizontal divider. `ratio` = **a's height** fraction.

Default shapes (`defaultLayout`):

| panes | shape |
|------|-------|
| 2 | `split(row, .5, l0, l1)` — left \| right |
| 3 | `split(col, .5, split(row,.5,l0,l1), l2)` — two top split, one bottom full width |
| 4 | `split(col, .5, split(row,.5,l0,l1), split(row,.5,l2,l3))` — 2×2 grid |

In the 4-pane grid the top row's vertical divider and the bottom row's vertical
divider are **separate split nodes**, so they move independently; the root `col`
divider sets the two row heights. Max 4 panes per group.

### Pure helpers (`types.ts`)

- `defaultLayout(tabIds: string[]): PaneNode` — canonical shape for 1–4 ids (extras dropped). Throws on `[]`.
- `leafCount(node): number`
- `leafTabIds(node): string[]` — visual order (left→right, top→bottom).
- `removeLeaf(node, tabId): PaneNode | null` — removes the leaf and collapses the now-single-child split; `null` if the tree was just that leaf.
- `addLeaf(node, tabId, targetBlockIndex?): PaneNode` — rebuilds to the next default shape inserting `tabId` at `targetBlockIndex` in the flattened order (append if omitted). No-op if the tab is already present or already at `MAX_PANES`.
- `setRatio(node, path, ratio): PaneNode` — returns a new tree with the ratio of the split addressed by `path` set (no clamping — the store clamps).

**`path`** addresses a split node from the root as a string of `'a'`/`'b'` steps;
`''` is the root node itself. `PaneTree` generates these (root `''`, children
`path+'a'` / `path+'b'`), so a `Splitter`'s `onRatio` always targets its own node.

---

## Store (`store.ts`) — `useGroups`

State, persisted to `localStorage['dispatch:groups']` (same pattern as `stores/tabs.ts`):

```ts
groups: Record<string, Group>           // groupId -> Group
tabGroup: Record<string, string>        // tabId  -> groupId   (membership index)
```

Actions:

| action | behavior |
|--------|----------|
| `merge(sessionId, tabIdA, tabIdB) => groupId` | Create a group from two **individual** tabs (`defaultLayout([a,b])`, left\|right). Returns the new group id. For dropping onto an already-grouped tab, use `addToGroup`. |
| `addToGroup(groupId, tabId, targetBlockIndex?)` | Add an individual tab into a group at an optional target block (rebuilds to the next default shape). No-op at `MAX_PANES` or if already present. |
| `unmerge(groupId)` | Dissolve the group; its tabs become individual again. **Tabs stay open.** |
| `closeGroup(groupId)` | Remove the group **and** close every tab in it (`useTabs.getState().closeTab` for each). |
| `removeFromGroup(groupId, tabId)` | Remove one pane (`removeLeaf`). The tab **stays open** as an individual. If ≤1 leaf remains, the group dissolves (survivor becomes individual). |
| `setRatio(groupId, path, ratio)` | Set a divider ratio, clamped **.15–.85**. |
| `reorganize(groupId, newLayout)` | Replace a group's layout wholesale (reorganize-drag drops); re-indexes `tabGroup`. |

Helper export:

- `groupForTab(tabId): Group | undefined` — the group a tab currently belongs to, if any (reads `useGroups.getState()`, not a hook).

### Consumer guidance (for the layers above)
- A tab is "grouped" iff `useGroups(s => s.tabGroup[tabId])` is set. App.tsx should
  render `<PaneTree node={group.layout} groupId={group.id} onMoveLeaf={…}/>`
  inside a `flex:1, minHeight:0` container instead of the single `<TabHost/>` when
  the active tab is grouped. Gate the whole feature on
  `useViewMode(s=>s.mode)==='operator'` **and** `useSettings(s=>s.multiPane)`.
- The merged-tab chip in the TabBar: its **unmerge** control → `unmerge(groupId)`;
  its **X** → `closeGroup(groupId)` (closes all grouped tabs, per the spec).
- Drag tab→tab = `merge`; drag tab→group = `addToGroup`.

---

## Components

### `Splitter.tsx` — `Splitter({ dir, ratio, onRatio })`
- `dir: 'row' | 'col'`, `ratio: number`, `onRatio: (r:number)=>void`.
- A 6px draggable bar: `row` → vertical bar, `col-resize`; `col` → horizontal bar, `row-resize`. Subtle, themed (`var(--color-border)`, accent on hover/drag).
- On `pointerdown` it captures the pointer (survives dragging over iframes/xterm), reads the **parent split container's** rect on each move, computes the new ratio, clamps **.15–.85**, and calls `onRatio`. `touchAction:'none'`.
- Must be rendered as the **direct middle child** of the split flex container (it uses `el.parentElement.getBoundingClientRect()` to map pointer → ratio). `PaneTree` already does this.

### `PaneFrame.tsx` — `PaneFrame({ tabId, onClose, onMoveStart? })`
- `tabId: string`, `onClose: () => void`, `onMoveStart?: (e: React.PointerEvent) => void`.
- A 30px title bar — label (from `useTabs`/`findTerminal`), a grip button (`DotsSixVertical`) whose **pointerdown** calls `onMoveStart(e)` (forwarded for drag tracking by the reorganize layer), and an X button (`X`) → `onClose` — over `<TabHost terminalId={tabId}/>` (`flex:1, minHeight:0`). Themed title bar (`var(--color-pane)`, border-bottom).

### `PaneTree.tsx` — `PaneTree({ node, groupId, path?, onMoveLeaf? })`
- `node: PaneNode`, `groupId: string`, `path?: string` (default `''`), `onMoveLeaf?: (tabId:string, e:React.PointerEvent)=>void`.
- Recursive: **leaf** → `<PaneFrame tabId onClose={removeFromGroup(groupId,tabId)} onMoveStart={e=>onMoveLeaf(tabId,e)}/>`; **split** → flex container (`row`→`flexDirection:'row'`, else `column`) with child A (`flex: ratio 1 0%`), a `<Splitter dir ratio onRatio={r=>setRatio(groupId, path, r)}/>`, and child B (`flex: 1-ratio 1 0%`); recurses with `path+'a'` / `path+'b'`. Every side has `minWidth/minHeight:0`.
- Render it inside a `flex:1, minHeight:0` container.

---

## Settings (`stores/settings.ts`)

Added minimally, matching the file's `load`/`save` localStorage pattern:
- State `multiPane: boolean` (default `true`, key `dispatch:multiPane`).
- Action `setMultiPane(b: boolean): void`.
- A toggle row ("Multi-pane layouts (Operator)") is wired into the General tab of `components/settings/SettingsModal.tsx`.
