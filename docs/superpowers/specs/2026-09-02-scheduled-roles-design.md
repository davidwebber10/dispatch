# Scheduled Roles — design spec

*2026-09-02 · brainstormed with Jason · status: awaiting review*

## Motivation

The Overseer usage analysis (see `docs/superpowers/plans/2026-09-02-overseer-tuning.md`)
found recurring work run by hand — ~10 nightly "check last night's run" researcher
spawns, 16 near-identical commit-chore spawns — plus a standing wish for overnight
autonomy without the failure mode Jason has already lived through: **context rot in
long-lived agents**, driven by turns, context growth, AND wall-clock staleness (the
world moves while the context stands still; Explorer's cautious operating rules are
scar tissue from this).

Design north star: **sessions are cattle, roles are pets.** The durable, refinable
asset is a role defined in files. Every incarnation is a short-lived fresh session
that inherits the role's full accumulated refinement by reading files — never by
resuming a conversation. Nothing conversational lives long enough to rot; wall-clock
staleness is structurally impossible because every incarnation is minutes old.

## 1. Role definition and storage

**Where a role runs and where it lives are separate.** Roles live at the USER level,
outside every work repo (mirrors the `~/.claude` global-config convention):

```
~/.dispatch/roles/<name>/
  role.md       # the pet — YAML frontmatter + brief body (human-curated)
  memory.md     # curated lessons, size-capped; agents propose, humans prune
  log.jsonl     # append-only run reports — LOCAL runtime, excluded from backup
```

`role.md` frontmatter:

```yaml
---
name: rollup-nightly-check
project: shopify-product-rollup     # Dispatch project binding — or `global: true`
agentType: researcher               # persona/tier from the existing typed-agent set
model: sonnet                       # optional override; else MODEL_FOR_TYPE default
schedule: { type: daily, time: "05:30" }
tz: America/Indianapolis
authority: stage                    # observe | stage | stage-deploy (see §5)
wallClockCapMin: 45                 # optional; default 45
---
<brief body: what the role does, its soft rules, its output contract>
```

- `role.md` is the single source of truth, re-read at every fire — a brief edit today
  is inherited by tonight's run with no re-registration.
- The runner may **propose** brief/memory changes in its run report; it never edits
  `role.md` itself (prevents drift-by-small-self-edits — the brief-rot guard).
- **Applying proposals (v1): deliberate-manual.** Proposals are written as exact
  ready-to-apply blocks (old text → new text); the digest surfaces them; the human
  applies via a file-tab edit or by asking an attended agent. No agent-initiated
  self-editing, even on approval. v1.1 candidate: a one-click Apply in the digest
  (daemon-side file edit, no agent) — the exact-diff format is chosen to make that
  trivial later.
- Backup/sharing: `~/.dispatch/roles` can be its own git repo (private remote).
  Definitions travel by git; **activation never does** — pulling a repo must not
  silently start agents on a machine.
- DB (`roles` table) holds ONLY operational state: enabled, last_run_at,
  consecutive_failures, next_fire. Enabling is a deliberate per-machine act; the
  daemon discovers `role.md` files and lists them available-but-disabled.
- **v2 (explicitly deferred):** in-repo `.dispatch/roles/` for team-owned roles that
  evolve via PRs; on-demand (coordinator-invoked) role incarnations.

## 2. Run lifecycle

1. **Trigger** — the daemon scheduler fires per frontmatter cron (extends the
   existing `agent_schedules` machinery).
2. **Birth** — a FRESH typed agent spawns in the bound project via the existing
   `spawnStructured` path: persona from `agentType`, model from frontmatter, visible
   in the rail under a mission named for the role. Seed context assembled at spawn:
   brief body + `memory.md` + tail of `log.jsonl` (last 3 reports) + authority rules
   + **a current timestamp with a freshness instruction** (verify the world before
   acting — fetch, check branch/data state; trust nothing remembered).
3. **Life** — one bounded stint; the daemon enforces `wallClockCapMin` (interrupt at
   cap → counts as a failed run).
