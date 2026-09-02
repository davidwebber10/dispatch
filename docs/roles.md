# Scheduled roles — operator guide

> Design reference: `docs/superpowers/specs/2026-09-02-scheduled-roles-design.md`.
> This page is the short, practical version: how to write a role, turn it on and off,
> and where to look when something needs your attention.

A **role** is a durable, refinable definition of recurring work — "check last night's
sync", "tidy the legacy repo", "watch open PRs" — that fires on a schedule as a fresh,
short-lived agent. The design's north star: **sessions are cattle, roles are pets.**
The role definition is the durable asset; every scheduled run is a brand-new agent that
inherits the role's accumulated context by *reading files*, never by resuming a
conversation. Nothing conversational lives long enough to rot.

## 1. Where a role lives

Roles live at the user level, outside every work repo — the same convention as
`~/.claude`:

```
~/.dispatch/roles/<name>/
  role.md       # the definition — frontmatter + brief body (you write and edit this)
  memory.md     # curated lessons; a role proposes them, a human prunes them
  log.jsonl     # append-only run reports (local runtime — not backed up)
```

`~/.dispatch/roles` can be its own git repo if you want the definitions backed up or
shared. Definitions travel by git. **Enabling never does** — checking out or pulling a
repo of role definitions must never start any agent on a machine (see §3, below).

## 2. `role.md` format

`role.md` starts with a flat frontmatter block between `---` fences, followed by the
brief body (plain text — what the role does, its soft rules, its output contract).

```yaml
---
name: rollup-nightly-check
project: Shopify Product Rollup     # a Dispatch PROJECT NAME, matched exactly (spaces and case) — or use global: true
agentType: researcher               # planner | implementer | researcher | reviewer |
                                     # design-reviewer | code-reviewer
model: sonnet                       # optional; omit for the type's default model
schedule: {"type":"daily","time":"05:30"}
tz: America/Indianapolis
authority: stage                    # observe | stage | stage-deploy — see §5
wallClockCapMin: 30                 # optional; default 45
---
Check last night's runs. <the rest of the brief body>
```

Frontmatter syntax rules (this is a small hand-rolled parser, not YAML):

- Each line is flat `key: value` — no nesting, no lists-of-maps.
- A value is `JSON.parse`d when it starts with `{`, `[`, or `"`, or equals `true`,
  `false`, or a number. Otherwise it is kept as the raw trimmed string.
- `schedule` must be valid JSON matching an existing `recurrence_rule` shape — daily,
  weekly, cron, or interval. See `packages/core/src/agents/recurrence.ts` for the exact
  shapes. Example weekly form: `{"type":"weekly","day":"mon","time":"09:00"}`.
- A non-global role needs `project:` naming a Dispatch project that already exists. Use
  `global: true` instead of `project:` for a role that isn't bound to one project (it
  runs against a shared **Operations** project — see §6).
- `authority` defaults to `stage` if omitted. `wallClockCapMin` defaults to 45.

The daemon re-reads and re-parses `role.md` fresh at every fire — an edit you make today
is picked up by tonight's run with no re-registration step.

**The runner never edits `role.md`.** It may *propose* brief or memory changes in its
run report, but applying a proposal is always a separate, deliberate human step (see
§4). This is the guard against slow self-inflicted brief drift.

## 3. Enabling and disabling a role

Placing a `role.md` file only makes a role *discoverable* — it does not start anything.
Turning a role on is a deliberate, per-machine act, run from the CLI against your local
daemon:

```bash
dispatch roles list              # every discovered role: enabled?, next run, failures, errors
dispatch roles enable <name>     # turn a role on (creates or updates its schedule)
dispatch roles disable <name>    # turn a role off (its run history and log.jsonl are kept)
```

Because enabling is per-machine, pulling `~/.dispatch/roles` from git onto a new machine
never activates anything by itself — you still run `dispatch roles enable <name>` there
yourself. Disabling keeps the role's schedule row and failure history; re-enabling
resumes from a clean slate for the auto-disable counter (see §5).

## 4. Where logs live, and how proposals are applied

Every run appends one report line to that role's own log:

```
~/.dispatch/roles/<name>/log.jsonl
```

