# Runtime verification — typewriter label animation

**Date:** 2026-07-19
**Branch:** `worktree-typewriter-label-v2`
**Result:** PASS (3/3 behavioural checks)

## Setup

Isolated daemon, never pointed at the real `~/.dispatch`:

```
HOME=/tmp/tw-home PORT=3999 \
  DISPATCH_WEB_DIST=<worktree>/packages/web/dist \
  node <worktree>/packages/core/dist/server.js
```

`DISPATCH_WEB_DIST` is **required** when verifying from a worktree. Without it the
first run resolved to `/Users/davidwebber/Sites/dispatch/packages/web/dist` — the
main checkout's stale bundle (19:37 vs the worktree's 20:01) — and the thread row
rendered a plain `<span>` with no `ThreadLabel`, which looked exactly like a real
integration failure. Confirm the daemon's `Serving web client from …` line points
into the worktree before trusting any observation.

Fixture: one project, one thread seeded to the pre-naming state
(`label = 'Claude Code'`, `label_source = 'default'`). Confirmed `labelSource`
arrives on the wire from a live daemon — `{"label":"Claude Code","labelSource":"default"}`
— which is the premise the whole client-side design rests on.

The rename was applied with the auto-namer's own SQL (`terminals.ts:155`) and
published through a genuine `session:tabs-changed` broadcast (triggered by
creating a second thread), so the client took its normal
`loadTabs` → `detectAutoNames` → `ThreadLabel` path. No test-only code was added
to the app.

Measurement: the label's `textContent` and the presence of `.dispatch-caret`
sampled every 20ms in the browser, then collapsed to distinct states. Screenshots
were not used — an ~860ms animation is not reliably observable that way.

## Check 1 — the animation fires live: PASS

300 samples, 27 distinct states:

```
t=5102  "Claude Code"    caret ON     <- caret appears, text still the OLD label
t=5142  "Claude Cod"     caret ON
  … one character per ~25ms …
t=5401  ""               caret ON     <- fully backspaced (299ms ≈ 11 × 25ms)
t=5442  "F"              caret ON
  … one character per ~35ms …
t=5922  "Fix login bug"  caret ON     <- fully typed (480ms ≈ 13 × 35ms)
t=5961  "Fix login bug"  caret OFF    <- caret retires
```

Two things this proves beyond "something animated":

1. **No pre-paint flash.** The first state carrying the caret still reads
   `"Claude Code"`. `"Fix login bug"` never appears before the backspace. This is
   the direct refutation of the Critical review finding — with the original
   `useEffect` version, the sample preceding the caret would have shown the final
   label, because the effect ran after the browser painted.
2. **The observed rates match the constants.** 11 deletions in 299ms and 13
   insertions in 480ms line up with `DELETE_MS = 25` / `TYPE_MS = 35`.

## Check 2 — a reload does NOT replay: PASS

Hard reload with the same thread in view; 150 samples over 3s yielded **exactly one
distinct state**: `"Fix login bug"`, `caret: false`, never any caret.

This is the "only if I'm looking" guarantee. It holds because `persist()` omits
`byProject`, so after a reload there is no previous list to diff and
`detectAutoNames` returns early.

## Check 3 — a user rename does NOT animate: PASS

Applied the user-rename SQL (`terminals.ts:150`, `label_source = 'user'`) and
broadcast. 300 samples, two distinct states:

```
t=21    "Fix login bug"  caret OFF
t=4462  "My own name"    caret OFF
```

Instant swap, no intermediate character states, no caret — only `default → auto`
animates.

## Re-verification after the final-review fix (port 3998, fresh daemon)

The final whole-branch review found that the epoch guard added mid-branch had broken
`loadTabs`'s promise contract: a superseded call resolved having applied nothing, so
`hydrate()` filtered the restored tab list against an empty `byProject` and persisted
an **empty** `openTabIds` to localStorage — losing the user's open tabs on boot,
permanently. Fixed by having a superseded call await the winning in-flight promise
instead of returning early.

Because that restructured `loadTabs`, all runtime checks were re-run against a
rebuilt bundle on a clean daemon:

- **Animation still fires:** 27 distinct states, first caret-bearing state still reads
  `"Claude Code"`, `sawFinalBeforeAnimating: false`. Backspace → type → caret retires,
  identical shape to the original run.
- **C1 regression is gone:** opened a thread (localStorage `dispatch:tabs` →
  `openTabIds: ["401c617c…"]`, `activeTabId` set, `tabSession` mapping present), then
  reloaded. After boot: `openTabIds` still holds the tab, `activeTabId` restored,
  `tabSession` intact. Before the fix this reload produced `openTabIds: []`.
- **Reload still does not replay:** label read `"Fix login bug"` with no caret.

Note the localStorage key is `dispatch:tabs` (colon), not `dispatch.tabs`.

## Not covered here

React StrictMode's double-invoke is development-only, so this production-bundle run
cannot exercise it. That path is covered by the unit test that renders
`ThreadLabel` inside `<React.StrictMode>` and asserts the sequence still plays.

## Suites at time of verification

- web: 549 passed (87 files)
- core: 918 passed (103 files) — unchanged, no core edits in this branch
- `tsc -b`: clean; `vite build`: clean
