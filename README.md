# Dispatch

Control your coding agents — **Claude Code**, **Codex**, **OpenCode** and **Grok** — and terminals from any browser or phone.

Dispatch runs as a small daemon on your Mac (or on Windows, inside WSL2). It manages long-lived terminal sessions
(your agents) and serves a web client, so you can drive your projects from a laptop, the
couch, or your phone — including as an installable PWA. Put it behind a
[Cloudflare Tunnel + Access](docs/cloudflare.md) and it's reachable anywhere, securely.

- **Chat** — one conversation that never ends. Dispatch remembers everything you have discussed, across all your projects, and starts and follows threads for you. See [Chat](#chat).
- **Projects & threads** — group terminals by working directory; each thread is a Claude Code, Codex, OpenCode, Grok, or plain shell session.
- **Control Plane** — a coordinator per project that plans work, starts agents, and asks you only for decisions.
- **Live terminals** — full xterm.js terminals over WebSocket, with scrollback, image paste/upload, and mobile soft-keys.
- **Files** — browse the project tree, view/edit files with syntax highlighting, render Markdown.
- **Agents** — schedule and monitor agent runs.
- **Analytics** — tokens, turns, and time per project, model, and provider, from your own machine.
- **Single-origin** — the daemon serves both the API/WebSocket and the web bundle, so there's no CORS and one URL to expose.
- **Installable PWA** — add it to your Dock (macOS) or Home Screen (iOS).

Agents run with your full user rights and with approvals off. That is by design: it lets them work unattended. See [Security notes](docs/security.md).

> **Setting this up with an AI agent?** Point it at [`AGENTS.md`](AGENTS.md) — it contains
> step-by-step, idempotent setup instructions written for a coding agent.

---

## Prerequisites

- **macOS** (the daemon installs as a `launchd` agent), or **Windows 10/11 with WSL2** — run
  [`scripts/install-windows.ps1`](scripts/install-windows.ps1); see [docs/wsl2-bring-up.md](docs/wsl2-bring-up.md).
- **Node.js 18+** and **pnpm 9+** — `node -v`, `pnpm -v`. Install pnpm with `npm i -g pnpm` or `corepack enable`.
- **git**.
- **The agent CLIs you want to drive, installed and authenticated as the same user that runs the daemon:**
  - **Claude Code** (`claude`) — also required for [Chat](#chat)
  - **Codex** (`codex`)
  - **OpenCode** (`opencode`) — runs OpenRouter models; needs an OpenRouter key
  - **Grok** (`grok`)

  Dispatch does **not** manage their logins — it just spawns them as terminals, so they must
  already be on your `PATH` and signed in. See **[docs/providers.md](docs/providers.md)** for
  install + authentication steps and how to verify them.

---

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/davidwebber10/dispatch/main/scripts/install.sh | sh
```

This checks prerequisites (git, Node 18+, pnpm), clones Dispatch to `~/.dispatch/app`, builds it,
starts the background daemon (launchd), puts `dispatch` on your `PATH`, and opens
`http://localhost:3456`. A first-run **setup wizard** then walks you through your agents
(Claude Code / Codex), mobile access (Tailscale), and optional secrets (Doppler). Run
`dispatch doctor` anytime to re-check that status from the terminal.

<details>
<summary>Prefer to do it by hand?</summary>

```bash
git clone https://github.com/davidwebber10/dispatch.git
cd dispatch
./bin/dispatch build      # install deps + build server + web client
./bin/dispatch install    # install + start the launchd daemon
open http://localhost:3456
ln -s "$PWD/bin/dispatch" /usr/local/bin/dispatch   # optional: dispatch on PATH
```
</details>

That's it — Dispatch is now running locally and will restart automatically on login.

---

## Make it reachable from anywhere

Locally Dispatch listens on `http://localhost:3456`.

**Easiest (recommended): Tailscale.** Install [Tailscale](https://tailscale.com) on your Mac and
your phone, sign into the same account, and Dispatch is reachable at `http://<your-mac>.ts.net:3456`
— privately, only from your own devices, with no public exposure. The setup wizard's **Mobile**
step shows the exact URL and a QR code to open on your phone.

**Public URL: Cloudflare Tunnel + Access.** To expose a real shareable `https://` URL, put Dispatch
behind a **Cloudflare Tunnel** gated with **Cloudflare Access** so only you can sign in:

→ **[docs/cloudflare.md](docs/cloudflare.md)** — full Tunnel + Zero Trust Access walkthrough.

> ⚠️ The daemon spawns shells and agents, so an open port would be remote code execution. Dispatch
> therefore answers only this computer and your own Tailscale devices without a sign-in. Every
> other device must sign in once with the token from `dispatch access`. Details:
> **[docs/network-access.md](docs/network-access.md)**.
>
> Agent threads carry their own keys, and `dispatch api` makes scripted calls without a token on the command line: see **Thread keys** in the same doc.

(For private, tailnet-only access without a public domain, Tailscale also works — see the note at the end of that doc.)

**One daemon per person.** Dispatch has no user accounts. Whoever holds the access token gets a
shell on your computer as you, and can read your secrets. Do not share a daemon or its token with
another person: each person runs their own. See **[docs/security.md](docs/security.md)**.

**Agents run with your rights.** Agent threads start with their approval prompts turned off, so a
thread can run commands and edit files as you without asking. Treat a thread's input (web pages,
pull requests, files) as able to steer it.

---

## Daemon management

```bash
dispatch status      # is it loaded + responding?
dispatch logs -f     # follow the logs
dispatch restart     # restart it
dispatch stop        # stop it
dispatch start       # start it
dispatch update      # update to the latest release, rebuild + restart
dispatch uninstall   # stop + remove the launchd agent (keeps your data)
dispatch run         # run in the foreground instead of as a daemon (Ctrl-C to stop)
```

---

## Chat

**Chat** (the second icon in the left rail) is one conversation that never ends. You do not
open threads or pick a project: you talk, and Dispatch does the work itself or starts threads
in the right project and reports back in the same chat when they finish.

- **It remembers.** Older messages are summarized into short lines that Dispatch can open
  again, so it can answer from months of history without a long context. Search the memory
  from the box at the top of the Chat view.
- **All projects.** Dispatch knows your projects and their open items. Pick a project with the
  button left of the attach button when you want to point at one; otherwise it works out the
  project from what you say.
- **Requirements.** Chat uses the Claude Code CLI (`claude`): Opus for its replies and Haiku for
  the summaries. Your Claude login must have access to both. Chat works in `~/.dispatch/chat`
  and loads your normal Claude Code MCP servers and skills.
- The **Stop** button ends a reply that runs too long. What Dispatch already wrote stays.

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
dispatch update     # fast-forward to the latest release tag, rebuild, restart
```

`dispatch update` installs the newest **release** (the latest `vX.Y.Z` tag), not whatever is at
the tip of `main`. The release notes you read in the update prompt describe exactly that version.

## Usage statistics

Usage reporting is on by default. Dispatch sends a small anonymous report (counts only, plus a random
install ID; never text, paths or names) to `dispatchd.app` about every 6 hours. Turn it off in
**Settings**, or start the daemon with `DISPATCH_TELEMETRY=0`.

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

[MIT](LICENSE) © David Webber.
