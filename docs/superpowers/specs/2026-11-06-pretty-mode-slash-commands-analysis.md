# Pretty mode: slash commands, model and effort — analysis

Date: 2026-11-06. Status: analysis, then the live spikes (see "Spike results"). The build plan is
`docs/superpowers/plans/2026-11-09-pretty-slash-menu-rebuild.md` (PR #155 was built on 3.25.1 and is replaced by it;
the model control in sections 2 and 4 is now the 4.2.0 model chip, not a new picker). Source: `origin/main` at `e6b93698`
(v3.24.2). Installed CLIs that I checked with `--help` and binary strings only (no sessions):
Claude Code 2.1.316, codex-cli 0.166.0, grok 1.0.70, opencode 2.2.5.

## The owner's ask

In a Pretty (structured) thread — a normal thread, an overseer (Control Plane) or Dispatch
Chat — the owner wants to send commands such as `/model` and `/effort`, ideally from a slash
command menu. Today the owner switches the thread to CLI, types the command, and switches back.

## Short answer

- Pretty mode does not know about slash commands. The composer sends the typed text to the
  harness as a normal user message. Dispatch adds nothing and removes nothing.
- What happens next depends on the harness. Claude Code treats a leading `/` as a command, so
  some commands work by accident. Codex, Grok and OpenCode get the text as a normal prompt.
- All four harnesses have a protocol call that changes the model mid-session, and three of
  them can also change effort. Dispatch uses none of these calls today.
- The CLI round trip does not always keep the change. Overseers cannot go to CLI at all.
- The best fix is a small "/" menu of commands that Dispatch runs itself, plus a model and
  effort picker. See "Options" and "Recommendation".

## 1. How Pretty mode works today, per harness

| Harness | Pretty process | How a message gets in | Typed `/model opus` today |
|---|---|---|---|
| Claude Code | One `claude -p --input-format stream-json --output-format stream-json` process per thread. It stays alive across turns. | One JSON line on stdin: `{type:'user', message:{content}}`. | Reaches the CLI as text. The CLI parses a leading `/`, so it works, for this session only (verified live, see "Spike results"). |
| Codex | One shared `codex app-server` (JSON-RPC over stdio) for the whole daemon. One app-server thread per Dispatch thread. | `turn/start` (or `turn/steer` during a turn) with the text as input. No model or effort is sent. | Sent to the model as a prompt. The app-server does not parse slash commands. The model reads "/model opus" as a request. |
| Grok | One `grok agent stdio` (ACP, JSON-RPC) process per thread. | `session/prompt`. | Sent as prompt text. ACP lets an agent advertise commands; Dispatch ignores that list. Whether Grok runs it is not verified. |
| OpenCode | One `opencode acp` process per thread (same manager as Grok). | `session/prompt`. | Same as Grok. Not verified. |
| Dispatch Chat | A new `claude -p` process for each turn (`--no-session-persistence`). The model is fixed to `opus`. No effort is set. | Dispatch builds one message: the conversation view, a status block and your text. | Your text is inside a larger message, so it is never a command. The model reads it as words. |
| Overseer | A Claude (or Codex) Pretty thread with the coordinator role. Same transport as a normal thread. | Same as the harness. | Same as the harness. The overseer cannot switch to CLI. |

Note on Claude Code. The 2.1.316 binary has two versions of `/model` and `/effort`: a panel
version for the terminal UI and a plain version (`supportsNonInteractive`) for `-p` mode. The
plain version is the one that runs in a Pretty thread. The live spike confirmed it: a typed
`/model haiku` or `/effort high` works and answers "for this session only". It does NOT change
the global default (an earlier version of this document said it did; that was wrong, the
"saved as your default" text belongs to the terminal UI panel version). `settings.json` was
byte-identical afterwards. One real problem remains: after Dispatch sets a model with a
control request, a later typed `/model` says "set" but the model does not change (the control
override masks it). So Dispatch must catch typed `/model` and `/effort` in a Claude thread and
run its own control-request version.

Where (all paths in `packages/`):

- Claude spawn arguments: `core/src/providers/claude-code.ts:103-139` (`-p`, stream-json in and
  out, `--model` at line 127, `--effort` at line 128).
