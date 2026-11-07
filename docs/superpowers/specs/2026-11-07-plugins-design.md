# Plugins: anyone changes Dispatch without a Dispatch release

Date: 2026-11-07. Status: approved in chat (the owner answered the brainstorm's questions; a
builder check raised six questions, settled in sections 3.3, 3.4, 5, 6, 8 and 10; the calls
marked "builder's call" are open to the builder). Brainstorm and spike:
`2026-11-07-plugins-brainstorm.md`; spike code on branch `spike/plugins`.

## Intent

A person, or the person's own agent, changes Dispatch without waiting for a release: a new
screen, a settings section, an item in a menu, buttons under the composer, a tool every
harness gets, an instruction every model reads, a hook that sees every prompt and every tool
call, a change to what an existing screen does. The change is a folder. The folder is a plugin.
It loads into the running app, and it reloads as its files are saved.

A plugin does not have to be published. A local plugin is complete. Publishing to a
marketplace is a separate step for a plugin someone else should install. A marketplace is a
JSON index at a URL: the public one on dispatchd.app, or an organisation's private one.

Skills (prompt packages the harnesses read) travel the same way, as a second kind.

## Goals

- An agent inside a thread can scaffold a plugin, write its files, and see it in the app
  within a second of saving, with no build of Dispatch and no restart.
- A plugin reaches every surface the owner asked for: the desktop rail, the phone's tabs,
  Settings, the thread and project menus, the composer, the thread header, the message row,
  the inspector, and (through overrides) any component.
- A plugin reaches the model: tools (an MCP server), instructions (system prompt text), hooks
  (every prompt, every tool call, every turn end), and an audit of the tools a thread had.
- A plugin can run a process: jobs on a clock, event handlers, its own endpoints.
- A broken plugin never takes the app down. A plugin's power is declared and visible.
- Install, update, roll back, pin and remove from the Plugins page, on desktop and phone.
- Previews becomes a plugin, as the proof the surface is complete.

## Non-goals

- A sandbox for plugin UI. A plugin's web part runs in the app with the app's power
  (decision 1). Safety comes from permissions on the daemon side, the boundary, safe mode,
  and the marketplace's review.
- A hosted marketplace service. The first marketplace is a GitHub repository (decision 3).
- Plugin code inside the daemon's process. Server-side plugin code is always a process the
  daemon runs, talking to the daemon over its API with a key.
- Themes and keyboard shortcuts as first slices. They are registries a later slice adds.

## Anti-goals

- A plugin that reads the daemon's database file, the access token, or another plugin's
  storage. Every server-side read goes through the API with the plugin's key.
- A plugin bundle fetched from another origin. Bundles are served by the daemon only.
- A plugin that keeps working after the owner disabled it (a worker left running, an MCP
  server still injected, a hook still firing).

## The decisions

1. **Trust**: a marketplace plugin runs with the same power as a local one. The manifest's
   `permissions` are enforced by the daemon on the plugin's key and shown before install.
   The public marketplace reviews before listing.
2. **Previews** moves into a plugin in the first real version (slice 4).
3. **Marketplace hosting**: a git repository is a marketplace (section 7.1); publishing is a
   pull request; an organisation uses a private repository and the git login its members
   already have.
4. **Skills**: a Dispatch skill library in `~/.dispatch/skills`, installed from the same
   marketplaces, injected per thread into each harness.
5. **The fifth tab**: a fixed "Plugins" tab that lists plugin screens, plus a tab of its own
   for up to two plugins the owner promotes in Settings.
6. **Plugins page**: local plugins first (open folder, reload, disable, remove), then the
   installed marketplace plugins, then browse.

## Constraints

- The daemon's CSP stays `script-src 'self'`; bundles are same-origin.
- Thread keys and route policy (`2026-10-23-per-thread-key-design.md`) stay the authority.
  A plugin's process gets a key of a new principal kind, `plugin`, scoped by its permissions.
- `~/.dispatch` is the data dir; plugins and skills live under it.
- The web client is React 18 and zustand 5 with inline styles and design tokens; a plugin's
  web part uses those through the SDK and ships no framework of its own.
