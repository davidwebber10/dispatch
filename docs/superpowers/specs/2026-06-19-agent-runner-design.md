# Dispatch Agent Runner — Design Spec

**Date:** 2026-06-19
**Branch:** `feat/agent-runner` (worktree of `~/Sites/dispatch`)
**Scope decision:** *Engine only* — build the runner engine + full UI to a high bar. No
bespoke integrations or starter agent templates. The "check Google Webmaster Tools every
morning" example is treated as the *archetype* an engine should make trivial via a prompt,
not a feature to wire.

## Goal

Turn Dispatch's already-headless agent runner into a **true autonomous, observable,
outcome-driven runner**: when an agent runs it executes a prompt to completion without
stopping to ask questions, and the UI shows **the steps it's taking, rendered nicely,
alongside the full activity output**, plus real per-run **analytics** (duration, success,
tokens, cost).

## Current state (what already exists — do NOT rebuild)

- **Headless execution.** `runNow()` → `createRunnerTerminal()` → `spawnTerminal()` (runner
  branch) → `provider.buildRunnerCommand()` → `ptyManager.spawn()`. Prompt passed on argv.
  - Claude: `claude --dangerously-skip-permissions --verbose --print <prompt>`
  - Codex: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check <prompt>`
- **Completion** via PTY exit code → `handleTerminalExit()`: 0 ⇒ `succeeded`, non-zero ⇒ `failed`.
- **Recurrence** (`agents/recurrence.ts`): timezone-aware (Intl, DST-correct), modes
  manual / interval / daily / weekly / cron + one-shot, custom 5-field cron parser. Solid.
- **Scheduler tick**: `setInterval(processDueRuns, 30_000)` in `startServer()`.
- **UI**: agents folded into project cards (`ProjectCard` AGENTS section → `AgentPane` →
  `AgentDashboard` | `RunnerView`); `EditAgentModal` supports all 5 schedule modes with
  weekday pills + live cron preview.
- **Events bus**: single `/api/events` WS broadcasting `agent:schedule-*` and `agent:run-*`
  (`agent:run-created`, `agent:run-updated`) with the full run/schedule payload.

## The delta to build

### 1. Structured execution (stream-json) + parser

Change `buildRunnerCommand` to emit structured JSONL:

- **Claude:** `['--dangerously-skip-permissions', '--verbose', '--output-format', 'stream-json', '--print', <prompt>]`
  (`stream-json` with `-p` requires `--verbose`). Emits newline-delimited JSON:
  - `system`/init → `session_id`, `model`, `tools`, `cwd`
  - `assistant` → `message.content[]` blocks: `{type:'text'}` and `{type:'tool_use', name, input}`
    (TodoWrite arrives as `tool_use` named `TodoWrite` with `input.todos`), plus per-message `usage`
  - `user` → `{type:'tool_result'}`
  - `result` → `subtype`, `result` (final text), `total_cost_usd`, `usage`, `duration_ms`,
    `num_turns`, `is_error`
- **Codex:** `['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', <prompt>]`
  → JSONL thread/turn/item events (agent messages, command executions, token usage, completion).

**`RunStreamParser`** (new, `packages/core/src/agents/run-stream.ts`):
- Pure, transport-agnostic: `feed(chunk: string) → RunEvent[]`. Buffers partial lines, strips
  `\r`, `JSON.parse`es complete lines, **skips** unparseable lines (robust to PTY framing).
- Normalizes provider-specific JSON into a **provider-agnostic `RunEvent`** union:
  `init`, `assistant-text`, `tool-use`, `tool-result`, `todos`, `usage`, `result`.
- Unit-tested with captured fixtures for both providers (TDD — this is the riskiest piece).

**Wiring:** add a parser instance per *runner* terminal, fed from `ptyManager.on('data')`
(parallel to `TerminalMonitor`). For runner terminals, the parser is authoritative for run
status; suppress `updateRunFromTerminalActivity` busy/idle for runner terminals so a thinking
pause is never misread as `idle`. On the `result` event, call a new
`AgentService.finalizeRun(terminalId, summary)` capturing cost/tokens/model/turns/result/isError;
`handleTerminalExit` remains the crash fallback (`is_error || exitCode!==0 ⇒ failed`).

### 2. Persistence (durable runs)

**Schema migration** (idempotent `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info`)
on `agent_runs`:
`cost_usd REAL`, `total_tokens INTEGER`, `input_tokens INTEGER`, `output_tokens INTEGER`,
`model TEXT`, `num_turns INTEGER`, `result_text TEXT`, `transcript_path TEXT`, `exit_code INTEGER`.

**Transcript file:** append each raw JSONL line to `~/.dispatch/runs/<runId>.jsonl` as it
streams. Store the path on the run. This survives ring-buffer eviction + restarts and powers
the runner view for *completed* runs.

### 3. WebSocket events

- Enrich `agent:run-updated` payload (via `toRun`) with the new fields (cost/tokens/model/turns/result).
- New low-frequency event `agent:run-step` `{ runId, terminalId, step }` where `step` is a
  normalized `RunStep` (kind: `tool` | `todos` | `assistant` | `result`, title, detail, ts).
  Emitted per parsed content block — volume is per-tool-call/turn, not per-token. Client
  filters by `runId`. (Events bus is broadcast-to-all; acceptable at this volume.)

### 4. API

- `GET /api/agents/runs/:id/events` → replays the persisted transcript as `RunStep[]` for
  completed runs (live runs use the WS stream + this for backfill on open).
- Existing run/schedule endpoints unchanged.

### 5. Runner view (the marquee feature)

Rebuild `RunnerView.tsx` body (keep its header: back, live status pill, name, started+duration,
Stop). Layout matches the design language (section 05 tokens):

- **HUD strip** — model · tokens · cost · turns · elapsed (mono labels, live).
- **STEPS / PLAN panel** — a vertical timeline of `RunStep`s:
  - `tool` → icon (Phosphor) + tool name + summarized input (e.g. `Bash: npm test`, `Edit: src/x.ts`).
  - `todos` (TodoWrite) → a checklist with pending/in_progress/completed states (the agent's plan).
  - `assistant` → reasoning/notes turns.
  - `result` → final outcome banner (success/failure + result text).
  - Live-updating; auto-scroll with "jump to latest".
- **ACTIVITY / TRANSCRIPT panel** — the full rendered log of every event ("the full output of
  the activity"), with a **Raw** toggle. For completed runs, hydrated from
  `GET /runs/:id/events`; for live runs, appended from the `agent:run-step` stream.

Data source: the `/api/events` WS (live steps + status) + the events endpoint (history). The
raw-PTY terminal is no longer the runner body (it would show JSONL); offer it only behind the
Raw toggle if useful.

### 6. Analytics (dashboard parity with design §05)

- `agentStats.ts`: add `totalCost`, `avgCost`, `totalCost30d`, `totalTokens`, `avgTokens`.
- `AgentDashboard.tsx`: KPI tiles → **Total Runs, Success Rate, Avg Duration, Avg Cost,
  Total Cost · 30d** (5 tiles, design §05). Recent-runs table → add **Cost** and **Tokens**
  columns. Promote schedule into its **own card** beside Trigger Prompt. Run-history chart:
  keep duration-height + outcome-color; legend (passed/flagged/failed).
- `api/types.ts` `AgentRun`: add the new fields; `stores/agents.ts` carries them through.

## Design tokens (from `docs/design/dispatch-web-client.dc.html` §06)

Backgrounds: Canvas `#08080A`, Base `#0F0F11`, Pane `#141416`, Card `#161618`, Elevated
`#1B1B1E`, Hover `#26262B`, Border `#29292E`/`#26262B`, hairline `#1d1d21`. Accent green
`#3ECF6A` (on-text `#08240f`), yellow `#F5C542`, red `#F0616D`. Text `#E9E9EC`/`#8E8E96`/`#5A5A61`.
Chart: passed `#2f9e54`, flagged `#caa83a`, failed `#e0616d`. Fonts: IBM Plex Sans (chrome),
JetBrains Mono (paths/code/labels/metrics). Use existing Phosphor icons (Play, Clock, Robot,
MagnifyingGlass, Plus, Gear, CaretLeft/Right/Down, Check, Wrench, ListChecks).

