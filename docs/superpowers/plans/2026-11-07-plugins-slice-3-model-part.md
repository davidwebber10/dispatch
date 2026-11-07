# Plugins slice 3: the model part and the prompt coach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin reaches the model: its instructions join every thread's system prompt, its MCP server is injected into every harness, it observes every thread's prompts, tool calls, turn ends and status changes (as daemon events and as hook scripts), it can ask the daemon's assist model for a judgement, and the bundled Prompt coach plugin uses all of that.

**Architecture:** `PluginRegistry.modelInjection()` returns the enabled plugins' `McpServerSpec`s and prompt blocks; `SessionService` gets a `pluginInjection` hook pushed at both spawn sites (CLI and Pretty). A new `ThreadEvents` module subscribes to the harness event layer (`runtime/adapter.ts`) and the status ingest (`status/service.ts`) and broadcasts `thread:spawned|prompt|tool|turn|status` (prompt and tool text included for the owner's browser; redacted to lengths for plugins without `read:prompts`). `PluginHooks` runs a plugin's `model.hooks` scripts per event with the payload on stdin. `assist/run.ts` generalises the title generator into one-prompt-in-text-out with usage, served at `POST /api/plugins/:id/assist` under `model:assist` and metered. Bundled plugins live in `packages/plugins/<id>` and are served in place (state `bundled`). The SDK gains `events.on` and `assist`. The coach is a bundled plugin written against the SDK.

**Tech Stack:** as before; hook scripts run with `node` (or the manifest's command) via `child_process`.

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` sections 2.2.1, 3 (3.1–3.4), 10 (the bundled state), 13 (the coach), 14 (instructions order, hooks).

## Global Constraints

- Nothing a plugin adds changes a thread that has no enabled plugins: with none, the injected lists are exactly what they are today.
- A plugin's MCP server runs with `DISPATCH_PLUGIN=<id>` and `DISPATCH_PLUGIN_AUTH_FILE=<key file>`; the thread's key reaches it the way the `dispatch` server gets it (`authEnv`). Server name `plugin-<id>`.
- Instructions join in plugin load order (alphabetical this slice), each under `## Plugin: <name>`; after Dispatch's own prompts.
- `thread:prompt` carries `text` only to the owner's browser and to plugins with `read:prompts`; otherwise `textLength`. `thread:tool` carries `input` only with `read:prompts`; otherwise the tool name and sizes.
- Hook scripts: 10 s timeout, one at a time per plugin, a backlog cap of 100 events per plugin (older events dropped, counted); a failing script never affects the thread.
- Assist: no tools, the daemon's assist model (the title generator's command, `claude -p` with `--output-format json`, else the OpenRouter fallback), `maxTokens` capped at 2000, metered per plugin (calls, input tokens, output tokens, ms).
- Bundled plugins cannot be removed; "Copy to local" duplicates under a new id.

## Review Focus

1. A thread spawned with a plugin's MCP server whose key file is missing (plugin disabled a moment ago) must still start; the server simply fails to serve (Task 1 test "injection skips a plugin without a key").
2. `thread:prompt` for a thread the plugin may not read must never carry text in the hook payload (Task 3 test "a hook without read:prompts gets lengths only").
3. A hook script that hangs must not delay the next event past the timeout, and must not block the daemon's event loop (Task 3 test "a hanging script is killed at the timeout and the queue continues").
4. An assist call when no model is signed in must return 503 with a plain message, not hang (Task 4 test "assist with no runner answers 503").
5. A bundled plugin folder missing from the checkout (a user build without `packages/plugins`) must not break boot (Task 5 test "a missing bundled dir lists nothing").

---

### Task 1: Instructions and MCP injection

**Files:**
- Modify: `packages/core/src/plugins/manifest.ts` (`model?: { instructions?: string; mcp?: { command: string; args?: string[]; env?: Record<string,string> }; hooks?: Record<'prompt'|'turnEnd'|'toolCall'|'spawn'|'status', { run: string; tools?: string[] }>; harnesses?: string[] }` validated: files inside the folder), `packages/core/src/plugins/registry.ts` (`modelInjection(harness: string): { specs: McpServerSpec[]; prompts: string[]; toolNames: string[] }` from enabled, keyed plugins whose `harnesses` include the harness or are unset; instruction text read per call; the spec: `{ name: 'plugin-<id>', command, args, env: { ...env, DISPATCH_PLUGIN: id, DISPATCH_PLUGIN_AUTH_FILE: keyFile }, authEnv: true }`), `packages/core/src/sessions/service.ts` (`setPluginInjection(fn)`; both spawn sites push `fn(terminal.type)` specs after the integrations and prompts after the peer prompt; the spec names go into `config.toolsAvailable` with the agency and integration names), `packages/core/src/server.ts` (wire `sessionService.setPluginInjection((h) => plugins.modelInjection(h))` in both app builds)
- Test: `packages/core/tests/plugins/model-injection.test.ts` (registry unit), `packages/core/tests/sessions/plugin-injection.test.ts` (service: spawn with `skipPty`/fake manager and read the written `thread-<id>.mcp.json` and the system prompt)

