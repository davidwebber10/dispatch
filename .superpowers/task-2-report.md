# Task 2 Report — thread_watches table + db layer

**Status:** DONE

**Commit:** 26c2ea1 — feat(db): thread_watches table and accessors

**Files:**
- `packages/core/src/db/schema.ts` — new `CREATE TABLE IF NOT EXISTS thread_watches (...)` beside the other tables (unconditional, runs on every boot), plus `idx_thread_watches_target` / `idx_thread_watches_watcher` indices. No migrations-array entry needed since it's a new table, not a new column.
- `packages/core/src/db/watches.ts` — new module: `create`, `listByWatcher`, `listByTarget`, `liveForTarget`, `markFired`, `remove`, `removeForTerminal`, `countByWatcher`, exact signatures from the plan's Task 2 Interfaces block. `create` generates the id internally via `uuid()` (v4), matching the plan's `create(...): string` signature (this module owns id generation, unlike `terminals.ts` where callers pass the id — the plan requires this exact shape since later tasks call it). "Live" = `fired_at IS NULL OR once = 0`, shared as one SQL clause across all live-filtering functions.
- `packages/core/tests/db/watches.test.ts` — 18 tests: create/list round-trip, defaults (note→null, once→0), `once:true` storage, per-terminal isolation, `liveForTarget` (exact match, `'any'`, non-match, wrong target), `markFired` (once=1 hides, once=0 stays live), `remove` (true/false), `removeForTerminal` (watcher side, target side, unrelated untouched), `countByWatcher` (per-watcher count, excludes fired once=1, zero for unknown).

**Test summary:** RED confirmed (moved watches.ts aside, test file failed to resolve the module) → implemented → GREEN on the target file (18/18) → full core suite `npx vitest run`: 98 files / 801 tests passed → `npx tsc -b` clean.

**Concerns:** None blocking. One note: I did not add FOREIGN KEY constraints to `terminals(id)` on the two id columns (unlike e.g. `agent_runs`) — the plan only asked for indices, and production runs with `PRAGMA foreign_keys = ON`, so an FK there would make terminal deletion fail unless a future task always calls `removeForTerminal` first. Left un-enforced by design; flagging in case a later task wants it added deliberately once the deletion wiring exists.

**Report path:** `/Users/davidwebber/Sites/dispatch/.claude/worktrees/peer-watch/.superpowers/task-2-report.md`
