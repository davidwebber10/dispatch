# Hosted boxes (Dispatch inside POLYWOOD OS)

A box is one container per person, provisioned by OS. The OS side of the contract is
`docs/2026-11-11-dispatch-box-contract.md` in the OS repository. This page lists what the box does.
Every behaviour here is off on a local install (no `OS_BASE_URL` / `OS_BOX_TOKEN`), unless a switch
below turns it on.

## Environment

| Variable | Set by | What |
| --- | --- | --- |
| `DISPATCH_BASE_PATH` | provisioner | `/dispatch`. The box serves `/dispatch/`; the exact `/dispatch` is the OS launcher. |
| `DISPATCH_BOX_TOKEN` | provisioner | Checked on every request and WebSocket (a refused socket gets HTTP 401). |
| `OS_BASE_URL`, `OS_BOX_TOKEN` | provisioner | Box → OS calls. Their presence is what "hosted" means. Never reach a thread. |
| `DISPATCH_OWNER_EMAIL` | provisioner | Sent as `x-dispatch-owner` on every OS call (heartbeat included). `--email` of the Claude login. |
| `DISPATCH_BOX_ID` | provisioner | Logged; the container's `HOSTNAME`. |
| `OS_PUBLIC_URL` | provisioner | Browser-facing OS origin (links shown to the person). |
| `DISPATCH_PROFILE` | provisioner | First profile. OS's `profile` in `/api/dispatch/connections` wins, live. |
| `DISPATCH_CLAUDE_LOGIN` | optional | `cli`: the clean Claude login on a local install too; `token`: keep setup-token even when hosted. |
| `DISPATCH_RESUME_CHATS` | optional | `1`: resume ordinary chat threads after a restart on a local install; `0`: off when hosted. |
| `DISPATCH_ALLOW_MODEL_GATEWAY` | optional (image) | `1`: `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS` and model variables pass through, and `forceLoginMethod` is not written. Tests and a later phase only. |

Thread setting: `config.approvals` = `auto` | `ask` | `smart` (default `smart` for a plain chat thread
of a business person). See `packages/core/src/os/approvals.ts`.

## What a hosted box does differently

- **Company tools.** One `os-tools` MCP server per thread, a stdio bridge to the daemon's loopback
  `POST /api/os-tools/mcp`, which adds the box token, owner and thread id (docs/integrations.md).
- **Claude login.** `claude auth login --claudeai --email <owner>` over pipes; Claude Code keeps its own
  credential; the daemon reads `claude auth status` only. An added account has its own
  `CLAUDE_CONFIG_DIR` under `<dataDir>/claude-accounts/<id>`; `projects/`, `skills/`, `commands/`,
  `agents/`, `plugins/`, `settings.json` and `CLAUDE.md` are links to the primary dir, so a thread can
  resume under another account. `.credentials.json` and `.claude.json` are never shared.
- **Codex login.** The CLI login signs in with the device code (`codex login --device-auth`), never a
  terminal thread; a sign-in thread is never restarted by itself.
- **Usage figures.** From `rate_limit_event` frames and one `get_usage` control request; never a token.
- **Continuity.** Mid-turn chat threads (Claude, Codex) resume after a restart; Grok/OpenCode show a
  Continue card; a thread whose process the restart replaced is idle, not `error`; SIGTERM exits after
  the kill grace. The web client treats the router's 503/redirect as "Reconnecting…" and reloads once
  at `/dispatch/`.
- **Updates.** From OS (`/api/dispatch/box/update`), one step: the workspace moves to the new image.
- **Projects.** A name alone makes `~/projects/<name>`.
- **Capabilities.** `platform/capabilities.ts` (`base-path`, `os-tools-proxy`, `profile`) rides the
  heartbeat and `GET /api/os/connections`.

## Image

`docker/hosted/Dockerfile`, built with `scripts/build-box-image.sh` (`--no-push` with no `--account`
makes no AWS call). Claude Code, Codex, OpenCode and mcp-remote are pinned build args. `/app` is
root-owned. The entrypoint runs as root only to write `/etc/claude-code/managed-settings.json` and
prepare `$HOME`, then drops to uid 1000. A copy of a CLI the image ships found in
`$HOME/.dispatch/tools/bin` (the in-app installer) is renamed `*.shadowed-by-image`: the image wins.
