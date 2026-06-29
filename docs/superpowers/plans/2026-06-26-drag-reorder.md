# Polished Drag-Reorder (projects & threads) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native-HTML5 project drag (grey-out + 2px line) with a polished @dnd-kit drag — picked item lifts + wiggles, list opens a clean gap placeholder — and apply the same to thread reordering.

**Architecture:** One reusable `SortableList` (a `@dnd-kit` `DndContext`+`SortableContext` wrapper with a `DragOverlay`) used by the project list (`ProjectSidebar`) and each project's thread list (`ProjectCard`). Pure order math + the tabs reorder action are extracted and unit-tested; the drag interaction itself is verified manually.

**Tech Stack:** React + TypeScript, @dnd-kit (`/core`, `/sortable`, `/modifiers`, `/utilities`), Vite, vitest + @testing-library.

## Global Constraints

- @dnd-kit only; no other DnD lib. Add to `packages/web` deps.
- **Wiggle = dragged item only** (the lifted `DragOverlay` copy); siblings animate to open the gap.
- **Activation = press-and-hold**: `PointerSensor` `activationConstraint: { delay: 180, tolerance: 8 }` so a tap/click still selects.
- **Desktop-only in v1**: drag is `disabled` when `useIsMobile()` is true (mobile rows already own swipe-delete + long-press-menu gestures via `SwipeRow`); mobile drag is a documented follow-up.
- **Dropzone = a rounded, tinted, dashed placeholder the same size as the item** (NOT a line). The source slot renders content at `opacity:0` with an absolutely-positioned dashed box filling it.
- Persistence: projects → `useProjects.reorder(orderedIds)` (→ `api.reorderSessions`); threads → a NEW `useTabs.reorder(projectId, orderedIds)` (→ `api.reorderTerminals`, which already exists).
- Wiggle keyframe lives in `packages/web/src/theme.css` (already hosts `@keyframes`).
- Reorder math is a pure helper (`lib/reorder.ts`), unit-tested; no dnd-kit import in the helper.

---

### Task 1: Deps + pure reorder helper + tabs.reorder action + wiggle keyframe

**Files:**
- Modify: `packages/web/package.json` (add @dnd-kit deps)
- Create: `packages/web/src/lib/reorder.ts`
- Create: `packages/web/src/lib/reorder.test.ts`
- Modify: `packages/web/src/stores/tabs.ts` (add `reorder`)
- Create: `packages/web/src/stores/tabs.reorder.test.ts`
- Modify: `packages/web/src/theme.css` (add `@keyframes dispatch-wiggle`)

**Interfaces:**
- Produces: `reorderIds(ids: string[], activeId: string, overId: string | null): string[]`; `useTabs.getState().reorder(projectId: string, orderedIds: string[]): Promise<void>`; CSS class `.dispatch-wiggle`.

- [ ] **Step 1: Add the dependencies**

Run: `cd /Users/davidwebber/Sites/dispatch && pnpm --filter dispatch-web add @dnd-kit/core @dnd-kit/sortable @dnd-kit/modifiers @dnd-kit/utilities`
Expected: packages added to `packages/web/package.json` + lockfile updated.

- [ ] **Step 2: Write the failing reorder-helper test**

Create `packages/web/src/lib/reorder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reorderIds } from './reorder';

describe('reorderIds', () => {
  it('moves an item down to the over position', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });
  it('moves an item up to the over position', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('returns the same order when dropped on itself', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });
  it('returns the same order for a null over', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', null)).toEqual(['a', 'b', 'c']);
  });
  it('returns the same order for an unknown id', () => {
    expect(reorderIds(['a', 'b', 'c'], 'x', 'b')).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/lib/reorder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the helper**

Create `packages/web/src/lib/reorder.ts`:

```ts
/** Pure list reorder: move `activeId` to where `overId` sits. No-op on self/null/unknown. */
export function reorderIds(ids: string[], activeId: string, overId: string | null): string[] {
  if (!overId || activeId === overId) return ids;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}
```

- [ ] **Step 5: Run helper test (pass)**

Run: `pnpm --filter dispatch-web exec vitest run src/lib/reorder.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing tabs.reorder test**

