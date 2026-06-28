# Structured (stream-json) Claude Thread + Live View — Design

**Date:** 2026-06-28
**Status:** Approved (design) — pending user review
**Program context:** Slice 1 (increments ① + ②) of the Overseer architecture (`docs/superpowers/notes/2026-06-28-overseer-architecture.md`). It builds the substrate everything else rides on. Later slices: ③ human-answered prompts, ④ autonomy dial, ⑤ the Overseer.

## Problem

Today a Claude/Codex thread runs as the CLI in a **PTY**, and View mode **reconstructs** the conversation by polling the JSONL transcript (`api.getConversation` every 1–2.5s). That's laggy, fragile to parse, and structurally blind to pending interactive prompts (a pending `AskUserQuestion` isn't written to the transcript until answered — which is why interactive answering had to be reverted). A spike (2026-06-28, confirmed green) showed the Claude CLI can instead be driven over a **stream-json control protocol** on stdio — a live, structured, bidirectional event channel — **while keeping subscription billing** (no API key, no PTY). This slice introduces that as a new thread transport and renders View live from it.

## Goal

A new, **opt-in "structured" transport** for Claude threads (alongside the existing PTY transport, which is untouched): the daemon drives `claude` over stream-json, auto-allows tool permissions **at parity with today** (zero behavior change in autonomy), streams the structured events to the web, and View renders them **live**. Deliverable: creating a structured Claude thread gives a live, structured, no-poll View built on the rich tool-views we already have.

## Decisions (from brainstorming)

- **Alongside PTY, opt-in** — a new transport, not a replacement; existing PTY threads are completely unchanged. Validate before ever flipping the default.
- **Claude-only** this slice; Codex (`exec --json`) is a fast-follow.
- **Parity permissions** — the control loop **auto-allows** every `control_request` (and auto-answers nothing else), so a structured thread is exactly as autonomous as today's `--dangerously-skip-permissions` PTY thread. Human-answered prompts + an autonomy dial are explicitly later slices (③/④).
- **Structured threads are View-only this slice** — no raw terminal for them yet (the PTY half was deferred). Interrupt/redirect of the agent still works via the control channel from the View's compose box.
- **Transport is a thread config flag**, not a new `TerminalType` — a `claude-code` thread with `config.transport: "structured"` — to minimize type-system ripple. The `+` menu offers "Claude (structured)".
- **Push, not poll** — events reach the web over a per-thread websocket (mirroring the existing terminal ws), with a buffered replay on connect.

## Architecture / components

Mirror the existing PTY trio (`pty/manager.ts` `PTYManager`, `pty/buffer.ts` `RingBuffer`, `ws/terminal.ts`).

**`StructuredSessionManager` (core, new — `src/structured/manager.ts`)**
- One child process per structured terminal. Spawns (spike-verified invocation):
  ```
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --permission-mode default --permission-prompt-tool stdio
  ```
  cwd = workDir; env = the same `childEnv` PTYManager builds (inherits daemon env incl. the bundled-tools PATH + Doppler → subscription auth, `apiKeySource:"none"`).
- Reads stdout **NDJSON line-by-line**; parses each event; on a `control_request{subtype:"can_use_tool"}` writes an **auto-allow** `control_response` to stdin (`{behavior:"allow", updatedInput:<echo input>}`) — parity. Every parsed event is appended to a per-thread **ring buffer** and emitted to subscribers (EventEmitter, like PTYManager emits `data`).
- `sendUserMessage(terminalId, text)` → writes `{"type":"user","message":{"role":"user","content":text}}` to stdin.
- `interrupt(terminalId)` → writes the `interrupt` control_request (available per the spike) — used by the View's stop control.
- Lifecycle: spawn on structured-thread open/create; keep alive; kill + cleanup on close/crash. Records the captured `session_id` (from the `init` event) for resume.
- **Multi-turn (must verify first in the plan):** prefer ONE long-lived process fed multiple user turns over the open stdin (streaming input — how the Agent SDK does multi-turn). If the pinned CLI exits after the first `result` (one-shot `-p`), fall back to **one process per turn resumed via `--resume <session_id>`**, reusing the captured id. The manager's interface stays the same either way.

**Wiring (core)**
- `sessions/service.ts` `spawnTerminal`: branch on `config.transport === "structured"` → use `StructuredSessionManager` instead of `ptyManager.spawn` (provider command built with the structured flags). All other spawn context (workDir, env, integrations/tools) unchanged.
- `ws/structured.ts` (new, mirror `ws/terminal.ts`): `/api/terminals/:id/structured-ws` — on connect, **replay the ring buffer** then stream live events; carries parsed event objects (JSON frames).
- `routes/terminals.ts`: `POST /api/terminals/:id/message` `{text}` → `sessionService` → `manager.sendUserMessage`; `POST …/interrupt` → `manager.interrupt`. (Distinct from the keystroke `/input` route, which stays for PTY.)

