# Task 1 report — server reports a terminal's scrollback size

**Status:** Done. RED → GREEN → full suite GREEN → tsc clean → committed.

**Commit:** `a21b5aa` — `feat(api): report a terminal's scrollback size`

**Files changed:**
- `packages/core/src/pty/buffer.ts` — added `RingBuffer.size(): number`
- `packages/core/src/pty/manager.ts` — added `PTYManager.getBufferSize(terminalId): number` (0 for unknown)
- `packages/core/src/sessions/service.ts` — added `SessionService.getScrollbackSize(terminalId)` delegate (matches the existing `getPendingPermission`-style thin-delegate pattern; routes never touch `PTYManager` directly, only `SessionService`)
- `packages/core/src/routes/terminals.ts` — `GET /api/terminals/:terminalId/scrollback` → `200 { totalBytes }`, `404 { error: 'Terminal not found' }` for an unknown terminal (same existence check as the neighbouring single-terminal GET: `sessionService.getTerminal(id)`)
- `packages/core/src/server.ts` — `NoopPTYManager` (test double, `skipPty: true`) gets an explicit `getBufferSize() { return 0; }` override, for the same reason its `getBuffer`/`getLastActivity` siblings are explicit rather than relying on the inherited empty-map fallback
- Tests (colocated in `tests/**`, matching how `pty` and `routes/terminals` tests are already organized — this repo's `src/**/*.test.ts` colocated convention exists elsewhere but not for these two areas): `packages/core/tests/pty/buffer.test.ts`, `packages/core/tests/pty/manager.test.ts`, `packages/core/tests/routes/terminals.test.ts`

**Test summary:** full core suite `npx vitest run` (from `packages/core`) → 103 files, 918 tests, all passing. `npx tsc -b` (from `packages/core`) clean, no errors.

**Which buffer field gives the retained size:** `totalSize`. `RingBuffer.write()`'s trim loop already decrements `totalSize` as it evicts old chunks once the ring exceeds `maxSize`, so `totalSize` is already "what a full replay would return right now" (retained/capped), never the lifetime sum of everything written. `size()` just exposes it as-is — no new accounting needed. Verified with a dedicated test: writing 5+5+3 bytes into a 10-byte-cap ring yields `size() === 8` (retained, post-trim) while the lifetime total written is 13 — the test asserts the two numbers differ.

**Route test note:** core route tests run with `createApp({ skipPty: true })` (a `NoopPTYManager`, no real PTY), so the "route returns the manager's number" test spies on `app._ptyManager.getBufferSize` (mirrors the existing `_sessionService`/`_structuredManager` test-seam pattern already used in this test file) to assert the route delegates faithfully and returns whatever the manager reports, rather than asserting only the trivial always-0 case. Manager-level byte-count coverage (N bytes, and retained-vs-lifetime under wrap) is exercised directly against `RingBuffer`/`PTYManager` with a real spawned PTY.

**Concerns:** None blocking. Two judgment calls worth flagging: (1) the endpoint's 404 is keyed on DB terminal existence (`sessionService.getTerminal`), not PTY liveness — a known-but-not-currently-alive terminal (e.g. stopped) returns `200 { totalBytes: 0 }` rather than 404, consistent with the plan's "0 when unknown" wording for the manager method and the sibling routes' 404 style. (2) Added a `SessionService.getScrollbackSize` delegate rather than passing `PTYManager` into `createTerminalsRouter` directly, since every existing HTTP route goes through `SessionService` only (the raw `PTYManager` is currently wired only into the websocket handler) — this keeps the new route consistent with its neighbours.

**Safety:** No dispatch lifecycle commands, no real daemon start, no attach to real terminals, `~/.dispatch` and port 3456 untouched. Only `npx vitest run` / `npx tsc -b` were executed.
