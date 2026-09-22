# Control Plane agent selector — design

Date: 2026-09-22. Approved by Jason on 2026-09-22 (thread "OG Handle Business").

## Goal

The Control Plane (overseer) is locked to Claude today, in two independent ways:

1. The coordinator thread itself is hard-coded `claude-code`
   (`sessions/service.ts` `ensureCoordinator`, and the lookup only matches that
   type).
2. Every worker the coordinator spawns is hard-coded `claude-code`
   (`overseer/agency-mcp.ts` `spawn_agent` / `queue_agent`).

This feature removes both locks, in two phases, and adds the UI to choose.
Approved decisions:

- **Scope: both locks, phased.** Phase 1 = worker-harness selection plus a
  coordinator model picker (coordinator stays on Claude). Phase 2 = non-Claude
  coordinators, after the policy membrane is ported.
- **Worker selection: session default + override.** The user sets a default
  worker harness per Control Plane session; `spawn_agent` gains optional
  `harness`/`model` args to override per agent.
- **Per-agent-type plumbing (Phase 1):** a worker matrix keyed by agent type
  ships in the daemon from day one. No matrix UI yet — API and settings
  plumbing only. Defaults fall through to today's behavior.
- **UX: inline setup card, not a modal.** The card replaces the canned
  greeting in the empty state. Defaults are preselected; the first directive
  creates the session with what is shown. An existing coordinator never shows
  the card.
- **Phase 2 order: Codex first**, then Grok, then OpenCode.

## Current state (verified 2026-09-22)

- Creation: web calls `POST /api/sessions/:id/overseer/coordinator` with an
  empty body on tab open; `ensureCoordinator` (service.ts:1673) is idempotent
  find-or-create; config is server-assigned
  `{ transport: 'structured', role: 'coordinator' }`, type `'claude-code'`.
- The "opening text" is static client copy (`CANNED.emptyGreeting`,
  `overseer/data.ts:107`), rendered only when the stream is empty. No seed
  message exists — nothing to migrate.
- Session controls are client-composed: "New session…" = archive + re-ensure;
  "Previous sessions…" = archive current + restore an archived coordinator
  (filtered by `type === 'claude-code'` — must widen with the lookup).
  `resetDispatch` exists in the overseer store but has no UI caller.
- Coordinator enforcement is Claude-only today: `toolPolicy` is consulted only
  in `ClaudeStructuredSessionManager`; `--disallowedTools` is a Claude CLI
  flag; `coordinator-policy.ts` matches Claude tool names.
- Workers need none of that: agents are supposed to write code, carry no
  coordinator policy, and the approval/escalation membrane is provider-generic
  since the harness-telemetry unification (runtime/adapter + contract tests
  across all four `AGENT_TYPES`).
- The v2.37.0 `NewThreadModal` is a monolith, but its substrate is reusable:
  `Modal` (sheet/anchor), `SearchSelect`, the harness-strip pattern, and
  `GET /api/setup/harnesses` capability data.

## Phase 1 — worker selector + coordinator model

### Daemon

1. **`ensureCoordinator` options.** The route accepts an optional JSON body
   `{ model?: string, workerHarness?: AgentType }`. Both persist into the
   coordinator's config. The find lookup widens to
   `isAgentType(t.type) && t.config?.role === 'coordinator'` (Phase 2 ready).
   An empty body behaves exactly as today.
2. **`spawn_agent` / `queue_agent` harness arg.** Both schemas gain optional
   `harness` (one of the agent types; `model` already exists). The hard-coded
   `type: 'claude-code'` POST becomes the resolved harness.
3. **Worker resolution order** (first match wins), implemented as one pure,
   tested function:
   1. Explicit `spawn_agent` args (`harness`, `model`).
   2. The per-agent-type worker matrix entry for `agentType`.
   3. The session default: coordinator `config.workerHarness`.
   4. Built-ins: harness `claude-code` with today's `MODEL_FOR_TYPE` tiers;
      any other harness with that harness's own default model.
   Claude model aliases (`sonnet`/`opus`/`fable`) never reach a non-Claude
   CLI. If a matrix entry names a harness without a model, the harness's
   default model applies.
