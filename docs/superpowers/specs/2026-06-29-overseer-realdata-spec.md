# Overseer — Real-Data Wiring Spec (Full Subsystem)

**Date:** 2026-06-29 · **Decision:** build the **Full subsystem** (Overseer-vision Phase 1), incrementally.
**Builds on:** the Overseer view (`packages/web/src/components/overseer/`, mock-data, shipped) + the structured stream-json substrate (`StructuredSessionManager`, `useStructuredChat`, the chat View).

## Product refinement (user, 2026-06-29)
- Switching to **Overseer mode** shrinks the left column to a **slim project picker**; selecting a project opens the Overseer for that project.
- The left list under the project = the **Overseer-managed agent threads** (auto added/removed by the coordinator, named appropriately) — not the user's manual Operator threads.
- Clicking a managed thread opens a **modal lightbox** of that worker's work rendered in the **structured-stream View** (the chat View we built — NOT a full terminal), so the user can **monitor at the worker level and interject** mid-work.
- ⇒ The structured chat View is the worker-monitor surface. Its quality (streaming, P0 fixes) is foundational here.

## Concept mapping (design → Dispatch)
| Overseer concept | Maps to | Status |
|---|---|---|
| **Coordinator** (you converse with; does no coding) | A structured terminal (`config.transport='structured'`, `config.role='coordinator'`) with a coordinator `--append-system-prompt`. One per project. | Substrate exists; needs `appendSystemPrompt` param + a find-or-create bootstrap. |
| **Conversation stream + composer** | The coordinator thread via `useStructuredChat(coordinatorId)` + `sendStructuredMessage`. | Reusable as-is (+ `ConvItem→StreamMessage` adapter). |
| **Typed agent thread** (planner/implementer/researcher/reviewer) | A child structured terminal tagged `config.agentType` + `config.mission` + a per-type system prompt. | Type/mission ride in `terminals.config` JSON (no migration for incr. 1; promote to table later). Status→ThreadStatus: working→working, needs_input→waiting, idle/archived→done. |
| **Worker lightbox** (monitor/interject) | A modal rendering `<ChatView terminalId={workerId}/>` (the structured View). | Reuse the chat View directly. |
| **Need / escalation** | Coarse: `needs_input` threads (live today). Rich: structured `control_request{can_use_tool}` + AskUserQuestion. | Coarse now; rich approve/deny/answer = incr. 3 (manager auto-allows today). |
| **Mission** | A `config.mission` tag (incr. 1) → a `missions` table (incr. 2). | New. |
| **Outcome** | A `done`/archived thread collapsed. | Status now; PR/diff later. |

## Increment roadmap (Full subsystem)
**Incr. 1 — Real coordinator + delegate + live wiring + worker lightbox** *(foundation; reuses substrate)*
- Backend: `appendSystemPrompt` on `buildStructuredCommand` (claude-code.ts) + pass-through in `service.ts` structured branch (map `config.agentType`→a per-type prompt constant; `config.role==='coordinator'`→coordinator prompt). A find-or-create coordinator helper per project (persist id in `app_state`).
- Web: live adapters (`overseer/live.ts`): `convItemsToStream`, `terminalToAgentThread(t,status)`, `groupByMission`, `needsFromThreads` (filter `needs_input`). Rewrite `overseer/store.ts` to source from `useProjects`(active) + `useTabs.byProject` + `useThreadStatus` + `useStructuredChat(coordinatorId)`, **keeping the `RenderVals` shape** so `overseer/components/*` are untouched. Wire composer→`sendStructuredMessage(coordinatorId)`, Delegate→`createTerminal(structured + agentType + mission)`, drill→worker lightbox `<ChatView>` , redirect→`sendStructuredMessage(workerId)`, interrupt→`stopTerminal`.
- Shell: Overseer-mode left column = slim project picker + managed-threads list (the `config.role!=='coordinator'` structured threads for the active project); click→worker lightbox modal.
- Defer: real approve/deny (buttons send a directive to the coordinator for now).

**Incr. 2 — Missions persistence:** `missions` table + `db/missions.ts` + routes; coordinator + threads reference `missionId`; mission CRUD in the rail.

**Incr. 3 — Interactive escalations (the membrane):** stop the auto-allow loop in `structured/manager.ts`; surface pending `control_request` / AskUserQuestion as real Need cards; a `control_response` endpoint (allow/deny + `updatedInput.answers`); wire need-card Approve/Deny/Answer. (Depends on the hidden `--permission-prompt-tool stdio` flag — pin + smoke-test.)

**Incr. 4 — Autonomy dial + interrupt:** `set_permission_mode` control (the autonomy dial) + `interrupt` exposed in the UI.

**Incr. 5 — Coordinator agency + polish:** a spawn/compress **tool** the coordinator calls (MCP/HTTP) so it auto-opens/closes typed threads + names them; conflict detection (a directive that contradicts the plan → conflict Need card); outcome PR/diff via git; **structured-thread resume/persistence** (today `service.ts` skips session-id capture + events are an in-memory ring → a restart loses coordinator+children — must be solved here).

## Known risks
- Structured threads don't persist across daemon restart yet (incr. 5).
- Event ring is in-memory + capacity-bounded (worse with `--include-partial-messages`); long sessions lose old events on reconnect.
- Rich escalation depends on the undocumented stdio permission flag.

## Activation
Backend changes across these increments + the streaming/P0 batch require a daemon rebuild+restart (which ends the serving session) — batch activations at increment checkpoints.
