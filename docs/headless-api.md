# Headless API (`headless-v1`)

The contract for a chat view that runs OUTSIDE this web client (for example a page in the host
platform, "OS") and drives a hosted Dispatch daemon as an API. Dispatch itself is unchanged: the same
daemon serves its own web client (the developer's "native" window) and this API.

Every example below was captured from a running daemon (4.6.0, hosted mode, base path `/dispatch`, a
stub OS, a scripted `claude`). Ids, times and paths are from that run; long values are cut with `…`.

## 0. Ground rules

- **Origin and auth.** The view calls the daemon on the SAME origin, through the router, under the
  base path (`/dispatch/api/...`). The router adds the box token (`x-dispatch-box-token`); the browser
  sends no token. Every HTTP route and every WebSocket below needs it; a socket without it gets
  `HTTP 401 {"error":"unauthorized"}`. All paths below are relative to `/dispatch`.
- **Capability check.** `GET /api/host-context` lists `headless-v1` in `capabilities` when this
  contract holds. Do not drive a box without it. For a business person also require `gate-v2`
  (section 9): an image without it has the older gate.
- **One spelling per path.** Send every path exactly as this page writes it: lower case, single
  slashes, no trailing slash, no `.` or `..` segment, and escape only what must be escaped
  (`encodeURIComponent` of a parameter is right). Any other spelling gets
  `400 {"error":"bad_path", ...}` before anything else reads the request; a different case of a
  route word gets `404`. A router in front of the box must pass the path on unchanged.
- **Errors.** A refusal is JSON `{ "error": "<plain sentence>", ... }`. The business gate adds
  `code: "not_available_in_profile"` and `rule` (section 9). A file route that refuses a path adds
  `code: "path_refused"` and `reason` (`system`, `outside`, `daemon`, `harness`, `hardlink`).
- **Writes that start work** (`POST .../terminals`, `POST .../message`, `POST .../permission`) accept a
  request from the owner (box token) or a browser; a credential-free program is refused.

## 1. Version, profile and capabilities

`GET /api/host-context`

```json
{"profile":"business","hosted":true,"osBaseUrl":"http://127.0.0.1:48812","ownerEmail":"person@example.com",
 "capabilities":["base-path","os-tools-proxy","profile","headless-v1","idle-info","gate-v2","inbox-v1","live-tools-v1","privsep-v1"]}
```

| Capability | Meaning |
| --- | --- |
| `base-path` | Served under `DISPATCH_BASE_PATH`. |
| `os-tools-proxy` | Company tools reach OS only through the daemon; the box token never reaches a thread. (Name kept for OS; since 2026-11-11 each system is its own MCP server.) |
| `profile` | The business gate (section 9) follows OS's live profile. |
| `headless-v1` | This document, including `GET /api/chats`. |
| `idle-info` | The heartbeat reports `automations` and a real `lastActivityAt` (`docs/hosted.md`). |
| `gate-v2` | The business gate decides from the route that matched, with default deny (section 9); a path has one spelling; the file routes serve the person's own folders only. |
| `inbox-v1` | The Inbox routes of section 11 exist. A view that shows the Inbox checks for it first. |
| `live-tools-v1` | A running thread learns of a changed tool list: `POST /api/os/connections/refresh` is the platform's signal, and a system that is not connected has a `connect` tool (`docs/hosted.md`, "Live tool changes"). |
| `privsep-v1` | Only when THIS START proved privilege separation (`docs/hosted-privilege-separation.md`): absent on a box that runs as one user. Require it for a business person. |

`automations-safe` is NOT advertised: a business person may not start automations (section 9).

## 2. All chat threads in one call

`GET /api/chats` (added for this contract). Every plain chat thread of every live project: not
archived, an agent harness (`claude-code`, `codex`, `grok`, `opencode`) on the chat transport, no
role, runner or agent type. Newest activity first.

```json
{"chats":[{"id":"4831e4ef-aba8-4725-89e5-3f036413e53a","title":"there","projectId":"c9ff2a05-8e9c-440f-ad68-f28db2123ccd",
  "projectName":"Chats","harness":"claude-code","status":"needs_input",
  "lastActivityAt":"2026-11-12T04:27:56.941Z","createdAt":"2026-11-12T04:23:51.119Z","model":null}]}
```

`status` is one of `working`, `needs_input`, `error`, `idle` (every other internal value, such as
`waiting` or `done` after a restart, is `idle`). Live changes arrive on the events socket (section 6);
read this list again on `terminal:created`, `terminal:removed` and `session:tabs-changed`.

## 3. Projects and a new chat

A chat lives in a project (a folder). The view needs no project picker:

1. `GET /api/sessions` lists projects (`id`, `name`, `workingDir`, …). Find yours by `name`.
2. If it is not there, `POST /api/sessions` `{"name":"Chats"}` makes it. A name alone makes
   `~/projects/<name>`; `{"name":"Reports","workingDir":"~/reports"}` takes a `~` path.

```text
POST /api/sessions {"name":"Chats"}                         -> 201
{"id":"c9ff2a05-…","name":"Chats","workingDir":"/home/dispatch/projects/Chats","status":"waiting",…}
```

3. `POST /api/sessions/:projectId/terminals` `{"type":"claude-code","config":{"transport":"structured"}}`

```json
{"id":"4831e4ef-…","sessionId":"c9ff2a05-…","type":"claude-code","label":"Claude Code","status":"waiting",
 "config":{"transport":"structured","approvals":"smart","spawnDepth":0,
           "toolsAvailable":["shopify","acumatica","google-drive","data","display","connections","dispatch","plugin-previews"]},…}
```

For a business person the daemon forces `transport: "structured"` and `approvals: "smart"`. Optional
`config.model` picks a model. `label` is the title; the daemon names an untitled thread from its first
message (`title` in `/api/chats`, `label` on the thread).

## 4. Send, stop, rename, archive

| Action | Request | Answer |
| --- | --- | --- |
| Send a message | `POST /api/terminals/:id/message` `{"text":"…","source":"user"}` | `204` |
| Send images | same, `{"content":[{"type":"text","text":"…"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}],"source":"user"}` | `204` |
| Stop the turn | `POST /api/terminals/:id/interrupt` | `204`; `409` when no live chat process |
| Rename | `PATCH /api/terminals/:id` `{"label":"Order questions"}` | `200` the thread |
| Archive | `DELETE /api/terminals/:id` | `204` (the thread leaves `/api/chats`) |
| Archived list | `GET /api/sessions/:projectId/terminals/archived` | `200` list |
| Restore | `POST /api/terminals/:id/restore` | `200` |

`source: "user"` marks the person's own words (the heartbeat's activity, the thread namer). Send an
`Idempotency-Key` header to retry a send safely: the copy answers `200 {"duplicate":true}` and is not
delivered twice; a copy while the first is in flight gets `409 {"error":"in_flight"}`. A message sent
while a turn runs is queued by the harness as the next turn. There is no hard delete.

