---
title: Per-thread keys (the daemon stops trusting every local caller)
date: 2026-10-23
status: draft for owner review (review rounds 1 and 2 fixed; no round 3; amended 2026-10-23 with owner decision PK-4)
base: main 0ce95415 (v3.4.0)
builds on: docs/superpowers/specs/2026-10-22-network-exposure-design.md (Phase 1 shipped in v3.4.0)
findings: SEC-05 (main), SEC-20, SEC-22, SEC-25 (unlocked by this design), SEC-04 (partly)
---

# Per-thread keys

## 1. Summary

Since v3.4.0 the daemon refuses other devices and foreign web pages. It still trusts
**every program on this computer** that connects over loopback with a local `Host`
name. Every agent thread is such a program. So the rules that Dispatch puts on
agents (spawn depth, message rate, project scope, "only the coordinator writes the
ledger", "only the human is `source: user`") are checked inside the agent's own MCP
helper, or taken from the request body. An agent that calls the API directly skips
all of them.

This design gives each agent process its own random key. The daemon maps the key to
the thread, takes the caller's identity from the key and never from the body, and
enforces the rules itself. A thread key can call only a short allowlist of routes.
Everything else stays with the owner, whose credentials are the browser cookie and
the access token from Phase 1.

One rule gets looser on purpose (owner decision PK-4, 6.4.1): a project's overseer
(its coordinator) can read threads in every project and can message another
project's overseer. It still cannot start, archive or answer threads, or write
ledger items, outside its own project. Workers stay inside their own project.

It ships in three stages:

- **Stage 1: keys and daemon-side rules.** Every spawn gets a key. Every first-party
  caller sends a credential. The daemon enforces scope for every request that
  carries a thread key. Requests with no credential from this computer still work,
  and are logged.
- **Stage 2: no credential, no access.** A request from this computer with no
  credential gets the sign-in page or `401`, the same as a request from another
  device. The CLI reads the token file and threads hold keys, so they see no change.
  Each browser signs in once, with `dispatch open` (one command, no typing of the
  token).
- **Stage 3 (optional, later): process check.** On loopback, the daemon looks up
  which process opened the connection, so that a thread cannot use the owner's
  token or another thread's key. Section 6.10.

The honest limit, stated up front: every thread runs as the owner's OS user. A thread
that sets out on purpose to read `~/.dispatch/access-token` can still become the
owner. Stages 1 and 2 close the normal paths (an agent that calls the API with
`curl`, an agent that is told to "approve" something, a tool call with a forged
body). Stage 3 makes the deliberate path harder. No stage makes it impossible on a
shared OS user. Section 8 lists every residual risk.

## 2. Goals and non-goals

**Goals**

1. The daemon knows which thread made each request, and the thread cannot lie
   about it.
2. Every agent guard that matters is enforced in the daemon: identity, project
   scope (with the overseer reach of PK-4, 6.4.1), spawn depth, message rate, "questions only" for `answer_agent`,
   coordinator-only ledger writes, never `source: user` from an agent.
3. A thread key cannot reach owner-only actions: secrets, integrations, schedules,
   roles, settings, sign-in, update, access, push, raw terminal input, any
   WebSocket.
4. Works for all four harnesses (claude-code, codex, grok, opencode), both views
   (CLI and Pretty), every thread type, macOS, Linux, WSL2, and the hosted box.
5. No lasting secret ever goes into a command line (the owner's machines log every
   argv). The one exception is the single-use, 60-second sign-in code of
   `dispatch open` (6.6).
6. The owner's CLI and scripts keep working with no new step in the normal case.
   Each browser signs in once at stage 2.
7. No off switch (section 7.4).

**Non-goals**

- An OS-level sandbox for agents. Agents keep running with the owner's rights and
  no approvals (finding SEC-06, accepted).
- A fix for prompt injection itself. A thread key still lets an injected thread do
  everything its own tools allow. Findings SEC-07 and SEC-25 need their own work;
  this design gives them the identity they need.
- Scoped Doppler tokens (SEC-04 item 1). Separate work.
- Several human users per daemon. One owner per daemon, as today.

## 3. Who calls the daemon from this computer today

Paths are under `packages/core/src` unless they start with `packages/`.

| Caller | Started by | How it finds the daemon | Identity it sends today | Routes |
|---|---|---|---|---|
| Agency MCP (`dispatch` tools, `overseer/agency-mcp.ts`) | The agent CLI, as an MCP child, in every claude-code, codex, grok and opencode thread (`sessions/service.ts:2833`) | `DISPATCH_API` or `localhost:DISPATCH_PORT` (`agency-mcp.ts:45-47`); env built at `sessions/service.ts:2853-2866` | `DISPATCH_TERMINAL`, `DISPATCH_SESSION`, `DISPATCH_SPAWN_DEPTH` from env, sent as body fields (`caller`, `config.spawnDepth`, `config.spawnedBy`, `source`, `watcherTerminalId`) and as path ids | Create thread, worker defaults, list and read threads, message, start, archive, permission read and answer, watches, report status, every ledger route |
| Memory MCP (`endless/memory-mcp.ts`) | The Chat turn CLI and the Chat summarizer CLI (`endless/turn-runner.ts:194`, `endless/summarizer-claude.ts:76`) | `memory.mcp.json`, written at daemon start with `DISPATCH_PORT` (`endless/service.ts:160`) | None. Creates workers with `spawnDepth: 1, origin: 'endless'` (`memory-mcp.ts:240`) | Chat reads, arm and disarm, Chat ledger, create worker in any project, read any transcript, archive |
| Claude status hooks (`type: 'http'`) | Claude CLI, CLI view only (`providers/claude-code.ts:134-153`) | URL in the per-thread settings file `hooks/ID.json` | Terminal id in the path | `POST /api/events/claude/ID` |
| `codex-notify.mjs` | Codex CLI `notify`, CLI view only (`providers/codex.ts:59-65`) | URL in argv | Terminal id in the path | `POST /api/events/codex/ID` |
| `grok-hook.mjs` | Grok hook, CLI view only (`providers/grok-home.ts:91-93`) | URL in `hooks.json` | Terminal id in the path | `POST /api/events/grok/ID` |
| Browser shim (`dispatch-open`, `open`, `xdg-open`; `auth/shim.ts`) | Any program in any thread or shell tab that opens a URL (for example `gh auth login`) | `DISPATCH_SERVER_URL` in every child env | `DISPATCH_TERMINAL_ID` as a body field | `POST /api/auth-requests` |
| `dispatch` CLI (`packages/cli/src/index.ts`) | The owner | `localhost:PORT` | None | `status` probe (`GET /api/sessions`), `roles` (`GET /api/roles`, enable, disable) |
| Owner scripts and skills | The owner or an agent | Whatever they hard-code | None | Anything. The repo's own `verify` skill and `scripts/test-live-*.mjs` call the API with `curl` and no credential. |
| A thread that calls the API itself (`curl`, `fetch`) | The agent | `DISPATCH_SERVER_URL` and `DISPATCH_PORT` are in its env | Anything it likes | **Every route** |

Facts that matter for the design:

- **The daemon checks almost nothing.** The create route stores `config`
  (role, depth, parent) as sent (`routes/terminals.ts:30,56`). `source` comes from
  the message body (`routes/terminals.ts:137-148`). The watcher comes from the body
  (`routes/watches.ts:20`). The ledger's coordinator check trusts a body `caller`
  (`overseer/ledger-service.ts:162-170`). `answerPermission` allows any pending
  tool, and `requestId` is optional (`sessions/service.ts:1717-1759`). Spawn depth,
  the message rate limit, the self-target check and the archive guard live only in
  `overseer/guards.ts`, inside each MCP process. `assertInProject` covers only three
  thread tools (`agency-mcp.ts:827,883,901,937`).
- **No per-thread secret exists.** The only credentials are the access token and
  cookie (Phase 1) and the hosted box token.
- **Nothing on this computer opens a WebSocket** except the browser.
- **The daemon kills every thread process when it stops** (best effort: a PTY child
  that ignores the signal, or a background job that an agent detached, can survive;
  `pty/manager.ts:110-115`). Every respawn and resume goes through `spawnTerminal` or
  `spawnStructured`, which rewrite every per-thread config file
  (`sessions/service.ts:2231-2568`). This makes keys that live only in daemon memory
  practical: a survivor holds a key that the new daemon does not know.
- **The create route takes far more than identity from the body:** `type` (any tab
  type, also `shell`), `externalId`, `workingDir`, `skipPermissions`, and a free
  `config` that can carry `signIn` (a shell that runs a provider login,
  `sessions/service.ts:2204`), `branchFrom`, `origin`, `runner`, `roleRun`,
  `autonomy` and more (`routes/terminals.ts:30-65`). The first-party worker create
  sends only `type`, `label`, `queued`, `task` and `config.{transport, agentType,
  role, mission, dependsOn, model, spawnDepth, spawnedBy, origin}`
  (`overseer/worker-payload.ts:29-42`).
- **Codex in the CLI view gets MCP env through argv** (`-c mcp_servers.NAME.env.KEY=VALUE`,
  `mcp/injection.ts:30`). Today those values are ids, not secrets. A key must never
  go there.
- **The hosted box** turns the Phase 1 access gate off and uses only the box gate
  (`server.ts:471-486`), which requires the box header on every request, also from
  loopback (`auth/box-token.ts:40-46`). The agency MCP sends no such header. Whether
  threads on a box reach the API today was not tested. Threads also inherit
  `DISPATCH_BOX_TOKEN` through `platform/inherited-env.ts`.
- File, browser and notes tabs start no process.

## 4. Threat model and principles

**In scope**

1. **An agent that drifts.** A normal agent that decides to call the API with `curl`
   because it can see `DISPATCH_SERVER_URL`, or passes the wrong id, or "helps" by
   approving another thread's held command.
2. **An injected agent that uses the documented paths.** An agent that read a
   hostile page or pull request and now follows its instructions with its MCP tools
   or a direct API call: send a message as `source: user`, spawn past the depth
   limit, approve a supervised thread in another project, add an integration or a
   schedule that persists (SEC-20), start a Claude sign-in (SEC-22), write a ledger
   rule as the coordinator (SEC-25).
3. **A stale or orphaned process.** A background job that an agent started and
   that outlives its thread.
4. **Another OS user on the same machine** (network spec R-3). Stage 2 closes this
   as a side effect.

**Out of scope for stages 1 and 2** (section 8): a process running as the owner that
deliberately reads the owner's token file, another thread's key from its process
environment, or the daemon database.

**Principles**

- **The daemon is the only enforcement point.** Client-side guards stay only to give
  early, friendly errors.
- **Default deny.** A route is owner-only unless the policy table (6.4) lists it for
  a key kind. A test fails when a route has no entry.
- **Identity comes from the key.** A body or query field that names the caller is
  filled in from the key when absent, and refused when it disagrees.
- **A thread key is not a secret from its own thread.** The agent can read its own
  key, and that is fine: the key can do only what the thread's tools can do. The
  key must stay away from other threads and out of logs and argv.
- **Keys live only in daemon memory.** No key table on disk; a daemon restart
  revokes every key.

## 5. Approaches considered

| | Approach | For | Against |
|---|---|---|---|
| **A** | **Bearer key per agent process, policy table in the daemon (recommended)** | Same code on every OS and harness. Fits the Phase 1 gate (one more credential type). Small runtime cost: one hash lookup and one row read per request. | The key sits in the thread's env, where same-user processes can read it. |
| B | Process check only, no key: map each loopback connection to a PID and walk up to the thread | No secret to deliver or leak | Different code per OS (`/proc` on Linux and WSL, `lsof` or a native helper on macOS). Codex Pretty threads share one app-server process, so their tools cannot be told apart. A double fork escapes it. Too weak alone; kept as optional stage 3 on top of A. |
| C | A separate Unix socket per thread | The socket path is the identity | Every harness talks HTTP to a URL; MCP clients, hooks and the shim would all need socket support. No equivalent for a native Windows daemon. |

## 6. Design

### 6.1 Principals

Every request resolves to exactly one principal, or to none.

| Principal | Credential | Who holds it |
|---|---|---|
| `owner` | The `dispatch_access` cookie, `Authorization: Bearer` with the access token, or the hosted box header | The owner's browsers, the `dispatch` CLI, owner scripts, the hosted box router |
| `thread` | `Authorization: Bearer dtk_...` | One agent process: a claude-code, codex, grok or opencode thread in either view, including coordinators, workers, role runs and scheduled runs |
| `chat` | `Authorization: Bearer dck_...` | One Chat turn CLI or one Chat summarizer CLI |
| `shell` | `Authorization: Bearer dsk_...` | One shell tab, for the browser shim only |
| none | No valid credential | Stage 1: allowed from a local known host (Phase 1 rule) and logged. Stage 2: refused. |

The prefix tells the daemon (and the CLI, section 6.7) which kind a key is. It also
makes leaked keys easy to find with a secret scanner.

A `thread` principal carries the terminal id and a key handle (6.2). Everything else
is read from the database at request time: project (`session_id`), `config.role`,
`config.spawnedBy`, `config.spawnDepth`, `config.origin`, `config.roleRun`,
`runner`, type, archived. Every scope check uses the **current** project of both the
caller and the target, so a thread or worker that the owner moves loses its old
rights at once.

From stage 1 on, a key can no longer write these fields (6.4: the create body
allowlist; `PATCH /api/terminals/ID` is owner only). **Records made before stage 1**
were written from request bodies, so the daemon checks them before it mints a key:

- `spawnDepth` that is missing on a record with no `spawnedBy` counts as 0, as the
  spawn path does today (`sessions/service.ts:2227`). These are root threads: the
  owner's own threads and the coordinators that the daemon creates without the field
  (`sessions/service.ts:2050-2062`), and they must keep spawning workers after the
  update. From stage 1 on, the daemon writes `spawnDepth: 0` on every root thread it
  creates, so the field is never missing on a new record.
- `spawnDepth` that is missing on a record **with** `spawnedBy`, not an integer, or
  outside 0 to 3 counts as 3 (the thread can no longer spawn). No first-party path
  makes such a record; the owner sees the thread and can archive it.
- `spawnedBy` that names no thread in the same project counts as empty (no parent
  rights).
- `role: coordinator` and `origin: endless` stay as stored. They are visible in the
  app, and only the owner can change them from now on. A record that a thread
  forged before stage 1 keeps its role; residual risk K-11.

**Overseer keys.** A thread key is an **overseer key** when, at request time, its
row has `config.role: coordinator`, is not archived, has no `config.roleRun`, and is
**the** live coordinator of its own current project: the one row that
`findCoordinator(sessionId)` returns (`sessions/service.ts:2019-2023`, the first
unarchived agent-harness coordinator row in the project's sort order). A second
unarchived coordinator row in the same project is not an overseer key. The ledger's
own check (`overseer/ledger-service.ts:162-170`) is wider (any unarchived coordinator
row); it keeps its current behavior for ledger writes, and the overseer reach uses
`findCoordinator` only. The same predicate decides a valid cross-project message
target and the coordinator id that the project list returns.
Every other thread key is a **worker key** (plain threads included). An overseer key
gets the cross-project reach of 6.4.1; a worker key never does. Only the daemon makes
coordinator rows (`ensureCoordinator`), and from stage 1 on no key can set
`config.role` (6.4), so a worker cannot turn itself into an overseer.

**Role runs** (`config.roleRun` set, written only by `roles/service.ts`) get a
narrower thread key: `whoami`, the read routes, `report-status`, `events` and
`auth-requests`. Today their delegation tools are removed only on the client side
(`roles/role-policy.ts:25-39`); a role run that calls the API with its key must not
regain spawn, message, start, archive or answer.

A `chat` principal carries `startedBy`: `user` (the owner typed in Chat), `report`
(a thread report started the turn) or `summarizer`. This design enforces only the
`summarizer` difference (read-only). The `report` value is there for the SEC-07 work,
which can narrow report-started turns without new plumbing.

### 6.2 Keys: format, minting, storage, lifetime

- **Format:** prefix plus 32 random bytes from `crypto.randomBytes`, base64url. For
  example `dtk_` followed by 43 characters.
- **Mint:** at every spawn of a process that gets a key: `spawnTerminal` and
  `spawnStructured` for agent and shell threads, the runner spawn, the Chat turn
  spawn and the summarizer spawn. A respawn, a relaunch, a resume and a restore all
  mint a new key.
- **Storage:** a new module `auth/principals.ts` keeps a `Map` from
  `sha256(key)` to the principal record, in daemon memory only. The daemon never
  writes a key to its log, its database or any file it does not hand to the child
  (6.3).
- **One live key per terminal.** Minting a key for a terminal revokes its previous
  key.
- **Revoke by key handle, never by terminal id.** `mint` returns a handle that the
  spawn path stores with that one process (its PTY, structured child, or Codex
  thread record). The exit handler of that process revokes that handle only. A
  relaunch kills the old process and spawns the new one at once
  (`sessions/service.ts:1918-1932`), and the old PTY's `exit` event arrives later
  (`server.ts:699`); revoking by terminal id would then kill the new key. If the
  spawn itself fails, the spawn path revokes the handle it just minted.
- **Revoke** when the process exits, when the owner stops, archives or deletes the
  thread, when a respawn mints a new key, and for a Codex Pretty thread when the
  manager unsubscribes it. **Not** on a Codex `failed` event: an app-server crash
  emits `failed` for every thread and then resumes them
  (`structured/codex-manager.ts:435-450`). A Chat key is revoked when its turn
  process exits.
- **Daemon restart:** the map starts empty, so every old key is dead. Every thread
  process dies with the daemon today (3), and a thread that comes back is respawned
  with a new key. A process that survived (an agent's `nohup` job) gets `401`.
- **Codex app-server crash:** the manager re-sends each live thread's stored config
  on `thread/resume` (`structured/codex-manager.ts:187-190,441`). The thread is
  still live in Dispatch, so its key is still valid, and the re-sent config carries
  the same key. No special case.
- **No time-based expiry.** A key lives as long as its process. Threads can run for
  days; an expiry would only break them.
- **Lookup cost:** one SHA-256 of the presented key and one map lookup. A wrong or
  revoked key is a plain miss. The map hides nothing secret in its timing: an
  attacker would need to guess a 256-bit value.

### 6.3 Delivery: how each process gets its key

**Rule:** the key travels in a per-spawn environment variable, `DISPATCH_AUTH`, or in
a `0600` file inside the `0700` data directory. Never in argv. Where a harness can
reference an environment variable from its config, the config holds the reference,
not the value.

**Why the name has no KEY, TOKEN or SECRET in it:** Codex filters variables with
those words out of the commands it runs, by default (its `shell_environment_policy`;
to confirm in the Codex check below). The shim must still see the variable. The
`dtk_`, `dck_` and `dsk_` prefixes keep the values easy to find for a secret scanner.

**One daemon URL for every caller:** `DISPATCH_API`, the real bound URL including
the port and the base path. The agency MCP and the memory MCP already read
`DISPATCH_API` first (`overseer/agency-mcp.ts:45-47`, `endless/memory-mcp.ts:16-17`).
Today the agency MCP falls back to `PORT || 3456` (`sessions/service.ts:2861`), which
is wrong when the daemon fell back to another port; a key must never go to whatever
else listens on 3456. Every caller in this design uses `DISPATCH_API`, and refuses to
send a key when it is unset. `DISPATCH_SERVER_URL` stays for the shim and the hooks,
set to the same value.

The per-spawn env already exists for `DISPATCH_TERMINAL_ID` (`sessions/service.ts:2268`
for PTY threads, `:2618-2620` for structured ones), so `DISPATCH_AUTH` rides beside
it. It is never added to the shared default env (`setDefaultEnv`), which every child
gets.

| Path | Thread process env | Agency or memory MCP | Hooks | Browser shim |
|---|---|---|---|---|
| claude-code, CLI view | `DISPATCH_AUTH` in the PTY env | `thread-ID.mcp.json` holds `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`, the same reference style that the Doppler server uses today | The `http` hook gets an `Authorization` header that references `DISPATCH_AUTH`, if Claude Code's HTTP hooks can read a header value from the environment (to verify in the plan). If not, the hook becomes a `command` hook that runs a small Node helper (like `codex-notify.mjs`) which reads the key from its env and the payload from stdin. | Reads `DISPATCH_AUTH` from env |
| claude-code, Pretty | `DISPATCH_AUTH` in the structured spawn env | Same file and reference | None (status comes from the stream) | Same |
| codex, CLI view | `DISPATCH_AUTH` in the PTY env | Non-secret values (`DISPATCH_API` and the ids) stay literal `-c mcp_servers.dispatch.env.NAME=VALUE` flags as today. The key goes through `-c mcp_servers.dispatch.env_vars=["DISPATCH_AUTH"]`, so argv names the variable, never the value. `composeInjection` changes to emit both `env` and `env_vars` for one server (today it emits one or the other, `mcp/injection.ts:25-34`). | `codex-notify.mjs` reads `DISPATCH_AUTH` from its inherited env (Codex check below) | Same |
| codex, Pretty (shared app-server) | The app-server env stays empty of keys. Each thread's `thread/start` and `thread/resume` config sets `shell_environment_policy.set.DISPATCH_AUTH`, beside the existing `DISPATCH_TERMINAL_ID` | `mcp_servers.dispatch.env.DISPATCH_AUTH` as a **literal** in the thread config, which goes over the JSON-RPC pipe, not argv. Never `env_vars` here: the app-server env has no key to pass through (`mcp/injection.ts:33-37` must not choose `env_vars` for this spec). | None | Same (through the shell policy) |
| grok, CLI view | `DISPATCH_AUTH` in the PTY env | The per-thread `plugins/dispatch/.mcp.json` in the thread's Grok home: an env reference if Grok supports one, else the literal value in a `0600` file | `grok-hook.mjs` reads `DISPATCH_AUTH` from env | Same |
| grok, Pretty | Same as above, structured env | Same file, written by the Pretty path | None | Same |
| opencode (Pretty only) | `DISPATCH_AUTH` in the structured env | `opencode.json` `mcp.dispatch.environment`: an env reference if opencode supports one, else the literal in a `0600` file | None | Same |
| Scheduled runs (claude, codex) | `DISPATCH_AUTH` in the runner env | Same as the claude or codex row | None | Same |
| Grok scheduled runs | `DISPATCH_AUTH` for the shim only | None today (no MCP for grok runners) | None | Same |
| Role runs | Same as a claude-code Pretty thread (narrow key, 6.1) | Same | None | Same |
| Chat turn and summarizer | `DISPATCH_AUTH` (a `dck_` key) in the turn's spawn env | `memory.mcp.json` holds the reference `${DISPATCH_AUTH}`; the file stays shared and holds no secret | None | Same |
| Shell tab | `DISPATCH_AUTH` (a `dsk_` key) in the PTY env | None | None | Same |

The browser shim stops using `curl` for its POST. A short Node script reads
`DISPATCH_AUTH` and `DISPATCH_SERVER_URL` from its env and sends the request, so the
key never appears in a process list. The MCP helpers and both hook scripts send
`Authorization: Bearer KEY` on every request.

**The agency MCP asks the daemon who it is.** At start it calls `GET /api/whoami`
with its key and gets its terminal id, project, role and depth. The
`DISPATCH_TERMINAL`, `DISPATCH_SESSION` and `DISPATCH_SPAWN_DEPTH` variables stay
where they are today (they are ids, not secrets) for display and for a clear error
when `whoami` fails; the daemon ignores them.

**Codex check (a prerequisite of the build, not a test after it).** Codex is the one
harness where Dispatch hands a literal key to another program's own config. Before
any delivery code is written, a scripted check on the pinned Codex version runs two
Pretty threads at once on one app-server and one CLI thread, with a canary key each.
It makes MCP calls from each, runs a shell command that reads `DISPATCH_AUTH`, fires
`notify` in the CLI view, resumes a thread, and kills the app-server once. Then it
scans the temporary `CODEX_HOME` (rollouts, logs, history) and the captured output for
the canary values. Outcomes:

- The key is not written anywhere: deliver as in the table.
- The key appears in a rollout or log file: Codex threads get a key file instead. The
  thread config carries `DISPATCH_AUTH_FILE`, the path of a `0600` file in the
  data directory (the path is not secret), and the agency MCP and the shim read the
  key from that file. The file is deleted at revoke.
- `notify` does not inherit the env: the notify program's argv carries the key file
  path (not secret), and the helper reads the key from that file.
- The default shell policy drops `DISPATCH_AUTH` despite `set`: the shim in Codex
  threads uses the key file. A user's own `include_only` filter can still drop it;
  then the sign-in banner from a Codex shell does not appear, and the release note
  says so.

**Files that hold a literal key** (Grok and opencode if they have no env reference,
and the Codex fallback) are written with mode `0600` and deleted when the thread
process exits, not only on archive. A key left in an old file is already revoked, so
the delete is for hygiene. PR 103 adds a sweep for stale `thread-*.mcp.json` files;
the same sweep covers the Grok and opencode homes and the key files.

**Keys in thread text.** A thread's own text can show its own key (an agent that ran
`env`). Other threads, Chat and the coordinator read that text through several paths,
so one redaction function replaces any `dtk_`, `dck_` or `dsk_` value in each of
them: the conversation routes, the completion and question notices that embed a
worker's last text in the coordinator's turn (`sessions/service.ts:1232-1252,1466-1473`),
the thread report text that goes to Chat and its memory, and the Chat memory reads
(`/api/endless/zoom` and the others).

**The thread env loses the owner's credentials.** `platform/inherited-env.ts` drops
`DISPATCH_BOX_TOKEN`, `OS_BOX_TOKEN` and any `DISPATCH_AUTH` of the daemon's own env
from what children inherit. (The access token is never in the daemon's env; it lives
in a file.) The wider env allowlist in SEC-04 stays separate work.

### 6.4 Scope: what each key may call

**Default:** owner only. The tables below are the whole allowlist. They list exactly
the method and route template of every request that a first-party caller makes
today (section 3). Adding a route for a key kind later is an explicit, reviewed
change to `auth/route-policy.ts`.

**How the policy attaches.** Express matches routes without regard to case and with
its own parameter rules, so a separate path matcher could drift from the real
routes. Each route declares its policy where it is registered (a small wrapper
around `router.METHOD`), and a test walks the Express router and fails when a route
has none. Peer addresses are normalized (`::ffff:127.0.0.1` becomes `127.0.0.1`)
before any address rule.

**All WebSocket upgrades are owner only.** No key kind may open a terminal socket,
the structured stream or the events socket.

**Precedence.** A request that carries a key is judged as that key, whatever other
credential it also carries (a cookie, the access token, a box header). The narrower
right always wins.

**The create body allowlist** (for every key kind that may spawn). The daemon accepts
only these fields and refuses the request (`403 field_not_allowed`, naming the field)
when any other field is present:

- `type`: an agent harness (`claude-code`, `codex`, `grok`, `opencode`). Never
  `shell`, never a file, browser or notes tab.
- `label`, `queued`, `task`.
- `config.transport` (only `structured`), `config.agentType`, `config.mission`,
  `config.model`, `config.dependsOn` (every id must be a thread in the same project).

The daemon writes `config.role` (`agent`), `config.spawnDepth`, `config.spawnedBy`
and `config.origin` itself. A body value for one of these four is accepted only when
it equals what the daemon would write (so today's MCP keeps working while it still
sends them), else `403 identity_mismatch`. Everything else is refused, in
particular `externalId`, `workingDir`, `skipPermissions`, `config.signIn`,
`config.branchFrom`, `config.runner`, `config.runnerPrompt`, `config.roleRun`,
`config.roleAuthority` and `config.autonomy`. The same allowlist applies to queued
workers and to Chat spawns.

**Thread key (`dtk_`)**

| Method and route | Rule in the daemon |
|---|---|
| `GET /api/whoami` | Returns the caller's own id, project, role, depth, parent, and whether it is an overseer key. |
| `GET /api/sessions` (project list) | Overseer key only (6.4.1); a worker key gets `403 out_of_scope`. For a key the daemon returns only `id`, `name` and the live coordinator's thread id of each project. |
| `GET /api/sessions/SID/terminals` | Worker key: `SID` is the caller's project. Overseer key: any project (6.4.1). |
| `GET /api/terminals/ID`, `GET /api/terminals/ID/conversation` | Worker key: target is in the caller's project. Overseer key: any project (6.4.1). Keys are redacted from the transcript (6.3). |
| `GET /api/terminals/ID/permission` | Worker key: target is in the caller's project. Overseer key: any project (6.4.1); this is a read and answers nothing. |
| `GET /api/sessions/SID/overseer/worker-defaults` | `SID` is the caller's project, for every thread key, overseers included (it only feeds a spawn). The Chat row below keeps any project. |
| `POST /api/sessions/SID/terminals` (spawn and queue) | `SID` is the caller's project (overseer keys too). The create body allowlist above. `spawnDepth` = caller depth + 1, refused past `MAX_SPAWN_DEPTH` (3). |
| `POST /api/terminals/ID/message` | Target is not the caller and is not a shell tab. Target is in the caller's project, or (overseer key only, 6.4.1) the target is the live overseer of another project. The daemon sets `source` to `coordinator` when the caller is the project's coordinator, else `agent`. A body `source: user` is refused. The per-pair hourly limit from `guards.ts` (10 per sender and target pair per hour) runs here, keyed by caller and target, for same-project and cross-project messages alike. A cross-project message gets the sender line of 6.4.1. |
| `POST /api/terminals/ID/start` | Target is not the caller, and was spawned by the caller or the caller is the coordinator of the target's current project. |
| `DELETE /api/terminals/ID` (archive) | Same rule, plus the `checkArchiveAllowed` rules, moved into the daemon. |
| `POST /api/terminals/ID/permission` (answer) | Same rule. The body may hold only `decision: allow`, `answers` and `requestId`; `reply`, `canned`, `message` and `deny` are refused. The pending request must have `questions` (a question, not a held tool call), and `requestId` must match it. The daemon logs the answer with source `coordinator`, never `user`, so no key can write a quotable "user" line (`sessions/service.ts:1735,1780,1795-1801`). |
| `POST /api/terminals/ID/report-status` | `ID` is the caller. |
| `POST /api/watches` | The watcher is the caller (filled in or checked). The target is in the caller's project, for overseer keys too (PK-4 does not include watches). A shell tab cannot be a watcher (PR 103). |
| `GET /api/watches` | Returns only the caller's watches. |
| `DELETE /api/watches/ID` | The watch belongs to the caller. |
| `POST /api/sessions/SID/ledger` and `POST /api/sessions/SID/ledger/{list,note,import,handoff,show,decide-self}` and `POST /api/sessions/SID/ledger/ITEM/{resolve,add-from-agent,decide-self,mark-default,title}` | `SID` is the caller's project, for overseer keys too (an overseer cannot write another project's ledger). `caller` comes from the key; the existing "live coordinator in this project" check (`overseer/ledger-service.ts:162-170`) then runs on the real caller. |
| `POST /api/events/PROVIDER/ID` | `ID` is the caller and `PROVIDER` matches its type. |
| `POST /api/auth-requests` | `terminalId` is set from the key. |

A **role run** key gets only `whoami`, the `GET` rows, `report-status`, `events` and
`auth-requests` (6.1). A role run is never an overseer key, so its `GET` rows stay
inside its own project.

#### 6.4.1 Cross-project reach for overseers (owner decision PK-4)

**This loosens today's rule on purpose.** Today every agent can list, read, message,
start, archive and answer threads only in its own project (the check lives in the
agency MCP, `overseer/agency-mcp.ts:818-834,880,892`). The owner needs overseers of
different projects to see and talk to each other, so on 2026-10-23 the owner chose option C
(section 13). The daemon enforces it as follows.

| Action | Overseer key | Worker key | Chat key (unchanged) |
|---|---|---|---|
| List projects (`GET /api/sessions`) | Any project | Refused | Not on its allowlist (Chat has its own reads) |
| List threads (`list_threads`), read a thread (`read_thread`, `read_agent`), read a pending question | Any project | Own project only | Any project |
| Message a thread (`message_thread`) | Own project: any thread. Another project: **only that project's live overseer** | Own project only | `origin: endless` targets |
| Start, archive or answer a thread | Own project only (its workers, or as the coordinator) | Own workers only | `origin: endless` targets (archive) |
| Spawn or queue a worker | Own project only | Own project only | Any project |
| Ledger writes | Own project only | Refused by the coordinator check | Chat ledger only |
| Watches | Own project only | Own project only | None |

Rules:

- **Message target.** A cross-project message is allowed only when the target row
  is its project's overseer by the 6.1 test (the row that `findCoordinator` returns
  for its current project). Any other target in another project (a worker, a plain thread,
  a role run, a shell tab) gets `403 out_of_scope`. `message_agent` is for the
  caller's own workers and stays inside the project.