- [ ] Tests: 'modelInjection lists an enabled plugin's mcp spec with the plugin env and its instructions as a prompt block under its name'; 'a plugin scoped to other harnesses is skipped'; 'injection skips a plugin without a key' (disabled); 'with no plugins the lists are empty'; service: 'a CLI spawn writes the plugin server into thread-<id>.mcp.json and the instructions into the system prompt, and config.toolsAvailable names dispatch, the integrations and the plugin server'.
- [ ] Implement; commit `feat(core): plugin instructions and MCP servers injected into every thread`.

### Task 2: Thread events

**Files:**
- Create: `packages/core/src/plugins/thread-events.ts`: `ThreadEvents` with `onHarnessEvent(terminalId, e: HarnessEvent)`, `onIngest(terminalId, normalized)` (from `status/service.ts` ingest: UserPromptSubmit → prompt, PreToolUse → tool, Stop → turn), `onSpawned(terminal, toolsAvailable)`, `onStatus(terminalId, state, summary)`; each builds a `ThreadEvent` `{ type: 'thread:prompt'|'thread:tool'|'thread:turn'|'thread:status'|'thread:spawned', terminalId, sessionId, at, ... }` and calls `broadcast(e)` and every `subscriber(e)`; `subscribe(fn)`; `redact(e)` returns the event without `text`/`input` (lengths only).
- Modify: `packages/core/src/server.ts` (construct; feed from `wirePermissionMembrane`'s `status.accept` path and from `statusService` ingest via a listener; feed `onSpawned` from the session service's spawn), `packages/core/src/status/service.ts` (an `onIngest` listener hook), `packages/core/src/sessions/service.ts` (`onSpawned` listener), `packages/core/src/routes/terminals.ts` (report-status → `onStatus`)
- Test: `packages/core/src/plugins/thread-events.test.ts` (pure: a UserPromptSubmit ingest becomes `thread:prompt` with text and length; PreToolUse → `thread:tool`; a `turn.completed` harness event with usage → `thread:turn` with tokens and ms; `redact` strips text and input but keeps lengths)

- [ ] Tests, implement, commit `feat(core): thread:prompt, thread:tool, thread:turn, thread:status and thread:spawned events`.

### Task 3: Hook scripts

