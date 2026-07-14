# Tab Activity Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Main-window tab chips show the same activity signals as sidebar thread rows — spinner while working/loading, yellow pulsing dot for needs_input, red for error.

**Architecture:** One new component file exports `TabActivityIndicator` (per-tab) and `GroupActivityIndicator` (rollup across a group's members). Both map store state through the existing `projectIndicator()` helper (`lib/status.ts`, precedence needs_input > working > error > idle) so tabs and sidebar can never disagree. Three insertion points in `GroupedTabBar.tsx`.

**Tech Stack:** React + zustand (`useTabs`), vitest + @testing-library/react (jsdom), existing `Spinner`/`StatusDot` components.

**Spec:** `docs/superpowers/specs/2026-07-14-tab-activity-indicator-design.md`

## Global Constraints

- Out of scope: `DispatchChip` (virtual tab, no terminal in `byProject`), drag ghosts, mobile pinned views.
- Run web tests from `packages/web`: `npx vitest run <path>` (root-cwd runs lack the jsdom config).
- Working branch: `feat/tab-activity-indicator`.

---

### Task 1: TabActivityIndicator component

**Files:**
- Create: `packages/web/src/components/panes/TabActivityIndicator.tsx`
- Test: `packages/web/src/components/panes/TabActivityIndicator.test.tsx`

**Interfaces:**
- Consumes: `useTabs`/`findTerminal` from `stores/tabs`, `projectIndicator` from `lib/status`, `Spinner` (aria-label `loading`), `StatusDot` (aria-label `status-<state>`).
- Produces: `TabActivityIndicator({ tabId: string })` and `GroupActivityIndicator({ tabIds: string[] })` — render Spinner / StatusDot / null. Task 2 imports both.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/components/panes/TabActivityIndicator.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { TabActivityIndicator, GroupActivityIndicator } from './TabActivityIndicator';
import { useTabs } from '../../stores/tabs';
import type { Terminal } from '../../api/types';

const term = (over: Partial<Terminal>): Terminal => ({
  id: 't1', sessionId: 'p1', type: 'claude-code', label: 't', pid: null, externalId: null,
  workingDir: null, status: 'waiting', createdAt: '', config: {}, archivedAt: null, sortOrder: 0, ...over,
});

beforeEach(() => {
  useTabs.setState({
    byProject: { p1: [term({ id: 'w', status: 'working' }), term({ id: 'n', status: 'needs_input' }), term({ id: 'e', status: 'error' }), term({ id: 'i', status: 'waiting' })] },
    loading: {},
  });
});

test('spinner while the thread is working', () => {
  render(<TabActivityIndicator tabId="w" />);
  expect(screen.getByLabelText('loading')).toBeInTheDocument();
});

test('spinner while the tab content is still loading (transient flag)', () => {
  useTabs.setState({ loading: { i: true } });
  render(<TabActivityIndicator tabId="i" />);
  expect(screen.getByLabelText('loading')).toBeInTheDocument();
});

test('yellow dot when the thread needs input', () => {
  render(<TabActivityIndicator tabId="n" />);
  expect(screen.getByLabelText('status-needs_input')).toBeInTheDocument();
});

test('red dot on error', () => {
  render(<TabActivityIndicator tabId="e" />);
  expect(screen.getByLabelText('status-error')).toBeInTheDocument();
});

test('nothing when idle', () => {
  const { container } = render(<TabActivityIndicator tabId="i" />);
  expect(container).toBeEmptyDOMElement();
});

test('nothing for a tab with no terminal (file / virtual tabs)', () => {
  const { container } = render(<TabActivityIndicator tabId="dispatch:p1" />);
  expect(container).toBeEmptyDOMElement();
});

test('group rollup: any working member -> spinner', () => {
  render(<GroupActivityIndicator tabIds={['i', 'w']} />);
  expect(screen.getByLabelText('loading')).toBeInTheDocument();
});

test('group rollup: needs_input outranks working', () => {
  render(<GroupActivityIndicator tabIds={['w', 'n']} />);
  expect(screen.getByLabelText('status-needs_input')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/web && npx vitest run src/components/panes/TabActivityIndicator.test.tsx`
Expected: FAIL — cannot resolve `./TabActivityIndicator`.

- [ ] **Step 3: Write the component**

Create `packages/web/src/components/panes/TabActivityIndicator.tsx`:

```tsx
import { useTabs, findTerminal } from '../../stores/tabs';
import { projectIndicator } from '../../lib/status';
import { Spinner } from '../common/Spinner';
import { StatusDot } from '../common/StatusDot';

/* Leading (favicon-style) activity glyph for a tab chip — mirrors the sidebar
   row's signals through the same projectIndicator rollup (needs_input > working
   > error > idle) so the two surfaces can never disagree. Renders nothing for
   idle tabs and for tabs with no backing terminal (files, virtual tabs). */

export function TabActivityIndicator({ tabId }: { tabId: string }) {
  const status = useTabs((s) => findTerminal(s.byProject, tabId)?.status);
  const loading = useTabs((s) => !!s.loading[tabId]);
  if (status === undefined && !loading) return null;
  return glyph(projectIndicator(undefined, status ? [status] : [], loading));
}

/** Group-chip variant: one glyph rolled up across the group's member tabs. */
export function GroupActivityIndicator({ tabIds }: { tabIds: string[] }) {
  const byProject = useTabs((s) => s.byProject);
  const loadingMap = useTabs((s) => s.loading);
  const statuses = tabIds.map((id) => findTerminal(byProject, id)?.status ?? '');
  return glyph(projectIndicator(undefined, statuses, tabIds.some((id) => !!loadingMap[id])));
}

function glyph(ind: ReturnType<typeof projectIndicator>) {
  if (ind === 'working') return <Spinner size={10} />;
  if (ind === 'needs_input' || ind === 'error') return <StatusDot state={ind} size={7} />;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/panes/TabActivityIndicator.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/panes/TabActivityIndicator.tsx packages/web/src/components/panes/TabActivityIndicator.test.tsx
git commit -m "feat(web): TabActivityIndicator — sidebar activity signals for tab chips"
```

---

### Task 2: Wire into the tab bar chips

**Files:**
- Modify: `packages/web/src/components/panes/GroupedTabBar.tsx` (three spots + import)

**Interfaces:**
- Consumes: `TabActivityIndicator`, `GroupActivityIndicator` from Task 1.
- Produces: user-visible indicators; no new exports.

- [ ] **Step 1: Add the import**

At the top of `GroupedTabBar.tsx`, next to the other local imports:

```tsx
import { TabActivityIndicator, GroupActivityIndicator } from './TabActivityIndicator';
```

- [ ] **Step 2: ClassicTabBar rows** — inside the `openTabIds.map`, directly before the label column `<div style={{ display: 'flex', flexDirection: 'column', ... }}>` (after the `{dispatch && <Network …/>}` line), add:

```tsx
            {!dispatch && <TabActivityIndicator tabId={id} />}
```

- [ ] **Step 3: SingleChip** — in the non-dragging return, directly before the label column `<div style={{ display: 'flex', flexDirection: 'column', ... }}>` (after `{isOver && <MergeOverlay label="Merge" />}`), add:

```tsx
      <TabActivityIndicator tabId={slot.tabId} />
```

- [ ] **Step 4: GroupChip** — directly after the `<SquaresFour …/>` stack icon, add:

```tsx
      <GroupActivityIndicator tabIds={slot.tabIds} />
```

- [ ] **Step 5: Full web suite + build**

Run: `cd packages/web && npx vitest run && npx tsc --noEmit && pnpm build`
Expected: all tests PASS, no type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/panes/GroupedTabBar.tsx
git commit -m "feat(web): show thread activity (spinner / needs-input / error) on main-window tabs"
```

---

### Task 3: Runtime verification

- [ ] **Step 1:** Rebuild web, relaunch the isolated daemon (`.claude/skills/verify/SKILL.md` recipe: fake HOME, PORT=3999), open in Playwright.
- [ ] **Step 2:** Open the shell thread as a tab; drive activity (run a command via the terminal ws) and observe the spinner appear on the tab within ~1s and disappear a few seconds after output stops. POST a `Notification` hook event → yellow dot on the tab; `Stop` → cleared.
- [ ] **Step 3:** Confirm an idle tab shows no leading glyph (no layout shift beyond the glyph itself).
