# New Codex Thread Modal (parity with Claude) — Design

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

Creating a Claude Code thread opens `NewClaudeThreadModal` (name field + a "Resume recent" list of past Claude sessions for the project, resumable via `externalId`). Creating a Codex thread, by contrast, happens instantly from `NewTabMenu` with no name and no resume. We want a Codex equivalent with full parity: name + resume-recent.

## Goal

A `NewCodexThreadModal` that mirrors `NewClaudeThreadModal`: an optional name, a "Start new thread" action, and a "Resume recent" list of the project's recent Codex sessions (each resumes via `codex resume <id>`). Opened from the Codex item in `NewTabMenu`, exactly as Claude Code opens its modal.

## Architecture / components

**Backend — Codex session lister.** New `packages/core/src/sessions/codex-sessions.ts` with `listRecentCodexSessions(workingDir: string, limit?): CodexRecentSession[]`, mirroring `cc-sessions.ts` but for Codex's storage. Codex writes rollout files at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`; line 1 is `{"type":"session_meta","payload":{"session_id","cwd",...}}`, followed by `response_item` lines (messages with `role`/`content`). The lister: walks the sessions tree (newest dirs first), reads each file's `session_meta`, keeps files whose `cwd` equals `workingDir`, derives a `preview` from the first user message text and a `messageCount`, sorts by file mtime desc, returns up to `limit` (default 20). Shape matches Claude's: `{ id: string; mtime: number; preview: string; messageCount: number; truncated: boolean }`. Reads are best-effort: a malformed/unreadable file is skipped, never throws.

**Backend — route.** `GET /api/sessions/:id/codex-recent` in `routes/sessions.ts`, mirroring the existing `cc-recent` route: resolve the session's `workingDir`, return `listRecentCodexSessions(workingDir)`.

**Web — api + type.** `CodexRecentSession` type (identical fields to `CcRecentSession`); `api.recentCodexSessions(sessionId)` hitting `/api/sessions/:id/codex-recent`.

**Web — modal.** `NewCodexThreadModal.tsx`, a near-copy of `NewClaudeThreadModal`: title "New Codex Thread", loads `api.recentCodexSessions`, creates via `api.createTerminal(sessionId, { type: 'codex', label, externalId })`. The recent rows and the create/resume flow are identical in shape.

**Web — wiring.** In `NewTabMenu`, add an `onPickCodex` prop; the Codex item calls `onPickCodex()` (instead of instant `createTerminal`) exactly as the Claude item calls `onPickClaude`. `ProjectCard` gains a `newCodex` state and renders `<NewCodexThreadModal>` when set, mirroring the existing `newClaude` handling, and passes `onPickCodex` into `NewTabMenu`.

## Data flow

Codex item clicked → `onPickCodex()` → modal opens → `api.recentCodexSessions(sessionId)` → `/api/sessions/:id/codex-recent` → `listRecentCodexSessions(workingDir)` → list rendered. "Start new thread" → `createTerminal({type:'codex', label})`. "Resume" a row → `createTerminal({type:'codex', label, externalId:<session_id>})` → spawn uses the provider's `buildResumeCommand` → `codex resume <id>`.

## Error handling

Lister: unreadable/malformed rollout files skipped; empty result when none match. Modal: recent-load failure → empty list (no crash), mirroring the Claude modal's `.catch(() => setRecent([]))`. Create failure → unset busy (mirrors Claude modal).

## Differences from Claude (intentional)

- Resume mechanism is `codex resume <id>` (already implemented in `codex.ts` `buildResumeCommand`), vs Claude's `-r <id>`. No new provider work.
- No "branch" affordance in the modal (the Claude modal doesn't have one either; branching is a separate per-thread action and is out of scope here).
- Codex session storage is a dated rollout-file tree (parsed fresh from disk), not Claude's per-cwd projects dir — hence the separate lister; the returned shape is identical so the web layer is a thin mirror.

## Testing

- `codex-sessions` lister: unit test against a temp `~/.codex/sessions`-shaped fixture (a couple of rollout files with differing `cwd`) → asserts cwd filtering, preview/count extraction, recency sort, and that a malformed file is skipped without throwing.
- Route: `GET /api/sessions/:id/codex-recent` returns the expected shape (mirror the cc-recent route test).
- Web: `NewCodexThreadModal` renders the "Start new thread" action + recent rows from a mocked `api.recentCodexSessions` (mirror `NewClaudeThreadModal.test`).

## Decision

Mirror the Claude implementation file-for-file where possible (same shapes, same modal structure, same wiring pattern) so the two flows stay consistent and the Codex lister is the only genuinely new logic.