- **Rate limit.** The daemon's one pair limiter (10 messages per sender and target
  pair per rolling hour, `overseer/guards.ts`) counts cross-project messages the same
  way. The 11th message from overseer A to overseer B in one hour gets
  `429 rate_limited`. A reply from B to A is its own pair. No spawn credit applies
  across projects.
- **The receiver sees where a message came from.** For every cross-project message
  the daemon itself puts one line before the text: `[From the overseer of project
  "NAME" (thread ID). This is not a message from the owner.]`, with the sender's
  current project name and terminal id taken from the key, never from the body. For
  a block message the line is the first text block. It reaches the receiving
  overseer in both views and every harness, it is stored with the message, and the
  owner sees it in the receiving thread. The message keeps `source: coordinator`
  (never `user`).
- **No forged sender line.** A message from any key (same project or not, Chat
  included) whose text holds the marker `[From the overseer of project` anywhere gets
  `403 identity_mismatch`. The daemon checks the text **as it will be delivered**:
  every text block and the flattened PTY text, after the same control-character
  removal that `ptyMessagePayload` does (`sessions/pty-message.ts:49-54`), and also
  with Unicode format characters (for example zero-width spaces) removed, case
  ignored and runs of white space folded to one space. So a marker split by a NUL, a
  zero-width space or a line break is still refused. One shared helper serves the
  thread key rule and the Chat key rule. So a worker cannot make a same-project message look like
  it came from another project's overseer. Owner messages are not checked.