**Web**
- `api/client.ts`: `sendStructuredMessage(id, text)`, `interruptStructured(id)`, and a structured-events ws opener (mirror the terminal-socket).
- View: for a structured thread (tab `config.transport === "structured"`), `ConversationView` subscribes to the structured ws, folds events into the existing render model, and **reuses the rich tool-views** (query/diff/todo/web) built earlier. The compose box calls `sendStructuredMessage` (not the PTY `sendInput` keystroke path). No polling for structured threads.
- `+` menu (`NewTabMenu`): a "Claude (structured)" option that creates a `claude-code` thread with `config.transport:"structured"`.
- Existing PTY threads' View/Terminal are **unchanged**.

## Data flow

Create structured thread → core spawns `claude` (stream-json) → `init` event (captures session_id, confirms `apiKeySource:"none"`) → assistant/thinking/tool_use/tool_result events → ring-buffer + broadcast → View renders live. User types → `POST /message` → manager writes user-turn to stdin → more events. `control_request` (permission) → manager auto-allows → execution proceeds (parity). Stop → `POST /interrupt`.

## Validated protocol (reference — spike 2026-06-28, `claude 2.1.195`)

Events: `system`(init/hook/thinking) · `assistant`(thinking|text|tool_use) · `user`(tool_result) · `control_request` · `control_response` · `rate_limit_event` · `result`(success: is_error, num_turns, total_cost_usd, usage). Permission round-trip: `control_request{request_id, request:{subtype:"can_use_tool", tool_name, input, tool_use_id}}` → `control_response{response:{subtype:"success", request_id, response:{behavior:"allow", updatedInput}}}`. **The `--permission-prompt-tool stdio` flag is undocumented** (what the SDK injects); without it gated tools silently auto-deny with no event → **pin the `claude` version + ship a smoke test.**

## Error handling

- **Process crash / nonzero exit:** mark the thread errored, surface to the View, allow respawn; never crash the daemon (wrap in try/catch like the push/status services).
- **Missing/auto-deny (flag regression):** the version smoke test catches it at build; at runtime, if no events arrive / tools silently deny, surface a clear "structured transport unavailable — use a PTY thread" state.
- **Malformed NDJSON line:** skip + log (don't crash the parser).
- **WS reconnect:** ring-buffer replay makes reconnect lossless for the buffered window; JSONL remains the durable transcript for deeper history.

## Testing

- **Core `StructuredSessionManager`:** drive it against a **fake `claude`** (a small script that emits recorded NDJSON from the spike + reads stdin) — assert: events parsed + buffered + emitted; `control_request` → auto-allow `control_response` written to stdin; `sendUserMessage` writes the correct user-turn JSON; crash handling. No network, hermetic.
- **Version smoke test:** a test that runs the real `claude --help`/a 1-line stream-json round-trip to assert the pinned version still accepts `--permission-prompt-tool stdio` and emits the expected `init`/`result` shapes (gated so it skips cleanly if `claude` is absent in CI).
- **Routes:** `POST /message` + `/interrupt` call through to the manager (supertest + a stubbed manager).
- **Web:** View renders assistant/tool events from a **mocked structured ws** stream; compose box calls `sendStructuredMessage`; structured threads do not poll.
- **Manual:** create a structured Claude thread, watch a real task stream live in View, send a follow-up message, confirm parity autonomy (tools run without prompting) and live rendering with the rich tool-views.

## Out of scope (later slices)

③ Human-answered permissions + AskUserQuestion from View · ④ autonomy dial (policy on `can_use_tool` + `set_permission_mode`) + dialectic co-driving · Codex structured transport · raw-PTY/raw-shell for structured threads · resume-based View⇄Terminal backbone toggle · ⑤ the Overseer surface · JSONL-history merge into the structured View (beyond the ring-buffer window).

## Risks

1. **Undocumented flag** `--permission-prompt-tool stdio` — pin version + smoke test.
2. **Multi-turn mechanism** (persistent stdin vs `--resume` per turn) — verify as the first plan task; the manager interface is designed to absorb either.
3. **Coexistence** with existing PTY plumbing — the transport flag keeps the branch localized to `spawnTerminal` + the new ws/route; existing paths untouched.

## Decision

Introduce a `StructuredSessionManager` + a per-thread structured-events ws + a structured message/interrupt route, gated by a `config.transport:"structured"` flag, with the View rendering live from the stream and **parity auto-allow permissions**. It mirrors the existing PTY trio, changes nothing about PTY threads, keeps subscription billing, and lays every rail the interactive/autonomy/Overseer slices need.
