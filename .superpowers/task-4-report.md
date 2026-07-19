# Task 4: peer tools in the agency MCP

**Status:** DONE

**Commit:** `a8400e7` — feat(mcp): peer tools — list/read/message/watch threads

## What was built

Added six tools to `packages/core/src/overseer/agency-mcp.ts` (TOOLS array +
`callTool` switch), alongside the existing 10 (unchanged names/schemas/semantics):

- `list_threads` — GETs `/api/sessions/:id/terminals`, maps EVERY row (not
  filtered like `list_agents`'s `isAgentTerminal`) to
  `{ id, label, type, role, agentType, status, lastActivityAt, isSelf }`.
  `isSelf = id === selfTerminalId()`. Includes role-less plain threads.
- `read_thread({ id, tail? })` — same conversation-tail logic as `read_agent`,
  minus the agent-type filter, after `assertInProject`. `tail` maps to the
  `?limit=` query param (default 500). Reuses the terminal already fetched by
  `assertInProject` for `status` instead of a second GET.
- `message_thread({ id, text })` — same POST `/message` call as `message_agent`,
  after `assertInProject`.
- `watch_thread({ id, when, note?, once? })` — POST `/api/watches` with
  `watcherTerminalId = selfTerminalId()`, after `assertInProject(id)` and a
  `requireSelf` identity check.
- `unwatch_thread({ watchId })` — DELETE `/api/watches/:id`.
- `list_watches()` — GET `/api/watches?watcher=<self>&target=<self>` (both
  params, so it returns both "watching" and "watchedBy" as the spec's tool
  description promises — the plan's literal text named only `watcher=`, but the
  route already supports `target=` too and returning only half the picture
  seemed like a functional gap, so both are passed).

**Shared helper `assertInProject(id)`**: fetches `GET /api/terminals/:id`,
throws `"<id> is not a thread in this project"` if missing (any fetch error) or
`sessionId !== DISPATCH_SESSION` — never leaks the foreign terminal's label/session
in the message (verified by test).

**Shared helper `requireSelf(action)`**: throws a clear error naming
`DISPATCH_TERMINAL` when `selfTerminalId()` is empty, before any HTTP call —
used by `watch_thread` and `list_watches` so a stale (pre-peer-tools) injection
can't register a watch with an empty watcher id.

**`watchesRequest`**: dedicated fetch wrapper for `/api/watches` that surfaces
the route's own `{error}` body as the tool error (never httpJson's generic
`<method> <url> -> <status>: <raw body>`), with an explicit 429 → "watch limit
reached: ..." message regardless of the route's exact wording.

## Tests (RED confirmed, then GREEN)

Extended `packages/core/tests/overseer/agency-mcp.test.ts` (new `describe`
blocks per tool, reusing the existing fake-fetch harness): happy-path shapes,
foreign-project id → project error with no data leak (asserted foreign label/
session absent from the error text) and no further fetch, unknown-id (404)
same treatment, `list_threads` includes a role-less thread and marks `isSelf`
correctly (including when `DISPATCH_TERMINAL` is unset), `watch_thread`
without `DISPATCH_TERMINAL` → clear error naming it, and a 429 → message
containing "watch limit". Updated the pre-existing `tools/list` test (name
array + `TOOLS` length 10 → 16).

## Verification

- `npx vitest run tests/overseer/agency-mcp.test.ts` — 47/47 pass.
- Full core suite: `cd packages/core && npx vitest run` — 99 files, 829/829
  tests pass (single run, no rerun needed — `tests/routes/terminals.test.ts`'s
  known flaky timeout did not trip this run).
- `cd packages/core && npx tsc -b` — clean, no errors.

## Concerns / notes

- `list_watches`'s query-param choice (`watcher` + `target`) is a small
  interpretation beyond the plan's literal one-param wording — flagged above
  for visibility; behavior matches the spec's stated intent ("what this
  thread is watching, and who is watching it").