4. **Death** — the runner ends with `report_status` + a structured final summary. The
   daemon appends one run report to `log.jsonl` — `{ start, end, outcome, summary,
   links (branch/PR), proposedBriefChanges? }` — and archives the thread (it stays
   readable in the rail's Done section). The report is the inheritance; the session
   is disposable.

## 3. Supervision

Deterministic, daemon-side. No agent supervises an agent.

- A failed / errored / wall-capped run retries ONCE, fresh.
- Second failure that night → the run is recorded failed; the digest leads with it.
- **2 consecutive failed nights → the role auto-disables and raises a Needs-you.**
- Future hook (not v1): route the failure signal to the project coordinator first
  (overseer-mediated supervision) before raising to the human.

## 4. Morning digest

Itself a global role. Each morning it reads every role's latest run report and every
coordinator's status/lastOutcome, posts ONE cross-project summary, and sends a
push-notification headline (existing push machinery). Leads with failures and
staged-work-awaiting-review (including any proposed brief changes); suppresses
"nothing happened" noise.

**Display (v1): existing surfaces, zero new UI.** The summary lands in a pinned
**file tab** — `digest.md` in a small dedicated **Operations** project — newest
entry on top, night-over-night history in one scrollback, PWA-readable, push
tap-through lands on it. (A file tab rather than a message thread: posting a
message to a thread wakes that thread's model; a display board should have no
model to wake.) The digest RUNNER thread archives like any role run — the file
holds only the deliverable. A purpose-built digest panel is deferred until the
file version proves insufficient.

**Implementation note (from machinery recon):** roles ride the existing
`agent_schedules` scheduler/recurrence/`agent_runs` telemetry unchanged; the role
branch spawns a STRUCTURED typed agent (persona/model/policy/report_status for
free) with the seed delivered as the first message — the same shape as
coordinator-spawned agents — instead of the static-prompt PTY runner path.

## 5. Authority

Per-role frontmatter, enforced at the structured membrane by a role-runner variant of
`coordinatorToolPolicy` (same mechanism shipped in v2.35.0). The enforcement trick:
**deny every ambiguous command form; allow only explicit forms whose target is
textually visible.**

| Level | May do | Never |
|---|---|---|
| `observe` | read-only + report | any write |
| `stage` (default) | write on branches, commit, `git push <remote> <branch>` (branch ∉ main/master/prod*), `gh pr create` | see below |
| `stage-deploy` | + `gh workflow run … environment=staging` and other explicit staging-deploy forms | see below |

Always denied at the membrane, every level: bare `git push` (ambiguous target),
any explicit push to main/master/prod*, ALL `gh pr merge` (base branch invisible to
the policy — staging integration uses the push-to-stage flow the repos already use),
`environment=production`, `gh release`, publishes, `dispatch update/release`,
terraform apply/destroy. Soft rules the regex cannot see (never re-run production
jobs, never mutate data) live in the brief. GitHub branch protection on main remains
the structural backstop beneath the policy. **Main and production mutations are
explicit human approval only — always.**

Fallback pre-approved by Jason: if `stage-deploy` proves hard to thread during
implementation, v1 ships with the blanket ban (drop the level; keep `observe`/`stage`).

## 6. Provider scope

- The role layer (files, seed, reports, digest) is provider-agnostic plain text by
  construction — any model or human reads the same thing.
- Daemon-side machinery (scheduler, caps, retry, log, digest) never touches a model
  API.
- **v1 runners are claude-code only**: it is the only adapter with hard authority
  enforcement (the membrane policy hook). Opening roles to codex/grok/opencode
  requires the equivalent policy hook in each adapter first — named here as the
  explicit precondition. A `provider:` frontmatter field slots in then.

## 7. v1 seed roles (the first real workload)

1. **rollup-nightly-check** — the delta-sync / OIC overnight validation sweeps
   (researcher, sonnet, `stage` — so a diagnosed failure can arrive as a staged fix
   branch + PR, per the "reviewable when I resume" goal).
2. **legacy-repo-chores** — the recurring Legacy commit/cleanup chores (implementer,
   sonnet, stage).
3. **ci-pr-babysitter** — global; watches open PRs across projects, reports failures
   and stalls (researcher, sonnet, observe).
4. **morning-digest** — global; §4 (researcher, sonnet, observe).

## Out of scope for v1

In-repo team roles · on-demand role invocation · overseer-mediated supervision ·
non-claude runners · any whitelisted-fix authority (the "fix within a playbook"
level) · cross-project lead agent.