Each line is one JSON object: `{ start, end, outcome, summary, links, attempt,
proposedBriefChanges? }`. `outcome` is one of `ok`, `attention`, or `failed`. Nothing
else reads or rewrites this file except the daemon appending the next run's report.

**Applying a proposed brief or memory change is deliberate-manual in v1.** A role may
suggest an exact old-text-to-new-text edit in its run report's `proposedBriefChanges`
field; the morning digest (§6) surfaces it. No agent ever applies its own proposal —
you review it and apply it yourself, either by opening the role's `role.md` or
`memory.md` in a file tab and editing it directly, or by asking an attended agent to
make the edit for you. There is no "approve" button that lets a role edit itself.

## 5. Authority levels

Each role declares an `authority` level in its frontmatter. The level is enforced at
the tool-call membrane — the same mechanism that already gates the coordinator's own
tool use — not just written as a soft rule in the brief.

| Level | May do | Never |
|---|---|---|
| `observe` | read-only actions, and report | any file write |

> Note: `observe` denies **every** file write, including a role's own deliverable.
> A digest-style role whose job is writing a file (like the shipped `morning-digest`)
> needs `authority: stage`, with the brief narrowing writes to its deliverable and
> memory proposals. Do not model a file-writing role on `observe`.
| `stage` (default) | write on branches, `git commit`, `git push <remote> <branch>` (branch not main/master/prod\*), `gh pr create` | see below |
| `stage-deploy` | everything `stage` allows, plus `gh workflow run … environment=staging` and other explicit staging-deploy forms | see below |

Denied at **every** level, with no exception: a bare `git push` with no explicit
remote and branch (an ambiguous target), any explicit push to a branch matching
`main`/`master`/`prod*`, every `gh pr merge`, any `gh workflow run` naming
`environment=production` (or omitting `environment=` — ambiguous is treated as
denied), `gh release`, package publishes, `dispatch update`/`dispatch release`, and
`terraform apply`/`terraform destroy`.

**Main and production mutations are explicit human approval only — always.** A role's
authority level never overrides that; GitHub branch protection on `main` remains the
backstop underneath the policy either way.

## 6. The Operations project and the morning digest

Global roles (`global: true`) run against a shared **Operations** project rather than a
per-role directory, at `~/.dispatch/operations`. The daemon creates this project the
first time it's needed.

The **morning-digest** role is itself a global role. Each morning it reads every role's
latest run report plus every project's live status, and writes one cross-project
summary — leading with failures, staged work awaiting review, and any proposed brief
changes — to a single file:

```
~/.dispatch/operations/digest.md
```

That file is the entire deliverable; nobody reads the digest role's own run thread. The
Operations project keeps a pinned **FILES** tab open on `digest.md` so the current
digest is always one tap away, and a push notification's tap-through lands there too.
The daemon ensures this tab exists (and seeds an empty placeholder file, so the tab
never opens to a read error before the first run lands).

## 7. Supervision (automatic, daemon-side)

No agent supervises another agent — this is deterministic bookkeeping in the daemon:

- A failed, errored, or wall-clock-capped run retries **once**, fresh.
- A second failure the same night is recorded as failed; the next morning's digest
  leads with it.
- **Two consecutive failed nights auto-disables the role** and raises a Needs-you push.
  Re-enable it yourself once you've addressed the cause: `dispatch roles enable <name>`.
- A run still going past its `wallClockCapMin` (default 45 minutes) is interrupted and
  counted as a failed run — a role can never run forever just because nothing else
  stopped it.

## 8. v1 limits

- **`claude-code` runners only.** The authority policy in §5 is enforced by a
  membrane hook that currently only exists for the `claude-code` adapter. Opening
  roles to `codex`, `grok`, or `opencode` requires the equivalent hook in each of
  those adapters first.
- **Enabling is per-machine, always.** There is no "enable everywhere" — if you run
  the same `~/.dispatch/roles` checkout on two machines, you enable a role on each one
  independently, by design (see §3).
- **No in-repo or on-demand roles yet.** v1 roles live only at the user level and only
  fire on their own schedule; team-owned roles that evolve via PRs in a work repo, and
  coordinator-invoked on-demand roles, are both out of scope for v1.
- **Applying a proposed change is always manual** (§4) — there is no one-click apply.
