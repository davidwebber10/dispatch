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