4. **Worker matrix storage.** A new `overseerWorkers` section in the daemon
   harness settings (same store as `opencodeModels`):
   `{ byType: { [agentType]: { harness?, model? } } }`. Global, survives
   "New session" and resets, editable via the existing harness-settings
   route. No UI in Phase 1.
5. **Availability guard.** `spawn_agent` with a harness whose CLI is not
   installed/authenticated returns a structured error to the coordinator (it
   already handles spawn errors); it must not create a dead thread.

### Web

1. **Extract picker pieces** from `NewThreadModal` into shared components
   (harness strip, settings `Row`); `NewThreadModal` consumes the extracted
   pieces so there is one implementation. Brand marks move next to the strip
   component with the catalog id as the key.
2. **`ControlPlaneSetupCard`** renders in the overseer empty state, replacing
   the canned greeting: a worker-harness strip (the four agent harnesses, no
   terminal, availability-dimmed like the thread picker) and one coordinator
   model row (Claude models, `sonnet` preselected). Copy stays minimal; the
   greeting text can sit above the card in a short form.
3. **Sequencing.** Tab open peeks for an existing coordinator (terminal list
   already loaded client-side) instead of calling ensure. With a coordinator:
   identical to today, no card. Without one: the card shows, and both
   start paths work: a Start button on the card creates the session at once,
   and a first directive typed into the composer creates it with the shown
   selection and then sends. Zero extra taps when the defaults are right.
4. **Session controls.** "New session…" keeps its confirm, archives, and the
   empty state that follows IS the picker — no new modal. "Previous
   sessions…" filter widens to any agent type with the coordinator role.
5. **Mobile.** The card is a plain in-stream block, so the phone layout needs
   no sheet work; reuse the strip's phone pill-row variant.

### Testing

TDD per layer: resolution-order unit tests (the pure function), route tests
for the ensure body and the widened lookup, agency-mcp spawn tests for the
harness pass-through and the availability guard, and web tests for the card
(shows only when empty + no coordinator; first directive carries the
selection; existing coordinator never shows it).

## Phase 2 — non-Claude coordinators (separate release)

1. **Port the membrane.** `toolPolicy` consultation moves into the shared
   approval path of `CodexStructuredSessionManager` and
   `GrokStructuredSessionManager` (both ACP dialects). A per-harness tool-name
   normalization map feeds `coordinator-policy.ts` (`shell`/`apply_patch`/ACP
   `write`/`execute` → the policy's categories).
2. **Capability flag.** `harnessCapabilities()` gains `coordinator: boolean`,
   true only where the policy-consulting membrane exists. The setup card gains
   a Coordinator harness row listing only capable harnesses; Claude stays the
   default.
3. **Codex first.** The blocker is in OUR provider, not the CLI: `codex.ts`
   `buildStructuredCommand` discards `appendSystemPrompt`. Codex 0.155.1
   carries `developer_instructions` (config) and `developerInstructions` /
   `baseInstructions` (app-server params). Work item one is a probe: pass the
   coordinator prompt via `thread/start` `developerInstructions`; fallback is
   a `-c developer_instructions=` config override. Codex upside: a read-only
   OS sandbox plus `approvalPolicy: 'untrusted'` enforces below the membrane —
   stronger than what Claude offers.
4. **Prompts and models.** Per-harness coordinator model map (real model ids,
   never Claude aliases); prompt variants drop the `~/.claude` memory
   instruction and Claude tier teaching on non-Claude harnesses (memory path
   becomes harness-appropriate, e.g. `~/.codex`), and the policy's allowed
   write path follows it.
5. **Known trade, accepted:** no non-Claude harness has a `--disallowedTools`
   equivalent, so spawn-time tool stripping does not exist there. The ported
   membrane (plus the Codex sandbox) is the enforcement. Grok/OpenCode ship
   only after their membranes actually consult the policy.

## Out of scope

- A matrix-editing UI (Settings section) — later, on top of the Phase 1
  plumbing.
- Per-project (vs global) worker matrices.
- `resetDispatch` UI exposure — unrelated; noted as an existing gap.
- Changing worker autonomy/escalation semantics.
