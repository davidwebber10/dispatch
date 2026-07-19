# Peer Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every claude-code/codex thread can see, read, watch, message, and act on its project peers; watching is a push subscription that wakes an idle thread when a peer finishes, asks, or errors.

**Architecture:** The existing coordinator-only `dispatch` agency MCP is generalized — it learns the caller's identity (`DISPATCH_TERMINAL`), moves onto the standard injection path (so codex threads get it too), widens its scope from typed agents to all threads in the project, and gains watch tools backed by a `thread_watches` table fired from the status machine.

**Tech Stack:** TypeScript ESM, better-sqlite3, Express, MCP stdio server, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-peer-threads-design.md`.
- **Scope is the project.** Every thread id crossing a tool boundary is validated against `DISPATCH_SESSION`; a foreign id returns an error, never data.
- **Existing tool names and semantics do not change** — coordinators depend on them. Only their scope widens and new tools appear alongside.
- **Ungating is Task 8, deliberately last.** Until then only coordinators receive the server, so a daemon running mid-implementation never has unguarded peers.
- Watch delivery reuses existing paths: structured → `sessionService.sendStructuredMessage`, PTY → `sessionService.writeToTerminal`. No new transport code.
- Guards are refusals with explanatory messages, never silent no-ops.
- Core tests from `packages/core` (`npx vitest run`), never repo root.
- This Mac runs the user's real daemon: no lifecycle commands, no real spawns; isolated daemon (fake HOME, PORT 3999) only where the plan says so.

---

### Task 1: caller identity + one injection path (still coordinator-gated)

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (`withAgencyMcp` → replaced by a spec builder; both spawn paths — the structured one at ~1470 and the PTY one, find it with `rg -n "withAgencyMcp"`)
- Modify: `packages/core/src/overseer/agency-mcp.ts` (read `DISPATCH_TERMINAL`)
- Test: `packages/core/tests/sessions/` (add an injection test file if none covers this)

**Interfaces:**
- Produces: `agencyServerSpec(terminalId: string, sessionId: string): McpServerSpec` — `{ name: 'dispatch', command: 'node', args: [<agency-mcp.js>], env: { DISPATCH_SESSION, DISPATCH_PORT, DISPATCH_TERMINAL } }`, pushed into the `specs` array handed to `composeInjection` instead of post-processing the Claude config file.
- In agency-mcp.ts: `function selfTerminalId(): string { return process.env.DISPATCH_TERMINAL || ''; }` beside the existing `sessionId()` helper.

- [ ] **Step 1: Failing test** — build the injection for a coordinator terminal and assert: the Claude config at the returned path contains an `mcpServers.dispatch` entry whose `env.DISPATCH_TERMINAL` is the terminal id and whose `env.DISPATCH_SESSION` is the session id; and (codex parity) that `composeInjection`'s `codexArgs` contain `mcp_servers.dispatch.command`. Mirror the setup style of the nearest existing service test.
- [ ] **Step 2: Run** → RED.
- [ ] **Step 3: Implement.** Replace `withAgencyMcp`'s file-rewriting with a spec pushed into `specs` before `composeInjection` runs, in BOTH spawn paths. Keep the gate exactly as it is for now (`config.role === 'coordinator' ? [agencySpec] : []`). Delete the now-dead `coordinator-<id>.mcp.json` writing. Read `mcp/injection.ts` first — `composeInjection` already emits both Claude JSON and codex `-c` args from one spec list, which is the whole point of the move.
- [ ] **Step 4:** file GREEN → full core suite GREEN → `npx tsc -b` clean.
- [ ] **Step 5: Commit** — `feat(core): agency MCP carries caller identity and rides the standard injection path`

---

### Task 2: `thread_watches` table + db layer

**Files:**
- Modify: `packages/core/src/db/schema.ts` (migrations array — follow the existing `{table, column, sql}` entries; a new TABLE goes in the CREATE TABLE section beside the others)
- Create: `packages/core/src/db/watches.ts`
- Test: `packages/core/tests/db/watches.test.ts`

**Interfaces:**
- Produces:
```ts
export interface WatchRow {
  id: string; watcher_terminal_id: string; target_terminal_id: string;
  criteria: 'idle' | 'needs_input' | 'error' | 'any';
  note: string | null; once: number; created_at: string; fired_at: string | null;
}
export function create(db, input: { watcherTerminalId: string; targetTerminalId: string; criteria: WatchRow['criteria']; note?: string | null; once?: boolean }): string;
export function listByWatcher(db, watcherTerminalId: string): WatchRow[];   // live only (fired_at IS NULL or once=0)
export function listByTarget(db, targetTerminalId: string): WatchRow[];      // live only
export function liveForTarget(db, targetTerminalId: string, status: string): WatchRow[]; // criteria matches status or 'any'
export function markFired(db, id: string): void;    // sets fired_at; one-shot rows stay for audit but stop matching
export function remove(db, id: string): boolean;
export function removeForTerminal(db, terminalId: string): void; // watcher OR target gone
export function countByWatcher(db, watcherTerminalId: string): number;
```

- [ ] **Step 1: Failing tests** — create/list round-trip; `liveForTarget` matches exact criteria and `'any'` but not a different status; `markFired` removes a `once` row from live results but leaves a `once:0` row live; `remove`/`removeForTerminal`; `countByWatcher`. Use the in-memory sqlite helper the other db tests use.
- [ ] **Step 2: Run** → RED. **Step 3: Implement** (table: `CREATE TABLE IF NOT EXISTS thread_watches (...)` with indices on `target_terminal_id` and `watcher_terminal_id`). **Step 4:** GREEN + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(db): thread_watches table and accessors`