Create `packages/web/src/stores/tabs.reorder.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reorderTerminals = vi.fn();
const listTerminals = vi.fn();
vi.mock('../api/client', () => ({ api: {
  reorderTerminals: (sid: string, order: string[]) => reorderTerminals(sid, order),
  listTerminals: (sid: string) => listTerminals(sid),
} }));

import { useTabs } from './tabs';

const mk = (id: string) => ({ id, sessionId: 'p', type: 'claude-code', label: id, status: 'waiting' } as any);

describe('useTabs.reorder', () => {
  beforeEach(() => {
    reorderTerminals.mockReset(); listTerminals.mockReset();
    useTabs.setState({ byProject: { p: [mk('a'), mk('b'), mk('c')] } } as any);
  });

  it('optimistically reorders byProject and calls the API', async () => {
    reorderTerminals.mockResolvedValue(undefined);
    await useTabs.getState().reorder('p', ['c', 'a', 'b']);
    expect(useTabs.getState().byProject.p.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(reorderTerminals).toHaveBeenCalledWith('p', ['c', 'a', 'b']);
  });

  it('reloads from the server when the API rejects', async () => {
    reorderTerminals.mockRejectedValue(new Error('nope'));
    listTerminals.mockResolvedValue([mk('a'), mk('b'), mk('c')]);
    await useTabs.getState().reorder('p', ['c', 'a', 'b']);
    expect(listTerminals).toHaveBeenCalledWith('p');
    expect(useTabs.getState().byProject.p.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/stores/tabs.reorder.test.ts`
Expected: FAIL — `reorder` is not a function.

- [ ] **Step 8: Implement `reorder` in the tabs store**

In `packages/web/src/stores/tabs.ts`: add `reorder` to the `TabsState` interface (near `loadTabs`):

```ts
  reorder: (projectId: string, orderedIds: string[]) => Promise<void>;
```

And add the implementation inside the `create<TabsState>((set, get) => ({ … }))` object (place it right after `loadTabs`):

```ts
  reorder: async (projectId, orderedIds) => {
    const current = get().byProject[projectId] ?? [];
    const byId = new Map(current.map((t) => [t.id, t]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    // keep any rows not present in orderedIds (defensive) appended in their old order
    for (const t of current) if (!orderedIds.includes(t.id)) reordered.push(t);
    set({ byProject: { ...get().byProject, [projectId]: reordered } });
    try { await api.reorderTerminals(projectId, orderedIds); }
    catch { await get().loadTabs(projectId); }  // restore server truth on failure
  },
```

(Confirm `api` is already imported in `tabs.ts`; it is used by `loadTabs`.)

- [ ] **Step 9: Run tabs.reorder test (pass)**

Run: `pnpm --filter dispatch-web exec vitest run src/stores/tabs.reorder.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Add the wiggle keyframe**

In `packages/web/src/theme.css`, append:

```css
@keyframes dispatch-wiggle { 0%, 100% { rotate: -1.2deg } 50% { rotate: 1.2deg } }
.dispatch-wiggle { animation: dispatch-wiggle .25s ease-in-out infinite; }
```

- [ ] **Step 11: Typecheck + commit**

Run: `pnpm --filter dispatch-web exec tsc --noEmit` → clean.
```bash
git add packages/web/package.json pnpm-lock.yaml packages/web/src/lib/reorder.ts packages/web/src/lib/reorder.test.ts packages/web/src/stores/tabs.ts packages/web/src/stores/tabs.reorder.test.ts packages/web/src/theme.css
git commit -m "feat(web): dnd-kit deps + pure reorder helper + tabs.reorder action + wiggle keyframe"
```

---

### Task 2: `SortableList` component

**Files:**
- Create: `packages/web/src/components/common/SortableList.tsx`
- Create: `packages/web/src/components/common/SortableList.test.tsx`

**Interfaces:**
- Consumes: `reorderIds` (Task 1); `.dispatch-wiggle` (Task 1).
- Produces: `SortableList<T extends { id: string }>({ items, onReorder, renderItem, renderOverlay?, disabled? })`.

- [ ] **Step 1: Write the failing smoke test**

Create `packages/web/src/components/common/SortableList.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { SortableList } from './SortableList';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('renders every item via renderItem', () => {
  render(<SortableList items={items} onReorder={() => {}} renderItem={(it) => <div>row-{it.id}</div>} />);
  expect(screen.getByText('row-a')).toBeInTheDocument();
  expect(screen.getByText('row-b')).toBeInTheDocument();
  expect(screen.getByText('row-c')).toBeInTheDocument();
});

