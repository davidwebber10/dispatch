# Hosted boxes (Dispatch inside POLYWOOD OS)

A box is one container per person, provisioned by OS. The OS side of the contract is
`docs/2026-11-11-dispatch-box-contract.md` in the OS repository. This page lists what the box does.
Every behaviour here is off on a local install (no `OS_BASE_URL` / `OS_BOX_TOKEN`), unless a switch
below turns it on.

## Environment

| Variable | Set by | What |
| --- | --- | --- |
| `DISPATCH_BASE_PATH` | provisioner | `/dispatch`. The box serves `/dispatch/`; the exact `/dispatch` is the OS launcher. |
| `DISPATCH_BOX_TOKEN` | provisioner | INBOUND only: checked on every request and WebSocket (a refused socket gets HTTP 401). Never sent anywhere. |
| `OS_BASE_URL`, `OS_BOX_TOKEN` | provisioner | OUTBOUND only: box → OS calls. Their presence is what "hosted" means. Never accepted from a caller. |
| `DISPATCH_ALLOW_SHARED_BOX_TOKEN` | image (for now) | `1`: the daemon starts although the two tokens hold the same value. Without it, one value in both roles stops the start. See "The two tokens". |
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

- **Company tools.** One MCP server per company system with a tool for the person (`acumatica`,
  `data`, `display`, `connections`, …), reaching the daemon's loopback `POST /api/os/mcp/<system>`,
  which renames the tools and adds the box token, owner, thread id and `x-dispatch-systems`
  (docs/integrations.md). The gateway's instructions ride the `data` server only.
- **The native window.** The web client on a hosted box looks like a local install: the Dispatch
  theme and layout, the technical wording for a developer. The OS look stays behind the business
  preview switch (off, hidden on a hosted box). A business person uses the chat view in OS, which
  drives this daemon through `docs/headless-api.md`.
- **Business profile: default deny (capability `gate-v2`).** Every route and WebSocket has a row in one
  table (`packages/core/src/profile/business-routes.ts`); the route that matched decides, a route with
  no row is refused, and a request path has one spelling (docs/headless-api.md sections 0 and 9). A
  business person gets chat threads, notes and file tabs, the files of their projects under
  `~/projects`, their sign-in and their notifications. Refused: everything that runs with approvals
  skipped (an automation, an agent, a role, a coordinator, a queued agent, the autonomous dial, Chat),
  a terminal in any form, plugins, skills, integrations, secrets and the machine's settings. A key held
  by a thread may do only what an agent needs. The daemon also refuses to START anything but a chat
  thread under this profile, and only on an image with the strict harness policy (below).
- **Files (capability `gate-v2`).** The file routes serve the person's own folders only: a developer
  the home and project folders, a business person the project of the request without the folders that
  configure an agent program; never `/proc` and the like, the daemon's data folder, `/app`, a harness's
  settings folder, or a file with more than one name (`packages/core/src/files/path-policy.ts`).
- **The access token.** On a hosted box under the business profile only the box token admits the owner.
  The `access-token` file in the data folder admits nobody: an agent can read that file.
