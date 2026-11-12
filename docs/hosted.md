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
  (docs/integrations.md). The gateway's instructions ride the `data` server only. A system the person
  has not connected yet gets a server too, with its one `connect` tool; when the person connects it,
  a running thread gets the real tools by MCP `list_changed` where its harness allows it (see "Live
  tool changes" below). The `connections` server also has the box's own `refresh` tool.
- **The Inbox for a headless view.** `GET /api/inbox` and the routes of docs/headless-api.md section 11:
  the drops of the Inbox plugin and their files, for the owner only. The tool and server titles read
  "Inbox" on a hosted box (the plugin MCP server gets `DISPATCH_HOSTED=1`).
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
  `headless-v1`, `idle-info`, `gate-v2`, `inbox-v1`, `live-tools-v1`) rides the heartbeat,
  `GET /api/host-context` and `GET /api/os/connections`. `inbox-v1`: the Inbox routes for a headless
  view exist. `live-tools-v1`: the event stream of a company system, the `connect` tool of a system
  that is not connected, and the refresh signal exist ("Live tool changes"). `automations-safe` is not
  advertised. OS should admit a business person only to a box that lists `gate-v2`. `privsep-v1` is
  added to the list only when THIS START proved privilege separation
  (hosted-privilege-separation.md): OS should require it for a business person too.
- **PATH.** On a box with privilege separation the daemon keeps the PATH the image gave the
  container. It asks no login shell: the start files of a login shell are in the person's home, which
  is the agent's, so a workload could otherwise choose what `claude` or `git` means for later threads.

## Live tool changes

The person asks a thread for something that needs a system they have not connected (the gateway lists
it with one tool, `<system>_connect`). The agent calls `connect`; the person gets a Connect card. After
the person connects, the thread should get the real tools without a restart.

