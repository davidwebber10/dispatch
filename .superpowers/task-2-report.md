# Task 2 Report — replay-size steps and scrollback-size client

**Status:** Complete, GREEN, committed.

**Commit:** `63628ce` — `feat(web): replay-size steps and scrollback-size client`

## Files changed
- `packages/web/src/api/terminal-socket.ts` — exported `INITIAL_REPLAY_MOBILE = 256_000`, `MAX_REPLAY = 4_000_000`, and `nextReplayStep(current): number` (walks a `[256_000, 1_000_000, 4_000_000]` ladder, returns the first step strictly greater than `current`, falls back to `Math.max(current, MAX_REPLAY)` so it never shrinks even past MAX). Replaced the hardcoded `4_000_000` default in `openTerminalSocket` with `MAX_REPLAY` (same value — desktop byte-identical). The module already accepted an explicit `replayBytes` per connect, so no other change was needed there.
- `packages/web/src/api/client.ts` — `getScrollbackSize(id): Promise<number>` via the shared `req()` helper: `req<{ totalBytes }>(`/api/terminals/${id}/scrollback`).then(r => r.totalBytes)`. A 404 (unknown terminal) is left to `req()`'s existing throw — no special-casing, consistent with every other terminal-id route in this file (e.g. `getTerminal`).
- `packages/web/src/api/terminal-socket.test.ts` — added `nextReplayStep` step/saturation/never-shrinks tests, a constants-match test, and two connect-URL tests: one asserting `replayBytes=999000` appears verbatim in the query string when passed explicitly, one asserting the default is `replayBytes=4000000` (desktop unchanged).
- `packages/web/src/api/client.test.ts` — added `getScrollbackSize` GET + return-value test and a 404-rejects test.

## Test summary
- RED confirmed first: `nextReplayStep is not a function`, `api.getScrollbackSize is not a function` (6 failures).
- GREEN after implementation: targeted run 18/18 passed.
- Full web suite: `npx vitest run` → 84 test files, 510 tests, all passed (pre-existing React `act()` warnings only, unrelated to this change).
- `npx tsc -b --noEmit` → clean, no output.

## Query param
The socket builds `...&replayBytes=<n>`; server reads it via `parsed.searchParams.get('replayBytes')` in `packages/core/src/ws/terminal.ts:12` — verified by reading the server file directly, not by grep alone. Names match exactly.

## Concerns
- None blocking. `.superpowers/task-2-report.md` already existed in the worktree with content from an unrelated task (an "update modal" feature) — overwritten with this report since the path is what the plan designates for Task 2 of *this* plan.
- No lifecycle commands, no daemon started, tests only, per the safety constraint.
