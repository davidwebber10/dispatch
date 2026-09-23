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
Jason chose: fix B1, B2, M1, M2, M3, plus the test gaps. Plan:
`docs/superpowers/plans/2026-09-23-pr47-phase2-remediation.md`.
