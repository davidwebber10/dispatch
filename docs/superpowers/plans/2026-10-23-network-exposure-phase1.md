# Network exposure Phase 1 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or subagent-driven-development. Steps use checkbox syntax. Every task is test first: write the test, see it fail, write the code, see it pass, commit.

**Goal:** Build the Phase 1 request gate from `docs/superpowers/specs/2026-10-22-network-exposure-design.md` (sections 7.1 to 7.15), plus security headers (SEC-09) and a private data directory (SEC-18).

**Architecture:** One pure async decision function (`decide`) takes the facts of a request (peer address, Host, Origin, cookie, bearer, Tailscale identity) and returns allow or deny. A thin Express middleware and the `upgrade` handler in `server.ts` call it. Four small modules hold the facts: token and cookie, known hosts, Tailscale lookups, headers. The listen address does not change.

**Tech stack:** TypeScript, Express 4, `ws`, vitest, supertest. Node 18 or later. macOS and Linux (including WSL2).

## Global Constraints

- The gate runs after the base-path strip and the box-token check, before `express.json`.
- Credential-free access: loopback peer (or WSL gateway peer) with a known Host; or an owner Tailscale peer with a Tailscale Host. Nothing else.
- Same Tailscale user only (NE-3). No switch to turn the gate off (NE-4).
- Token file `access-token` mode `0600`. Cookie `dispatch_access`, value `HMAC-SHA256(token, "dispatch-access-cookie-v1")`, `HttpOnly`, `SameSite=Lax`, `Max-Age` 400 days.
- Login: `POST /api/access/login`, 10 failed tries per peer per minute, then `429`.
- Never put the token in argv, logs or the startup line.
- No process-wide umask change (spec 7.14). No em-dashes in docs.
- Run one vitest process at a time (memory). Command: `node node_modules/vitest/vitest.mjs run <file>` from `packages/core`.
- No version bump, no release note file, no merge. Draft PR only.

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/auth/access-token.ts` (new) | token file, rotate, cookie value, cookie parse |
| `packages/core/src/auth/known-hosts.ts` (new) | host and origin parsing, loopback names, `access.json` with mtime cache |
| `packages/core/src/auth/tailscale-access.ts` (new) | Tailscale self facts and owner-peer check, with cache |
| `packages/core/src/auth/access-gate.ts` (new) | `decide`, middleware, upgrade check, login route, rate limit |
| `packages/core/src/auth/signin-page.ts` (new) | inline sign-in HTML |
| `packages/core/src/auth/security-headers.ts` (new) | SEC-09 middleware |
| `packages/core/src/auth/private-dir.ts` (new) | SEC-18 `lockDownDataDir` |
| `packages/core/src/platform/{types,darwin,linux,wsl}.ts` | `isHostGatewayPeer(addr)` |
| `packages/core/src/files/reveal.ts` | export `hostnameOf` |
| `packages/core/src/server.ts` | wire headers, gate, login, upgrade check, lock-down, startup line |
| `packages/core/package.json` | export `./access` for the CLI |
| `packages/cli/src/index.ts` | `dispatch access` commands, status line |
| `packages/web/src/api/client.ts`, `main.tsx` | reload on 401 |
| `docs/network-access.md`, `README.md`, `docs/cloudflare.md` | user docs |

---

### Task 1: Token, cookie, known hosts

**Files:** create `auth/access-token.ts`, `auth/known-hosts.ts` and tests `access-token.test.ts`, `known-hosts.test.ts`; modify `files/reveal.ts` (export `hostnameOf`).

**Produces:**
- `ensureAccessToken(dataDir): string`, `rotateAccessToken(dataDir): string`, `readAccessToken(dataDir): string | null`
- `cookieValue(token): string`, `COOKIE_NAME`, `parseCookies(header: string | undefined): Record<string,string>`
- `originHostPort(origin: string): { host: string; port: string } | null` (null for `null`, junk)
- `createAccessConfig(dataDir)`: `{ allowedHosts(): string[]; allowedOrigins(): string[]; addHost(n); removeHost(n) }`, re-read when the file mtime changes
- `isLoopbackName(name)`; `normalizeHostHeader(host): string | null` (lowercase hostname, no port, brackets removed)

Tests (written first):
- [ ] `ensureAccessToken` creates a 43 character base64url token with mode `0600` under a `0022` umask, and returns the same token on the second call. `rotate` changes it.
- [ ] `cookieValue` is deterministic, differs per token, and is not the token.
- [ ] `parseCookies('a=1; dispatch_access=xyz')` works; a malformed header gives `{}`.
- [ ] `normalizeHostHeader`: `Localhost:3456`, `[::1]:3456`, `127.0.0.2`, `a.ts.net.` and empty cases.
- [ ] `originHostPort('null')` is null; `http://x:3000` gives host `x`, port `3000`; default ports resolve (80, 443).
- [ ] `addHost` then `allowedHosts()` shows the name; a changed mtime reloads; a corrupt file gives `[]`.

### Task 2: Tailscale access facts

**Files:** create `auth/tailscale-access.ts`, `tailscale-access.test.ts`.