How the box learns of the change: a fast re-check of that one system right after the `connect` call
and then every 5 s for 5 minutes (`os/tools-proxy.ts` `OsToolCatalog.watchAfterConnect`); the
platform's signal `POST /api/os/connections/refresh`; the OS poll (60 s); the agent's `refresh` tool on
the `connections` server. A change of a system's tool set (never a poll with the same answer) sends
`notifications/tools/list_changed` on the event stream of that system's route (`GET
/api/os/mcp/<system>`, `Accept: text/event-stream`). The stdio bridge passes it on to its harness.

What each harness does with it, measured 2026-11-12 with the real CLI and a stub model (no real model),
on an HTTP entry and on stdio:

| Harness | After the person connects | What was seen |
| --- | --- | --- |
| Claude Code 2.1.322 | the running thread gets the tools | `tools/list` again at once; the new tool in the next model request; called. Also end to end through the daemon's own route with the fast re-check |
| OpenCode 1.18.34 | the running thread gets the tools | the same. The image's 1.19.5 was not run |
| Codex 0.167.0 | a new thread is needed | no event stream opened, list_changed ignored (also on stdio), the next turn has the old list, `config/mcpServer/reload` does not change a loaded thread |
| Grok | not measured; treated as "a new thread is needed" | |

The `connect` result carries one line from the box per harness: "its tools reach this thread by
themselves within a few seconds … if they do not appear, call `refresh` … else ask the person to send
the request again in a new thread" (Claude Code, OpenCode), or "this thread cannot load new tools while
it runs … ask the person to send the request again in a new thread" (Codex, Grok). The platform view
can show that as a button.

Not covered: a system that appears mid-thread (just granted) gets no new server in a running thread;
servers are fixed at thread start, so it reaches new threads only. For Codex, a thread resumed after
the app-server unloaded it (`thread/unsubscribe`, then `thread/resume` after
`thread_unload_delay_secs`) does load the new tools with its history (measured); Dispatch does not do
that by itself yet.

## The two tokens

`DISPATCH_BOX_TOKEN` admits requests to the daemon. `OS_BOX_TOKEN` signs the daemon's calls to the
platform. Each has that one job (`packages/core/src/platform/box-secrets.ts`):

- The daemon reads both once at start, keeps them in memory, and deletes them from its environment
  before it starts any process. No harness, shell, MCP server, plugin worker or probe inherits one.
- The start line says the mode, never a value: `box tokens: split …`, or `box tokens: SHARED
  (compatibility, …)`. The box log's `daemon.start` carries `tokenMode` (`split`, `shared-compat`,
  `no-inbound`).
- One value in both roles stops the start (`SharedBoxTokenError`), unless
  `DISPATCH_ALLOW_SHARED_BOX_TOKEN=1`. **The image sets that switch, and keeps it for now**
  (decision of 2026-11-12, after a read of the platform's provisioner). The platform code that runs
  today writes ONE value into both variables. The platform code for privilege separation mints two
  different values, but only when it registers a new task definition for a box: a box gets them at its
  next rebuild, not before. So this image must start in both situations, and it does (the proof starts
  it with one value in the one-user layout and in the separated layout). With two different values
  the switch does nothing and the start line says `split`. Remove the `ENV` line from
  `docker/hosted/Dockerfile` when every box of every environment has been rebuilt by platform code
  that mints two values; from then on one value in both roles is an error again.

How the two values arrive depends on the layout:

- **With privilege separation** (started as root with the state volume): the entrypoint writes both
  into a pipe and removes them from the environment it gives the daemon; the daemon reads the pipe
  once (`privsep/secrets.ts`). They are in no environment a workload can read and in no file.
- **Without it** (one user): the daemon reads them from its environment and deletes them there. A
  process that runs as the daemon's own user can still read the daemon's first environment block
  (`/proc/<pid>/environ`) and its memory. Only the separated layout closes that, and only that layout
  reports `privsep-v1`.

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

The image with privilege separation (`4.6.0-os.5`, the same day): 0 critical, 10 high, 16 medium,
5 low. The ten are the same ten: `glibc` 2.41-12+deb13u4 (2), `krb5` 1.21.3-5+deb13u1 (6), `git`
2.47.3-0+deb13u1 (1), `cyrus-sasl2` 2.1.28+dfsg1-9 (1). `apt list --upgradable` in the image names no
package, so Debian 13 had published no fixed version of any of them. Privilege separation added no
package to the image.

## Harness policy

Root-owned files in each harness's system location (`docker/hosted/policy/`). A harness reads them above
every user, project and command-line setting, so they also hold for a harness an agent starts by itself.

| Harness | File | What it does |
| --- | --- | --- |
| Claude Code 2.1.322 | `/etc/claude-code/managed-settings.json` | `permissions.disableBypassPermissionsMode: "disable"`; `allowManagedHooksOnly: true`; `allowManagedPermissionRulesOnly: true`; `forceLoginMethod: "claudeai"`; `disableClaudeAiConnectors: true`; `spinnerVerbs` (the POLYWOOD set, mode `replace`, added at build from `packages/web/src/lib/spinnerWords.ts`) |
| Claude Code 2.1.322 | `/etc/claude-code/managed-settings.d/` | a link to `/run/dispatch/claude-policy` (root, `0755`); under the business profile the daemon writes `50-dispatch-business-mcp.json` there (see "Company systems only through the platform") |
| Codex 0.167.0 | `/etc/codex/requirements.toml` | `allowed_approval_policies = ["untrusted", "on-request"]`; `allowed_sandbox_modes = ["read-only", "workspace-write"]`; `[features] apps = false`, `plugins = false` |
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

## Company systems only through the platform (MCP servers of a thread)

Observed on stage (2026-11-12): a thread's Claude Code, signed in with the person's Claude account,
loaded that account's own claude.ai connectors next to the platform's servers, and the agent sent the
person to claude.ai settings. Such a connector goes around the platform's gateway: no grant, no tool
log, no approval, and its traffic goes to the model provider. The rule (`packages/core/src/os/hosted-mcp-policy.ts`):

| Profile | A thread's MCP servers |
| --- | --- |
| business | exactly the platform's per-system servers, Dispatch's own `dispatch` server (list_threads, read_thread, status) and the servers of bundled plugins (the Inbox, `plugin-previews`) |
| developer | the same, plus what the developer added through Dispatch's own screens (integrations, the Doppler server, local plugins) |
| local install | unchanged |

Never, under any hosted profile: the connectors of the person's AI account, a server from user or
project scope (`~/.claude.json`, `.mcp.json`), a server added at run time (`claude mcp add`).

What a developer loses on a hosted box: the claude.ai connectors of their account (in every Claude Code
process, nested ones included), the ChatGPT apps and connectors in Codex, and, in Dispatch's own Claude
Code threads, their own user-scope and project-scope servers (`--strict-mcp-config`). A `claude` the
developer starts in a terminal still loads user and project servers, but no account connector.

The layers, and what each was measured to do (Claude Code 2.1.322 in the image, as uid 1000, with a
stand-in account whose token carries the connector scope; the connector list came from a local stub):

| Layer | Where | Measured |
| --- | --- | --- |
| `disableClaudeAiConnectors: true` | managed settings (root) | connectors absent; a user `false`, `--settings` `false` and `ENABLE_CLAUDEAI_MCP_SERVERS=true` do not bring them back |
| business drop-in: `allowManagedMcpServersOnly` + `allowedMcpServers` (the loopback URL of the box, the commands of `dispatch` and the Inbox) | `/etc/claude-code/managed-settings.d` → `/run/dispatch/claude-policy` (root writes, at each business spawn) | `claude mcp add` refused ("not allowed by enterprise policy"); a server written into `~/.claude.json`, a project `.mcp.json` with `enableAllProjectMcpServers`, a user allow-list, an `--mcp-config` of a nested harness and a `CLAUDE_CONFIG_DIR` of its own: none loads |
| `--strict-mcp-config` | launch, every hosted Claude Code thread | only the `--mcp-config` servers; it alone also drops the connectors |
| `ENABLE_CLAUDEAI_MCP_SERVERS=false` | thread environment | connectors absent |
| Codex `[features] apps = false` | `/etc/codex/requirements.toml` (root) | `apps` stays off with `-c features.apps=true`, `--enable apps` and a `CODEX_HOME` with its own config |

A business thread does not start when the drop-in cannot be written (the daemon is not root, or the
folder or its parent could be changed by another user): "its tool policy could not be set". Under the
developer profile the daemon removes the drop-in at the next spawn. Claude Code reads a drop-in owned
by any user (measured), so the entrypoint refuses to start when `/run/dispatch` or
`/run/dispatch/claude-policy` is not root's with no group or other write.

Not covered: Codex keeps the servers of the person's own `~/.codex/config.toml` (its `[mcp_servers]`
requirement needs fixed names; the platform's systems are per person). OpenCode has no account
connectors; its global config still loads. Grok was not measured.

**The check stage runs.** At each start of a hosted Claude Code thread the box logs one line from the
harness's first `system/init` frame, names only:

    {"event":"thread.mcp","thread":"<id>","harness":"claude-code","servers":[...],"expected":[...],"unexpected":[]}

A name Dispatch did not pass adds `{"event":"thread.mcp.unexpected","level":"warn",...}`, a
`[mcp] WARNING` console line, and a notice in the thread. Stage must see `unexpected: []`, and no name
that starts with `claude.ai `, for a person whose Claude account has connectors. The business drop-in
logs `thread.mcp.policy` with `ok: false` only when it fails.

**Wording.** The company-systems note in a thread's prompt (`os/os-servers.ts` `osServersNote`) tells
the agent: a system that is not set up in this workspace is "not set up yet", an administrator must set
it up, offer what it can do instead (a file in the Inbox), and never send the person to an AI vendor's
settings.

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

Box log lines: `privsep.prepare` (imported, removed, skipped) and `privsep.proof` (guardOk, selfCheck,
failures).

## The task definition contract (image `4.6.0-os.5` and later)

This section replaces "Task definition settings for the platform" above for a box with privilege
separation. It is what the image EXPECTS. A row marked **start** stops the container when it is not
met; a row marked **claim** lets the box run as one user without `privsep-v1`, so the platform then
refuses a business person.

### The container

| Setting | Value | If it is not so |
| --- | --- | --- |
| `user` | `"0"` | With `DISPATCH_PRIVSEP=1` and another user: the entrypoint stops (**start**). With `DISPATCH_PRIVSEP` unset: one user (**claim**) |
| `linuxParameters.initProcessEnabled` | `true` | Children of the harnesses are not reaped |
| `linuxParameters.capabilities.drop` | `AUDIT_WRITE`, `FSETID`, `MKNOD`, `NET_BIND_SERVICE`, `NET_RAW`, `SETFCAP`, `SYS_CHROOT` | These seven are what the image never needs |
| capabilities that must REMAIN | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID`, `SETUID` (the daemon keeps them, in its bounding set) and `SETPCAP` (the entrypoint needs it once, to drop every other capability from the bounding set; the daemon does not keep it) | Without `SETPCAP`, `SETUID` or `SETGID`: `setpriv` fails and the container stops (**start**). Fargate can add no capability back, so none of the seven may be dropped. `drop: ["ALL"]` is for the one-user layout only |
| `linuxParameters.capabilities.add` | nothing | |
| `readonlyRootFilesystem` | `true` (the image supports `false` too) | With `true` the four mounts below are the only writable places |
| `portMappings` | container port `3456`, TCP | |
| `image` | by digest | |
| `healthCheck` | none needed; the platform asks `GET <base path>/api/sessions` and `GET <base path>/api/providers` with the inbound token from another host | A call from inside the box with the inbound token gets 401: the owner credential is refused from a local peer |
| the inbound path | the router and the control plane connect STRAIGHT to the task's own address (service discovery by DNS). No proxy container in the task, no service mesh sidecar | The daemon reads the peer's address from the socket. A proxy inside the task makes every request come from loopback or from the box's own address, and then the owner credential is refused for all of them: the box starts and answers 401 to the platform (the readiness step never passes) |
| ECS Exec | leave it off for a business person's box. A session is a root process the daemon did not start: it has the container's first environment (both tokens) and none of the limits of a workload. It also needs a writable root file system | |