- **Discovery.** An overseer finds other projects with a new agency MCP tool
  `list_projects` (backed by `GET /api/sessions`, trimmed for keys), and lists a
  project's threads with `list_threads` and an optional `projectId`.
- **Scope uses current facts.** Whether a caller or a target is an overseer is read
  from the database at request time (6.1). An overseer that the owner archives, or
  that stops being its project's live coordinator, loses the reach at once.

Not included in PK-4: cross-project watches, cross-project `message_agent`, and any
cross-project write. Each would be a separate, reviewed change to the policy table.

**Chat key (`dck_`)**

| Method and route | Rule |
|---|---|
| `GET /api/whoami` | Returns the principal kind and `startedBy`. |
| `GET /api/endless/zoom`, `/date`, `/threads`, `/project` | Allowed (Chat reads across projects by design). |
| `GET /api/terminals/ID`, `GET /api/terminals/ID/conversation` | Any project (by design). Keys redacted. |
| `GET /api/sessions/SID/overseer/worker-defaults` | Any project. |
| `POST /api/sessions/SID/terminals` | Any project. The create body allowlist; the daemon writes `origin: endless`, `spawnDepth: 1`, `role: agent`, `spawnedBy` empty. |
| `POST /api/endless/arm`, `/disarm` | Target has `origin: endless`. |
| `POST /api/terminals/ID/message` | Target has `origin: endless`. Source `coordinator`, as `sendTask` sends today; never `user`. |
| `DELETE /api/terminals/ID` | Target has `origin: endless`. |
| `POST /api/endless/ledger/ACTION` | Allowed, with today's service rules. |
| `POST /api/auth-requests` | Allowed. |

