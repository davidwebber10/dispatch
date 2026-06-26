# Polished Drag-Reorder (projects & threads) — Design

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

Reordering projects uses native HTML5 drag in `ProjectSidebar.tsx`: the dragged card drops to `opacity:0.45` (a flat grey-out) and the drop target shows a `2px` accent **line**. It has no touch support, and threads can't be reordered at all. We want a polished, consistent drag for **both** projects and threads: the picked item lifts and gently wiggles, and the list opens a clean **gap placeholder** (not a line) where it will land.

## Goal

One reusable sortable-list building block, used by the project list and each project's thread list, giving an identical feel: press-and-hold to pick up; the dragged item lifts + wiggles (only it); other items animate to open a rounded tinted gap; drop persists the new order. Works on pointer and touch.

## Decisions (from brainstorming)

- **Wiggle = dragged item only** (it lifts; the rest stay upright but slide to make room).
- **Library = @dnd-kit** (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`, `@dnd-kit/utilities`).
- **Activation = press-and-hold** (so tap/click still selects; a hold starts the drag) — pointer + touch.
- **Scope = reorder within a list:** projects within the sidebar; threads within their project. Cross-project thread moves are out of scope.

## Architecture / components

**Reusable core — `components/common/SortableList.tsx`.** A generic, presentational wrapper:
```
SortableList<T extends { id: string }>({
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  renderItem: (item: T, opts: { dragging: boolean }) => React.ReactNode;
  renderOverlay?: (item: T) => React.ReactNode;   // defaults to renderItem(item,{dragging:true})
  disabled?: boolean;
})
```
Internals: a `DndContext` with `PointerSensor` (activationConstraint `{ delay: 180, tolerance: 8 }`) + `KeyboardSensor`; a `SortableContext` (`verticalListSortingStrategy`); each item wrapped by an internal `SortableItem` (uses `useSortable`) that applies dnd-kit's `transform`/`transition`. While an item `isDragging`, its in-list element renders as a **placeholder** — a rounded, tinted, dashed, item-height box (the dropzone) — and a `DragOverlay` renders the lifted copy (scale ~1.03, shadow, slight tilt) with a continuous **wiggle**. On `onDragEnd`, compute the new id order via a pure helper and call `onReorder`. When `disabled`, items render normally with no drag wiring.

**Pure reorder helper — `lib/reorder.ts`.** `reorderIds(ids: string[], activeId: string, overId: string): string[]` (thin wrapper over dnd-kit's `arrayMove` by index) — unit-tested in isolation so the ordering math isn't trapped behind drag simulation.

**Wiggle keyframe.** Add `@keyframes dispatch-wiggle { 0%,100% { rotate: -1.2deg } 50% { rotate: 1.2deg } }` to `packages/web/src/theme.css` (which already hosts keyframes); the `DragOverlay` content applies `animation: dispatch-wiggle .25s ease-in-out infinite`.

**Projects — `ProjectSidebar.tsx`.** Replace the native-drag `<div draggable …>` wrapper + `dragId`/`overId` state + grey-out/line styles with `<SortableList items={filtered} onReorder={…} renderItem={(s,{dragging}) => <ProjectCard … />} disabled={!!query} />`. `onReorder(orderedIds)` → `useProjects.getState().reorder(orderedIds)` and `setSort('custom')` (preserve today's "manual drag implies custom order" behavior). Drag stays disabled while searching.

**Threads — `ProjectCard.tsx` + `stores/tabs.ts`.** The expanded thread list (the `byProject[session.id]` list) becomes a `SortableList`; `renderItem` is the existing thread-row. `onReorder(orderedIds)` → a NEW `useTabs.reorder(sessionId, orderedIds)` store action that optimistically reorders `byProject[sessionId]` then calls `api.reorderTerminals(sessionId, orderedIds)` (the route + client method already exist), reverting/reloading on failure. The plan pins the exact render site (ProjectCard has two thread-render blocks; only the expanded list gets sortable).

## Data flow

Press-hold on a row → dnd-kit picks it up → overlay (lifted+wiggling) follows the pointer; siblings animate; the source slot shows the dashed gap placeholder → on drop, `reorderIds` computes the order → `onReorder` persists (projects: `reorderSessions`; threads: `reorderTerminals`) → store updates → list settles into the new order.

## Error handling

Persist failures: projects — the store reorder already round-trips to the server; on failure, re-fetch/restore prior order. Threads — `useTabs.reorder` updates optimistically and, on a failed `reorderTerminals`, reloads tabs to restore truth. A no-op drop (drop onto self / `overId === activeId` / null) makes no call. `disabled` (project search active) fully bypasses drag.

## Testing

- `lib/reorder.ts` unit tests: move-down, move-up, drop-on-self (no change), unknown id (no change). Pure + deterministic.
- `stores/tabs` test: `reorder(sessionId, ids)` optimistically reorders `byProject` and calls `api.reorderTerminals` with the new order; on a rejected api call, it reloads.
- `SortableList` smoke test: renders all items via `renderItem` and, when `disabled`, applies no drag attributes. (Full press-hold drag interaction is verified manually — drag feel in jsdom isn't meaningful; dnd-kit interaction is e2e territory.)
- Verify web `tsc --noEmit` + `vite build` clean.

## Out of scope

Cross-project thread moves (`moveTerminal`); reordering in the separate mobile view if it renders its own list (the plan will check whether the mobile view reuses `ProjectSidebar`/`ProjectCard`; if it has a bespoke list, applying `SortableList` there is a documented follow-up).

## Decision

dnd-kit + a single shared `SortableList` keeps projects and threads identical and gives the lift/wiggle/animated-gap and touch support without hand-rolling pointer math; the only genuinely new logic (the order computation, the tabs reorder action) is extracted to pure, unit-tested units.
