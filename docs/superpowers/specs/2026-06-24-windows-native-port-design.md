# Dispatch — Native Windows Support (Platform Abstraction Layer)

**Date:** 2026-06-24
**Status:** Design approved; implementation plan to follow.
**Target:** Windows 11 (native, not WSL). macOS behavior unchanged.

## Goal

Run the Dispatch daemon natively on Windows 11 — terminals, agents (Claude Code +
Codex), web client, files, secrets, and transcripts/Normal Mode all working — and ship it
for others (robust install, automated CI, docs). Introduce a clean platform-abstraction
layer so platform-divergent behavior lives in one place rather than as scattered
conditionals.

## Decisions (confirmed)

1. **Goal:** ship for others — distributable, robust install, docs, automated Windows CI.
2. **Scope (v1):** **core parity** — terminals, agents, web client, files, secrets,
   transcripts/Normal Mode. **Deferred (graceful no-op on Windows):** the browser/OAuth
   capture shim and the Tailscale-status integration.
3. **Daemon lifecycle:** **Task Scheduler at-logon task** (per-user, runs in the user's
   logon session with their env + `%USERPROFILE%` credentials, restart-on-failure). This
   mirrors the macOS per-user **LaunchAgent** semantics, with no stored service password.
4. **CLI:** **rewrite `bin/dispatch` (bash) as one cross-platform Node CLI**; platform
   specifics delegate to the abstraction layer. pnpm auto-generates the `dispatch` (unix)
   and `dispatch.cmd` (Windows) shims.
5. **Architecture:** **single platform-abstraction module** (`Platform` interface +
   `darwin.ts`/`win32.ts`), resolved once at startup by `process.platform`.
6. **Verification:** **no local Windows 11 machine** — a coworker performs the runtime
   bring-up. Therefore: maximize macOS-runnable unit tests of the `win32` logic, add a
   GitHub Actions `windows-latest` CI gate, and ship a coworker bring-up checklist.

## Non-goals (v1)

- Linux support (the interface leaves room; no Linux impl now).
- Any change to current macOS behavior — the `darwin` impl wraps existing code paths.
- In-app browser/OAuth relay on Windows (deferred; see §5).
- Tailscale-status panel on Windows (deferred; see §5).

## Current state (why this is needed)

There is **no platform abstraction today** — the code implicitly assumes macOS/Unix:

- `bin/dispatch` (257-line bash) drives launchd (`launchctl`, plist, `~/Library/...`).
- `sessions/service.ts` hardcodes `/bin/zsh` for shell terminals.
- `server.ts` resolves login PATH via `$SHELL -ilc 'echo $PATH'` and lists processes via
  `execSync('ps -eo pid')`.
- `auth/shim.ts` writes a `#!/bin/sh` browser-capture shim and sets `BROWSER`/`GH_BROWSER`.
- `claude-code.ts` / `sessions/service.ts` encode the Claude transcript dir as
  `~/.claude/projects/<workDir with "/" → "-">`.
- `routes/state.ts` shells out to a hardcoded `/Applications/Tailscale.app/...` path.

node-pty `1.1.0` (already merged) ships `win32-arm64`/`win32-x64` prebuilts, so the PTY
layer is already Windows-capable (ConPTY on Win11).

## Components

### 1. `packages/core/src/platform/` — the abstraction

One `Platform` interface, two implementations (`darwin.ts`, `win32.ts`), an `index.ts`
that resolves the active platform once at startup via `process.platform` and exports a
singleton. All consumers depend on the interface; **no `if (process.platform === ...)`
outside this module.**

