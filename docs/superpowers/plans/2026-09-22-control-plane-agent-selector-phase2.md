# Control Plane Agent Selector — Phase 2 (Codex coordinator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Control Plane coordinator run on Codex (not just Claude), with its ground rules actually enforced, and lay harness-agnostic plumbing so Grok/OpenCode are a cheap follow-up (not enabled here).

**Architecture:** A `systemPrompt` field flows to the Codex manager and lands as `thread/start developerInstructions` (the working channel — the documented `settings.developer_instructions` is silently dropped, verified live). `toolPolicy` (already passed to every manager, ignored by Codex today) becomes consumed via a per-harness tool-name adapter that maps Codex `Shell`/`ApplyPatch` approvals into the shape `coordinator-policy` expects. A `coordinator` capability flag gates a new Coordinator harness strip to Claude + Codex. The coordinator prompt, memory root, and model default become harness-parameterized.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest + supertest (core), React + zustand + vitest (web). Codex app-server JSON-RPC over stdio.

**Spec:** `docs/superpowers/specs/2026-09-22-control-plane-agent-selector-design.md` (Phase 2 section, refined 2026-09-22 with live-probe findings).

## Global Constraints

- Enforcement for a Codex coordinator = ported membrane + `sandbox: 'read-only'` + `approvalPolicy: 'on-request'`. (CORRECTED from an earlier workspace-write plan: the Task 5 review proved workspace-write lets in-workspace repo writes/commits bypass the approval, defeating the membrane. read-only makes every write/command surface for the policy; the coordinator's memory writes live under its memory dir, outside the workspace, and the policy allows them.)
- Persona channel for Codex = `thread/start` top-level `developerInstructions` (camelCase). The documented `settings.developer_instructions` is verified NON-functional on codex-cli 0.155.1 — do not use it.
- Every persona-delivery path ships with a canary contract test: a canary instruction must be observably honored, or the build fails. No silent-drop path ships.
- Claude model aliases (`sonnet`/`opus`/`haiku`/`fable`) must NEVER reach Codex (Phase-1 guard stays; the coordinator model default must be a real id for Codex).
- Grok/OpenCode coordinators are NOT enabled: the `coordinator` capability flag is true only for `claude-code` and `codex`. The ACP tool-name adapter is a documented stub, not wired.
- Claude, Grok, and OpenCode coordinator behavior must not regress — Claude stays the default coordinator harness.
- `AgentType` (providers/agent-types.ts) = harness wire type; alias harness imports as `HarnessType` in new code where the persona `AgentType` (planner/implementer/…) is also in scope.
- TDD every task. Run tests from `packages/core` / `packages/web` with `npx vitest run <file>`. Do NOT run the web vite build.
- Commits end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: `systemPrompt` on the spawn contract; Codex delivers it as `developerInstructions`

**Files:**
- Modify: `packages/core/src/structured/manager.ts` (`StructuredSpawnOpts` interface)
- Modify: `packages/core/src/providers/codex.ts` (`buildStructuredCommand` — accept/ignore appendSystemPrompt is fine; the prompt rides opts, not argv)
- Modify: `packages/core/src/structured/codex-manager.ts` (store systemPrompt per session; send on `thread/start`)
- Modify: `packages/core/src/sessions/service.ts` (pass `systemPrompt: systemPromptFor(config)` into `manager.spawn`)
- Test: `packages/core/src/structured/codex-manager.systemprompt.test.ts`

**Interfaces:**
- Produces: `StructuredSpawnOpts.systemPrompt?: string`. Consumed by the Codex manager → `thread/start` param `developerInstructions`. Claude/Grok/OpenCode ignore it (they already receive the persona via their existing paths — Claude `--append-system-prompt`, Grok `--rules`, OpenCode `rules.md`).

- [ ] **Step 1: Write the failing test.** Unit-test the Codex manager's `thread/start` params using the manager's existing test seam (there are Codex manager tests already — find `codex-manager*.test.ts` and reuse its fake-connection/transport harness). Assert: when `spawn` is called with `systemPrompt: 'CANARY-PERSONA'`, the `thread/start` request params include `developerInstructions: 'CANARY-PERSONA'` (NOT `settings.developer_instructions`). Add a second assertion: `thread/resume` does NOT carry it (resume restores an existing thread that already has its instructions).

```ts
// shape of the key assertion (adapt to the existing codex-manager test harness)
const sent = fakeConn.requests.find(r => r.method === 'thread/start');
expect(sent.params.developerInstructions).toBe('CANARY-PERSONA');
expect(sent.params.settings?.developer_instructions).toBeUndefined();
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/core && npx vitest run src/structured/codex-manager.systemprompt.test.ts` — systemPrompt not on opts / not sent.

- [ ] **Step 3: Implement.**
  - `manager.ts`: add `systemPrompt?: string;` to `StructuredSpawnOpts` (document: "persona for harnesses that inject it out-of-band, e.g. Codex thread/start developerInstructions; argv-based harnesses use their own appendSystemPrompt path").
  - `codex-manager.ts`: store `systemPrompt` on the `CodexSession` at spawn; in `startThread`, add `developerInstructions: session.systemPrompt` to the `thread/start` params when set (omit the key when undefined). Do not add it to `thread/resume`.
  - `service.ts`: in the `manager.spawn(...)` call, add `systemPrompt: systemPromptFor(config)`. (This is redundant-but-harmless for Claude/Grok/OpenCode, which also still get it via their argv/config paths — leave those untouched this task.)
  - `codex.ts`: no functional change required (the prompt no longer needs argv); leave `buildStructuredCommand` as is.

- [ ] **Step 4: Run tests** — the new file green; full core suite green.

- [ ] **Step 5: Commit** — `feat(core): deliver a Codex thread's persona via thread/start developerInstructions`.

---

### Task 2: Live canary contract test for Codex persona injection

**Files:**
- Create: `packages/core/src/structured/codex-persona.contract.test.ts`

**Interfaces:** Consumes Task 1. This is the guard that the channel actually reaches the model — the live probe proved the documented spelling fails silently, so this test is mandatory and must exercise a REAL `codex app-server`.

- [ ] **Step 1: Write the test.** Gate it on Codex being installed + signed in (skip with a clear message otherwise, like other environment-gated tests in the repo — grep for `it.skipIf` / a `codexAvailable()` helper; if none exists, detect via `which codex` + a cheap `codex` auth check and `describe.skipIf`). The test spawns a real app-server (reuse the probe protocol in `/tmp/codex-probe/probe.mjs` as the reference: `initialize` → `initialized` → `thread/start` with `developerInstructions: 'Begin every reply with the exact word MELON.'`, `approvalPolicy: 'never'`, `sandbox: 'read-only'`, `model` from env or a cheap default → `turn/start` "say hi" → wait for `turn/completed`), and asserts the assistant text contains `MELON`. Timeout generously (90s).

- [ ] **Step 2: Run it** — `cd packages/core && npx vitest run src/structured/codex-persona.contract.test.ts` — PASS where Codex is available (verified manually via the probe: camelCase works). If it does not pass, the channel is wrong — STOP and escalate, do not ship.

- [ ] **Step 3: Commit** — `test(core): live canary guard that Codex persona injection actually lands`.

---

### Task 3: Harness-agnostic approval → policy adapter

**Files:**
- Create: `packages/core/src/overseer/policy-adapter.ts`
- Test: `packages/core/src/overseer/policy-adapter.test.ts`

**Interfaces:**
- Produces: `adaptForPolicy(harness: string, pending: { toolName: string; input: unknown }): { toolName: string; input: unknown }` — normalizes a manager's surfaced approval into the vocabulary `coordinatorToolPolicy` matches (`Bash` with `{ command }`, `Write`/`Edit` with `{ file_path }`).
  - `claude-code`: identity (already the right shape).
  - `codex`: `Shell` → `{ toolName: 'Bash', input: { command } }`; `ApplyPatch` → `{ toolName: 'Write', input: { file_path, changes } }` — and expose ALL change paths so a multi-file patch can be fully checked (see Task 4's multi-path handling).
  - `grok`/`opencode`: documented STUB — throw or return identity with a `// TODO(phase-3)` comment and a test asserting it is not yet wired. Do NOT implement ACP mapping.

- [ ] **Step 1: Failing test** covering: codex Shell→Bash with command preserved; codex ApplyPatch→Write with file_path + all change paths; claude-code identity; an unknown/stub harness returns identity (documented).

- [ ] **Step 2: Watch fail** (module missing).

- [ ] **Step 3: Implement** the pure adapter per the interface above. Keep it a pure function — no I/O.

- [ ] **Step 4: Tests green** + full core suite.

- [ ] **Step 5: Commit** — `feat(core): harness-agnostic approval→policy adapter (Codex Shell/ApplyPatch)`.

---

### Task 4: `coordinator-policy` takes a memory dir; multi-path patch check

**Files:**
- Modify: `packages/core/src/overseer/coordinator-policy.ts`
- Modify: `packages/core/src/overseer/coordinator-policy.test.ts`

**Interfaces:**
- Produces: `coordinatorToolPolicy` gains an optional allowed-write-root parameter so the `~/.claude` hardcode becomes per-harness. Preferred shape (keeps the existing `(toolName, input) => decision` call signature that managers store): a factory `makeCoordinatorPolicy(memoryDir: string)` returning the policy fn, plus keep `coordinatorToolPolicy` as `makeCoordinatorPolicy(path.join(os.homedir(), '.claude'))` for back-compat and existing callers.
- FILE_TOOLS write check must accept a `changes: {path}[]` array (from the Codex ApplyPatch adaptation) and allow only when EVERY path is under the memory dir; a single outside path denies.

- [ ] **Step 1: Failing tests:** (a) `makeCoordinatorPolicy('/home/x/.codex')` allows a Write under `/home/x/.codex/…` and denies one under `~/.claude`; (b) an ApplyPatch-shaped input with `changes: [{path: memoryDir/a}, {path: repo/b}]` denies (mixed); (c) all-in-memory-dir allows; (d) existing `coordinatorToolPolicy` behavior unchanged (the default export still keys on `~/.claude`).

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement** the factory + multi-path check; re-express `coordinatorToolPolicy` via the factory. Update the deny copy that currently hardcodes "~/.claude" to name the passed memory dir.

- [ ] **Step 4: Tests green** + full core suite.

- [ ] **Step 5: Commit** — `feat(core): parameterize the coordinator memory dir; check all patch paths`.

---

### Task 5: Codex manager consumes `toolPolicy`

**Files:**
- Modify: `packages/core/src/structured/codex-manager.ts` (store toolPolicy per session; consult in `handleApproval`)
- Modify: `packages/core/src/structured/manager.ts` if the shared session type needs the field visible (it is already on `StructuredSpawnOpts`)
- Test: `packages/core/src/structured/codex-manager.policy.test.ts`

**Interfaces:**
- Consumes: Task 3 adapter, Task 4 policy. In `handleApproval`, BEFORE the escalate/auto-allow branch: if `session.toolPolicy`, call it with `adaptForPolicy('codex', action.pending)`; on `{allow:false}`, respond `decline` for the approval AND inject the policy `message` as a synthetic tool-result/assistant event into the ring so the coordinator sees why (Codex's decline envelope has no message field — mirror how the manager pushes events elsewhere; grep `pushEvent`/`applyActions`). A policy deny must NOT create a pending / involve the human — same semantics as the Claude manager.

- [ ] **Step 1: Failing test** using the codex manager test harness: spawn with a `toolPolicy` that denies `Bash` commands matching `git push`; simulate a `commandExecution` approval whose command is `git push`; assert the manager responds `decline` (not accept, not a pending emit) and that a synthetic event carrying the deny message was pushed. Second case: a benign `ls` command with the same policy → auto-approved (accept). Third: policy denies, `escalate` is also true → policy wins (deny, no pending).

- [ ] **Step 2: Watch fail** — toolPolicy currently ignored (auto-approves / escalates).

- [ ] **Step 3: Implement.** Store `toolPolicy` on `CodexSession` at spawn. In `handleApproval`, insert the policy check first, using the Task 3 adapter. On deny: `this.conn?.respond(requestId, declineResponse)` + push the synthetic message event. Keep AskUserQuestion-analogue (`requestUserInput`, `alwaysSurface`) exempt from policy, as the Claude manager exempts AskUserQuestion.

- [ ] **Step 4: Tests green** + full core suite.

- [ ] **Step 5: Commit** — `feat(core): Codex coordinator ground rules — consult toolPolicy in handleApproval`.

---

### Task 6: Codex coordinator spawns in ask mode; fix the approvalPolicy type

**Files:**
- Modify: `packages/core/src/structured/codex-manager.ts` (approvalPolicy type union; per-coordinator sandbox/approval)
- Modify: `packages/core/src/sessions/service.ts` (pass approval/sandbox intent for a coordinator)
- Test: extend `codex-manager.policy.test.ts` or a focused new test

**Interfaces:**
- A Codex coordinator must spawn with `approvalPolicy: 'on-request'` and `sandbox: 'read-only'` (CORRECTED from workspace-write — the Task 5 review proved workspace-write lets in-workspace repo writes/commits run WITHOUT an approval, so the membrane would never fire on exactly the actions it must block). Under `read-only` + `on-request`, every write and every command needing write/network surfaces an approval that `handleApproval` (Task 5) gates: repo writes / `git commit` / `git push` → policy deny; the coordinator's memory writes under its memory dir → `fileChange` approval that the policy ALLOWS (this requires Task 7's memory-dir wiring — `makeCoordinatorPolicy(<codex memory dir>)` — so between this task and Task 7 the integrated behavior is only correct once Task 7 lands; they ship in one PR). Today approval/sandbox are manager-construction defaults, not per-spawn. Minimal seam: pass them through `StructuredSpawnOpts` (add `approvalPolicy?`/`sandbox?`) and set the coordinator-safe pair for `config.role === 'coordinator'` in service.ts; if the shared codex app-server connection makes per-thread sandbox impossible, document that and fall back to coordinator-safe manager defaults.
- Correct the type union: `'untrusted'` → the documented set `'never' | 'unlessTrusted' | 'onRequest'` (map our internal names as needed). Verify the exact wire literal the CLI accepts (`on-request` vs `onRequest`, `read-only` vs `readOnly`) against the installed CLI before committing — the reference probe at `/tmp/codex-probe/probe.mjs` used `approvalPolicy:'never'`/`sandbox:'read-only'` successfully.
- Live verification (do here or defer to the Task 12 smoke, but it MUST happen before the PR): against a real `codex app-server`, confirm a `git commit` and a memory-dir write BOTH surface as approvals under `read-only` + `on-request` (i.e. the membrane actually sees them), and a benign read-only command does not brick.

- [ ] **Step 1: Failing test** — a coordinator-role Codex spawn sends `thread/start` with `approvalPolicy` = the ask value and `sandbox: 'read-only'`; a non-coordinator Codex thread keeps today's behavior.

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement**, verifying the exact accepted literal against the installed CLI (a quick `codex` app-server probe if unsure — the reference probe is at `/tmp/codex-probe/probe.mjs`).

- [ ] **Step 4: Tests green** + full core suite + `npm run build`.

- [ ] **Step 5: Commit** — `feat(core): Codex coordinator spawns on-request/read-only so the membrane fires`.

---

### Task 7: `buildCoordinatorPrompt({ harness })` + per-harness memory root & model default

**Files:**
- Modify: `packages/core/src/overseer/prompts.ts` (COORDINATOR_PROMPT → builder; MODEL_FOR_TYPE coordinator per harness)
- Modify: `packages/core/src/sessions/service.ts` (systemPromptFor + the policy/memory wiring pass the harness)
- Test: `packages/core/src/overseer/prompts.coordinator.test.ts`

**Interfaces:**
- Produces: `buildCoordinatorPrompt({ harness }): string`. Claude variant is byte-identical to today's `COORDINATOR_PROMPT` (pin with a test). Codex variant: memory-root line says `~/.codex`; the tier-teaching sentences (opus/sonnet/fable) are dropped or replaced with harness-neutral guidance ("pass a model id appropriate to the worker's harness"). `systemPromptFor(config)` resolves the harness from the terminal type.
- A per-harness coordinator model default: extend `modelFor`/`MODEL_FOR_TYPE` (or the Phase-1 `resolveSpawnModel`) so a Codex coordinator with no explicit model gets a real Codex default, never `'sonnet'`. Wire the memory dir into the policy (Task 4 factory) per harness at the coordinator spawn site.

- [ ] **Step 1: Failing tests:** claude coordinator prompt unchanged (snapshot/equality against the old constant); codex coordinator prompt contains `~/.codex` and does NOT contain `~/.claude` or `fable`; codex coordinator resolved model is not a Claude alias; the coordinator policy for a codex coordinator allows a write under `~/.codex`.

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement** the builder and wiring. Keep the Claude path exactly as-is.

- [ ] **Step 4: Tests green** + full core suite.

- [ ] **Step 5: Commit** — `feat(core): per-harness coordinator prompt, memory root, and model default`.

---

### Task 8: `coordinator` capability flag + `ensureCoordinator` harness

**Files:**
- Modify: `packages/core/src/providers/capabilities.ts` (add `coordinator`)
- Modify: `packages/core/src/sessions/service.ts` (`ensureCoordinator` accepts `coordinatorHarness`; create uses it)
- Modify: `packages/core/src/routes/sessions.ts` (validate `coordinatorHarness` against the capability)
- Test: `packages/core/src/routes/ensure-coordinator.test.ts` (extend), `packages/core/src/providers/capabilities.test.ts` (extend or create)

**Interfaces:**
- `harnessCapabilities()` entries gain `coordinator: boolean`, true for `claude-code` and `codex` only (a small allowlist constant is honest and testable — the underlying requirements are met by exactly those two after Tasks 1-7).
- `ensureCoordinator(sessionId, opts)` opts gains `coordinatorHarness?: HarnessType`; create uses it as the terminal `type` (default `'claude-code'`). Route rejects a `coordinatorHarness` whose capability `coordinator` is false (400). The Phase-1 `workerHarness`/`model` handling stays.
- Client type + `ensureOverseerCoordinator` opts gain `coordinatorHarness` (web Task 10).

- [ ] **Step 1: Failing tests:** capability lists coordinator:true for claude-code+codex, false for grok/opencode/shell; ensure route with `coordinatorHarness:'codex'` creates a codex-type coordinator; `coordinatorHarness:'grok'` → 400; empty body still creates claude-code.

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Tests green** + full core suite + `npm run build`.

- [ ] **Step 5: Commit** — `feat(core): coordinator capability flag + selectable coordinator harness`.

---

### Task 9: Codex coordinator restart/backfill + kickstart idempotency

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (resume backfill gate; boot kickstart idempotency)
- Test: `packages/core/src/sessions/coordinator-restart.test.ts`

**Interfaces:**
- Confirm a Codex coordinator's history restores on daemon restart (Codex manager backfills from `thread/resume`; the claude-transcript backfill gate at the seed-events line must not swallow Codex — Codex has its own path, so ensure the claude-only `readSessionBackfill` gate does not misfire for codex, and that codex resume still runs).
- The boot-kickstart idempotency check is claude-transcript-backed (`transcriptTailStatus`), which is always null for Codex → a Codex coordinator would be kicked once then permanently skipped. Fix: for a non-claude coordinator, use a harness-agnostic liveness signal (e.g. the manager's own alive/last-activity state) instead of the claude transcript tail, OR document that Codex coordinators rely on `ensureStructuredAlive` (revive-on-open) and are intentionally not boot-kicked — pick the smaller correct option and test it.

- [ ] **Step 1: Failing/behavioral test** for the kickstart path with a codex-type coordinator row (assert it is not permanently skipped, or that revive-on-open covers it — match the option chosen).

- [ ] **Step 2: Watch fail** (or document why the current behavior is already correct with a test that pins it).

- [ ] **Step 3: Implement** the smaller correct fix.

- [ ] **Step 4: Tests green** + full core suite.

- [ ] **Step 5: Commit** — `fix(core): Codex coordinator boot/restart lifecycle`.

---

### Task 10: Web — Coordinator harness strip + wiring

**Files:**
- Modify: `packages/web/src/api/client.ts` + `types.ts` (`ensureOverseerCoordinator` opts gain `coordinatorHarness`; capability type gains `coordinator`)
- Modify: `packages/web/src/components/overseer/store.ts` (`setupSelection` gains `coordinatorHarness`; `startCoordinator` sends it; default `'claude-code'`; the `'sonnet'` model default applies only to a Claude coordinator)
- Modify: `packages/web/src/components/overseer/components/SetupCard.tsx` (add a Coordinator harness strip filtered by `capabilities.coordinator`; un-pin `COORDINATOR_MODELS` to the selected coordinator harness's models)
- Test: extend `SetupCard.test.tsx`, `setup-sequencing.test.ts`

**Interfaces:**
- SetupCard gains a second `HarnessStrip` labeled "Coordinator", options = harnesses with `coordinator: true` (Claude default, Codex available). Selecting it updates `setupSelection.coordinatorHarness`; the coordinator model `SearchSelect` sources that harness's models. `startCoordinator` sends `{ coordinatorHarness, model, workerHarness }`.

- [ ] **Step 1: Failing tests:** the Coordinator strip renders Claude + Codex only (grok/opencode absent because coordinator:false); selecting Codex updates the store + swaps the model list; Start sends coordinatorHarness. Keep existing SetupCard cases green.

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Tests green** + full web suite + `tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(web): choose the Control Plane coordinator harness (Claude or Codex)`.

---

### Task 11: Web straggler — worker rail shows non-Claude workers

**Files:**
- Modify: `packages/web/src/components/overseer/live.ts` (`isStructuredWorker` widen from claude-only)
- Audit + fix if needed: `ProjectCard.tsx`, `PinnedThreadsView.tsx` `structuredClaude` gates; `typeIcons.tsx` coordinator row color
- Test: extend the relevant `live`/overseer tests

**Interfaces:**
- `isStructuredWorker` accepts any agent harness with structured transport (mirror the daemon's `isAgentType`), so Codex/Grok/OpenCode workers appear in the Overseer rail and archived outcomes. This is a Phase-1 miss surfaced by the intel; scope it tightly to the rail visibility, not a broad refactor.

- [ ] **Step 1: Failing test** — a codex-type structured worker is recognized by `isStructuredWorker` / appears in the rail selector.

- [ ] **Step 2: Watch fail.**

- [ ] **Step 3: Implement** the widen; audit the two `structuredClaude` sites and fix only if they hide a coordinator/worker incorrectly (note any left as-is with reasoning).

- [ ] **Step 4: Tests green** + full web suite + `tsc --noEmit`.

- [ ] **Step 5: Commit** — `fix(web): show non-Claude structured workers in the Overseer rail`.

---

### Task 12: Full verification + live smoke + PR

- [ ] **Step 1:** `cd packages/core && npx vitest run && npm run build` — green + tsc clean.
- [ ] **Step 2:** `cd packages/web && npx vitest run && npx tsc --noEmit` — green.
- [ ] **Step 3: Live smoke via the verify skill** against an isolated daemon (fake HOME): create a project; `POST /overseer/coordinator` with `{ "coordinatorHarness": "codex" }`; confirm the coordinator terminal row is codex-typed with the persona; send it a directive that would trip the policy (ask it to `git push`) and confirm the membrane denies with the redirect message; confirm a benign directive works and it can spawn a worker. Also confirm `coordinatorHarness: "grok"` is rejected (capability false). Restore the live web dist from a main build afterward (Phase-1 lesson: `pnpm build` overwrites `packages/web/dist`).
- [ ] **Step 4:** Final whole-branch review (fable) + fix loop, then open the PR (do NOT merge). Report CI and stop.

---

## Self-review notes

- Spec coverage: persona delivery (T1) + live canary (T2); membrane port via adapter (T3) + memory-dir policy (T4) + Codex consumption (T5) + ask-mode spawn (T6); prompt/model parameterization (T7); capability flag + selectable harness (T8); restart/kickstart lifecycle (T9); web selector (T10) + rail straggler (T11); verification (T12). Grok/OpenCode intentionally stubbed in T3, gated off in T8.
- The live-probe reality (developerInstructions, not settings.*) is pinned by T1's unit assertion AND T2's live canary — the two together prevent a silent regression if a future CLI changes the channel.
- Type consistency: `adaptForPolicy` (T3) consumed by the Codex manager (T5); `makeCoordinatorPolicy(memoryDir)` (T4) consumed by T7's spawn wiring; `coordinator` capability (T8) consumed by the web strip (T10).
- Known deferral: Grok/OpenCode as coordinators (no stable tool vocabulary, no question channel) — documented future phase, not this plan.