- Every harness (Claude Code, Codex, OpenCode, Grok) keeps working with no plugins installed.
- Hosted boxes (no checkout, no shell) can still install from a marketplace.

## 1. The plugin folder and manifest

```
~/.dispatch/plugins/<id>/
  plugin.json
  web.js              optional: the browser bundle
  instructions.md     optional: text for the model
  mcp/                optional: an MCP server (any language)
  worker/             optional: a process the daemon runs
  hooks/              optional: scripts for the model hooks
  skills/             optional: skills the plugin bundles
  README.md           shown on the Plugins page and in the marketplace
  CHANGELOG.md        shown as the release note on update
```

`plugin.json`:

```json
{
  "id": "daily-rundown",
  "name": "Daily rundown",
  "version": "1.2.0",
  "description": "What happened yesterday, every morning.",
  "author": "dispatchd",
  "dispatch": ">=3.28",
  "sdk": 1,
  "web": "web.js",
  "model": {
    "instructions": "instructions.md",
    "mcp": { "command": "node", "args": ["mcp/server.js"] },
    "hooks": {
      "prompt":   { "run": "hooks/on-prompt.js" },
      "turnEnd":  { "run": "hooks/on-turn-end.js" },
      "toolCall": { "run": "hooks/on-tool.js", "tools": ["Bash", "secrets_*"] },
      "spawn":    { "run": "hooks/on-spawn.js" }
    },
    "harnesses": ["claude-code", "codex", "opencode", "grok"]
  },
  "worker": { "command": "node", "args": ["worker/index.js"], "jobs": [{ "id": "morning", "cron": "0 7 * * 1-5" }] },
  "contributes": {
    "views": [{ "id": "rundown", "label": "Rundown", "icon": "sun" }],
    "settings": [{ "id": "rundown", "label": "Daily rundown" }],
    "menus": { "thread": ["pin"], "project": [] },
    "slots": ["composer.actions"],
    "overrides": [],
    "tools": ["rundown_note"]
  },
  "permissions": ["read:projects", "read:threads", "read:ledger", "notify", "storage"],
  "skills": ["skills/*"]
}
```

Rules:

- `id` is `[a-z0-9][a-z0-9-]{0,63}` and equals the folder name. The daemon refuses a mismatch
  and shows the reason on the Plugins page (the folder still lists, as broken).
- `dispatch` is a semver range the running daemon must satisfy. `sdk` is the SDK major the
  web part was built against; the daemon serves the current SDK major and one before it.
- `contributes` is informational for the app and the marketplace (what a plugin touches,
  shown before install); the web part's `register` is the truth at runtime. A contribution
  the web part registers but the manifest did not list is allowed and logged once.
- `permissions` is the full list of what the plugin's key may do (section 6). Anything not
  listed is refused by the daemon, whichever part asks.
- A plugin folder that is a symlink is followed (an agent develops in a project folder and
  links it in); files are still confined to the resolved folder.
- A marketplace plugin's folder carries a `.dispatch-install.json` the daemon writes
  (marketplace, version, hash, installedAt). A folder without it is local.

## 2. The web part

### 2.1 Loading

- `GET /api/plugins` returns every plugin's manifest, its state (`local` or the install
  record, enabled, broken with the reason) and a `stamp` (the newest mtime in the folder).