```ts
interface Platform {
  defaultShell(): { command: string; args: string[] };
  // mac: { command: $SHELL || '/bin/zsh', args: [] }
  // win: pwsh.exe if resolvable, else powershell.exe; args: ['-NoLogo']

  resolveLoginPath(): string | undefined;
  // mac: run `$SHELL -ilc 'echo -n <sentinels>$PATH<sentinels>'`, extract PATH
  // win: undefined — Task Scheduler logon tasks already inherit the user's
  //      registry PATH; no shimming needed

  dataDir(): string;   // both: path.join(os.homedir(), '.dispatch')  (works on Windows)
  logDir(): string;    // mac: ~/Library/Logs/dispatch ; win: %LOCALAPPDATA%\dispatch\logs

  resolveCommand(name: string): string | null;
  // mac: `which`; win: `where.exe` — resolves claude/codex (.cmd shims) to a real
  // target node-pty/ConPTY can spawn

  listProcessIds(): number[];
  // mac: `ps -eo pid`; win: `tasklist` (CSV) — used to reap orphaned PTYs

  claudeProjectDir(workDir: string): string;
  // the `~/.claude/projects/<encoded>` dir for a working directory; encoding matches
  // the host platform's Claude Code (see Risks — Windows encoding to confirm)

  installBrowserShim(opts: BrowserShimOptions): BrowserShimEnv;
  // mac: writes the dispatch-open shim + returns BROWSER/GH_BROWSER/PATH env
  // win: no-op — returns {} (OAuth opens the real system browser; see §5)

  daemon: DaemonController;  // §2
}
```

The `darwin` impl is a thin wrapper around the existing code (extracted verbatim where
possible). The `win32` impl is new.

### 2. `DaemonController` — process lifecycle

```ts
interface DaemonController {
  install(opts: { port: number; env: Record<string,string> }): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  restart(): void;
  status(): { loaded: boolean; pid?: number };
}
```

- **darwin:** existing launchd/plist behavior (write plist → `launchctl bootstrap` →
  `kickstart`), unchanged.
