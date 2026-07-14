# Ctrl+Tab Tab Cycling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+Tab / Ctrl+Shift+Tab cycle forward/backward through open main-window tabs, wrapping.

**Architecture:** One new hook (`useTabCycleShortcut`) registers a capture-phase window keydown listener and drives the existing `useTabs.setActiveTab()` action over `openTabIds`. Called once at the top of `App`.

**Tech Stack:** React + zustand, vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-14-ctrl-tab-cycle-design.md`

## Global Constraints

- Ctrl+Tab only — no fallback binding (user decision).
- Run web tests from `packages/web`: `npx vitest run <path>`.
- Working branch: `feat/ctrl-tab-cycle` (worktree `.claude/worktrees/ctrl-tab-cycle`).

---

### Task 1: useTabCycleShortcut hook

**Files:**
- Create: `packages/web/src/hooks/useTabCycleShortcut.ts`
- Test: `packages/web/src/hooks/useTabCycleShortcut.test.tsx`

**Interfaces:**
- Consumes: `useTabs` store (`openTabIds`, `activeTabId`, `setActiveTab`).
- Produces: `useTabCycleShortcut(): void` — Task 2 calls it in `App`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/hooks/useTabCycleShortcut.test.tsx`:

```tsx
import { renderHook } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { useTabCycleShortcut } from './useTabCycleShortcut';
import { useTabs } from '../stores/tabs';

const press = (init: KeyboardEventInit) => {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, ...init });
  window.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  useTabs.setState({ openTabIds: ['a', 'b', 'c'], activeTabId: 'a' });
});

test('Ctrl+Tab advances to the next tab and prevents default', () => {
  renderHook(() => useTabCycleShortcut());
  const ev = press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('b');
  expect(ev.defaultPrevented).toBe(true);
});

test('Ctrl+Tab wraps from the last tab to the first', () => {
  useTabs.setState({ activeTabId: 'c' });
  renderHook(() => useTabCycleShortcut());
  press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});

test('Ctrl+Shift+Tab goes backward and wraps', () => {
  renderHook(() => useTabCycleShortcut());
  press({ ctrlKey: true, shiftKey: true });
  expect(useTabs.getState().activeTabId).toBe('c');
});

test('plain Tab and meta/alt combos are ignored', () => {
  renderHook(() => useTabCycleShortcut());
  press({});
  press({ ctrlKey: true, metaKey: true });
  press({ ctrlKey: true, altKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});

test('single tab: no change, default not prevented', () => {
  useTabs.setState({ openTabIds: ['a'], activeTabId: 'a' });
  renderHook(() => useTabCycleShortcut());
  const ev = press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
  expect(ev.defaultPrevented).toBe(false);
});

test('stale activeTabId recovers to the first tab', () => {
  useTabs.setState({ activeTabId: 'gone' });
  renderHook(() => useTabCycleShortcut());
  press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});

test('listener is removed on unmount', () => {
  const { unmount } = renderHook(() => useTabCycleShortcut());
  unmount();
  press({ ctrlKey: true });
  expect(useTabs.getState().activeTabId).toBe('a');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/web && npx vitest run src/hooks/useTabCycleShortcut.test.tsx`
Expected: FAIL — cannot resolve `./useTabCycleShortcut`.

- [ ] **Step 3: Write the hook**

Create `packages/web/src/hooks/useTabCycleShortcut.ts`:

```ts
import { useEffect } from 'react';
import { useTabs } from '../stores/tabs';

/* Ctrl+Tab / Ctrl+Shift+Tab cycles through open tabs (wrapping). Capture phase so
   it wins even when focus is inside an xterm terminal or a text input — safe to
   hijack because Ctrl+Tab never types a character. Note: a regular browser tab
   reserves Ctrl+Tab for its own tab switching; this fires where the page actually
   receives the key (installed/standalone PWA window). */
export function useTabCycleShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return;
      const { openTabIds, activeTabId, setActiveTab } = useTabs.getState();
      if (openTabIds.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = openTabIds.indexOf(activeTabId ?? '');
      // cur === -1 (stale/no active tab): +1 lands on index 0, -1 on the last.
      const next = (cur + (e.shiftKey ? -1 : 1) + openTabIds.length) % openTabIds.length;
      setActiveTab(openTabIds[next]);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/hooks/useTabCycleShortcut.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useTabCycleShortcut.ts packages/web/src/hooks/useTabCycleShortcut.test.tsx
git commit -m "feat(web): useTabCycleShortcut — Ctrl+Tab / Ctrl+Shift+Tab cycle open tabs"
```

---

### Task 2: Mount in App + full verification

**Files:**
- Modify: `packages/web/src/App.tsx` (import + one call at the top of `App()`)

- [ ] **Step 1: Mount the hook**

In `packages/web/src/App.tsx`, add the import next to the other hook imports:

```tsx
import { useTabCycleShortcut } from './hooks/useTabCycleShortcut';
```

Inside `App()` (line ~44), immediately after the existing top-level hooks (e.g. after `const isMobile = useIsMobile();`), add:

```tsx
  useTabCycleShortcut(); // Ctrl+Tab / Ctrl+Shift+Tab cycle open tabs
```

- [ ] **Step 2: Full web suite + typecheck + build**

Run: `cd packages/web && npx vitest run && npx tsc --noEmit && pnpm build`
Expected: all PASS, no type errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/App.tsx
git commit -m "feat(web): mount Ctrl+Tab tab cycling in App"
```

---

### Task 3: Runtime verification

- [ ] **Step 1:** `pnpm build` (worktree root, builds core too), launch isolated daemon from the worktree (fake HOME, PORT=3998 to avoid clashing with anything), open in Playwright.
- [ ] **Step 2:** Ensure ≥2 tabs are open (open the shell thread and a Control Plane tab). Press Control+Tab via Playwright (CDP-synthesized keys bypass browser-reserved shortcuts and reach the page) → active tab advances; Control+Shift+Tab → goes back. Verify wrap by cycling past the end.
- [ ] **Step 3:** Focus the terminal (click inside the xterm pane), press Control+Tab → still switches (capture phase beats xterm).