- `GET /plugins/<id>/<path>` serves a file from an enabled plugin's folder, confined to it,
  `Cache-Control: no-cache`. HTML under a plugin folder is served with the same sandbox CSP
  as an HTML preview (a plugin page in a frame is possible, never with the app's origin).
- The client imports `web.js` with `import(/* @vite-ignore */ url + '?v=' + stamp)` after
  the first state load, and renders nothing plugin-related until the manifests are known.
  A `?safe` query, or the Settings → Plugins "Safe mode" switch (kept in localStorage),
  loads no plugin.
- The daemon watches `~/.dispatch/plugins` and sends `plugin:changed { id, plugin }`
  (debounced 150 ms). The client unregisters that plugin, re-imports with the new stamp, and
  re-registers. A removed folder sends `plugin: null`, which unregisters.

### 2.2 The SDK

`window.dispatch` is the SDK object, installed before any plugin loads. It is also published
as the npm package `@dispatchd/sdk` (types only, plus a build template whose esbuild config
maps `react`, `react-dom` and `zustand` to the global). A plugin may use plain `h()` calls
with no build step, or JSX through the template.

The object:

- `version` (SDK major.minor), `React`, `h`, `Fragment`, `hooks` (the React hooks the app
  uses plus `useIsMobile`), `zustand.create`.
- `stores`: the app's stores, read-only by convention, with explicit actions exposed where a
  plugin should write (`setView`, `openThread`, `openSettings`, `openPreview`).
- `useContributions(kind)` and `useStore(store, selector)`: memoised selectors, because a
  selector that returns a new array every call loops React under zustand 5 (spike finding).
- `api`: the app's API client (same-origin, the owner's credentials).
- `plugin.storage.get/set/list/remove` and `plugin.settings`: per plugin, backed by section 5.
- `plugin.events.on(type, handler)`: the daemon's event stream, filtered by type.
- `ui`: `Modal`, `Markdown`, `FileViewer`, `Toggle`, `Row`, `Button`, `Chip`, the style
  tokens, the icon map (named phosphor icons; a plugin may also pass its own component).
- `hint(text)`, `notify({ title, body, url })` (needs `notify`), `copyText(text)`.
- `register(id, contributions)`, `unregister(id)`, `override(name, wrap)`.

### 2.3 Contributions and slots

Registries (lists the existing screens read beside their own):

- `views`: `{ id, label, icon, Component, mobileTab? }`. Desktop: a rail item after the
  built-in ones. Phone: listed in the Plugins tab; the first two the owner promoted in
  Settings get a tab of their own.
- `settings`: `{ id, label, blurb, icon, Component }` under a PLUGINS group.
- `menus.thread`, `menus.project`, `menus.coordinator`: `{ id, label, when?, onPick }` with
  the thread/project in the context.
- `composerActions`: `{ id, label, icon?, when?, onClick }` with
  `{ surface, terminalId, sessionId, value, insert, set, send }`. `send(text)` sends through the
  composer's own path so it behaves like a typed message.
- `commands`: `{ id, label, run }` for the command palette (slice 6).
- `toolRenderers`: `{ toolName, Component }` for a custom tool-call card in Pretty mode.

Slots (named places; a plugin registers `{ slot, id, Component }`):

| Slot | Where | Props |
| --- | --- | --- |
| `composer.actions` | the row under the composer (registry above renders here) | composer context |
| `composer.before` | above the composer (a template form) | composer context |
| `thread.header.actions` | the thread header, before the ⋯ | `{ terminal }` |
| `thread.row.meta` | a thread row's right side | `{ terminal }` |
| `project.header.actions` | the project header | `{ session }` |
| `message.actions` | a chat message's hover/long-press actions | `{ terminalId, item }` |
| `inspector.tabs` | beside Details and Files | `{ terminal, session }` |
| `details.rows` | the end of Thread details | `{ terminal }` |
| `analytics.panels` | the end of the Analytics page | `{}` |
| `settings.about` | the end of About & updates | `{}` |
| `app.overlay` | a global layer (tours, focus mode) | `{}` |

Every slot and every view renders inside a `PluginBoundary` with the plugin's name. A throw
shows a red card in place; the rest of the screen stays.

### 2.4 Overrides

`override('ChatView', (Original) => (props) => ...)` replaces a named component. The app
exports a map of overridable components (`ChatView`, `Markdown`, `ThreadRow`, `Composer`,
`BoardView`, `AuthBanner`, `MobileApp`, `IconRail`, `FileViewer`, `UpdateModal`, and the
builder adds to it as plugins ask). An override wraps the original; two plugins overriding the
same name compose in load order. Documented as the escape hatch: no promise across SDK majors.

### 2.5 The Plugins page and the fifth tab

