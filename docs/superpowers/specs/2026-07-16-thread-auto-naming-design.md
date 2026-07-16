# Dispatch — Thread Auto-Naming

**Date:** 2026-07-16
**Status:** Design approved; spec awaiting review.

## Goal

Threads created without a name stop piling up as "Claude Code" / "Codex".
When the user doesn't name a thread, dispatch names it once from the
conversation itself. A name the user sets — at creation or via rename, even
if it is literally "Claude Code" — is permanent and never touched.

## Decisions (confirmed)

1. **Source:** reuse the transcripts dispatch already parses — Claude Code's
   own `summary` entry when present, else the first user message; codex
   threads use their transcript's first user message. No LLM calls, no API
   keys, no cost.
2. **Cadence:** name once, shortly after the thread's first real activity.
   Auto-assigned names are never regenerated or upgraded.
3. **User names are law:** any user-supplied label (creation field or
   rename) is final. The system must distinguish user labels from defaults
   structurally, not by string comparison.
4. **New threads only:** no backfill. Existing rows are frozen as-is.
5. **Shell threads excluded** (no conversation to name from).

## Data model

Migration: `ALTER TABLE terminals ADD COLUMN label_source TEXT NOT NULL
DEFAULT 'user'`.

- Existing rows become `'user'` via the column default — this implements
  "new threads only" and can never misfreeze a name the user typed.
- `createTerminal`/`createQueuedTerminal`/`createRunnerTerminal`/`createTab`:
  `'user'` when a label was supplied, `'default'` when
  `defaultTerminalLabel()` filled it in.
- PATCH `/api/terminals/:id` (rename) and `updateTab`: set `'user'`
  unconditionally.
- New `terminalsDb.setAutoLabel(db, id, label)`: single statement,
  `UPDATE terminals SET label = ?, label_source = 'auto' WHERE id = ? AND
  label_source = 'default'` — the guard makes a concurrent user rename win
  every race. Returns whether a row changed.

## Namer

`packages/core/src/sessions/thread-namer.ts`:

- `deriveThreadName(transcriptText, provider): string | null` — pure.
  Claude transcripts: prefer the first `{type:'summary'}` entry's summary;
  else the first user message that isn't tool noise (reuse the same
  filtering the `cc-sessions.ts` preview logic applies: skip
  `<`-prefixed payloads). Codex transcripts: first user message per the
  codex-sessions parsing. Cleaning: collapse whitespace to single spaces,
  strip leading command punctuation, cut at 48 chars on a word boundary
  (no mid-word cuts, no trailing "…" if the text fit).
- Returns `null` for empty/unusable content — callers treat that as "try
  again later", never as a name.
- Transcript resolution reuses existing helpers (`claudeProjectDir` +
  external/discovered session id for claude-code; the codex-sessions
  lookup for codex). Filesystem access is injectable for tests.

## Trigger service

`ThreadAutoNamer` (constructed in `server.ts`, alongside StatusService /
TerminalMonitor):

- Input signal: the same moments that call `touchActivity` — StatusService
  `apply()` on real hook edges (covers claude-code) and TerminalMonitor's
  busy-idle bump (covers codex PTY activity).
- On signal for a terminal whose row has `label_source === 'default'` and
  type ≠ shell: schedule one attempt ~5s later (debounced per terminal —
  a burst of signals schedules nothing new while one is pending).
- Attempt: resolve transcript → `deriveThreadName` → on success,
  `setAutoLabel`; if the guarded UPDATE changed a row, emit the same
  broadcast the rename path emits so open sidebars re-render.
- On `null` (transcript not written yet): count the attempt; the NEXT
  activity signal may schedule again, up to 3 attempts total, then the
  terminal is left `'default'` silently (it simply keeps today's behavior).
- No timers persist across restarts; a restarted daemon just responds to
  the next activity signal. All failures are swallowed with a debug log —
  naming must never affect thread operation.

## Web

No changes. Labels already propagate through the existing tab reload
events; the rename modal already lands on the PATCH route that now stamps
`'user'`.

## Testing

- Unit — `deriveThreadName`: summary present; prompt-only; prompt with
  XML-ish/tool noise skipped; whitespace collapse; 48-char word-boundary
  cut; empty transcript → null; codex format.
- Unit — db: `setAutoLabel` no-ops on `'user'`/`'auto'` rows (race guard);
  creation stamps `'user'` vs `'default'`; rename stamps `'user'`.
- Unit — trigger: debounce (N signals → 1 attempt), 3-attempt cap,
  shell exclusion.
- Integration (isolated daemon per the verify skill): create an unnamed
  claude-code thread with a seeded transcript file, POST a
  `UserPromptSubmit` hook event, poll GET the terminal until the label is
  the derived name and `label_source` behavior holds; then PATCH a rename
  and POST more events — label must never change again.

## Non-goals

- Backfilling existing threads (decision 4).
- LLM-generated titles.
- Renaming on later conversation shifts (decision 2).
- Naming shell threads.