test('renders items when disabled (no drag wiring)', () => {
  render(<SortableList items={items} disabled onReorder={() => {}} renderItem={(it) => <div>row-{it.id}</div>} />);
  expect(screen.getByText('row-a')).toBeInTheDocument();
  expect(screen.getByText('row-c')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/common/SortableList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SortableList`**

Create `packages/web/src/components/common/SortableList.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors,
  closestCenter, type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { reorderIds } from '../../lib/reorder';

interface SortableListProps<T extends { id: string }> {
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  renderItem: (item: T, opts: { dragging: boolean }) => ReactNode;
  renderOverlay?: (item: T) => ReactNode;
  disabled?: boolean;
}

function SortableRow({ id, children }: { id: string; children: (dragging: boolean) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, position: 'relative' }}
      {...attributes}
      {...listeners}
    >
      <div style={{ opacity: isDragging ? 0 : 1 }}>{children(isDragging)}</div>
      {isDragging && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 8, pointerEvents: 'none',
          border: '1.5px dashed color-mix(in srgb, var(--color-accent) 55%, transparent)',
          background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
        }} />
      )}
    </div>
  );
}

export function SortableList<T extends { id: string }>({ items, onReorder, renderItem, renderOverlay, disabled }: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (disabled) return <>{items.map((it) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}</>;

  const activeItem = activeId ? items.find((i) => i.id === activeId) ?? null : null;

  function onDragStart(e: DragStartEvent) { setActiveId(String(e.active.id)); }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const next = reorderIds(items.map((i) => i.id), String(e.active.id), e.over ? String(e.over.id) : null);
    const cur = items.map((i) => i.id);
    if (next.some((id, i) => id !== cur[i])) onReorder(next);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]}
      onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((it) => (
          <SortableRow key={it.id} id={it.id}>{(dragging) => renderItem(it, { dragging })}</SortableRow>
        ))}
      </SortableContext>
      <DragOverlay>
        {activeItem ? (
          <div className="dispatch-wiggle" style={{ transform: 'scale(1.03)', boxShadow: '0 14px 34px -10px rgba(0,0,0,.65)', borderRadius: 8, cursor: 'grabbing' }}>
            {(renderOverlay ?? ((it: T) => renderItem(it, { dragging: true })))(activeItem)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
```

- [ ] **Step 4: Run smoke test (pass) + typecheck**

Run: `pnpm --filter dispatch-web exec vitest run src/components/common/SortableList.test.tsx && pnpm --filter dispatch-web exec tsc --noEmit`
Expected: PASS (2 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/common/SortableList.tsx packages/web/src/components/common/SortableList.test.tsx
git commit -m "feat(web): SortableList (dnd-kit) — lift+wiggle overlay, dashed gap placeholder, press-hold"
```

---

### Task 3: Integrate into projects + threads (remove native drag)

**Files:**
- Modify: `packages/web/src/components/sidebar/ProjectSidebar.tsx` (projects → SortableList; remove native drag)
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (threads → SortableList)

**Interfaces:**
- Consumes: `SortableList` (Task 2); `useTabs.reorder` (Task 1); `useIsMobile` (`../../hooks/useIsMobile`); existing `useProjects.reorder`.

- [ ] **Step 1: Projects — replace native drag with SortableList**

In `packages/web/src/components/sidebar/ProjectSidebar.tsx`:
- Add imports: `import { SortableList } from '../common/SortableList';` and `import { useIsMobile } from '../../hooks/useIsMobile';`.
- Add `const isMobile = useIsMobile();` inside the component.
- DELETE the `const [dragId, setDragId] = useState<string | null>(null);` and `const [overId, setOverId] = useState<string | null>(null);` lines, and DELETE the entire `function onDrop(targetId) { … }`.
- REPLACE the `filtered.map((s) => ( <div key draggable … >…</div> ))` block (the whole `<div>` wrapper with the drag handlers + `borderTop`/`opacity` styles) with:

```tsx
      <SortableList
        items={filtered}
        disabled={!!query || isMobile}
        onReorder={(orderedIds) => { if (sort !== 'custom') setSort('custom'); useProjects.getState().reorder(orderedIds); }}
        renderItem={(s) => (
          <ProjectCard session={s} active={s.id === activeId} open={expanded.has(s.id)} onToggle={() => toggleExpand(s.id)} onSelectTab={onSelectTab} onSelectAgent={onSelectAgent} onNewAgent={onNewAgent} />
        )}
      />
```

(`canDrag` is now unused — remove the `const canDrag = !query;` line.) Keep the `{!filtered.length && …}` empty-state line directly after the `SortableList`.

- [ ] **Step 2: Verify projects compile + native drag gone**

Run: `cd /Users/davidwebber/Sites/dispatch && grep -n "draggable\|onDragOver\|dragId\|overId" packages/web/src/components/sidebar/ProjectSidebar.tsx` → no matches.
Run: `pnpm --filter dispatch-web exec tsc --noEmit` → clean.

- [ ] **Step 3: Threads — wrap the thread list in SortableList**

In `packages/web/src/components/sidebar/ProjectCard.tsx`, add `import { SortableList } from '../common/SortableList';` (top with the other imports). The main card component already has `const isMobile = useIsMobile();` (line ~293) and `const tabs = useTabs((s) => s.byProject[session.id]) ?? [];`.

Find the threads render block (the `projTab === 'threads'` branch) whose inner content is `{threadItems.map((t) => ( <SwipeRow …><ThreadRow …/></SwipeRow> ))}`. Replace the `{threadItems.map(...)}` expression (NOT the surrounding flex `<div>` or the `{!threadItems.length && …}` line) with a `SortableList`:

```tsx
              <SortableList
                items={threadItems}
                disabled={isMobile}
                onReorder={(orderedIds) => void useTabs.getState().reorder(session.id, orderedIds)}
                renderItem={(t) => (
                  <SwipeRow key={t.id} disabled={!isMobile}
                    actionLabel={t.type === 'file' ? 'Unpin' : 'Delete'}
                    actionColor={t.type === 'file' ? '#3F3F46' : 'var(--color-status-red)'}
                    onAction={() => { if (t.type === 'file') void archive(t); else setPendingDelete({ kind: 'thread', thread: t }); }}>
                    <ThreadRow tab={t} active={t.id === highlightId} fadeKey={fadeActiveKey}
                      onClick={(e) => { e.stopPropagation(); onSelectTab(t.id); }}
                      onMiddle={() => useTabs.getState().openTab(t.id, true)}
                      onArchive={() => setArchiveTarget(t)}
                      onContext={(x, y) => setCtxMenu({ tab: t, x, y })} />
                  </SwipeRow>
                )}
              />
```

(`threadItems` must be an array of objects with an `id` field — `Terminal` has `id`, so it satisfies `SortableList`'s `{ id: string }` constraint. The `key` on `SwipeRow` is harmless; `SortableList` keys its own rows.)

- [ ] **Step 4: Typecheck + build + run the new tests**

Run: `pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web build && pnpm --filter dispatch-web exec vitest run src/lib/reorder.test.ts src/stores/tabs.reorder.test.ts src/components/common/SortableList.test.tsx`
Expected: tsc clean; build clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sidebar/ProjectSidebar.tsx packages/web/src/components/sidebar/ProjectCard.tsx
git commit -m "feat(web): drag-reorder projects + threads via SortableList; drop native HTML5 drag"
```

---

## Self-Review

**1. Spec coverage:** dnd-kit dep + shared SortableList (T2) used by projects (T3) + threads (T3); lift+wiggle overlay + dashed gap placeholder (T2); press-hold activation (T2); persistence projects=`reorder`/threads=`useTabs.reorder` (T1+T3); pure helper + store action tested (T1); native drag removed (T3); desktop-only via `disabled={isMobile}` (T3). ✅
**2. Placeholder scan:** every step has complete code + exact commands; the two replaced blocks are quoted from the current files. ✅
**3. Type consistency:** `reorderIds(ids, activeId, overId|null)` used in T2's `onDragEnd`; `useTabs.reorder(projectId, orderedIds)` signature consistent T1↔T3; `SortableList` generic `{id:string}` satisfied by sessions + terminals; `.dispatch-wiggle` defined T1, used T2. ✅

## Manual verification (after merge — drag feel isn't unit-testable)

On desktop: press-and-hold a project → it lifts + wiggles, others open a dashed gap, drop reorders and persists (survives refresh). Repeat within a project's thread list. Confirm a plain click still selects (no accidental drag) and that searching disables project drag.