**Files.** `POST /api/sessions/:projectId/files/inbox` (multipart, field `file`, 50 MB at most):

```json
{"ok":true,"path":".dispatch/inbox/1794457729794-7dpxzvt7-sample.csv","absolutePath":"/home/dispatch/projects/Chats/.dispatch/inbox/…-sample.csv"}
```

The web client then sends an image as an `image` block (above) and any other file as a line
`Attached file: <path>` in the message text; the model reads it from the project folder.

## 5. The chat stream: `WS /api/terminals/:id/structured-ws?journal=1[&after=<seq>][&tail=<n>][&window=<n>]`

There is no subscribe message: connecting IS the subscription to that one thread. Open one socket per
visible thread. Connecting also starts a thread whose process a restart ended (with its history).

`window=<n>` (1 to 200): the first journal frame holds the newest `n` items. Ask for a small window
for a fast first paint, then read the items above it with the journal route below. `tail=<n>` then
bounds only the replay of a thread that has no journal yet. Without `window`, `tail` sets both. A
daemon from before this parameter ignores it and sends `tail` items.

**First frames, in this order**

1. `{"type":"system","subtype":"status","status":"idle","turnOpen":false,"generation":…,"sequence":0,"at":"…","activity":null}`
2. History:
   - `{"type":"journal","reset":true,"after":null,"items":[{"seq":26,"kind":"tool","at":"…","payload":{…}},…],"firstSeq":1,"lastSeq":29,"hasMore":true}`
     (with `after=<seq>`: `reset:false` and only the items after it), or
   - `{"type":"system","subtype":"inactive"}` when the thread has nothing yet (read history over REST).