- **Idle info (capability `idle-info`).** The heartbeat carries `automations: {enabled, nextRunAt,
  kinds: {schedules, pluginJobs, parkedThreads}}` and `lastActivityAt` (`os/idle-info.ts`).
  Counted: enabled agent schedules with a next run, plugin worker cron jobs of a running worker,
  threads parked on a usage limit. Not counted (event driven or housekeeping): thread watches, the
  delivery outbox, the interim recap, auto-archive, the stall watchdog, the plugin update check,
  telemetry, the usage gauge. `lastActivityAt` is the newest of a person's message (`source:
  "user"`), a thread turn (a status change to working, idle, needs input or error, or a CLI output
  burst; never an attach) and an automation run. The heartbeat, the OS poll and an open page never
  move it.
- **Stop and start.** SIGTERM ends the daemon at once (measured 0.01 s with idle threads; at most the
  3 s kill grace for a busy CLI); SQLite is written as it goes. On the next start a chat thread
  resumes with its history (the journal) when its socket opens or a message arrives, and an enabled
  schedule keeps its `next_run_at`. A run that fell due during the sleep runs ONCE on the first tick
  (about 30 s after start), then the schedule continues from now; missed runs are not repeated.
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
  the kill grace. The web client treats the router's 503/redirect as a quiet "Reconnecting…" and never
  reloads or navigates while the box is down (a page load then lands on the OS launcher). It probes
  `/api/host-context` (redirects not followed) from 1.5 s up to 5 s, with no time limit; after 3 minutes
  it adds "This takes longer than usual." Back on the same build (the page's content-hashed entry
  script against the shell served now): new sockets and a state reload in place, so drafts, tabs and
  the grid stay. Back on a new build: one reload, only after the shell answered 200 HTML
  (`web/src/lib/boxRestart.ts`).
- **Updates.** From OS (`/api/dispatch/box/update`), one step: the workspace moves to the new image.
- **Projects.** A name alone makes `~/projects/<name>`.
- **Box log.** One JSON line per event on stdout (`os/box-log.ts`): `daemon.start` (version, profile,
  base path, capabilities), `daemon.shutdown` (signal), `os.connections` (reachable, counts; a line
  only when the answer changes), `thread.start` / `thread.exit` (harness, exit code), and each step of
  the Claude sign-in (`claude.signin.*`: start, URL host, code length and shape, CLI exit code, the
  CLI's error text, `claude auth status`). Every string is redacted: no code, token, e-mail, cookie or
  URL query. A local install writes none of these lines.
- **Capabilities.** `platform/capabilities.ts` (`base-path`, `os-tools-proxy`, `profile`,
  `headless-v1`, `idle-info`, `gate-v2`) rides the heartbeat, `GET /api/host-context` and
  `GET /api/os/connections`. `automations-safe` is not advertised. OS should admit a business person
  only to a box that lists `gate-v2`. `privsep-v1` is added to the list only when THIS START proved
  privilege separation (hosted-privilege-separation.md): OS should require it for a business person
  too.

## The two tokens

`DISPATCH_BOX_TOKEN` admits requests to the daemon. `OS_BOX_TOKEN` signs the daemon's calls to the
platform. Each has that one job (`packages/core/src/platform/box-secrets.ts`):

- The daemon reads both once at start, keeps them in memory, and deletes them from its environment
  before it starts any process. No harness, shell, MCP server, plugin worker or probe inherits one.
- The start line says the mode, never a value: `box tokens: split …`, or `box tokens: SHARED
  (compatibility, …)`. The box log's `daemon.start` carries `tokenMode` (`split`, `shared-compat`,
  `no-inbound`).
- One value in both roles stops the start (`SharedBoxTokenError`), unless
  `DISPATCH_ALLOW_SHARED_BOX_TOKEN=1`. **The image sets that switch today**, because the platform
  still issues one value for both. When the platform issues two different values the daemon runs in
  `split` mode with no other change; then remove the `ENV` line from `docker/hosted/Dockerfile`.

What this does not do: a process that runs as the daemon's own user can read the daemon's first
environment block (`/proc/<pid>/environ`) and its memory. That needs the agents to run as another user.

## Image

`docker/hosted/Dockerfile`, built with `scripts/build-box-image.sh` (`--no-push` with no `--account`
makes no AWS call; `--tag`, `--no-latest`, `--target`). Three stages: `build` (compilers, pnpm) and
`agents` (downloads) are never shipped; `runtime` is the image.

**Pinned.** The base image by digest (`node:22-trixie-slim@sha256:…`, Debian 13). Claude Code: the
release binary, compared with a SHA-256 written in the Dockerfile; no installer script runs. Codex,
OpenCode and mcp-remote: `npm ci` from `docker/hosted/agent-clis/package-lock.json`, which pins every
package by integrity hash. Not pinned by hash: the Debian packages (`apt-get upgrade` takes the
distribution's current fixes at build time; a rebuild can differ by those).

**What the image holds, and why.** `node` and `npm`/`npx` (the daemon; a remote integration starts
through `npx`); `git` (the daemon's git routes and every harness); `ripgrep` (Claude Code's search);
`procps` (`ps`, for the daemon's process list); `less` (the pager of git and the CLIs);
`ca-certificates`; `bash` and the Debian base (`apt`, `dpkg`, `perl-base`, `tar`, `sed`, `awk`:
part of the base system; `apt` can do nothing without root). Removed: `gcc`, `g++`, `make`,
`python3`, `curl`, `unzip`, `pnpm`, `corepack`. A developer who needs a toolchain gets the developer
image (below), not this one.

**No program gains rights.** Every setuid and setgid bit is removed at build (`su`, `mount`, `umount`,
`passwd`, `chsh`, `chfn`, `newgrp`, `gpasswd`, `chage`, `expiry`, `unix_chkpwd`). `/app`, the CLIs and
the policy files are root-owned and not writable by the runtime user.

**The user.** The image's default user is `dispatch` (uid 1000): the daemon, `docker exec` and any
other command run as that user. The entrypoint needs root for nothing in the standard mode. It can be
started as root (`user: "0"`) for ONE case, `DISPATCH_ALLOW_MODEL_GATEWAY=1` (it replaces the Claude
Code policy file with the one that has no `forceLoginMethod`), and then runs the daemon as uid 1000
with `setpriv`; that needs the SETUID and SETGID capabilities and a writable `/etc/claude-code`.

**Read-only root file system.** The daemon and the harnesses write under `$HOME` (the person's volume:
`~/.dispatch`, `~/.claude`, `~/.codex`, `~/.config`, `~/.local`, `~/.cache`, `~/.npm`, `~/projects`) and
under `/tmp` (uploads in transit, the CLIs' scratch files). Nothing else. `/tmp` is declared a `VOLUME`
with mode 1777, so a volume the platform mounts there is writable by uid 1000. Tested with
`docker run --read-only --security-opt no-new-privileges --cap-drop ALL` and a home volume.

**The developer image** (`--target runtime-dev`, its own tag, never `latest`): the same, plus
`build-essential`, `python3`, `curl`, `unzip`, and the developer harness policy (a harness may skip
approvals, so CLI threads and unattended agents work as on a local install). The daemon does not start
a business person's thread on it.

A copy of a CLI the image ships found in `$HOME/.dispatch/tools/bin` (the in-app installer) is renamed
`*.shadowed-by-image`: the image wins.

**Registry scan (2026-11-12, the image of this change).** 0 critical, 10 high (the image before: 16
high). What went: the findings in `sqlite3` (it came with python), `util-linux` and `zlib`. What stays,
each at Debian 13's newest version on the build day (`apt-get upgrade` ran, so no fixed package existed):
`git` (1); `krb5` (6) and `cyrus-sasl2` (1), which are libraries of git's HTTP transport
(`libcurl3t64-gnutls`) and go only if git goes; `glibc` (2). Rebuild to take the fixes when Debian
publishes them: the base digest and `apt-get upgrade` are the two places a rebuild picks them up.

## Harness policy

Root-owned files in each harness's system location (`docker/hosted/policy/`). A harness reads them above
every user, project and command-line setting, so they also hold for a harness an agent starts by itself.

| Harness | File | What it does |
| --- | --- | --- |
| Claude Code 2.1.322 | `/etc/claude-code/managed-settings.json` | `permissions.disableBypassPermissionsMode: "disable"`; `allowManagedHooksOnly: true`; `allowManagedPermissionRulesOnly: true`; `forceLoginMethod: "claudeai"` |
| Codex 0.167.0 | `/etc/codex/requirements.toml` | `allowed_approval_policies = ["untrusted", "on-request"]`; `allowed_sandbox_modes = ["read-only", "workspace-write"]` |
| OpenCode 1.19.5 | none | It has a managed config folder (`/etc/opencode`), but an environment variable moves it, and its effect on the flag that skips permissions was not measured (that needs a model). No policy is shipped for it |

Measured in the image, as uid 1000 (the `permissionMode` of the session's own `init` frame; Codex's
own header):

| Asked for | Without the policy | With the policy |
| --- | --- | --- |
| `claude --dangerously-skip-permissions` | `bypassPermissions` | `default` |
| `claude --permission-mode bypassPermissions` | `bypassPermissions` | `default` |
| `claude --allow-dangerously-skip-permissions --permission-mode bypassPermissions` | `bypassPermissions` | `default` |
| `claude --settings '{"permissions":{"defaultMode":"bypassPermissions"}}'` | `bypassPermissions` | `default` |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH=<an empty file> claude --dangerously-skip-permissions` | `bypassPermissions` | `default` |
| a project `.claude/settings.json` with `defaultMode: bypassPermissions`, plus the flag | `bypassPermissions` | `default` |
| `claude --permission-mode auto` (smart approvals) | `auto` | `auto` |
| `codex exec --dangerously-bypass-approvals-and-sandbox` | `approval: never`, `sandbox: danger-full-access` | `approval: untrusted`, `sandbox: read-only`, with a warning that names the file |
| `CODEX_HOME=<a folder with its own config>` and the same | as above | `approval: untrusted`, `sandbox: read-only` |