A `summarizer` chat key gets only the `GET` routes.

**Shell key (`dsk_`)**: `POST /api/auth-requests` only, with `terminalId` from the key.

**Everything else is owner only**, for example: secrets, integrations, roles
enable and disable, schedules and runs, Claude sign-in, auth-request
complete and callback, update, settings, servers, push, access, setup and install,
Chat instructions and send, terminal input, autonomy, relaunch, restore, stop,
stop-all, interrupt, compact, `PATCH /api/terminals/ID` (which can set any role),
move, every files route, state, transcribe, ledger `card` and `source` reads, and
creating or changing a project.

**Errors** (JSON, so the MCP tools can show a plain message):

| Status | `error` | When |
|---|---|---|
| `401` | `auth_required` | No valid credential (stage 2), or a revoked or unknown key (any stage) |
| `403` | `owner_only` | A key called a route outside its allowlist |
| `403` | `field_not_allowed` | A create or answer body has a field outside its allowlist |
| `403` | `identity_mismatch` | A body or query field names another caller, or a role, depth, parent or origin the daemon would not write |
| `403` | `out_of_scope` | Target outside the caller's reach (another project for a worker key; another project's non-overseer thread, or any write, for an overseer key), the caller itself, or not the caller's worker |
| `403` | `depth_exceeded` | Spawn past the limit |
| `403` | `not_a_question` | `answer_agent` on a held tool call |
| `429` | `rate_limited` | Per-pair message limit |

