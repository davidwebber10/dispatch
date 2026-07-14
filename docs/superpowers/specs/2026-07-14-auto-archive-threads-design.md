# Auto-Archive Threads — Design

**Date:** 2026-07-14
**Branch:** `worktree-auto-archive-threads`
**Status:** Approved

## Problem

Threads accumulate. The common case is a throwaway: spin up a thread, ask one
question, get the answer, never touch it again. It then sits in the sidebar
forever. Manually archiving each one is a chore nobody does, so the sidebar
fills with dead threads and the live ones get harder to find.

## Goal

Let a thread be marked, at creation, as an **Auto-Archive Thread** with an
inactivity deadline (default 12 hours). When it goes that long without doing
anything, it archives itself and disappears from the sidebar.

Opt-in only. A thread with no auto-archive policy behaves exactly as today, so
no existing thread changes behavior.

## What already exists

This feature is mostly assembly. The pieces are in place:

- **`terminals.archived_at`** (`db/schema.ts:137`) — the archive flag. Archiving
  is already a soft-delete; the row and its transcript survive.
- **`SessionService.removeTerminal(id)`** (`sessions/service.ts:1123`) — *is* the
  archive operation: kills the PTY / structured process, sets `archived_at`,
  nulls the pid. This is what `DELETE /api/terminals/:id` calls.
- **`terminals.config`** (`db/schema.ts:136`) — an opaque JSON blob already used
  for per-thread policy (`transport`, `queued`, `dependsOn`, `runner`, `role`).
- **`terminals.last_activity_at`** — as of the `last_activity_at` semantics work
  (commits `5040276`..`dda806a`), an honest activity clock: `StatusService.apply`
  stamps it on real lifecycle edges (`status/service.ts:104`) and the
  `TerminalMonitor` stamps it on genuine output bursts
  (`terminal-monitor.ts:143`). Structured threads reach it via the
  `structuredManager` → `StatusService` wiring at `server.ts:105-122`.
- **Periodic-loop precedent** — `sessions/status.ts` exports
  `startPtyTimingLoop()` (returns the interval) plus a pure `ptyStatusTick()`
  for tests; registered in `server.ts:513` and cleared in `cleanup()`.

**Hard dependency:** the `last_activity_at` semantics work above. Without it,
structured threads never stamp the column, `rowToTerminal` falls back to
`created_at` (`db/terminals.ts:62`), and a 12-hour thread would archive 12 hours
after *creation* regardless of use. That work is merged; this design assumes it.

Notably, `StatusService` deliberately does **not** stamp activity on the
`'starting'` edge. That exclusion is load-bearing here: if attaching to a thread
counted as activity, leaving it open in a browser tab (or the daemon reviving it
at boot) would renew its lease forever and nothing would ever be pruned.
"Activity" must mean the thread *thought*, not that someone *looked at it*.

## What does not exist

**There is no archived-threads UI.** `restoreTerminal` exists
(`POST /api/terminals/:id/restore`, `client.ts:86`) but nothing in the sidebar
calls it; the only consumer of `listArchivedTerminals` is the Overseer rail.

This is an accepted, explicit product decision: an auto-archived thread is gone
from the UI. The row survives in SQLite and is restorable via the API, but no
recovery affordance ships with this feature. The countdown badge (below) is the
mitigation — you can see a thread is about to go and act before it does.

## Design

### 1. Data model — no migration

The policy lives in the existing `terminals.config` blob:

```ts
{ autoArchive: true, autoArchiveMs: 43_200_000 }   // 12 hours
```

- Stored in **milliseconds**, so the unit picker is purely presentational. The UI
  renders the largest unit that divides evenly: `43_200_000` → "12 hours",
  `1_800_000` → "30 minutes".
- Absent, or `autoArchive: false` → the thread is permanent. Every pre-existing
  thread is therefore untouched.
- A malformed blob already parses to `{}` (`db/terminals.ts:50`), which reads as
  "not an auto-archive thread". Failing closed is the safe direction.

**Landmine:** `terminalsDb.updateConfig` *replaces* the whole blob
(`db/terminals.ts:148`). Every write must read-merge-write, as
`status/service.ts:90-93` already does. A shared helper avoids re-learning this.

### 2. Core — the sweep

New file `packages/core/src/sessions/auto-archive.ts`, mirroring
`sessions/status.ts`:

- `startAutoArchiveLoop(db, sessionService, broadcaster, intervalMs = 60_000)`
  → returns `NodeJS.Timeout`.
- `autoArchiveTick(db, sessionService, broadcaster)` → one pure pass, exported
  for tests, no timers involved.

