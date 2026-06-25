# Agent setup instructions

You are an AI coding agent setting up **Dispatch**. Follow these steps in order for the
user's operating system. They are **idempotent** — safe to re-run. Stop and ask the user
only when a step needs a credential or a decision you can't make safely.

## Goal

A running Dispatch daemon on `http://localhost:3456`, optionally exposed publicly via
Cloudflare Tunnel + Access, with the user's agent CLIs (Claude Code, Codex) installed and
authenticated so Dispatch can spawn them.

---

## macOS setup

### 0. Confirm the environment (macOS)

```bash
uname -s            # expect: Darwin (macOS). The daemon is launchd-based.
node -v             # need >= 18
pnpm -v             # need >= 9  (install: npm i -g pnpm  OR  corepack enable)
git --version
```

If Node or pnpm is missing, install them (Homebrew: `brew install node pnpm`) before continuing.

### 1. Verify the agent CLIs are installed and authenticated (macOS)

Dispatch does **not** log these in for you — it spawns them as terminals, so they must already
be on the same `PATH` and signed in as the user who will run the daemon. See
[`docs/providers.md`](docs/providers.md) for details.

```bash
command -v claude && claude --version    # Claude Code
command -v codex  && codex --version     # Codex
```

- If a binary is missing, install it (see `docs/providers.md`) — do **not** guess the package name; use the one documented there.
- **Authentication is interactive.** Do not attempt to automate or fake a login. If a CLI is
  not authenticated, tell the user to run `claude` / `codex` once in their own terminal and
  complete the sign-in, then continue. Their credentials live in the CLIs' own config dirs
  (e.g. `~/.claude`, `~/.codex`), independent of Dispatch.

### 2. Build and install the daemon (macOS)

From the repo root:

```bash
./bin/dispatch build      # pnpm install + build server and web client
./bin/dispatch install    # write the launchd plist, load and start it
./bin/dispatch status     # confirm it is loaded and HTTP-reachable
```

`dispatch status` should report the daemon `loaded yes` and HTTP `reachable at
http://localhost:3456`. If not, check `./bin/dispatch logs` and report the error.

Smoke test:

```bash
curl -fsS http://localhost:3456/api/sessions >/dev/null && echo OK
open http://localhost:3456   # optional: confirm the UI loads
```

### 3. (Optional) Expose it publicly (macOS)

If the user wants remote access, follow [`docs/cloudflare.md`](docs/cloudflare.md) to set up a
Cloudflare Tunnel and a Zero Trust Access policy. Several steps there are interactive (browser
login to Cloudflare, choosing a hostname, adding the user's email to the Access policy) — hand
those to the user rather than guessing.

---

## Windows setup

### 0. Confirm the environment (Windows)

Run in PowerShell:

```powershell
node -v             # need >= 18
pnpm -v             # need >= 9  (install: npm i -g pnpm  OR  corepack enable)
$PSVersionTable.PSVersion   # confirm PowerShell is present
git --version
```

If Node or pnpm is missing, install them before continuing (e.g. via winget:
`winget install OpenJS.NodeJS`). PowerShell is included with Windows 11; `pwsh` (PowerShell 7+)
is preferred but `powershell.exe` works.

### 1. Verify the agent CLIs are installed and authenticated (Windows)

Both Claude Code (`claude`) and Codex (`codex`) run **natively on Windows** — no WSL required.
They install as Node.js packages and expose `.cmd` shims on the PATH. See
[`docs/providers.md`](docs/providers.md) for details.

```powershell
where.exe claude; claude --version    # Claude Code
where.exe codex;  codex --version     # Codex
```

- If a binary is missing, install it (see `docs/providers.md`) — do **not** guess the package name.
- **Authentication is interactive.** Do not attempt to automate or fake a login. If a CLI is
  not authenticated, tell the user to run `claude` / `codex` once in their own PowerShell window
  and complete the sign-in, then continue. Credentials live in `%USERPROFILE%\.claude` and
  `%USERPROFILE%\.codex`, independent of Dispatch.

### 2. Build and install the daemon (Windows)

From the repo root in PowerShell:

```powershell
pnpm install
pnpm -r run build
dispatch install    # registers a Task Scheduler at-logon task and starts the daemon
dispatch status     # confirm it is running and HTTP-reachable
```

`dispatch status` should report the daemon running and HTTP `reachable at http://localhost:3456`.
If not, check `dispatch logs` and report the error.

Smoke test:

```powershell
Invoke-WebRequest http://localhost:3456/api/sessions -UseBasicParsing | Select-Object StatusCode
start http://localhost:3456   # optional: confirm the UI loads
```

**Known v1 gaps on Windows** (document, do not attempt to fix during setup):
- The in-app browser/OAuth-capture relay is not wired; OAuth flows open in the system browser directly.
- The Tailscale-status panel shows "unavailable" (not an error; Tailscale networking still works).

### 3. (Optional) Expose it publicly (Windows)

Same Cloudflare Tunnel + Access approach as macOS — follow
[`docs/cloudflare.md`](docs/cloudflare.md). The `cloudflared` binary has a Windows build.

---

## Guardrails (all platforms)

- **Never commit secrets.** Cloudflare tunnel credentials, the SQLite DB, and `.env` files
  must stay out of git — `.gitignore` already excludes them.
- **Don't fabricate auth.** Sign-in flows for Claude Code, Codex, and Cloudflare are the
  user's to complete interactively.
- **The data dir is `~/.dispatch`** on macOS / **`%USERPROFILE%\.dispatch`** on Windows
  (SQLite + runtime). Don't delete it unless the user asks.
- **Logs:** macOS: `~/Library/Logs/dispatch/`; Windows: `%LOCALAPPDATA%\dispatch\logs\`.
  Both: `dispatch logs -f`.
- Prefer the `dispatch` CLI over hand-running `launchctl` (macOS) or `schtasks` (Windows).

## Useful commands (all platforms)

```bash
dispatch restart      # after pulling changes or editing config
dispatch update       # git pull + rebuild + restart
dispatch uninstall    # remove the daemon (keeps data dir)
PORT=4000 dispatch install   # use a non-default port
```
