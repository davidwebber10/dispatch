# Dynamic Transport — Codex Pretty + live CLI↔Pretty switching

**Date:** 2026-07-16
**Status:** Approved — ready for implementation
**Depends on:** the unified New Thread modal (merged, `main` @ v1.3.0) which already emits
`config.transport='structured'` for both harnesses behind `CODEX_PRETTY_ENABLED`.

## Motivation

Today `transport` is a fixed creation-time property, and only `claude-code` has a
`structured` (Pretty) transport. This spec makes `transport` a **switchable dimension**
and gives **Codex** a structured transport, via three linked pieces:

1. **Shared structured contract** — one interface both managers satisfy.
2. **Codex Pretty** — a `CodexStructuredSessionManager` over the `codex app-server` protocol.
3. **Live CLI↔Pretty switch** — restart-with-resume, on an already-running thread.

The frontend does **not** change: both managers emit the *same Claude-shaped event stream*
the `ChatView` + structured ws already consume.

---

## 1. Shared structured contract

Extract the public surface of the existing `StructuredSessionManager`
(`packages/core/src/structured/manager.ts`) into an interface `IStructuredManager`:

- **Methods:** `spawn(terminalId, opts)`, `sendMessage(id, content, source?)`,
  `answerPermission(id, requestId, decision)`, `setEscalate(id, bool)`, `interrupt(id)`,
  `compact(id)`, `getPending(id)`, `getSessionId(id)`, `getEvents(id)`,
  `getEventsTail(id, n)`, `isAlive(id)`, `kill(id)`, `killAll()`.
- **Emitted events (unchanged, Claude-shaped):** `event`, `session`, `permission`,
  `idle`, `scheduled`, `busy`, `resolved`, `exit`, `message-source`.

The existing manager is renamed/kept as `ClaudeStructuredSessionManager implements
IStructuredManager`. `SessionService` holds **both** and picks by `terminal.type`:

```
private structuredManagerFor(type): IStructuredManager | undefined
  claude-code → claudeStructured
  codex       → codexStructured   (only when CODEX_PRETTY_ENABLED)
```

Everywhere `service.ts` currently calls `this.structuredManager?.…`, route through
`structuredManagerFor(terminal.type)`. Un-gate the two structured checks
(`service.ts:1203`, `:1205`, and the sweep-side `:1335`/`:1390`) from
`type === 'claude-code'` to "has a structured manager for this type."

## 2. Codex Pretty — `CodexStructuredSessionManager`

Implements `IStructuredManager` but its payload is the **codex app-server JSON-RPC v2**
protocol instead of Claude stream-json. **One shared app-server connection**, multiplexed
by `ThreadId` (the protocol is thread-multiplexed — one server, many threads, events tagged
by thread). Internal `Map<terminalId, { threadId, pending, escalate, events, … }>`.

### Connection model
- Spawn a single `codex app-server` subprocess for the daemon and speak JSON-RPC over its
  stdio. **Spike #1:** confirm the exact invocation for a stdio JSON-RPC channel (base
  `codex app-server` stdio vs `codex app-server daemon` + `codex app-server proxy` over the
  unix control socket). Reference: the TUI's `--remote unix://…` connects to this server.
- Handshake once with `initialize` (InitializeParams).
- Crash recovery: if the app-server exits, respawn it and `thread/resume` every live thread
  by its `ThreadId` (mirrors the Claude daemon-restart resume path).

### Protocol mapping (v2)  — regenerate bindings with `codex app-server generate-ts --out`
| `IStructuredManager` | codex app-server v2 |
|---|---|
| `spawn` (new) | `initialize` (once) → `thread/start` (`ThreadStartParams`: model, cwd) |
| `spawn` (resume, external_id set) | `thread/resume` (`ThreadResumeParams` w/ `ThreadId`) + `thread/read` to backfill the ring |
| `sendMessage(content)` | `turn/start` (`TurnStartParams`); `turn/steer` if a turn is already running |
| assistant text → `event` | `item/agentMessage/delta` (`AgentMessageDeltaNotification`) |
| thinking → `event` | `item/reasoning/textDelta` · `item/reasoning/summaryTextDelta` |
| tool output → `event` | `item/started` · `item/completed` · `item/commandExecution/outputDelta` · `item/fileChange/patchUpdated` |
| `idle` (turn boundary) | `turn/completed` (`turn/started` → emit `busy`) |
| `session` (capture external_id) | `thread/started` → `ThreadId`; persist as `terminal.external_id` |
| `permission` pending → allow/deny | ServerRequest `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` → respond with `ReviewDecision` (approve/reject). Same escalate/auto-allow membrane as Claude; `item/tool/requestUserInput` is the AskUserQuestion analogue and always surfaces. |
| `interrupt` | `turn/interrupt` |
| `compact` | `thread/compact/start` |
| token usage (optional) | `thread/tokenUsage/updated` |
| `exit` | app-server process exit |