### Volumes and mount points

| Volume | Kind | `containerPath` | `readOnly` | What the image needs of it |
| --- | --- | --- | --- | --- |
| `home` | EFS, access point 1, transit encryption on | `/home/dispatch` | `false` | The access point ENFORCES the POSIX user `1000:1000` (the agent). Root directory owned by `1000:1000`. The daemon (root) and the agent both act as uid 1000 on it |
| `state` | EFS, access point 2, transit encryption on | `/var/lib/dispatch/state` | `false` | The access point enforces a POSIX user that NO process of the box runs as (the platform uses `990:990`), root directory mode `0700`, outside every home. The lock inside the box is the parent folder `/var/lib/dispatch`, which is the image's own (root, `0700`): the mount must leave that folder's owner and mode as the image made them, or the entrypoint stops (**start**). Without this volume and without `DISPATCH_PRIVSEP=1`: one user (**claim**). With `DISPATCH_PRIVSEP=1` and no volume: the box starts, proves the separation, and LOSES its state with the task |
| `run` | task volume (the task's own disk) | `/run/dispatch` | `false` | Arrives empty or with the image's folders; the entrypoint (root) makes `agent/` (root, `0755`) and `private/` (root, `0700`) again. Emptied at every start. Needs `CHOWN` |
| `tmp` | task volume | `/tmp` | `false` | Mode `1777`, taken from the image's `VOLUME` declaration. If the platform's volume arrives as `0755 root` the harnesses cannot write scratch files (threads fail, the daemon starts) |

The two access points and their identities: access point 1 is the person's home, enforced user
`1000:1000`. Access point 2 is the daemon's state of the same box, enforced user `990:990`. Each box
has its own task role, whose only file-system permission is `ClientMount` and `ClientWrite` through
these two access points; the volumes use IAM authorization (`authorizationConfig.iam: ENABLED`),
which needs transit encryption. No `ClientRootAccess` is needed.

### Environment variables

| Variable | Value | Notes |
| --- | --- | --- |
| `DISPATCH_PRIVSEP` | `1` | Asks for the separation. With it the entrypoint refuses to start as another user than root. Unset: on only when started as root with a volume at the state path. `0`: one user |
| `DISPATCH_BOX_TOKEN` | the INBOUND token | A plain `environment` value or a `secrets` value: the image reads it from the container's environment either way. The entrypoint moves it into a pipe; it is in no environment below PID 1 |
| `OS_BOX_TOKEN` | the OUTBOUND token, a different value | The same delivery. One value in both is accepted only while the image carries `DISPATCH_ALLOW_SHARED_BOX_TOKEN=1` ("The two tokens") |
| `OS_BASE_URL` | where the box calls the platform | With `OS_BOX_TOKEN` it is what "hosted" means |
| `OS_PUBLIC_URL` | the browser-facing platform origin | |
| `DISPATCH_OWNER_EMAIL`, `DISPATCH_BOX_ID`, `DISPATCH_BASE_PATH`, `DISPATCH_PROFILE` | as before | `DISPATCH_PROFILE` is the first profile only; the platform's live answer wins |
| `DISPATCH_MIGRATE_LEGACY_HOME` | `1` until the box has reported `privsep-v1` once, then absent | The one-time import of state that an older image kept in the home. Without it an old home is left exactly as it is and the box starts with empty state |
| `HOME` | `/home/dispatch` (the image sets it too) | |
| proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, both spellings), `NODE_USE_ENV_PROXY` | when the platform locks the network | They pass through to the daemon and to every workload. `NO_PROXY` must name `127.0.0.1` and `localhost`: a thread reaches the daemon on loopback. Node in the image is 22.23, which reads `NODE_USE_ENV_PROXY` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | NEVER | The entrypoint stops when one is set (**start**) |
| `ANTHROPIC_AUTH_TOKEN` | only with `DISPATCH_ALLOW_MODEL_GATEWAY=1` | Otherwise the entrypoint stops (**start**). The model-gateway mode writes `/etc/claude-code`, so it does not work with a read-only root file system |
| set by the container runtime: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `ECS_CONTAINER_METADATA_URI`, `ECS_CONTAINER_METADATA_URI_V4`, `ECS_AGENT_URI` | | The daemon removes them from its own environment and from every child's. PID 1 keeps them (root only) |

