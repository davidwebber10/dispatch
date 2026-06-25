# Claude Code thread: name-on-create, resume recent, branch — Design

**Date:** 2026-06-25
**Status:** Approved; ready for implementation
**Scope:** Claude Code threads only (Codex/shell/etc. keep instant creation). Codex resume/branch is a follow-up.

## Goal

When launching a Claude Code thread, open a modal to (1) name it and (2) resume a recent
session for this project's folder. Add a right-click **Branch** that forks a thread's
conversation into a new thread (original untouched).

## Feasibility (confirmed)

- Resume already works: `createTerminal(externalId)` → provider `buildResumeCommand` → `claude -r <id>`.
- Sessions live at `~/.claude/projects/<workdir-with-/replaced-by->/<uuid>.jsonl`; the uuid is the session id.
- `claude --fork-session` exists ("When resuming, create a new session ID") → branch = `claude -r <id> --fork-session`.

## Feature 1 — New-thread modal

`NewTabMenu` "Claude Code" no longer creates instantly; it opens `NewClaudeThreadModal`:
- **Name** input (optional). Blank → backend default label.
- **Start new thread** button → `createTerminal({ type:'claude-code', label })`.
- **Resume** list: this project's recent sessions, each row = preview (first user message) + relative time + message count → `createTerminal({ type:'claude-code', label, externalId })`.

Backend `GET /api/sessions/:id/cc-recent` → reads the session's `workingDir`-encoded project dir,
returns `[{ id, mtime, preview, messageCount }]` newest-first, cap 20. Unparseable files skipped.

## Feature 2 — Branch

Thread context menu (claude-code only) gains **Branch**:
- `POST /api/terminals/:id/branch` resolves the source thread's session id (`external_id`, or the
  existing `recoverSessionId` fallback), creates a new terminal with `config.branchFrom = <sourceId>`
  and label `"<source label> (branch)"`, returns it. 422 if the source id can't be resolved yet.
- Spawn: when a terminal has no `external_id` but `config.branchFrom`, the provider builds
  `claude … -r <branchFrom> --fork-session` (new `buildBranchCommand`). `captureSessionId` records the
  NEW forked id as the terminal's `external_id`; later relaunches resume it normally. Original untouched.

## Components

**Core**
- `providers/types.ts` — add optional `buildBranchCommand({ sourceSessionId, workDir, secretsMcp, statusHooks })`.
- `providers/claude-code.ts` — implement `buildBranchCommand` = resume args + `--fork-session`.
- `sessions/cc-sessions.ts` (new) — `listRecentSessions(workDir, limit)` → enumerate + parse jsonl (first user message preview, message count, mtime).
- `sessions/service.ts` — spawn picks branch command when `!external_id && config.branchFrom`; add `branchTerminal(terminalId)`.
- `routes/sessions.ts` — `GET /:id/cc-recent`. `routes/terminals.ts` — `POST /:id/branch`.

**Web**
- `api/types.ts` + `api/client.ts` — `CcRecentSession` type; `recentCcSessions(sessionId)`, `branchTerminal(terminalId)`.
- `components/sidebar/NewClaudeThreadModal.tsx` (new) — name + resume list.
- `components/sidebar/NewTabMenu.tsx` — claude-code opens the modal; others unchanged.
- `components/sidebar/ProjectCard.tsx` — thread context menu adds "Branch" for claude-code → `api.branchTerminal` → open.

## Data flow

Modal → `recentCcSessions` (reads jsonl) → New/Resume → `createTerminal(±externalId)`.
Branch → `POST /branch` → service resolves source id → new terminal w/ `config.branchFrom` → spawn forks → captures new id.

## Error handling

- No recent sessions → modal shows only "Start new thread".
- Unparseable jsonl entries skipped.
- Branch before the source has a session id → 422 → toast "Let the thread start first, then branch."
- `--fork-session` assumed present (claude ≥ 2.x; verified 2.1.191).

## Testing

- Core unit: `cc-sessions` enumeration/parse (mock fs); `buildBranchCommand` args include `-r <id>` + `--fork-session`; `branchTerminal` sets `config.branchFrom` + resolves id.
- Route tests: `/cc-recent` shape; `/branch` creates a terminal with `config.branchFrom` (mock provider/spawn).
- Web: `NewClaudeThreadModal` renders New + resume rows from a mocked client; ProjectCard "Branch" present only for claude-code.

## Deploy

Core change (provider + routes) → one daemon restart to ship.
