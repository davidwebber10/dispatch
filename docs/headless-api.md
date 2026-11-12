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
  contract holds. Do not drive a box without it.
- **Errors.** A refusal is JSON `{ "error": "<plain sentence>", ... }`. The business gate adds
  `code: "not_available_in_profile"` and `rule` (section 9).
- **Writes that start work** (`POST .../terminals`, `POST .../message`, `POST .../permission`) accept a
  request from the owner (box token) or a browser; a credential-free program is refused.

## 1. Version, profile and capabilities

`GET /api/host-context`

```json
{"profile":"business","hosted":true,"osBaseUrl":"http://127.0.0.1:48812","ownerEmail":"person@example.com",
 "capabilities":["base-path","os-tools-proxy","profile","headless-v1","idle-info"]}
```

| Capability | Meaning |
| --- | --- |
| `base-path` | Served under `DISPATCH_BASE_PATH`. |
| `os-tools-proxy` | Company tools reach OS only through the daemon; the box token never reaches a thread. (Name kept for OS; since 2026-11-11 each system is its own MCP server.) |
| `profile` | The business gate (section 9) follows OS's live profile. |
| `headless-v1` | This document, including `GET /api/chats`. |
| `idle-info` | The heartbeat reports `automations` and a real `lastActivityAt` (`docs/hosted.md`). |

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

## 5. The chat stream: `WS /api/terminals/:id/structured-ws?journal=1[&after=<seq>][&tail=<n>]`

There is no subscribe message: connecting IS the subscription to that one thread. Open one socket per
visible thread. Connecting also starts a thread whose process a restart ended (with its history).

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
  the stream then shows `{"type":"system","subtype":"permission_blocked_resolved","id":"toolu_block","decision":"allow"}` and a user
  message that approves it. `GET /api/terminals/:id/approvals` → `{"mode":"smart","blocked":[…],"pending":{…}|null}`.
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
  `server`/`tool` is how a thread sees it. A system that needs consent has no server in a thread until
  it is connected; a running thread keeps the servers it started with, a new thread gets the new set.
  The built-in `data` and `display` systems need no connection. The gateway's instructions ride the
  `data` server (tool names written `data.guide`, `display.chart`).

## 9. What the business profile refuses

`403 {"error":"<plain sentence>","code":"not_available_in_profile","rule":"<id>"}`. Hide these controls
for a business person. Every GET stays allowed.

| Rule | Request |
| --- | --- |
| `thread.create` | a `shell` or `browser` thread; a CLI thread (`transport:"pty"`); a thread with `role`, `runner`, `agentType`, `roleAuthority`, `autonomy:"autonomous"`, approvals other than `smart`; `queued:true` |
| `thread.transport.cli`, `thread.pty-input` | switching to the CLI; typing into a terminal; the terminal WebSockets |
| `thread.approvals` | approvals other than `smart` |
| `thread.autonomy` | the autonomous dial |
| `thread.config` | `PATCH /api/terminals/:id` with a config of the forms above |
| `automation.create`, `automation.update`, `automation.run` | `POST /api/agents/schedules`, `PATCH /api/agents/schedules/:id`, `POST …/run-now` |
| `role.enable`, `coordinator.create`, `thread.start-queued` | a role, a coordinator, a queued agent |
| `worktree.create`, `plugin.*`, `skill.install`, `integration.*` | machine features |

Automations for a business person: list (`GET /api/agents/schedules`, `GET /api/agents/runs`),
cancel a run and delete a schedule; never create, change, enable or run one. A run starts its
harness with every approval skipped, so this stays refused until a run can use `smart` approvals and
end itself on a blocked action (no capability `automations-safe` yet).

## 10. Idle information (capability `idle-info`, for OS, not the view)

The heartbeat (`POST <OS>/api/dispatch/heartbeat`, every 30 s) carries, captured:

```json
"automations":{"enabled":1,"nextRunAt":"2026-11-13T09:00:00.000Z","kinds":{"schedules":1,"pluginJobs":0,"parkedThreads":0}},
"lastActivityAt":"2026-11-12T04:29:28.302Z"
```

Four beats in a row with no action kept the same `lastActivityAt`. What is counted and what moves
`lastActivityAt` is in `docs/hosted.md` ("Idle info"). A schedule that falls due while the box sleeps
runs once on the first tick after the next start.