**Produces:** `isTailscaleAddress(addr)`; `createTailscaleAccess({ exec, now? })` with `self(): Promise<{ userId: number; names: string[]; ips: string[] } | null>` (names are lowercase MagicDNS name without the trailing dot, and short host name) and `isOwnerPeer(addr): Promise<boolean>`. `exec(bin, args): Promise<string>` is injected; production tries `tailscale`, the macOS app binary, then `tailscale.exe`. Cache: self 60 s; owner results 5 minutes allowed, 30 seconds refused.

Tests (fake exec):
- [ ] address ranges: `100.64.0.1`, `100.127.255.255`, `::ffff:100.100.1.1`, `fd7a:115c:a1e0::1` are Tailscale; `100.128.0.1`, `192.168.1.5`, `127.0.0.1` are not.
- [ ] same user: true. Other user: false. Tagged node (`Tags` non-empty): false. Whois fails: false. CLI missing: `self()` null and `isOwnerPeer` false.
- [ ] cache: second call does not exec; after 31 s a refused result re-runs; after 301 s an allowed result re-runs.

### Task 3: The decision function

**Files:** create `auth/access-gate.ts` (decide part), `access-gate.test.ts`; modify `platform/types.ts`, `darwin.ts`, `linux.ts`, `wsl.ts` (`isHostGatewayPeer`), platform conformance test if it lists keys.

**Produces:**
```ts
export interface GateRequest {
  remoteAddress: string | undefined; host: string | undefined; origin: string | undefined;
  secFetchSite: string | undefined; authorization: string | undefined; cookie: string | undefined;
  tailscaleUserLogin: string | undefined; tailscaleFunnel: string | undefined;
  isApi: boolean; isUpgrade: boolean;
}
export interface GateDeps {
  token: string; isGatewayPeer(addr: string): boolean; config: AccessConfig;
  tailscale: { self(): Promise<TsSelf | null>; isOwnerPeer(a: string): Promise<boolean> };
}
export type Decision = { ok: true; via: 'credential' | 'local' | 'tailscale' } | { ok: false; status: 401 | 403; error: 'auth_required' | 'origin_refused' };
export function decide(req: GateRequest, deps: GateDeps): Promise<Decision>;
```

Rules, in this order (spec 7.1, 7.3, 7.4):
1. Credential: `Bearer TOKEN` or a cookie equal to `cookieValue(token)`, constant time. Then the Origin check.
2. Local: peer is loopback or gateway, and Host is known: loopback name, an `allowedHosts` entry, or a Tailscale name only with `tailscaleUserLogin` and no `tailscaleFunnel`.
3. Tailscale: peer is a Tailscale address, `isOwnerPeer`, Host is a Tailscale name or address.
4. Else `401 auth_required`.
Origin check (after 1 to 3): no Origin is fine; same host and port as Host is fine; both loopback is fine only when `secFetchSite` is absent or `same-origin` (tightening of spec 7.4, see PR body); `access.json` origin is fine; `Origin: null` is refused. `Sec-Fetch-Site` of `cross-site` or `same-site` on `/api` or an upgrade is refused unless the origin is allow-listed. Refusal is `403 origin_refused`.

Tests (table, one per break-list row of spec 7.11 plus extras):
- [ ] loopback + `localhost:3456`, `127.0.0.1`, `[::1]`, `::ffff:127.0.0.1` allowed; loopback + `evil.example` denied (rebinding).
- [ ] LAN peer `192.168.1.9` + any Host denied; with bearer allowed; with a good cookie allowed; with a wrong cookie denied.
- [ ] gateway peer + `localhost` allowed; gateway peer + `evil.example` denied; non-gateway private peer + `localhost` denied.
- [ ] ts.net Host from loopback: allowed with `tailscaleUserLogin`; denied without; denied with `tailscaleFunnel`.
- [ ] Tailscale peer: owner + `machine.ts.net` allowed; other user denied; owner + `evil.example` denied; owner + LAN-style Host denied.
- [ ] `allowedHosts` entry passes from loopback and not from a LAN peer; removed entry stops passing.
- [ ] Origin: foreign denied for GET, POST and upgrade; `null` denied; same-origin allowed; Vite case (`localhost:5173` to `localhost:3456`, `same-origin`) allowed; same case with `same-site` denied; `cross-site` without Origin on `/api` denied; non-API navigation with `cross-site` allowed.
- [ ] SEC-03: foreign Origin with credential still denied (a cookie holder visited an evil page).

### Task 4: Middleware, sign-in, login, headers

**Files:** modify `auth/access-gate.ts` (add `createAccessGate`), create `auth/signin-page.ts`, `auth/security-headers.ts`, tests `access-gate-http.test.ts`, `security-headers.test.ts`.

**Produces:** `createAccessGate(deps & { basePath: string; now?: () => number })` returning `{ middleware: RequestHandler; upgradeAllowed(req: IncomingMessage): Promise<Decision>; loginRoute: RequestHandler[] }`; `securityHeaders: RequestHandler`.

