# Per-thread keys, stage 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Every code task is test first: write the test, run it and see it fail, write the code, run it and see it pass, commit.

**Goal:** Build stage 1 of `docs/superpowers/specs/2026-10-23-per-thread-key-design.md`: every agent, Chat and shell process gets its own key, the daemon takes the caller's identity from the key and enforces the per-key rules, and requests with no credential still work and are counted.

**Architecture:** A key registry in daemon memory maps `sha256(key)` to a principal. A principal middleware runs after the existing gate (and before the login route) and attaches one principal to every request. Each route declares its key policy where it is registered, through a small router wrapper whose default is owner only. The spawn paths mint a key per process, put it in the process environment or the per-thread harness config (never argv), and revoke it by handle when that process exits. The MCP helpers, the hook helpers and the browser shim send `Authorization: Bearer KEY`, and only to the daemon's own URL.

**Tech stack:** TypeScript, Express 4, `ws`, vitest 2, supertest 7, Node 18 or later. macOS, Linux, WSL2, the hosted box.

**Scope:** stage 1 only. Stage 2 (no credential, no access; `dispatch open`; one-time codes; the `#code=` sign-in) and stage 3 (process check) are follow-ups and have no task here.

**Review history:** round 1 (Opus, Codex `gpt-6-astra`) on `623eb1ef`; all findings are folded in below. The main changes: structured exits revoke the bound handle, not the live one; Codex Pretty keeps `env: {}`; the login route sees the principal; redaction at every write point; a Codex reuse window when a resume can find the old MCP set; the probes use fixture helpers and the real `CODEX_HOME` (no copied sign-in); one route registration for the test app and the daemon; the restart test runs in a clean environment, with real work in progress and every claimed case set up.

## Global Constraints

- Stage 1 causes no visible change for the owner. A request with no credential from this computer keeps working exactly as in v3.4.1 and is counted. No cookie is set in stage 1 (spec 6.6).
- Key format: prefix `dtk_` (thread), `dck_` (Chat), `dsk_` (shell), then 32 bytes from `crypto.randomBytes`, base64url, 43 characters (spec 6.2).
- Keys live only in daemon memory: the registry holds `sha256` hashes; the literal exists only in the spawn env or config that the daemon hands to the child, in the Codex manager's stored `threadConfig` (as today for the thread id), and in the Codex reuse window (Task 12). Never in the database, the daemon log, argv, or a file that the daemon does not hand to the child (spec 6.2, 6.3).
- The environment variable is `DISPATCH_AUTH` (no KEY, TOKEN or SECRET in the name, spec 6.3). It is never added to the shared default env (`setDefaultEnv`), and the shared Codex app-server env never holds it.
- One destination rule for every first-party caller: a key is sent only to a URL that starts with `DISPATCH_API` (the real bound URL with the base path); when `DISPATCH_API` is unset, no key is sent (spec 6.3).
- Default deny: a route with no key policy is owner only. Every WebSocket upgrade that carries a key is refused (spec 6.4).
- A request that carries a key is judged as the key, whatever other credential it also carries, the login route included (spec 6.4, precedence).
- Error bodies are JSON `{ error, message }` with the codes of spec 6.4: `auth_required` (401), `owner_only`, `field_not_allowed`, `identity_mismatch`, `out_of_scope`, `depth_exceeded`, `not_a_question` (403), `rate_limited` (429).
- `MAX_SPAWN_DEPTH` stays 3 and `MAX_MESSAGES_PER_PAIR_PER_HOUR` stays 10 (`overseer/guards.ts`).
- No new file must exist for the daemon to start (spec 7.3). No database schema change. No off switch (spec 7.4).
- Tests: run vitest from `packages/core` (or `packages/cli`) as `node node_modules/vitest/vitest.mjs run FILE > /tmp/ptk-test.log 2>&1`, then read the file. Never `npx vitest` (the rtk hook rewrites it into a full run on the real HOME). Never pipe a test run through `head` or `tail`. One vitest process at a time. If a run that you did not start is alive, wait; never kill it.
- Tests that spawn, write files or delete files use a nested temp sandbox (`mkdtemp`, then a subdirectory). A delete test also puts a symlink to a canary folder outside the sandbox and asserts the canary survives. The test harness already isolates HOME (`tests/harness/isolated-home.ts`); do not work around it.
- Never touch port 3456, the live `~/.dispatch`, or the live daemon. No `dispatch restart`, `dispatch update` or `launchctl`. A throwaway daemon uses a fake HOME, a clean env and a free port that is not 3456. Never `pkill -f` or `killall`: kill by pid only (a pattern kill ended 14 live threads on 2026-10-12).
- Never copy, move or delete a CLI's sign-in file (`~/.codex/auth.json`, the Claude keychain item, `~/.grok`, the opencode auth file). OAuth refresh tokens rotate, so a copy that refreshes and is then deleted can sign the owner out everywhere.
- The repo is public: no company, customer, product or person names and no home paths (`/Users/NAME`) in code, tests, docs or commit messages. No em-dashes in prose. No raw `<placeholder>` text outside code spans.
- No push, no PR, no merge, no release, no version bump until the owner says so. Commit locally after each task.

## Base, branch and spec drift

- Build branch: `feat/per-thread-key-stage-1`, from `main` at `5b6663b8` (v3.4.1), in a new worktree `.worktrees/per-thread-key-stage-1`. The spec branch `spec/per-thread-key` (base v3.4.0) stays docs only. Bring the spec and this plan in with `git checkout spec/per-thread-key -- docs/superpowers/specs/2026-10-23-per-thread-key-design.md docs/superpowers/plans/2026-10-23-per-thread-key-stage-1.md` and one docs commit.
- The spec cites v3.4.0 line numbers. Main moved them. Checked on main `5b6663b8`:

| Spec cite (v3.4.0) | On main | Note |
|---|---|---|
| `sessions/service.ts:2227` (depth default) | 2237 and 2414 | +10 after line 2122, +7 before it |
| `sessions/service.ts:2268` (PTY env) | 2278 | |
| `sessions/service.ts:2618-2620` (structured env) | 2627-2630 | Codex gets `env: {}` and `threadConfig` |
| `sessions/service.ts:2853-2866` (agency env) | 2863-2876 | `DISPATCH_PORT` now uses `daemonPort` (PR 103) |
| `sessions/service.ts:2050-2062` (coordinator create) | 2057-2069 | |
| `sessions/service.ts:1918-1932` ("relaunch") | 1925-1939 | That range is `switchTransport`; `relaunchTerminal` is 1011, `restartTerminal` 1032, `relaunch` (project) 432 |
| `sessions/service.ts:1717-1759` (`answerPermission`) | 1724-1766 | attribution lines now 1742, 1759, 1787, 1808 |
| `sessions/service.ts:1232-1252`, `1466-1473` (notices) | 1239-1259, 1467-1480 | also `noteAgentNeedsHelp` 1542-1555 embeds `ask` |
| `sessions/service.ts:2231-2568` (spawn paths) | `spawnTerminal` 2186, `spawnStructured` 2399-2633 | |
| `server.ts:699` (PTY exit) | 703 | |
| `server.ts:471-486` (box gate, token file) | 474-486 | |
| `routes/terminals.ts:30,56,137-148` | same | |
| `routes/watches.ts:20` | same | PR 103 added the shell-watcher refusal at 36-40 |
| `overseer/ledger-service.ts:162-170` | 161-170 | |
| `structured/codex-manager.ts:435-450` | 435-457 | |
| all `agency-mcp.ts`, `memory-mcp.ts`, `endless/*`, `providers/*`, `pty/manager.ts`, `roles/role-policy.ts` cites | same | |

