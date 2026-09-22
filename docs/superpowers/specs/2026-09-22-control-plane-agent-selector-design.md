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

## Phase 2 — Codex coordinator, with harness-agnostic plumbing (separate release)

Scope decided 2026-09-22: **enable Codex as a coordinator harness now**; build
the harness-agnostic plumbing so Grok/OpenCode are a cheap follow-up, but do
NOT enable them (a `coordinator` capability flag gates the UI to Claude +
Codex). Enforcement for Codex: **the ported membrane plus a `workspace-write`
sandbox** (not read-only) — the coordinator must write its own `~/.codex`
memory, and the membrane denies the dangerous calls, mirroring the Claude
coordinator.

### Verified findings (live probe, 2026-09-22)

Probed a real `codex app-server` (`codex-cli 0.155.1`, `gpt-6-astra`):

- **The documented persona channel does NOT work.** `thread/start` with
  `settings.developer_instructions` (the spelling in the app-server docs) is
  **silently ignored** — the canary never appeared. This is exactly
  openai/codex#11004's silent-drop, and it means the spec's earlier "primary
  channel" was wrong.
- **The working channel is `developerInstructions`** — camelCase, top-level on
  `thread/start`. The canary (`MELON …`) came back honored. This is what the
  implementation MUST use; the `developer_instructions` config key is the
  documented fallback. The canary contract test stays mandatory — it is what
  caught the wrong spelling.
- Handshake confirmed: `initialize` → `initialized` notification → `thread/start`
  `{ cwd, model, approvalPolicy, sandbox, developerInstructions }`. Turns run
  async (`turn/start` returns immediately; wait for `turn/completed`).

### Work items

1. **Persona reaches Codex.** Add `systemPrompt?: string` to
   `StructuredSpawnOpts` (`manager.ts`), thread it from `service.ts`'s
   `manager.spawn` call (today only argv-based `appendSystemPrompt` exists, which
   Codex drops). `codex-manager.ts` `startThread` sends it as `thread/start`
   `developerInstructions`. Claude/Grok/OpenCode keep their existing prompt
   paths unchanged. **Contract test (mandatory):** a canary instruction sent
   through the channel must be observable in the model's reply — no silent-drop
   path ships.
2. **Port the membrane, harness-agnostically.** `toolPolicy` (already passed to
   every manager, silently ignored by Codex/ACP today) becomes consumed. Add a
   per-harness tool-name adapter that normalizes a manager's native approval
   into the shape `coordinator-policy` expects:
   - Codex: `Shell` → `{ command }` (already carries `command`); `ApplyPatch` →
     `{ file_path, changes[].path }` (check ALL change paths, not just the
     first).
   - The adapter is an interface with a Codex implementation now and a
     documented Grok/OpenCode stub (ACP `kind`+`title`+`rawInput`+`locations[]`)
     that is NOT wired to an enabled coordinator.
   Codex `handleApproval` consults the policy before its escalate/auto-allow
   branch and, on deny, responds `decline`. Codex's decline envelope carries no
   message — inject the policy's instructive text as a synthetic tool-result
   event so the coordinator can redirect.
3. **Codex asks, so the membrane can fire.** Coordinator spawns run
   `approvalPolicy: 'on-request'` + `sandbox: 'workspace-write'` so repo-write
   and command approvals actually reach `handleApproval`. Also correct the
   `codex-manager.ts` approvalPolicy type union: `'untrusted'` is documented as
   unsupported; the app-server accepts `never | unlessTrusted | onRequest`.
4. **Coordinator harness is selectable.** `ensureCoordinator` accepts a
   `coordinatorHarness` (default `claude-code`); the route validates it against
   the `coordinator` capability. `harnessCapabilities()` gains
   `coordinator: boolean`, true only where persona + policy-consuming membrane
   + resume/backfill all exist — today that is `claude-code` and (after this
   work) `codex`. The setup card gains a Coordinator harness strip filtered by
   that flag; Claude stays default.
5. **Prompts and models, parameterized.** Convert `COORDINATOR_PROMPT` to
   `buildCoordinatorPrompt({ harness })`: the memory-root line and the Claude
   tier-teaching become harness-appropriate (Codex → `~/.codex`, no
   sonnet/opus/fable vocabulary). The policy's allowed write path follows the
   harness memory root (`coordinator-policy` takes a memory-dir parameter). A
   per-harness coordinator model default (Codex gets a real model id, never a
   Claude alias); `store.ts`'s `'sonnet'` default only applies to a Claude
   coordinator.
6. **Codex coordinator survives restart.** Confirm `thread/resume` backfill
   (`codex-manager` already has it) restores a Codex coordinator's history, and
   the boot-kickstart idempotency check (claude-transcript-backed today) does
   not permanently skip a Codex coordinator.
7. **Web stragglers (Phase-1 misses that will read as Phase-2 bugs):** widen
   `live.ts` `isStructuredWorker` (claude-only today, so Codex/Grok/OpenCode
   workers never appear in the Overseer rail); audit `ProjectCard`/
   `PinnedThreadsView` `structuredClaude` gates and `typeIcons` for the
   coordinator row.

### Known trade, accepted

No non-Claude harness has a `--disallowedTools` equivalent, so spawn-time tool
stripping of native orchestration tools does not exist for a Codex coordinator.
The ported membrane is the enforcement. (Codex's native tools are `Shell`/
`ApplyPatch`/MCP, not an `Agent`/`Task` spawner, so the drift the
`--disallowedTools` fix addressed does not apply the same way.) Grok/OpenCode
remain worker-only until their ACP membranes consult the policy and gain a
question-escalation channel — tracked as a future phase, not this one.

## References (Codex, Phase 2)

- App-server protocol: https://learn.chatgpt.com/docs/app-server.md
  (redirect target of https://developers.openai.com/codex — the docs live
  under learn.chatgpt.com as of 2026-09). NOTE: the doc's
  `settings.developer_instructions` spelling was verified NON-functional on
  codex-cli 0.155.1; use top-level `developerInstructions`.
- Config reference: https://learn.chatgpt.com/docs/config-file/config-reference.md
- Sandboxing: https://learn.chatgpt.com/docs/sandboxing.md
- Known injection gap by client: https://github.com/openai/codex/issues/11004

## Out of scope

- A matrix-editing UI (Settings section) — later, on top of the Phase 1
  plumbing.
- Per-project (vs global) worker matrices.
- `resetDispatch` UI exposure — unrelated; noted as an existing gap.
- Changing worker autonomy/escalation semantics.
