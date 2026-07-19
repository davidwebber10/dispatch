# Task 3: watch subscription HTTP endpoints

**Status:** Done.

**Commit:** b77b7ab — `feat(api): watch subscription endpoints`

## What was built

- `packages/core/src/overseer/guards.ts` — new file, exports `MAX_LIVE_WATCHES_PER_WATCHER = 20` (Task 6 will import and extend this module; left it as a clean constants/predicates home per the plan's note).
- `packages/core/src/routes/watches.ts` — new router (shape copied from `routes/update.ts`):
  - `POST /` — validates body presence, validates `criteria` ∈ `idle|needs_input|error|any` (400), looks up both terminals via `terminalsDb.getById` (404 if either missing), requires `watcher.session_id === target.session_id` (400 `{error:'not in this project'}`), enforces the 20-live-watch cap via `watchesDb.countByWatcher` (429), then `watchesDb.create` → `201 {id}`.
  - `GET /` — reads `?watcher=` / `?target=` query params independently; returns `{watching, watchedBy}`, each populated only if its query param was given (both can be combined).
  - `DELETE /:id` — `watchesDb.remove` → `200 {ok:true}` or `404`.
- Mounted as `app.use('/api/watches', createWatchesRouter(db))` in both `createApp` and `startServer` in `packages/core/src/server.ts`, alongside the other routers (after `/api/appearance`).

## Tests

New `packages/core/tests/routes/watches.test.ts` (10 tests, full `createApp` + real sqlite, matching the `terminals.test.ts` convention since project-scoping needed real sessions/terminals): create/list/delete happy paths, cross-project → 400, unknown watcher/target → 404 (both directions), invalid criteria → 400, 20-watch cap → 429 on the 21st, delete-missing → 404.

Verified RED before implementing (module-not-found), then GREEN. Full core suite: **99 files / 811 tests passed**. `npx tsc -b` clean.

## Concerns / notes for later tasks

- Did not touch `sessions/service.ts`, `overseer/agency-mcp.ts`, or `db/watches.ts` — read-only, per instructions.
- 400 vs 404 precedence when both terminals are invalid/mismatched: criteria validated first, then watcher lookup, then target lookup, then session match — deterministic but untested for every combination beyond what the spec asked.
- No auth/identity check in this router itself (e.g. no verification that the caller *is* `watcherTerminalId`) — that's Task 4's job in the MCP layer (`assertInProject`), this task only enforces watcher/target same-project.