An `owner_only` answer from an MCP tool tells the agent, in one sentence, to ask the
owner to do it in the browser.

**The owner is not restricted** by this table. The browser keeps sending
`source: user` with its cookie. Owner-only actions that SEC-20 worries about could
later become a decision card that a thread proposes and the owner accepts; that is
a follow-up, not part of this design.

**Behaviour change for agents:** today any thread can start, archive or answer any
thread through its tools (only three tools check the project). After stage 1 a thread
can do that only for its own workers, or as the coordinator of the project. No
first-party flow uses the wider right; section 7.2 lists it. In the other direction,
overseers gain reach they do not have today: reads in every project and messages to
other projects' overseers (6.4.1).

### 6.5 Lifecycle walk-through

| Event | Key effect |
|---|---|
| New thread (any harness, either view) | Mint, put in the spawn env and config, then start the process. If the spawn fails, revoke that handle. |
| Spawned worker | The parent's key authorizes the create; the worker gets its own key at its own spawn. |
| Queued agent | No key until `start` spawns it. |
| Process exits (task done, crash, `/exit`) | Revoke that process's handle only. |
| Owner stops, archives or deletes | Revoke, then kill. |
| Respawn, relaunch, restore, switch view (transport) | Mint a new key (which revokes the old one). The old process's late `exit` revokes only its own, already dead, handle. |
| PTY thread revived by a browser socket after a restart | New spawn, new key. |
| Structured thread revived by `ensureStructuredAlive` | New spawn, new key. |
| Coordinator kickstart at daemon start | New spawn, new key. |
| Codex Pretty thread released (`thread/unsubscribe`) | Revoke. Its MCP set may live up to `thread_unload_delay_secs` longer and gets `401`. |
| Codex app-server crash (`failed` for each thread) and `thread/resume` | Same key (still live). `failed` never revokes. |
| Daemon stop or crash | All keys gone with the process memory. |
| Chat turn | Mint at spawn, revoke at exit. |
| Scheduled run | Mint at spawn, revoke at exit or cancel. |

### 6.6 Stage 2: the gate stops trusting loopback

Today the Phase 1 gate (`auth/access-gate.ts:116`) lets a loopback or WSL gateway
peer in with no credential when the `Host` is known. Stage 2 removes that rule. This
is the "require a credential on this computer too" mode from network spec 8.7,
made the default. The network spec kept it optional because its only reason then
was shared machines. The reason now is agents.

**After stage 2, a request passes the trust step only when one of these is true:**

1. It carries an owner credential (cookie, access token, box header).
2. It carries a live key, and the route is in that key's allowlist.
3. It comes from one of the owner's own Tailscale devices (Phase 1 rule 3), and the
   peer address is **not** one of this machine's own Tailscale addresses. A program
   on this computer can connect to the machine's own tailnet address, and
   `tailscale whois` names the owner for it, so without this exclusion rule 3 would
   become a local bypass.

The Origin and `Sec-Fetch-Site` checks run after, as today.

**Still open with no credential:** the sign-in page (any non-API `GET`) and
`POST /api/access/login` (rate limited, Origin-checked).

**What stage 2 removes:**

- The loopback plus known-host rule.
- The WSL gateway rule. Any Windows program can reach a WSL daemon through
  `localhostForwarding` and arrives from the gateway address, and a thread inside
  WSL can start a Windows program through WSL interop (for example `curl.exe`).
  The Windows browser signs in once instead.
- `allow-host` names no longer admit a request without a credential. They still
  count as known for the Host and Origin checks, so a browser behind such a proxy
  signs in once.
- The `tailscale serve` identity-header rule, with owner question PK-2 option A. Any
  program on this computer can send the two headers that rule checks
  (`auth/access-gate.ts:66-76`), so keeping it keeps a credential-free door open for
  every local program.

Stage 2 therefore also closes network spec residuals R-1, R-2 and R-3, and with
PK-2 option A it replaces R-6, which the owner accepted as a known limit on
2026-10-23. This is a deliberate later change, not a defect in Phase 1: Phase 1
trusted loopback on purpose (network spec 4.2), and this design is the follow-up
that withdraws that trust.

**No cookie is handed out in stage 1.** An earlier draft set the owner cookie on
every local page load during stage 1, so that stage 2 would need no sign-in. Review
showed that the local rule also admits callers that must not get a lasting owner
credential: a LAN device through a WSL portproxy (R-2), an `allow-host` proxy (R-1),
a forwarder with no relay header (R-6), forged `tailscale serve` headers, and an
agent's `curl -v` (which would put the cookie in a transcript that peers can read).
The cookie derives from the token and lives 400 days, so it would outlive stage 2.
Each browser therefore signs in once at stage 2.

**A browser with no cookie** sees the sign-in page. Two ways in:

- `dispatch open` (new) on the computer that runs Dispatch. It asks the daemon, with
  the owner token (in-process `fetch`, never argv), for a one-time code (128 bits,
  single use, valid 60 seconds, stored only as a hash in memory) and opens
  `DISPATCH_API/#code=CODE` in the default browser. The sign-in page posts the code
  to `POST /api/access/login`, which sets the cookie, and clears the fragment with
  `history.replaceState`. The code shows in the opener's argv; it is single use and
  expires in a minute, so this is the one accepted argv exception (goal 5). The
  token itself never appears. On WSL the CLI uses the Windows opener
  (`wslview`, else `cmd.exe /c start`); when no opener works it prints the URL.
- Paste the token from `dispatch access`, or open a `dispatch access --link HOST`
  link, as in Phase 1. This is the path for a phone, and for an installed web app
  (an iOS home-screen app or a Safari "Add to Dock" app), which keeps its own
  cookies and is not the browser that `dispatch open` starts.

The sign-in page names both. `dispatch install` ends with `dispatch open`.

### 6.7 The CLI and the owner's scripts

- **The CLI sends the owner token** (read from `~/.dispatch/access-token`, as
  `dispatch access` already does) on its HTTP calls (`roles`, `api`, `open`, the
  stage 1 count in `status`), always from an in-process `fetch`. The reachability
  probe sends **no** credential: it runs `node -e` with the URL in its argv
  (`packages/cli/src/index.ts:119-121`) and already counts any answer, `401`
  included, as reachable.
- **New `dispatch api METHOD PATH`**, with an optional body from a file or stdin. It
  adds the owner token and prints the JSON answer. This is the low-friction path for
  the owner's own scripts: no token on the command line, no header to build.