## Testing & verification

- **Unit (TDD):** `RunStreamParser` (provider fixtures → normalized events), `agentStats`
  cost aggregates, schema migration idempotency.
- **No self-deploy.** This session runs *inside* the live MacBook daemon; restarting it
  (`dispatch restart`/`install`) kills the session. Verify locally by running a **second**
  server instance on a spare port with a throwaway data dir
  (`DISPATCH_DATA_DIR`/port override), never by restarting the live daemon. Optionally deploy
  to the **mini** via `ssh mini` for a real end-to-end check.
- Run the existing core + web test suites; keep them green.

## Risks

- **JSONL through a PTY** — mitigated by a line-buffering parser that strips `\r` and skips
  unparseable lines; long JSON lines survive (terminal width does not insert breaks into the
  byte stream). If it proves flaky, fall back to a piped `child_process` runner path
  (`spawnTerminal` already branches on `config.runner`).
- **stream-json schema drift** between CLI versions — normalize defensively; ignore unknown
  event types.
- **Events bus has no rooms** — fine at step-event volume; client filters by `runId`.

## Build sequence

1. `RunStreamParser` + fixtures (TDD).
2. Schema migration + `db/agents.ts` writers/readers + `toRun` fields.
3. Provider `buildRunnerCommand` → stream-json/json; parser wiring in server; transcript
   persistence; `finalizeRun`; status authority for runner terminals.
4. `agent:run-step` event + `GET /runs/:id/events`.
5. Frontend: types/store/api → `RunnerView` (steps + activity + HUD) → `AgentDashboard`
   analytics + `agentStats`.
6. Tests green; local second-instance smoke; (optional) mini deploy.

**Deployment note:** this lands in `feat/agent-runner` on `~/Sites/dispatch`; it deploys live
by merging to `main` + `dispatch update` (mini) and last, the MacBook.
