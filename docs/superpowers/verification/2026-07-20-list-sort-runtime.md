# Runtime verification — project card sort control

**Date:** 2026-07-20
**Branch:** `worktree-thread-sort`
**Result:** PASS

## Setup

```
HOME=/tmp/sort-home PORT=3996 \
  DISPATCH_WEB_DIST=<worktree>/packages/web/dist \
  node <worktree>/packages/core/dist/server.js
```

`DISPATCH_WEB_DIST` is mandatory when verifying from a worktree — without it the
daemon can resolve the main checkout's stale bundle and the feature appears
missing. Confirm the `Serving web client from …` line points into the worktree
first.

Fixture: project **SortTest** with three shell threads created in the order
`zeta`, `alpha`, `mike`, all with `sortOrder: 0` — the "never drag-reordered"
case, which is what most real projects look like. A second project
**OneThread** with a single thread covers the visibility rule.

Measurement was done by reading the DOM (`getBoundingClientRect`, element
parentage, `data-thread-id` order) rather than by screenshot, so the assertions
are exact rather than eyeballed.

## Desktop (1440×900)

| Check | Result |
|---|---|
| Sort button present beside `+` | PASS — `sortIsLeftOfPlus: true` |
| Matches the `+` footprint | PASS — both exactly 16×16 |
| All 6 thread options, Custom marked | PASS — `Needs you first, Recently active, Newest, Oldest, Name (A–Z), Custom ·` |
| **Menu escapes the card's clipping** | PASS — `panelParentIsBody: true`, `panelInsideClippingAncestor: false` |
| Menu fully on screen | PASS |
| Default order (Custom) | PASS — `zeta, alpha, mike` = creation order, matching the daemon's `ORDER BY sort_order ASC, created_at ASC` |
| Choosing "Name (A–Z)" reorders | PASS — `alpha, mike, zeta` |
| Menu closes on selection | PASS |
| Preference persisted | PASS — `dispatch:listSort` → `{"threads":{"<projectId>":"name"},"agents":{}}` |
| Survives reload | PASS — order and stored value both intact |

The clipping check is the one that mattered most: the card animates with
`grid-template-rows: 0fr` + `overflow: hidden`, so a panel rendered inside it
would be invisible in a browser while passing every jsdom test. Walking the
panel's ancestor chain for `overflow: hidden` proves the portal works.

## Mobile (390×844)

| Check | Result |
|---|---|
| Reached via the mobile project list | The card is not mounted on the mobile home screen; tapping the project opens `/p/<id>` |
| Sort button present beside `+` | PASS — `sortLeftOfPlus: true` |
| Matches the `+` at mobile size | PASS — both exactly 34×34 |
| Menu fits a 390px viewport | PASS — panel spans 134–334px, `fullyOnScreen: true`, at the wider 200px mobile menu width |
| Selection carried over from desktop | PASS — "Name (A–Z)" marked `·`, rows in `alpha, mike, zeta` |

## Visibility rule

With both projects expanded on desktop: **2 add-thread buttons, 1 sort button.**
The 3-thread project shows its control; the 1-thread project hides it. This also
demonstrates per-project independence — the preference set on SortTest did not
leak to OneThread.

## Not covered here

- **Drag-and-drop was not driven through real pointer events.** dnd-kit uses a
  180ms press-delay sensor that is unreliable to simulate. The drag path is
  covered by unit tests that drive `useTabs.reorder()` and assert the resulting
  DOM order — including the regression test for the Critical review finding
  below, which was confirmed to fail before the fix.
- **The Automations tab** was verified only at the unit level (option set,
  defaults, absence of `Custom`/`Needs you first`); no live schedules were
  created on the isolated daemon.

## Review findings fixed before this run

1. **Critical — `custom` sorted by the stale `sortOrder` field.**
   `useTabs.reorder()` reorders the array optimistically but never rewrites
   `sortOrder` on the objects, so the comparator re-derived the pre-drag order
   and a dropped row snapped back until the next server refetch. Fixed by making
   `custom` preserve the incoming array order — the daemon already sorts, and the
   optimistic path already maintains position.
2. **Important — a failed reorder stranded the sort mode on `custom`.** The mode
   flipped before the request, and nothing rolled it back on rejection, silently
   discarding e.g. a "Name (A–Z)" preference. `useTabs.reorder` now returns
   `Promise<boolean>` and the card restores the previous mode on failure.

## Suites at time of verification

- web: 634 passed (96 files)
- `tsc -b`: clean; `vite build`: clean
- `packages/core`: untouched by this branch