- **Inside a thread the CLI does not act as the owner.** One credential resolver
  (a small shared module) serves the CLI, the agency MCP, the memory MCP, the shim
  and both hook helpers, so they cannot disagree:
  1. `DISPATCH_AUTH` starts with `dsk_`: a shell tab, the owner at a keyboard. The
     CLI uses the owner token as normal; the shim uses the shell key.
  2. `DISPATCH_AUTH` starts with `dtk_` or `dck_`, or `DISPATCH_AUTH_FILE` is set:
     thread mode. Use the key from the variable or the file.
  3. No usable key, but a thread marker is present (`DISPATCH_TERMINAL_ID`,
     `DISPATCH_TERMINAL` or `DISPATCH_AUTH_FILE`): thread mode with no credential.
     The call **fails closed** with "This thread has no Dispatch key"; the resolver
     never falls back to the owner token. This covers a Codex shell whose filter
     dropped the variable, and a key file that cannot be read.
  4. No marker at all: owner mode (the owner's own terminal).

  In thread mode `dispatch access` (print, `--link`, `rotate`) and `dispatch open`
  refuse with "Run this in your own terminal, not in a Dispatch thread." This is a
  guard against drift only: a thread can still read the token file on purpose
  (section 8).
- **Scripts in other languages** read the token file themselves and send
  `Authorization: Bearer`. `docs/network-access.md` shows `curl -H @FILE`, where
  FILE holds the header line, so the token stays out of argv.
- **Repo scripts and skills** that call a daemon (`.claude/skills/verify/SKILL.md`,
  `scripts/test-live-*.mjs`, `scripts/test-wsl-docker.sh`) change to `dispatch api`
  or a header file in the same release as stage 2.

### 6.8 Platforms

- **macOS and Linux:** as above. Nothing OS-specific in stages 1 and 2.
- **WSL2:** the daemon, every thread and every helper run inside WSL, so keys,
  env and files use Linux paths and the `0700` data directory. A data directory on a
  Windows mount (`/mnt/c`) cannot hold Unix modes (network spec 7.14); the literal
  key files (Grok, opencode) then rely on revocation only, and the release note
  says so. Stage 2 drops the gateway rule (6.6), which also closes the interop path.
  The Windows browser signs in once (`dispatch open` inside WSL starts the Windows
  opener). Mirrored mode is the same as a local browser.
- **Hosted box:** one authorization step serves both deployments. On a box the box
  gate (`auth/box-token.ts`) stays first and admits a request that carries a valid
  box header, a valid owner access token (`Authorization: Bearer`, for the CLI on the
  box), or a live key; it refuses everything else, as today. The same
  principal resolution and route policy as on a local daemon then run on every
  admitted request, so a key on a box is exactly as narrow as on a laptop, and a key
  wins over a box header that a proxy may also add (precedence, 6.4). Upgrades on a
  box accept only the box header. The owner's credentials on a box are the box header
  (the router) and the access token. Today the daemon creates the token file only
  when no box token is set (`server.ts:475-482`); this design creates it in both
  modes, so the CLI on the box works the same way. The browser cookie stays a
  local-mode credential (a box browser comes through the router with the box
  header). Threads no longer inherit the box token
  (6.3). Stage 2 changes nothing on a box: the box gate never trusted loopback.
- **Native Windows (port in progress on its own branch):** the design is OS-neutral.
  Two items for that port: the browser shim needs a Windows form that reads
  `%DISPATCH_AUTH%` and posts with Node, not `curl` argv; and a stage 3 process check
  would use `GetExtendedTcpTable`, which gives the owning PID directly.

### 6.9 Logs and attribution

- Every refusal logs one line: principal kind, terminal id, method, route, error.
  Never the key.
- **Stage 1 only:** every request that passed with no credential logs one line with
  method, path, `User-Agent` and a category: `browser` (it sends `Sec-Fetch-Mode`)
  or `program` (it does not). The daemon keeps counts per category and top paths in
  memory since its start, and an owner-only route returns them; `dispatch status`
  prints them. The log lines keep the history across restarts. The `program` count is
  the go signal for stage 2: it should hold only the owner's own scripts, which then
  move to `dispatch api`. The `browser` count only shows which browsers will see the
  sign-in page once.
- Messages, spawns and ledger writes from a key record the real caller (they
  already have fields for it; the daemon now fills them).

### 6.10 Stage 3 (optional): which process is calling

On loopback the daemon can find the PID that owns the client end of a TCP
connection and walk its parent chain up to a thread's root process (the PID recorded
at spawn).

- **Rules:** an owner credential presented from inside a thread's process tree is
  treated as that thread's key, and logged. A thread key presented from outside its
  own thread's tree is refused.
- **Lookup:** Linux and WSL read `/proc/net/tcp` and `/proc/net/tcp6`, then the
  `fd` links in `/proc/PID`. macOS needs `lsof` (tens to hundreds of milliseconds) or
  a small native helper. Run it once per new connection, only for owner credentials
  and keys on loopback, and cache the answer for the life of the socket.
- **Limits:** a double fork or `launchctl submit` leaves the tree. All Codex Pretty
  threads share one app-server process, so their tools cannot be told apart by tree.
  It is a speed bump against deliberate theft, not a boundary.

Recommended: decide after stage 2 has run for a while (owner question PK-3).

## 7. Rollout and migration

### 7.1 Stages and releases

| Stage | Release | What changes for the owner |
|---|---|---|
| 1 | Next minor (for example v3.5.0) | Nothing visible. Threads get keys. Agents that call owner-only routes, or forge identity, with their key get `403`. Calls with no credential still work and are counted. |
| 2 | A later minor (owner question PK-1) | Programs on this computer need a credential. The CLI and threads already have one. Each browser signs in once. |
| 3 | Only if the owner chooses | Process check. |

**Go condition for stage 1:** the restart mid-work test (section 9, end to end)
passes for every harness and view, for a coordinator with a worker, and for Chat.

**Go conditions for stage 2** (with PK-1 option A), all of them, not a date:

1. The Codex check (6.3) passed, and every harness row of the end-to-end tests
   (section 9) passed on the stage 1 release.
2. The stage 1 `program` count on the owner's machine holds nothing but scripts that
   have moved to `dispatch api`.
3. At least one week of stage 1 on the owner's machine.

Stage 1 alone already closes the forged-body paths for every agent that uses its MCP
tools, and every owner-only route for every caller that sends a key. The direct
`curl` with no key stays open until stage 2, so the gap should be short.

**An install that skips stage 1** (updates straight from v3.4.x to the stage 2
release) gets both at once. Nothing differs for it: browsers sign in once in either
case, because stage 1 hands out no cookie.

**Rollback.** Installing the stage 1 release again brings back loopback trust. That is
a version rollback that the owner chooses, not a switch, and the release note says
so. Thread keys work in both releases.

### 7.2 What breaks

| Who | Stage 1 | Stage 2 | Fix |
|---|---|---|---|
| The owner's browser on this computer | Nothing | The sign-in page once per browser profile | `dispatch open` |
| Windows browser for a WSL2 daemon | Nothing | The sign-in page once | `dispatch open` inside WSL, or paste the token |
| Phone through `tailscale serve` | Nothing | With PK-2 option A: sign in once | `dispatch access --link HOST` |
| An installed web app (iOS home screen, Safari "Add to Dock") | Nothing | Sign in once inside the app (it keeps its own cookies) | Paste the token or open the `--link` link in the app |
| Phone or laptop on the owner's tailnet (direct) | Nothing | Nothing | None |
| Other devices (LAN, other tailnet users) | Nothing (they already sign in) | Nothing | None |
| A browser whose cookie expires (400 days) or after `dispatch access rotate` | Sign-in page, as today | Same | `dispatch open` |
| `dispatch` CLI | Sends the token | Nothing more | None |
| The owner's own scripts that call the API with no credential | Nothing; counted | `401` | `dispatch api`, or send the token from a header file |
| An agent that calls the API with `curl` and no key | Nothing; counted | `401` | Use the MCP tools |
| An agent that calls an owner-only route or forges identity | `403` | `403` | Ask the owner |
| An agent that starts, archives or answers a thread that is not its own worker (and it is not the coordinator) | `403 out_of_scope` | Same | The coordinator or the owner does it |
| An agent that answers a held tool call, or its own question | `403` | Same | The owner answers in the browser |
| An overseer that reads another project, or messages another project's overseer | Newly allowed (6.4.1); today the agency MCP refuses it | Same | None |
| An overseer that messages a worker or plain thread in another project, or starts, archives, answers, spawns or writes the ledger there | `403 out_of_scope` | Same | Message that project's overseer instead |
| A worker that reads or messages a thread in another project | `403 out_of_scope` (today the agency MCP refuses most of these, but `read_agent` has no project check) | Same | Its overseer does it |
| `pnpm dev` (Vite) | Nothing | One sign-in on `localhost`; the cookie also reaches the dev server, because cookies ignore the port | None |
| Hosted box | Threads reach their own routes through the box gate with their key | Same | None |
| A proxy added with `allow-host` | Nothing | Sign in once per browser | None |
| A third-party program that called the API with no credential | Nothing; counted | `401` | Give it the token through a file |

### 7.3 Not locking the owner out

- The CLI reads the token file directly, so `dispatch access`, `dispatch open` and
  `dispatch api` work whatever state the browsers are in.
- The sign-in page always tells the reader how to get in.
- No stage touches the access token or the cookie format. `dispatch access rotate`
  still signs out every browser and does not touch thread keys.
- If the daemon will not start, nothing in this design is involved: it adds no file
  that must exist at start.
