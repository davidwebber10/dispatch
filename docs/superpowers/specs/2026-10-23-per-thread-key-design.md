---
title: Per-thread keys (the daemon stops trusting every local caller)
date: 2026-10-23
status: draft for owner review
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

It ships in three stages:

- **Stage 1: keys and daemon-side rules.** Every spawn gets a key. Every first-party
  caller sends a credential. The daemon enforces scope for every request that
  carries a thread key. Requests with no credential from this computer still work,
  and are logged.
- **Stage 2: no credential, no access.** A request from this computer with no
  credential gets the sign-in page or `401`, the same as a request from another
  device. The owner's browser already holds a cookie from stage 1, and the CLI reads
  the token file, so the owner sees no new step in the normal case.
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
   scope, spawn depth, message rate, "questions only" for `answer_agent`,
   coordinator-only ledger writes, never `source: user` from an agent.
3. A thread key cannot reach owner-only actions: secrets, integrations, schedules,
   roles, settings, sign-in, update, access, push, raw terminal input, any
   WebSocket.
4. Works for all four harnesses (claude-code, codex, grok, opencode), both views
   (CLI and Pretty), every thread type, macOS, Linux, WSL2, and the hosted box.
5. No secret ever goes into a command line (the owner's machines log every argv).
6. The owner's CLI, browser and scripts keep working with no new step in the
   normal case.
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
- **Every thread process is killed when the daemon stops**, and every respawn and
  resume goes through `spawnTerminal` or `spawnStructured`, which rewrite every
  per-thread config file (`sessions/service.ts:2231-2568`). This makes keys that
  live only in daemon memory practical.
- **Codex in the CLI view gets MCP env through argv** (`-c mcp_servers.NAME.env.KEY=VALUE`,
  `mcp/injection.ts:30`). Today those values are ids, not secrets. A key must never
  go there.
- **The hosted box gate** (`auth/box-token.ts:40-46`) requires the box header on
  every request, also from loopback. Local callers there send no such header, so they
  are probably refused today (not verified). Threads also inherit
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

A `thread` principal carries only the terminal id. Everything else is read from the
database at request time: project (`session_id`), `config.role`, `config.spawnedBy`,
`config.spawnDepth`, `config.origin`, `runner`, type, archived. Stage 1 makes these
fields daemon-written (6.4), so reading them live is safe and follows a thread that
the owner moves to another project.

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
- **Revoke** when the process exits, when the owner stops, archives or deletes the
  thread, when a respawn mints a new key, and for a Codex Pretty thread when the
  manager unsubscribes it. A Chat key is revoked when its turn process exits.
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

**Rule:** the key travels in a per-spawn environment variable, `DISPATCH_KEY`, or in a
`0600` file inside the `0700` data directory. Never in argv. Where a harness can
reference an environment variable from its config, the config holds the reference,
not the value.

The per-spawn env already exists for `DISPATCH_TERMINAL_ID` (`sessions/service.ts:2268`
for PTY threads, `:2618-2620` for structured ones), so `DISPATCH_KEY` rides beside it.
It is never added to the shared default env (`setDefaultEnv`), which every child gets.

| Path | Thread process env | Agency or memory MCP | Hooks | Browser shim |
|---|---|---|---|---|
| claude-code, CLI view | `DISPATCH_KEY` in the PTY env | `thread-ID.mcp.json` holds `"DISPATCH_KEY": "${DISPATCH_KEY}"`, the same reference style that the Doppler server uses today | The `http` hook gets an `Authorization` header that references `DISPATCH_KEY`, if Claude Code's HTTP hooks can read a header value from the environment (to verify in the plan). If not, the hook becomes a `command` hook that runs a small Node helper (like `codex-notify.mjs`) which reads the key from its env and the payload from stdin. | Reads `DISPATCH_KEY` from env |
| claude-code, Pretty | `DISPATCH_KEY` in the structured spawn env | Same file and reference | None (status comes from the stream) | Same |
| codex, CLI view | `DISPATCH_KEY` in the PTY env | `-c mcp_servers.dispatch.env_vars=["DISPATCH_KEY","DISPATCH_SERVER_URL"]`: argv names the variables, never the value. The literal identity flags are dropped (6.4: identity comes from the key). | `codex-notify.mjs` reads `DISPATCH_KEY` from its inherited env (to verify that Codex passes its env to `notify`) | Same |
| codex, Pretty (shared app-server) | The app-server env stays empty of keys. Each thread's `thread/start` and `thread/resume` config sets `shell_environment_policy.set.DISPATCH_KEY`, beside the existing `DISPATCH_TERMINAL_ID` | `mcp_servers.dispatch.env.DISPATCH_KEY` as a literal in the thread config, which goes over the JSON-RPC pipe, not argv | None | Same (through the shell policy) |
| grok, CLI view | `DISPATCH_KEY` in the PTY env | The per-thread `plugins/dispatch/.mcp.json` in the thread's Grok home: an env reference if Grok supports one, else the literal value in a `0600` file | `grok-hook.mjs` reads `DISPATCH_KEY` from env | Same |
| grok, Pretty | Same as above, structured env | Same file, written by the Pretty path | None | Same |
| opencode (Pretty only) | `DISPATCH_KEY` in the structured env | `opencode.json` `mcp.dispatch.environment`: an env reference if opencode supports one, else the literal in a `0600` file | None | Same |
| Scheduled runs (claude, codex) | `DISPATCH_KEY` in the runner env | Same as the claude or codex row | None | Same |
| Grok scheduled runs | `DISPATCH_KEY` for the shim only | None today (no MCP for grok runners) | None | Same |
| Role runs | Same as a claude-code Pretty thread | Same | None | Same |
| Chat turn and summarizer | `DISPATCH_KEY` (a `dck_` key) in the turn's spawn env | `memory.mcp.json` holds the reference `${DISPATCH_KEY}`; the file stays shared and holds no secret | None | Same |
| Shell tab | `DISPATCH_KEY` (a `dsk_` key) in the PTY env | None | None | Same |

The browser shim stops using `curl` for its POST. A short Node script reads
`DISPATCH_KEY` and `DISPATCH_SERVER_URL` from its env and sends the request, so the
key never appears in a process list. The MCP helpers and both hook scripts send
`Authorization: Bearer KEY` on every request.

**The agency MCP asks the daemon who it is.** At start it calls `GET /api/whoami`
with its key and gets its terminal id, project, role and depth. The
`DISPATCH_TERMINAL`, `DISPATCH_SESSION` and `DISPATCH_SPAWN_DEPTH` variables stay
for one release as a fallback for display only; the daemon ignores them.

**Files that hold a literal key** (Grok and opencode, if they have no env reference)
are written with mode `0600` and deleted when the thread process exits, not only on
archive. A key left in an old file is already revoked, so the delete is for hygiene.
PR 103 adds a sweep for stale `thread-*.mcp.json` files; the same sweep covers the
Grok and opencode homes.

**The thread env loses the owner's credentials.** `platform/inherited-env.ts` drops
`DISPATCH_BOX_TOKEN`, `OS_BOX_TOKEN` and any `DISPATCH_KEY` of the daemon's own env
from what children inherit. (The access token is never in the daemon's env; it lives
in a file.) The wider env allowlist in SEC-04 stays separate work.

### 6.4 Scope: what each key may call

**Default:** owner only. The table below is the whole allowlist. It lists exactly the
routes that first-party callers use today (section 3). Adding a route for a key kind
later is an explicit, reviewed change to `auth/route-policy.ts`.

**All WebSocket upgrades are owner only.** No key kind may open a terminal socket,
the structured stream or the events socket.

**Thread key (`dtk_`)**

| Route | Rule in the daemon |
|---|---|
| `GET /api/whoami` | Returns the caller's own id, project, role, depth, parent. |
| `GET /api/sessions/SID/terminals` | `SID` is the caller's project. |
| `GET /api/terminals/ID`, `/conversation`, `/conversation/search`, `/permission` | Target is in the caller's project. |
| `GET /api/sessions/SID/overseer/worker-defaults` | `SID` is the caller's project. |
| `POST /api/sessions/SID/terminals` (spawn and queue) | `SID` is the caller's project. The daemon sets `role: agent`, `spawnedBy` = caller, `spawnDepth` = caller depth + 1, and refuses past `MAX_SPAWN_DEPTH` (3). It ignores `skipPermissions`. `workingDir`, when given, must resolve (real path) inside the project folder. Body values for role, depth or parent that disagree are refused. |
| `POST /api/terminals/ID/message` | Target is in the caller's project, is not the caller, is not a shell tab. The daemon sets `source` to `coordinator` when the caller is the project's coordinator, else `agent`. A body `source: user` is refused. The per-pair hourly limit from `guards.ts` runs here, keyed by caller and target. |
| `POST /api/terminals/ID/start` | Target was spawned by the caller, or the caller is the coordinator of the target's project. |
| `DELETE /api/terminals/ID` (archive) | Same rule, plus the `checkArchiveAllowed` rules, moved into the daemon. |
| `POST /api/terminals/ID/permission` (answer) | Same rule. The pending request must be a question (the AskUserQuestion kind), not a held tool call. `requestId` is required and must match. |
| `POST /api/terminals/ID/report-status` | `ID` is the caller. |
| `POST`, `GET`, `DELETE /api/watches` | The watcher is the caller (filled in or checked). The target is in the caller's project. A shell tab cannot be a watcher (PR 103). `GET` returns only the caller's watches. |
| Every `/api/sessions/SID/ledger...` route the agency MCP uses, and `GET .../ledger/card`, `.../source` | `SID` is the caller's project. Write routes take `caller` from the key; the existing "live coordinator in this project" check then runs on the real caller. |
| `POST /api/events/PROVIDER/ID` | `ID` is the caller and `PROVIDER` matches its type. |
| `POST /api/auth-requests` | `terminalId` is set from the key. |

**Chat key (`dck_`)**

| Route | Rule |
|---|---|
| `GET /api/whoami` | Returns the principal kind and `startedBy`. |
| `GET /api/endless/zoom`, `/date`, `/threads`, `/project` | Allowed (Chat reads across projects by design). |
| `GET /api/terminals/ID/conversation` | Any project (by design). |
| `POST /api/endless/arm`, `/disarm` | Target has `origin: endless`. |
| `POST /api/endless/ledger/ACTION` | Allowed, with today's service rules. |
| `POST /api/sessions/SID/terminals` and the worker calls it makes (message, read) | Any project. The daemon sets `origin: endless`, `spawnDepth: 1`, `role: agent`. Messages only to `origin: endless` threads. |
| `DELETE /api/terminals/ID` | Target has `origin: endless`. |
| `POST /api/auth-requests` | Allowed. |

A `summarizer` chat key gets only the `GET` routes.

**Shell key (`dsk_`)**: `POST /api/auth-requests` only, with `terminalId` from the key.

**Everything else is owner only**, for example: secrets, integrations, roles
enable and disable, schedules and runs, Claude sign-in, auth-request
complete and callback, update, settings, servers, push, access, setup and install,
Chat instructions and send, terminal input, autonomy, relaunch, restore, stop,
stop-all, interrupt, compact, `PATCH /api/terminals/ID` (which can set any role),
move, every files route, state, transcribe, and creating or changing a project.

**Errors** (JSON, so the MCP tools can show a plain message):

| Status | `error` | When |
|---|---|---|
| `401` | `auth_required` | No valid credential (stage 2), or a revoked or unknown key (any stage) |
| `403` | `owner_only` | A key called a route outside its allowlist |
| `403` | `identity_mismatch` | A body or query field names another caller |
| `403` | `out_of_scope` | Target outside the caller's project, or not the caller's worker |
| `403` | `depth_exceeded` | Spawn past the limit |
| `403` | `not_a_question` | `answer_agent` on a held tool call |
| `429` | `rate_limited` | Per-pair message limit |

An `owner_only` answer from an MCP tool tells the agent, in one sentence, to ask the
owner to do it in the browser.

**The owner is not restricted** by this table. The browser keeps sending
`source: user` with its cookie. Owner-only actions that SEC-20 worries about could
later become a decision card that a thread proposes and the owner accepts; that is
a follow-up, not part of this design.

### 6.5 Lifecycle walk-through

| Event | Key effect |
|---|---|
| New thread (any harness, either view) | Mint, put in the spawn env and config, then start the process. |
| Spawned worker | The parent's key authorizes the create; the worker gets its own key at its own spawn. |
| Queued agent | No key until `start` spawns it. |
| Process exits (task done, crash, `/exit`) | Revoke. |
| Owner stops, archives or deletes | Revoke, then kill. |
| Respawn, relaunch, restore, switch view (transport) | Revoke the old key, mint a new one. |
| PTY thread revived by a browser socket after a restart | New spawn, new key. |
| Structured thread revived by `ensureStructuredAlive` | New spawn, new key. |
| Coordinator kickstart at daemon start | New spawn, new key. |
| Codex Pretty thread released (`thread/unsubscribe`) | Revoke. Its MCP set may live up to `thread_unload_delay_secs` longer and gets `401`. |
| Codex app-server crash and `thread/resume` | Same key (still live). |
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
- The `tailscale serve` identity-header rule, if the owner chooses that (owner
  question PK-2). Any program on this computer can send the two headers that rule
  checks.

Stage 2 therefore also closes network spec residuals R-1, R-2, R-3 and R-6 (with
PK-2 option A).

**Stage 1 prepares the browsers so that stage 2 needs no sign-in.** During stage 1,
when a non-API `GET` passes through the local rule and has no valid cookie, the
response sets the cookie. Every local browser, Windows browser on WSL and phone
through `tailscale serve` that opens Dispatch during stage 1 then already holds a
cookie when stage 2 arrives. This gives no new right during stage 1: the local rule
already admits that caller.

**A browser that still has no cookie** sees the sign-in page. Two ways in:

- `dispatch open` (new) on the computer that runs Dispatch. It asks the daemon, with
  the owner token, for a one-time code (128 bits, single use, valid 60 seconds,
  stored only as a hash in memory) and opens `http://localhost:PORT/#code=CODE`. The
  sign-in page posts the code to `POST /api/access/login`, which sets the cookie. The
  code shows in the `open` command's argv; it is single use and expires in a minute,
  so this is acceptable. The token itself never appears.
- Paste the token from `dispatch access`, as in Phase 1.

The sign-in page names both. `dispatch install` ends with `dispatch open`.

### 6.7 The CLI and the owner's scripts

- **The CLI sends the owner token** (read from `~/.dispatch/access-token`, as
  `dispatch access` already does) on every HTTP call: the status probe and `roles`.
  The status probe also counts a `401` as "reachable".
- **New `dispatch api METHOD PATH`**, with an optional body from a file or stdin. It
  adds the owner token and prints the JSON answer. This is the low-friction path for
  the owner's own scripts: no token on the command line, no header to build.
- **Inside a thread the CLI does not act as the owner.** When `DISPATCH_KEY` starts
  with `dtk_` or `dck_`, the CLI sends that key instead of the owner token, and
  `dispatch access` (print, `--link`, `rotate`) refuses with "Run this in your own
  terminal, not in a Dispatch thread." A shell tab (`dsk_`) is the owner at a
  keyboard, so the CLI there uses the owner token as normal. This is a guard against
  drift only: a thread can still read the file on purpose (section 8).
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
  The Windows browser keeps working through its stage 1 cookie. Mirrored mode is the
  same as a local browser.
- **Hosted box:** the box gate (`auth/box-token.ts`) accepts a live key as well as
  the box header, so threads on a box reach their own routes. Threads no longer
  inherit the box token (6.3). The router's own path is unchanged.
- **Native Windows (port in progress on its own branch):** the design is OS-neutral.
  Two items for that port: the browser shim needs a Windows form that reads
  `%DISPATCH_KEY%` and posts with Node, not `curl` argv; and a stage 3 process check
  would use `GetExtendedTcpTable`, which gives the owning PID directly.

### 6.9 Logs and attribution

- Every refusal logs one line: principal kind, terminal id, method, route, error.
  Never the key.
- **Stage 1 only:** every request that passed with no credential logs method, path
  and `User-Agent`, and `dispatch status` prints the count for the last 7 days with
  the top paths. That count is the go signal for stage 2: it should be zero apart
  from the owner's own scripts.
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
| 1 | Next minor (for example v3.5.0) | Nothing visible. Threads get keys. Agents that call owner-only routes with their key get `403`. Calls with no credential still work and are counted. Local browsers get the cookie. |
| 2 | The minor after, one week later if the stage 1 count is clean (owner question PK-1) | Programs on this computer need a credential. The CLI, threads and stage 1 browsers already have one. |
| 3 | Only if the owner chooses | Process check. |

Stage 1 alone already closes the forged-body paths for every agent that uses its MCP
tools, and every owner-only route for every caller that sends a key. The direct
`curl` with no key stays open until stage 2. That is why the gap between the two
releases should be short.

### 7.2 What breaks

| Who | Stage 1 | Stage 2 | Fix |
|---|---|---|---|
| The owner's browser on this computer | Nothing; gets the cookie | Nothing if opened during stage 1; else the sign-in page once | `dispatch open` |
| Windows browser for a WSL2 daemon | Gets the cookie | Same as above | `dispatch open` inside WSL, or paste the token |
| Phone through `tailscale serve` | Gets the cookie | With PK-2 option A: nothing if opened during stage 1; else sign in once | `dispatch access --link HOST` |
| Phone or laptop on the owner's tailnet (direct) | Nothing | Nothing | None |
| Other devices (LAN, other tailnet users) | Nothing (they already sign in) | Nothing | None |
| `dispatch` CLI | Sends the token | Nothing more | None |
| The owner's own scripts that call the API with no credential | Nothing; counted | `401` | `dispatch api`, or send the token from a header file |
| An agent that calls the API with `curl` and no key | Nothing; counted | `401` | Use the MCP tools |
| An agent that calls an owner-only route or forges identity | `403` | `403` | Ask the owner |
| An agent that answers another thread's held tool | `403 not_a_question` | Same | The owner answers in the browser |
| `pnpm dev` (Vite) | Nothing | One sign-in on `localhost`; the cookie also reaches the dev server, because cookies ignore the port | None |
| Hosted box | Threads start to work through the box gate with their key | Same | None |
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

### 7.4 Why no off switch

A switch that brings back loopback trust would be turned on once to fix a script
and then forgotten, and it would bring back every path this design closes, for every
thread. The owner keeps full access through the CLI and the cookie, `dispatch api`
covers scripts, and the stage 1 count shows what would break before stage 2 ships.
This matches NE-4 in the network spec.

## 8. Residual risks

- **K-1. Deliberate theft by a same-user process.** A thread can read
  `~/.dispatch/access-token` (and the cookie derives from it), read a peer thread's
  `DISPATCH_KEY` from its process environment (`/proc/PID/environ` on Linux and WSL,
  `ps eww` on macOS), or read a literal key file. Stage 3 makes this harder. Only an
  OS sandbox or a separate OS user per thread would close it.
- **K-2. A stage 1 cookie harvested by a local program** keeps working after stage 2.
  It is the same class as K-1. `dispatch access rotate` revokes every cookie.
- **K-3. A key leaks through the thread's own children** (a test that prints its env,
  a log, a Codex rollout file that records the thread config; the last is not
  verified). The key is scoped to that thread and dies with it.
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