3. Optional `{"type":"system","subtype":"model","model":"claude-fake"}`.
4. A pending approval, if any: `{"type":"permission","pending":{…}}` (below).

Ignore a replay tail of `{"type":"assistant","message":{"content":[]…}}` and `{"type":"result","subtype":"backfill"}`:
they only settle an older client's spinner.

**Live frames** (captured)

| Frame | What it is |
| --- | --- |
| `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello there"}]},"meta":{"source":"user"},"seq":1}` | the person's message, echoed |
| `{"type":"system","subtype":"status","status":"working","turnOpen":true,"sequence":1,"activity":"Working…",…}` | status; `turnOpen` is the "working" flag. Statuses: `working`, `needs_input`, `idle`, `error`, `done` |
| `{"type":"stream_event","uuid":"ev-…","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Streamed "}}}` | text delta (also `message_start`, `content_block_start`/`stop`, `message_stop`; thinking: `delta.type:"thinking_delta"`) |
| `{"type":"assistant","message":{"id":"msg_st1","content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"Streamed answer."}],"usage":{…}},"seq":5}` | the whole assistant message (replaces the deltas of the same `message.id`) |
| `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s","name":"mcp__shopify__search_orders","input":{"query":"this week"}}]},"seq":8}` | a tool call |
| `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_s","is_error":false,"content":[{"type":"text","text":"{\"orders\":[…]}"}]}]},"seq":9}` | its result |
| `{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":3,"usage":{"input_tokens":12,"output_tokens":8},"seq":11}` | turn end, with usage |
| `{"type":"result","is_error":true,"subtype":"process_exit","result":"Process exited (1): …"}` | the process died mid-turn |
| `{"type":"system","subtype":"dispatch_notice","level":"warning","message":"Company tools are not reachable right now. …"}` | a plain notice for the person |

**Company tool names.** Each company system is its own MCP server: `mcp__<server>__<tool>`, for
example `mcp__acumatica__search_sales_orders`, `mcp__data__query`, `mcp__display__chart`,
`mcp__connections__list`. A tool result whose JSON text has `"error":"not_connected"` carries
`label` and `connect_url`: show a Connect card. Display markers such as `[[chart:<id>]]` arrive
byte for byte in the tool result and in the assistant text.

**Approvals** (a thread on `smart`: routine work runs; the rest asks or is blocked)

- A request: `{"type":"system","subtype":"status","status":"needs_input","activity":"Needs approval: Bash",…}` then
  `{"type":"permission","pending":{"requestId":"req-ask-3","toolName":"Bash","input":{"command":"rm -rf ./build"},"toolUseId":"toolu_ask"}}`.
  Answer: `POST /api/terminals/:id/permission` `{"requestId":"req-ask-3","decision":"allow"}` or
  `{"requestId":"…","decision":"deny","message":"Not now"}` → `204` (`404` when it is gone). Then
  `{"type":"permission","pending":null}` clears the card on every viewer. A question tool
  (`AskUserQuestion`) carries `questions`; answer with `decision:"allow","answers":{…}`.
  `GET /api/terminals/:id/permission` reads the pending one (or `null`).