- Claude send: `core/src/structured/manager.ts:549-580` writes the text as is. The Compact button
  already uses this route: `compact()` at `manager.ts:590-592` writes the literal text
  `/compact`. Stop uses a stream-json `interrupt` control request (`manager.ts:681-687`).
- Codex spawn: `core/src/providers/codex.ts:75-80` (base `codex app-server`). Send:
  `core/src/structured/codex-manager.ts:654-680` (`turn/start` with `threadId` and `input`
  only). The model is sent only at `thread/start` and `thread/resume` (`codex-manager.ts:328-360`).
  Compact: `thread/compact/start` (`codex-manager.ts:717-721`).
- Grok and OpenCode: `core/src/structured/grok-manager.ts:1-31` (ACP design), `:252` and `:258`
  (`session/load`, `session/new`), `:276-284` (the model is read from the bind response),
  `:468-473` (compact is a no-op). The ACP command list is dropped at
  `core/src/structured/grok-translate.ts:175`. Grok spawn: `core/src/providers/grok.ts:113-135`
  (`-m` only, no effort). OpenCode spawn: `core/src/providers/opencode.ts:72` (`opencode acp`).
- Chat: `core/src/endless/claude-args.ts:9` (`TURN_MODEL = 'opus'`) and `:64-80`; spawn per turn
  at `core/src/endless/turn-runner.ts:269-276`.
- The send path has no slash handling anywhere: `web/src/components/tabs/chat/useStructuredChat.ts:936-946`,
  `core/src/routes/terminals.ts:154`, and the managers above.

### What the CLI round trip keeps, and what it loses

- Claude, plain user thread: kept. On each relaunch Dispatch reads the model and effort of
  the last turn from the transcript and saves them (`core/src/sessions/thread-settings.ts:23-39`,
  `core/src/sessions/service.ts:2722-2733`).
- Claude, thread with a role or an agent type: lost on the next relaunch. The adoption skips
  these threads on purpose, so Dispatch policy sets their model.
- Codex: probably lost when the thread has a saved model. `thread/resume` sends the saved
  `config.model` (`codex-manager.ts:334`), and nothing reads a CLI `/model` change back. Effort
  is never sent. Not verified live.
- Grok and OpenCode: no CLI round trip. `switchTransport` allows Claude Code and Codex only.
- Overseer: no CLI round trip. `switchTransport` refuses to move a coordinator to CLI
  (`service.ts:2121-2125`).

## 2. What already exists

- One shared composer, `web/src/components/composer/PillComposer.tsx`, for Pretty threads,
  Control Plane, Chat and the phone CLI box. Its **+** menu takes extra rows (`menuExtra`).
- A slash command sheet for **CLI threads on a phone only**:
  `web/src/components/tabs/TerminalTab.tsx:99-135` (fixed Claude and Codex lists),
  `:1030-1033` (the **+** row), `:1074-1090` (the sheet, `isMobile` only). It types the command
  into the terminal. Pretty mode has no such sheet.
- The Keys sheet (v3.13.0) is for CLI threads on a phone. It sends terminal key codes.
- A model picker exists only when you create a thread (`web/src/components/sidebar/NewThreadModal.tsx:87`,
  `:186-223`). There is no effort picker anywhere in the web app. The saved effort is only
  what the transcript adoption writes.
- The model name shows in the status row under the composer
  (`web/src/components/ContextIndicator.tsx:87`). It reads the model from the Claude
  `system/init` event (`useStructuredChat.ts:494-497`). It is not a control.
- Commands that Dispatch already runs, each with a route in `core/src/routes/terminals.ts`:
  Stop (`/interrupt`, line 256), Compact (`/compact`, line 267, Claude and Codex), Switch to
  CLI or Pretty (`/transport`, line 342), Restart (`/relaunch`, line 401), Switch account
  (`/account`, line 360), Autonomy (`/autonomy`, line 240), Branch, Archive. The overseer also
  has Restart session, New session and Previous sessions.
- `switchAccount` (`service.ts:2176-2226`) is a working pattern for "change a setting, then
  stop and resume the thread": wait for the turn to end, kill, merge the config, respawn with
  resume.