## 9. Tests

**Unit**

- `principals.test.ts`: mint, resolve, revoke; one live key per terminal; unknown,
  revoked, malformed and wrong-prefix keys; the map holds hashes only.
- `route-policy.test.ts`: a completeness test that walks every route Express
  registers and fails when one has no policy entry; one case per allowlist row for
  allowed and refused; every WebSocket path refuses every key kind.
- Identity: body `caller`, `watcherTerminalId`, `terminalId`, `source`,
  `config.role`, `config.spawnDepth`, `config.spawnedBy` filled in when absent,
  refused when different.
- Guards in the daemon: depth 3 refused at 4; pair rate limit; self-target; shell
  target; archive rules; `answer_agent` refused for a held tool, a missing
  `requestId`, a thread in another project, a thread that is not the caller's
  worker.
- `source: user` refused for every key kind, accepted from the owner cookie.
- Gate: stage 1 still admits a credential-free local request and logs it; stage 2
  refuses it with `401` (API) and the sign-in page (navigation); a request from this
  machine's own tailnet address is refused under rule 3; the WSL gateway peer needs
  a credential; the stage 1 cookie is set on a local navigation.
- One-time code: single use, 60-second expiry, refused after use, only an owner
  credential can mint one.
- CLI: sends the token; uses a `dtk_` key inside a thread; `dispatch access`
  refuses inside a thread; a `dsk_` shell key does not change owner mode;
  `dispatch api` reads the body from a file and stdin.