- A blocked action (the harness refused it by itself): `{"type":"system","subtype":"permission_blocked","block":{"id":"toolu_block","toolName":"Bash","title":"Wants to run a command","detail":"git push --force origin main","reason":"[Git Destructive] force push to main","at":…}}`.
  "Allow this": `POST /api/terminals/:id/blocked/<block.id>` `{"decision":"allow"}` (or `"keep"`) → `204`;
  the stream then shows `{"type":"system","subtype":"permission_blocked_resolved","id":"toolu_block","decision":"allow"}` and a
  line from Dispatch that asks the model to run the action again (`[Dispatch] The action that was blocked (…) may run once. …`).
  The allowance is held by the daemon, for that one call: it answers the retry of exactly that call itself, and
  anything else the model asks for in the meantime arrives as an ordinary approval request. No sentence in the
  conversation allows anything, and only this request (the person's, through the router) sets the allowance.
  If it could not be set, a `dispatch_notice` says so. `GET /api/terminals/:id/approvals` → `{"mode":"smart","blocked":[…],"pending":{…}|null}`.
- `control_request` / `control_response` frames are the harness's own protocol: ignore them.

**Ordering, reconnect, restart.** Frames arrive in order on one socket. Each finished item has a
`seq` (per thread, increasing; an item may be sent again with the SAME `seq` when the harness
updates it: replace by `seq`). Keep the newest `seq` you rendered. After a socket drop, reconnect with
`?journal=1&after=<seq>`: the journal frame then holds only newer items, so nothing repeats. After a
daemon restart the same works: the journal is on disk; the status frame's `generation` changes, and
`sequence` restarts at 0 (status frames are ordered by `generation`, then `sequence`). Stream deltas
are not in the journal: a turn cut by a drop shows when its `assistant` item lands. Older history:
`GET /api/terminals/:id/journal?before=<seq>&limit=<n>` (or `after=<seq>`) →
`{"items":[{"seq":27,"kind":"assistant","at":"…","payload":{…}}],"firstSeq":1,"lastSeq":29,"hasMore":true}`.

**Harness context is not the person.** A harness puts its own text in user-role items: Claude Code
`<system-reminder>` and `<local-command-caveat>`; Codex `<environment_context>`, `<user_instructions>`,
the AGENTS.md block (`# AGENTS.md instructions for …`) and `<turn_aborted>`. An item that holds only
such text has `kind: "context"`, and its payload (and the live frame) carries `isMeta: true` and
`dispatch_context: true`. Never show it as the person's message, never take a title from it, and do
not count it as unread. When the person's own message has such a block appended, the journal keeps
only the person's words. A slash command and its output (`<command-name>`, `<local-command-stdout>`)
stay `kind: "notice"`: a short marker, not the person's words.

## 6. The events socket: `WS /api/events`

One per page, all projects. No subscription; send the text `ping` to get `{"type":"pong"}`. Frames
captured: `terminal:created` (`terminal`), `terminal:removed`, `terminal:status`
(`{"terminalId":"…","status":"working","threadStatus":"working","activity":"Working…","turnOpen":true,…}`),
`session:status`, `session:tabs-changed`, `thread:prompt`, `thread:turn` (ms, tokens, outcome),
`thread:tool`, `thread:spawned` (`toolsAvailable`), `usage-limits`, `os:connections` (the state of
section 8), `analytics-dirty`. Unknown types: ignore.

## 7. Claude sign-in and usage

| Step | Request | Answer |
| --- | --- | --- |
| Status | `GET /api/claude-auth` | `{"authenticated":false,"session":null,"method":"claude-auth-login","account":null}` |
| Start | `POST /api/claude-auth/login` | `{"id":"…","status":"awaiting_code","url":"https://claude.com/cai/oauth/authorize?…&login_hint=person%40example.com","error":null}` |
| Show | open `url` in a new tab; the person copies the code (`<code>#<state>`) | |
| Submit | `POST /api/claude-auth/login/code` `{"code":"abc123#state"}` | `{"status":"complete",…}` |
| Wrong code | same | `200` with `status:"awaiting_code"` and a plain `error` ("That is not the whole code. …"); the person pastes again |
| Attempt gone | same | `400 {"error":"no login in progress","code":"no_session"}`: start again |
| Cancel / sign out | `POST /api/claude-auth/login/cancel` → `204`; `DELETE /api/claude-auth` | |
| Signed in | `GET /api/claude-auth` | `{"authenticated":true,…,"account":{"email":"person@example.com","plan":"max","orgName":null}}` |

Usage and limits: `GET /api/usage-limits/summary` →
`{"type":"usage-limits","at":…,"warnPercent":80,"providers":[…],"paused":[…]}` (the same object as the
`usage-limits` event; `providers` holds each account's windows once a thread reported them).
`POST /api/usage-limits/refresh` asks now. Per thread: `GET /api/usage-limits?terminalId=<id>`.

## 8. Company connections and tools

- `GET /api/os/connections` → `{"hosted":true,"reachable":true,"profile":"business","entitled":[…],"osToolsEnabled":true,"needsConsent":[{"system":"zendesk","label":"Zendesk","connectUrl":"…"}],"servers":[],"capabilities":[…]}`.
- `POST /api/os/connections/refresh` asks OS now (after the person connected a system).
- `GET /api/os/tools` → `{"enabled":true,"reachable":true,"tools":[{"name":"acumatica_search_sales_orders","server":"acumatica","tool":"search_sales_orders","system":"acumatica","description":"…","readOnly":null},…]}`.
  `server`/`tool` is how a thread sees it. The built-in `data` and `display` systems need no
  connection. The gateway's instructions ride the `data` server (tool names written `data.guide`,
  `display.chart`).

**A system the person has not connected yet** (2026-11-12). The gateway lists it with ONE tool,
`<system>_connect`; the thread gets a server for it as for any other system, with the one tool
`connect` (`mcp__google__connect`). When a request needs that system, the agent calls `connect`; the
result is OS's own text (the Connect card: `"error":"not_connected"`, `label`, `connect_url`) and one
more text block from the box with what happens next. When the person has connected the system, the
gateway lists the real tools and no `connect`.

**A running thread gets the new tools** without a restart where its harness allows it: the box sends
MCP `notifications/tools/list_changed` for that system (below). The box learns of the change from:

| Source | When |
| --- | --- |
| A fast re-check after a `connect` call | at once, then every 5 s for 5 minutes, that system only; ends at the first change |
| `POST /api/os/connections/refresh` | **the platform's signal**: call it (through the router, with the box token) when the person finished a Connect flow; every running thread with that system's server gets list_changed at once |
| The OS poll | every 60 s, when OS's answer changes |
| The `refresh` tool of the `connections` server | the agent calls it (the `connect` result tells it to, when the tools do not come) |

| Harness (version measured) | Running thread after the person connects | Evidence (2026-11-12, real CLI, stub model, no real model) |
| --- | --- | --- |
| Claude Code 2.1.322 | **yes, live** (HTTP and stdio) | after list_changed it asks `tools/list` again; the new tool is in its tool list on the next model request and is called. Also end to end through the daemon route with the fast re-check |
| OpenCode 1.18.34 | **yes, live** (HTTP and stdio) | the same. The image's 1.19.5 was not run |
| Codex 0.167.0 | **no: a new thread is needed** | it opens no event stream, ignores list_changed (also on stdio), keeps the old list on the next turn, and `config/mcpServer/reload` does not change a loaded thread. Its `connect` result says so and tells the agent to ask the person to send the request again in a new thread |
| Grok | not measured: treated as "a new thread is needed" | |

A system that appears mid-thread (the person was just granted it) gets no new server in a running
thread: servers are fixed when the thread starts. It reaches new threads only. For Codex, a thread that
is resumed after the app-server unloaded it (`thread/unsubscribe`, `thread_unload_delay_secs`, then
`thread/resume`) also gets the new tools with its history: measured, not wired into Dispatch.

The view can offer "Send again in a new thread" when a Codex thread's tool result or text says so.

**How a thread receives list_changed.** Each company server is the daemon route
`/api/os/mcp/<system>` (streamable HTTP). `initialize` always declares `capabilities.tools.listChanged:
true` (a harness subscribes only then). `GET` with `Accept: text/event-stream` and the thread's key opens
the server-to-client event stream; each change is one event
`event: message` / `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`, and a
comment line every 25 s keeps it open. A `GET` without that header still answers `405`. A harness on the
stdio bridge (`os-mcp-bridge.js`) gets the same notification on stdout: the bridge opens the stream after
`initialize` and opens it again (with one list_changed) after a daemon restart.

## 9. What the business profile allows and refuses (capability `gate-v2`)

`403 {"error":"<plain sentence>","code":"not_available_in_profile","rule":"<id>"}`. Hide these controls
for a business person.

**Default deny.** Every route and every WebSocket of the daemon has one row in one table
(`packages/core/src/profile/business-routes.ts`): allowed, refused, or allowed for some bodies. The
decision is made by the route that matched the request, not by the text of the URL, so no spelling of
a path changes it. A route with no row answers `rule: "unclassified"`. A `GET` is not allowed just
because it is a `GET`: a read of a secret or of the machine is refused too.

What this contract needs is allowed: sections 1 to 8 and 11, and the file routes inside the person's project.

| Rule | Refused request |
| --- | --- |
| `thread.create` | a `shell` or `browser` thread; a CLI thread (`transport:"pty"`); a thread with `role`, `runner`, `agentType`, `roleAuthority`, `autonomy:"autonomous"`, approvals other than `smart`; `queued:true` |
| `thread.not-chat` | a message, an approval answer, "Allow this", restart, restore, continue, model, effort, account or compact for a thread that is not a chat thread (a shell, a CLI thread, an agent, a runner made earlier). Stop, interrupt and archive stay allowed. Its `structured-ws` socket answers `403` |
| `thread.transport.cli`, `thread.pty-input`, `thread.pty-output` | switching to the CLI; typing into a terminal; reading a terminal's scrollback; the terminal WebSockets |
| `thread.approvals`, `thread.autonomy` | approvals other than `smart`; the autonomous dial |
| `thread.config`, `thread.branch`, `thread.start-queued` | `PATCH /api/terminals/:id` with a config of the forms above; branching a thread; starting a queued agent |
| `project.folder`, `project.relaunch` | `POST /api/sessions` with a `workingDir` outside `~/projects` (send a name alone); `POST /api/sessions/:id/relaunch` |
| `automation.create`, `automation.update`, `automation.run`, `role.enable`, `coordinator.create`, `watch.create` | everything that creates, changes, enables or runs an automation, a role, a coordinator or a watch |
| `chat` | the "Chat" (Endless) routes, except reading its state: its turns run with every tool allowed |
| `worktree.create`, `review.diff`, `files.browse`, `files.reveal` | worktrees; the diff review routes; the folder browser of the machine |
| `plugin.*`, `skill.install`, `skill.enable`, `integration.*`, `setup.install` | adding, enabling, updating or exporting a plugin, a skill or a tool connection; installing a CLI |
| `secrets`, `settings`, `devices`, `analytics`, `control-plane` | Doppler secrets (also reading a value); the machine's settings (`PUT`); device sign-in; analytics; the decision ledger (`POST`) |
| `inbox.secret` | the value of a `secret` drop in the Inbox (section 11) |
| `agent-key` | any request that carries a thread's or a plugin's own key, except the few an agent needs: its company tools (`/api/os/mcp/:system`), its own status and hook events, who it is, the project and thread lists, and its Inbox files. A key cannot start or message a thread, answer an approval, change approvals or add a tool |
| `unclassified` | a route that has no row in the table |

Files: every file route checks its path against the person's folders (`code: "path_refused"`). A business
person gets the project the request names, which must be a folder of `~/projects`; never a folder that
configures an agent program (`.claude`, `.codex`, `.git`, `.mcp.json`, …) and never `/proc` and the like.

Automations for a business person: list (`GET /api/agents/schedules`, `GET /api/agents/runs`),
cancel a run and delete a schedule; never create, change, enable or run one. A run starts its
harness with every approval skipped, so this stays refused until a run can use `smart` approvals and
end itself on a blocked action (no capability `automations-safe` yet). Under the business profile the
daemon also refuses to START anything but a chat thread, whatever asked for it.

## 10. Idle information (capability `idle-info`, for OS, not the view)

The heartbeat (`POST <OS>/api/dispatch/heartbeat`, every 30 s) carries, captured:

```json
"automations":{"enabled":1,"nextRunAt":"2026-11-13T09:00:00.000Z","kinds":{"schedules":1,"pluginJobs":0,"parkedThreads":0}},
"lastActivityAt":"2026-11-12T04:29:28.302Z"
```

Four beats in a row with no action kept the same `lastActivityAt`. What is counted and what moves
`lastActivityAt` is in `docs/hosted.md` ("Idle info"). A schedule that falls due while the box sleeps
runs once on the first tick after the next start.

## 11. The Inbox (drops a thread hands the person)

The bundled plugin with the MCP tool `mcp__plugin-previews__preview` is the **Inbox**: a thread puts
files, tables, images, links, commands and text there for the person. Plugin id `previews`, server id
`plugin-previews`, tool `preview`: clients match on these ids, so they stay. On a hosted box the names a
person reads say Inbox: the server's `serverInfo.title` is `Inbox`, the tool's `title` and
`annotations.title` are `Put in Inbox` (a local install shows neither).

The examples below were captured from a daemon build with a fake harness (`tests/routes/inbox.test.ts`,
`INBOX_CAPTURE=<file>`): the drops were made by the real Inbox MCP server under a thread's key, then
read as the owner. Every route works the same for the developer and the business profile, except
the secret (below).

**The tool's input** (`tools/list`, abridged): `kind` (`command`, `link`, `code`, `secret`, `steps`,
`diff`, `table`, `doc`, `text`, `images`, `files`; default inferred), `paths` (files of the thread's
project: png, jpg, gif, webp, svg, pdf, html, md, txt, csv, json; up to 20), `text` (up to 64 KB),
`commands`, `cwd`, `url` (`link`), `language` (`code`), `steps` (`[{text, command?}]`, up to 30),
`title`, `note`. The checks are in `packages/plugins/previews/mcp/kinds.mjs`.