- The overseer model: an explicit `config.model` wins over the coordinator tier
  (`core/src/overseer/prompts.ts:552-558`). So a picker can set it.

## 3. Which commands can work in Pretty mode

### Protocol calls that change a live session (no restart)

| Harness | Model | Effort | Permission mode | Evidence |
|---|---|---|---|---|
| Claude Code | `control_request` `set_model` | `control_request` `apply_flag_settings` with `effortLevel` (session only, no saved default) | `set_permission_mode` | Subtype strings and handlers in the 2.1.316 binary. Same stdin channel that Dispatch already uses for `interrupt`. Not run. |
| Codex | `turn/start` field `model` | `turn/start` field `effort` | `approvalPolicy`, `sandboxPolicy` | The `generate-json-schema` output says each one applies "for this turn and subsequent turns". `model/list` gives the models and the efforts each one supports. |
| Grok | `session/set_model` | `session/set_config_option` (probably) | `session/set_mode` | Method names in the binary. Not run. Fallback: restart with `-m` and `--reasoning-effort`. |
| OpenCode | `session/set_config_option` (the bind response has a `model` option) | Not known | `session/set_mode` | Method names in the binary and the test fixture. Not run. Fallback: restart with a new per-thread config file. |
| Chat | A Dispatch setting. The next turn uses it. | Same | Not applicable | Each turn is a new process, so no restart is needed. |

Other Claude control requests in the binary that Dispatch could use: `get_context_usage`,
`get_usage`, `get_session_cost`, `get_status`, `mcp_status`, `mcp_reconnect`,
`reload_plugins`, `reload_skills`, `stop_task`. The `reload_plugins` call fixes the old
"stale MCP tools" problem without a restart. The 2026-08-05 coordinator spec said that this
was not possible.

### Restart with new flags (works for all, costs more)

Kill the process and respawn it with resume, as `switchAccount` does. Claude keeps the
conversation (`-r`, Dispatch backfills from the transcript). Codex, Grok and OpenCode resume
by thread or session id. Use this only when no live call exists.

### Native commands that already work as text (Claude only)

Claude `-p` mode lists the commands that it accepts in the `system/init` event
(`slash_commands`). A fixture from 2.1.183 has: `clear`, `compact`, `context`, `usage`,
`init`, `review`, `security-review`, `config`, `insights`, `goal`, `reload-skills`, and every
skill and plugin command. The output comes back as a `local-command-stdout` user entry, which
the chat already shows as a small notice. A panel command (for example `/permissions`,
`/agents`, `/mcp` without arguments) answers "opens an interactive panel and isn't available
in this environment".

Codex: the app-server does not parse slash commands. Some have RPC equivalents:
`thread/compact/start`, `review/start`, `account/rateLimits/read`, `model/list`, `skills/list`.
Grok and OpenCode: ACP sends `available_commands_update` with the list of commands that the
agent accepts as prompt text. Dispatch drops that list today.

### Interactive only (cannot work in Pretty without new UI)

Panels in the terminal UI: `/permissions`, `/agents`, `/memory`, `/mcp` (panel), `/config`
(panel), `/resume` (picker), `/rewind`, `/vim`, `/export`, `/hooks`. Codex `/approvals`,
`/diff`, `/mention`. Dispatch would have to build each one as web UI.

### Commands that Dispatch can run itself

| Command | What Dispatch does | Exists today? |
|---|---|---|
| `/model` | Saves `config.model`, then applies it live or restarts. | No (new) |
| `/effort` | Saves `config.effort`, then applies it live or restarts. | No (new) |
| `/compact` | `POST /compact` | Yes (button) |
| `/stop` | `POST /interrupt` | Yes (button) |
| `/cli` | `POST /transport` | Yes (header menu) |
| `/restart` | `POST /relaunch` | Yes |
| `/account` | `PATCH /account` | Yes (v3.23.0) |
| `/autonomy` | `POST /autonomy` (supervised or autonomous) | Yes (overseer controls) |
| `/context`, `/usage` | Open the existing context detail and usage limits panels. | Yes (panels) |
| `/clear`, `/new` | Archive this thread and start a new one with the same settings. Never a silent wipe. | Partly |
| `/reload` | Claude `reload_plugins`, else restart. | No (new) |