**Delivery (spawn spies, no real CLIs)**

- For each harness and view: the spawn env holds a key of the right kind; the
  shared default env holds none; the MCP config holds a reference where the harness
  supports one.
- **No key in argv:** scan the argv of every spawned process in the spawn tests for
  `dtk_`, `dck_` and `dsk_`.
- No key in the daemon log: run a spawn and a refused call, then scan the log.
- Respawn, relaunch, restore and transport switch revoke the old key; process exit,
  stop, archive and delete revoke; a daemon restart starts with an empty map.
- Codex Pretty: `thread/start` and `thread/resume` carry the key in the thread
  config; the app-server argv and env do not.
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

**Manual, WSL2 (follow-up, like network spec 10.3):** the Windows browser keeps its
stage 1 cookie through stage 2; `curl.exe` started from a WSL thread gets `401`.

## 10. Files touched (for the plan)

- New `packages/core/src/auth/principals.ts`: key mint, resolve, revoke.
- New `packages/core/src/auth/route-policy.ts`: the allowlist and the scope checks.
- New `packages/core/src/auth/one-time-code.ts`: codes for `dispatch open`.
- `auth/access-gate.ts`: principal resolution; stage 1 count and cookie; stage 2
  rule removal; own-tailnet-address exclusion.
- `auth/box-token.ts`: accept a live key.
- `server.ts`: attach the principal to each request; refuse keys on upgrades;
  `GET /api/whoami`.