- On WSL, if the Windows opener fails, `dispatch open` prints the URL to paste.

### 7.4 Why no off switch

A switch that brings back loopback trust would be turned on once to fix a script
and then forgotten, and it would bring back every path this design closes, for every
thread. The owner keeps full access through the CLI and the cookie, `dispatch api`
covers scripts, and the stage 1 count shows what would break before stage 2 ships.
This matches NE-4 in the network spec.

## 8. Residual risks

- **K-1. Deliberate theft by a same-user process.** A thread can read
  `~/.dispatch/access-token` (and the cookie derives from it), read a peer thread's
  `DISPATCH_AUTH` from its process environment (`/proc/PID/environ` on Linux and WSL,
  `ps eww` on macOS), or read a literal key file. Stage 3 makes this harder. Only an
  OS sandbox or a separate OS user per thread would close it.
- **K-2. A cookie made from a stolen token** keeps working until the owner rotates
  the token. It is the same class as K-1. `dispatch access rotate` revokes every
  cookie.
- **K-3. A key leaks through the thread's own children** (a test that prints its env,
  a log). Transcripts are redacted (6.3), and the Codex check decides how Codex gets
  its key (6.3). The key is scoped to that thread and dies with it.
- **K-4. A thread's legitimate powers.** An injected thread can still message peers
  in its project, spawn workers up to the depth limit, archive its own workers and
  write status. SEC-07 and SEC-25 cover what other threads do with that text.
- **K-5. Hook status forgery.** A thread can post fake lifecycle events, but only for
  itself.
- **K-6. Long-lived keys.** A thread that runs for days keeps one key for days.
- **K-7. Same-machine proxy that adds its own credential.** A proxy that the owner
  configures with the token, or a browser behind `allow-host` with a cookie, is the
  owner. That is the owner's configuration.
- **K-8. The Chat principal is broad by design.** It reads every project and spawns
  in any project. SEC-07 narrows report-started turns.
- **K-9. Data directory on a Windows mount** (WSL): literal key files there are not
  private on disk. Revocation still applies.
- **K-10. File writes that persist.** A thread can still edit files in
  `~/.dispatch`, for example the `role.md` of a role that the owner already enabled,
  which then runs on its schedule. That is a file write, not an API call, so keys do
  not stop it. SEC-20 is therefore narrowed (no new integration, schedule or role
  enable from a thread), not closed.
- **K-11. Records forged before stage 1.** A thread that set `role: coordinator` or
  `origin: endless` on a record before stage 1 keeps it (6.1). The owner sees the
  role in the app and can archive the thread.
- **K-12. A Codex user's own shell filter** can drop `DISPATCH_AUTH` and
  `DISPATCH_AUTH_FILE` from Codex shell commands. Then a sign-in banner from a Codex
  shell does not appear, and the CLI in that shell refuses to run calls that need a
  credential (6.7: it fails closed, it never falls back to the owner token).
- **K-13. An overseer's cross-project reach (PK-4, accepted).** An injected overseer
  can read the transcripts of every project, and can send up to 10 messages an hour
  to each other project's overseer. Text from one project can therefore reach another
  project's overseer, and from there its workers. The sender line (6.4.1) tells the
  receiver that the message came from another project and is not from the owner, and
  the receiver still decides what to do with it. No overseer can write in another
  project. A record forged as `role: coordinator` before stage 1 (K-11) would also
  get this reach, which makes K-11 a little wider.

## 9. Tests

**Unit**

- `principals.test.ts`: mint, resolve, revoke; one live key per terminal; unknown,
  revoked, malformed and wrong-prefix keys; the map holds hashes only.
- `route-policy.test.ts`: a completeness test that walks every route Express
  registers and fails when one has no policy entry; one case per allowlist row for
  allowed and refused; every WebSocket path refuses every key kind.
- Identity: body `caller`, `watcherTerminalId`, `terminalId`, `source`,
  `config.role`, `config.spawnDepth`, `config.spawnedBy`, `config.origin` filled in
  when absent, refused when different.
- Create body allowlist: one refusal case per field: `type: shell` (and every tab
  type), `config.signIn`, `externalId`, `workingDir`, `skipPermissions`,
  `config.branchFrom`, `config.runner`, `config.runnerPrompt`, `config.roleRun`,
  `config.roleAuthority`, `config.autonomy`, `config.dependsOn` outside the project;
  the same for queued workers and Chat spawns. Plus the full chain: a thread cannot
  get a shell tab and so cannot reach owner mode in the CLI.
- Guards in the daemon: depth 3 refused at 4; pair rate limit; self-target; shell
  target; archive rules; start, archive and answer refused on the caller itself;
  `answer_agent` refused for a held tool, a missing or stale `requestId`, a `reply`,
  `canned` or `deny` body, a thread in another project, a thread that is not the
  caller's worker; an answer from a key is logged as `coordinator`.
- Role runs: a role-run key is refused on spawn, message, start, archive and answer.
- Cross-project reach (PK-4, 6.4.1):
  - an overseer key lists projects, lists another project's threads, and reads
    another project's thread (`read_thread`, `read_agent`, the pending question):
    allowed;
  - an overseer key messages another project's live overseer: allowed, the
    delivered text starts with the sender line that names the sender's project and
    terminal id, and the source is `coordinator`; the 11th message to the same
    overseer in one hour gets `429 rate_limited`;
  - an overseer key messages a worker, a plain thread or an archived coordinator in
    another project: `403 out_of_scope`;
  - an overseer key starts, archives, answers, spawns, queues or writes a ledger item
    in another project: `403 out_of_scope`;
  - a worker key lists projects, reads, or messages a thread in another project
    (its overseer included): `403 out_of_scope`;
  - any key message whose text holds the sender-line marker: `403 identity_mismatch`;
  - an overseer that the owner archived, or a coordinator row that is not its
    project's live coordinator, gets worker scope;
  - a Chat key still reads, spawns and archives `origin: endless` threads in any
    project.
- Moves: after the owner moves a worker to another project, its old parent loses
  start, archive and answer on it.
- Legacy records: a stored `spawnDepth` of 7 or `"x"` counts as 3; a `spawnedBy` in
  another project counts as empty; a coordinator record made by today's code (no
  `spawnDepth`, no `spawnedBy`) counts as 0 and can spawn a worker; a worker record
  with `spawnedBy` and no `spawnDepth` counts as 3; new root threads get
  `spawnDepth: 0` written.
- Revocation by handle: a relaunch whose old PTY exits after the new spawn keeps the
  new key valid; a Codex `failed` event revokes nothing; a failed spawn revokes its
  handle.
- Redaction: a `dtk_` value in a worker's text is redacted in the conversation
  route, in the completion notice to the coordinator, in a thread report to Chat, and
  in the Chat memory reads.
- Hosted box mode: owner box header, owner access token (the CLI), thread key,
  revoked key and no credential, each on an owner-only route and an allowed route; a
  key plus a box header is judged as the key; the token file exists in box mode.
- `source: user` refused for every key kind, accepted from the owner cookie.
- Gate: stage 1 still admits a credential-free local request and logs it; stage 2
  refuses it with `401` (API) and the sign-in page (navigation); a request from this
  machine's own tailnet address (also as `::ffff:` form) is refused under rule 3; the
  WSL gateway peer needs a credential; forged `tailscale serve` headers from loopback
  get the sign-in page (PK-2 option A); stage 1 sets no cookie on a local navigation.
- Stage 1 count: a request with `Sec-Fetch-Mode` counts as `browser`, one without as
  `program`; the counts route is owner only.
- One-time code: single use, 60-second expiry, refused after use, only an owner
  credential can mint one.
- CLI: sends the token from in-process `fetch` only; the reachability probe sends
  none; uses a `dtk_` key inside a thread; `dispatch access` refuses inside a thread;
  a `dsk_` shell key does not change owner mode; `dispatch api` reads the body from a
  file and stdin; `dispatch open` on WSL falls back to printing the URL.
- Credential resolver: under file delivery (`DISPATCH_AUTH_FILE`) and with
  `DISPATCH_AUTH` filtered out but `DISPATCH_TERMINAL_ID` present, `dispatch api`,
  `dispatch open` and `dispatch access` never use the owner token; an unreadable key
  file fails closed.
- Every caller refuses to send a key when `DISPATCH_API` is unset, and uses the real
  bound port when the daemon fell back from its preferred port.

**Delivery (spawn spies, no real CLIs)**

- For each harness and view: the spawn env holds a key of the right kind; the
  shared default env holds none; the MCP config holds a reference where the harness
  supports one.
- **No key in argv:** scan the argv of every spawned process in the spawn tests for
  `dtk_`, `dck_` and `dsk_`.
- No key in the daemon log: run a spawn and a refused call, then scan the log.
- Respawn, relaunch, restore and transport switch revoke the old key; process exit,
  stop, archive and delete revoke; a daemon restart starts with an empty map.
