# Ctrl+Tab tab cycling — design

**Date:** 2026-07-14
**Status:** Approved (Ctrl+Tab only — no fallback binding — chosen via inline review)

## Goal

Ctrl+Tab activates the next open tab in the main-window tab bar; Ctrl+Shift+Tab the
previous one. Cycling wraps at both ends.

## Design

New hook `packages/web/src/hooks/useTabCycleShortcut.ts` — the app's first global
keyboard shortcut (the ⌘N/⌘P/⌘K footer hints in `EmptyWorkspace.tsx` have no
handlers today):

- `window.addEventListener('keydown', handler, { capture: true })` on mount,
  removed on unmount. Capture phase so it wins even when focus sits inside an
  xterm terminal or a text input — hijacking is safe here because Ctrl+Tab never
  types a character.
- Match: `e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey`. On match:
  `preventDefault()` + `stopPropagation()`, then advance `activeTabId` within
  `useTabs.getState().openTabIds` by +1 (`shiftKey` → −1), wrapping with modular
  arithmetic, via the existing `setActiveTab()` action (which also opens/persists).
- Fewer than two open tabs, or active tab not found → recompute from index 0 so a
  stale/missing `activeTabId` still lands on a real tab; with zero tabs do nothing.
- Cycle order is `openTabIds` (the order the classic tab strip renders). The
  Dispatch/Control-Plane virtual tab is included — it is an open tab.
- Called once at the top of `App` (hooks can't sit behind the mobile early-return);
  effectively desktop-only since phones send no Ctrl+Tab.

## Known limitation (accepted)

In a regular Chrome/Safari browser tab, Ctrl+Tab is reserved by the browser and
never reaches the page; the shortcut works where the page receives the key
(installed/standalone PWA window, browsers that don't reserve it). User chose to
ship Ctrl+Tab only, no fallback binding.

## Testing

Hook test with @testing-library: seed `useTabs.setState` with three open tabs;
dispatch `keydown` (`key: 'Tab'`, `ctrlKey: true`) on window → active advances and
wraps; with `shiftKey` → goes backward and wraps the other way; `metaKey`/`altKey`
combos and plain Tab are ignored; single tab → no change and default not prevented.