- `routes/terminals.ts`, `routes/watches.ts`, `routes/ledger.ts`,
  `routes/events.ts`, `routes/auth.ts`, `routes/endless.ts`, `routes/sessions.ts`:
  identity from the principal.
- `sessions/service.ts`: mint at spawn, revoke at exit and on owner actions,
  per-spawn env, `agencyServerSpec`, questions-only `answerPermission`.
- `pty/manager.ts`, `structured/manager.ts`, `structured/codex-manager.ts`,
  `mcp/injection.ts`, `providers/claude-code.ts`, `providers/codex.ts`,
  `providers/grok.ts`, `providers/grok-home.ts`, `providers/opencode.ts`,
  `providers/opencode-config.ts`: delivery.
- `overseer/agency-mcp.ts`, `overseer/agency-shared.ts`: send the key, `whoami`,
  readable errors. `overseer/guards.ts` stays as the client-side early check and is
  reused by the daemon.
- `endless/service.ts`, `endless/turn-runner.ts`, `endless/summarizer-claude.ts`,
  `endless/memory-mcp.ts`: Chat keys.
- `auth/shim.ts`, `packages/core/scripts/codex-notify.mjs`,
  `packages/core/scripts/grok-hook.mjs`: send the key without argv.
- `platform/inherited-env.ts`: drop owner credentials from the child env.
- `packages/cli/src/index.ts`: token on HTTP calls, thread mode, `dispatch api`,
  `dispatch open`.
