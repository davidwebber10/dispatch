# Dispatch — Peer Threads: See, Watch, and Act on Each Other

**Date:** 2026-07-19
**Status:** Approved through implementation.

## Goal

Any thread in a project can see its peers, read them, watch them, and act
on them. You can tell a thread "watch the migration thread and when it
finishes, review its diff" — and it will, without polling, waking only
when the thing it cares about happens.

Today this power exists but is locked to one thread per project: a
`role: 'coordinator'` thread gets the `dispatch` agency MCP server
(`spawn_agent`, `read_agent`, `message_agent`, `complete_agent`, …) and
sees only *typed agent* threads. Ordinary threads — the ones the user
creates from "New Thread" — get nothing and don't know peers exist.

This feature generalizes that machinery rather than duplicating it.

## Decisions (confirmed)

1. **Full agency for every thread.** Ordinary threads get the same tool
   surface a coordinator has today — spawn, queue, start, message, answer,
   read, complete — plus the new peer/watch tools. No reduced tier.
2. **Watching is a push subscription.** A thread registers interest and
   goes idle at zero token cost; the daemon wakes it with a message when
   the target hits the criteria.
3. **Project-scoped.** Tools see every non-archived thread in the *same
   project* — plain, agent, and coordinator alike (a superset of the
   coordinator's current agent-only view) — and nothing outside it. A
   thread id from another project is rejected.
4. **Automatic, not opt-in.** Every claude-code and codex thread receives
   the tools and a context block naming its project and peers. Shell
   threads are excluded (nothing to inject into).

## Architecture

### Identity: the missing piece

The agency MCP runs as a **separate node process** spawned by the agent's
MCP client, reaching the daemon over HTTP. It currently receives only
`DISPATCH_SESSION` (the project) and `DISPATCH_PORT`. With one coordinator
per project that was enough; with N peers the server must know *which
thread is calling it*.

`DISPATCH_TERMINAL=<terminalId>` is added to the injected env. It becomes
the identity behind watcher registration, self-target refusal, spawn-depth
inheritance, and rate limiting. This is the enabling change for everything
below.

### Injection: one path, both providers

Agency injection today is a post-processing step (`withAgencyMcp`) that
rewrites the *Claude* MCP config JSON directly, so codex threads could
never receive it. This work moves the `dispatch` server into the normal
`McpServerSpec` list handed to `composeInjection`, which already emits
both the Claude config file and the equivalent codex `-c mcp_servers.*`
arguments. Codex peers come along for free, and the special-case file
`coordinator-<id>.mcp.json` disappears in favor of the standard path.

Coordinator behavior must be byte-identical afterward: same server name
(`dispatch`), same command, same `DISPATCH_SESSION`.

### Tools

Existing tools keep their names and semantics (coordinator prompts and
habits depend on them). Their *scope* widens from typed agents to all
threads in the project, and these are added:

| Tool | Behavior |
|---|---|
| `list_threads` | Every non-archived thread in this project: id, label, type, role/agentType, status, lastActivityAt, and `isSelf` on the caller's own row. |
| `read_thread(id, tail?)` | Transcript tail of any thread in the project (generalizes `read_agent`). |
| `message_thread(id, text)` | Send a message to any thread in the project (generalizes `message_agent`). |
| `watch_thread(id, when, note, once?)` | Register a subscription. `when` ∈ `idle` \| `needs_input` \| `error` \| `any`. `note` is the watcher's own reminder of why. |
| `unwatch_thread(watchId)` | Cancel a subscription. |
| `list_watches()` | What this thread is watching, and who is watching it. |

Every id argument is validated against `DISPATCH_SESSION`; an id outside
the project returns a clear "not in this project" error rather than data.

### Watch subscriptions

New table `thread_watches`: `id`, `watcher_terminal_id`,
`target_terminal_id`, `criteria`, `note`, `once` (default true),
`created_at`, `fired_at`. Persisted rather than in-memory so a daemon
restart doesn't silently drop a watch the user is relying on.

**Firing** hangs off the status machine that already exists. When
`StatusService` records a status edge for a terminal — the same place that
stamps activity and escalates agent events to coordinators — matching live
watches are looked up and delivered. Criteria map directly onto statuses:
`idle` (turn finished), `needs_input` (asked a question), `error`.

**Delivery** reuses the daemon's existing "send this thread a message"
path, selected by the target's transport exactly as the coordinator
escalation does today (structured threads via the structured manager; PTY
threads via the same input path a user message takes). The wake message
names the peer, says what happened, and echoes the watcher's own note:

> Thread "Fix login bug" (t_abc123) just went idle. You asked to watch it:
> "review its diff and report back". Use read_thread to see what it did.

One-shot watches delete themselves after firing. If the watcher is gone or
archived at fire time, the watch is dropped silently.

### Guards

Full agency for N peers makes two failures reachable that a single
coordinator never hit:

- **Spawn recursion.** Threads carry `spawnDepth` in config (`parent + 1`).
  `spawn_agent`/`queue_agent` refuse beyond depth 3 with an explanatory
  error naming the chain.
- **Message ping-pong.** Per `(sender, target)` pair, at most 10 messages
  per rolling hour (in-memory). Past that, the tool refuses and tells the
  caller to stop or ask the human.
- **Self-targeting** on watch/message/complete → error.
- **Watch fan-out** capped at 20 live watches per watcher.
- **Archive protection.** `complete_agent` archives; on a *plain* thread
  (no `role` — i.e. one the human created and may be typing in) it refuses
  unless called with `force: true`. Typed agents archive as they do today.
  This is the one deliberate piece of friction: full power retained, but a
  confused peer can't archive the user's active thread by accident.

### Injected context

A peer block is added to the system prompt of every eligible thread:
project name and working directory, the thread's own label and id, the
peer roster at spawn time (label, type, status), a summary of the peer
tools, and the etiquette rules (prefer `watch_thread` over polling; don't
ping-pong; the roster goes stale — `list_threads` is the live picture).
Coordinators keep `COORDINATOR_PROMPT` and receive the peer block without
duplicated instructions.

## Non-goals

- Cross-project visibility (explicitly rejected).
- Watching *content* patterns (e.g. "wake me when it mentions X") — only
  status criteria.
- Replaying missed watches after a watcher dies.
- Any UI surface for watches in this pass (tools only; a later pass can
  visualize who watches whom).

## Testing

- **Unit:** project-scope validation (foreign id rejected); watch CRUD and
  criteria matching; one-shot deletion; dead-watcher cleanup; each guard
  (depth cap, rate limit, self-target, fan-out, archive protection);
  `list_threads` includes plain threads and marks `isSelf`.
- **Injection:** the `dispatch` spec reaches both the Claude config and the
  codex args; `DISPATCH_TERMINAL` is present; a coordinator's resulting
  config is equivalent to today's.
- **Integration (isolated daemon, per `.claude/skills/verify/SKILL.md`):**
  two threads in one project; register a watch via the daemon's HTTP
  surface; drive the target to `idle` with a hook event; assert the watcher
  receives an injected message containing its note; assert a second
  status edge does NOT re-fire a one-shot watch.