**Translation layer is the ONE place** Codex-shaped events become Claude-shaped `event`
objects the `ChatView` renders — keep it isolated so a protocol bump is a single-file fix.
The synthetic `user`-echo behavior (manager.ts `sendMessage`) is reproduced so the user's
bubble appears + replays.

### Provider wiring
- Add `codexProvider.buildStructuredCommand?()` returning the app-server spawn command.
- `SessionService.spawnStructured` dispatches to the right manager; keep the model
  (`config.model` → `--model`) and MCP/secrets wiring parity.

## 3. Live CLI ↔ Pretty switch

New service method `switchTransport(terminalId)` and route
`POST /api/terminals/:terminalId/transport` `{ transport: 'structured' | 'pty' }`:

1. **Guard:** thread is `claude-code`|`codex`, is **idle** (not mid-turn), and has an
   `external_id` (else 409 with reason — a brand-new thread can't resume yet).
2. If busy, `interrupt` first and await the turn boundary (or reject — decision below).
3. Kill the current process/connection for this terminal.
4. **Merge** `config.transport` (structured ↔ absent) via the read-merge-write path — never
   clobber the config blob (reuse the `setAutoArchive`-style merge; unrelated keys like
   `model`, `role`, `pinned` must survive).
5. Re-spawn **resuming** `external_id` in the new transport (structured backfills history via
   the ring/`thread/read`; PTY resumes via `claude --resume` / `codex resume`).
6. Emit `terminal:removed`/`session:tabs-changed` as needed; the frontend swaps
   ChatView↔xterm off `config.transport` on the next tabs reload.

Works for **Claude immediately**; for **Codex once #2 lands**.

### UI
A new **CLI ⇄ Pretty** control (distinct from the existing View/Terminal `ModeToggle`,
which is a frontend-only PTY render preference). Placed on active claude/codex threads
(e.g. beside `ModeToggle` in `TabHost`). Disabled with a tooltip until `external_id` exists;
calls `api.switchTransport(id, target)` then `loadTabs`.

## Phasing

- **Phase A — shared contract + Claude live-switch.** `IStructuredManager` extraction,
  `switchTransport` + endpoint + UI, Claude CLI↔Pretty proven end-to-end. High confidence.
  Ships a real win with zero Codex risk.
- **Phase B — Codex Pretty.** `CodexStructuredSessionManager` + app-server integration +
  translation. Behind `CODEX_PRETTY_ENABLED`. Time-box Spike #1 (connection model); if the
  app-server proves intractable, land A + a findings report, keep the flag off.
- **Phase C — enable Codex.** Flip `CODEX_PRETTY_ENABLED`; Codex live-switch falls out of A+B.

## Decisions

- **One shared app-server connection**, routed by `ThreadId` (matches the protocol's
  multiplexed design; single reconnect+resume path). *(Updated from the earlier
  per-thread-process default after reading the protocol.)*
- **New translating manager**, not a generalized one — protocols differ; they converge at
  the shared *event* interface, not the implementation.
- **Idle-only switching**, `external_id`-gated. Decision: if busy, interrupt-then-switch
  (preferred) rather than reject — confirm during Phase A.
- **Ship behind `CODEX_PRETTY_ENABLED`**, flip only after a real Codex-Pretty thread streams
  + approves end-to-end against an isolated daemon.

## Risks

- `codex app-server` is **experimental** — protocol may shift between Codex versions.
  Mitigation: assert `codex --version` at manager init, regenerate bindings at build time,
  isolate the translation layer, and keep Codex Pretty behind the flag.
- Approval semantics differ (Codex has typed approvals: exec/patch/permissions/user-input) —
  map each to the single pending-permission channel; `requestUserInput` = AskUserQuestion.

## Testing & verification

- Unit: translation layer (Codex notification → Claude-shaped event) with fixture frames;
  `switchTransport` guards (idle/external_id) and config-merge (unrelated keys survive).
- Reuse the Claude structured manager test patterns for the Codex manager (fake app-server
  emitting canned JSON-RPC frames — a test seam like `structuredCommandOverride`).
- E2E via the `verify` skill (isolated daemon, fake HOME, non-default PORT): a Claude thread
  switched CLI→Pretty→CLI keeps its conversation; (Phase B) a Codex-Pretty thread streams a
  turn and surfaces an approval. Never touch the real `~/.dispatch` / `~/.codex`.
- Full suites + tsc + `vite build` green before each phase's commit.

## Spike notes for the implementer

- Bindings generated to scratchpad `codex-appserver/` (89 files); regenerate into the repo
  (gitignored) via `codex app-server generate-ts --out`. Key unions: `ClientRequest.ts`,
  `ServerNotification.ts`, `ServerRequest.ts`; params under `v2/*Params.ts`.
- Confirm the stdio/socket connection invocation (Spike #1) before building the manager.
- Confirm `turn/start` content shape (`AgentMessageInputContent`/`ContentItem`) and the
  `ReviewDecision` response envelope for the approval ServerRequests.