- `auth/signin-page.ts`: accept `#code=`.
- Docs: `docs/network-access.md`, `README.md`, the release notes for both stages,
  `.claude/skills/verify/SKILL.md`, `scripts/test-live-*.mjs`.

## 11. How this unlocks other findings

- **SEC-20 (persistence):** integrations, schedules and roles writes are owner only
  for every key.
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
  read that most of these routes already do. No new process, no disk write. Stage 3,
  if built, adds a process lookup per new loopback connection.
- **Build size:** stage 1 is the large part (policy table, six delivery paths, MCP
  changes, tests). Stage 2 is small (gate rule removal, `dispatch open`, the one-time
  code, doc changes).

## 13. Open questions for the owner

- **PK-1. How to release.** (A) Two releases: stage 1 first, stage 2 one week later
  after the "calls with no key" count is clean. (B) Both stages in one release.
  **Recommended: A.** The week shows any script that would break, and it gives every
  browser its cookie, so stage 2 needs no sign-in.
- **PK-2. Your phone through `tailscale serve` after stage 2.** (A) It needs a cookie
  like every other browser. A phone that opened Dispatch during stage 1 already has
  one; any other phone signs in once. (B) It stays automatic, as today. **Recommended:
  A.** Option B keeps a door that any program on this computer can open by sending
  two headers, which is the kind of local bypass this work closes.
- **PK-3. The process check (stage 3).** (A) Decide after stage 2 has run for a few
  weeks. (B) Build it with stage 2. (C) Never. **Recommended: A.** It needs different
  code per OS and a thread can escape it, so it should wait until stages 1 and 2 show
  whether it is needed.
