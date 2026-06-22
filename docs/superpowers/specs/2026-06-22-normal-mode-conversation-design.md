# Normal Mode — rendered conversation view for AI threads

**Date:** 2026-06-22  **Branch:** main (deploy: mini web rebuild + daemon restart for the new endpoints)

## Goal
Each AI thread (Claude Code; Codex later) gets two views, toggled in the thread header:
- **Expert Mode** — the raw terminal (today's `TerminalTab`).
- **Normal Mode** — a clean, chat-style conversation **live-tailed from the session's transcript
  JSONL**, with a chat input that writes to the *same live session*, a **Stop** button while it's
  responding (interrupt the turn), and **queueing** (sending while busy holds the message and
  auto-sends when the turn finishes).

Both views drive the one live PTY session, so the user can flip between them freely.

## Decisions (confirmed)
- Source = **tail the live transcript** (not a separate engine).
- Input = **chat box → live session**, **+ Stop**, **+ queue-while-busy**.

## Transcript format (sampled from `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl`)
JSONL; relevant entries: `{type:'user', message:{role:'user', content: <string> | [{type:'text'}] |
[{type:'tool_result', tool_use_id, content, is_error}]}, isMeta?, timestamp, uuid}` and
`{type:'assistant', message:{role:'assistant', content:[{type:'thinking'|'text'|'tool_use', …}], usage}, timestamp, uuid}`.
Ignore: `last-prompt`, `mode`, `permission-mode`, `attachment`, `file-history-snapshot`, and `isMeta` users.

## Backend
- **`packages/core/src/conversation/transcript.ts`** — `parseClaudeTranscript(text): ConvItem[]`.
  `ConvItem = { kind:'user'|'assistant'|'thinking'|'tool'|'tool-result', text?, toolName?, toolTitle?,
  toolDetail?, isError?, ts?, uuid? }`. Pure, line-buffered, skips unparseable/meta lines.
  Tool title/detail mirror the RunStreamParser conventions (Bash→command, Write/Edit→basename, etc.).
- **Locate the file** — `~/.claude/projects/<workingDir.replace(/\//g,'-')>/<terminal.external_id>.jsonl`.
- **`GET /api/terminals/:id/conversation?since=<n>`** — read the file, split complete lines, parse
  `lines[since..]`, return `{ items, cursor }` (cursor = complete-line count). Claude-only for now;
  others → `{ items: [], cursor: 0, unsupported: true }`. Never errors on a missing file (empty).
- **`POST /api/terminals/:id/input` `{ data }`** — write raw bytes to the PTY via
  `sessionService.writeInput(id, data)` → `ptyManager.write`. Used for **send** (`msg\r`) and
  **interrupt** (`\x1b` Esc). Add `writeInput` to SessionService.
- Mount both in `createApp` + `startServer` (extend `routes/terminals.ts`).

## Frontend
- **`ConversationView`** (`components/tabs/ConversationView.tsx`, props `{ terminalId }`):
  - Loads `GET /conversation`, then **polls** for new items (cursor-incremental): ~2.5s idle, ~1s
    while the thread is busy. Dedup/append by cursor.
  - Renders items as chat: user (distinct, right/elevated), assistant **markdown** (reuse
    `lib/markdown.ts`), tool calls as compact chips, tool-results collapsible, thinking subtle.
  - **Busy state** from the activity store (`terminal:activity` busy/idle keyed by terminalId) →
    a "working…" typing indicator + drives Stop/queue.
  - **Composer:** textarea + Send. Idle → Send writes `msg\r` via `POST /input`. Busy → button becomes
    **Queue**; queued messages held and flushed (sent) on busy→idle. **Stop** button shows while busy →
    `POST /input { data: '\x1b' }`.
- **Mode toggle** in the thread header (`TerminalTab`/`TabHost` header): `Normal | Expert` segmented
  control for `claude-code`/`codex` tabs (Codex: Normal disabled with a tooltip for now). Per-thread
  mode persisted in a small `ui`/tabs store (default **Normal** for AI threads, Expert for shell).
- Expert Mode = the existing `TerminalTab` unchanged.

## Out of scope (v1)
Token-by-token streaming (the transcript lands per message, so Normal Mode updates per turn + shows a
typing indicator); Codex transcript parsing (Expert-only until its format is wired); editing/retry.

## Testing
- Unit: `parseClaudeTranscript` against a synthesized fixture (user string prompt, assistant
  thinking+text+tool_use, user tool_result, meta-skip, partial-last-line). Route: conversation endpoint
  (missing file → empty; incremental `since`), input endpoint (writes to a stub PTY). Keep suites green.

## Deploy
Backend endpoints need `dispatch build` + restart on each host (MacBook restart ends the session — last).
Web rebuild for the mini (primary) without restart where possible; the new endpoints require the mini
daemon restart too (safe).