What the image sets itself and the platform must not override: `DISPATCH_AGENT_UID`,
`DISPATCH_AGENT_GID`, `DISPATCH_STATE_DIR`, `DISPATCH_AGENT_RUN_DIR`, `DISPATCH_SECRETS_FD` (the
entrypoint), `DISPATCH_WEB_DIST`, `PORT`, `SHELL`, `PATH`.

### What the box then reports

`GET <base path>/api/host-context` and every heartbeat: `base-path`, `os-tools-proxy`, `profile`,
`headless-v1`, `idle-info`, `gate-v2`, `inbox-v1`, `live-tools-v1`, and `privsep-v1` when the self-check
of that start passed. Box log: `daemon.start` with `tokenMode: "split"`, `privsep.prepare`,
`privsep.proof` with `guardOk: true, selfCheck: true`. A box that logs `selfCheck: false` names each
failed check in `failures`.

### Checked against the platform's provisioner (2026-11-12, its branch for privilege separation)

What that provisioner writes agrees with this contract in: the user, the seven dropped capabilities,
the four mount points and their paths, the two access points and their identities, IAM authorization
with transit encryption, `DISPATCH_PRIVSEP=1`, the migration flag and when it ends, two different
token values per task definition, the two readiness calls, and the inbound path (DNS service
discovery, no container beside the box's own). Where it differs, or where the image depends on
something neither side has measured on the real platform:

1. **The capability the platform requires for a business person.** It requires `profile` and
   `privsep-v1`. It does not require `gate-v2`. This image reports all three, so nothing fails; but a
   separated image without the default-deny gate would be admitted. The platform should require
   `gate-v2` too.
2. **The tokens are plain `environment` values**, not `secrets`. The image works with both. They are
   readable in the task definition by anyone who may describe it, and in the environment of PID 1.
3. **`readonlyRootFilesystem` is off unless the platform's switch is set.** The image works either
   way; with it off, the image's own files are protected only by their owner and mode (root, and the
   agent has no capability), which the proof covers. Turn the switch on after one clean start.
