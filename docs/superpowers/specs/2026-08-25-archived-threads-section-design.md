# Archived-threads section in the project sidebar — design

**Date:** 2026-08-25
**Status:** Approved (brainstorm complete)
**Branch:** `feat/archived-threads-section`

## Problem

Archiving a thread is a soft delete: the daemon keeps the row and its
`external_id`, and `POST /api/terminals/:id/restore` can bring the thread back
and resume the same agent conversation. But no general UI surface lists
archived threads. The only consumer of `GET /api/sessions/:id/terminals/archived`
is the Overseer `CoordinatorMenu`, which filters to coordinator-role threads.
A normal thread that auto-archives (default timer: 12 h after last activity)
simply vanishes from the sidebar with no way back short of curl.

This is not hypothetical: one real machine has 467 archived `claude-code`
threads, 128 of them in a single project. The list is long, so the UI must cap
it.

## Decisions (from brainstorm)

1. **Placement: a quiet ARCHIVED section per project card**, rendered after
   FILES, using the existing non-prominent `SectionHeader` style with a count
   badge and a chevron. Collapsed by default. Hidden entirely when the project
   has no archived threads. (Alternatives considered: an inline toggle in the
   THREADS header, and a modal behind the project menu. Rejected for mixing
   live and dead rows, and for hiding the feature, respectively.)
2. **Web-client only.** Both endpoints already exist
   (`listArchivedTerminals`, `restoreTerminal`). No daemon changes.
3. **Upstream PR** to `davidwebber10/dispatch`, full tests.

## Design

### Component

New `packages/web/src/components/sidebar/ArchivedSection.tsx`.
`ProjectCard` renders `<ArchivedSection sessionId={session.id} onSelectTab={...} />`
once per project, after the FILES section.

### Data flow

- When the project card is open, the section fetches
  `api.listArchivedTerminals(sessionId)` once (lazy on first open, cached in
  component state).
- Filter: keep thread types only (`THREAD_TYPES`: claude-code, codex, shell).
  Drop `file` rows; archive is the delete path for file tabs.
- Sort: `archivedAt` descending (newest first).
- Cap: show the newest 10 rows plus a "Show all (N)" expander, following the
  existing `showAllThreads` pattern in `ProjectCard`.
- Refresh: refetch on `session:archived` and `terminal:created` broadcast
  events for this project, so archives and restores from another device stay
  in sync. (`terminal:created` is what the daemon broadcasts on restore.)

### Row

Reuse `ThreadLabel` for the label, plus:

- the archive date (short form, e.g. "Aug 25"),
- a restore icon button on hover (desktop) or always visible (mobile),
  `title="Restore thread"`.

No status dot: archived threads have no live process.

### Restore semantics

Restore calls the existing `api.restoreTerminal(id)`. The daemon unarchives
the row and, for PTY types, respawns the agent with its resume command
(`claude --resume <externalId>` / `codex resume`), so the original
conversation continues. On success:

- remove the row from the archived list,
- `useTabs.getState().loadTabs(sessionId)` to refresh the thread list,
- select the restored thread (`onSelectTab(id)`).

Note: a restored thread keeps its config, including `autoArchive`. If the
user does not touch it, it will re-archive after the timer. That is existing
behavior and out of scope here.

### Errors

- Fetch failure: keep the section header, render a "Couldn't load — retry"
  row instead of an empty state (same rationale as `CoordinatorMenu`: an empty
  state on a fetch failure is misleading).
- Restore failure: keep the row, surface the error inline on the row.

## Out of scope

- Deleting archived threads permanently.
- Restore-without-respawn.
- Showing archived file tabs.
- Any daemon/API change.

## Testing

`ArchivedSection.test.tsx`, following the sidebar test conventions:

1. Section hidden when the archived list (post-filter) is empty.
2. `file` rows are filtered out of both the list and the count.
3. Cap: 12 archived threads render 10 rows + "Show all (12)"; clicking
   expands.
4. Restore success: row removed, `loadTabs` called, `onSelectTab` called.
5. Fetch failure: retry row shown, clicking refetches.
6. Refetch on `session:archived` broadcast for the same project.