**Where a drop is stored.** One document `preview:<dropId>` of the plugin `previews` in the daemon's
database (`plugin_data`). Each file is a file reference (`plugin_files`) with a copy made when it was
posted: `<data dir>/plugin-files/previews/<fileId><ext>` (25 MB at most; a bigger file is served from
the project, with every check of the path policy). A secret's value is removed 24 hours after it was posted.

| Route | Answer |
| --- | --- |
| `GET /api/inbox` | the drops, newest first. Query: `threadId`, `projectId`, `unread=1`, `limit` (default 200, at most 1000), `before=<createdAt>` (the next page). `{drops, hasMore, unread}`; `unread` counts every drop |
| `GET /api/inbox/unread` | `{total, byThread, byProject}` |
| `GET /api/inbox/drops/:dropId` | `{drop}`; `404` when it is gone |
| `GET /api/inbox/drops/:dropId/files/:fileId` | the bytes of a file THAT DROP lists, by its id |
| `POST /api/inbox/drops/:dropId/read` | marks it read: `{drop}` |
| `POST /api/inbox/read` | marks every unread drop read; body `{}`, `{"threadId":"…"}` or `{"projectId":"…"}`: `{marked}` |
| `DELETE /api/inbox/drops/:dropId` | `204`; the drop, its file references and their copies go |
| `GET /api/inbox/drops/:dropId/secret` | developer only: `{value}` of a `secret` drop on this explicit request (`410` after its 24 hours). Business: `403` rule `inbox.secret` |