- Codex Pretty: `thread/start` and `thread/resume` carry the key as a literal in the
  thread config (never `env_vars`); the app-server argv and env do not. Codex CLI:
  argv has `env_vars=["DISPATCH_AUTH"]` and the literal non-secret values, and no key.
- The Codex check (6.3) is its own scripted test on the pinned Codex version, run
  before the delivery code and again before stage 2.
- The shim script, `codex-notify.mjs` and `grok-hook.mjs` send the header, and the
  shim no longer runs `curl`.

**End to end on a throwaway daemon** (port 3490, temporary `HOME`, never the live
daemon)

- A claude-code CLI thread, a claude-code Pretty thread, a codex CLI thread, a codex
  Pretty thread, a grok thread and an opencode thread: `list_threads`,
  `message_thread`, `spawn_agent`, `report_status` and the status hooks work; the
  shim banner shows the right thread.
- From inside a thread: `curl` with no key gets `401` (stage 2); with its own key
  to an owner-only route gets `403`; with its own key and `source: user` gets `403`.
- A Chat turn can spawn a worker in another project; a summarizer key cannot.
- `dispatch open` signs in a fresh browser profile.
- **Restart mid-work (required before stage 1 ships, owner request 2026-10-23).**
  Start, on the throwaway daemon, one thread per harness and view from the list
  above, a project coordinator (overseer) with one worker, and a Chat turn. While
  each is mid-task, restart the daemon (`dispatch restart` equivalent), then also
  kill it hard (`kill -9`) and start it again. After each restart:
  - every thread, the coordinator and Chat come back through their normal revive
    path (browser socket, `ensureStructuredAlive`, coordinator kickstart, next Chat
    turn) with a **new** key, and their next `list_threads`, `message_thread`,
    `report_status` and ledger call succeeds with no `401` and no `403`;
  - conversations, ledger items, files in the working directory and thread status
    are the same as before the restart;
  - the old key gets `401`;
  - a `nohup` job that a thread started before the restart gets `401` and the
    thread that started it is not affected;
  - no thread, coordinator or Chat turn is left stuck in a state that needs the
    owner to relaunch it by hand.
  Repeat once with a Codex app-server crash instead of a daemon restart: the Codex
  Pretty threads keep their key and keep working. A failure here blocks the stage 1
  release.

**Manual, WSL2 (follow-up, like network spec 10.3):** the Windows browser signs in
with `dispatch open` from inside WSL; `curl.exe` started from a WSL thread gets `401`.

## 10. Files touched (for the plan)

- New `packages/core/src/auth/principals.ts`: key mint, resolve, revoke.
- New `packages/core/src/auth/route-policy.ts`: the allowlist and the scope checks.
- New `packages/core/src/auth/one-time-code.ts`: codes for `dispatch open`.
- `auth/access-gate.ts`: principal resolution; stage 1 count; stage 2 rule removal;
  own-tailnet-address exclusion.
- `auth/box-token.ts`: admit a live key or the owner access token; the route policy
  then runs as on a local daemon. `server.ts`: create the token file in box mode too.
- `server.ts`: attach the principal to each request; refuse keys on upgrades;
  `GET /api/whoami`.
- Every route file: declare its policy at registration. `routes/terminals.ts`,
  `routes/watches.ts`, `routes/ledger.ts`, `routes/events.ts`, `routes/auth.ts`,
  `routes/endless.ts`, `routes/sessions.ts`: identity from the principal, the create
  and answer body allowlists, transcript redaction.
- `sessions/service.ts`: mint at spawn and keep the handle per process, revoke by
  handle, legacy record checks, per-spawn env, `agencyServerSpec` (`DISPATCH_API`),
  questions-only `answerPermission` with `coordinator` attribution for keys.
- `pty/manager.ts`, `structured/manager.ts`, `structured/codex-manager.ts`,
  `mcp/injection.ts`, `providers/claude-code.ts`, `providers/codex.ts`,
  `providers/grok.ts`, `providers/grok-home.ts`, `providers/opencode.ts`,
  `providers/opencode-config.ts`: delivery.
- `overseer/agency-mcp.ts`, `overseer/agency-shared.ts`: send the key, `whoami`,
  readable errors; for PK-4 a new `list_projects` tool, an optional `projectId` on
  `list_threads`, and client checks that let an overseer read any project and message
  another project's overseer.
- `sessions/service.ts` (`sendThreadMessage`): the sender line of 6.4.1 on
  cross-project messages. `overseer/guards.ts` stays as the client-side early check and is
  reused by the daemon.
- `endless/service.ts`, `endless/turn-runner.ts`, `endless/summarizer-claude.ts`,
  `endless/memory-mcp.ts`: Chat keys.
- `auth/shim.ts`, `packages/core/scripts/codex-notify.mjs`,
  `packages/core/scripts/grok-hook.mjs`: send the key without argv.
- `platform/inherited-env.ts`: drop owner credentials from the child env.
- New shared credential resolver (one module, used by the CLI, both MCP servers, the
  shim and the hook helpers).
- `packages/cli/src/index.ts`: token on HTTP calls, thread mode through the resolver,
  `dispatch api`, `dispatch open`.
- Redaction helper, used by the conversation routes, the coordinator notices
  (`sessions/service.ts`), the Chat report path and the Chat memory reads
  (`endless/`).
- `auth/signin-page.ts`: accept `#code=`.
- Docs: `docs/network-access.md`, `README.md`, the release notes for both stages,
  `.claude/skills/verify/SKILL.md`, `scripts/test-live-*.mjs`.

## 11. How this unlocks other findings

- **SEC-20 (persistence):** integrations, schedules and roles enable are owner only
  for every key. Editing the file of an already enabled role stays possible (K-10),
  so SEC-20 is narrowed, not closed.
- **SEC-22 (sign-in relay):** Claude sign-in and auth-request completion are owner
  only; a thread can still raise a sign-in banner, and the banner now names the
  thread from its key.
- **SEC-25 (coordinator impersonation):** no thread can write as the coordinator or
  as the user.
- **SEC-07 (Chat on reports):** the `chat` principal carries `startedBy`, so that work
  can narrow report-started turns in the policy table.
- **SEC-04 (secrets in env):** the box tokens leave the thread env. The Doppler token
  stays (separate work).

## 12. Cost and frequency

- **How often the problem happens now:** no incident is known of an agent calling
  the API outside its MCP tools. The risk is what an injected or drifting agent
  could do, and the daemon cannot see it today because it does not know who calls.
- **Runtime cost:** one SHA-256 and one map lookup per request, plus the terminal row
  read that most of these routes already do. No new process. The only new disk
  writes are the stage 1 log lines and, where a harness has no env reference, a small
  key file per thread. Stage 3, if built, adds a process lookup per new loopback
  connection.
- **Build size:** stage 1 is the large part (the Codex check, the policy table and
  body allowlists, six delivery paths, MCP changes, tests). Stage 2 is small (gate
  rule removal, `dispatch open`, the one-time code, doc changes).

## 13. Owner decisions

**Decided 2026-10-23 by the owner: A for all three (PK-1 A, PK-2 A, PK-3 A).**
Two releases; the phone signs in once after stage 2; the process check waits until
stage 2 has run for a few weeks.

- **PK-1. How to release.** (A) Two releases: stage 1 first, stage 2 when the go
  conditions in 7.1 hold (Codex check and end-to-end tests passed, the "programs with
  no key" count is clean, at least one week). (B) Both stages in one release.
  **Recommended and chosen: A.** The stage 1 count shows any script of yours that would break,
  before it breaks.
- **PK-2. Your phone through `tailscale serve` after stage 2.** (A) It signs in once,
  like every other browser, and keeps the cookie for 400 days. (B) It stays automatic,
  as today. **Recommended and chosen: A.** Option B keeps a door that any program on this
  computer can open by sending two headers, so stage 2 would not really stop local
  programs. It also keeps the accepted limit R-6, which option A closes.
- **PK-3. The process check (stage 3).** (A) Decide after stage 2 has run for a few
  weeks. (B) Build it with stage 2. (C) Never. **Recommended and chosen: A.** It needs different
  code per OS and a thread can escape it, so it should wait until stages 1 and 2 show
  whether it is needed.

**Decided 2026-10-23 by the owner: PK-4 option C.**

- **PK-4. Can overseers reach other projects?** (A) No: every key stays in its own
  project, as today. (B) Overseers can read every project, but cannot message
  outside their own. (C) Overseers can read every project and can message another
  project's overseer, under the existing limit of 10 messages per sender and target
  pair per hour; no other cross-project action. **Chosen: C.** The owner has needed
  cross-project reach between overseers. Each project's work stays under its own
  overseer: an overseer still cannot start, archive or answer threads, spawn workers
  or write ledger items outside its own project. Worker keys stay own-project only;
  the summarizer key and the Chat key do not change. This loosens today's rule on
  purpose; 6.4.1 has the rules and K-13 the accepted risk.

Decided in the spec after review round 1, not asked: stage 1 sets no browser cookie
(6.6). One sign-in per browser costs little; handing out a lasting owner credential
to every caller that the local rule admits costs more.
