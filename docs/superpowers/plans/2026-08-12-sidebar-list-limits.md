# Sidebar List Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent settings — max threads shown and max files shown per project in the sidebar (default 10 each) — with a per-section "Show N more" expander so nothing becomes unreachable.

**Architecture:** Purely client-side. Two new persisted fields in the existing `useSettings` Zustand store (localStorage, same pattern as every other setting), truncation applied in `ProjectCard.tsx` where the THREADS and FILES lists render, and two `Stepper` rows added to the SIDEBAR block of the General settings section. No daemon/server changes.

**Tech Stack:** React 18 + TypeScript, Zustand, vitest + @testing-library/react (jsdom), inline-style design system already used by the settings and sidebar components.

## Global Constraints

- Branch: `feat/sidebar-list-limits`, cut from **updated** `main` (`git fetch origin && git checkout -b feat/sidebar-list-limits origin/main`).
- Defaults: **10** for both limits. Sentinel **0 = "All" (no limit)**. Stepper range **3–50**; one step up past 50 lands on All; one step down from All lands on 50.
- localStorage keys: `dispatch:sidebarMaxThreads`, `dispatch:sidebarMaxFiles` (JSON numbers, via the store's existing `load`/`save` helpers).
- Scope: the limit applies on **desktop and mobile** (same `ProjectCard` component, no `isMobile` branch in the truncation logic). The files limit covers the **FILES section only** — WEB and NOTES are never capped.
- Exact UI copy: expander row `Show {N} more`; settings rows `Threads shown` and `Files shown`; stepper displays the number, or `All` when the limit is 0.
- The active (highlighted) thread/file must never be hidden by the cap: if it falls past the cut, the cap lifts for that section while it stays active.
- A drag-reorder on a truncated thread list must send the **full** id order to the server (visible ids first, hidden tail appended, relative order preserved). `SessionService.reorderTabs` rewrites `sortOrder = index` for exactly the ids it receives — sending only the visible slice would interleave hidden rows unpredictably.
- Run web tests from `packages/web`: `npx vitest run <file>`. Type-check with `npx tsc -b` at the repo root.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Do not merge or open a release; stop when the branch is pushed and the PR is open.

## File Structure

- Modify: `packages/web/src/stores/settings.ts` — two persisted fields + setters, plus exported pure helpers `stepSidebarLimit` / `formatSidebarLimit` (the step-and-wrap logic lives here so it is unit-testable and shared by desktop/mobile settings).
- Modify: `packages/web/src/stores/settings.test.ts` — defaults, persistence, clamping, step/format behavior.
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` — truncation of the THREADS list and the FILES section, the local `ShowMoreRow` component (local, matching `ThreadRow`/`TabPill` precedent), and the reorder-tail fix.
- Create: `packages/web/src/components/sidebar/ProjectCard.limits.test.tsx` — truncation/expander/reorder tests (harness cloned from `ProjectCard.sort.test.tsx`).
- Modify: `packages/web/src/components/settings/GeneralSection.tsx` — two `Stepper` rows in the SIDEBAR block. (Mobile settings render the same `GeneralSection` via `sections.tsx` — no separate mobile work.)
- Modify: `packages/web/src/components/settings/GeneralSection.test.tsx` — stepper wiring tests.

---

### Task 1: Settings store — limits, step helper, format helper

**Files:**
- Modify: `packages/web/src/stores/settings.ts`
- Test: `packages/web/src/stores/settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `useSettings` state fields `sidebarMaxThreads: number`, `sidebarMaxFiles: number` (0 = All)
  - `setSidebarMaxThreads(n: number): void`, `setSidebarMaxFiles(n: number): void`
  - `export function stepSidebarLimit(current: number, delta: 1 | -1): number`
  - `export function formatSidebarLimit(n: number): string`
  - `export const SIDEBAR_LIMIT_MIN = 3`, `export const SIDEBAR_LIMIT_MAX = 50`

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/src/stores/settings.test.ts` (and extend the import line at the top to `import { useSettings, stepSidebarLimit, formatSidebarLimit } from './settings';`):

```ts
describe('sidebar list limits', () => {
  it('defaults both limits to 10', () => {
    expect(useSettings.getState().sidebarMaxThreads).toBe(10);
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });

  it('setters persist to localStorage under their own keys', () => {
    useSettings.getState().setSidebarMaxThreads(25);
    useSettings.getState().setSidebarMaxFiles(5);
    expect(useSettings.getState().sidebarMaxThreads).toBe(25);
    expect(useSettings.getState().sidebarMaxFiles).toBe(5);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxThreads')!)).toBe(25);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxFiles')!)).toBe(5);
  });

  it('setters clamp to 3–50 but pass 0 (All) through', () => {
    useSettings.getState().setSidebarMaxThreads(1);
    expect(useSettings.getState().sidebarMaxThreads).toBe(3);
    useSettings.getState().setSidebarMaxThreads(999);
    expect(useSettings.getState().sidebarMaxThreads).toBe(50);
    useSettings.getState().setSidebarMaxThreads(0);
    expect(useSettings.getState().sidebarMaxThreads).toBe(0);
  });

  it('stepSidebarLimit walks 3…50 then All, and back down from All', () => {
    expect(stepSidebarLimit(10, 1)).toBe(11);
    expect(stepSidebarLimit(10, -1)).toBe(9);
    expect(stepSidebarLimit(50, 1)).toBe(0);   // past max → All
    expect(stepSidebarLimit(0, 1)).toBe(0);    // All is the ceiling
    expect(stepSidebarLimit(0, -1)).toBe(50);  // down from All → max
    expect(stepSidebarLimit(3, -1)).toBe(3);   // floor
  });

  it('formatSidebarLimit renders 0 as All', () => {
    expect(formatSidebarLimit(0)).toBe('All');
    expect(formatSidebarLimit(10)).toBe('10');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/stores/settings.test.ts`
Expected: FAIL — `stepSidebarLimit` is not exported / `sidebarMaxThreads` is `undefined`.

- [ ] **Step 3: Implement the store changes**

In `packages/web/src/stores/settings.ts`:

Add below the `MobileViewMode` type (module scope, before the interface):

```ts
/**
 * Sidebar list caps (THREADS / FILES sections). 0 is the "All" sentinel — no cap.
 * The stepper walks 3…50, then one more step up lands on All; step logic lives here
 * (not in the component) so both settings shells share it and it is unit-testable.
 */
export const SIDEBAR_LIMIT_MIN = 3;
export const SIDEBAR_LIMIT_MAX = 50;

export function stepSidebarLimit(current: number, delta: 1 | -1): number {
  if (current === 0) return delta === 1 ? 0 : SIDEBAR_LIMIT_MAX;
  const next = current + delta;
  if (next > SIDEBAR_LIMIT_MAX) return 0;
  return Math.max(SIDEBAR_LIMIT_MIN, next);
}

export function formatSidebarLimit(n: number): string {
  return n === 0 ? 'All' : String(n);
}

function clampSidebarLimit(n: number): number {
  if (!Number.isFinite(n) || n === 0) return Number.isFinite(n) ? 0 : 10;
  return Math.max(SIDEBAR_LIMIT_MIN, Math.min(SIDEBAR_LIMIT_MAX, Math.round(n)));
}
```

Add to the `SettingsState` interface (after `projectFontSize: number;`):

```ts
  sidebarMaxThreads: number;  // 0 = All (no cap)
  sidebarMaxFiles: number;    // 0 = All (no cap)
```

and with the other setters:

```ts
  setSidebarMaxThreads: (n: number) => void;
  setSidebarMaxFiles: (n: number) => void;
```

Add to the `create<SettingsState>((set) => ({ ... }))` initializer (after `projectFontSize: load(...)`):

```ts
  sidebarMaxThreads: load('dispatch:sidebarMaxThreads', 10),
  sidebarMaxFiles: load('dispatch:sidebarMaxFiles', 10),
```

and with the other setters (one-line style, matching `setSidebarFontSize`):

```ts
  setSidebarMaxThreads: (n) => { const sidebarMaxThreads = clampSidebarLimit(n); save('dispatch:sidebarMaxThreads', sidebarMaxThreads); set({ sidebarMaxThreads }); },
  setSidebarMaxFiles: (n) => { const sidebarMaxFiles = clampSidebarLimit(n); save('dispatch:sidebarMaxFiles', sidebarMaxFiles); set({ sidebarMaxFiles }); },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/stores/settings.test.ts`
Expected: PASS (all suites in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/stores/settings.ts packages/web/src/stores/settings.test.ts
git commit -m "feat(web): sidebar thread/file list limits in the settings store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ProjectCard — truncate the THREADS list behind a Show-more row

**Files:**
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx`
- Test: `packages/web/src/components/sidebar/ProjectCard.limits.test.tsx` (create)

**Interfaces:**
- Consumes (from Task 1): `useSettings` fields `sidebarMaxThreads` / `sidebarMaxFiles` (0 = All).
- Produces: local component `ShowMoreRow({ count, onClick }: { count: number; onClick: () => void })` — Task 3 reuses it verbatim for the FILES section. Renders a full-width quiet button with the exact text `Show {count} more`.

**Context for the implementer:** `ProjectCard.tsx` renders the THREADS tab via `SortableList` around line 436–466. `threadItems` is the sorted, visible-filtered thread array. `highlightId` (already computed near the top) is the active row's terminal id. `useTabs.getState().reorder(projectId, orderedIds)` optimistically reorders and then calls `api.reorderTerminals`; the server rewrites `sortOrder = index` for exactly the ids it receives — that is why a truncated drop must append the hidden tail. The test harness pattern (mocking `SortableList` to drive the real `onReorder`) is in `ProjectCard.sort.test.tsx`; read it before writing the test file.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/components/sidebar/ProjectCard.limits.test.tsx`:

```tsx
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

// Same stand-in as ProjectCard.sort.test.tsx: real dnd-kit gestures are brittle in jsdom,
// so drive ProjectCard's actual onReorder prop directly. The drop button hands back the
// VISIBLE items reversed — exactly what a real drag over a truncated list produces.
vi.mock('../common/SortableList', () => ({
  SortableList: ({ items, onReorder, renderItem }: any) => (
    <div>
      <button data-testid="simulate-drop-reverse" onClick={() => onReorder(items.map((i: any) => i.id).slice().reverse())}>simulate drop</button>
      {items.map((it: any) => <div key={it.id}>{renderItem(it, { dragging: false })}</div>)}
    </div>
  ),
}));

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

function term(id: string, label: string, type = 'claude-code') {
  return { id, sessionId: SID, type, label, status: 'idle', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0 } as any;
}

// Ids sort naturally: t01…t12. Default thread sort is 'custom' = array order.
const threads = (n: number) => Array.from({ length: n }, (_, i) => term(`t${String(i + 1).padStart(2, '0')}`, `thread ${i + 1}`));

const rowIds = () => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-thread-id')).map((b) => b.getAttribute('data-thread-id'));

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
  useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderCard() {
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
}

test('caps the thread list at the limit and offers the remainder behind Show more', () => {
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(10);
  expect(screen.getByText('Show 2 more')).toBeInTheDocument();
  // The THREADS pill still counts the full list, not the visible slice.
  expect(screen.getByText('12')).toBeInTheDocument();
});

test('clicking Show more reveals the full list and removes the expander', () => {
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {} } as any);
  renderCard();
  fireEvent.click(screen.getByText('Show 2 more'));
  expect(rowIds()).toHaveLength(12);
  expect(screen.queryByText('Show 2 more')).not.toBeInTheDocument();
});

test('no expander when the list fits within the limit', () => {
  useTabs.setState({ byProject: { [SID]: threads(10) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(10);
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('All (0) disables the cap entirely', () => {
  useSettings.setState({ sidebarMaxThreads: 0 });
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('an active thread past the cut lifts the cap instead of being hidden', () => {
  useTabs.setState({ byProject: { [SID]: threads(12) }, loading: {}, activeTabId: 't12' } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
});

test('a drop on the truncated list keeps the hidden tail in the server order', async () => {
  const all = threads(12);
  useTabs.setState({ byProject: { [SID]: all }, loading: {} } as any);
  vi.spyOn(api, 'reorderTerminals').mockResolvedValue(undefined as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue(all as any);
  renderCard();

  fireEvent.click(screen.getByTestId('simulate-drop-reverse'));

  await waitFor(() => expect(api.reorderTerminals).toHaveBeenCalled());
  const sent: string[] = (api.reorderTerminals as any).mock.calls[0][1];
  expect(sent).toHaveLength(12); // full order, not just the visible slice
  expect(sent.slice(0, 10)).toEqual(['t10', 't09', 't08', 't07', 't06', 't05', 't04', 't03', 't02', 't01']);
  expect(sent.slice(10)).toEqual(['t11', 't12']); // hidden tail preserved, in order
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/components/sidebar/ProjectCard.limits.test.tsx`
Expected: FAIL — 12 rows render where 10 are expected, and `Show 2 more` is not found.

- [ ] **Step 3: Implement the truncation**

All edits in `packages/web/src/components/sidebar/ProjectCard.tsx`.

3a. Extend the phosphor import (line 5) with `CaretDown`:

```ts
import { FolderOpen, CaretRight, CaretDown, Network, TerminalWindow, ChatCircle, PushPin, Timer, Bell, Plus } from '@phosphor-icons/react';
```

3b. Inside `ProjectCard()`, next to the existing `pfs` / `density` selectors (~line 250), add:

```ts
  const maxThreads = useSettings((s) => s.sidebarMaxThreads);
  const maxFiles = useSettings((s) => s.sidebarMaxFiles);
  // Per-card, per-session expansion: "Show N more" reveals the rest until the
  // card unmounts. Deliberately not persisted — the cap is the steady state.
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
```

(`maxFiles` / `showAllFiles` are consumed in Task 3; they land here so the state block reads as one unit.)

3c. Directly after the `threadItems` line (~line 274), add:

```ts
  // Cap the list at the configured limit (0 = All). The active thread must never
  // be hidden by the cap — if it falls past the cut, the cap lifts while it's active.
  const activeThreadHidden = maxThreads > 0 && threadItems.findIndex((t) => t.id === highlightId) >= maxThreads;
  const threadsCapped = maxThreads > 0 && !showAllThreads && !activeThreadHidden && threadItems.length > maxThreads;
  const visibleThreads = threadsCapped ? threadItems.slice(0, maxThreads) : threadItems;
```

3d. In the THREADS tab render block (~line 438), change `SortableList`'s `items` prop from `threadItems` to `visibleThreads`, and replace the `onReorder` callback body with:

```ts
                onReorder={(orderedIds) => {
                  // A truncated drag hands back only the visible ids. The server rewrites
                  // sortOrder for exactly the ids it receives, so append the hidden tail
                  // or its rows would interleave unpredictably.
                  const fullOrder = [...orderedIds, ...threadItems.filter((t) => !orderedIds.includes(t.id)).map((t) => t.id)];
                  // The dropped arrangement IS the user's custom order now; persisting it
                  // under any other mode would save an order they'd never see again.
                  const prev = useListSort.getState().threadSort(session.id);
                  useListSort.getState().setThreadSort(session.id, 'custom');
                  void useTabs.getState().reorder(session.id, fullOrder).then((ok) => {
                    // The server rejected the new order and reorder() restored server truth,
                    // so the mode flip no longer corresponds to anything the user can see.
                    if (!ok) useListSort.getState().setThreadSort(session.id, prev);
                  });
                }}
```

3e. Between the `<SortableList …/>` closing and the `{!threadItems.length && …}` empty-state line, add:

```tsx
              {threadsCapped && <ShowMoreRow count={threadItems.length - visibleThreads.length} onClick={() => setShowAllThreads(true)} />}
```

3f. Add the `ShowMoreRow` component at module scope, next to `TabPill` at the bottom of the file:

```tsx
function ShowMoreRow({ count, onClick }: { count: number; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const isMobile = useIsMobile();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 6, width: '100%',
        padding: isMobile ? '12px' : '4px 9px', background: hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none', borderRadius: isMobile ? 0 : 5, textAlign: 'left', cursor: 'pointer',
        color: hover ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
        fontSize: isMobile ? 14 : 11.5,
      }}
    >
      <CaretDown size={isMobile ? 13 : 11} style={{ flexShrink: 0 }} />
      Show {count} more
    </button>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/sidebar/ProjectCard.limits.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the neighboring sidebar suites (truncation must not break them)**

Run: `cd packages/web && npx vitest run src/components/sidebar/`
Expected: PASS — in particular `ProjectCard.sort.test.tsx` (its 2 threads sit under every cap) and `ProjectSidebar.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/sidebar/ProjectCard.tsx packages/web/src/components/sidebar/ProjectCard.limits.test.tsx
git commit -m "feat(web): cap the sidebar THREADS list behind a Show-more row

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: ProjectCard — truncate the FILES section (WEB and NOTES stay full)

**Files:**
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (the `renderSection` helper, ~line 313)
- Test: `packages/web/src/components/sidebar/ProjectCard.limits.test.tsx` (append)

**Interfaces:**
- Consumes (from Task 2): `ShowMoreRow`, `maxFiles`, `showAllFiles` / `setShowAllFiles`, and `highlightId` — all already in scope.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `ProjectCard.limits.test.tsx` (the `files` helper goes next to the `threads` helper at the top):

```tsx
const files = (n: number) => Array.from({ length: n }, (_, i) => term(`f${String(i + 1).padStart(2, '0')}`, `file-${i + 1}.md`, 'file'));

test('caps the FILES section at its own limit with its own expander', () => {
  useTabs.setState({ byProject: { [SID]: [...threads(2), ...files(12)] }, loading: {} } as any);
  renderCard();
  expect(rowIds().filter((id) => id!.startsWith('f'))).toHaveLength(10);
  expect(rowIds().filter((id) => id!.startsWith('t'))).toHaveLength(2); // threads untouched
  expect(screen.getByText('Show 2 more')).toBeInTheDocument();
});

test('expanding FILES reveals every file', () => {
  useTabs.setState({ byProject: { [SID]: files(12) }, loading: {} } as any);
  renderCard();
  fireEvent.click(screen.getByText('Show 2 more'));
  expect(rowIds()).toHaveLength(12);
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('a files limit of All (0) disables the FILES cap', () => {
  useSettings.setState({ sidebarMaxFiles: 0 });
  useTabs.setState({ byProject: { [SID]: files(12) }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
});

test('the thread and file limits are independent', () => {
  useSettings.setState({ sidebarMaxThreads: 3, sidebarMaxFiles: 0 });
  useTabs.setState({ byProject: { [SID]: [...threads(5), ...files(12)] }, loading: {} } as any);
  renderCard();
  expect(rowIds().filter((id) => id!.startsWith('t'))).toHaveLength(3);
  expect(rowIds().filter((id) => id!.startsWith('f'))).toHaveLength(12);
  expect(screen.getByText('Show 2 more')).toBeInTheDocument(); // the thread expander (5 − 3)
});

test('WEB and NOTES sections are never capped', () => {
  const web = Array.from({ length: 12 }, (_, i) => term(`w${String(i + 1).padStart(2, '0')}`, `tab ${i + 1}`, 'browser'));
  useTabs.setState({ byProject: { [SID]: web }, loading: {} } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
  expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
});

test('an active file past the cut lifts the FILES cap', () => {
  useTabs.setState({ byProject: { [SID]: files(12) }, loading: {}, activeTabId: 'f12' } as any);
  renderCard();
  expect(rowIds()).toHaveLength(12);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/components/sidebar/ProjectCard.limits.test.tsx`
Expected: FAIL — the six new tests see 12 file rows where 10 are expected (and Task 2's seven still PASS).

- [ ] **Step 3: Implement the FILES cap in `renderSection`**

In `ProjectCard.tsx`, replace the first three lines of the `renderSection` helper (currently `const items = tabs.filter(...); if (sec.key !== 'threads' && !items.length) return null;`) with:

```ts
  const renderSection = (sec: (typeof SECTIONS)[number]) => {
    const all = tabs.filter((t) => sec.types.includes(t.type) && showRow(t));
    if (sec.key !== 'threads' && !all.length) return null;
    // Only FILES is capped (WEB/NOTES stay full — they're usually short). Same
    // active-row escape hatch as the thread list above.
    const activeFileHidden = maxFiles > 0 && all.findIndex((t) => t.id === highlightId) >= maxFiles;
    const capped = sec.key === 'files' && maxFiles > 0 && !showAllFiles && !activeFileHidden && all.length > maxFiles;
    const items = capped ? all.slice(0, maxFiles) : all;
```

Then, in the same helper: change `SectionHeader`'s `count={items.length}` to `count={all.length}` (the header should count the full list), and after the `{items.map((t) => (…))}` block — before the `{sec.key === 'threads' && !items.length && …}` line — add:

```tsx
        {capped && <ShowMoreRow count={all.length - items.length} onClick={() => setShowAllFiles(true)} />}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/sidebar/ProjectCard.limits.test.tsx`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sidebar/ProjectCard.tsx packages/web/src/components/sidebar/ProjectCard.limits.test.tsx
git commit -m "feat(web): cap the sidebar FILES section behind its own Show-more row

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: General settings — "Threads shown" / "Files shown" steppers

**Files:**
- Modify: `packages/web/src/components/settings/GeneralSection.tsx` (SIDEBAR block, ~line 129–145)
- Test: `packages/web/src/components/settings/GeneralSection.test.tsx` (append)

**Interfaces:**
- Consumes (from Task 1): `sidebarMaxThreads` / `sidebarMaxFiles` fields, `setSidebarMaxThreads` / `setSidebarMaxFiles`, `stepSidebarLimit`, `formatSidebarLimit` from `../../stores/settings`.
- Produces: nothing new. (Mobile inherits automatically: `MobileSettingsSection` renders this same component via `sections.tsx`.)

- [ ] **Step 1: Write the failing tests**

Append to `GeneralSection.test.tsx` (add `within` to the `@testing-library/react` import):

```tsx
// The Stepper renders bare −/+ buttons with no accessible names, so target the row by its
// label text: the row div is the label's parent, and its two buttons are [dec, inc].
function limitRow(label: string) {
  const row = screen.getByText(label).parentElement!;
  const [dec, inc] = within(row).getAllByRole('button');
  return { row, dec, inc };
}

describe('GeneralSection — sidebar list limits', () => {
  beforeEach(() => {
    useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  });

  it('shows both limits at their default of 10', () => {
    render(<GeneralSection />);
    expect(within(limitRow('Threads shown').row).getByText('10')).toBeInTheDocument();
    expect(within(limitRow('Files shown').row).getByText('10')).toBeInTheDocument();
  });

  it('stepping the thread limit up past 50 lands on All and persists 0', () => {
    useSettings.setState({ sidebarMaxThreads: 50 });
    render(<GeneralSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(0);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxThreads')!)).toBe(0);
    expect(within(limitRow('Threads shown').row).getByText('All')).toBeInTheDocument();
  });

  it('stepping the file limit down from All lands on 50', () => {
    useSettings.setState({ sidebarMaxFiles: 0 });
    render(<GeneralSection />);
    fireEvent.click(limitRow('Files shown').dec);
    expect(useSettings.getState().sidebarMaxFiles).toBe(50);
  });

  it('the two limits are independent — stepping threads never touches files', () => {
    render(<GeneralSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(11);
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && npx vitest run src/components/settings/GeneralSection.test.tsx`
Expected: FAIL — `Unable to find an element with the text: Threads shown`.

- [ ] **Step 3: Implement the settings rows**

In `GeneralSection.tsx`:

3a. Extend the settings-store import (line 3):

```ts
import { useSettings, ACCENTS, formatSidebarLimit, stepSidebarLimit, type MobileViewMode } from '../../stores/settings';
```

3b. Add selectors next to the existing ones (~line 67):

```ts
  const sidebarMaxThreads = useSettings((s) => s.sidebarMaxThreads);
  const sidebarMaxFiles = useSettings((s) => s.sidebarMaxFiles);
```

3c. In the SIDEBAR block, insert after the Density row's closing `</div>` (before the block's closing `</div>`):

```tsx
        <div style={row}><span style={item}>Threads shown</span><Stepper value={formatSidebarLimit(sidebarMaxThreads)} onDec={() => useSettings.getState().setSidebarMaxThreads(stepSidebarLimit(sidebarMaxThreads, -1))} onInc={() => useSettings.getState().setSidebarMaxThreads(stepSidebarLimit(sidebarMaxThreads, 1))} /></div>
        <div style={row}><span style={item}>Files shown</span><Stepper value={formatSidebarLimit(sidebarMaxFiles)} onDec={() => useSettings.getState().setSidebarMaxFiles(stepSidebarLimit(sidebarMaxFiles, -1))} onInc={() => useSettings.getState().setSidebarMaxFiles(stepSidebarLimit(sidebarMaxFiles, 1))} /></div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Longer lists collapse behind a “Show more” row. Step past 50 for All.</div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/settings/GeneralSection.test.tsx`
Expected: PASS (8 tests: 4 pre-existing + 4 new).

- [ ] **Step 5: Full verification**

```bash
cd /Users/jdetamore/Developer/Projects/dispatch && npx tsc -b
cd packages/web && npx vitest run
```

Expected: `tsc -b` clean; full web suite green (~850 tests). (The known intermittent nonzero-exit flake lives in the **core** suite, not web — an occasional web-runner hiccup with zero failing tests just gets one re-run.)

- [ ] **Step 6: Commit and push**

```bash
git add packages/web/src/components/settings/GeneralSection.tsx packages/web/src/components/settings/GeneralSection.test.tsx
git commit -m "feat(web): Threads shown / Files shown limits in General settings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin feat/sidebar-list-limits
```

Then open the PR (base `main`, repo `davidwebber10/dispatch`) titled `feat(web): configurable sidebar limits for threads and files`, and **stop — do not merge**. Report the CI status.
