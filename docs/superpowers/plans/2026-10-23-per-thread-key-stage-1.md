# Per-thread keys, stage 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Every code task is test first: write the test, run it and see it fail, write the code, run it and see it pass, commit.

**Goal:** Build stage 1 of `docs/superpowers/specs/2026-10-23-per-thread-key-design.md`: every agent, Chat and shell process gets its own key, the daemon takes the caller's identity from the key and enforces the per-key rules, and requests with no credential still work and are counted.

**Architecture:** A key registry in daemon memory maps `sha256(key)` to a principal. A principal middleware runs after the existing gate and attaches one principal to every request. Each route declares its key policy where it is registered, through a small router wrapper whose default is owner only. The spawn paths mint a key per process, put it in the process environment (never argv), and revoke it by handle when that process exits. The MCP helpers, the hook helpers and the browser shim send `Authorization: Bearer KEY`.

**Tech stack:** TypeScript, Express 4, `ws`, vitest 2, supertest 7, Node 18 or later. macOS, Linux, WSL2, the hosted box.

**Scope:** stage 1 only. Stage 2 (no credential, no access; `dispatch open`; one-time codes; the `#code=` sign-in) and stage 3 (process check) are follow-ups and have no task here.

## Global Constraints

- Stage 1 causes no visible change for the owner. A request with no credential from this computer keeps working exactly as in v3.4.1 and is counted. No cookie is set in stage 1 (spec 6.6).
- Key format: prefix `dtk_` (thread), `dck_` (Chat), `dsk_` (shell), then 32 bytes from `crypto.randomBytes`, base64url, 43 characters (spec 6.2).
- Keys live only in daemon memory, as `sha256` hashes. Never in the database, the daemon log, argv, or any file that the daemon does not hand to the child (spec 6.2, 6.3).
- The environment variable is `DISPATCH_AUTH` (no KEY, TOKEN or SECRET in the name, spec 6.3). It is never added to the shared default env (`setDefaultEnv`).
- Every first-party caller uses `DISPATCH_API` (the real bound URL with the base path) and does not send a key when it is unset (spec 6.3).
- Default deny: a route with no key policy is owner only. Every WebSocket upgrade that carries a key is refused (spec 6.4).
- A request that carries a key is judged as the key, whatever other credential it also carries (spec 6.4, precedence).
- Error bodies are JSON `{ error, message }` with the codes of spec 6.4: `auth_required` (401), `owner_only`, `field_not_allowed`, `identity_mismatch`, `out_of_scope`, `depth_exceeded`, `not_a_question` (403), `rate_limited` (429).
- `MAX_SPAWN_DEPTH` stays 3 and `MAX_MESSAGES_PER_PAIR_PER_HOUR` stays 10 (`overseer/guards.ts`).
- No new file must exist for the daemon to start (spec 7.3). No database schema change. No off switch (spec 7.4).
- Tests: run vitest from `packages/core` (or `packages/cli`) as `node node_modules/vitest/vitest.mjs run FILE > /tmp/ptk-test.log 2>&1`, then read the file. Never `npx vitest` (the rtk hook rewrites it into a full run on the real HOME). Never pipe a test run through `head` or `tail`. One vitest process at a time. If a run that you did not start is alive, wait; never kill it.
- Tests that spawn, write files or delete files use a nested temp sandbox (`mkdtemp`, then a subdirectory). The test harness already isolates HOME (`tests/harness/isolated-home.ts`); do not work around it.
- Never touch port 3456, the live `~/.dispatch`, or the live daemon. No `dispatch restart`, `dispatch update` or `launchctl`. A throwaway daemon uses a fake HOME and a free port that is not 3456.
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
| `sessions/service.ts:1918-1932` ("relaunch") | 1925-1939 | That range is `switchTransport`; `relaunchTerminal` is 1011, `relaunch` (project) is 432 |
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
  1. PR 103 already added `sessions/mcp-config-sweep.ts` (stale `thread-*.mcp.json` sweep). Task 13 extends it.
  2. `routes/watches.ts` already refuses a shell watcher (spec 6.4 cites "PR 103").
  3. Files still written without mode `0600`: `hooks/ID.json` (`service.ts:370-373`), `opencode.json` and `rules.md` (`providers/opencode-config.ts:58,79`), Grok `hooks/hooks.json` (`grok-home.ts:133`), `chat/memory.mcp.json` (`endless/service.ts:160`).
  4. `platform/inherited-env.ts` drops only `PORT`.
  5. Role runs keep `watch_thread`, `unwatch_thread` and `list_watches` (`roles/role-policy.ts:30-33`). Spec 6.1 leaves the watch routes out of the role-run key. Task 11 adds them, or role runs would get `403` on a tool they use today.
  6. `MessageSource` is `'user' | 'coordinator'` in the database and the UI (`db/message-source.ts:6`). Spec 6.4 asks for a new `agent` value. Plan decision (no visible change in stage 1): every key caller gets `coordinator`, which is what every agent sends today, and never `user`. The `agent` value is a follow-up.
  7. In stage 1 the owner's browser has no cookie, so every browser request has no credential. A log line per request (spec 6.9) would flood the log. Plan decision: log the first request of each (category, method, path pattern) per daemon start and then one summary line per hour with counts. The in-memory counts are complete.
  8. `scripts/test-live-*.mjs` and the `verify` skill keep working in stage 1 (no credential is still allowed). They change in the stage 2 release, as the spec says.
  9. The Claude Code docs confirm HTTP hook `headers` with `allowedEnvVars` (HTTP hooks since 2.1.63; Dispatch already needs 2.1.69 or later). This resolves the open item in spec 6.3: no command-hook helper is needed for Claude.
  10. `opencode` 2.x runs a managed shared service (port 49374 on this Mac). If MCP servers are started by that shared service, a `{env:DISPATCH_AUTH}` reference resolves in the wrong process. Task 1 decides the opencode delivery.

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/auth/principals.ts` (new) | `KeyRegistry`: mint, resolve, revoke by handle, one live key per terminal; `keyKindOf` |
| `packages/core/src/auth/request-principal.ts` (new) | Principal middleware, `principalOf(req)`, `scopeOf(req)`, refusal logging, key refusal on upgrades |
| `packages/core/src/auth/no-credential-stats.ts` (new) | Stage 1 counts per category and path pattern, rate-limited log lines |
| `packages/core/src/auth/route-policy.ts` (new) | `policyRouter()`, `keyRoute()`, `ownerOnly`, `publicRoute`, `refuse()`, error type |
| `packages/core/src/auth/key-scope.ts` (new) | Database facts for a caller and a target: effective depth, legacy record rules, coordinator of, worker of, same project, role run |
| `packages/core/src/auth/key-rules.ts` (new) | The rules of each allowlist row (create body allowlist, message, start, archive, answer, watches, ledger, events, auth requests, Chat) |
| `packages/core/src/auth/redact-keys.ts` (new) | `redactKeys(text)`, `redactKeysDeep(value)` |
| `packages/core/src/auth/credential.ts` (new) | The one credential resolver (owner, thread, shell, none, refuse) for the CLI and both MCP servers |
| `packages/core/src/auth/shim-relay.ts` (new) | Node relay that the browser shim runs instead of `curl` |
| `packages/core/src/sessions/thread-keys.ts` (new) | Key lifecycle per process: mint at spawn, bind to the process, revoke on exit, stop, archive, delete, spawn failure |
| `packages/core/src/auth/access-gate.ts` | Record the decision `via` on the request |
| `packages/core/src/auth/box-token.ts` | Box gate admits a box header, the owner access token, or a live key |
| `packages/core/src/server.ts` | Build one registry; mount the principal middleware in `startServer` and `createApp`; whoami and stats routes; key refusal on upgrades; token file in box mode; pass PTY pid on exit |
| `packages/core/src/routes/*.ts` (26 files) | `Router()` becomes `policyRouter()`; key rows use `keyRoute(...)` |
| `packages/core/src/sessions/service.ts` | Mint and deliver keys, revoke, legacy depth, `spawnDepth: 0` on root threads, `DISPATCH_API` in `agencyServerSpec`, `answerPermission` attribution, redaction in notices |
| `packages/core/src/pty/manager.ts` | `exit` event carries the pid |
| `packages/core/src/mcp/injection.ts` | One server can carry literal `env` and `env_vars` together; the key reference and the Codex literal |
| `packages/core/src/providers/claude-code.ts` | HTTP hook `headers` and `allowedEnvVars` |
| `packages/core/src/providers/grok-home.ts`, `providers/opencode-config.ts` | Key delivery per Task 1 result; `0600` files |
| `packages/core/src/platform/inherited-env.ts` | Drop `DISPATCH_BOX_TOKEN`, `OS_BOX_TOKEN`, `DISPATCH_AUTH`, `DISPATCH_AUTH_FILE` |
| `packages/core/src/overseer/agency-shared.ts`, `overseer/agency-mcp.ts` | Send the key on every call, `whoami`, readable errors, `force` on archive |
| `packages/core/src/endless/service.ts`, `endless/turn-runner.ts`, `endless/summarizer-claude.ts`, `endless/memory-mcp.ts` | Chat keys, `startedBy`, memory MCP sends the key, redaction in reports and reads |
| `packages/core/src/auth/shim.ts`, `packages/core/scripts/codex-notify.mjs`, `packages/core/scripts/grok-hook.mjs` | Send the key without argv |
| `packages/core/package.json` | Export `./credential` for the CLI |
| `packages/cli/src/index.ts` | Owner token on HTTP calls, `dispatch api`, thread mode refusals, stage 1 counts in `status` |
| `scripts/key-delivery-probe.mjs` (new) | The Codex check and the other harness delivery checks (Task 1) |
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
  constructor(registry: KeyRegistry);
  mintForSpawn(terminalId: string, kind: 'thread' | 'shell'): { key: string; handle: KeyHandle };
  bindPty(terminalId: string, pid: number, handle: KeyHandle): void;
  onPtyExit(terminalId: string, pid: number): void;   // revokes only the handle bound to that pid
  bindStructured(terminalId: string, handle: KeyHandle): void;
  onStructuredExit(terminalId: string): void;         // managers emit exit only for the current session
  spawnFailed(handle: KeyHandle): void;
  revokeLive(terminalId: string): void;               // stop, archive, delete
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
```

---

### Task 1: Delivery probes, including the Codex check (gate before any delivery code)

Spec 6.3 makes the Codex check a prerequisite. This task also settles the three other open delivery questions: the Claude hook header, the Grok `.mcp.json` env reference, and opencode under its shared service.

**Files:** create `scripts/key-delivery-probe.mjs`; create `docs/superpowers/plans/2026-10-23-per-thread-key-stage-1-probe-results.md`.

- [ ] **Step 1: Write the probe.** Model it on `scripts/codex-release-probe.mjs` (it drives the real `CodexStructuredSessionManager` through `node --import tsx`). The probe:
  - Starts a fake daemon: a `node:http` server on a free port that records, per request, the method, the path and the `Authorization` header, and answers `200 {}` (for `GET /api/whoami` it answers a fixed principal).
  - Makes one canary key per thread: `dtk_` plus 43 random base64url characters. It writes each canary only into the places the spec table uses, never into argv.
  - Codex Pretty: two threads at once on one app-server. `threadConfig` holds `mcp_servers.dispatch` with the real agency MCP (`packages/core/src/overseer/agency-mcp.ts` through tsx), literal `env.DISPATCH_AUTH`, literal `env.DISPATCH_API` (the fake daemon), and `shell_environment_policy.set.DISPATCH_AUTH`. The prompt: call `list_threads`, then run the shell command `node -e "process.stdout.write(String(process.env.DISPATCH_AUTH||'').slice(0,4))"`, then reply `done`.
  - Codex CLI: one PTY thread through `node-pty` with `-c mcp_servers.dispatch.env_vars=["DISPATCH_AUTH"]`, the non-secret `env.*` literals, and `-c notify=["node","packages/core/scripts/codex-notify.mjs","URL"]`, with `DISPATCH_AUTH` only in the PTY env.
  - Resumes one Pretty thread, then kills the app-server once with `SIGKILL`, waits for the resume, and makes one more MCP call.
  - Claude CLI view: a `--settings` file with an HTTP `Stop` hook that has `headers: { Authorization: "Bearer ${DISPATCH_AUTH}" }` and `allowedEnvVars: ["DISPATCH_AUTH"]`, and an `--mcp-config` file with `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`. Run `claude -p "Call the list_threads tool, then reply ok." --model haiku`.
  - Grok: a per-thread Grok home (as `providers/grok-home.ts` writes it) whose `plugins/dispatch/.mcp.json` holds `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`. One run in each view.
  - opencode: two threads at once, each with its own `OPENCODE_CONFIG`; first with `environment.DISPATCH_AUTH = "{env:DISPATCH_AUTH}"`, then with the literal value.
  - Every harness runs in a scratch directory. Codex uses a temporary `CODEX_HOME` that holds a copy of `~/.codex/auth.json` (mode `0600`, deleted at the end). The other CLIs use the real HOME (they must be signed in); their config files live in the scratch directory.
- [ ] **Step 2: Scan.** After the runs, search the temporary `CODEX_HOME` (rollouts, logs, history, sqlite files, with `rg -a`), the scratch directories, and the captured stdout and stderr of every process for each canary. Record, per harness and view: did every MCP request carry the right canary; did each thread carry its own canary (no cross-talk between the two Codex threads and the two opencode threads); did the shell see the 4-character prefix; did `notify` and the hooks carry it; where (if anywhere) the canary was written.
- [ ] **Step 3: Write the results file** with the table from step 2, the CLI versions (`claude`, `codex`, `grok`, `opencode`), and the outcome for each row below.
- [ ] **Step 4: Gate.** Pick the delivery for each row. If an outcome is not one of these, stop and report to the coordinator.

| Row | Outcome | Delivery used in Task 13 and 14 |
|---|---|---|
| Codex | canary in no file | spec table (literal in thread config, `env_vars` in the CLI) |
| Codex | canary in a rollout or log | Task 13b fallback: key file `DISPATCH_AUTH_FILE` |
| Codex `notify` | env not inherited | notify argv carries the key file path; helper reads the file |
| Codex shell | `set` dropped | the shim in Codex threads uses the key file |
| Claude hook | header arrived | `headers` + `allowedEnvVars` |
| Claude hook | header empty or literal | keep the hook as is (no credential, counted); open question for stage 2 |
| Grok | reference resolved | `${DISPATCH_AUTH}` in `.mcp.json` |
| Grok | literal `${DISPATCH_AUTH}` arrived | literal key in the `0600` `.mcp.json`, deleted at exit |
| opencode | reference resolved per thread | `{env:DISPATCH_AUTH}` |
| opencode | reference empty or cross-talk | literal key in the `0600` `opencode.json`, deleted at exit |

- [ ] **Step 5: Commit** `scripts/key-delivery-probe.mjs` and the results file: `test(keys): delivery probes and Codex check results`.

### Task 2: Key registry

**Files:** create `packages/core/src/auth/principals.ts`, `packages/core/src/auth/principals.test.ts`.

**Produces:** `KeyKind`, `KEY_PREFIX`, `KeyHandle`, `KeyPrincipal`, `MintInput`, `keyKindOf`, `KeyRegistry` (see the shared interfaces).

- [ ] **Step 1: Write the failing tests.**
  - `mint({kind:'thread', terminalId:'t1'})` returns a key that matches `/^dtk_[A-Za-z0-9_-]{43}$/`; `resolve(key)` returns `{kind:'thread', terminalId:'t1', handle}`.
  - Chat keys start `dck_` and carry `startedBy`; shell keys start `dsk_`.
  - A second `mint` for `t1` makes the first key resolve to `null`; `liveHandleFor('t1')` is the new handle.
  - `revoke(handle)` makes the key resolve to `null`; a second `revoke` does not throw; revoking an old handle does not touch the new key.
  - `resolve` returns `null` for an unknown key, `''`, `dtk_short`, a `dck_` value with a `dtk_` body swapped, and a 44-character body.
  - The registry holds hashes only: `JSON.stringify([...internal map])` and `util.inspect(registry, {depth: 5})` do not contain the key.
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

### Task 4: Credential resolver and the CLI export

**Files:** create `packages/core/src/auth/credential.ts`, `packages/core/src/auth/credential.test.ts`; modify `packages/core/package.json` (exports `./credential` pointing at `dist/auth/credential.js` with types, as `./access` does).

**Produces:** `resolveCredential` (shared interfaces). Rules, in this order (spec 6.7, with the stage 1 change marked):
1. `DISPATCH_AUTH` is a `dsk_` key: purpose `shim` gives `thread` with the shell key; purpose `cli` gives `owner` from `readOwnerToken()`; purpose `mcp` gives `refuse`.
2. `DISPATCH_AUTH` is a `dtk_` or `dck_` key: `thread` with `Bearer KEY`.
3. `DISPATCH_AUTH_FILE` is set: read the file (one line, trimmed); a valid `dtk_` or `dck_` key gives `thread`; an unreadable file or bad content gives `refuse` with "This thread has no Dispatch key".
4. A thread marker is present (`DISPATCH_TERMINAL_ID` or `DISPATCH_TERMINAL`) and no usable key: purpose `cli` gives `refuse` with "This thread has no Dispatch key"; purposes `mcp` and `shim` give `none` (**stage 1 only**: the helper sends no credential, as today, and the daemon counts it; it never uses the owner token). Stage 2 changes this to `refuse`.
5. No marker: purpose `cli` gives `owner` (or `none` when the token file is missing); purposes `mcp` and `shim` give `none`.

- [ ] Tests first, one per rule and purpose, plus: a `dtk_` key with `purpose: 'cli'` never calls `readOwnerToken` (use a spy that throws); a malformed `DISPATCH_AUTH` with a marker gives `refuse` for `cli`; `DISPATCH_AUTH_FILE` pointing at a missing file gives `refuse` and never the owner token. Run, FAIL, implement, PASS.
- [ ] Commit `feat(keys): one credential resolver`.

### Task 5: Principal middleware, gates, whoami, stage 1 counts

**Files:** create `packages/core/src/auth/request-principal.ts`, `packages/core/src/auth/no-credential-stats.ts`, tests `packages/core/src/auth/request-principal.test.ts`, `packages/core/src/auth/no-credential-stats.test.ts`; modify `packages/core/src/auth/access-gate.ts` (line 196: record `d.via` on the request with a symbol before `next()`; export `hasOwnerCredential(authorization, cookie, token)` from the existing `hasCredential` at 51-56), `packages/core/src/auth/box-token.ts`, `packages/core/src/server.ts`, test `packages/core/tests/auth/access-integration.test.ts`, `packages/core/src/auth/box-token.test.ts`.

**Consumes:** `KeyRegistry` (Task 2). **Produces:** `createPrincipalMiddleware({ registry, scope, getToken, boxToken? })`, `principalOf`, `scopeOf(req): KeyScope`, `bearerKey`, `refuseKeyUpgrade(req): boolean`, `createNoCredentialStats({ log, now })` with `record(req)` and `snapshot()`, `createBoxGate({ boxToken, registry, getToken })`.

Middleware rules, in this order:
1. `bearerKey(Authorization)` is set: `registry.resolve`. `null` gives `401 auth_required` ("This Dispatch key is not valid any more. Start a new thread.") and one refusal log line. A key principal on a path that does not start with `/api/` gives `403 owner_only`. Otherwise attach the key principal.
2. Else an owner credential (box header on a box, `Bearer` access token, the `dispatch_access` cookie): attach `owner`.
3. Else attach `none` with the gate's `via` (`local` or `tailscale`; `test` in `createApp`). For `via: 'local'`, call `stats.record(req)`.
A `Bearer` value that is neither a key nor the token is ignored (an older Claude CLI may send a literal `${DISPATCH_AUTH}`); the request is judged as if it had no `Authorization`.

Stats: category `browser` when `Sec-Fetch-Mode` is present, else `program`. Path pattern: replace each UUID-like or 20-plus-character id segment with `:id`. Log the first request of each (category, method, pattern) per start as `[keys] no-credential program GET /api/roles UA=...`; then at most one summary line per hour. `snapshot()` returns `{ since, browser: { total, top: [{pattern, count}] }, program: {...} }`.

Box gate (spec 6.8): admit a valid box header, a `Bearer` access token, or a live key; refuse everything else with today's `401 unauthorized`. Upgrades on a box still accept only the box header. In `server.ts` create the token file in both modes (`ensureAccessToken(dataDir)` before the `BOX_TOKEN ?` branch at 478).

Server wiring:
- One `KeyRegistry` per daemon. `startServer`: after the gate (`app.use(accessGate.middleware)`, line 489) or the box gate, mount the principal middleware, then `express.json` (491). `createApp`: mount it before `express.json` (338) with `via: 'test'` for credential-free requests; add `keys?: KeyRegistry` to `CreateAppOptions` (236-246) and return-access to it for tests (`app.locals.keys`).
- `GET /api/whoami` (`publicRoute`): a thread key returns `{ kind, terminalId, sessionId, role, depth, spawnedBy, roleRun }` from `KeyScope`; a Chat key `{ kind, startedBy }`; a shell key `{ kind, terminalId }`; owner and none `{ kind }`.
- `GET /api/access/no-credential-stats` (owner only): `stats.snapshot()`.
- `handleUpgrade` (784-843): after the existing gates, `if (refuseKeyUpgrade(request))` write `HTTP/1.1 403 Forbidden` and destroy the socket.

- [ ] Tests first (unit, with a stub registry and a peer override as in `access-gate-http.test.ts:15-31`):
  - a live thread key attaches the thread principal; a revoked key gives `401 auth_required`; a key plus a valid cookie is judged as the key; a key plus the access token is judged as the key; a key on `/` (a page) gives `403 owner_only`;
  - the access token attaches `owner`; no credential from loopback attaches `none` with `via: 'local'` and is counted; a `Bearer ${DISPATCH_AUTH}` literal is ignored and counted as `none`;
  - stats: `Sec-Fetch-Mode` request counts as `browser`, none as `program`; ten requests to `/api/terminals/UUID` give one pattern and one log line; the hourly summary appears after `now` moves 61 minutes;
  - box gate: box header passes as `owner`; access token passes as `owner`; a live key passes as the key; revoked key `401`; no credential `401`; key plus box header is judged as the key; the token file exists in box mode;
  - integration (`access-integration.test.ts`, real listen): a WebSocket with a key header to the terminal socket, the structured socket and `/api/events` gets `403`; `GET /api/whoami` with a minted key returns the terminal id; no credential from `127.0.0.1` still gets `200` on `/api/sessions`.
- [ ] Run each file (`node node_modules/vitest/vitest.mjs run src/auth/request-principal.test.ts`, then the others), see FAIL, implement, see PASS.
- [ ] Commit `feat(keys): principal middleware, box gate, whoami, stage 1 counts`.

### Task 6: Route policy wrapper and the completeness test

**Files:** create `packages/core/src/auth/route-policy.ts`, `packages/core/tests/auth/route-policy-completeness.test.ts`, `packages/core/src/auth/route-policy.test.ts`; modify every router file under `packages/core/src/routes/` (26 files: replace `Router()` with `policyRouter()`, keep the options such as `mergeParams`), and `server.ts` (the `app.get('/icons/:name')` and SPA fallback routes at 420, 422, 772, 774 get `publicRoute`; `app.post('/api/access/login')` at 488 gets `publicRoute`).

**Produces:** `policyRouter`, `keyRoute`, `ownerOnly`, `publicRoute`, `POLICY_TAG`, `refuse(res, result)`, `KeyRules`, `Rule`, `RuleResult`.

Behaviour:
- `policyRouter()` returns an Express `Router` whose `get`, `post`, `put`, `patch`, `delete` and `all` prepend `ownerOnly` when the first handler has no `POLICY_TAG`.
- `ownerOnly`: `owner` and `none` pass; any key gets `403 owner_only` with "This action is for the owner only. Ask the owner to do it in the browser."
- `keyRoute(rules)`: `owner` and `none` pass untouched. A key picks its rule: a thread key with `CallerFacts.roleRun` uses `rules.roleRun` (no fallback to `rules.thread`); a Chat key with `startedBy: 'summarizer'` uses `rules.summarizer`; a missing rule gives `owner_only`. A thread or shell key whose caller row is missing or archived gives `401 auth_required`. A failed rule calls `refuse`, which logs one line (principal kind, terminal id, method, route path, error; never the key) and sends `{ error, message }`.
- Normalize the peer address (`::ffff:127.0.0.1` to `127.0.0.1`) before any address rule (spec 6.4). The existing `isLoopbackAddress` already does this; add a test that proves it.

- [ ] Tests first:
  - `route-policy.test.ts`: a plain route on `policyRouter()` refuses a thread key with `owner_only` and serves owner and none; a `keyRoute({thread})` route runs the rule and serves the key; a role-run caller on a route with only `thread` gets `owner_only`; the refusal log line has no key in it.
  - `route-policy-completeness.test.ts`: build the full app (`createApp({ db, skipPty: true })`), walk `app._router.stack` recursively (`layer.route` for routes, `layer.handle.stack` for mounted routers), and fail when a route's first handler has no `POLICY_TAG`. A second test lists every route whose first handler is a `keyRoute`, as `METHOD /full/path`, and compares it with an inline expected list (the allowlist of Tasks 8 to 11). Adding a key route later then fails this test until the list is updated in review.
- [ ] Run both, see FAIL (the completeness test fails on every plain route), switch all routers, see PASS. Run the existing route tests that touch the switched files (`tests/routes/*.test.ts`, `src/routes/*.test.ts`) one file at a time; expected: PASS with no change, because owner and none pass every route.
- [ ] Commit `feat(keys): default-deny route policy on every route`.

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

**Consumes:** Tasks 5 to 7. **Produces:** in `key-rules.ts`: `createBodyRule`, `messageRule`, `directRule` (start and archive), `answerRule`, `selfRule` (report-status), `sameProjectRead`, and one daemon-wide `PairRateLimiter` from `overseer/guards.ts`.

Rules (spec 6.4, with the plan decisions above):
- `POST /api/sessions/:id/terminals`: `:id` is the caller's project. The body allows only `type` (`claude-code`, `codex`, `grok`, `opencode`), `label`, `queued`, `task`, `config.transport` (`structured` only), `config.agentType`, `config.mission`, `config.model`, `config.dependsOn` (each id a thread in the same project), and `config.role`, `config.spawnDepth`, `config.spawnedBy`, `config.origin` only when they equal what the daemon writes (`agent`, caller depth + 1, caller id, absent). Any other field gives `403 field_not_allowed` naming the field. A different value of the four gives `403 identity_mismatch`. `checkSpawnDepth(caller.depth)` fails with `403 depth_exceeded`. Then the rule writes the four fields into `req.body.config` and the existing handler runs.
- `GET /api/sessions/:id/terminals`, `GET /api/sessions/:id/overseer/worker-defaults`: `:id` is the caller's project.
- `GET /api/terminals/:terminalId`, `GET .../conversation`, `GET .../permission`: target in the caller's project.
- `POST .../message`: target in the caller's project, not the caller, not a shell tab; body fields only `text`, `content`, `source`; `source` absent or `coordinator`, else `403 identity_mismatch`; the rule sets `source: 'coordinator'`; then the pair limiter (`429 rate_limited`, keyed by caller id and target id).
- `POST .../start` and `DELETE /api/terminals/:terminalId`: `mayDirect`. For `DELETE`, also `checkArchiveAllowed(target, req.query.force === '1')`.
- `POST .../permission`: `mayDirect`; body only `decision` (`allow`), `answers`, `requestId`; the pending request must have `questions` (`403 not_a_question`) and `requestId` must equal its id (`403 identity_mismatch`); the rule sets `res.locals.answerLogAs = 'coordinator'`, and the handler passes it to `answerPermission`.
- `POST .../report-status`: `:terminalId` is the caller.

- [ ] Tests first (`terminals-keys.test.ts`, `createApp` plus `app.locals.keys.mint(...)`, rows seeded with `terminalsDb.create`):
  - create: one refusal per field: `type: shell`, `type: file`, `type: browser`, `type: notes`, `externalId`, `workingDir`, `skipPermissions`, `config.signIn`, `config.branchFrom`, `config.runner`, `config.runnerPrompt`, `config.roleRun`, `config.roleAuthority`, `config.autonomy`, `config.transport: 'pty'`, `config.dependsOn` with an id in another project; `config.role: 'coordinator'` and `config.spawnDepth: 0` give `identity_mismatch`; depth 3 caller gets `depth_exceeded`; the exact body that `buildWorkerCreateBody` makes today (queued and not queued) gets `201` and the stored row has role `agent`, depth caller + 1, `spawnedBy` the caller; another project gives `out_of_scope`;
  - the chain: a thread cannot create a shell tab, so it cannot get a `dsk_` key and cannot reach owner mode in the CLI;
  - message: `source: 'user'` gives `403 identity_mismatch` and `noteUserPrompt` is not called; self, a shell tab and another project give `out_of_scope`; the 11th message in an hour gives `429`; `canned` gives `field_not_allowed`; the owner with `source: 'user'` still works;
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

- [ ] Tests first: a Chat spawn in another project gets `201` with the four fields written; a Chat message to a non-endless thread gives `out_of_scope`; a summarizer key on `POST /api/sessions/:id/terminals` gives `owner_only`; a Chat key on `POST /api/endless/send` gives `owner_only`; `startedBy: 'report'` behaves as `user` in stage 1.
- [ ] Run, FAIL, implement, PASS. Run `tests/routes/endless.test.ts`. Expected PASS.
- [ ] Commit `feat(keys): Chat key rules`.

### Task 11: Role-run keys

**Files:** modify `packages/core/src/auth/key-rules.ts` and the route files of Tasks 8 and 9 (add `roleRun` rules); create `packages/core/tests/routes/role-run-keys.test.ts`.

A role-run key (a thread key whose row has `config.roleRun`) gets: `whoami`, the `GET` rows of Task 8, `report-status`, `events`, `auth-requests`, and (plan addition, see "spec drift" item 5) `POST /api/watches`, `GET /api/watches`, `DELETE /api/watches/:id`, with the same rules as a thread key.

- [ ] Tests first: a role-run key gets `owner_only` on create, message, start, archive and answer; it gets `2xx` on `list_threads`, `read_thread`, `report_status` and `watch_thread` requests.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): narrow role-run keys`.

### Task 12: Key lifecycle per process

**Files:** create `packages/core/src/sessions/thread-keys.ts`, `packages/core/src/sessions/thread-keys.test.ts`, `packages/core/tests/sessions/key-lifecycle.test.ts`; modify `packages/core/src/pty/manager.ts` (line 57: `this.emit('exit', sessionId, exitCode, proc.pid)`), `packages/core/src/sessions/service.ts` (`spawnTerminal` 2186, `spawnStructured` 2399, `stopTerminal` 1047, `stopAllTerminals` 2136, `removeTerminal` 2147, `archive` 477, `stop` 462; a `setKeyRegistry(registry)` setter like `setDaemonPort`), `packages/core/src/server.ts` (create the registry, call `sessionService.setKeyRegistry`, and forward `ptyManager` `exit` (703) and each structured manager's `exit` to `ThreadKeys`).

**Consumes:** `KeyRegistry`. **Produces:** `ThreadKeys` (shared interfaces); `SessionService.keyFor(terminalId)` is not added (keys are never read back).

Rules (spec 6.2, 6.5):
- Mint right before the process starts, in `spawnTerminal` (agent types: `thread`; `shell`: `shell`, also for a sign-in shell) and `spawnStructured` (`thread`). This covers create, start of a queued agent, runner, branch, relaunch, restart, restore, transport switch, `ensureStructuredAlive`, and the coordinator kickstart, because they all spawn through these two functions.
- PTY: `bindPty(terminalId, pid, handle)` with the pid that `ptyManager.spawn` returns; `onPtyExit(id, pid)` revokes only that pid's handle. A relaunch whose old PTY exits after the new spawn keeps the new key.
- Structured: `bindStructured`; `onStructuredExit(id)` revokes the live handle (the managers emit `exit` only for the current session: `structured/manager.ts:477`, `grok-manager.ts:223`, and `kill` emits once before the next spawn).
- Codex Pretty: `kill` emits `exit` and then unsubscribes (`codex-manager.ts:735-746`), so the structured rule covers unsubscribe. The `failed` event never revokes.
- Spawn failure (exception or no pid): `spawnFailed(handle)`.
- Stop, stop-all, archive, delete and project archive or stop: `revokeLive(id)` before the kill.
- A queued agent has no key until `start` spawns it.

- [ ] Tests first:
  - `thread-keys.test.ts` (pure): PTY late exit keeps the new key; structured exit revokes; `spawnFailed` revokes; `revokeLive` revokes only the current key.
  - `key-lifecycle.test.ts` (a `CapturingPty` and capturing structured managers as in `tests/sessions/terminal-id-env.test.ts:15-38`): each spawn path above mints a new key and the previous key resolves to `null`; `removeTerminal` and `stopTerminal` revoke; a Codex `failed` event leaves the key live; a daemon restart (a new `KeyRegistry`) resolves no old key.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): mint at spawn, revoke by handle`.

### Task 13: Delivery into the thread processes

Split in four commits. Every step keeps the key out of argv and out of the shared default env.

**13a: Environment, `DISPATCH_API`, inherited env.** Files: `packages/core/src/sessions/service.ts` (PTY `spawnEnv` at 2278 and the structured `env` at 2630 get `DISPATCH_AUTH`; `agencyServerSpec` 2863-2876 adds `DISPATCH_API` = `http://127.0.0.1:PORT` plus the base path, from the bound port; the key itself is not in `env`), `packages/core/src/server.ts` (`DISPATCH_API` is not a secret, so it goes into the shared default env in `refreshPtyEnv` 629-661 after the port is bound (878), beside `DISPATCH_SERVER_URL`, which keeps its value; thread shells, the shim and `dispatch api` inside a thread then see it; the Codex app-server inherits it, and its default shell policy keeps it because the name has no KEY, TOKEN or SECRET), `packages/core/src/platform/inherited-env.ts` (drop `DISPATCH_BOX_TOKEN`, `OS_BOX_TOKEN`, `DISPATCH_AUTH`, `DISPATCH_AUTH_FILE`), tests `packages/core/tests/sessions/terminal-id-env.test.ts` (lines 59 and 76 use exact `toEqual`; change them to check `DISPATCH_TERMINAL_ID` and a `dtk_` `DISPATCH_AUTH`), `packages/core/tests/platform/inherited-env.test.ts`.

**13b: MCP injection.** Files: `packages/core/src/mcp/injection.ts` (a spec can set `authEnv: true`; then the Claude-style file gets `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`; the Codex CLI args get the literal `env.NAME` flags for the non-secret values and `env_vars=["DISPATCH_AUTH"]` for the same server; `codexThreadConfig` gets the literal key only when the caller passes `codexAuthLiteral`, and never `env_vars` for this server), `packages/core/src/sessions/service.ts` (structured Codex: pass `codexAuthLiteral` and add `shell_environment_policy.set.DISPATCH_AUTH` beside `DISPATCH_TERMINAL_ID` at 2628), tests `packages/core/src/mcp/injection.test.ts` (74-78 pin `codexThreadConfig`), `packages/core/tests/sessions/agency-mcp-injection.test.ts`, `packages/core/tests/sessions/injection-wiring.test.ts`. If Task 1 chose the Codex key file, write `DISPATCH_AUTH_FILE` (a `0600` file `keys/ID` in the data directory, deleted by `ThreadKeys` at revoke) instead of the literal, and the agency MCP and the shim read it through the resolver.

**13c: Hooks.** Files: `packages/core/src/providers/claude-code.ts` (134-154: add `headers: { Authorization: 'Bearer ${DISPATCH_AUTH}' }` and `allowedEnvVars: ['DISPATCH_AUTH']` when Task 1 confirmed them), `packages/core/src/sessions/service.ts` (370-373: write `hooks/ID.json` with mode `0600`), `packages/core/scripts/codex-notify.mjs`, `packages/core/scripts/grok-hook.mjs` (send `Authorization: Bearer` when `process.env.DISPATCH_AUTH` is a `dtk_` value; otherwise no header), `packages/core/src/providers/grok-home.ts` (133: `hooks.json` mode `0600`), tests `packages/core/tests/providers/providers.test.ts` and `packages/core/tests/routes/events.test.ts` (the existing hook tests), `packages/core/tests/scripts/hook-helpers.test.ts` (new: run each script with `node` against a local `http` server, with and without `DISPATCH_AUTH`, and assert the header and that argv holds no key).

**13d: Grok and opencode.** Files: `packages/core/src/providers/grok-home.ts` (119-124), `packages/core/src/providers/opencode-config.ts` (58, 72, 79: `0600` for `opencode.json` and `rules.md`; `environment.DISPATCH_AUTH` as Task 1 chose), `packages/core/src/sessions/mcp-config-sweep.ts` (also sweep `grok-homes/ID`, `opencode-homes/ID` and `keys/ID` of threads that are not alive, with the same one-minute age rule), tests `packages/core/tests/providers/opencode.test.ts` (28-37), `packages/core/tests/sessions/mcp-config-sweep.test.ts`. When a literal key is in a file, `ThreadKeys` deletes that file at revoke.

- [ ] For each part: tests first. Per harness and view (claude-code CLI and Pretty, codex CLI and Pretty, grok CLI and Pretty, opencode, Claude and Codex runners, role runs): the spawn env holds a key of the right kind; the shared default env holds none; the MCP config holds a reference where the harness supports one. **No key in argv:** every test in `key-lifecycle.test.ts`, `agency-mcp-injection.test.ts` and `injection-wiring.test.ts` scans the captured `command` and `args` of every spawn for `dtk_`, `dck_` and `dsk_`. Codex Pretty: `thread/start` and `thread/resume` carry the key as a literal (the fake Codex in `tests/routes/structured.test.ts:1300-1327` records them); the app-server argv and env do not. Codex CLI: argv has `env_vars=["DISPATCH_AUTH"]` and the literal non-secret values, and no key. Files holding a key have mode `0600`.
- [ ] Run each touched test file, FAIL, implement, PASS. Commit after each part: `feat(keys): deliver keys through env (13a)`, `(13b)`, `(13c)`, `(13d)`.

### Task 14: First-party helpers send the key

**Files:** modify `packages/core/src/overseer/agency-shared.ts` (`httpJson` 65-79 adds the header from `resolveCredential({ purpose: 'mcp' })`), `packages/core/src/overseer/agency-mcp.ts` (`apiBase` 45-47 uses `DISPATCH_API` and sends no key when it is unset; `watchesRequest` 912-928 and `ledgerRequest` 985-993 use the same header; a lazy `whoami` on the first tool call that needs identity, with the env ids as the stage 1 fallback when it fails; `complete_agent` sends `?force=1` when `force` is true; error text: `owner_only` becomes "Error: only the owner can do this. Ask the owner to do it in the browser.", `auth_required` becomes "Error: this thread's Dispatch key is not valid. Ask the owner to relaunch the thread.", other key errors show the daemon's `message`; `assertInProject` 827-838 shows a `401` or `403` as itself, not as "not in this project"), `packages/core/src/endless/memory-mcp.ts` (`apiBase` 16-18 and `requestJson` 188-199 send the header), `packages/core/src/auth/shim.ts` (`relayCommand` 112-119 runs `node DIST/auth/shim-relay.js URL SOURCE` instead of `curl`), create `packages/core/src/auth/shim-relay.ts`.

- [ ] Tests first: `tests/overseer/agency-mcp.test.ts` and `agency-mcp-ledger.test.ts` (they mock `global.fetch`): every request carries `Authorization: Bearer dtk_...` when `DISPATCH_AUTH` is set, and none when it is not; `DISPATCH_API` unset gives no key on the request; the `owner_only` error text; `complete_agent` with `force`. `tests/endless/memory-mcp.test.ts`: the header on every route. `tests/auth/shim.test.ts` (27, 86-123): the shim script holds no `curl`; running the relay against a local server sends the header from `DISPATCH_AUTH` and the `terminalId`; the URL is the only argument; with no `DISPATCH_AUTH` it sends no header.
- [ ] Run each file, FAIL, implement, PASS. Commit `feat(keys): MCP helpers and the shim send the key`.

### Task 15: Chat keys

**Files:** modify `packages/core/src/endless/turn-runner.ts` (spawn 192-197: mint `chat` with `startedBy` `user` for a typed message and `report` for a delivered report, put `DISPATCH_AUTH` in the spawn env beside `FIXED_CONTEXT_ENV`, revoke on the turn process exit), `packages/core/src/endless/summarizer-claude.ts` (74-80: `startedBy: 'summarizer'`, revoke on exit), `packages/core/src/endless/service.ts` (160: `memory.mcp.json` env gets `DISPATCH_API` and `"DISPATCH_AUTH": "${DISPATCH_AUTH}"`, mode `0600`; the file stays shared and holds no secret); tests `packages/core/tests/endless/*.test.ts` that cover the turn runner and the summarizer, `packages/core/tests/routes/endless.test.ts` (59-60 assert the file env).

- [ ] Tests first: a turn spawn env has a `dck_` key and `startedBy` `user`; a report turn has `report`; the summarizer key is `summarizer`; the key is revoked when the turn exits; the memory file has no key and mode `0600`; argv has no key.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): Chat turn and summarizer keys`.

### Task 16: Redaction wiring

**Files:** modify `packages/core/src/routes/terminals.ts` (conversation 104 and search 116: `redactKeysDeep` on the response), `packages/core/src/sessions/service.ts` (`lastAssistantText` 1370-1380, `formatAgentQuestion` 1239-1259, `noteAgentNeedsHelp` 1542-1555), `packages/core/src/endless/service.ts` (`report()` 303-330; `zoom` 461, `date` 466, `threads` 471, and the `/messages` read); test `packages/core/tests/keys/redaction-paths.test.ts` (new).

- [ ] Tests first: a `dtk_` value in a worker's last text is redacted in the conversation route, in the completion notice to the coordinator, in the question notice, in the blocked notice, in a thread report to Chat, and in the Chat memory reads.
- [ ] Run, FAIL, implement, PASS. Commit `feat(keys): redact keys wherever thread text travels`.

### Task 17: CLI

**Files:** modify `packages/cli/src/index.ts` (`rolesRequest` 324-344 sends the owner header from `resolveCredential({ purpose: 'cli' })`; `cmdAccess` 148-190 refuses in thread mode with "Run this in your own terminal, not in a Dispatch thread."; `dispatch status` prints the stage 1 counts from `GET /api/access/no-credential-stats` when the daemon answers; new `dispatch api METHOD PATH [--body FILE | --body -]` that prints the JSON answer and exits non-zero on a non-2xx status; `probeHttp` 113-127 stays credential-free; fix the stale comment at 280), tests `packages/cli/tests/commands.test.ts` (316, 359, 376 pin the `fetch` init; update them to expect the header), `packages/cli/tests/api.test.ts` (new).

- [ ] Tests first: `roles` sends `Authorization: Bearer TOKEN` from an injected token reader and never puts it in argv; inside a thread (`DISPATCH_AUTH=dtk_...`) `roles` sends the key (and the daemon will answer `owner_only`); `dispatch access` refuses with a `dtk_` key, with `DISPATCH_AUTH_FILE`, and with only `DISPATCH_TERMINAL_ID`; a `dsk_` key keeps owner mode; `dispatch api GET /api/sessions` prints the answer; `--body FILE` and `--body -` (stdin) send the body; an unreadable key file never falls back to the owner token; the reachability probe sends no credential.
- [ ] `cd packages/cli && node node_modules/vitest/vitest.mjs run tests/commands.test.ts > /tmp/ptk-test.log 2>&1`, and `tests/api.test.ts`. FAIL, implement, PASS. Commit `feat(cli): owner token on HTTP calls, dispatch api, thread mode`.

### Task 18: First-party flows pass with keys (the "no 403" test)

This task protects work in progress: every tool that an agent or Chat uses today must still succeed with its key.

**Files:** create `packages/core/tests/keys/first-party-flows.test.ts`.

- [ ] Write the test. Start `createApp` on a real port (`listen(0)`), set `DISPATCH_API`, seed a project with a coordinator, a worker (spawned by the coordinator), a peer thread, a role run, an endless worker, and a second project. Mint keys. Call the real `callTool` of `overseer/agency-mcp.ts` and `endless/memory-mcp.ts` in-process (the pattern of `tests/routes/endless.test.ts:255-284`), with `DISPATCH_AUTH` set per caller, for every tool: `spawn_agent`, `queue_agent`, `start_agent`, `list_agents`, `list_missions`, `message_agent`, `answer_agent` (with a seeded pending question), `read_agent`, `complete_agent`, `list_threads`, `read_thread`, `message_thread`, `watch_thread`, `unwatch_thread`, `list_watches`, `report_status`, every `ledger_*` tool (as the coordinator), and every memory MCP tool. Expected: no `401`, no `403`. The structured managers are capturing fakes, so no CLI runs.
- [ ] Add the forged cases from spec 9: a worker key with `source: 'user'`, with `caller` set to the coordinator, with `watcherTerminalId` of a peer, a spawn past depth 3, an answer to a held tool call, an owner-only route (`POST /api/secrets`, `POST /api/roles/NAME/enable`, `POST /api/claude-auth/...`, `POST /api/integrations`, `POST /api/terminals/ID/input`, `PATCH /api/terminals/ID`): each gets its `403` code.
- [ ] Run it. If a first-party tool fails, fix the rule or the helper (not the test), with its own failing test first. Commit `test(keys): every first-party tool passes with its key`.

### Task 19: No key in the log

**Files:** create `packages/core/tests/keys/no-key-in-log.test.ts`.

- [ ] Spy on `console.log`, `console.warn` and `console.error`; run a spawn (capturing managers), a refused call, a revoked-key call, a stats summary, and a structured exit with stderr. Assert that no captured line contains `dtk_`, `dck_` or `dsk_` followed by 43 characters. Run, fix if needed, commit `test(keys): no key in the daemon log`.

### Task 20: Docs

**Files:** modify `docs/network-access.md` (a "Thread keys" section: what a key is, that agents get `403` on owner-only actions, that no-credential calls still work in this release and are counted, how to see the counts with `dispatch status`, and `dispatch api` for scripts with no token in argv), `README.md` (one line under remote access pointing to it).

- [ ] Write the docs. Render-check with `marked` from `packages/web` (no `<a>` from stray angle brackets). Commit `docs(keys): thread keys and dispatch api`.
- The release note is written at the release step, not here. It must say: nothing visible changes; agents that call owner-only routes get `403`; `dispatch status` shows the no-credential counts; WSL users with the data directory on `/mnt/c` get no file privacy for literal key files (if Task 1 chose any); a Codex user's own `include_only` shell filter can drop the key from Codex shells; how to roll back.

### Task 21: Full suite and typecheck

- [ ] From the worktree root: `pnpm build > /tmp/ptk-build.log 2>&1` (the build runs `tsc` in every package; there is no separate typecheck script); read the log; expected no errors.
- [ ] `cd packages/core && node node_modules/vitest/vitest.mjs run > /tmp/ptk-core.log 2>&1`; then `packages/cli`; then `packages/web`. One at a time. Read each log. Expected: all pass, the same skip count as main.
- [ ] The repo-hygiene scan from the global constraints over `git diff main...HEAD` and the commit messages.

### Task 22: Restart mid-work test on a throwaway daemon (the go gate for stage 1)

A failure here blocks the stage 1 release (spec 7.1, 9). It costs real model usage on all four harnesses (use `haiku` for Claude workers) and takes about two hours.

**Setup**

- [ ] **Step 1: Build from the worktree root.** `pnpm build > /tmp/ptk-build.log 2>&1`. Confirm the build has the new code: `rg -c "dtk_" packages/core/dist/auth/principals.js` prints a number above 0.
- [ ] **Step 2: Pick the port and the scratch folder.** `S=/tmp/ptk-s1; P=3490; lsof -nP -iTCP:$P -sTCP:LISTEN` must print nothing; else use 3491 to 3499. Never 3456.
- [ ] **Step 3: Fake HOME with signed-in CLIs.** `mkdir -p $S/home $S/proj-a $S/proj-b $S/keys && chmod 700 $S/keys`. Symlink from the real home into `$S/home`: `.claude`, `.claude.json`, `.codex`, `.grok`, `.config/opencode`, `.local/share/opencode` (the recipe of the 2026-10-13 Chat end-to-end run). The fake home gets a fresh `.dispatch`, so no real role, schedule, project or token is visible to the test daemon. Test threads appear in the real CLI session histories; that is expected. Check each CLI under the fake HOME: `HOME=$S/home claude -p "Reply with the word ok." --model haiku`, `HOME=$S/home codex login status`, a one-line `grok` and `opencode` prompt. If one is not signed in, stop and report to the coordinator. Do not sign in for the owner.
- [ ] **Step 4: Helper scripts in `$S` (not in the repo).**

```js
// $S/save-key.mjs: a thread runs `node $S/save-key.mjs $S/keys/LABEL`; writes its own key, mode 0600
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], String(process.env.DISPATCH_AUTH ?? ''), { mode: 0o600 });
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
// $S/whoami-loop.mjs: a thread starts `nohup node $S/whoami-loop.mjs $S/nohup.out > /dev/null 2>&1 &`
// It writes its own pid to OUT.pid, so teardown kills exactly this process (never a pattern kill).
import fs from 'node:fs';
const out = process.argv[2];
fs.writeFileSync(out + '.pid', String(process.pid));
for (;;) {
  let s = 'ERR';
  try { s = String((await fetch(process.env.DISPATCH_API + '/api/whoami',
    { headers: { authorization: `Bearer ${process.env.DISPATCH_AUTH}` } })).status); } catch {}
  fs.appendFileSync(out, `${new Date().toISOString()} ${s}\n`);
  await new Promise((r) => setTimeout(r, 5000));
}
```

  The operator's own calls use the owner token through a header file, so they are not counted as `program`: `printf 'Authorization: Bearer %s\n' "$(cat $S/home/.dispatch/access-token)" > $S/owner.hdr; chmod 600 $S/owner.hdr`, then `curl -sS -H @$S/owner.hdr ...`. (The `printf` runs in the shell; the token is not in any argv.) Write this file after the first start, when the token file exists.
- [ ] **Step 5: Start the throwaway daemon.**

```bash
cd $WT   # the build worktree
HOME=$S/home PORT=$P DISPATCH_TELEMETRY=0 DISPATCH_WEB_DIST=$WT/packages/web/dist \
  nohup node packages/core/dist/server.js >> $S/daemon.log 2>&1 &
echo $! > $S/daemon.pid
```

  Ready when `$S/daemon.log` has `Dispatch server listening on port $P`. `export API=http://127.0.0.1:$P`.

**Work in progress**

- [ ] **Step 6: Create two projects** (`POST /api/sessions` with `workingDir` `$S/proj-a` and `$S/proj-b`, both `git init` first with one committed `NOTES.md`).
- [ ] **Step 7: One thread per harness and view in project A:** claude-code CLI, claude-code Pretty, codex CLI, codex Pretty (two of them, so two threads share the app-server), grok CLI, grok Pretty, opencode. Create each with `POST /api/sessions/A/terminals` and `{ "type": HARNESS, "label": LABEL, "config": { "transport": "structured" } }` for Pretty, or no `transport` for the CLI view (owner header). Each gets this first message (owner, `source: user`): "Run `node $S/save-key.mjs $S/keys/LABEL`. Call list_threads. Append the line `LABEL step 1` to `NOTES-LABEL.md`. Then run the shell command `sleep 600` and wait for it." One thread (claude-code Pretty) also starts `nohup node $S/whoami-loop.mjs $S/nohup.out > /dev/null 2>&1 &` before the sleep. Attach each CLI thread once with the terminal WebSocket (the `verify` skill recipe), so the CLI views are live.
- [ ] **Step 8: A coordinator with a worker in project A.** `POST /api/sessions/A/overseer/coordinator`. Message it: "Spawn one worker (agentType researcher, model haiku) with the task: append the numbers 1 to 300 to `COUNT.md`, one number per shell command `sleep 2`, then report_status done. Add a ledger note 'e2e-alpha'. Watch the worker." Wait until the worker row exists and `COUNT.md` grows.
- [ ] **Step 9: A Chat turn.** `POST /api/endless/send` with "Spawn a worker in project B that appends the line 'chat-worker step 1' to `NOTES.md` and then runs `sleep 600`. Tell me when it started." Wait until the worker row exists in project B.
- [ ] **Step 10: Snapshot before the restart** (owner header): for every thread `GET /api/terminals/ID` (status, config, label) and the message count of `GET .../conversation`; the coordinator's ledger through `sqlite3 -readonly $S/home/.dispatch/dispatch.db` (the ledger table) ; `shasum $S/proj-a/* $S/proj-b/*`; `GET /api/access/no-credential-stats`; `wc -l $S/nohup.out` (all `200`). Also check that `$S/keys` holds one file per thread with a `dtk_` prefix (Codex threads included).

**Restart 1: clean**

- [ ] **Step 11:** `kill -TERM $(cat $S/daemon.pid)`; wait for the process to exit; confirm the `nohup` job is still alive (`pgrep -f whoami-loop.mjs`). Start the daemon again as in step 5.

**Checks after each restart**

- [ ] **Step 12: Revive and use each one through its normal path.**
  - CLI threads: attach the terminal WebSocket (this relaunches and resumes them), then send the message below.
  - Pretty threads: send the message below (this runs `ensureStructuredAlive`).
  - The coordinator: wait for the kickstart (`kickstartInterruptedAgents`), then message it "Call ledger_list, read the worker with read_agent, then report_status done with summary 'after-restart'."
  - Chat: send a new Chat message "List the threads in project B and tell me the worker's status."
  - The message to each thread: "Run `node $S/save-key.mjs $S/keys/LABEL-2`. Call list_threads. Send message_thread 'ping' to the thread labelled PEER. Append `LABEL step 2` to `NOTES-LABEL.md`. Then report_status done with summary 'after-restart'."
- [ ] **Step 13: Pass conditions, all of them:**
  1. Every thread, the coordinator, the worker and Chat answer, and `GET /api/terminals/ID` shows the `after-restart` summary (or the worker finishes its count).
  2. `$S/daemon.log` since the restart has no key refusal line (`rg '\[keys\] refused' $S/daemon.log`) and no `401` or `403` for any of these terminals.
  3. `GET /api/access/no-credential-stats` shows `program` total 0 since the restart (every first-party helper sent a key; the operator used the owner header).
  4. Each `LABEL-2` key differs from `LABEL` (a new key per process). `node $S/call.mjs $S/keys/LABEL GET /api/whoami` gives `401` for every old key; `LABEL-2` gives `200`.
  5. `$S/nohup.out` shows `200` lines before the restart and only `401` lines after it; the thread that started it still works (condition 1).
  6. Data is the same: labels, config, the ledger note `e2e-alpha`, conversation counts (equal or higher, never lower), the files in both projects (unchanged except the new appended lines).
  7. Nothing is stuck: after 10 minutes no thread shows `running` with no output, no thread needs a manual relaunch, no queued item is lost.
  8. Forged calls from a live key: `node $S/call.mjs $S/keys/A-claude-pretty-2 POST /api/secrets` gives `403 owner_only`; a message with `source: user` gives `403 identity_mismatch`; a ledger call from a worker key gives `403`.

**Restart 2: hard kill**

- [ ] **Step 14:** Give each thread a new long task ("Append `LABEL step 3`, then `sleep 600`"), wait until they run, then `kill -9 $(cat $S/daemon.pid)`. Start again (step 5) and repeat steps 12 and 13 with `LABEL-3`.

**Codex app-server crash**

- [ ] **Step 15:** With both Codex Pretty threads mid-task, find the app-server: `pgrep -f "codex app-server" -P $(cat $S/daemon.pid)` (check that the pid is a child of the throwaway daemon, never of the live one). `kill -9` it. Wait for the resume. Then each Codex Pretty thread runs `node $S/save-key.mjs $S/keys/LABEL-4`, calls list_threads and report_status. Pass: `LABEL-4` equals `LABEL-3` (same key), every call succeeds, no refusal in the log.

**Teardown and record**

- [ ] **Step 16:** `kill -TERM $(cat $S/daemon.pid)`; `kill $(cat $S/nohup.out.pid)`. Never `pkill -f` or `killall`: a pattern kill can match the owner's live threads (it did on 2026-10-12). Confirm with `pgrep -fl whoami-loop` (read only) that the job is gone, and with `lsof -nP -iTCP:$P -sTCP:LISTEN` that the port is free. Delete `$S/keys` and `$S/owner.hdr`. Keep `$S/daemon.log`.
- [ ] **Step 17:** Write the results into the build record (`docs/superpowers/plans/2026-10-23-per-thread-key-stage-1-build-record.md`): versions, the pass table per condition, per restart and per harness, and every failure with its fix. A failure blocks the release. Fix it test first and run the failed part again.

### Task 23: Reviews and hand-off

- [ ] Two independent code reviews of the branch (Opus, and Codex `gpt-6-astra`), at most two rounds; a third round only for a High or a secret finding that a normal run can hit. Fix test first. Run Task 22 again if a fix touches spawn, delivery, the gate or a rule.
- [ ] Stop with local commits and the build record. A draft PR, a merge, the version bump, the release note and any deploy each need the owner's own approval.

## How stage 1 avoids breaking anyone's environment or work in progress

- **Nothing that works today with no credential stops working.** The access gate keeps its v3.4.1 rules. A helper whose key did not arrive (an older CLI, a harness filter, a managed setting that blocks the hook header) sends no credential, exactly as today, and the daemon counts it. It never fails closed in stage 1, and it never uses the owner token.
- **Only key holders meet new rules,** and Task 18 runs every first-party tool with its key against the real routes. A rule that refuses a first-party call is a bug in the rule, fixed before release.
- **The browser, the phone, the CLI and the owner's scripts** carry no key, so the key rules never apply to them. No cookie, no sign-in page, no new prompt.
- **No stored state to migrate.** Keys are in memory only; no schema change; no new file is needed to start. Rollback is a plain version change.
- **An update restarts the daemon, as every update does.** The restart test (Task 22) proves that each harness, view, coordinator, worker and Chat comes back with a new key, with its data intact and nothing stuck.
- **Other users.** WSL2: the daemon, threads and helpers all run inside WSL, so the code path is the Linux one; the Windows browser is unchanged in stage 1. Older harness versions: an unsupported config field is ignored and the caller is counted, not refused. The hosted box: the box gate starts to admit keys and the owner token, and a key is as narrow as on a laptop; an e2e run on a box is not possible here, so the box is covered by unit tests only (open item for the release note).

## Rollout and rollback (for the release step, not for this build)

- **Stage 1 release:** the next minor (for example v3.5.0). Gate: Task 22 passed on the release commit.
- **On each machine:** `dispatch update` restarts the daemon, as every update does. Every running thread dies and comes back through its normal revive path with a new key. A thread from v3.4.1 that survives (a detached job) has no key and keeps working with no credential (counted).
- **Rollback:** in the repo, `git checkout v3.4.1 && ./bin/dispatch build && ./bin/dispatch restart`. Keys live only in memory and stage 1 changes no schema, so v3.4.1 runs on the same data. The only stored change is `spawnDepth: 0` on new root threads, which v3.4.1 reads as before. After a rollback, do not run `dispatch update` until a fixed release exists, because it moves to the newest release tag.
- **Stage 2 go conditions** (spec 7.1, unchanged): the Codex check and every end-to-end harness row passed; the `program` count on the owner's machine holds only scripts that moved to `dispatch api`; at least one week of stage 1.

## Self-review against the spec

- 6.1 principals: Tasks 2, 5, 7, 11 (role runs, plus the watch routes). 6.2 keys: Tasks 2, 12. 6.3 delivery: Tasks 1, 13, 14, 15; redaction Task 16; inherited env 13a. 6.4 scope: Tasks 6, 8, 9, 10, 11; upgrades Task 5. 6.5 lifecycle: Task 12. 6.7 CLI: Tasks 4, 17. 6.8 platforms: box in Task 5; WSL needs no code in stage 1 (release note). 6.9 logs: Tasks 5, 6, 19. Section 9 tests: Tasks 2 to 19, end to end Task 22. Section 10 files: all listed above except the stage 2 files (`one-time-code.ts`, the `#code=` sign-in, `dispatch open`).
- Not in stage 1 by design: 6.6 (stage 2), 6.10 (stage 3), the repo scripts and `verify` skill change (stage 2 release).
- Plan decisions where the spec was silent or out of date: message `source` stays `coordinator` for every key; stage 1 helpers with no key send no credential (never the owner token); the no-credential log is first-seen plus hourly; role runs keep the watch routes; the Claude hook uses `headers` with `allowedEnvVars`.