## 4. Options

Sizes are for one implementer with tests, plus one live check per harness.

| | A. Model and effort picker | B. "/" menu of Dispatch commands | C. Native passthrough menu | D. Full parity |
|---|---|---|---|---|
| What you see | The model name in the status row under the composer becomes a button. It opens a small panel: model list and effort levels. A note says "applies from the next turn". | Type `/` at the start of the composer. A list opens above it, filtered as you type. Enter runs the command. `/model` and `/effort` open the picker from A. The **+** menu gets a "Commands" row for the phone. | The same list also shows the harness's own commands: Claude skills and plugin commands from `system/init`, ACP commands from Grok and OpenCode. Dispatch sends these as text. | B and C, plus web versions of the panels: permissions, MCP, agents, memory, rewind, resume picker. |
| Normal threads | All four harnesses. | All four harnesses. Unsupported commands are grey with a reason. | Claude: good. Grok and OpenCode: what the agent lists. Codex: only the RPC-mapped commands. | All. |
| Overseer | Yes. This is the only way to change its model or effort without a new session. | Yes, without `/cli`. | Claude overseer: yes, but skills can conflict with the coordinator policy. | Yes. |
| Chat | Yes, as a Chat setting (Chat has no per-thread process). | A short list: `/model`, `/effort`, `/stop`. | No. Chat turns are built messages. | Partly. |
| Size | About 8 to 12 files, 2 to 3 days. | A plus about 6 files, 2 more days (4 to 5 total). | B plus 2 to 3 days. | Weeks. Not a fit. |
| Main risks | A model change loses the prompt cache on the next turn (the cache is per model). A restart fallback (Grok and OpenCode) can fail to resume. Overseer tier policy (see decisions). | A command must never reach the model by mistake. A literal `/path` at the start of a message needs an escape: a leading space (verified live: Claude sends ` /effort high` to the model as text). | Dispatch must catch typed `/model` and `/effort` in Claude threads (the control override masks the typed version). Panel commands answer "not available". | Every CLI update can break a panel. |

### Detail: how A works

1. A new route, `PATCH /api/terminals/:id/settings` with `model` and `effort`, owner only. It
   merges into the thread config, like the account route does.
2. A new manager method, `applySettings`. Claude sends `set_model` and `apply_flag_settings`
   on stdin. Codex keeps the values and adds them to the next `turn/start`. Grok and OpenCode
   try the ACP calls, else restart with resume.
3. Dispatch saves the config first, then applies it. So a relaunch, an update or a CLI switch
   keeps the choice, also for role threads, which the transcript adoption skips.
4. The model list comes from the same source as the New Thread modal. The effort list comes
   from the harness: Claude low to max, Codex from `model/list`, Grok from its flag.
5. During a turn, the change waits for the turn to end. It does not stop the turn.

## Recommendation

Build **A and B together** as one feature, for Claude Code and Codex first, with live calls
(no restart). Then add Grok and OpenCode with the restart fallback. Leave C for later. Add
only the Claude skills list from C if the owner wants skills in the menu.

Reasons:

- A fixes the exact pain (model and effort) on every surface, including the overseer, which
  has no workaround today. B gives the menu that the owner asked for, and most commands in it
  already exist as routes.
- Live calls keep the conversation and the process. Only the model change costs a cache miss,
  and the CLI round trip has the same cost.
- C has small value beyond skills, and a model change that it passes through as typed text is
  masked by Dispatch's own control request (see "Spike results").

Measured use: in the last 30 days, about 1,100 Claude sessions on this Mac had transcripts.
`/model` or `/effort` shows in about 6 real sessions (some are test sessions). So the change
is rare, but each one costs two transport switches. For an overseer there is no way at all.

The spikes below were run on 2026-11-06 before the build.

Before the build, run four short spikes (minutes each, close to zero cost). Each one needs an
owner OK, because each one starts a CLI session:

1. Claude: send `set_model` and `apply_flag_settings` on stdin before any user turn. Confirm the
   reply and that no default is saved. No model call.
2. Claude: send the text `/effort high`. Confirm whether it saves the default. No model call.
3. Codex: one tiny turn with `model` and `effort` in `turn/start`. Confirm the next turn keeps
   them. Uses a few tokens.