Only the owner (the box token through the router, or the owner's page) may call them; a thread's or a
plugin's key gets `403`. No capability names these routes: on an older box `GET /api/inbox` is not a
route and answers an error, so a view can hide the Inbox there. Under the business profile they are classified in the route table (section 9):
all allowed except the secret.

`GET /api/inbox?limit=2`, captured:

```json
{"drops":[
  {"id":"8988068e-e422-453c-bd92-1ce021e98d55","threadId":"T1","threadTitle":"Sales by region","projectId":"P1","projectName":"Reports",
   "title":"example.com","note":"The shared report.","kind":"link","createdAt":"2026-11-12T14:27:24.249Z","read":false,"readAt":null,
   "files":[],"text":"https://example.com/report","url":"https://example.com/report"},
  {"id":"bd86fc3e-b94b-47a7-839d-904f5c2113b2","threadId":"T1","threadTitle":"Sales by region","projectId":"P1","projectName":"Reports",
   "title":"API token","note":"For the import.","kind":"secret","createdAt":"2026-11-12T14:27:24.244Z","read":false,"readAt":null,
   "files":[],"text":null,"secret":{"present":true,"expired":false}}],
 "hasMore":true,"unread":4}
```

`GET /api/inbox/drops/c1ebff7f-…` (a `table` drop with one file):

```json
{"drop":{"id":"c1ebff7f-affc-4fc9-81a5-5f29536e973c","threadId":"T1","threadTitle":"Sales by region","projectId":"P1","projectName":"Reports",
 "title":"Sales by region","note":"This week, from the order system.","kind":"table","createdAt":"2026-11-12T14:27:24.215Z","read":false,"readAt":null,
 "files":[{"id":"64bc0b11-5841-4f91-894c-c68db44000de","name":"sales.csv","size":32,"type":"text/csv",
           "url":"/api/inbox/drops/c1ebff7f-affc-4fc9-81a5-5f29536e973c/files/64bc0b11-5841-4f91-894c-c68db44000de"}],
 "text":null}}
```

A drop's fields: `kind` null means "infer the look" (images only: pictures; one file: that file;
else text). By kind: `text` (the text to show or copy; null for a `secret`, always), `url` (`link`),
`commands` and `cwd` (`command`), `language` (`code`), `steps` (`steps`), `secret: {present, expired}`
(`secret`). A file `url` starts with `/api/`: put the base path (`/dispatch`) in front.

