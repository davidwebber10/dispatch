# Thread status & events — fresh implementation

**Date:** 2026-06-22  **Branch:** main (backend → daemon restart to deploy)

Replaces the byte-heuristic `TerminalMonitor` status + the dormant `buildHooksConfig` with a
provider-driven event system. Decisions (confirmed): **Codex = notify-based** (no app-server rework);
**surface status + a live activity label**.

## Normalized model
Per thread: `status ∈ starting | working | needs_input | idle | done | error`, an optional `activity`
string ("Running: npm test", "Editing app.ts", "Waiting for approval", "Subagent: Explore"), and
`updatedAt`. Persisted on `terminals.status` (mapped to the existing enum: starting/working→`working`,
idle/done→`waiting`, needs_input→`needs_input`, error→`error`) and broadcast on
`terminal:status { terminalId, status, activity }`.

## Event ingestion (server)
- **`packages/core/src/status/events.ts`** — pure normalizers, TDD:
  - `normalizeClaude(payload) → { status, activity, sessionId }` from `hook_event_name`
    (+ `notification_type`, `tool_name`, `tool_input`): SessionStart→starting; UserPromptSubmit→working;
    PreToolUse→working + activity=`<Tool> <arg>`; PostToolUse→working; Notification(permission_prompt)
    /PermissionRequest→needs_input; Notification(idle_prompt)/Stop→idle; SessionEnd→done;
    Stop/ToolFailure→error. `sessionId = payload.session_id`.
  - `normalizeCodex(payload) → { status, activity, sessionId }`: `agent-turn-complete`→idle,
    `sessionId = payload['thread-id']`. (notify only fires at turn end; "working" is set on input.)
- **`packages/core/src/status/service.ts`** — `StatusService.ingest(provider, terminalId, payload)`:
  normalize → if `sessionId` and the terminal has no `external_id`, **persist it immediately**
  (`terminalsDb.updateExternalId`) → persist mapped `terminals.status` → broadcast `terminal:status`
  (+ aggregate `session:status`). `markWorking(terminalId, activity?)` for the input edge.
- **`packages/core/src/routes/events.ts`** — `POST /api/events/:provider/:terminalId` (provider ∈
  claude|codex) → `StatusService.ingest`. 204. Mounted in createApp + startServer.

## Provider injection (spawn)
Thread a `statusHooks?: { claudeSettingsPath?: string; codexNotifyArgs?: string[] }` arg through
`spawnTerminal` → provider `build*` (mirrors the existing `secretsMcp` injection).
- **Claude:** `spawnTerminal` writes a per-terminal settings file `~/.dispatch/hooks/<terminalId>.json`
  with **command hooks** that `curl -s -X POST <serverUrl>/api/events/claude/<terminalId> -d @-`
  (event JSON arrives on the hook's stdin; `@-` posts it). Robust across versions (no reliance on the
  `http` hook type). Provider appends `--settings <path>`. Events: SessionStart, UserPromptSubmit,
  PreToolUse, PostToolUse, Notification, Stop, SessionEnd.
- **Codex:** provider prepends `-c 'notify=["node","<helper>","<terminalId>","<serverUrl>"]'` (verified
  per-invocation). Helper `packages/core/scripts/codex-notify.mjs` reads argv (terminalId, serverUrl,
  payload-as-last-arg) and POSTs to `/api/events/codex/<terminalId>`. Also mark `working` when the user
  sends input (Normal Mode composer / `writeToTerminal`).
- `SessionService.setStatusContext({ serverUrl, hooksDir, codexHelperPath })` set by `server.ts`
  (serverUrl = `http://127.0.0.1:<port>`).

## Replace the heuristic
`TerminalMonitor` stops writing `terminals.status` (the hooks are authoritative); it keeps scraping the
status bar for the cost/tokens HUD (`terminal:activity`). Heuristic remains only as a silent fallback.

## ID capture (the missing-ID fix)
Every Claude hook payload carries `session_id`; Codex `notify` carries `thread-id`. `ingest` persists
`external_id` from the first event that has one — so threads get linked at the source, no
filesystem polling. (Keeps the read-time recovery from the prior fix as a backstop for old threads.)

## Web
- `stores/threadStatus.ts` — `{ byTerminal: Record<id,{status,activity}> }` from `terminal:status`.
- Sidebar `StatusDot`/`ThreadRow` + Normal Mode indicator read it (working→pulse, needs_input→glow,
  idle→hollow, error→red). Normal Mode shows the `activity` label; sidebar shows the dot (+ tooltip).

## Testing
Unit: `normalizeClaude`/`normalizeCodex` (event→status/activity/sessionId, incl. permission vs idle);
`StatusService.ingest` (status persist, external_id captured on first event, broadcast). Route:
`POST /api/events/...` happy + id-capture. Keep suites green.

## Deploy
Backend → `dispatch build` + restart (mini via update; MacBook restart = session-ending, last).