4. Grok and OpenCode: `session/set_model` before any prompt. No model call.

## Decisions (owner, 2026-11-06: "go with recs")

1. Build A and B together. Skip C for now.
2. Phase 1 is Claude Code and Codex. Grok and OpenCode show the commands greyed with a reason.
3. The owner may change an overseer's model and effort freely (an explicit model wins over the tier).
4. Chat gets one Chat-wide model and effort setting that persists. Its "/" menu is `/model`, `/effort`, `/stop`.
5. An unknown `/word` is sent as text for Claude (and Grok and OpenCode). For Codex a hint says it only reaches the model.
6. Effort applies to this thread only. It is not saved as the default for new threads.

## Open questions for the owner (answered above)

1. Overseer model: may the owner change the overseer's model and effort freely from the
   picker, or must the coordinator tier policy stay fixed? Recommendation: allow it. The
   explicit model already wins over the tier in the code.
2. Chat model and effort: one Chat-wide setting that stays, or a choice per message?
   Recommendation: one Chat-wide setting.
3. An unknown `/word` in Pretty: send it as text (today's behavior), or stop it and show "not
   a Dispatch command"? Recommendation: send it as text for Claude, Grok and OpenCode; show a
   hint for Codex, where it only reaches the model.
4. Effort scope: only this thread (recommended), or also save it as the default for new
   threads of that harness?
5. Scope of phase 1: Claude Code and Codex only (recommended), or all four harnesses at once?

## Spike results (2026-11-06)

Versions: Claude Code 2.1.316, codex-cli 0.166.0, grok 1.0.70, opencode 2.2.5. Launch flags were
copied from Dispatch. The Claude, Codex and Grok config files were byte-identical afterwards.

**Claude control requests, before or between turns: PASS.** No model call, nothing saved to
`settings.json`.
- `{"type":"control_request","request_id":"r2","request":{"subtype":"set_model","model":"haiku"}}`
  answers `{"subtype":"success","request_id":"r2","response":{"model":"claude-haiku-5-5"}}`.
- `{"subtype":"apply_flag_settings","settings":{"effortLevel":"low"}}` answers `success`. A new
  `flagSettings` source appears; `userSettings` is unchanged.
- A bad model answers `{"subtype":"error","error":"Model 'x' not found"}`. `effortLevel: "bogus"`
  answers `success` and is silently ignored, so Dispatch validates effort itself. `max` is accepted.
- `set_model` with `model: null` resets to the settings default. A flag-layer effort survives
  later `set_model` calls. A model change without a flag-layer effort moves the effort to that
  model's default.

**Claude typed commands: PASS, session only.** `/effort high` and `/model sonnet` run as commands
(`total_cost_usd: 0`, `num_turns: 0`) and say "this session only". Conflict: after a control
`set_model haiku`, a typed `/model sonnet` says "Set model to Sonnet" but `get_settings` and the
next `system/init` still say haiku. The control override masks the typed command.
Build-time check: a message with a leading space (` /effort high`) goes to the model as text, so
a leading space is the escape for a literal `/path`. An unknown `/word` also goes to the model as
text (it answered "ok"), so passing unknown commands through as text is safe for Claude.

**Codex `turn/start` model and effort: PASS.** `turn/start` with `model` and `effort` sticks for
later turns that send neither, and `thread/resume` on a fresh app-server keeps them.
`thread/read` returns `model` and `reasoningEffort`. A turn costs about 5 output tokens plus the
system prompt (about 18k input, partly cached).

**Grok over ACP: PASS.** `session/set_model {modelId}` works (unknown id: `-32602`).
`session/set_config_option {configId:"reasoning_effort", value}` works (xhigh, high, medium, low).
A new session starts at the default again; `config.toml` is unchanged. It lists 63 commands in
`available_commands_update`, none for model or effort.

**OpenCode over ACP: PASS, with differences.** `session/set_model` does not exist (`-32601`). Use
`session/set_config_option {configId:"model", value}`. An `effort` option appears only for a model
that supports it. It lists 4 commands (init, review, goal, compact).

Grok and OpenCode are phase 2: the calls work, but this build does not wire them.