**Files:**
- Create: `packages/core/src/plugins/hooks.ts`: `PluginHooks(registry, threadEvents, opts: { timeoutMs = 10000, backlog = 100, runner? })`: subscribes; for each enabled plugin with `model.hooks`, maps event type → hook (`prompt`, `toolCall` (with `tools` glob filter), `turnEnd`, `spawn`, `status`); queues per plugin; runs `node <script>` (or the manifest's `command`) in the plugin folder with env `DISPATCH_PLUGIN`, `DISPATCH_PLUGIN_AUTH_FILE`, `DISPATCH_API`, `DISPATCH_TERMINAL`, `DISPATCH_SESSION`; writes the (redacted unless `read:prompts`) event JSON to stdin; kills at the timeout; counts runs, failures and drops per plugin (`stats(id)`), surfaced on `GET /api/plugins` rows as `hooks: { runs, failures, dropped }`.
- Modify: `packages/core/src/server.ts` (construct in `startServer`), `packages/core/src/plugins/registry.ts` (rows carry `hooks` stats when given a provider)
- Test: `packages/core/tests/plugins/hooks.test.ts` with a real `node` script that appends its stdin to a file: 'a prompt event runs the prompt hook with the full text when the plugin has read:prompts'; 'a hook without read:prompts gets lengths only'; 'toolCall hooks filter by tool name glob'; 'a hanging script is killed at the timeout and the queue continues'; 'the backlog cap drops the oldest and counts it'.

- [ ] Tests, implement, commit `feat(core): plugin hook scripts run on thread events`.

### Task 4: Assist

**Files:**
- Create: `packages/core/src/assist/run.ts`: `AssistRunner` with `run({ system, messages: {role:'user'|'assistant', content}[], maxTokens })` → `{ text, usage: { inputTokens, outputTokens }, ms, model }`; built from the title generator's pieces (`cli-namer.ts` `runCommand`, the `claude -p` args with `--output-format json`, the OpenRouter fallback); `null` when no generator is available.
- Modify: `packages/core/src/db/schema.ts` (migration `'019-plugin-assist'`: `plugin_assist(plugin_id, at, input_tokens, output_tokens, ms)`), `packages/core/src/db/plugin-data.ts` (`recordAssist`, `assistTotals(pluginId)`), `packages/core/src/routes/plugins.ts` (`POST /plugins/:id/assist` with `keyRoute({ plugin: needs('model:assist') })` and `ownPluginRule`; the owner's browser may call it for a plugin too (the web part); 503 `{ error: 'no_model', message: 'No model is signed in for assist. Sign in to Claude Code or set an OpenRouter key.' }`; 400 on bad body; `maxTokens` capped at 2000), rows carry `assist: { calls, inputTokens, outputTokens }`
- Test: `packages/core/tests/routes/plugins-assist.test.ts` with a fake runner: 'a plugin with model:assist gets text and usage and the call is metered'; 'without the permission 403'; 'assist with no runner answers 503'; 'the owner can call assist for a plugin'.

- [ ] Tests, implement, commit `feat(core): model assist for plugins, metered`.

### Task 5: Bundled plugins

**Files:**
- Modify: `packages/core/src/plugins/registry.ts` (`bundledDir?: string` option; `list()` merges bundled rows with `bundled: true` (same id in local wins and the row says `shadowed`); `resolveFile` serves from the bundled folder; `remove` refuses bundled (`'bundled'` → 400); `copyToLocal(id, newId)`), `packages/core/src/server.ts` (`bundledDir: path.join(repoRoot, 'packages/plugins')`), `packages/core/src/routes/plugins.ts` (`POST /plugins/:id/copy { id }`), `packages/web/src/api/types.ts` (`bundled?: boolean`), `packages/web/src/components/settings/PluginsSection.tsx` (a BUNDLED list: no Remove; "Copy to local…"), `packages/web/src/api/client.ts` (`copyPlugin`)
- Create: `packages/plugins/README.md`
- Test: registry 'a bundled plugin lists with bundled: true, serves its files, cannot be removed, and copies to local under a new id'; 'a missing bundled dir lists nothing'; PluginsSection 'a bundled plugin shows under BUNDLED with Copy to local'.

- [ ] Tests, implement, commit `feat: bundled plugins served from the checkout`.

### Task 6: SDK events and assist

**Files:**
- Modify: `packages/web/src/plugins/sdk.tsx` (`events.on(type: string | string[], handler: (e: ServerEvent) => void): () => void`; `assist(plugin, { system, messages, maxTokens })` → the route's answer), `packages/web/src/plugins/host.ts` (`applyPluginEvent` fans every event to the SDK listeners; `thread:*` included), `packages/web/src/api/client.ts` (`pluginAssist`)
- Test: `sdk.test.ts` (add 'events.on receives thread events and unsubscribes'; 'assist posts and returns text').

- [ ] Tests, implement, commit `feat(web): plugin events and assist in the SDK`.

### Task 7: The Prompt coach plugin

**Files:**
- Create: `packages/plugins/prompt-coach/plugin.json` (permissions `read:prompts`, `read:threads`, `model:assist`, `notify`; `contributes` views `coach`, settings, slot `composer.before`), `rubric.md` (the rubric from the spec's section 13, editable), `web.js` (listens to `thread:prompt` and `thread:turn`; after a prompt, calls assist with the rubric and the prompt (and the previous exchange when `thread:turn` arrives) and stores an observation `{ terminalId, at, prompt (first 200 chars), score 1–5 per rubric line, note, better }` under storage key `obs:<terminalId>:<at>`; a `composer.before` card for the thread of the current composer showing the latest observation's one note and one better version, with Dismiss and "Use this" (sets the composer text); a Coach view: this week's observations grouped by habit with counts and the trend against last week; settings: style quiet/normal/direct, per-project opt-out, "what it may read"), `README.md`, `CHANGELOG.md`
- Test: none in code (a bundled plugin's bundle is plain JS); the e2e in Task 8 exercises it with a fake assist runner.

- [ ] Write, commit `feat(plugins): the Prompt coach`.

### Task 8: Suites, docs, end-to-end

- [ ] Full suites; docs/plugins.md gains "Instructions and tools", "Hooks", "Assist", "Bundled plugins"; the design's `tools_available` noted in Thread details (DetailsPane row "Tools" from `config.toolsAvailable`).
- [ ] E2E on an isolated daemon with a fake assist runner (env `DISPATCH_ASSIST_COMMAND` pointing at a script that echoes JSON): spawn a shell thread, post a UserPromptSubmit hook event, see `thread:prompt` and the hook script's output file, see the coach card in the composer, the Coach view, and the assist meter on the Plugins page.