Settings → Plugins (desktop and phone), three lists:

1. **Local**: folder name, version, state, "Open folder", "Reload", enable/disable, "Remove
   (deletes the folder)". A broken one shows its error. "New plugin…" scaffolds from the
   template into `~/.dispatch/plugins/<id>` and opens the folder.
2. **Installed**: name, version, the marketplace, "update available" with the changelog,
   Update, Roll back, Pin, enable/disable, Remove. Auto-update switch per plugin.
3. **Browse**: per marketplace, search, a plugin's README, its permissions and contributions,
   Install. "Add marketplace…" takes a URL and an optional token.

The phone's fifth tab, "Plugins", lists every plugin view as a row and opens it at level 1.
Settings → Plugins → "Promote to a tab" on up to two views gives them tabs of their own
between Analytics and Settings.

## 3. The model part

### 3.1 Instructions

`model.instructions` names a Markdown file. The daemon appends its text to the thread's
system prompt after Dispatch's own prompts, under a heading with the plugin's name, for the
harnesses in `model.harnesses` (default all). Per project, the plugin's settings may turn it
off (`plugin.settings` holds `projects: { [sessionId]: { instructions: false } }`; the daemon
reads the same storage).

### 3.2 Tools

`model.mcp` is an MCP server spec. The daemon adds it to every eligible thread's injected
servers, named `plugin-<id>`, with `DISPATCH_API`, `DISPATCH_SESSION`, `DISPATCH_TERMINAL`,
and `DISPATCH_AUTH` (the thread's key) in its environment, plus `DISPATCH_PLUGIN` (the id)
and `DISPATCH_PLUGIN_AUTH` (the plugin's own key, section 6). The server may act as the
thread (thread key) or as the plugin (plugin key). The peer prompt lists the plugin's tools
under the plugin's name, from the manifest's `contributes.tools`.

### 3.3 Hooks

The daemon raises these events for every thread, whichever harness:

| Event | When | Payload |
| --- | --- | --- |
| `thread:spawned` | a thread starts | id, session, type, model, `tools_available` (every MCP server and tool name injected) |
| `thread:prompt` | the user sends a message | id, text (or `textLength` only, if the plugin lacks `read:prompts`), source (user, coordinator, other thread) |
| `thread:tool` | the model calls a tool | id, tool, input summary, output summary, ok, ms |
| `thread:turn` | a turn ends | id, ms, input tokens, output tokens, cost, stop reason |
| `thread:status` | report_status or a derived status change | id, state, summary |

Sources: the structured stream for Pretty threads; the PTY monitor, the hooks Dispatch
already installs for Claude Code (UserPromptSubmit, Stop, PreToolUse, PostToolUse), and
`report_status` for CLI threads. Where a harness gives less (Grok and OpenCode CLI mode),
the payload says `partial: true`.

`model.hooks` runs a script per event with the payload on stdin and the thread's identity in
the environment. For `prompt` and `toolCall` on Claude Code, the script runs as a native hook
and may answer `{ "decision": "block", "reason": "..." }` (PreToolUse) or
`{ "context": "..." }` (UserPromptSubmit adds text). Elsewhere the script observes only, and
the Plugins page says which harnesses give a plugin's hook the power to block.

A native hook hands the script the full prompt or tool input, which the daemon cannot trim.
So a plugin without `read:prompts` gets no native `prompt` or `toolCall` hook: it receives
the derived events only, and the Plugins page says so under its permissions.

`tools_available` is also stored on the thread row and shown in Thread details.

### 3.4 Model assist

A plugin that judges, summarises or drafts needs a model call of its own (the prompt coach,
section 13). `POST /api/plugins/<id>/assist` with `{ system, messages, maxTokens }` runs one
turn on the daemon's assist model (the one that names threads and writes summaries today),
with no tools, and returns the text and the usage. It needs `model:assist`; the daemon
meters calls and tokens per plugin and shows them on the Plugins page and in Analytics.
Nothing a plugin sends through assist reaches a thread.

## 4. The worker

`worker.command` is started by the daemon when the plugin is enabled, with the plugin's key,
`DISPATCH_API`, and `DISPATCH_PLUGIN`. It is restarted on exit with backoff; its stdout and
stderr go to `~/Library/Logs/dispatch/plugins/<id>.log` and the Plugins page shows the tail.
`worker.jobs` run on their cron by the daemon sending `plugin:job { id }` to the worker's
event stream (the worker subscribes to `/api/events` like the web client). A worker may
listen on a Unix socket the daemon gives it (`DISPATCH_PLUGIN_SOCKET`); the daemon proxies
`/plugins/<id>/api/*` to it with the caller's principal in a header, so the web part and other
plugins can call the worker. Disabling the plugin stops the worker and removes the proxy.

## 5. Storage and settings

- `GET/PUT/DELETE /api/plugins/<id>/data/<key>` and `GET /api/plugins/<id>/data`: JSON
  documents per plugin, 256 KB each, 50 MB per plugin (builder's call on the figures), in a
  `plugin_data` table. The owner's credentials and the plugin's own key may read and write;
  a thread key may read if the plugin granted `threads:read-storage`.
- `GET/PUT /api/plugins/<id>/settings`: one JSON document the Plugins page and the plugin's
  settings section edit. The daemon reads it for the model part (instructions per project).
- A thread key may write a plugin's data when the plugin granted `threads:write-storage`
  (and read with `threads:read-storage`). The daemon stamps every document a thread key
  writes with `writer: { terminalId, sessionId }` from the key, never from the body, so the
  per-thread key rule holds. Previews uses this: the `preview` tool writes as the thread.
- File references: `POST /api/plugins/<id>/files` with `{ path }` from a thread key checks
  the path against that thread's project folder (the previews rules: inside the real root,
  a known type, a regular file, size cap) and returns `{ fileId, name, mime, size }`. The
  daemon serves it at `GET /api/plugins/<id>/files/<fileId>` with the same re-check and the
  same sandbox headers as a preview file today, for as long as the plugin keeps the record.
  This is the "generic checked file route" section 10 relies on.
- Both are copied before an update and kept until the plugin reports its migration done or
  the owner rolls back (section 7).

## 6. Permissions and keys

A plugin's processes (MCP server, worker, hooks) get a key of principal kind `plugin`, issued
when the plugin is enabled and revoked when disabled, stored at `~/.dispatch/keys/plugin-<id>`
(0600). Route policy adds `plugin` to `keyRoute`, with `permissions` read from the manifest:

| Permission | Grants |
| --- | --- |
| `read:projects`, `read:threads` | the lists and transcripts (what a thread key can read) |
| `read:prompts` | prompt text in `thread:prompt`; without it only the length |
| `read:ledger`, `write:ledger` | the ledger routes |
| `message:threads` | `message_thread` as the plugin (sender line names the plugin) |
| `spawn:threads` | spawn and start threads |
| `notify` | push notifications and in-app hints |
| `storage` | its own data and settings (implied; listed for honesty) |
| `secrets:<NAME>` | one named secret, delivered as `NAME` in the environment of the plugin's processes at start (never over a route) |
| `model:assist` | one model call per request through `POST /api/plugins/<id>/assist` (section 3.4), metered per plugin |
| `network` | informational: the worker makes outbound calls (shown before install) |

A plugin principal in the key rules: a thread a plugin spawns gets `createdBy: { kind:
'plugin', id }` (a new kind the decoder accepts), spawn depth 1, and the plugin's project
is the one named in the call; a plugin may message any agent thread with the sender line
`[From plugin "NAME" (id). This is not a message from the owner.]`, under the same per-pair
rate limit a thread has, and never itself. Spawn needs the owner's one-time approval per
plugin, the way a thread's first spawn does today.

Where a secret lives: a Doppler reference when Doppler is set up, else a local file
`~/.dispatch/plugin-secrets.json` (0600) that Settings → Plugins edits. Marketplace tokens
(section 7.1) live in the same place. A hosted box without Doppler still works.

The web part runs with the owner's credentials (decision 1); its `permissions` are shown,
not enforced, except that `api` calls from a plugin carry an `X-Dispatch-Plugin: <id>`
header the daemon logs, so the audit log can name the plugin.

## 7. Marketplaces, install, update

### 7.1 A marketplace is a git repository (owner decision, 2026-11-07)

A marketplace is a git repository. Its URL is the marketplace; the ability to clone it is the
access control. There is no index service and no token kept by Dispatch: the daemon clones
with the same git credentials the owner already has on this machine (ssh keys, the git
credential helper, `gh auth`), so a private repository is a private marketplace for exactly the
people who can read it.

The repository's layout is the catalog:

```
<repo>/
  marketplace.json          { "name": "dispatchd", "description": "..." }   (optional)
  plugins/<id>/             one plugin per folder, with its plugin.json, web.js, README.md, CHANGELOG.md
  skills/<id>/              one skill per folder, with its skill.json and SKILL.md
```

- The daemon keeps one clone per marketplace under `~/.dispatch/marketplaces/<slug>/` and
  pulls it on the updater's schedule (about 45 minutes) and on "Check now".
- A plugin's version is its `plugin.json` version at the clone's HEAD; its release note is its
  `CHANGELOG.md`. Older versions are in git history: roll back and pin check out the commit
  that last carried the wanted version (`git log -- plugins/<id>/plugin.json`).
- Install copies `plugins/<id>` from the clone into `~/.dispatch/plugins/<id>` and writes
  `.dispatch-install.json` with the marketplace URL, the commit and the version. Git gives the
  integrity; no hashes.
- The public marketplace is the repository `dispatch-plugins` on GitHub (the owner creates it,
  or the builder does, at slice 7); publishing is a pull request, or `dispatch plugin publish`,
  which commits the plugin folder on a branch and opens one.
- Settings → Plugins → Marketplaces takes a repository URL (https or ssh). If the clone needs
  a login the owner does not have, the page shows git's own message and a hint to sign in
  with `gh auth login` or add an ssh key.

### 7.2 Install, update, roll back, pin

- Install: pull the marketplace clone, check `dispatch` and `sdk`, copy `plugins/<id>` into
  `~/.dispatch/plugins/<id>`, write `.dispatch-install.json`, enable.
- Check: the daemon polls each marketplace on the updater's schedule (about 45 minutes) and
  stores "updates available"; the Settings dot and banner from v3.27.0 list plugin updates
  under the Dispatch one.
- Update: pull, copy into a staging folder, swap the folder (the old one kept as `<id>.prev`),
  copy storage and settings, raise `plugin:changed`, restart the worker, re-inject the MCP
  server for new threads. The plugin's web part and worker receive `{ from, to }` once; `plugin.migrated()`
  tells the daemon to drop the copies. Auto-update per plugin, default off; a marketplace the
  owner marked trusted defaults on.
- Roll back: swap `.prev` back and restore the copies. Pin: no update past a version.
- Remove: stop the worker, revoke the key, delete the folder and the storage (after confirm).
- A local plugin never checks an index. Publishing one (`dispatch plugin publish`, slice 7)
  builds the tarball and opens the pull request; the local copy stays local.

## 8. Skills

- `~/.dispatch/skills/<id>/` with a `skill.json` (`id`, `name`, `version`, `description`,
  `harnesses`) and the skill files (`SKILL.md` and anything it references).
- Installed from the same marketplaces (`kind: "skill"`), or local, or bundled by a plugin.
- Injection per thread: the enabled skills' `SKILL.md` texts are joined into the thread's
  system prompt (the same path as plugin instructions, section 3.1), each under its name with
  the absolute path of its folder so the model can read its other files. Dispatch never
  writes into the user's project (no `AGENTS.md` or `CLAUDE.md` edits). Where a harness
  takes a skill folder directly (Grok's plugin dir; Claude Code if its CLI accepts one, the
  builder verifies the flag), the folder is passed as well. Enabled per project in
  Settings → Skills (a section beside Plugins; the desktop rail gets no Skills item,
  builder's call).
- The Plugins page's Browse lists skills under their own heading.

## 9. Agent tools

The `dispatch` MCP server gains: `plugin_scaffold({ id, name, parts })`, `plugin_list()`,
`plugin_enable({ id })`, `plugin_disable({ id })`, `plugin_remove({ id })`,
`plugin_reload({ id })`, `plugin_logs({ id, tail })`, `skill_list()`. Scaffold and remove are
owner-approved: the thread's call creates a needs-you decision the owner confirms in the app,
like a spawn. The peer prompt gets one paragraph: "You can build a plugin for this Dispatch:
plugin_scaffold, then edit the files under ~/.dispatch/plugins/<id>; the app reloads it as
you save. The SDK reference is at /plugins/sdk/README.md."

## 10. Previews as a plugin

The `previews` plugin ships with Dispatch under `packages/plugins/previews` and is served
from there in place: a third state, **bundled**, beside local and installed. A bundled plugin
updates with Dispatch, never checks an index, can be disabled but not removed, and is not
edited in place; "Copy to local…" on the Plugins page duplicates it under a new id for the
owner to change. Its storage migration (the `previews` table into plugin data) runs at
daemon start, whatever the plugin's enabled state. It carries: the `preview` and
`post_image` tools (its MCP server, using the thread key), the Previews view, the phone sheet
(a `project.header.actions` slot and a `menus.project` item), the unseen badge
(`thread.header.actions`), the list and item components, and `FileViewer` use from the SDK.
The `previews` table migrates into the plugin's storage; the file-serving route stays in the
daemon as a generic "serve a file inside a project folder, checked" route the plugin's tool
registers a reference to. The thread menu's "Previews" item comes from the plugin.

## 14. Plugin conflicts

Two plugins will touch the same thing. The rules, so the result is intentional:

- **Namespaces**: every contribution is keyed by its plugin id (`plugin:<id>:<view>`,
  storage per plugin, settings sections per plugin, MCP server `plugin-<id>` so tool names
  cannot collide across plugins: a harness sees `mcp__plugin-<id>__<tool>`). Two plugins
  cannot overwrite each other's keys.
- **Load order**: plugins load in the order of the owner's list on the Plugins page
  (default: bundled, then installed, then local, alphabetical within each). The page lets the
  owner drag to reorder. Order is the tie-break everywhere below, and it is stored in
  `~/.dispatch/plugins.json` with the enabled state.
- **Slots**: every plugin's content renders, in load order; a contribution may set
  `priority` (higher first) to override that. The same for menu items and composer actions.
- **Overrides**: compose in load order (the later plugin wraps the earlier plugin's result).
  The Plugins page shows, per override target, every plugin that touches it, in order.
- **Instructions and skills**: concatenated in load order, each under its own heading. The
  Plugins page shows the assembled instructions for a project so the owner can read what
  the model reads.
- **Hooks**: every plugin's hook runs; a `block` from any one blocks, and the thread's
  notice names the plugin. Added context from several `prompt` hooks is concatenated.
- **Same id in two places**: a local folder and an installed plugin with the same id
  cannot both exist; install refuses when a local folder has the id, and the page says so.
  A bundled plugin copied to local gets a new id.
- **Conflict report**: Settings → Plugins has a "Touches" view: for each slot, override,
  instruction target and hook, the plugins that use it, in order. A plugin's install screen
  lists the same for that plugin, with "also used by …" lines.
- **Same name, different plugin**: two plugins may both contribute a view called
  "Rundown"; the rail and the Plugins tab show the plugin's name under a duplicate label.

## 13. Key plugins Dispatch ships

Beyond Previews, Dispatch ships a few plugins that show what the surface can do and that
the owner wants on day one. Each is bundled (section 10's state), disabled or enabled from
the Plugins page, and written against the public SDK so a user can copy it to local and
change it.

- **Composer favourites**: your own buttons under every composer, edited in Settings.
- **Daily rundown**: yesterday per project, every morning, with a push; pin from a thread.
- **Prompt coach**: the one the owner cares most about. Its goal is to level a person up in
  how they engage with AI: not as a parrot (the person types what the model should type),
  not as a file editor (the person asks for one small change at a time), but with leverage
  (outcomes, context, delegation, verification, plans before edits, parallel work). It
  watches `thread:prompt` and `thread:turn` (with `read:prompts`) and, through `model:assist`,
  judges each prompt and each exchange against a rubric: did the prompt state the outcome or
  dictate the steps; did it give the context the model needed (what, why, constraints, done
  looks like); was the scope one file or the whole task; did it ask for a plan or a spike
  when the task was open; did it ask for verification; could it have been delegated or run
  in parallel; and over time, is the person repeating the same correction. It shows a short
  card under the composer after a send (`composer.before` slot) with one observation and one
  better version of the prompt, never more; a Coach view with the person's patterns over the
  week and the habits that changed; and a settings section for the coaching style (quiet,
  normal, direct), per-project opt-out, and what it may read. It never changes a prompt on its
  own; it never posts to a thread. The rubric is a Markdown file in the plugin folder so the
  owner can edit it.

The coach is also the proof for `model:assist`, `read:prompts`, `composer.before` and the
weekly job, so it ships in slice 3 with the model part.

- **Usage planner** (the owner's idea, 2026-11-07): the quota is a budget that resets, and an
  unspent budget is wasted. The plugin watches the usage store (the per-account windows the
  Usage card shows) and, when a window has a good share left and the reset is near, it
  proposes work: "40% of this week's Claude budget is left and it resets tomorrow. Scan the
  repos for dependency vulnerabilities, work the three open Jira tickets tagged small, or
  write tests for last week's untested changes?" Each proposal is a card (a view and a phone
  notification through the push hook) with Start / Not now / Never this; Start spawns threads
  through the Control Plane with a brief the plugin wrote, scoped to the budget. It learns
  the owner's answers (what they never want, what they accept) and the projects' shape (what
  has a test suite, a lockfile, an issue tracker). Sources are other plugins' data where they
  exist (a Jira plugin, a CI plugin) and the projects' files otherwise. It needs: a worker
  (slice 5: a scheduled job that reads usage and the projects while no browser is open),
  `model:assist` to rank and phrase the proposals, `read:projects`, the Control Plane's
  `spawn_agent` through its key, and a settings section for the floor (never propose below
  this share), the hours, and the project list. It never spends without a Start. It ships
  after the worker slice; its proposals are the proof that a plugin can plan work, not only
  react to it.

## 11. Delivery slices

1. **Host and SDK** (from the spike): registry, loader, boundary, safe mode, hot reload,
   `plugin:changed`, views, settings, thread/project menus, `composer.actions`, the phone's
   Plugins tab, the local list on the Plugins page, scaffold template, tests.
2. **Storage, settings, permissions, keys**: `plugin_data`, the `plugin` principal, the
   permissions table, audit header.
3. **The model part**: instructions, MCP injection, the five thread events across harnesses,
   native hooks for Claude Code, `tools_available`, `model:assist`, the Prompt coach.
4. **Previews as a plugin**, plus the remaining slots and overrides the migration needs.
5. **Workers**: supervision, logs, jobs, the socket proxy.
6. **Marketplaces**: index, install, update, roll back, pin, browse, skills install, the
   Settings dot and banner for plugin updates, commands registry and palette.
7. **Publishing and the public index**: `dispatch plugin publish`, the dispatch-plugins
   repository (owner creates it; the owner said the builder may), the review checklist,
   `@dispatchd/sdk` on npm (owner step: needs the npm account), docs.

Each slice ships on its own release and leaves Dispatch working with no plugins installed.

## 12. Left to the builder

- Exact table schemas, size limits, debounce times, backoff curves.
- The look of the Plugins page within the existing Settings style.
- The scaffold template's contents and the SDK README.
- Which overridable components to export first beyond the list in 2.4.
- How the phone's Plugins tab lists views (rows with icons; builder's call on grouping).
- Test strategy per slice (the existing suites plus plugin fixtures under a fake HOME).
