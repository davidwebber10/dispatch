# PR #47 (Control Plane Phase 2 — Codex coordinator) — review findings

**Date:** 2026-09-23. **Reviewers:** GPT-6 Astra (`codex exec -m gpt-6-astra`, read-only)
and a Claude Opus 4.8 subagent (Opus 5.5 is NOT available in this environment; the
subagent self-reported `claude-opus-4-8`). Both traced real code paths, not the diff alone.
The two reviewers converged on the same top blockers; each finding below was then
confirmed directly in the code.

## Blockers (both reviewers; code-confirmed)

- **B1 — Bash policy is a blocklist, so arbitrary write commands pass.**
  `coordinator-policy.ts` `BLOCKED_BASH` denies only a small regex list. Every other
  command returns `{ allow: true }`. Under `read-only` + `on-request`, an approved
  command runs escalated OUTSIDE the sandbox, so `printf > /repo/f`, `tee`, `sed -i`,
  `cp`, `node -e fs.writeFileSync`, `ln -s` all write the repo. Defeats the
  "repo writes denied" guarantee. Inherited from the Claude coordinator policy.

- **B2 — The `coordinator` capability gate is create-only.** `capabilities.ts` gates on
  `structured && …`, but only the create route checks it. `service.ts` falls through to a
  PTY spawn when `structuredManagerFor('codex')` is undefined (e.g. `DISPATCH_CODEX_PRETTY=0`).
  The PTY command adds `--dangerously-bypass-approvals-and-sandbox` and drops the persona.
  Restart / WebSocket relaunch / transport-switch do not re-check the capability. A Codex
  coordinator can revive ungoverned.

## High / Medium (one reviewer; code-confirmed)

- **M1 — Symlinks escape memory containment.** `isUnder` uses `path.resolve`/`path.relative`,
  not `fs.realpathSync`; it does not follow symlinks. Chains with B1 (`ln -s` allowed).
- **M2 — ApplyPatch move/rename destination dropped.** `codex-translate.ts` reduces each
  change to `{ path, kind: string, diff }`, discarding a rename destination. `extractWritePaths`
  checks only the source `path`. A patch whose source is in `~/.codex` but destination is a
  repo file passes containment.
- **M3 — Shared app-server connection leaks MCP identity.** `ensureConnection` is
  first-spawn-wins for `command/args/cwd/env`; later Codex threads reuse the first thread's
  env (`DISPATCH_SESSION`/`DISPATCH_TERMINAL`), so a second coordinator's `spawn_agent` /
  `report_status` targets the first thread's project/terminal. Governance (sandbox/approval)
  DOES ride per-thread correctly.

## Lower (tests / robustness)

- **T1** — Restart resumes the Codex thread but never sends a continuation turn.
- **T2** — Persona canary test matches `MELON` anywhere in reasoning; resume test only
  checks params reached the fake server. Both can pass without observed persona-following.
- **T3** — Prompt memory label and enforced dir are two maps with no cross-check test.
- **T4** — No end-to-end deny test of an ApplyPatch repo write through the real coordinator
  policy in the manager.

## Validated sound by both reviewers
Persona re-send on resume; per-thread sandbox/approval (no governance leak); categorical
self-escalation deny; fail-closed on non-string Bash and empty patch paths; adapter field
names match the translator; unrecognized approval methods fail closed.

## Decision
Jason chose: fix B1, B2, M1, M2, plus the test gaps; M3 deferred to a separate PR. Plan:
`docs/superpowers/plans/2026-09-23-pr47-phase2-remediation.md`.

## Remediation + second review pass (2026-09-23)
B1/B2/M1/M2 fixed (commit 007e413) + a fable adversarial review hardening pass (F1–F4, commit
3378687). A SECOND GPT-6 Astra verification pass then confirmed B1 and M2 sound, and found three
more real gaps — all fixed:
- **Astra-V1 (B2 too narrow):** the guard checked only structured-manager presence, so a
  coordinator on a NON-capable harness (grok/opencode ACP ignore toolPolicy) or a `shell`
  coordinator (bypassed the else-branch) could run ungoverned. Fix: the guard now also requires
  `COORDINATOR_CAPABLE_HARNESSES.has(type)` and runs at the TOP of spawnTerminal (before the shell
  branch). `COORDINATOR_CAPABLE_HARNESSES` is now exported from capabilities.ts.