- **win32 (Task Scheduler at-logon):**
  - `install` generates a scheduled-task **XML** and registers it with
    `schtasks /Create /TN Dispatch /XML <file> /F`. The XML specifies:
    - Trigger: **LogonTrigger** for the current user.
    - Principal: run as the current user, **interactive** logon type (so it lives in the
      user's session with their env + `%USERPROFILE%`); highest available privileges.
    - Settings: **RestartOnFailure** (interval 1 min, count 3), `StopIfGoingOnBatteries`
      false, `ExecutionTimeLimit` PT0S (no limit), `MultipleInstancesPolicy` IgnoreNew.
    - Action: `node <repo>\packages\core\dist\server.js` with `PORT` and other env baked
      in; stdout/stderr redirected to `logDir()`.
  - `start`/`stop` → `schtasks /Run` / `schtasks /End`; `status` → `schtasks /Query`
    (+ resolve PID via the task or a pidfile in `dataDir()`); `uninstall` →
    `schtasks /Delete /F`.

### 3. `packages/cli` — the cross-platform CLI

Port `bin/dispatch` to Node/TS. Same commands: `build`, `install`, `uninstall`, `start`,
`stop`, `status`, `restart`, `update`, `run`, `logs`. OS-specific work routes through
`platform.daemon` and helpers. `update` = `git pull --ff-only` + rebuild + restart on both
platforms. Root `package.json` `bin` maps `dispatch` → the built CLI entry; pnpm generates
the `dispatch` shell stub and `dispatch.cmd` on install. Keep `bin/dispatch` as a thin
shim that execs the Node CLI during the transition, or replace it outright (decided in the
plan).

### 4. Runtime wiring (route existing call sites through the interface)

- `sessions/service.ts`: `'/bin/zsh'` → `platform.defaultShell()`.
- `server.ts`: `resolveShellPath()` → `platform.resolveLoginPath()`; `execSync('ps …')` →
  `platform.listProcessIds()`; data dir → `platform.dataDir()`.
- `providers/claude-code.ts`, `sessions/service.ts`: transcript dir →
  `platform.claudeProjectDir(workDir)`.
- provider command spawning: resolve `claude`/`codex` via `platform.resolveCommand()`
  before handing to node-pty (Windows `.cmd` shims).
- `auth/shim.ts`: gated behind `platform.installBrowserShim()`.
- `routes/state.ts`: Tailscale path guarded; `win32` returns "unavailable".

## Deferred on Windows (graceful, not broken) — §5

- **Browser/OAuth capture shim:** `installBrowserShim` is a no-op on Windows; agent OAuth
  opens the system browser directly (no in-app relay). Core auth still works. Documented
  as a known v1 gap; revisit with a `.cmd`/`.ps1` shim later.
- **Tailscale status:** returns "unavailable" on Windows instead of erroring. Revisit with
  the Windows Tailscale CLI path later.

## Error handling / degradation

Unsupported-on-this-platform features return a structured "unavailable" result that the
web client renders as a disabled/empty state — never an unhandled throw. The platform
selector throws a clear startup error only for a genuinely unsupported `process.platform`
(e.g. not `darwin`/`win32`).

## Testing strategy

Because all divergence lives behind the interface, the **logic** is unit-testable on
macOS:

- **macOS unit tests** (run in normal CI here): `win32` impl pure logic — scheduled-task
  XML generation, `defaultShell`/`resolveCommand` argument construction, `tasklist` CSV
  parsing, `claudeProjectDir` encoding, browser-shim no-op. Call the `win32` impl directly;
  no Windows needed for logic coverage.
- **GitHub Actions `windows-latest` CI** (new workflow): `pnpm install` (exercises the
  node-pty prebuilt + the `fix-node-pty-perms` postinstall as a no-op on Windows), build
  all packages, run the full unit suite on real Windows. Automated gate independent of any
  local machine.
- **Coworker bring-up checklist** (runtime-only, can't be done in CI):
  1. `dispatch install` → confirm the scheduled task registers and the daemon serves
     `http://localhost:3456`.
  2. Open the web client; create a **shell** terminal → confirm a real PTY spawns and
     streams (ConPTY).
  3. Create a **Claude Code** terminal → confirm it spawns, and confirm the transcript dir
     under `%USERPROFILE%\.claude\projects\…` matches `claudeProjectDir()` (adjust the
     encoding if not — see Risks).
  4. Run a headless agent → confirm run + transcript replay.
  5. `dispatch restart`/`update` → confirm the task survives and the daemon comes back.
  6. Confirm deferred features degrade gracefully (no crash on the Tailscale panel; OAuth
     opens the system browser).

## Risks / assumptions

- **Codex on Windows:** Claude Code supports Windows; Codex CLI Windows support must be
  confirmed. If unsupported, Codex degrades to "unavailable" on Windows (Claude still
  works); not a blocker for v1.
- **Claude transcript encoding:** `claudeProjectDir()` must match Windows Claude Code's
  actual `%USERPROFILE%\.claude\projects\<encoded>` scheme byte-for-byte. Confirmed during
  bring-up (checklist step 3); the encoding is isolated to one method so a fix is local.
- **`.cmd` spawn via ConPTY:** `resolveCommand` resolves the real target; worth an early
  coworker smoke test (checklist step 2–3).
- **Data dir on Windows:** `os.homedir()/.dispatch` works on Windows; kept for parity. If
  a `%APPDATA%` location is preferred later, it is a one-line change in `dataDir()`.

## Phasing (for the implementation plan)

1. Introduce the `Platform` interface + `darwin` impl; route existing call sites through it
   (pure refactor, macOS behavior identical; all current tests stay green).
2. Add the `win32` impl (logic) + macOS unit tests for it.
3. Rewrite the CLI as the cross-platform Node CLI; `darwin` lifecycle parity.
4. `win32` `DaemonController` (Task Scheduler) + CLI wiring.
5. GitHub Actions `windows-latest` CI workflow.
6. Docs: Windows section in `README.md` + `AGENTS.md`, and the coworker bring-up checklist.
7. Coworker runtime bring-up; fix encoding/spawn issues surfaced.