---

### Task 3: watch HTTP endpoints

**Files:**
- Modify or create: `packages/core/src/routes/watches.ts` (new router, mounted in `server.ts` next to the other routers — copy a small existing router's shape, e.g. `routes/update.ts`)
- Test: `packages/core/tests/routes/watches.test.ts`

**Interfaces:**
- Produces (all project-scoped — the handler verifies watcher and target share a session, else 400 `{error:'not in this project'}`):
  - `POST /api/watches` body `{ watcherTerminalId, targetTerminalId, criteria, note?, once? }` → `201 { id }`
  - `GET /api/watches?watcher=<id>` → `{ watching: WatchRow[], watchedBy: WatchRow[] }` (accepts `?target=` too)
  - `DELETE /api/watches/:id` → `{ ok: true }` / 404
- Consumes: Task 2's db layer.

- [ ] **Step 1: Failing tests** — create/list/delete happy paths; cross-project rejected with 400; unknown terminal → 404; fan-out cap (20 live per watcher, from the shared constant in Task 6 — until that task lands, define the constant here and have Task 6 import it) → 429 with a clear message.
- [ ] **Step 2–4:** RED → implement → GREEN + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(api): watch subscription endpoints`

---

### Task 4: peer tools in the agency MCP

**Files:**
- Modify: `packages/core/src/overseer/agency-mcp.ts` (tool list + dispatch switch — both are explicit arrays/switches, follow their shape exactly)
- Test: `packages/core/tests/overseer/agency-mcp.test.ts` (extend; if the file's tools are tested through a fake fetch, reuse that harness)

**Interfaces:**
- Produces these tools (JSON-schema entries + switch cases), all calling the daemon over the existing `api()`/fetch helper:
  - `list_threads` → GET the project's terminals, map to `{ id, label, type, role, agentType, status, lastActivityAt, isSelf }` (isSelf = id === `DISPATCH_TERMINAL`), excluding archived.
  - `read_thread({ id, tail? })` → same underlying call `read_agent` uses, minus the agent-type filter, after a project check.
  - `message_thread({ id, text })` → same call `message_agent` uses, after a project check.
  - `watch_thread({ id, when, note?, once? })` → `POST /api/watches` with `watcherTerminalId = DISPATCH_TERMINAL`.
  - `unwatch_thread({ watchId })` → `DELETE /api/watches/:id`.
  - `list_watches()` → `GET /api/watches?watcher=<self>`.
- Shared helper `assertInProject(id)`: fetches the terminal, throws a tool error `"<id> is not a thread in this project"` when its session differs from `DISPATCH_SESSION`.

- [ ] **Step 1: Failing tests** for each new tool: happy path shape; foreign id → project error; `list_threads` includes plain (role-less) threads and marks `isSelf`; `watch_thread` without `DISPATCH_TERMINAL` set → clear error (defensive: identity missing means an old injection).
- [ ] **Step 2–4:** RED → implement → GREEN + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(mcp): peer tools — list/read/message/watch threads`

---

### Task 5: firing and delivery

**Files:**
- Modify: `packages/core/src/status/service.ts` (where status edges are recorded — the same block that stamps activity and calls `onActivity`)
- Create: `packages/core/src/sessions/watch-dispatcher.ts`
- Test: `packages/core/tests/sessions/watch-dispatcher.test.ts`

**Interfaces:**
- Produces:
```ts
export class WatchDispatcher {
  constructor(db, deliver: (terminalId: string, text: string) => void, opts?: { now?: () => number });
  /** Called on every status edge; finds live matching watches, delivers, marks fired. */
  onStatus(targetTerminalId: string, status: string): void;
}
export function composeWakeMessage(target: { id: string; label: string }, status: string, note: string | null): string;
```
- Wiring: `server.ts` constructs it with a deliver function that picks transport per target — structured → `sessionService.sendStructuredMessage(id, text)` (after `ensureStructuredAlive`), PTY → `sessionService.writeToTerminal(id, text + '\n')`; StatusService calls `onStatus` beside its existing activity callback.
- Message text per the spec: names the peer and id, what happened, echoes the note, points at `read_thread`.

- [ ] **Step 1: Failing tests** (fake db rows + a capturing `deliver`): a matching watch delivers exactly once and is marked fired; a one-shot does NOT fire on a second edge; `'any'` matches every status; a non-matching status delivers nothing; a watch whose watcher row is gone is removed and delivers nothing; `composeWakeMessage` includes label, status, and note.
- [ ] **Step 2–4:** RED → implement → GREEN + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(core): watch dispatcher wakes watchers on peer status edges`

---

### Task 6: guards

**Files:**
- Create: `packages/core/src/overseer/guards.ts` (pure predicates + constants, importable by both the MCP server and the routes)
- Modify: `packages/core/src/overseer/agency-mcp.ts` (apply them), `packages/core/src/sessions/service.ts` (stamp `spawnDepth` on spawned threads)
- Test: `packages/core/tests/overseer/guards.test.ts`

**Interfaces:**
```ts
export const MAX_SPAWN_DEPTH = 3;
export const MAX_MESSAGES_PER_PAIR_PER_HOUR = 10;
export const MAX_LIVE_WATCHES_PER_WATCHER = 20;
export function checkSpawnDepth(parentDepth: number): { ok: true } | { ok: false; reason: string };
export class PairRateLimiter { constructor(opts?: { now?: () => number }); check(sender: string, target: string): { ok: true } | { ok: false; reason: string }; }
export function checkSelfTarget(selfId: string, targetId: string, verb: string): { ok: true } | { ok: false; reason: string };
export function checkArchiveAllowed(target: { role?: string | null }, force: boolean): { ok: true } | { ok: false; reason: string };
```
- `spawn_agent`/`queue_agent` read the caller's `config.spawnDepth ?? 0`, refuse past `MAX_SPAWN_DEPTH`, and stamp `spawnDepth: parent + 1` on the child.
- `complete_agent` calls `checkArchiveAllowed` — a target with no `role` refuses unless `force: true` was passed (add `force` to that tool's schema).

- [ ] **Step 1: Failing tests** for every predicate incl. boundaries (depth exactly at cap refuses, one below allows; 10 messages pass and the 11th refuses; the window rolls; self-target refused per verb; archive refused on role-less target, allowed with force, allowed on a typed agent without force).
- [ ] **Step 2–4:** RED → implement → GREEN + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(core): peer guards — spawn depth, pair rate limit, self-target, archive protection`

---

### Task 7: injected peer context

**Files:**
- Modify: `packages/core/src/overseer/prompts.ts` (new `PEER_PROMPT` + a builder), `packages/core/src/sessions/service.ts` (include it in `prompts` for eligible threads)
- Test: `packages/core/tests/overseer/prompts.test.ts` (extend or create)

**Interfaces:**
- Produces `buildPeerPrompt(ctx: { projectName: string; workingDir: string; selfLabel: string; selfId: string; peers: { label: string; type: string; status: string }[] }): string` — project + identity + roster + tool summary + etiquette (prefer `watch_thread` over polling; don't ping-pong; roster is a snapshot, `list_threads` is live).
- Coordinators get `COORDINATOR_PROMPT` + the peer block with no duplicated instructions (the peer block must not re-explain spawning).

- [ ] **Step 1: Failing tests** — the built prompt contains the project name, the thread's own label, each peer's label, and the `list_threads` staleness note; an empty roster renders a sensible "no peers yet" line rather than a dangling header.
- [ ] **Step 2–4:** RED → implement → GREEN + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(core): peer context injected into thread system prompts`

---

### Task 8: ungate — every thread becomes a peer

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (both spawn paths' gate)
- Test: extend Task 1's injection test file

**Interfaces:** Consumes Tasks 1–7. No new exports.

- [ ] **Step 1: Failing test** — a PLAIN thread (no `config.role`) of type `claude-code` receives the `dispatch` server with its own `DISPATCH_TERMINAL`; the same for `codex`; a `shell` thread receives NO dispatch server and no peer prompt.
- [ ] **Step 2: Run** → RED (plain threads currently get nothing).
- [ ] **Step 3: Implement** — replace `config.role === 'coordinator' ? [spec] : []` with eligibility by type (`claude-code`/`codex`, not shell) in both spawn paths, and include the peer prompt for those same threads.
- [ ] **Step 4:** GREEN + full core suite + tsc.
- [ ] **Step 5: Commit** — `feat(core): all claude/codex threads receive peer tools and context`

---

### Task 9: runtime verification (isolated daemon)

**Files:** none committed unless a defect is found.

- [ ] **Step 1:** Build; launch per `.claude/skills/verify/SKILL.md` — fake HOME under the scratchpad, `PORT=3999`, `DISPATCH_WEB_DIST=<worktree>/packages/web/dist`. NEVER port 3456, never the real `~/.dispatch`.
- [ ] **Step 2:** Create one project and two claude-code threads (A and B) via curl.
- [ ] **Step 3:** Register a watch directly against the HTTP surface: `POST /api/watches {watcherTerminalId: A, targetTerminalId: B, criteria: 'idle', note: 'review its diff'}`.
- [ ] **Step 4:** Drive B to idle with a hook event (`POST /api/events/claude/<B>` `{"hook_event_name":"Stop","session_id":"x"}`). Assert A received the wake message — check the daemon log and/or A's transcript ring via its API for the note text "review its diff".
- [ ] **Step 5:** Fire another `Stop` on B; assert the one-shot did NOT deliver twice. Assert `GET /api/watches?watcher=A` shows no live watch.
- [ ] **Step 6:** Cross-project rejection: create a second project with thread C; `POST /api/watches` with A watching C → 400.
- [ ] **Step 7:** Kill the daemon (`lsof -ti :3999 | xargs kill`). Report evidence per step; on any failure report BLOCKED with the daemon log tail rather than fixing code.

---

## Self-Review (performed)

- **Spec coverage:** identity → T1; injection unification + codex parity → T1; table → T2; endpoints → T3; tools + project scope → T4; push delivery → T5; all five guards → T6; injected context → T7; automatic-for-every-thread → T8; integration incl. one-shot and cross-project → T9.
- **Placeholders:** none. Where the plan says "follow the existing shape", it names the checked-in file to read.
- **Type consistency:** `criteria` union identical in db/routes/tools/dispatcher; `DISPATCH_TERMINAL` spelled identically throughout; guard constants live in one module imported by both consumers (T3 defines the fan-out constant and T6 imports it — noted at both sites).
- **Ordering:** the risky ungate is T8, after every guard exists (T6) — deliberate.
