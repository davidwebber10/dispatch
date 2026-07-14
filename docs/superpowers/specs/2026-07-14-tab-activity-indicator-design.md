# Tab activity indicator — design

**Date:** 2026-07-14
**Status:** Approved (full-parity option chosen via inline review)

## Problem

A working thread shows a spinner (and needs_input/error dots) in the sidebar row, but
its tab in the main-window tab bar shows nothing — you can't tell from the tabs which
thread is busy or waiting on you.

## Goal

Every main-window tab chip mirrors the sidebar row's activity signals, in a leading
(favicon-style) slot:

- `Spinner` (accent, ~10px) while `loading[tabId] || status === 'working'`
- `StatusDot state="needs_input"` (yellow pulse, 7px) / `state="error"` (red)
- nothing when idle

## Design

### New component: `packages/web/src/components/panes/TabActivityIndicator.tsx`

- `TabActivityIndicator({ tabId })` — subscribes to `useTabs` (terminal via
  `findTerminal(byProject, tabId)`, transient `loading[tabId]` flag) and maps state
  through the existing `projectIndicator()` helper from `lib/status.ts`
  (precedence: needs_input > working > error > idle), so tabs and sidebar can never
  disagree. Renders Spinner / StatusDot / null. Returns null when the tab has no
  terminal (files, virtual tabs).
- `GroupActivityIndicator({ tabIds })` — same, rolled up across a group's member
  tabs (spinner if any member is working, etc.), mirroring the sidebar project
  header rollup.

### Insertion points (all in `GroupedTabBar.tsx`)

- `ClassicTabBar` rows (multi-pane off) — before the label column
- `SingleChip` — before the label column
- `GroupChip` — next to the stack icon, rolled up via `GroupActivityIndicator`

### Out of scope

- `DispatchChip` — the Dispatch tab is a client-only virtual tab deliberately kept
  out of `byProject` (no terminal/status to read). Wiring the coordinator's status
  into it is a separate feature.
- Drag ghosts / overlays (momentary).
- Mobile pinned-thread views (already show their own indicators).

## Testing

Component tests seeding `useTabs.setState` with a terminal in `byProject`:
spinner when status `working`, spinner when only `loading` set, yellow dot for
`needs_input`, red for `error`, null when idle, null for unknown tab id; group
rollup shows spinner when any member works and needs_input wins over working.

## Deploy note

Web-only change: browser refresh once the daemon serves the new bundle; rides the
next release for remote boxes.
