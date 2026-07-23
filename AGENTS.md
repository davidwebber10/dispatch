# Agent setup instructions

You are an AI coding agent setting up **Dispatch** on the user's macOS machine. Follow these
steps in order. They are **idempotent** — safe to re-run. Stop and ask the user only when a
step needs a credential or a decision you can't make safely.

## Goal

A running Dispatch daemon on `http://localhost:3456`, optionally exposed publicly via
Cloudflare Tunnel + Access, with the user's agent CLIs (Claude Code, Codex) installed and
authenticated so Dispatch can spawn them.

## 0. Confirm the environment

```bash
uname -s            # expect: Darwin (macOS). The daemon is launchd-based.
node -v             # need >= 18
pnpm -v             # need >= 9  (install: npm i -g pnpm  OR  corepack enable)
git --version
```

If Node or pnpm is missing, install them (Homebrew: `brew install node pnpm`) before continuing.

## 1. Verify the agent CLIs are installed and authenticated

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

## 2. Build and install the daemon

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

## 3. (Optional) Expose it publicly

If the user wants remote access, follow [`docs/cloudflare.md`](docs/cloudflare.md) to set up a
Cloudflare Tunnel and a Zero Trust Access policy. Several steps there are interactive (browser
login to Cloudflare, choosing a hostname, adding the user's email to the Access policy) — hand
those to the user rather than guessing.

## Guardrails

- **Never commit secrets.** Cloudflare tunnel credentials (`~/.cloudflared/*.json`), the
  SQLite DB, and `.env` files must stay out of git — `.gitignore` already excludes them.
- **Don't fabricate auth.** Sign-in flows for Claude Code, Codex, and Cloudflare are the
  user's to complete interactively.
- **The data dir is `~/.dispatch`** (SQLite + runtime). Don't delete it unless the user asks.
- **Logs:** `~/Library/Logs/dispatch/` and `./bin/dispatch logs -f`.
- Prefer the `dispatch` CLI over hand-running `launchctl`.

## Useful commands

```bash
dispatch restart      # after pulling changes or editing config
dispatch update       # git pull + rebuild + restart
dispatch uninstall    # remove the daemon (keeps ~/.dispatch)
PORT=4000 dispatch install   # use a non-default port
```

## Cutting a release

Shipping a new version is a **git tag + a GitHub Release**, driven by `dispatch release`. The
one thing that trips agents up: the version in `package.json` is a *separate* hand-authored
commit that must land on `main` **before** you tag — bump only the tag and the in-app update
prompt never converges. The full runbook, including the two-halves-must-move-together model
and the worktree caveat, is in [`docs/RELEASING.md`](docs/RELEASING.md).

```bash
# after your changes are on origin/main:
#   1. bump the version in all four package.json (root + cli + core + web)
#   2. git commit -am "chore(release): X.Y.Z — <headline>" && git push origin main
./bin/dispatch release        # tags, pushes the tag, cuts the GitHub Release
```

A release is **not** a deploy: it never builds, restarts, or updates any machine. Installs
upgrade themselves with `dispatch update`; deploying to the user's own Mac mini is opt-in —
**ask first**.