What the policy does not close: an agent can still start a second harness in its ordinary, asking mode,
or give a second harness its own program to answer the questions (`--permission-prompt-tool`), or call
the model with a client of its own. The harness's risk judgement sees the command that would do so; no
file in the image can forbid it. It closes the flags, which is what the review asked for.

## Task definition settings for the platform

Fargate facts, checked against the ECS API reference and developer guide (2026-11-12):
`dockerSecurityOptions` is not valid on Fargate, so `no-new-privileges` cannot be set there (the image
has no setuid file instead); `linuxParameters.tmpfs` is not supported (use a task volume);
`capabilities.drop` takes any capability, `capabilities.add` only `SYS_PTRACE`; `ulimits` can set
`nofile` (default 65535); there is no process-count limit in a task definition.

| Setting | Value | Why |
| --- | --- | --- |
| `user` | leave unset (the image's `dispatch`, uid 1000), or `"1000:1000"` | No process starts as root. Only the model-gateway mode needs `"0"` |
| `readonlyRootFilesystem` | `true` | The image writes under `$HOME` and `/tmp` only |
| `mountPoints` | the EFS access point at `/home/dispatch` (as today); an empty task volume at `/tmp` | The two writable paths. The `/tmp` volume takes mode 1777 from the image's `VOLUME` |
| `linuxParameters.capabilities` | `drop: ["ALL"]` | The daemon needs none. (When the agents run as another user this becomes "drop everything except what that design needs", because Fargate cannot add `SETUID`/`SETGID` back) |
| `linuxParameters.initProcessEnabled` | `true` (as today) | Reaps the harnesses' children |
| `ulimits` | `nofile` soft 65535 / hard 65535 (the default; set it only to lower it) | |
| `ephemeralStorage` | the default 20 GiB is enough for `/tmp` | |
| `secrets` | `DISPATCH_BOX_TOKEN` and `OS_BOX_TOKEN` from Secrets Manager, two different values | Today both are plain `environment` values, and the same value |
| ECS Exec | check it after `readonlyRootFilesystem`: the SSM agent writes under `/var/lib/amazon` and `/var/log/amazon`; give it task volumes there if exec is still needed | Not tested here |
| image | by digest, the standard image for a business person; the developer image only for a developer | |

Not a task-definition matter but open: the security group lets a box reach the EFS mount targets and
the whole internet; the EFS file system has no policy that enforces the access point.

## Privilege separation

Design, proof and limits: [hosted-privilege-separation.md](hosted-privilege-separation.md). In short:
started as root with a volume at `/var/lib/dispatch/state`, the daemon stays root with six
capabilities and `no_new_privs`, and every other process (harness, shell, MCP bridge, plugin worker,
helper) runs as uid 1000 with none. The box tokens reach the daemon through a pipe. The daemon's
state is in that volume, below a folder only root can enter. The owner credential is refused from a
peer inside the box. A self-check at each start, run as uid 1000, decides whether the box reports
`privsep-v1`.

What the platform sets for it (this replaces the rows above where they differ):

| Setting | Value | Why |
| --- | --- | --- |
| `user` | `"0"` | Only root can start a process as another user. Without it (or without the state volume) the box runs as one user and does not report `privsep-v1` |
| `mountPoints` | the home at `/home/dispatch`; a second access point at `/var/lib/dispatch/state`; task volumes at `/run/dispatch` and `/tmp` | State outside the home; two writable paths on the task's disk for a read-only root file system |
| `linuxParameters.capabilities` | `drop` everything except `CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID SETPCAP` | The daemon keeps the first six; the entrypoint needs `SETPCAP` once to drop the rest from the bounding set |
| env `DISPATCH_PRIVSEP` | `1` (or unset: on when started as root with the state volume) | `0` forces the one-user layout |
| env `DISPATCH_MIGRATE_LEGACY_HOME` | `1` until the box has reported `privsep-v1` once | One-time import of the state of a box that kept it in the home |

Box log lines: `privsep.prepare` (imported, removed, skipped) and `privsep.proof` (guardOk, selfCheck,
failures).
