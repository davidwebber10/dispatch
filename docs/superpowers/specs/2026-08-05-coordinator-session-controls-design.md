# Coordinator session controls — Restart, New session, Previous sessions

**Date:** 2026-08-05
**Status:** Approved design, pending implementation plan

## Problem

Worker (subagent) threads have Interrupt / Stop / Archive controls in the
worker lightbox (`packages/web/src/components/overseer/components/WorkerLightbox.tsx`).
The coordinator (Control Plane) thread has none, on any surface:

- The desktop Dispatch tab renders flush — stream + composer, no header
  (`OverseerView.tsx`). The tab's × only closes the UI tab; the thread and
  process persist.
- The mobile consolidated header has only back-nav and the Needs alert.
- The Board coordinator lightbox (`overseer/WorkerLightbox.tsx`) has
  Interrupt only.

Field consequence (2026-08-05): a coordinator spawned under an old Claude
account held a stale MCP tool set. The structured process reads MCP config
once, at spawn; TUI slash commands like `/reload-plugins` do not exist in
stream-json mode. The only remedies were raw REST calls
(`POST /terminals/:id/stop`, `DELETE /terminals/:id`).

## Feature

A coordinator-specific menu with three actions, honest about coordinator
semantics (which differ from worker Stop/Archive):

1. **Restart session** — kill + immediately respawn the coordinator process.
   Same conversation (`-r <external_id>` resume + history backfill), freshly
   rebuilt MCP config (secrets + integrations + agency wiring). This is the
   one-click "reload tools" fix.
2. **New session…** — archive the coordinator (soft delete; confirm required).
   A fresh coordinator is find-or-created immediately. The old conversation is
   archived, not deleted.
3. **Previous sessions…** — list this project's archived coordinators and
   swap a chosen one back in.

## Design

### 1. Server: structured-aware relaunch (the only server change)

`restartTerminal` (`packages/core/src/sessions/service.ts:822`) kills only
via `ptyManager`, so `POST /api/terminals/:id/relaunch` is a no-op for a live
structured thread (`spawnStructured` returns early when the manager reports
alive). Change:

- When the terminal runs the structured transport (`isStructuredTerminal`),
  kill it with the existing `killCurrentTransport(type, id, 'structured')`
  helper and await exit (bounded, 3s), then fall through to the existing
  `relaunchTerminal` path — which already respawns, resumes with
  `-r <external_id>`, backfills the ring from the transcript, and rebuilds
  the MCP injection from current connections.
- PTY threads keep the current behavior. This change also repairs relaunch
  for structured **worker** threads (same dead route today).

No new endpoints. `DELETE /terminals/:id` (archive) and
`POST /terminals/:id/restore` already exist and behave correctly for
coordinators.

### 2. Web API client

Add `restoreTerminal(id)` (`POST /api/terminals/:id/restore`) — the only
missing client method. `relaunchTerminal`, `stopTerminal`, `archiveTerminal`,
`listArchivedTerminals` already exist.

### 3. Store actions (`useOverseer`)

- `newCoordinatorSession(sessionId)`: `api.archiveTerminal(coordinatorId)` →
  clear `coordinatorId` → `ensureForProject(sessionId)`. The guard at
  `store.ts:320` passes because `coordinatorId` is null, so a fresh
  coordinator is created immediately and the stream remounts empty.
- `resumeCoordinatorSession(sessionId, archivedTerminalId)`: archive the
  current coordinator FIRST, then `api.restoreTerminal(archivedTerminalId)`,
  then set `coordinatorId` to the restored id (reset stream/paging/pending
  state the same way `ensureForProject` does). Order preserves the
  one-active-coordinator invariant. If restore fails, fall back to
  `ensureForProject(sessionId)` (fresh coordinator) — never leave the
  project with zero active coordinators.
- Restart needs no store action: the menu calls
  `api.relaunchTerminal(coordinatorId)` directly.

### 4. UI: shared `CoordinatorMenu` component

New `packages/web/src/components/overseer/components/CoordinatorMenu.tsx`,
styled like `AutonomyControls` with the same `scheme: 'scoped' | 'global'`
prop. A kebab (⋯) button opens a popover with:

- **Restart session** — one click; busy state until the call returns.
  Tooltip: "Restart — reload tools and connections; history is kept."
- **New session…** — two-step inline confirm. The item swaps to "End this
  session? A fresh one starts now. The old conversation is archived." with
  Confirm / Cancel. No browser `confirm()` (blocks the event loop), no new
  modal infrastructure.
- **Previous sessions…** — expands to a list of the project's archived
  coordinators, fetched on open via `api.listArchivedTerminals(sessionId)`
  filtered to `type === 'claude-code' && config.role === 'coordinator'`
  (server returns `archived_at DESC`). Each row: "Archived <relative time>".
  Empty state: "No previous sessions." Choosing a row runs
  `resumeCoordinatorSession` (no extra confirm — the current session is
  archived, not lost, and appears at the top of this same list).

### 5. Mounts (three)

- Desktop: right end of the `Composer` row (scoped scheme).
- Mobile: `OverseerMobile` consolidated header, left of `NeedsAlert` (scoped).
- Board: outer `overseer/WorkerLightbox.tsx` header next to Interrupt, only
  in the `isCoordinator` branch (global scheme).

### 6. Gating

Render only when a coordinator id exists AND the loaded coordinator belongs
to the viewed project — the same `projectMatches` gate the Load-earlier
button uses (cross-tab isolation contract).

### 7. Error handling

Best-effort like the existing control buttons: on failure clear the busy
state and keep the menu open. A failed archive leaves the current session
intact. The resume fallback (design §3) covers a failed restore.

### 8. Tests

- **Core:** `restartTerminal` through the `structuredCommandOverride` seam —
  spawn a structured thread, relaunch, assert the old process died and the
  respawn args carry `-r <external_id>`.
- **Web:** `CoordinatorMenu` — items render; Restart calls
  `api.relaunchTerminal`; New session is inert on first click, archives and
  re-ensures on confirm; Previous sessions lists only archived coordinators
  and a row click archives-then-restores in that order; menu hidden when the
  coordinator belongs to another project. Follow the jsdom paint-gate /
  text-query conventions documented in `Stream.test.tsx`.
- **Verify (plan step, not code):** archived coordinators must not appear as
  "done outcomes" in the WorkRail — confirm the archived-terminals consumers
  filter through `isStructuredWorker` (which excludes coordinators,
  `live.ts:96`).

## Known limitations (documented, not solved here)

- The Claude CLI deletes transcripts after its retention window (~30 days
  default). A resumed session older than that cannot rebuild its history.
- Restore respawns with the tool wiring current at restore time — which is
  the desired behavior for the stale-MCP case.
- Restart's kill is bounded (3s await); a wedged process may briefly overlap
  its replacement's spawn window. Same bound `restartTerminal` uses today.

## Out of scope

- No changes to `useStructuredChat`, coordinator prompts, or worker controls.
- No rename/labeling of archived sessions (rows show archived time only).
- No retention/pinning of transcripts past the CLI's window.