- **Astra-V2 (M1 `..`-after-symlink):** `path.resolve`/`realpathSync` collapse `link/..` lexically
  (to the link's own parent), but the kernel follows the link target then `..` at write time — a
  `mem/link/../escape` could pass containment yet write outside. Fix: isUnder rejects ANY raw `..`
  segment outright (a coordinator memory path never needs one).
- **Astra-V3 (realResolve failed open):** a non-ENOENT lstat/realpath error (EACCES, ELOOP, EIO)
  was treated as "absent" and re-appended lexically. Fix: realResolve walks original segments and
  fails closed on any non-ENOENT error (tested via a symlink loop → ELOOP).

Final: core 1976/1976, web 1219/1219, both tsc clean.

## Independent review (Claude Opus 5.5, 2026-09-23, head 994b30e) + remediation

A separate review (own reading + a `/code-review xhigh` agent + live probes against the installed
`codex-cli 0.156.1` and its `generate-ts` bindings) re-checked every finding above.

**Earlier findings:** B1, M1, M2, T3, T4, F1–F4, Astra-V2/V3 confirmed fixed (M2's
`kind.move_path` matches the 0.156.1 `PatchChangeKind` exactly). **B2 / Astra-V1 were only half
fixed**, and **T1/T2 were never fixed** — the remediation plan scoped only T3+T4, although the
Decision above says "plus the test gaps".

**New findings — all fixed in this pass unless noted:**
- **N1 (High, probe-confirmed):** the Codex coordinator memory dir was ALL of `~/.codex`, so the
  policy auto-approved ApplyPatch writes to `config.toml` (`notify` / `mcp_servers` run commands
  outside the sandbox), `rules/*.rules` (execpolicy allow rules), the global `AGENTS.md`, skills,
  and the real git worktrees in `~/.codex/worktrees/`. Coordinators have `escalate=false`, so no
  human saw them. Fix: dedicated `~/.codex/dispatch-coordinator`; the prompt label is now DERIVED
  from the policy's own map (no second map to drift); the memory dir is resolved once at policy
  build; relative targets are denied.
- **N2 (High, probe-confirmed):** the coordinator guard lived only in `spawnTerminal`;
  `ensureStructuredAlive` → `spawnStructured` skipped it, so a Grok coordinator (reachable via
  `PATCH /terminals/:id` or a refused queued start) revived ungoverned. Fix:
  `assertCoordinatorGoverned` runs on both doors.
- **N3 (Medium):** governed Codex threads did not pin `approvalsReviewer`; `auto_review` /
  `guardian_subagent` in config.toml would answer escalations inside Codex, skipping the membrane.
  Fix: `approvalsReviewer: 'user'` on thread/start + thread/resume (live-verified accepted).
- **N4 (Medium):** `item/fileChange/patchUpdated` was ignored, so the policy could check a stale
  change list. Fix: the translator keeps the cached change list current.
- **N5 (M3 made reachable):** the setup card offered Codex coordinator + Codex workers, which
  share one app-server MCP identity. **Blocked, not fixed** (owner decision): the Codex manager's
  `exclusiveConnection` refuses a Codex coordinator while any other Codex Pretty thread is live and
  vice versa; the setup route rejects the Codex+Codex pair; `worker-defaults` reports Codex workers
  unavailable under a Codex coordinator; the card hides them. Per-thread identity = follow-up.
- **N6 (Medium):** Codex threads never got the peer/tools prompt, and a per-thread persona dropped
  the global tools note. Fix: `developerInstructions` = persona + peer/tools block.
- **T1:** boot kickstart now covers Codex, gated on the rollout (`codexRolloutTailStatus`:
  `task_started` last = cut off; `task_complete` / `turn_aborted` = settled).
- **T2:** the live contract test is now opt-in (`DISPATCH_LIVE_CODEX=1`; it runs billed turns),
  counts only the agent's REPLY text, and cannot pass on a timeout. Its new resume cases found a
  **wrong earlier claim**: codex-cli 0.156.1 does NOT apply `developerInstructions` on
  `thread/resume`. The persona survives a resume because the thread's own history carries the one
  given at thread/start; a persona CHANGE only reaches a fresh thread. Comments corrected.
- **N7 (Blocker, found by a live probe during this pass):** under `approvalPolicy: 'on-request'`
  (the Codex manager's default for EVERY Codex Pretty thread, on `main` too, and the coordinator's
  pinned policy), codex-cli 0.156.1 gates every MCP tool call behind an
  `mcpServer/elicitation/request` (`_meta.codex_approval_kind: 'mcp_tool_call'`), sent after
  `item/started` for the `mcpToolCall`. Dispatch answered it with an error → "user rejected MCP
  tool call": a Codex coordinator could not call `spawn_agent` / `report_status` at all, and no
  Codex Pretty thread could use any MCP tool. Fix: the translator maps a tool-call elicitation to
  an approval named `mcp__<server>__<tool>` (paired to the in-progress item), so the membrane
  decides like any other tool; `accept` = `{ action: 'accept', content: {}, _meta: null }`
  (live-verified: the tool then runs). A real elicitation form is still refused.
- **Low:** the deny reason now survives Codex's own declined `item/completed` (the chat is
  last-wins), and a permissions deny renders as a paired tool call; the setup card resets a stale
  coordinator pick and shows a Start failure; the permissions-deny message is harness-generic;
  the web `HarnessCapability` type is derived from core.

**Left as-is, by judgment:** the Overseer rail showing plain Grok/OpenCode Pretty threads matches
how plain Pretty Claude threads already show. `~/.claude` stays the Claude coordinator's memory
root — its Bash runs under a denylist, not a sandbox, so it is not a containment boundary.