4. **ECS Exec is enabled on a box whose network is not locked.** See the row above: with a read-only
   root file system it does not work, and on a business person's box it is a root process outside the
   separation. The platform should turn it off when it turns the read-only switch on.
5. **No `ulimits`.** The design names `nofile` and `nproc` as the only per-task limits available. A
   workload can exhaust the task's processes or memory; the task then restarts. Stated, not protected.
6. **One token value arrives until a box is rebuilt.** The provisioner mints two values only when it
   registers a task definition. A box that the platform wakes from sleep, or that simply keeps
   running, keeps its old task definition and its one value. The image therefore keeps the
   compatibility switch ("The two tokens").
7. **A box that is rebuilt with `keep_image`** gets the NEW task definition (root, state volume,
   `DISPATCH_PRIVSEP=1`, two token values) with its OLD image. An image from before privilege
   separation ignores the variable and the state volume: its entrypoint, started as root, runs the
   daemon as uid 1000 after a `setpriv` step (it needs `SETUID` and `SETGID`, which remain), keeps
   its state in the home, and does not report `privsep-v1`. So such a box works for a developer and is
   refused for a business person, which is the intended fail-closed result. Not measured: that start
   on the real platform. The migration flag stays set for it, as it must.
8. **Which image a rebuild takes.** The provisioner of that branch takes the NEWEST image in the
   registry by push time. A pin by digest exists on another branch of the platform. Until the pin is
   what runs, every push of a box image to an environment's registry changes what the next rebuild,
   update or new workspace of that environment gets, and the update check names the pushed version.