The file, captured:

```text
GET /api/inbox/drops/c1ebff7f-…/files/64bc0b11-…   -> 200
content-type: text/csv
content-disposition: attachment; filename="sales.csv"; filename*=UTF-8''sales.csv
x-content-type-options: nosniff
content-security-policy: sandbox; default-src 'none'
cache-control: private, max-age=300

region,total
North,120
South,95
```

File rules: only a file the drop lists, by id; never a path (another drop's file id, an unknown id or a
path-like id: `404`, or `400 bad_path`). Every file goes out with `nosniff` and `attachment`. HTML, SVG
and other markup go out as `application/octet-stream`, so no file a thread made runs as a page; an
`<img>` of a png, jpg, gif or webp still works (fetch the bytes and show them). A file that has no copy
is checked against the project's folder and the path policy at each request (a file that became a link
out of the project is refused).

The other answers, captured: `GET /api/inbox/unread` → `{"total":4,"byThread":{"T1":4},"byProject":{"P1":4}}`;
`POST /api/inbox/drops/c1ebff7f-…/read` → `{"drop":{…,"read":true,"readAt":"2026-11-12T14:27:24.260Z",…}}`;
`POST /api/inbox/read` `{"threadId":"T1"}` → `{"marked":3}`; `DELETE /api/inbox/drops/8988068e-…` → `204`;
business `GET /api/inbox/drops/bd86fc3e-…/secret` →
`403 {"error":"A secret that a thread handed you is not shown in your workspace.","code":"not_available_in_profile","rule":"inbox.secret"}`.

**A secret drop.** A list or drop answer never carries the value: the view shows that a secret exists
(`secret.present`) or that it expired. For a business person the value is not shown at all, also not
through the plugin's own data routes (`GET /api/plugins/previews/data…` answers `text: null,
redacted: true` for a secret under the business profile). The developer gets it on an explicit
request for that one drop (`…/secret`, `Cache-Control: no-store`).

**Events.** On the events socket (section 6) each new drop, each read mark and each delete is one frame,
captured: `{"type":"plugin:data","id":"previews","key":"preview:c1ebff7f-affc-4fc9-81a5-5f29536e973c"}`
(a new or changed drop: read `GET /api/inbox/drops/<id>`) and
`{"type":"plugin:data","id":"previews","key":"preview:8988068e-…","deleted":true}`. Ignore frames of another plugin id.

**Not now (an option for later).** An agent cannot make a file available to the person without the
Inbox plugin (when the plugin is disabled or absent, the `preview` tool is not there). A daemon tool that
registers a file of the thread's project as a drop would close that.