- Did not touch `.superpowers/progress.md` / `task-1-report.md`, which were
  already modified in the working tree from Task 1's follow-up fix before I
  started — left untouched, not part of this commit.

---

# Task 4 follow-up: fix ownership check on `DELETE /api/watches/:id`

**Status:** DONE

**Commit:** `212b81b` — fix(api): watches can only be cancelled by their watcher

## Finding addressed

Review flagged that `DELETE /api/watches/:id` deleted by id with no
verification of who was asking, and that `unwatch_thread` forwarded straight
to it. Contained today only because watch ids are opaque UUIDs reachable
solely through self-scoped tools, but that backstop disappears once every
thread gets this tool.

## Fix

- `packages/core/src/routes/watches.ts` — `DELETE /:id` now requires a
  `watcher` query param: missing → `400 { error: 'watcher is required' }`;
  row exists but belongs to a different watcher → `404 { error: 'watch not
  found' }` (deliberately the SAME response as a missing id — a 403 or an
  "not yours" message would confirm the id exists, exactly the leak the rest
  of this feature avoids, matching `assertInProject`'s existing
  foreign-vs-missing indistinguishability); owned → deletes, `{ ok: true }`.
  Ownership is checked via the existing `watchesDb.listByWatcher(db,
  watcher).some(w => w.id === id)` accessor — `db/watches.ts` itself was not
  touched, per the no-go list (another agent working there).
- `packages/core/src/overseer/agency-mcp.ts` — `unwatchThread` now calls
  `requireSelf('unwatch a thread')` before issuing the DELETE, and passes
  `?watcher=<self>` on the URL, so a stale injection with no
  `DISPATCH_TERMINAL` fails with a clear error instead of sending an empty
  watcher, and a thread can only cancel watches it owns.
- Minor: the `list_watches` MCP test now asserts both `watcher` and `target`
  query params are present on the request URL (previously only `watcher` was
  checked, so a regression dropping `target` would have passed silently).

## Tests (RED confirmed, then GREEN)

- `packages/core/tests/routes/watches.test.ts`: added "returns 400 when the
  watcher query param is missing", "returns 404 (not 403) when the caller is
  not the watch's watcher, and leaves the row intact" (asserts the row still
  exists afterwards), and updated the existing delete/404 tests to pass
  `?watcher=`.
- `packages/core/tests/overseer/agency-mcp.test.ts`: `unwatch_thread` now
  asserts the DELETE URL's `watcher` query param equals the caller's
  `DISPATCH_TERMINAL`, and a new test asserts a clear `DISPATCH_TERMINAL`
  error with zero fetch calls when it's unset. `list_watches` test now checks
  both `watcher` and `target` params.
- Confirmed RED first (4 failing tests, all in the newly-added/changed
  assertions), then GREEN after the implementation.

## Verification

- `npx vitest run tests/routes/watches.test.ts tests/overseer/agency-mcp.test.ts`
  — 60/60 pass.
- Full core suite (`cd packages/core && npx vitest run`): 832 tests, 831 pass,
  1 failed on the first run — `tests/routes/auth.test.ts`'s "caps listed auth
  requests to the 100 newest records" (socket hang up). Reran that file alone
  and it passed 8/8 — confirmed as the known flaky-under-parallel-load test
  called out in the task brief, not a regression from this change.
- One test *file* failed to even load: `tests/sessions/watch-dispatcher.test.ts`
  (imports `../../src/sessions/watch-dispatcher.js`, which doesn't exist yet).
  This is untracked, in-progress work from another agent (Task 5, watch
  dispatcher) already present in the worktree before this task started — not
  touched, not caused by, and out of scope for this fix.
- `cd packages/core && npx tsc -b` — clean, no errors.

## Concerns

None. Scope stayed within `routes/watches.ts` and `overseer/agency-mcp.ts` (+
their tests) as instructed; `db/watches.ts`, `watch-dispatcher.ts`,
`status/service.ts`, `server.ts`, and `sessions/service.ts` were not edited.
