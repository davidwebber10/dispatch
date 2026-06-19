# Dispatch

Control your coding agents — **Claude Code** and **Codex** — and terminals from any browser or phone.

Dispatch runs as a small daemon on your Mac. It manages long-lived terminal sessions
(your agents) and serves a web client, so you can drive your projects from a laptop, the
couch, or your phone — including as an installable PWA. Put it behind a
[Cloudflare Tunnel + Access](docs/cloudflare.md) and it's reachable anywhere, securely.

- **Projects & threads** — group terminals by working directory; each thread is a Claude Code, Codex, or plain shell session.
- **Live terminals** — full xterm.js terminals over WebSocket, with scrollback, image paste/upload, and mobile soft-keys.
- **Files** — browse the project tree, view/edit files with syntax highlighting, render Markdown.
- **Agents** — schedule and monitor agent runs.
- **Single-origin** — the daemon serves both the API/WebSocket and the web bundle, so there's no CORS and one URL to expose.
- **Installable PWA** — add it to your Dock (macOS) or Home Screen (iOS).

> **Setting this up with an AI agent?** Point it at [`AGENTS.md`](AGENTS.md) — it contains
> step-by-step, idempotent setup instructions written for a coding agent.

---

## Prerequisites

- **macOS** (the daemon installs as a `launchd` agent).
- **Node.js 18+** and **pnpm 9+** — `node -v`, `pnpm -v`. Install pnpm with `npm i -g pnpm` or `corepack enable`.
- **git**.
- **The agent CLIs you want to drive, installed and authenticated as the same user that runs the daemon:**
  - **Claude Code** (`claude`)
  - **Codex** (`codex`)

  Dispatch does **not** manage their logins — it just spawns them as terminals, so they must
  already be on your `PATH` and signed in. See **[docs/providers.md](docs/providers.md)** for
  install + authentication steps and how to verify them.

---

## Quick start

```bash
git clone https://github.com/davidwebber10/dispatch.git
cd dispatch

# Install dependencies and build the server + web client
./bin/dispatch build

# Install + start the background daemon (launchd)
./bin/dispatch install

# Open it
open http://localhost:3456
```

That's it — Dispatch is now running locally and will restart automatically on login.

To use the `dispatch` command from anywhere, add it to your `PATH`:

```bash
ln -s "$PWD/bin/dispatch" /usr/local/bin/dispatch   # or somewhere on your PATH
```

---

## Make it reachable from anywhere

Locally Dispatch listens on `http://localhost:3456`. To reach it from your phone or another
machine, expose it with a **Cloudflare Tunnel** and gate it with **Cloudflare Access** so only
you can sign in:

→ **[docs/cloudflare.md](docs/cloudflare.md)** — full Tunnel + Zero Trust Access walkthrough.

(For private, tailnet-only access without a public domain, Tailscale also works — see the note at the end of that doc.)

---

## Daemon management

```bash
dispatch status      # is it loaded + responding?
dispatch logs -f     # follow the logs
dispatch restart     # restart it
dispatch stop        # stop it
dispatch start       # start it
dispatch update      # git pull + rebuild + restart
dispatch uninstall   # stop + remove the launchd agent (keeps your data)
dispatch run         # run in the foreground instead of as a daemon (Ctrl-C to stop)
```

---

## Configuration

| Setting | Default | How |
| --- | --- | --- |
| Port | `3456` | `PORT=4000 dispatch install` (baked into the launchd plist) |
| Web bundle path | `packages/web/dist` | `DISPATCH_WEB_DIST` (set automatically by the daemon) |
| Data directory | `~/.dispatch` | SQLite DB (`dispatch.db`) + runtime files live here |
| In-app server switcher | empty | `DISPATCH_SERVERS` — a list the in-app brand dropdown offers. Empty by default; set once per deployment. |

The server switcher (the dropdown on the **Dispatch** brand) is populated from `DISPATCH_SERVERS`,
exposed by the daemon at `/api/servers`. Set it as either a shell-friendly list or JSON, then
`dispatch install` bakes it into the launchd plist:

```bash
DISPATCH_SERVERS="MacBook=https://macbook.example.ts.net:3456,Mac mini=https://mini.example.ts.net:3456" dispatch install
# or JSON:
DISPATCH_SERVERS='[{"label":"MacBook","origin":"https://…"},{"label":"Mac mini","origin":"https://…"}]' dispatch install
```

Logs are written to `~/Library/Logs/dispatch/`.

---

## How it works

```
browser / PWA  ──HTTPS──>  Cloudflare (Tunnel + Access)  ──>  cloudflared  ──>  localhost:3456
                                                                                    │
                                                                    ┌───────────────┴───────────────┐
                                                                    │   Dispatch daemon (Node)       │
                                                                    │   • Express API + WebSocket    │
                                                                    │   • PTY manager (node-pty)     │
                                                                    │   • SQLite (~/.dispatch)       │
                                                                    │   • serves the web bundle      │
                                                                    └───────────────┬───────────────┘
                                                                                    │ spawns
                                                                          claude / codex / shell PTYs
```

- `packages/core` — the daemon: Express + `ws` + `node-pty` + `better-sqlite3`. Serves the built web client (single-origin).
- `packages/web` — the React + Vite web client (xterm.js, CodeMirror, Zustand).

The daemon resolves your **login shell `PATH`** at startup so spawned terminals can find
`claude`, `codex`, `git`, etc. even when launched by `launchd`.

WebSockets are kept alive with a 30s server-side ping so they survive Cloudflare's ~100s idle
timeout.

---

## Updating

```bash
dispatch update     # git pull --ff-only, rebuild, restart
```

## Uninstalling

```bash
dispatch uninstall  # removes the launchd agent; ~/.dispatch is left intact
```

To remove your data too: `rm -rf ~/.dispatch`.

---

## Mobile / install as an app

Open the site in a browser and install it:

- **iPhone (Safari):** Share → **Add to Home Screen**.
- **macOS (Chrome / Edge / Arc / Brave):** the install icon in the address bar, or ⋮ → **Install Dispatch…**.
- **macOS (Safari):** File → **Add to Dock**.

> The install option only appears on a **secure (HTTPS)** origin — i.e. your Cloudflare
> hostname, not a plain `http://…:3456` address.

---

## License

Private. © David Webber. All rights reserved.