- Facts on main that change the spec's assumptions (handled in the tasks below):
  1. PR 103 already added `sessions/mcp-config-sweep.ts` (stale `thread-*.mcp.json` sweep). Task 13d extends it, by named file only.
  2. `routes/watches.ts` already refuses a shell watcher (spec 6.4 cites "PR 103").
  3. Files still written without mode `0600`: `hooks/ID.json` (`service.ts:370-373`), `opencode.json` and `rules.md` (`providers/opencode-config.ts:58,79`), Grok `hooks/hooks.json` (`grok-home.ts:133`), `chat/memory.mcp.json` (`endless/service.ts:160`).
  4. `platform/inherited-env.ts` drops only `PORT`.
  5. Role runs keep `watch_thread`, `unwatch_thread` and `list_watches` (`roles/role-policy.ts:30-33`). Spec 6.1 leaves the watch routes out of the role-run key. Task 11 adds them, or role runs would get `403` on a tool they use today.
  6. `MessageSource` is `'user' | 'coordinator'` in the database and the UI (`db/message-source.ts:6`). Spec 6.4 asks for a new `agent` value. Plan decision (no visible change in stage 1): every key caller gets `coordinator`, which is what every agent sends today, and never `user`. The `agent` value is a follow-up.
  7. In stage 1 the owner's browser has no cookie, so every browser request has no credential. A log line per request (spec 6.9) would flood the log. Plan decision: log the first request of each (category, method, path pattern) per daemon start, then one summary line per hour. The same rate limit applies to refusal lines (first line per key hash or peer, then one per minute with a count). The in-memory counts are complete.
  8. `scripts/test-live-*.mjs` and the `verify` skill keep working in stage 1 (no credential is still allowed). They change in the stage 2 release, as the spec says.
  9. The Claude Code docs confirm HTTP hook `headers` with `allowedEnvVars` (HTTP hooks since 2.1.63; Dispatch already needs 2.1.69 or later). Task 1 confirms it on the installed CLI. A managed `httpHookAllowedEnvVars` setting can block it; then the hook sends no credential and is counted (stage 1 keeps working).
  10. `opencode` 2.x runs a managed shared service (port 49374 on this Mac). If MCP servers are started by that service, a `{env:DISPATCH_AUTH}` reference resolves in the wrong process. Task 1 decides the opencode delivery.
  11. `structured/manager.ts:303` calls `kill()` inside `spawn()` when a draining session is still in the map, and `kill` emits `exit` at once (659). An exit handler that revoked "the terminal's live key" would then revoke the key that was just minted. Task 12 binds each structured exit to the handle of that session.
  12. The Codex app-server env is built from the first thread's spawn env and kept for crash recovery (`codex-manager.ts:298-304`, 442). Codex Pretty must keep `env: {}`.
  13. `createApp` (tests) and `startServer` (daemon) mount different routes: `/api/endless` exists only in `startServer` (756), and the login route only there (488). Task 6 moves the mounts into one function.
  14. Thread text is stored by the daemon in more places than the spec lists: `config.lastOutcome` (`noteTurnOutcome` 1588-1609, returned by the terminal row routes), report-status summaries and asks, the coordinator message log, and the Chat store (`endless/log.ts:15-29` `appendLogged`). Task 16 redacts at those write points.
  15. The project-level legacy relaunch (`service.ts:440-456`, projects with no terminal rows) spawns a plain CLI with no env and no MCP. It gets no key, needs none, and is unchanged.
  16. Hooks and the shim use `http://127.0.0.1:PORT` with no base path (`server.ts:451-454`, 891-896). On a hosted box with a base path they miss the daemon today. Task 13a adds the base path.
  17. A new Grok thread defaults to Pretty unless the body names a transport (`service.ts:523-527`). The restart test names `pty` for Grok CLI.

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/auth/principals.ts` (new) | `KeyRegistry`: mint, resolve, revoke by handle, one live key per terminal; `keyKindOf` |
| `packages/core/src/auth/request-principal.ts` (new) | Principal middleware, `principalOf(req)`, `scopeOf(req)`, rate-limited refusal logging, key refusal on upgrades |
| `packages/core/src/auth/no-credential-stats.ts` (new) | Stage 1 counts per category and path pattern, rate-limited log lines |
| `packages/core/src/auth/route-policy.ts` (new) | `policyRouter()`, `keyRoute()`, `ownerOnly`, `publicRoute`, `refuse()`, error type |
| `packages/core/src/auth/key-scope.ts` (new) | Database facts for a caller and a target: effective depth, legacy record rules, coordinator of, worker of, same project, role run |
| `packages/core/src/auth/key-rules.ts` (new) | The rules of each allowlist row; the daemon-wide pair limiter with a spawn credit |
| `packages/core/src/auth/redact-keys.ts` (new) | `redactKeys(text)`, `redactKeysDeep(value)` |
| `packages/core/src/auth/credential.ts` (new) | The one credential resolver (owner, thread, shell, none, refuse) and the destination rule, for the CLI, both MCP servers and the shim relay |
| `packages/core/src/auth/shim-relay.ts` (new) | Node relay that the browser shim runs instead of `curl` |
| `packages/core/src/sessions/thread-keys.ts` (new) | Key lifecycle per process: mint at spawn, bind to the process, revoke on exit, stop, archive, delete, spawn failure; the Codex reuse window; key files |
| `packages/core/src/server-routes.ts` (new) | `mountApiRoutes(app, deps)`: the one list of `/api` mounts, used by `createApp` and `startServer` |
| `packages/core/src/auth/access-gate.ts` | Record the decision `via` on the request; export `hasOwnerCredential` |
| `packages/core/src/auth/box-token.ts` | Box gate admits a box header, the owner access token, or a live key |
| `packages/core/src/server.ts` | Build one registry; mount the principal middleware before the login route and every router; whoami and stats routes; key refusal on upgrades; token file in box mode; base path in hook and shim URLs; `DISPATCH_API` in the default env |
| `packages/core/src/routes/*.ts` (26 files) | `Router()` becomes `policyRouter()`; key rows use `keyRoute(...)` |
| `packages/core/src/sessions/service.ts` | Mint and deliver keys, revoke, legacy depth, `spawnDepth: 0` on root threads, `DISPATCH_API` in `agencyServerSpec`, `answerPermission` attribution, redaction at write points |
| `packages/core/src/pty/manager.ts` | `exit` event carries the pid |
| `packages/core/src/mcp/injection.ts` | One server can carry literal `env` and `env_vars` together; the key reference and the Codex literal |
| `packages/core/src/providers/claude-code.ts`, `providers/codex.ts` | HTTP hook `headers` and `allowedEnvVars`; notify key-file path in the fallback |
| `packages/core/src/providers/grok-home.ts`, `providers/opencode-config.ts` | Key delivery per Task 1 result; `0600` files |
| `packages/core/src/platform/inherited-env.ts` | Drop `DISPATCH_BOX_TOKEN`, `OS_BOX_TOKEN`, `DISPATCH_AUTH`, `DISPATCH_AUTH_FILE` |
| `packages/core/src/overseer/agency-shared.ts`, `overseer/agency-mcp.ts` | Send the key on every call, `whoami` (project id from the daemon), readable errors, `force` on archive |
| `packages/core/src/endless/service.ts`, `endless/turn-runner.ts`, `endless/summarizer-claude.ts`, `endless/memory-mcp.ts`, `endless/log.ts` | Chat keys, `startedBy`, memory MCP sends the key, redaction before the Chat store |
| `packages/core/src/auth/shim.ts`, `packages/core/scripts/codex-notify.mjs`, `packages/core/scripts/grok-hook.mjs` | Send the key without argv, only to `DISPATCH_API` |
| `packages/core/package.json` | Export `./credential` for the CLI |
| `packages/cli/src/index.ts` | Owner token on HTTP calls, `dispatch api`, thread mode refusals, stage 1 counts in `status` |
| `scripts/key-delivery-probe.mjs`, `scripts/probe-fixtures/` (new) | The Codex check and the other harness delivery checks (Task 1) |
| `docs/network-access.md`, `README.md` | Thread keys and `dispatch api` |

## Interfaces that several tasks share

```ts
// auth/principals.ts
export type KeyKind = 'thread' | 'chat' | 'shell';
export const KEY_PREFIX: Record<KeyKind, 'dtk_' | 'dck_' | 'dsk_'>;
export type ChatStartedBy = 'user' | 'report' | 'summarizer';
declare const handleBrand: unique symbol;
export type KeyHandle = string & { readonly [handleBrand]: true };
export type KeyPrincipal =
  | { kind: 'thread'; terminalId: string; handle: KeyHandle }
  | { kind: 'shell'; terminalId: string; handle: KeyHandle }
  | { kind: 'chat'; startedBy: ChatStartedBy; handle: KeyHandle };
export type MintInput =
  | { kind: 'thread'; terminalId: string }
  | { kind: 'shell'; terminalId: string }
  | { kind: 'chat'; startedBy: ChatStartedBy };
export function keyKindOf(value: string): KeyKind | null; // exact prefix + 43 base64url chars, else null
export class KeyRegistry {
  mint(input: MintInput): { key: string; handle: KeyHandle }; // thread/shell: revokes the terminal's previous key
  resolve(key: string): KeyPrincipal | null;                   // unknown, revoked, malformed: null
  revoke(handle: KeyHandle): void;                             // idempotent
  liveHandleFor(terminalId: string): KeyHandle | undefined;
  size(): number;
}

// auth/request-principal.ts
export type Principal =
  | KeyPrincipal
  | { kind: 'owner'; via: 'cookie' | 'token' | 'box' }
  | { kind: 'none'; via: 'local' | 'tailscale' | 'test' };
export function principalOf(req: import('express').Request): Principal; // throws if the middleware did not run
export function bearerKey(authorization: string | undefined): string | null; // a value with a key prefix, else null

// auth/route-policy.ts
export type KeyErrorCode = 'owner_only' | 'field_not_allowed' | 'identity_mismatch' | 'out_of_scope'
  | 'depth_exceeded' | 'not_a_question' | 'rate_limited';
export type RuleResult = { ok: true } | { ok: false; status: 403 | 429; error: KeyErrorCode; message: string };
export type Rule = (req: import('express').Request, ctx: RuleCtx) => RuleResult;
export interface KeyRules { thread?: Rule; roleRun?: Rule; chat?: Rule; summarizer?: Rule; shell?: Rule }
export function keyRoute(rules: KeyRules): import('express').RequestHandler; // tagged
export const ownerOnly: import('express').RequestHandler;                    // tagged
export const publicRoute: import('express').RequestHandler;                  // tagged, any principal
export function policyRouter(opts?: import('express').RouterOptions): import('express').Router;
export const POLICY_TAG: unique symbol;

// auth/key-scope.ts
export interface CallerFacts {
  id: string; sessionId: string; type: string; role: string | null;
  depth: number;            // effective depth (legacy rules applied)
  spawnedBy: string | null; // null when it names no live thread in the same project
  origin: string | null; roleRun: boolean; archived: boolean;
}
export interface KeyScope {
  caller(terminalId: string): CallerFacts | null;
  target(terminalId: string): CallerFacts | null;
  isCoordinatorOfProject(caller: CallerFacts, sessionId: string): boolean;
  mayDirect(caller: CallerFacts, target: CallerFacts): boolean; // same project, not self, and worker of caller or caller is coordinator
}
export interface RuleCtx { principal: KeyPrincipal; caller: CallerFacts | null; scope: KeyScope }
export function effectiveSpawnDepth(config: Record<string, unknown>, spawnedByValid: boolean): number;

// sessions/thread-keys.ts
export class ThreadKeys {
  constructor(registry: KeyRegistry, opts?: { keyDir?: string; now?: () => number; codexReuseMs?: number });
  mintForSpawn(terminalId: string, kind: 'thread' | 'shell'): { key: string; handle: KeyHandle };
  bindPty(terminalId: string, pid: number, handle: KeyHandle): void;      // after ptyManager.spawn returns
  onPtyExit(terminalId: string, pid: number): void;                       // revokes only that pid's handle
  bindStructured(terminalId: string, handle: KeyHandle): void;            // after manager.spawn returns
  onStructuredExit(terminalId: string): void;                             // revokes the BOUND handle, then unbinds
  spawnFailed(handle: KeyHandle): void;
  revokeLive(terminalId: string): void;                                   // stop, archive, delete
  // Codex Pretty only (Task 12, used when Task 1 finds that a resume keeps the old MCP set)
  codexKilled(terminalId: string, key: string, handle: KeyHandle): void;  // hold for codexReuseMs, then revoke
  codexReusable(terminalId: string): { key: string; handle: KeyHandle } | null; // take it back on a quick resume
  // Key files (only for the delivery rows that Task 1 sends to a file)
  writeKeyFile(terminalId: string, key: string): string;                  // DATA/keys/ID, mode 0600; returns the path
}

// auth/credential.ts
export type Credential =
  | { mode: 'owner'; header: string }          // Authorization header value
  | { mode: 'thread'; header: string }         // dtk_ or dck_ key (or a dsk_ key for the shim only)
  | { mode: 'none' }                           // stage 1: send nothing
  | { mode: 'refuse'; reason: string };
export function resolveCredential(opts: {
  env: NodeJS.ProcessEnv; purpose: 'cli' | 'mcp' | 'shim'; readOwnerToken: () => string | null;
}): Credential;
export function keyAllowedFor(url: string, env: NodeJS.ProcessEnv): boolean; // url starts with DISPATCH_API
```

---

### Task 1: Delivery probes, including the Codex check (gate before any delivery code)

Spec 6.3 makes the Codex check a prerequisite. This task also settles the other open delivery questions: the Claude hook header, the Grok `.mcp.json` env reference, opencode under its shared service, and a Codex resume that may find the old MCP set still loaded.

**Files:** create `scripts/key-delivery-probe.mjs`, `scripts/probe-fixtures/probe-mcp.mjs`, `scripts/probe-fixtures/probe-notify.mjs`, `scripts/probe-fixtures/probe-shell.mjs`; create `docs/superpowers/plans/2026-10-23-per-thread-key-stage-1-probe-results.md`.

The production helpers do not send a key yet, so the probe uses fixtures that already do:
- `probe-mcp.mjs`: a minimal stdio MCP server with one tool `probe_call`. On each call it sends `GET FAKE/probe/mcp` with `Authorization: Bearer` from `DISPATCH_AUTH` (or from the file in `DISPATCH_AUTH_FILE`), and answers `ok`.
- `probe-notify.mjs`: the same shape as `codex-notify.mjs`, plus the header from its env (or the key-file path in its argv).
- `probe-shell.mjs`: run as a shell command by the agent; sends `GET FAKE/probe/shell` with the header from its env, so the fake daemon sees which canary the shell holds (a 4-character prefix would not show a swap between two threads).

- [ ] **Step 1: Write the probe.** Model it on `scripts/codex-release-probe.mjs` (it drives the real `CodexStructuredSessionManager` through `node --import tsx`). The probe:
  - Starts a fake daemon: a `node:http` server on a free port (not 3456) that records method, path and `Authorization` per request and answers `200 {}`.
  - Makes one canary key per thread: `dtk_` plus 43 random base64url characters, and writes each canary only into the places the spec table uses, never into argv.
  - Codex Pretty: two threads at once on one app-server. `threadConfig` holds `mcp_servers.dispatch` (the probe MCP) with literal `env.DISPATCH_AUTH` and `shell_environment_policy.set.DISPATCH_AUTH`. The app-server spawn env is `{}` (as in production). Prompt: "Call probe_call. Then run `node FIXTURES/probe-shell.mjs`. Then reply done."
  - Codex resume reuse: kill one Pretty thread through the manager (`kill`, which unsubscribes), and within 3 seconds spawn it again with resume and a NEW canary in its `threadConfig`; call `probe_call`; record which canary arrives (old, new, or none).
  - Codex app-server crash: `SIGKILL` the app-server once; after the resume, call `probe_call` and the shell fixture again in both threads.
  - Codex CLI: one PTY thread through `node-pty` with `-c mcp_servers.dispatch.env_vars=["DISPATCH_AUTH"]`, the probe MCP `command` and `args`, and `-c notify=["node","FIXTURES/probe-notify.mjs","FAKE/probe/notify"]`, with `DISPATCH_AUTH` only in the PTY env.
  - Claude CLI view: a `--settings` file with an HTTP `Stop` hook to `FAKE/probe/hook` with `headers: { Authorization: "Bearer ${DISPATCH_AUTH}" }` and `allowedEnvVars: ["DISPATCH_AUTH"]`, and an `--mcp-config` file whose probe server env holds `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`. Run `claude -p "Call the probe_call tool, then run node FIXTURES/probe-shell.mjs, then reply ok." --model haiku`.
  - Grok: a per-thread Grok home (as `providers/grok-home.ts` writes it) whose `plugins/dispatch/.mcp.json` holds the probe server with `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`. One run in each view.
  - opencode: two threads at once, each with its own `OPENCODE_CONFIG`; first with `environment.DISPATCH_AUTH = "{env:DISPATCH_AUTH}"`, then with the literal value.
  - Sign-in: every CLI uses the owner's real config home (`~/.codex`, `~/.claude`, `~/.grok`, the opencode home). Never copy a sign-in file (global constraint). The probe's own config files live in a fresh `mktemp -d` scratch folder.
  - Start the probe with a clean env (`env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" LANG="$LANG" PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin node ...`), so no live `DISPATCH_*` variable reaches it.
- [ ] **Step 2: Scan.** Record the start time `T0`. After the runs, search for each canary (`rg -a -l CANARY`):
  - in every file under `~/.codex` modified after `T0` (rollouts, logs, history, sqlite and its `-wal`), and under the scratch folder;
  - in the captured stdout and stderr of every process;
  - in `manager.getEvents(id)` of each Codex Pretty thread and in the raw JSON-RPC responses and notifications to `thread/start` and `thread/resume` (the manager's event ring feeds the structured socket and the conversation, so an echo there would reach peers).
  Record, per harness and view: did every MCP request carry that thread's canary; did each shell carry its own canary (no swap, no share); did `notify` and the hooks carry it; which canary the quick Codex resume used; where (if anywhere) a canary was written.
- [ ] **Step 3: Write the results file** with the table from step 2, the CLI versions (`claude`, `codex`, `grok`, `opencode`), and the outcome for each row below.
- [ ] **Step 4: Gate.** Pick the delivery for each row. If an outcome is not one of these, stop and report to the coordinator.

| Row | Outcome | Delivery used in Tasks 12 to 14 |
|---|---|---|
| Codex | canary in no file and no event | spec table (literal in thread config, `env_vars` in the CLI) |
| Codex | canary in a rollout, a log or an event | key file: `DISPATCH_AUTH_FILE` in the thread config and the shell policy, file `DATA/keys/ID` mode `0600` |
| Codex quick resume | new canary arrives | nothing extra |
| Codex quick resume | old canary arrives | the Codex reuse window of Task 12 |
| Codex `notify` | env inherited | `codex-notify.mjs` reads `DISPATCH_AUTH` |
| Codex `notify` | env not inherited | notify argv carries the key-file path (not secret); the helper reads the file |
| Codex shell | own canary arrives | `shell_environment_policy.set.DISPATCH_AUTH` |
| Codex shell | dropped | the shim in Codex threads uses the key file |
| Claude hook | header arrived | `headers` + `allowedEnvVars` |
| Claude hook | header empty or literal | the hook stays as today (no credential, counted); open question for stage 2 |
| Grok | reference resolved | `${DISPATCH_AUTH}` in `.mcp.json` |
| Grok | literal `${DISPATCH_AUTH}` arrived | literal key in the `0600` `.mcp.json`, deleted at revoke |
| opencode | reference resolved per thread | `{env:DISPATCH_AUTH}` |
| opencode | reference empty or cross-talk | literal key in the `0600` `opencode.json`, deleted at revoke |

- [ ] **Step 5: Commit** the probe, the fixtures and the results file: `test(keys): delivery probes and Codex check results`.

### Task 2: Key registry

**Files:** create `packages/core/src/auth/principals.ts`, `packages/core/src/auth/principals.test.ts`.

**Produces:** `KeyKind`, `KEY_PREFIX`, `KeyHandle`, `KeyPrincipal`, `MintInput`, `keyKindOf`, `KeyRegistry` (see the shared interfaces).

- [ ] **Step 1: Write the failing tests.**
  - `mint({kind:'thread', terminalId:'t1'})` returns a key that matches `/^dtk_[A-Za-z0-9_-]{43}$/`; `resolve(key)` returns `{kind:'thread', terminalId:'t1', handle}`.
  - Chat keys start `dck_` and carry `startedBy`; shell keys start `dsk_`.
  - A second `mint` for `t1` makes the first key resolve to `null`; `liveHandleFor('t1')` is the new handle.
  - `revoke(handle)` makes the key resolve to `null`; a second `revoke` does not throw; revoking an old handle does not touch the new key.
  - `resolve` returns `null` for an unknown key, `''`, `dtk_short`, a `dck_` value with a `dtk_` body swapped, and a 44-character body.
  - The registry holds hashes only: `util.inspect(registry, {depth: 5})` does not contain the key.
  - `keyKindOf` returns the kind for each prefix and `null` for `Bearer x`, the access token, and `dtk_` alone.
- [ ] **Step 2:** `cd packages/core && node node_modules/vitest/vitest.mjs run src/auth/principals.test.ts > /tmp/ptk-test.log 2>&1`; read the log. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Core of it:

```ts
import crypto from 'node:crypto';
const BODY = /^[A-Za-z0-9_-]{43}$/;
const hash = (k: string) => crypto.createHash('sha256').update(k).digest('hex');
export function keyKindOf(v: string): KeyKind | null {
  for (const kind of ['thread', 'chat', 'shell'] as const) {
    const p = KEY_PREFIX[kind];
    if (v.startsWith(p) && BODY.test(v.slice(p.length))) return kind;
  }
  return null;
}
export class KeyRegistry {
  private byHash = new Map<string, KeyPrincipal>();
  private hashByHandle = new Map<KeyHandle, string>();
  private liveByTerminal = new Map<string, KeyHandle>();
  mint(input: MintInput) {
    const key = KEY_PREFIX[input.kind] + crypto.randomBytes(32).toString('base64url');
    const handle = crypto.randomUUID() as KeyHandle;
    if (input.kind !== 'chat') {
      const old = this.liveByTerminal.get(input.terminalId);
      if (old) this.revoke(old);
      this.liveByTerminal.set(input.terminalId, handle);
    }
    const h = hash(key);
    this.byHash.set(h, { ...input, handle } as KeyPrincipal);
    this.hashByHandle.set(handle, h);
    return { key, handle };
  }
  // resolve: keyKindOf check, then byHash.get(hash(key)) ?? null
  // revoke: delete both maps, and liveByTerminal when it still points at this handle
}
```

- [ ] **Step 4:** Run the test again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(keys): in-memory key registry`.

### Task 3: Redaction helper

**Files:** create `packages/core/src/auth/redact-keys.ts`, `packages/core/src/auth/redact-keys.test.ts`.

**Produces:** `redactKeys(text: string): string` (each `dtk_`, `dck_`, `dsk_` value with a 43-character body becomes `dtk_[redacted]` and so on); `redactKeysDeep<T>(value: T): T` (walks arrays and plain objects, redacts every string, returns new objects, leaves other types).

- [ ] Tests first: a key inside a sentence, two keys on one line, a key at the end of a line, a key inside JSON text, a non-key `dtk_abc`, nested objects and arrays, `null` and numbers unchanged, the input object not mutated. Run, see FAIL, implement with one regex `/\b(dtk|dck|dsk)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g`, run, see PASS.
- [ ] Commit `feat(keys): redaction helper`.

### Task 4: Credential resolver, destination rule, and the CLI export

**Files:** create `packages/core/src/auth/credential.ts`, `packages/core/src/auth/credential.test.ts`; modify `packages/core/package.json` (exports `./credential` pointing at `dist/auth/credential.js` with types, as `./access` does).

**Produces:** `resolveCredential` and `keyAllowedFor` (shared interfaces).

`resolveCredential` rules, in this order (spec 6.7, with the stage 1 change marked):
1. `DISPATCH_AUTH` is a `dsk_` key: purpose `shim` gives `thread` with the shell key; purpose `cli` gives `owner` from `readOwnerToken()`; purpose `mcp` gives `refuse`.
2. `DISPATCH_AUTH` is a `dtk_` or `dck_` key: `thread` with `Bearer KEY`.
3. `DISPATCH_AUTH_FILE` is set: read the file (one line, trimmed); a valid `dtk_` or `dck_` key gives `thread`; an unreadable file or bad content gives `refuse` with "This thread has no Dispatch key".
4. A thread marker is present (`DISPATCH_TERMINAL_ID` or `DISPATCH_TERMINAL`) and no usable key: purpose `cli` gives `refuse` with "This thread has no Dispatch key"; purposes `mcp` and `shim` give `none` (**stage 1 only**: the helper sends no credential, as today, and the daemon counts it; it never uses the owner token). Stage 2 changes this to `refuse`.
5. No marker: purpose `cli` gives `owner` (or `none` when the token file is missing); purposes `mcp` and `shim` give `none`.

`keyAllowedFor(url, env)`: true only when `env.DISPATCH_API` is set and `url` starts with it (compare scheme, host, port and base path; a trailing slash on `DISPATCH_API` is ignored). Every caller that holds a `thread` credential checks it before it adds the header; when it is false, the caller sends the request with no credential (stage 1). The `.mjs` hook helpers cannot import TypeScript, so they repeat these 10 lines; a parity test runs both over the same table.

- [ ] Tests first, one per rule and purpose, plus: a `dtk_` key with `purpose: 'cli'` never calls `readOwnerToken` (a spy that throws); a malformed `DISPATCH_AUTH` with a marker gives `refuse` for `cli`; `DISPATCH_AUTH_FILE` pointing at a missing file gives `refuse` and never the owner token; `keyAllowedFor` is false with no `DISPATCH_API`, for another port, for another host, for a URL without the base path, and true for a path under it. Run, FAIL, implement, PASS.
- [ ] Commit `feat(keys): one credential resolver and destination rule`.

### Task 5: Principal middleware, gates, login, whoami, stage 1 counts

**Files:** create `packages/core/src/auth/request-principal.ts`, `packages/core/src/auth/no-credential-stats.ts`, tests `packages/core/src/auth/request-principal.test.ts`, `packages/core/src/auth/no-credential-stats.test.ts`; modify `packages/core/src/auth/access-gate.ts` (line 196: record `d.via` on the request with a symbol before `next()`; export `hasOwnerCredential(authorization, cookie, token)` from the existing `hasCredential` at 51-56), `packages/core/src/auth/box-token.ts`, `packages/core/src/server.ts`, tests `packages/core/tests/auth/access-integration.test.ts`, `packages/core/src/auth/box-token.test.ts`.

**Consumes:** `KeyRegistry` (Task 2). **Produces:** `createPrincipalMiddleware({ registry, scope, getToken, boxToken? })`, `principalOf`, `scopeOf(req): KeyScope`, `bearerKey`, `refuseKeyUpgrade(req): boolean`, `createNoCredentialStats({ log, now })` with `record(req)` and `snapshot()`, `createBoxGate({ boxToken, registry, getToken })`.

Middleware rules, in this order:
1. `bearerKey(Authorization)` is set: `registry.resolve`. `null` gives `401 auth_required` ("This Dispatch key is not valid any more. Start a new thread.") and a rate-limited refusal line (first per key hash, then one per minute with a count; never the key). A key principal on a path that does not start with `/api/`, or on `POST /api/access/login`, gives `403 owner_only`. Otherwise attach the key principal.
2. Else an owner credential (box header on a box, `Bearer` access token, the `dispatch_access` cookie): attach `owner`.
3. Else attach `none` with the gate's `via` (`local` or `tailscale`; `test` in `createApp`). For `via: 'local'`, call `stats.record(req)`.
A `Bearer` value that is neither a key nor the token is ignored (an older Claude CLI may send a literal `${DISPATCH_AUTH}`); the request is judged as if it had no `Authorization`.

Stats: category `browser` when `Sec-Fetch-Mode` is present, else `program`. Path pattern: replace each UUID-like or 20-plus-character id segment with `:id`. Log the first request of each (category, method, pattern) per start as `[keys] no-credential program GET /api/roles UA=...`; then at most one summary line per hour. `snapshot()` returns `{ since, browser: { total, top: [{pattern, count}] }, program: {...} }`.

Box gate (spec 6.8): admit a valid box header, a `Bearer` access token, or a live key; refuse everything else with today's `401 unauthorized`. Upgrades on a box still accept only the box header. In `server.ts` create the token file in both modes (`ensureAccessToken(dataDir)` before the `BOX_TOKEN ?` branch at 478).

Server wiring (production order in `startServer`): security headers (472), base-path strip (473), box gate or access gate, **principal middleware**, then `app.post('/api/access/login', ...)` (moved from 488 to after the principal middleware; it still runs before the gate's credential rule as today, because the gate already lets the login path through), then `express.json` and the routes. The login rule: a key-bearing login request gets `403 owner_only`; a revoked key `401`; a credential-free login behaves as in v3.4.1.
- One `KeyRegistry` per daemon. `createApp`: mount the principal middleware before `express.json` (338) with `via: 'test'` for credential-free requests; add `keys?: KeyRegistry` to `CreateAppOptions` (236-246) and expose it as `app.locals.keys` for tests.
- `GET /api/whoami` (`publicRoute`): a thread key returns `{ kind, terminalId, sessionId, role, depth, spawnedBy, roleRun }` from `KeyScope`; a Chat key `{ kind, startedBy }`; a shell key `{ kind, terminalId }`; owner and none `{ kind }`.
- `GET /api/access/no-credential-stats` (owner only): `stats.snapshot()`.
- `handleUpgrade` (784-843): after the existing gates, `if (refuseKeyUpgrade(request))` write `HTTP/1.1 403 Forbidden` and destroy the socket.

- [ ] Tests first (unit, with a stub registry and a peer override as in `access-gate-http.test.ts:15-31`):
  - a live thread key attaches the thread principal; a revoked key gives `401 auth_required`; a key plus a valid cookie is judged as the key; a key plus the access token is judged as the key; a key on `/` (a page) gives `403 owner_only`;
  - the access token attaches `owner`; no credential from loopback attaches `none` with `via: 'local'` and is counted; a `Bearer ${DISPATCH_AUTH}` literal is ignored and counted as `none`;
  - login: a live key with a correct token in the body gets `403` and no `Set-Cookie`; a revoked key gets `401`; a credential-free login with the right token still sets the cookie;
  - refusal log: 20 calls with one revoked key give one log line, then a count line after `now` moves 61 seconds;
  - stats: `Sec-Fetch-Mode` request counts as `browser`, none as `program`; ten requests to `/api/terminals/UUID` give one pattern and one log line; the hourly summary appears after `now` moves 61 minutes;
  - box gate: box header passes as `owner`; access token passes as `owner`; a live key passes as the key; revoked key `401`; no credential `401`; key plus box header is judged as the key; the token file exists in box mode;
  - integration (`access-integration.test.ts`, real `startServer` listen on a temp HOME, as it does today): a WebSocket with a key header to the terminal socket, the structured socket and `/api/events` gets `403`; `GET /api/whoami` with a minted key returns the terminal id; no credential from `127.0.0.1` still gets `200` on `/api/sessions`; the login order: a key-bearing `POST /api/access/login` gets `403`.
- [ ] Run each file (`node node_modules/vitest/vitest.mjs run src/auth/request-principal.test.ts`, then the others), see FAIL, implement, see PASS.
- [ ] Commit `feat(keys): principal middleware, box gate, login order, whoami, stage 1 counts`.

### Task 6: One route list, the policy wrapper and the completeness test

**Files:** create `packages/core/src/server-routes.ts`, `packages/core/src/auth/route-policy.ts`, `packages/core/tests/auth/route-policy-completeness.test.ts`, `packages/core/src/auth/route-policy.test.ts`; modify every router file under `packages/core/src/routes/` (26 files: replace `Router()` with `policyRouter()`, keep options such as `mergeParams` in `files` and `git`), and `server.ts`.

**Produces:** `mountApiRoutes(app, deps)`; `policyRouter`, `keyRoute`, `ownerOnly`, `publicRoute`, `POLICY_TAG`, `refuse(res, result)`, `KeyRules`, `Rule`, `RuleResult`.

- `mountApiRoutes(app, deps)` holds the one list of `/api` mounts (`server.ts:383-407` and `729-756`), including `/api/endless`, `/api/whoami` and the stats route. `createApp` and `startServer` both call it. `createApp` gains `endless?: EndlessService` (a stub in tests); without it the endless router answers `503` as today before the service is ready.
- `server.ts` routes outside `/api` (`/icons/:name` at 420 and 772, the SPA fallback at 422 and 774) get `publicRoute`; the login route gets its own tagged handler (Task 5).
- `policyRouter()` returns an Express `Router` whose `get`, `post`, `put`, `patch`, `delete` and `all` prepend `ownerOnly` when the first handler has no `POLICY_TAG`. `router.use` middleware is not a route and is not touched.
- `ownerOnly`: `owner` and `none` pass; any key gets `403 owner_only` with "This action is for the owner only. Ask the owner to do it in the browser."
- `keyRoute(rules)`: `owner` and `none` pass untouched. A key picks its rule: a thread key with `CallerFacts.roleRun` uses `rules.roleRun` (no fallback to `rules.thread`); a Chat key with `startedBy: 'summarizer'` uses `rules.summarizer`; a missing rule gives `owner_only`. A thread or shell key whose caller row is missing or archived gives `401 auth_required`. A failed rule calls `refuse`, which logs one rate-limited line (principal kind, terminal id, method, route path, error; never the key) and sends `{ error, message }`.
- Normalize the peer address (`::ffff:127.0.0.1` to `127.0.0.1`) before any address rule (spec 6.4). The existing `isLoopbackAddress` already does this; add a test that proves it.

- [ ] Tests first:
  - `route-policy.test.ts`: a plain route on `policyRouter()` refuses a thread key with `owner_only` and serves owner and none; a `keyRoute({thread})` route runs the rule and serves the key; a role-run caller on a route with only `thread` gets `owner_only`; the refusal log line has no key in it.
  - `route-policy-completeness.test.ts`: build the full app (`createApp({ db, skipPty: true, endless: stub })`), walk `app._router.stack` recursively (`layer.route` for routes, `layer.handle.stack` for mounted routers), and fail when a route's first handler has no `POLICY_TAG`. A second test lists every route whose first handler is a `keyRoute`, as `METHOD /full/path`, and compares it with an inline expected list (the allowlist of Tasks 8 to 11). A third test asserts that `createApp` and `startServer` use the same mount list (both import `mountApiRoutes`; `access-integration.test.ts` covers the production-only order of the gate, principal middleware and login).
- [ ] Run, see FAIL (the completeness test fails on every plain route), move the mounts, switch all routers, see PASS. Run the existing route tests that touch the switched files (`tests/routes/*.test.ts`, `src/routes/*.test.ts`) one file at a time; expected: PASS with no change, because owner and none pass every route.
- [ ] Commit `feat(keys): one route list and default-deny route policy`.

### Task 7: Key scope and legacy records

**Files:** create `packages/core/src/auth/key-scope.ts`, `packages/core/src/auth/key-scope.test.ts`; modify `packages/core/src/sessions/service.ts` (`createTerminal` 506, `createQueuedTerminal` 569, `createRunnerTerminal` 638, `ensureCoordinator` 2057-2069: when `config.spawnedBy` is absent and `config.spawnDepth` is not a number, write `spawnDepth: 0`; `agencyServerSpec` callers at 2237 and 2414 pass the effective depth).

**Produces:** `createKeyScope(db): KeyScope`, `effectiveSpawnDepth`, `CallerFacts` (shared interfaces).

Legacy rules (spec 6.1):
- `spawnDepth` missing and no `spawnedBy`: 0.
- `spawnDepth` missing with `spawnedBy`, not an integer, or outside 0 to 3: 3.
- `spawnedBy` that names no thread in the same project: `null`.
- `role` and `origin` as stored. `roleRun` is `true` when `config.roleRun` is set.
- Every fact is read at request time, so a move to another project changes the scope at once.

- [ ] Tests first (in-memory database, `initSchema`, rows through `terminalsDb.create`): depth 7 and `"x"` count as 3; a `spawnedBy` in another project counts as `null`; a coordinator made by today's `ensureCoordinator` shape (no depth, no parent) counts as 0; a worker with `spawnedBy` and no depth counts as 3; new root threads from `createTerminal` and `ensureCoordinator` have `spawnDepth: 0` stored; `mayDirect` is true for the caller's own worker and for the project coordinator, false for self, a peer's worker, and a worker that the owner moved to another project.
- [ ] Run, FAIL, implement, PASS. Then run `tests/sessions/agency-mcp-injection.test.ts` and `tests/overseer/*.test.ts` that read `spawnDepth`; expected PASS.
- [ ] Commit `feat(keys): caller scope from the database, legacy record rules`.

### Task 8: Thread key rules on the terminal and session routes

**Files:** create `packages/core/src/auth/key-rules.ts`, `packages/core/tests/routes/terminals-keys.test.ts`; modify `packages/core/src/routes/terminals.ts` (create 28, list 72, get 82, conversation 104, message 137, permission 158 and 169, report-status 250, start 337, delete 480), `packages/core/src/routes/sessions.ts` (worker-defaults 107), `packages/core/src/sessions/service.ts` (`answerPermission` 1724-1766 and `logQuestionCardAnswer` 1802-1813 take `logAs: 'user' | 'coordinator'`, default `user`).

**Consumes:** Tasks 5 to 7. **Produces:** in `key-rules.ts`: `createBodyRule`, `messageRule`, `directRule` (start and archive), `answerRule`, `selfRule` (report-status), `sameProjectRead`, and one daemon-wide `PairRateLimiter` from `overseer/guards.ts` with a spawn credit.

Rules (spec 6.4, with the plan decisions above):
- `POST /api/sessions/:id/terminals`: `:id` is the caller's project. The body allows only `type` (`claude-code`, `codex`, `grok`, `opencode`), `label`, `queued`, `task`, `config.transport` (`structured` only), `config.agentType`, `config.mission`, `config.model`, `config.dependsOn` (each id a thread in the same project), and `config.role`, `config.spawnDepth`, `config.spawnedBy`, `config.origin` only when they equal what the daemon writes (`agent`, caller depth + 1, caller id, absent). Any other field gives `403 field_not_allowed` naming the field. A different value of the four gives `403 identity_mismatch`. `checkSpawnDepth(caller.depth)` fails with `403 depth_exceeded`. Then the rule writes the four fields into `req.body.config` and the existing handler runs. On `201` the rule grants a spawn credit for (caller, new id): today `sendTask` after `spawn_agent` is not counted by the client limiter (`agency-shared.ts:106-108`), so the daemon must not count that first task message either.
- `GET /api/sessions/:id/terminals`, `GET /api/sessions/:id/overseer/worker-defaults`: `:id` is the caller's project.
- `GET /api/terminals/:terminalId`, `GET .../conversation`, `GET .../permission`: target in the caller's project.
- `POST .../message`: target in the caller's project, not the caller, not a shell tab; body fields only `text`, `content`, `source`; `source` absent or `coordinator`, else `403 identity_mismatch`; the rule sets `source: 'coordinator'`; then the pair limiter (`429 rate_limited`, keyed by caller id and target id; a spawn credit is used first).
- `POST .../start` and `DELETE /api/terminals/:terminalId`: `mayDirect`. For `DELETE`, also `checkArchiveAllowed(target, req.query.force === '1')`.
- `POST .../permission`: `mayDirect`; body only `decision` (`allow`), `answers`, `requestId`; the pending request must have `questions` (`403 not_a_question`) and `requestId` must equal its id (`403 identity_mismatch`); the rule sets `res.locals.answerLogAs = 'coordinator'`, and the handler passes it to `answerPermission`.
- `POST .../report-status`: `:terminalId` is the caller.

- [ ] Tests first (`terminals-keys.test.ts`, `createApp` plus `app.locals.keys.mint(...)`, rows seeded with `terminalsDb.create`):
  - create: one refusal per field: `type: shell`, `type: file`, `type: browser`, `type: notes`, `externalId`, `workingDir`, `skipPermissions`, `config.signIn`, `config.branchFrom`, `config.runner`, `config.runnerPrompt`, `config.roleRun`, `config.roleAuthority`, `config.autonomy`, `config.transport: 'pty'`, `config.dependsOn` with an id in another project; `config.role: 'coordinator'` and `config.spawnDepth: 0` give `identity_mismatch`; a depth 3 caller gets `depth_exceeded`; the exact body that `buildWorkerCreateBody` makes today (queued and not queued) gets `201` and the stored row has role `agent`, depth caller + 1, `spawnedBy` the caller; another project gives `out_of_scope`;
  - the chain: a thread cannot create a shell tab, so it cannot get a `dsk_` key and cannot reach owner mode in the CLI;
  - message: `source: 'user'` gives `403 identity_mismatch` and `noteUserPrompt` is not called; self, a shell tab and another project give `out_of_scope`; after a spawn, the task message plus 10 more messages pass and the 12th gives `429`; with no spawn, the 11th gives `429`; `canned` gives `field_not_allowed`; the owner with `source: 'user'` still works;
  - start, archive, answer: refused on self, on a peer's worker, on another project, on a worker that the owner moved away; allowed for the caller's worker and for the project coordinator; archive of a plain thread needs `?force=1`;
  - answer: refused for a held tool call, a missing or stale `requestId`, a `reply`, `canned`, `message` or `deny` body; an allowed answer is logged with source `coordinator` (read the coordinator message log), never `user`;
  - report-status for another id gives `out_of_scope`.
- [ ] Run, FAIL, implement, PASS. Then run `tests/routes/terminals.test.ts` (owner paths unchanged). Expected PASS.
- [ ] Commit `feat(keys): thread key rules for terminal routes`.

### Task 9: Watches, ledger, events and auth-request rules

**Files:** modify `packages/core/src/routes/watches.ts`, `packages/core/src/routes/ledger.ts`, `packages/core/src/routes/events.ts`, `packages/core/src/routes/auth.ts`, `packages/core/src/auth/key-rules.ts`; create `packages/core/tests/routes/keys-misc.test.ts`.

Rules:
- `POST /api/watches`: `watcherTerminalId` absent or the caller (else `identity_mismatch`), then set to the caller; target in the caller's project.
- `GET /api/watches`: the `watcher` and `target` query values, when present, are the caller (else `identity_mismatch`); absent values are set to the caller.
- `DELETE /api/watches/:id`: `watcher` query absent or the caller, then set; the existing ownership check runs.
- All 12 ledger `POST` routes (`ledger.ts:28-42`): `:id` (the project) is the caller's project; body `caller` absent or the caller, then set to the caller; the existing `assertOverseer` then runs on the real caller. The two ledger `GET` routes (`card`, `source`) stay owner only.
- `POST /api/events/:provider/:terminalId`: `:terminalId` is the caller and `:provider` matches its type (`claude` for `claude-code`, `codex`, `grok`). A mismatch gives `out_of_scope`. (The route still answers `204` for owner and none.)
- `POST /api/auth-requests` (`auth.ts:11`): thread and shell keys: body `terminalId` absent or the caller, then set; Chat keys: body `terminalId` must be absent.

- [ ] Tests first: each rule allowed and refused; a worker key calling `ledger_add` with `caller` set to the coordinator id gives `identity_mismatch`; the coordinator key with no `caller` passes `assertOverseer`; a shell key on any route but auth-requests gives `owner_only`; a forged `watcherTerminalId` gives `identity_mismatch`.
- [ ] Run, FAIL, implement, PASS. Run `tests/routes/watches.test.ts` and the ledger route tests. Expected PASS.
- [ ] Commit `feat(keys): watches, ledger, events and auth-request rules`.

### Task 10: Chat key rules

**Files:** modify `packages/core/src/routes/endless.ts`, `packages/core/src/routes/terminals.ts`, `packages/core/src/routes/sessions.ts`, `packages/core/src/auth/key-rules.ts`; create `packages/core/tests/routes/endless-keys.test.ts`.

Rules (spec 6.4, Chat table): `GET /api/endless/zoom`, `/date`, `/threads`, `/project`: allowed. `GET /api/terminals/:id` and `/conversation`: any project. `GET .../worker-defaults`: any project. `POST /api/sessions/:id/terminals`: any project, the create body allowlist, and the daemon writes `origin: endless`, `spawnDepth: 1`, `role: agent`, no `spawnedBy` (the memory MCP's body today sends exactly these, so it passes). `POST /api/endless/arm`, `/disarm`, `POST .../message`, `DELETE /api/terminals/:id`: target has `origin: endless`; message source `coordinator`. `POST /api/endless/ledger/:action`: allowed with today's service rules. `POST /api/auth-requests`: allowed. A `summarizer` key gets only the `GET` rows. Every other route, for example `POST /api/endless/send`, `PUT /api/endless/instructions`, stays owner only.

- [ ] Tests first (with the stub `EndlessService` from Task 6): a Chat spawn in another project gets `201` with the four fields written; a Chat message to a non-endless thread gives `out_of_scope`; a summarizer key on `POST /api/sessions/:id/terminals` gives `owner_only`; a Chat key on `POST /api/endless/send` gives `owner_only`; `startedBy: 'report'` behaves as `user` in stage 1.
- [ ] Run, FAIL, implement, PASS. Run `tests/routes/endless.test.ts`. Expected PASS.
- [ ] Commit `feat(keys): Chat key rules`.

### Task 11: Role-run keys

**Files:** modify `packages/core/src/auth/key-rules.ts` and the route files of Tasks 8 and 9 (add `roleRun` rules); create `packages/core/tests/routes/role-run-keys.test.ts`.

A role-run key (a thread key whose row has `config.roleRun`) gets: `whoami`, the `GET` rows of Task 8, `report-status`, `events`, `auth-requests`, and (plan addition, see "spec drift" item 5) `POST /api/watches`, `GET /api/watches`, `DELETE /api/watches/:id`, with the same rules as a thread key.

- [ ] Tests first: a role-run key gets `owner_only` on create, message, start, archive and answer; it gets `2xx` on the requests behind `list_threads`, `read_thread`, `list_agents`, `read_agent`, `list_missions`, `report_status`, `watch_thread`, `unwatch_thread` and `list_watches` (the whole `ROLE_DISPATCH_TOOLS_ALLOWED` set).
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): narrow role-run keys`.

### Task 12: Key lifecycle per process

**Files:** create `packages/core/src/sessions/thread-keys.ts`, `packages/core/src/sessions/thread-keys.test.ts`, `packages/core/tests/sessions/key-lifecycle.test.ts`; modify `packages/core/src/pty/manager.ts` (line 57: `this.emit('exit', sessionId, exitCode, proc.pid)`), `packages/core/src/sessions/service.ts` (`spawnTerminal` 2186, `spawnStructured` 2399, `stopTerminal` 1047, `stopAllTerminals` 2136, `removeTerminal` 2147, `archive` 477, `stop` 462; a `setKeyRegistry(registry)` setter like `setDaemonPort`), `packages/core/src/server.ts` (create the registry, call `sessionService.setKeyRegistry`, and forward `ptyManager` `exit` (703) and each structured manager's `exit` to `ThreadKeys`).

**Consumes:** `KeyRegistry`. **Produces:** `ThreadKeys` (shared interfaces). Keys are never read back from the registry.

Rules (spec 6.2, 6.5):
- Mint right before the process starts, in `spawnTerminal` (agent types: `thread`; `shell`: `shell`, also for a sign-in shell) and `spawnStructured` (`thread`). This covers create, start of a queued agent, runner, branch, relaunch, restart, restore, transport switch, `ensureStructuredAlive`, and the coordinator kickstart, because they all spawn through these two functions. The project-level legacy relaunch (`service.ts:440-456`) spawns a plain CLI with no MCP and no env; it gets no key (drift item 15) and a test pins that it is unchanged.
- PTY: `bindPty(terminalId, pid, handle)` with the pid that `ptyManager.spawn` returns; `onPtyExit(id, pid)` revokes only that pid's handle. A relaunch whose old PTY exits after the new spawn keeps the new key.
- Structured: bind **after** `manager.spawn` returns. `onStructuredExit(id)` revokes the handle that is bound at that moment, then unbinds. The managers emit `exit` only for the current session, and `structured/manager.ts:303` kills a draining session inside `spawn()`, before the new binding exists; that `exit` therefore revokes the old handle, never the new one.
- Codex Pretty: `kill` emits `exit` and then unsubscribes (`codex-manager.ts:735-746`), so the structured rule covers unsubscribe. The `failed` event never revokes. Codex keeps `env: {}` at spawn; the key goes only into `threadConfig` (Task 13b).
- **Codex reuse window** (only when Task 1 found that a quick resume keeps the old MCP set): on a Codex Pretty `exit`, call `codexKilled(id, key, handle)` instead of revoking: the key stays valid for `codexReuseMs` (the app-server's `thread_unload_delay_secs`, 10 s, plus 5 s), then it is revoked. A `spawnStructured` for the same Codex thread within the window, on the same live app-server, calls `codexReusable(id)` and puts that same key in the new `threadConfig` instead of minting. The literal lives in daemon memory only for the window. An archive, delete or stop revokes it at once.
- Spawn failure (exception or no pid): `spawnFailed(handle)`.
- Stop, stop-all, archive, delete and project archive or stop: `revokeLive(id)` before the kill.
- Key files (only for the rows that Task 1 sends to a file): `writeKeyFile` writes `DATA/keys/ID` with mode `0600` inside the `0700` data directory; revoke deletes that one file (`lstat` first; refuse a symlink).
- A queued agent has no key until `start` spawns it.

- [ ] Tests first:
  - `thread-keys.test.ts` (pure, fake clock): PTY late exit keeps the new key; structured exit revokes the bound handle; an exit during `spawn()` (before the new bind) revokes only the old handle; `spawnFailed` revokes; `revokeLive` revokes only the current key; the Codex window keeps the key for 15 s, a reuse in the window returns the same key and handle, a reuse after the window returns `null`, an archive in the window revokes at once; a key file has mode `0600` and is deleted at revoke; a symlink at the key-file path is not followed (nested sandbox with a canary target).
  - `key-lifecycle.test.ts` (a `CapturingPty` and capturing structured managers as in `tests/sessions/terminal-id-env.test.ts:15-38`, plus one real `StructuredSessionManager` with a fake CLI that stays in the drain state): each spawn path above mints a new key and the previous key resolves to `null`; a draining Claude session followed at once by `ensureStructuredAlive` leaves the new key valid; `removeTerminal` and `stopTerminal` revoke; a Codex `failed` event leaves the key live; the legacy project relaunch spawns with no `DISPATCH_AUTH`; a daemon restart (a new `KeyRegistry`) resolves no old key.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): mint at spawn, revoke by handle`.

### Task 13: Delivery into the thread processes

Four commits. Every step keeps the key out of argv, out of the shared default env, and out of the Codex app-server env.

**13a: Environment, `DISPATCH_API`, base path, inherited env.** Files:
- `packages/core/src/sessions/service.ts`: the PTY `spawnEnv` at 2278 gets `DISPATCH_AUTH`; the structured `env` at 2630 gets `DISPATCH_AUTH` for every harness **except Codex, which keeps `env: {}`** (drift item 12); `agencyServerSpec` 2863-2876 adds `DISPATCH_API`; the key itself is not in the spec `env` (13b adds the reference).
- `packages/core/src/server.ts`: `DISPATCH_API` = `http://127.0.0.1:PORT` plus `BASE_PATH`, from the bound port. It is not a secret, so it goes into the shared default env in `refreshPtyEnv` (629-661) after the port is bound (878), beside `DISPATCH_SERVER_URL`. Thread shells, the shim and `dispatch api` inside a thread then see it; the Codex app-server inherits it, and its default shell policy keeps it (no KEY, TOKEN or SECRET in the name). `DISPATCH_SERVER_URL` (451-454) and the hook `serverUrl` (891-896) also get `BASE_PATH`, so hooks and the shim reach a box daemon with a base path (empty on a local daemon, so no change there).
- `packages/core/src/platform/inherited-env.ts`: drop `DISPATCH_BOX_TOKEN`, `OS_BOX_TOKEN`, `DISPATCH_AUTH`, `DISPATCH_AUTH_FILE`.
- Tests: `packages/core/tests/sessions/terminal-id-env.test.ts` (lines 59 and 76 use exact `toEqual`; change them to check `DISPATCH_TERMINAL_ID` and a `dtk_` `DISPATCH_AUTH`, and that a Codex Pretty spawn env is exactly `{}`), `packages/core/tests/platform/inherited-env.test.ts`, a new case that the Codex app-server spawn env (the `connSpec.env` that `ensureConnection` builds) holds no `dtk_` value and no `DISPATCH_AUTH_FILE`.

**13b: MCP injection.** Files: `packages/core/src/mcp/injection.ts` (a spec can set `authEnv: true`; then the Claude-style file gets `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`; the Codex CLI args get the literal `env.NAME` flags for the non-secret values and `env_vars=["DISPATCH_AUTH"]` for the same server; `codexThreadConfig` gets the literal key only when the caller passes `codexAuthLiteral`, and never `env_vars` for this server), `packages/core/src/sessions/service.ts` (structured Codex: pass `codexAuthLiteral` and add `shell_environment_policy.set.DISPATCH_AUTH` beside `DISPATCH_TERMINAL_ID` at 2628), tests `packages/core/src/mcp/injection.test.ts` (74-78 pin `codexThreadConfig`), `packages/core/tests/sessions/agency-mcp-injection.test.ts`, `packages/core/tests/sessions/injection-wiring.test.ts`.
- **Codex key-file fallback** (only when Task 1 chose it): `threadConfig` gets `mcp_servers.dispatch.env.DISPATCH_AUTH_FILE` and `shell_environment_policy.set.DISPATCH_AUTH_FILE` (the path, not secret) from `ThreadKeys.writeKeyFile`; the Codex CLI view puts `DISPATCH_AUTH_FILE` in the PTY env and `env_vars=["DISPATCH_AUTH_FILE"]`; the agency MCP and the shim read the file through `resolveCredential` (rule 3); the file is deleted at revoke; after a daemon restart the new spawn writes a new file and the old one is swept (13d).

**13c: Hooks.** Files: `packages/core/src/providers/claude-code.ts` (134-154: add `headers: { Authorization: 'Bearer ${DISPATCH_AUTH}' }` and `allowedEnvVars: ['DISPATCH_AUTH']` when Task 1 confirmed them), `packages/core/src/sessions/service.ts` (370-373: write `hooks/ID.json` with mode `0600`), `packages/core/scripts/codex-notify.mjs`, `packages/core/scripts/grok-hook.mjs` (send `Authorization: Bearer` only when the key is a `dtk_` value from `DISPATCH_AUTH`, or from `DISPATCH_AUTH_FILE`, and the target URL passes the copied `keyAllowedFor`; otherwise no header), `packages/core/src/providers/codex.ts` (59-66: in the notify fallback, the notify argv carries the key-file path), `packages/core/src/providers/grok-home.ts` (133: `hooks.json` mode `0600`). Tests: `packages/core/tests/providers/providers.test.ts`, `packages/core/tests/routes/events.test.ts` (the existing hook tests), `packages/core/tests/scripts/hook-helpers.test.ts` (new: run each script with `node` against a local `http` server, with and without `DISPATCH_AUTH`, with `DISPATCH_API` unset and pointing at another port; assert the header only in the matching case, and that argv holds no key), and the parity test of Task 4.

**13d: Grok, opencode, sweep.** Files: `packages/core/src/providers/grok-home.ts` (119-124), `packages/core/src/providers/opencode-config.ts` (58, 72, 79: `0600` for `opencode.json` and `rules.md`; `environment.DISPATCH_AUTH` as Task 1 chose), `packages/core/src/sessions/mcp-config-sweep.ts`, tests `packages/core/tests/providers/opencode.test.ts` (28-37), `packages/core/tests/providers/grok-home.test.ts`, `packages/core/tests/sessions/mcp-config-sweep.test.ts`.
- The sweep extension deletes **named files only**, never a folder: `grok-homes/ID/plugins/dispatch/.mcp.json`, `grok-homes/ID/hooks/hooks.json`, `opencode-homes/ID/opencode.json`, `keys/ID`, for threads that are not alive and with the existing one-minute age rule. It uses `lstat`, refuses a symlink, and never recurses: everything else in a Grok home is a symlink into the real `~/.grok` (`grok-home.ts:61-84,113-114`). The test puts a symlink to a canary folder in a fake Grok home and asserts that the canary survives.
- When a literal key is in a file, `ThreadKeys` deletes that one file at revoke (same `lstat` rule).

- [ ] For each part: tests first. Per harness and view (claude-code CLI and Pretty, codex CLI and Pretty, grok CLI and Pretty, opencode, Claude and Codex runners, role runs): the spawn env holds a key of the right kind (Codex Pretty: none, the thread config holds it); the shared default env holds none; the MCP config holds a reference where the harness supports one. **No key in argv:** every test in `key-lifecycle.test.ts`, `agency-mcp-injection.test.ts` and `injection-wiring.test.ts` scans the captured `command` and `args` of every spawn for `dtk_`, `dck_` and `dsk_`. Codex Pretty: `thread/start` and `thread/resume` carry the key as a literal (the fake Codex in `tests/routes/structured.test.ts:1300-1327` records them); the app-server argv and env do not. Codex CLI: argv has `env_vars=["DISPATCH_AUTH"]` and the literal non-secret values, and no key. Files holding a key have mode `0600`.
- [ ] Run each touched test file, FAIL, implement, PASS. Commit after each part: `feat(keys): deliver keys through env (13a)`, `(13b)`, `(13c)`, `(13d)`.

### Task 14: First-party helpers send the key

**Files:** modify `packages/core/src/overseer/agency-shared.ts` (`httpJson` 65-79 adds the header from `resolveCredential({ purpose: 'mcp' })` when `keyAllowedFor(url)`), `packages/core/src/overseer/agency-mcp.ts`, `packages/core/src/endless/memory-mcp.ts` (`apiBase` 16-18 and `requestJson` 188-199 send the header under the same rule), `packages/core/src/auth/shim.ts` (`relayCommand` 112-119 runs `node DIST/auth/shim-relay.js URL SOURCE` instead of `curl`), create `packages/core/src/auth/shim-relay.ts` (posts to `DISPATCH_API` when set, else `DISPATCH_SERVER_URL`, with the header only when `keyAllowedFor` holds).

`agency-mcp.ts` changes:
- `apiBase` 45-47 uses `DISPATCH_API`; when it is unset it falls back to `DISPATCH_PORT` as today and sends no key.
- `watchesRequest` 912-928 and `ledgerRequest` 985-993 use the same header rule.
- A lazy `whoami` on the first tool call. Project paths (`669`, `689`, `834`, `986`) use `whoami().sessionId`, not `DISPATCH_SESSION`, so a thread that the owner moves keeps its tools; after an `out_of_scope` answer the cache is dropped and `whoami` runs again once. When `whoami` fails (stage 1, no key), the env ids are the fallback.
- `complete_agent` sends `?force=1` when `force` is true.
- Error text: `owner_only` becomes "Error: only the owner can do this. Ask the owner to do it in the browser."; `auth_required` becomes "Error: this thread's Dispatch key is not valid. Ask the owner to relaunch the thread."; other key errors show the daemon's `message`; `assertInProject` 827-838 shows a `401` or `403` as itself, not as "not in this project".

- [ ] Tests first: `tests/overseer/agency-mcp.test.ts` and `agency-mcp-ledger.test.ts` (they mock `global.fetch`): every request carries `Authorization: Bearer dtk_...` when `DISPATCH_AUTH` and `DISPATCH_API` are set, and none when either is not; a URL outside `DISPATCH_API` gets no header; a moved thread's `list_threads` uses the `whoami` project; the `owner_only` error text; `complete_agent` with `force`. `tests/endless/memory-mcp.test.ts`: the header on every route. `tests/auth/shim.test.ts` (27, 86-123): the shim script holds no `curl`; running the relay against a local server sends the header from `DISPATCH_AUTH` and the `terminalId`; the URL to open is the only argument; with no `DISPATCH_AUTH`, or with `DISPATCH_API` pointing elsewhere, it sends no header.
- [ ] Run each file, FAIL, implement, PASS. Commit `feat(keys): MCP helpers and the shim send the key`.

### Task 15: Chat keys

**Files:** modify `packages/core/src/endless/turn-runner.ts` (spawn 192-197: mint `chat` with `startedBy` `user` for a typed message and `report` for a delivered report, put `DISPATCH_AUTH` in the spawn env beside `FIXED_CONTEXT_ENV`, revoke on the turn process exit), `packages/core/src/endless/summarizer-claude.ts` (74-80: `startedBy: 'summarizer'`, revoke on exit), `packages/core/src/endless/service.ts` (160: `memory.mcp.json` env gets `"DISPATCH_AUTH": "${DISPATCH_AUTH}"` (the turn env carries `DISPATCH_API` through the default env), mode `0600`; the file stays shared and holds no secret); tests `packages/core/tests/endless/*.test.ts` that cover the turn runner and the summarizer, `packages/core/tests/routes/endless.test.ts` (59-60 assert the file env).

- [ ] Tests first: a turn spawn env has a `dck_` key and `startedBy` `user`; a report turn has `report`; the summarizer key is `summarizer`; the key is revoked when the turn exits; the memory file has no key and mode `0600`; argv has no key.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): Chat turn and summarizer keys`.

### Task 16: Redaction at every write point and read path

Thread text can hold its own key (an agent that ran `env`). The daemon must not store a key, and must not pass one to another thread or to Chat.

**Files:** modify
- `packages/core/src/endless/log.ts` (`appendLogged` 15-29: `redactKeys` on `input.text` before `store.append`, so assistant text, tool calls and tool results of Chat turns that reach the store through `turn-runner.ts:331-339` and `endless/service.ts:380` never hold a key);
- `packages/core/src/sessions/service.ts`: `noteTurnOutcome` 1588-1609 (`lastOutcome.summary` and `blocker`), `reportStatus` 1856 (summary, ask, blocker before they are stored), `logCoordinatorMessage` (before the insert), `lastAssistantText` 1370-1380, `formatAgentQuestion` 1239-1259, `noteAgentNeedsHelp` 1542-1555;
- `packages/core/src/routes/terminals.ts`: conversation 104 and search 116 (`redactKeysDeep` on the response; the transcript comes from the harness's own files, which the daemon does not own), and the terminal row routes 72 and 82 (`redactKeysDeep` on `config`, for rows stored before this release);
- `packages/core/src/endless/service.ts`: `report()` 303-330, and the reads `zoom` 461, `date` 466, `threads` 471 and `/messages` (for rows stored before this release).

Test: create `packages/core/tests/keys/redaction-paths.test.ts`.
- [ ] Tests first: a `dtk_` canary in a worker's last text is absent from the raw database rows after `noteTurnOutcome`, `reportStatus` and `logCoordinatorMessage` (read the tables directly), absent from the Chat store rows after a turn that echoes it (the stored rows, not only the API answer), and redacted in the conversation route, the terminal row routes, the completion notice, the question notice, the blocked notice, a thread report to Chat, and the Chat memory reads.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): redact keys at every write point and read path`.

### Task 17: CLI

**Files:** modify `packages/cli/src/index.ts` (`rolesRequest` 324-344 sends the owner header from `resolveCredential({ purpose: 'cli' })`; `cmdAccess` 148-190 refuses in thread mode with "Run this in your own terminal, not in a Dispatch thread."; `dispatch status` prints the stage 1 counts from `GET /api/access/no-credential-stats` when the daemon answers; new `dispatch api METHOD PATH [--body FILE | --body -]` that prints the JSON answer and exits non-zero on a non-2xx status; `probeHttp` 113-127 stays credential-free; fix the stale comment at 280), tests `packages/cli/tests/commands.test.ts` (316, 359, 376 pin the `fetch` init; update them to expect the header), `packages/cli/tests/api.test.ts` (new).

- [ ] Tests first: `roles` sends `Authorization: Bearer TOKEN` from an injected token reader and never puts it in argv; inside a thread (`DISPATCH_AUTH=dtk_...`) `roles` sends the key (and the daemon will answer `owner_only`); `dispatch access` refuses with a `dtk_` key, with `DISPATCH_AUTH_FILE`, and with only `DISPATCH_TERMINAL_ID`; a `dsk_` key keeps owner mode; `dispatch api GET /api/sessions` prints the answer; `--body FILE` and `--body -` (stdin) send the body; an unreadable key file never falls back to the owner token; the reachability probe sends no credential.
- [ ] `cd packages/cli && node node_modules/vitest/vitest.mjs run tests/commands.test.ts > /tmp/ptk-test.log 2>&1`, and `tests/api.test.ts`. FAIL, implement, PASS. Commit `feat(cli): owner token on HTTP calls, dispatch api, thread mode`.

### Task 18: First-party flows pass with keys (the "no 403" test)

This task protects work in progress: every tool that an agent or Chat uses today must still succeed with its key.

**Files:** create `packages/core/tests/keys/first-party-flows.test.ts`.

- [ ] Write the test. Start `createApp` (with `mountApiRoutes`, a stub `EndlessService` whose `arm`, `disarm`, `zoom`, `date`, `threads`, `project` and `ledger` methods behave as the real ones, and capturing structured managers; no CLI runs) on a real port (`listen(0)`), set `DISPATCH_API`, seed a project with a coordinator, a worker (spawned by the coordinator), a peer thread, a role run, an endless worker, and a second project. Mint keys. Call the real `callTool` of `overseer/agency-mcp.ts` and `endless/memory-mcp.ts` in-process (the pattern of `tests/routes/endless.test.ts:255-284`), with `DISPATCH_AUTH` set per caller, for every tool: `spawn_agent`, `queue_agent`, `start_agent`, `list_agents`, `list_missions`, `message_agent`, `answer_agent` (with a seeded pending question), `read_agent`, `complete_agent`, `list_threads`, `read_thread`, `message_thread`, `watch_thread`, `unwatch_thread`, `list_watches`, `report_status`, every `ledger_*` tool (as the coordinator), every memory MCP tool (as Chat), and the role-run set (as the role run). Expected: no `401`, no `403`.
- [ ] Add the forged cases from spec 9: a worker key with `source: 'user'`, with `caller` set to the coordinator, with `watcherTerminalId` of a peer, a spawn past depth 3, an answer to a held tool call, an owner-only route (`POST /api/secrets`, `POST /api/roles/NAME/enable`, `POST /api/claude-auth/...`, `POST /api/integrations`, `POST /api/terminals/ID/input`, `PATCH /api/terminals/ID`): each gets its `403` code.
- [ ] Run it. If a first-party tool fails, fix the rule or the helper (not the test), with its own failing test first. Commit `test(keys): every first-party tool passes with its key`.

### Task 19: No key in the log

**Files:** create `packages/core/tests/keys/no-key-in-log.test.ts`.

- [ ] Spy on `console.log`, `console.warn` and `console.error`; run a spawn (capturing managers), a refused call, a revoked-key call, a stats summary, and a structured exit with stderr. Assert that no captured line contains `dtk_`, `dck_` or `dsk_` followed by 43 characters. Run, fix if needed, commit `test(keys): no key in the daemon log`.

### Task 20: Docs

**Files:** modify `docs/network-access.md` (a "Thread keys" section: what a key is, that agents get `403` on owner-only actions, that no-credential calls still work in this release and are counted, how to see the counts with `dispatch status`, and `dispatch api` for scripts with no token in argv), `README.md` (one line under remote access pointing to it).

- [ ] Write the docs. Render-check with `marked` from `packages/web` (no `<a>` from stray angle brackets). Commit `docs(keys): thread keys and dispatch api`.
- The release note is written at the release step, not here. It must say: nothing visible changes; agents that call owner-only routes get `403`; `dispatch status` shows the no-credential counts; WSL users with the data directory on `/mnt/c` get no file privacy for literal key files (if Task 1 chose any); a Codex user's own `include_only` shell filter can drop the key from Codex shells; a managed Claude setting that blocks hook env values leaves the hook without a key (counted); the hosted box is covered by unit tests only; how to roll back.

### Task 21: Full suite, build, probe rerun

- [ ] From the worktree root: `pnpm build > /tmp/ptk-build.log 2>&1` (the build runs `tsc` in every package; there is no separate typecheck script); read the log; expected no errors.
- [ ] `cd packages/core && node node_modules/vitest/vitest.mjs run > /tmp/ptk-core.log 2>&1`; then `packages/cli`; then `packages/web`. One at a time. Read each log. Expected: all pass, the same skip count as main.
- [ ] Rerun the Task 1 probe with the production helpers in place of the fixtures (`--production` flag: the real agency MCP, `codex-notify.mjs`, `grok-hook.mjs`, the shim relay), against its fake daemon. Expected: the same table as Task 1, now from the real code. Add the result to the probe results file.
- [ ] The repo-hygiene scan from the global constraints over `git diff main...HEAD` and the commit messages.

### Task 22: Restart mid-work test on a throwaway daemon (the go gate for stage 1)

A failure here blocks the stage 1 release (spec 7.1, 9). It costs real model usage on all four harnesses (use `haiku` for Claude workers) and takes about two to three hours. The operator is usually an agent in a live Dispatch thread, so every command below runs with a clean environment: nothing from the live daemon (`DISPATCH_*`, the shim `PATH`, `BROWSER`) may reach the test daemon or its threads.

**Setup**

- [ ] **Step 1: Build from the worktree root.** `pnpm build > /tmp/ptk-build.log 2>&1`. Confirm the build has the new code: `rg -c "dtk_" packages/core/dist/auth/principals.js` prints a number above 0.
- [ ] **Step 2: Fresh scratch folder and port.** `S=$(mktemp -d /tmp/ptk-s1.XXXXXX); P=3490`. `lsof -nP -iTCP:$P -sTCP:LISTEN` must print nothing; else use 3491 to 3499. Never 3456. Record `S` and `P` in the build record.
- [ ] **Step 3: Fake HOME with signed-in CLIs, read-only checks first.**
  - `mkdir -p $S/home/.config $S/home/.local/share $S/proj-a $S/proj-b $S/keys && chmod 700 $S/keys`.
  - Symlink from the real home into `$S/home`: `.claude`, `.claude.json`, `.codex`, `.grok`, `.config/opencode`, `.local/share/opencode` (the recipe of the 2026-10-13 Chat end-to-end run). Never copy a sign-in file. The fake home gets a fresh `.dispatch`, so no real role, schedule, project or token is visible to the test daemon. Test threads appear in the real CLI session histories, and they load the owner's own user-level MCP servers; that is expected and does not touch the live daemon.
  - Check that no global CLI config points at a Dispatch daemon: `rg -n -l "3456|DISPATCH_|/api/events" $S/home/.claude/settings.json $S/home/.claude.json $S/home/.codex/config.toml` prints nothing (a match in a URL that is not a Dispatch address is fine; read it before you go on). If one points at the live daemon, stop and report to the coordinator.
  - Define the clean environment once: `CLEAN="env -i HOME=$S/home USER=$USER LOGNAME=$LOGNAME SHELL=$SHELL LANG=${LANG:-en_US.UTF-8} TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$(dirname $(command -v node))"`. `USER` is needed for the macOS keychain. Add the folder of each CLI binary (`command -v claude codex grok opencode`) to `PATH`, but never `~/.dispatch/bin` (the live shim).
  - Check each CLI under the clean env: `$CLEAN claude -p "Reply with the word ok." --model haiku`, `$CLEAN codex login status`, a one-line `grok` and `opencode` prompt. If one is not signed in, stop and report to the coordinator. Do not sign in for the owner.
- [ ] **Step 4: Helper scripts in `$S` (not in the repo).** They read the key from `DISPATCH_AUTH` or from the file in `DISPATCH_AUTH_FILE` (the Codex fallback of Task 1), so they work with either delivery.

```js
// $S/key.mjs: shared helper
import fs from 'node:fs';
export const ownKey = () => process.env.DISPATCH_AUTH
  || (process.env.DISPATCH_AUTH_FILE ? fs.readFileSync(process.env.DISPATCH_AUTH_FILE, 'utf8').trim() : '');
```

```js
// $S/save-key.mjs: a thread runs `node $S/save-key.mjs $S/keys/LABEL`; writes its own key, mode 0600
import fs from 'node:fs';
import { ownKey } from './key.mjs';
fs.writeFileSync(process.argv[2], ownKey(), { mode: 0o600 });
```

```js
// $S/call.mjs: node $S/call.mjs KEYFILE METHOD PATH [BODYFILE]; prints the status; no key in argv
import fs from 'node:fs';
const [keyFile, method, path, bodyFile] = process.argv.slice(2);
const key = fs.readFileSync(keyFile, 'utf8').trim();
const res = await fetch(process.env.API + path, { method, headers: { authorization: `Bearer ${key}`,
  'content-type': 'application/json' }, body: bodyFile ? fs.readFileSync(bodyFile) : undefined });
console.log(res.status, (await res.text()).slice(0, 200));
```

```js
// $S/whoami-loop.mjs: a thread runs `node $S/whoami-loop.mjs $S/nohup.out`. The first run starts a
// detached copy of itself in its own process group (so a process-group kill of the thread does not
// end it) and exits. The copy writes its pid to OUT.pid, so teardown kills exactly this process.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ownKey } from './key.mjs';
const out = process.argv[2];
if (process.argv[3] !== 'child') {
  spawn(process.execPath, [process.argv[1], out, 'child'], { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}
fs.writeFileSync(out + '.pid', String(process.pid));
const key = ownKey(), api = process.env.DISPATCH_API;
for (;;) {
  let s = 'ERR';
  try { s = String((await fetch(api + '/api/whoami', { headers: { authorization: `Bearer ${key}` } })).status); } catch {}
  fs.appendFileSync(out, `${new Date().toISOString()} ${s}\n`);
  await new Promise((r) => setTimeout(r, 5000));
}
```

```js
// $S/work.mjs: the long task every thread runs, one short step per call so no tool timeout ends it:
// node $S/work.mjs FILE N appends line N to FILE and sleeps 3 s.
import fs from 'node:fs';
fs.appendFileSync(process.argv[2], `${process.argv[3]}\n`);
await new Promise((r) => setTimeout(r, 3000));
```

- [ ] **Step 5: Start the throwaway daemon.**

```bash
cd $WT   # the build worktree
$CLEAN PORT=$P DISPATCH_TELEMETRY=0 DISPATCH_WEB_DIST=$WT/packages/web/dist \
  nohup node packages/core/dist/server.js >> $S/daemon.log 2>&1 &
echo $! > $S/daemon.pid
```

  Ready when `$S/daemon.log` has `Dispatch server listening on port $P`. `export API=http://127.0.0.1:$P`. Then write the owner header file, so the operator's own calls are owner calls and are not counted as `program`: `printf 'Authorization: Bearer %s\n' "$(cat $S/home/.dispatch/access-token)" > $S/owner.hdr; chmod 600 $S/owner.hdr`, and use `curl -sS -H @$S/owner.hdr ...` for every operator call (the `printf` runs in the shell; the token is in no argv).
- [ ] **Step 6: Check the test daemon's children see only the test daemon.** Create a shell tab (`POST /api/sessions` for project A first, then `POST /api/sessions/A/terminals` with `{ "type": "shell" }`), attach it, run `env | grep -E '^(DISPATCH_|BROWSER|PATH)' > $S/shell-env.txt` in it, and read the file: `DISPATCH_API` and `DISPATCH_SERVER_URL` hold port `$P`, `PATH` starts with `$S/home/.dispatch/bin`, and no value holds `3456`. Then `$S/home/.dispatch/bin/dispatch-open https://example.com/login` in that shell must create an auth request with that shell's terminal id (`GET /api/auth-requests`).

**Work in progress**

- [ ] **Step 7: Projects.** `git init` both `$S/proj-a` and `$S/proj-b` with one committed `NOTES.md`. Project A exists from step 6; create project B with `POST /api/sessions`.
- [ ] **Step 8: One thread per harness and view in project A.** Create each with `POST /api/sessions/A/terminals` and `{ "type": HARNESS, "label": LABEL, "config": { "transport": "structured" } }` for Pretty, or `"transport": "pty"` for the CLI view (Grok defaults to Pretty when no transport is named). Labels: `cc-cli`, `cc-pretty`, `cx-cli`, `cx-pretty-1`, `cx-pretty-2` (two threads share the app-server), `gk-cli`, `gk-pretty`, `oc`. Plus one plain peer `peer` (claude-code Pretty, model haiku) that only answers. Check each row's real `config.transport` with `GET /api/terminals/ID` before you go on. Attach each CLI thread once with the terminal WebSocket (the `verify` skill recipe). First message to each (owner, `source: user`): "Run `node $S/save-key.mjs $S/keys/LABEL`. Call list_threads. Then, for N from 1 to 400, run `node $S/work.mjs $S/proj-a/NOTES-LABEL.md N`, one command per number. Do not stop until 400." `cc-pretty` also runs `node $S/whoami-loop.mjs $S/nohup.out` before the loop.
- [ ] **Step 9: A coordinator, a worker, a queued agent, in project A.** `POST /api/sessions/A/overseer/coordinator`. Message it: "Run `node $S/save-key.mjs $S/keys/coord`. Spawn one worker (agentType researcher, model haiku, label worker) whose task is: run `node $S/save-key.mjs $S/keys/worker`, then for N from 1 to 400 run `node $S/work.mjs $S/proj-a/COUNT.md N`. Queue a second agent (label queued, model haiku) that depends on the worker. Add a ledger note 'e2e-alpha'. Watch the worker." Wait until the worker row exists, the queued row exists with status `queued`, and `COUNT.md` grows.
- [ ] **Step 10: A role run and a scheduled run.** Write a minimal role in `$S/home/.dispatch/roles/e2e-role/role.md` (a role that runs `list_threads`, `watch_thread` on `peer`, then `report_status`; copy the shape of an existing seed role in `packages/core/src/roles/seed.ts`), enable it with `POST /api/roles/e2e-role/enable` (this makes its schedule), then run that schedule now with `POST /api/agents/schedules/ID/run-now` (find the id with `GET /api/agents/schedules`). Create a scheduled agent with `POST /api/agents/schedules` (provider `claude-code`, model haiku, a prompt that runs `node $S/save-key.mjs $S/keys/sched` then the `work.mjs` loop) and run it now the same way. Both get keys (check `$S/keys/sched`) and appear as rows.
- [ ] **Step 11: A Chat turn in progress.** `POST /api/endless/send` with "Spawn a worker in project B (model haiku, label chat-worker) whose task is: run `node $S/save-key.mjs $S/keys/chat-worker`, then for N from 1 to 400 run `node $S/work.mjs $S/proj-b/NOTES.md N`. Then call list_threads every 20 seconds and tell me each time how far it is, for 10 minutes." Wait until the worker row exists in project B and `GET /api/endless/state` shows a turn running.
- [ ] **Step 12: Snapshot and barrier before the restart** (owner header):
  - Every thread, the coordinator, the worker, the scheduled run and the Chat turn show status `working` (or `running`) right now. If one is idle, send it "continue the loop" and wait. Record the statuses.
  - For every thread: `GET /api/terminals/ID` (status, config, label) and the message count of `GET .../conversation`; the coordinator's ledger through `sqlite3 -readonly $S/home/.dispatch/dispatch.db` (the ledger table); `shasum` of every file in both projects; `GET /api/access/no-credential-stats`; `wc -l $S/nohup.out` (all `200`); `$S/keys` holds one file per thread with a `dtk_` prefix (Codex threads included).

**Restart 1: clean**

- [ ] **Step 13:** `kill -TERM $(cat $S/daemon.pid)`; wait until that pid is gone. Check that the `whoami-loop` copy is alive (`kill -0 $(cat $S/nohup.out.pid)`). Start the daemon again as in step 5 and note the restart time `R`.

**Checks after each restart**

- [ ] **Step 14: Revive and use each one through its normal path.**
  - CLI threads: attach the terminal WebSocket (this relaunches and resumes them), then send the message below.
  - Pretty threads: send the message below (this runs `ensureStructuredAlive`).
  - The coordinator: wait for the kickstart (`kickstartInterruptedAgents`), then message it "Run `node $S/save-key.mjs $S/keys/coord-2`. Call ledger_list, read the worker with read_agent, start the queued agent if the worker is done, then report_status done with summary 'after-restart'."
  - Chat: send a new Chat message "List the threads in project B and tell me the chat-worker's status."
  - The message to each thread: "Run `node $S/save-key.mjs $S/keys/LABEL-2`. Call list_threads. Send message_thread 'ping' to the thread labelled peer. Then report_status done with summary 'after-restart', and go on with the loop from where NOTES-LABEL.md ends."
- [ ] **Step 15: Pass conditions, checked in this order:**
  1. **No false refusals.** Before any check below makes refusals on purpose: `rg '\[keys\] refused' $S/daemon.log` after `R` shows no line that names a terminal id of a live test thread. (A rate-limited `auth_required` line with no terminal id comes from the `whoami-loop` job, which condition 5 expects.)
  2. **Everyone came back.** Every thread, the coordinator, the worker and Chat answer, and `GET /api/terminals/ID` shows the `after-restart` summary (or the worker goes on with its count). The queued agent is still `queued` or was started by the coordinator; it is not lost.
  3. **Every helper sent a key.** `GET /api/access/no-credential-stats` shows `program` total 0 since `R`, except the rows that Task 1 left without a key (for example the Claude hook, if it chose so); list them.
  4. **New keys, old keys dead.** Each `LABEL-2` key differs from `LABEL`. `node $S/call.mjs $S/keys/LABEL GET /api/whoami` gives `401` for every old key; `LABEL-2` gives `200`.
  5. **The orphan job is locked out, its thread is fine.** `$S/nohup.out` shows `200` lines before the restart, `ERR` lines while the daemon was down, and only `401` lines after `R`; `cc-pretty` meets condition 2.
  6. **Data is the same.** Labels, config, the ledger note `e2e-alpha`, conversation counts (equal or higher, never lower), the files in both projects (unchanged except new appended lines).
  7. **Nothing is stuck.** After 10 minutes no thread shows `running` with no new output, no thread needs a manual relaunch, no queued item is lost.
  8. **Forged calls still fail.** `node $S/call.mjs $S/keys/cc-pretty-2 POST /api/secrets` gives `403 owner_only`; a message with `source: user` from the same key gives `403 identity_mismatch`; a ledger call from the worker key gives `403`.

**Restart 2: hard kill**

- [ ] **Step 16:** Check the barrier of step 12 again (every one `working`). `kill -9 $(cat $S/daemon.pid)`. A hard kill does not stop the daemon's children (the SIGTERM handler at `server.ts:984-1006` does not run). List the leftovers read only: `ps -axo pid,ppid,command | awk '$2==1'` and, for each candidate, `lsof -a -d cwd -p PID` showing a cwd under `$S` or `$S/home`. Record them. Kill those pids only, one by one (`kill PID`, never a pattern). Then start again (step 5), note `R`, and repeat steps 14 and 15 with `LABEL-3`.

**Codex app-server crash**

- [ ] **Step 17:** With both Codex Pretty threads in their loop, find the app-server: `pgrep -P $(cat $S/daemon.pid) -f "codex app-server"` (the `-P` limits it to children of the throwaway daemon; check the pid's parent with `ps -o ppid= -p PID` before you kill it). `kill -9` it. Wait for the resume. Then each Codex Pretty thread runs `node $S/save-key.mjs $S/keys/LABEL-4`, calls list_threads and report_status. Pass: `LABEL-4` equals `LABEL-3` (same key), every call succeeds, no refusal line for these terminals in the log.

**Codex quick restart (only if Task 1 chose the reuse window)**

- [ ] **Step 18:** Use the "Restart session" action on `cx-pretty-1` (`POST /api/terminals/ID/relaunch`, owner header). Within 10 seconds message it to run `save-key` to `LABEL-5`, call list_threads and report_status. Pass: no `401` in the log for this terminal, the call succeeds. After 20 seconds, archive it; its key gives `401` at once.

**Teardown and record**

- [ ] **Step 19:** `kill -TERM $(cat $S/daemon.pid)`; `kill $(cat $S/nohup.out.pid)`. List leftovers read only as in step 16 and kill them by pid. Confirm with `lsof -nP -iTCP:$P -sTCP:LISTEN` that the port is free and with `pgrep -fl whoami-loop` (read only) that the job is gone. Delete `$S/keys` and `$S/owner.hdr`. Keep `$S/daemon.log`. Remove the symlinks in `$S/home` with `unlink` (never `rm -r` on `$S/home`, because it holds links into the real home).
- [ ] **Step 20:** Write the results into the build record (`docs/superpowers/plans/2026-10-23-per-thread-key-stage-1-build-record.md`): versions, `S`, `P`, the pass table per condition, per restart and per harness, the leftover processes found after the hard kill, and every failure with its fix. A failure blocks the release. Fix it test first and run the failed part again.

### Task 23: Reviews and hand-off

- [ ] Two independent code reviews of the branch (Opus, and Codex `gpt-6-astra`), at most two rounds; a third round only for a High or a secret finding that a normal run can hit. Fix test first. Run Task 22 again if a fix touches spawn, delivery, the gate or a rule.
- [ ] Stop with local commits and the build record. A draft PR, a merge, the version bump, the release note and any deploy each need the owner's own approval.

## How stage 1 avoids breaking anyone's environment or work in progress

- **Nothing that works today with no credential stops working.** The access gate keeps its v3.4.1 rules. A helper whose key did not arrive (an older CLI, a harness filter, a managed setting that blocks the hook header) sends no credential, exactly as today, and the daemon counts it. It never fails closed in stage 1, and it never uses the owner token.
- **Only key holders meet new rules,** and Task 18 runs every first-party tool with its key against the real routes. A rule that refuses a first-party call is a bug in the rule, fixed before release.
- **The browser, the phone, the CLI and the owner's scripts** carry no key, so the key rules never apply to them. No cookie, no sign-in page, no new prompt.
- **No stored state to migrate.** Keys are in memory only; no schema change; no new file is needed to start. Rollback is a plain version change.
- **An update restarts the daemon, as every update does.** The restart test (Task 22) proves that each harness, view, coordinator, worker, queued agent, role run, scheduled run and Chat comes back with a new key, with its data intact and nothing stuck, after a clean stop, a hard kill and a Codex app-server crash.
- **Other users.** WSL2: the daemon, threads and helpers all run inside WSL, so the code path is the Linux one; the Windows browser is unchanged in stage 1. Older harness versions: an unsupported config field is ignored and the caller is counted, not refused. The hosted box: the box gate starts to admit keys and the owner token, a key is as narrow as on a laptop, and hooks and the shim gain the base path; an end-to-end run on a box is not possible here, so the box is covered by unit tests only (named in the release note).

## Rollout and rollback (for the release step, not for this build)

- **Stage 1 release:** the next minor (for example v3.5.0). Gate: Task 22 passed on the release commit.
- **On each machine:** `dispatch update` restarts the daemon, as every update does. Every running thread dies and comes back through its normal revive path with a new key. A thread from v3.4.1 that survives (a detached job) has no key and keeps working with no credential (counted).
- **Rollback:** in the repo, `git checkout v3.4.1 && ./bin/dispatch build && ./bin/dispatch restart`. Keys live only in memory and stage 1 changes no schema, so v3.4.1 runs on the same data. The only stored changes are `spawnDepth: 0` on new root threads and redacted text, which v3.4.1 reads as before. After a rollback, do not run `dispatch update` until a fixed release exists, because it moves to the newest release tag.
- **Stage 2 go conditions** (spec 7.1, unchanged): the Codex check and every end-to-end harness row passed; the `program` count on the owner's machine holds only scripts that moved to `dispatch api`; at least one week of stage 1.

## Self-review against the spec

- 6.1 principals: Tasks 2, 5, 7, 11 (role runs, plus the watch routes). 6.2 keys: Tasks 2, 12. 6.3 delivery: Tasks 1, 13, 14, 15; redaction Task 16; inherited env 13a. 6.4 scope: Tasks 6, 8, 9, 10, 11; upgrades and the login order Task 5. 6.5 lifecycle: Task 12. 6.7 CLI: Tasks 4, 17. 6.8 platforms: box in Tasks 5 and 13a; WSL needs no code in stage 1 (release note). 6.9 logs: Tasks 5, 6, 19. Section 9 tests: Tasks 2 to 19, end to end Task 22. Section 10 files: all listed above except the stage 2 files (`one-time-code.ts`, the `#code=` sign-in, `dispatch open`).
- Not in stage 1 by design: 6.6 (stage 2), 6.10 (stage 3), the repo scripts and `verify` skill change (stage 2 release).
- Plan decisions where the spec was silent or out of date: message `source` stays `coordinator` for every key; stage 1 helpers with no key send no credential (never the owner token); the no-credential and refusal logs are rate limited; role runs keep the watch routes; the Claude hook uses `headers` with `allowedEnvVars`; the first task message after a spawn is not counted by the pair limit; a Codex reuse window if a quick resume keeps the old MCP set; hooks and the shim gain the base path.
