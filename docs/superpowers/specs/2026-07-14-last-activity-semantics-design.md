# Thread `last_activity_at` semantics — design

**Date:** 2026-07-14
**Status:** Approved (inline review)

## Problem

The "last active" timestamp on a thread updates when the thread is *opened*, not when
it last *did* something. Root cause: `sessions.last_activity_at` has three independent
writers, two of which fire on passive events:

1. `terminal-monitor.ts` bumps it 3s after **any** PTY output burst, unconditionally.
   Opening a thread attaches a WebSocket, which triggers `nudgeRepaint()` (SIGWINCH)
   and an xterm fit resize — the TUI repaints its full screen (>500 bytes), and the
   monitor stamps activity. The monitor's existing busy-threshold/grace-period
   machinery gates only the status broadcast, not the timestamp.
2. `sessionsDb.updateStatus()` bumps it on **every** status write — including the
   `SessionStart` hook fired on resume/revive (i.e. on open), PTY-exit rollups,
   `stop()`, and `ptyStatusTick`'s repaint-induced `working` flips for Codex.
3. `sessionsDb.touchActivity()` exists as the correct primitive but is dead code.

## Goal

`last_activity_at` (on both `sessions` and `terminals`) means: **the last time this
thread thought about something** — a message was sent to it, a turn ran or completed,
it asked for input, or it produced sustained work output.

Opening, attaching, repainting, resizing, resuming/reviving, stopping, and process
exit must not move it.

## Design

### 1. `db/sessions.ts`
- `updateStatus()` stops writing `last_activity_at` (keeps `status` + `updated_at`).
- `touchActivity()` becomes the only session-level activity writer.

### 2. `db/terminals.ts`
- Add `touchActivity(db, id)` mirroring the sessions helper (terminal rows are
  currently only bumped by the monitor's inline SQL).

### 3. `status/service.ts` (StatusService)
- In `apply()`, after persisting the terminal status, touch activity on both the
  terminal and session rows for every normalized status **except `'starting'`**
  (SessionStart = open/revive, not thought).
- Touching statuses: `working` (UserPromptSubmit / markWorking), `idle` (Stop /
  markIdle — turn completed), `needs_input`, `done`, `scheduled`, `error`
  (StopFailure — it was thinking until it failed).
- Best-effort try/catch, same as the existing status writes.

### 4. `terminal-monitor.ts`
- The idle-timer callback bumps `last_activity_at` **only when the burst actually
  crossed the busy threshold** — i.e. the callback fires while `activity === 'busy'`.
- New `suppress(terminalId)` method re-arms the existing connection grace window
  (`connectedAt = now`, reset burst bytes; create the tracking entry if absent) so
  passive repaints inside the window can never reach `busy`.

### 5. `ws/terminal.ts` + `server.ts`
- Pass the `TerminalMonitor` into `handleTerminalConnection` (optional param).
- Call `suppress()` on attach and on each client resize message. This covers the
  `nudgeRepaint` SIGWINCH repaint and fit-addon resizes. A thread genuinely mid-turn
  when opened still stamps: its output continues past the grace window.

### Free fixes (no code change needed)
- `ptyStatusTick` (Codex) and PTY-exit `rollupSession` / `stop()` stop polluting the
  timestamp automatically once `updateStatus` no longer bumps it.
- Structured threads are already safe: `busy` is emitted only from `sendMessage`
  (turn start) and `idle`/`scheduled` only from a live `result` event; resume
  backfill seeds the ring without re-emitting either.

## Not changing
- Status-dot/rail semantics, `updated_at` behavior, sort logic (still
  `last_activity_at DESC`), DB schema (no migration).
- Old timestamps inflated by past opens self-correct on the next real activity.
- Known cosmetic issue left as follow-up: opening a Codex thread can still flash the
  status dot `working` for ~4s (`ptyStatusTick` reads raw PTY recency).

## Edge cases
- Plain shell terminals have no hooks; activity comes from busy bursts only. A
  command producing <500 bytes of output won't stamp — consistent with "thought
  about something".
- Web client reads `lastActivityAt ?? createdAt` in several places; unchanged.

## Testing
- Flip `tests/db/sessions.test.ts` "updates lastActivityAt": `updateStatus` must now
  NOT bump it; `touchActivity` must.
- StatusService: touches activity on `working`/`idle`/`needs_input`, not on
  `starting`.
- TerminalMonitor: sub-threshold burst → no bump; suppressed-window repaint → no
  bump; genuine busy burst → bump on both session and terminal rows.