Each pass, for every non-archived terminal whose `config.autoArchive` is true:

```
if (status is 'working' | 'queued' | 'scheduled' | 'needs_input')  → skip
if (now - lastActivityAt < autoArchiveMs)                          → skip
otherwise:
    sessionService.removeTerminal(id)
    broadcast { type: 'terminal:removed', terminalId, sessionId }
    broadcast { type: 'session:tabs-changed', sessionId }
```

Registered in `server.ts` beside the other three loops; `clearInterval`'d in
`cleanup()`.

It calls `removeTerminal()` — the same method the DELETE route calls — so
auto-archive and manual archive are literally one operation. There is no second
archive code path that can drift. It also emits the same two frames the DELETE
route emits, which the frontend already handles, so **the sidebar row vanishes
live with no new frontend event handling**.

60-second polling is deliberate. Per-thread `setTimeout`s would be exact but die
on daemon restart (needing boot rehydration) and would have to hook every
activity path. At 12-hour granularity, one-minute precision is free.

#### Skip table

A thread is archived only when **nobody is blocked on it** — not the system, not
the user.

| `status` | Swept? | Rationale |
|---|---|---|
| `working` | No | Mid-turn. A thinking agent can be silent for a long time. |
| `queued` | No | Waiting on a `dependsOn` agent, not on the user. Reaping it strands the dependency chain. |
| `scheduled` | No | Deliberately parked for a future wake. |
| `needs_input` | No | Blocked on the user at a permission prompt. Archiving would kill the process mid-prompt. |
| `waiting` | **Yes** | Idle at the prompt. This is the clutter case. |
| `error` | **Yes** | Dead. Prime clutter. |

### 3. Web — three touch points

**a. Unified New Thread modal** (`NewThreadModal.tsx`, new).

Today `NewTabMenu.tsx` is a four-item dropdown where only two items open a modal:
Claude Code (PTY) and Codex open one; Claude (structured) and Terminal create
instantly. There is no single "New Thread modal" to add an option to.

All four types now route through one modal: **type picker → name → auto-archive
toggle → `[12] [hours ▾]`** (revealed only when the toggle is on). When the type
is Claude Code or Codex it still shows the existing RESUME RECENT list, so
nothing is lost from today's two modals. `NewTabMenu` becomes the thing that
opens this modal with a type preselected. `NewClaudeThreadModal` and
`NewCodexThreadModal` fold into it.

Cost: structured and Terminal threads, which are one-click today, gain a modal
step. Accepted for consistency and discoverability.

**b. Context menu — `Auto-archive…`** on the thread row, opening a small modal
with the same toggle + duration control. This is what makes the feature useful
against the clutter that *already* exists, and lets a thread be taken off the
clock when it turns out to matter.

**c. Countdown badge** on auto-archive rows: `⏱ 3h`, computed client-side from
`lastActivityAt + autoArchiveMs` on a shared 60-second interval. No new API
surface. It renders in the existing right-hand status area alongside `timeAgo`,
so it costs no horizontal room and cannot reintroduce the label-offset bug.

### 4. Error handling

- Each thread is swept inside its own `try/catch`. One thread whose process
  refuses to die cannot abort the sweep for the rest.
- Malformed `config` → parses to `{}` → treated as not-auto-archive.
- Missing `last_activity_at` → falls back to `created_at`
  (`db/terminals.ts:62`), the correct conservative reading for a thread that has
  genuinely never done anything.
- The sweep never throws out of the interval callback.

### 5. Testing

**Core** — `packages/core/src/sessions/auto-archive.test.ts`, following
`sessions/archive.test.ts` (real SQLite in a tmpdir, fake PTY). Drives
`autoArchiveTick` directly against rows with backdated `last_activity_at`:

- every row of the skip table, state by state;
- a thread past its deadline is archived (`archived_at` set, process killed);
- a thread inside its deadline is not;
- a thread with no `autoArchive` config is never touched, however old;
- a malformed `config` blob is never touched;
- one failing thread does not prevent the others from being swept.

Route/DB tests gain the thread-archive coverage they currently lack (no existing
test asserts `archived_at` is set or that a thread appears in
`/terminals/archived`).

**Web** — the new modal (toggle reveals the duration input; default is 12 hours;
the correct `config` is POSTed), the context-menu editor, and the badge's
duration math.

## Out of scope

- Any archived-threads / restore UI (explicitly declined).
- A global default auto-archive policy in Settings. Per-thread only.
- Auto-archiving projects (sessions). Threads only.
- Auto-archive for `browser` / `notes` / `file` tabs — they have no activity
  signal to measure.