Behaviour:
- Middleware allows `POST /api/access/login` through the rate limiter and Origin check but not the credential check. Everything else uses `decide`.
- Denied `/api` gets JSON; denied `GET` HTML gets the sign-in page with 401 and `Cache-Control: no-store`; other denied methods get JSON.
- Login reads `{ token }` from a 4 kb JSON body, compares in constant time, sets the cookie (`Secure` when `X-Forwarded-Proto: https` came from a loopback or gateway peer), returns `{ ok: true }`. Failures count per peer: the 11th failure in 60 s returns 429.
- Sign-in page script reads `#access=TOKEN`, posts it, clears the fragment.
- Headers (spec 7.13) on every response, set before the gate.

Tests (supertest with a fake peer is not possible, so build an Express app and call the middleware with a stubbed `remoteAddress` through a small test wrapper that overrides `req.socket.remoteAddress`):
- [ ] denied API call gives 401 JSON; denied page gives 401 HTML containing the form; login with a good token sets an `HttpOnly; SameSite=Lax` cookie and the cookie then opens `/api/x`; wrong token gives 401; 11th wrong token gives 429; foreign-Origin login gives 403.
- [ ] rotation: a cookie from the old token is refused after `rotate` (the gate re-reads the token file by mtime).
- [ ] headers present on 200, 401 and 403 responses.

### Task 5: Private data directory

**Files:** create `auth/private-dir.ts`, `private-dir.test.ts`.

**Produces:** `lockDownDataDir(dataDir: string, extraDirs?: string[], warn?: (m: string) => void): void`.

Tests (temp dir, `process.umask(0o022)` restored after):
- [ ] a missing directory is created `0700`; an existing `0755` directory becomes `0700`; `dispatch.db`, `-wal`, `-shm`, `access-token`, `access.json` go to `0600`; absent files are skipped; a `chmod` error warns and does not throw; the process umask is unchanged.
- [ ] a new empty `dispatch.db` is pre-created `0600` so SQLite copies the mode to `-wal` and `-shm`.

### Task 6: Wire the server

**Files:** modify `server.ts` (around the data dir creation, `app.use(boxGate)`, the `upgrade` handler, after `listen`), `package.json` (export `./access`), `platform/*`.

- [ ] Call `lockDownDataDir(dataDir, [platform.logDir()])` right after `dataDir` is known.
- [ ] `ensureAccessToken(dataDir)`; build config, Tailscale access (real `execFile`), gate.
- [ ] `app.use(securityHeaders)` first (before the base-path strip is fine), then the gate after `boxGate`, then `express.json`.
- [ ] Mount `POST /api/access/login`.
- [ ] In the `upgrade` handler, after `upgradeAllowed(BOX_TOKEN, ...)`: `const d = await gate.upgradeAllowed(request); if (!d.ok) { socket.write('HTTP/1.1 ' + d.status + ' ...\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }`. The handler becomes async; wrap in `.catch(() => socket.destroy())`.
- [ ] Startup line (spec 7.9) without the token.
- Integration test `access-integration.test.ts`: real listen on port 0; loopback request passes; `Host: evil.example` gives 401; foreign-Origin WebSocket to `/api/events`, the terminal socket and the structured socket is refused; cookie-bearing, same-origin WebSocket connects; SEC-03 cases (text/plain POST to mkdir, multipart POST, DELETE with foreign Origin) give 403; hooks path `POST /api/events/claude/ID` on `127.0.0.1` still works with no token.

### Task 7: CLI

**Files:** modify `packages/cli/src/index.ts`, test `index.test.ts` (existing pattern).

- [ ] `dispatch access` prints the token and sign-in steps (token is read from `ctx.dataDir`, created if missing, printed to stdout only). `dispatch access --link HOST` prints `http://HOST:PORT/#access=TOKEN`. `rotate`, `allow-host NAME`, `remove-host NAME`, `list-hosts`.
- [ ] `dispatch status` adds the network line.
- Tests use a temp `dataDir` and capture `console.log`.

### Task 8: Web client

**Files:** modify `packages/web/src/api/client.ts` (`req()`), `packages/web/src/main.tsx` (shell poll), tests next to them.

- [ ] On `401` with `error: 'auth_required'`, call `location.reload()` once (guard with a `sessionStorage` flag cleared after a successful response). The shell poll reloads on `401`.

### Task 9: Docs

- [ ] `docs/network-access.md` (model, setups, token use without argv, rotate), a README remote-access paragraph, one paragraph in `docs/cloudflare.md` (spec 6.6).

### Task 10: Verify and review

- [ ] Full test suite once (core, cli, web, one at a time).
- [ ] Throwaway daemon on 3490 with its own HOME: rerun the overview attacks T-1 to T-5 and the localhost checks. Record the results in the PR body.
- [ ] Open the draft PR. Two review rounds. Fix P1 and P2.

## Self-review against the spec

Covered: 7.1 to 7.9 (Tasks 1 to 6, 8), 7.10 file list (all), 7.13 (Task 4), 7.14 (Task 5), 7.15 (PR body), 10.1 tests (Tasks 3, 4, 6). Not in Phase 1: pairing, settings page, listen address (Phase 2). Release note and version bump are left for the release step.