9. **The proxy variables of a locked network and the daemon's own calls.** With `NODE_USE_ENV_PROXY=1`
   the daemon's calls to `OS_BASE_URL` follow `HTTPS_PROXY` / `HTTP_PROXY` too, unless `NO_PROXY`
   names that host. The provisioner's default `NO_PROXY` names only loopback. Either the proxy lets
   the platform's address through, or `NO_PROXY` must name it. Not measured; the box starts either
   way, but its company tools and its heartbeat depend on it.

### What the first start on the real platform must show

The design (hosted-privilege-separation.md, section 10) rests on seven assumptions about the platform
that the box checks ITSELF at every start, as the agent user. The stage engineer reads one log line,
`privsep.proof`: `guardOk: true`, `selfCheck: true`, `failures: []`, and then `privsep-v1` in
`GET <base path>/api/host-context`. A failed check is named in `failures`:

| # | Assumption | Names in `failures` when it does not hold |
| --- | --- | --- |
| 1 | The state root and its parent cannot be listed, read or written by the agent user | `state-parent`, `state-root`, `state-db`, `state-write` |
| 2 | The two tokens and the credential locators are in no environment the agent user can read | `env-clean`, `proc-environ-scan` |
| 3 | The daemon's environment, memory, open files and working directory cannot be read (nor the init process's environment) | `daemon-environ`, `init-environ`, `daemon-mem`, `daemon-fds`, `daemon-cwd` |
| 4 | The daemon cannot be signalled by the agent user | `signal-daemon` |
| 5 | `no_new_privs` is 1 and every capability set of a workload is empty | `no-new-privs`, `CapPrm-empty`, `CapEff-empty`, `CapAmb-empty`, `CapInh-empty`, `uid`, `no-root-group` |
| 6 | A set-uid program does not raise privilege | `setuid-su` |
| 7 | The agent run dir can be read and cannot be written by the agent user | `run-dir-read`, `run-dir-write` |

What the self-check cannot see. Measure each once, at the first start on the real platform:

| Assumption | What to measure | If it does not hold |
| --- | --- | --- |
| The runtime's default capability set holds `SETPCAP`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL` for a container that starts as root | The log has `privilege separation is ON`, then `daemon.start`; `CapBnd` in `/proc/<daemon pid>/status` is `00000000000000eb` | `setpriv` fails: the task stops at start |
| A volume mounted at `/var/lib/dispatch/state` leaves `/var/lib/dispatch` as root, `0700` | No line `FATAL: /var/lib/dispatch must be owned by root`; assumption 1 above passes | The entrypoint stops |
| One task role authorizes both access points (IAM, transit encryption) | The task reaches RUNNING; a refused mount stops it with `ResourceInitializationError` | The task never starts |
| The state access point's enforced user lets the daemon (root in the box) create, write and lock its database | `daemon.start` is logged; a thread's history survives a restart of the task | The daemon stops when it opens the database |
| Task volumes at `/run/dispatch` and `/tmp` take the image's owner and mode (`/tmp`: `1777`) | A chat thread answers a turn; `stat -c '%a' /tmp` prints `1777` | The harnesses cannot write scratch files |
| A workload cannot learn the path of the task's credential endpoint | As uid 1000: the task metadata address without its identifier gives no credential path (assumption 2 covers the environments) | An agent can use the box's own role: its own two access points, nothing of another box |
| `fs.protected_symlinks` is 1; whether a workload can make a user namespace | `cat /proc/sys/fs/protected_symlinks`; `unshare -Ur true` as uid 1000 | The proof shows that a user namespace opens nothing. A 0 matters only for `/tmp`, which the daemon does not trust |
