# Dispatch plugins: brainstorm and spike (2026-11-07)

Status: brainstorm, with a throwaway spike done (section 8.1). The spike lives on the
`spike/plugins` branch (worktree `../dispatch-spike-plugins`); its example plugins are under
`docs/spike-plugins/` on that branch. Nothing here is a commitment; the open questions at the
end need the owner's answers before a design.

## 1. The intent

The owner wants anyone (a person, or the person's own agent) to change Dispatch without a
Dispatch release: add a screen, add a settings section, add an item to a menu, give every
harness a new tool, change what an existing screen does. Changes are packaged as plugins,
published to a marketplace (a public one on dispatchd.app, or an organisation's private
one), and installed from inside Dispatch. Skills (prompt packages for the harnesses) get
the same treatment, as a separate kind.

Two examples from the owner: an SFTP client; a "daily rundown" that scans yesterday's
work. The Previews feature could itself become a plugin, which is a good test of whether the
plugin surface is complete.

## 2. The shape of a plugin

A plugin is a folder. It has a manifest and up to three parts, each optional:

```
~/.dispatch/plugins/<id>/
  plugin.json        the manifest: id, name, version, what it contributes, what it needs
  web.js             a browser bundle: screens, settings, menu items, slot content
  mcp/               an MCP server (any language): tools every harness gets
  worker/            a process the daemon runs: jobs, event handlers, HTTP endpoints
```

The daemon never loads plugin code into its own process. The web bundle runs in the app;
the MCP server and the worker are processes that talk to the daemon over the API it already
has, with a key the daemon issues to the plugin. That keeps the daemon safe from a bad
plugin, and it means a plugin can be written in anything.

The manifest declares contributions, so Dispatch can show a plugin's screens and menu
items before the bundle has loaded, and so the marketplace can list what a plugin touches:

```json
{
  "id": "daily-rundown",
  "name": "Daily rundown",
  "version": "0.1.0",
  "description": "What happened yesterday, every morning.",
  "web": "web.js",
  "contributes": {
    "views": [{ "id": "rundown", "label": "Rundown", "icon": "sun", "mobileTab": true }],
    "settings": [{ "id": "rundown", "label": "Daily rundown", "group": "PLUGINS" }],
    "menus": { "thread": [{ "id": "add-to-rundown", "label": "Add to today's rundown" }] },
    "tools": [{ "name": "rundown_note", "server": "mcp" }],
    "jobs": [{ "id": "morning", "cron": "0 7 * * *" }]
  },
  "permissions": ["read:threads", "read:ledger", "notify"]
}
```

### 2.1 The web part: in the app, not in a frame

The riskiest decision is how plugin UI runs. Three options:

| Option | Can change existing screens | Looks native | Safe from a bad plugin | Agent can author it |
| --- | --- | --- | --- | --- |
| A. Sandboxed iframe per plugin, postMessage API | No | Only with a shipped stylesheet | Yes | Yes |
| B. ES module loaded into the app, with an SDK | Yes | Yes (shares React and the tokens) | No; needs an error boundary and a safe mode | Yes |
| C. Declarative UI (JSON cards, forms, tables) | No | Yes | Yes | Easiest |

The owner's goal is "modify anything", which only B gives. The author of a plugin is usually
the owner's own agent working on the owner's machine, which is the same trust as editing the
repo. Marketplace plugins are the case that needs care, and the manifest's `permissions`
plus a review step on the marketplace cover that, the way editor extensions do.

Recommendation: B, with A available as one contribution type (`"frame": "index.html"`) for
a plugin that is really a whole web app (an SFTP client built with its own framework).

How B works, concretely:

- The daemon serves `GET /api/plugins` (the enabled manifests) and `GET /plugins/<id>/<file>`.
- At boot the web client fetches the manifests and `import()`s each `web.js`. The bundle
  does not bundle React or zustand: it reads them from `window.dispatch`, the SDK object,
  which also carries the stores, the API client, the UI primitives (buttons, rows, the
  Markdown renderer, the Modal) and `register(...)`.
- `register` adds contributions to registries that the existing screens read: the desktop
  rail's items, the phone's tabs, the settings sections, the thread and project menus, and
  named slots in existing screens (`thread.header.actions`, `composer.actions`,
  `inspector.tabs`, `preview.item.actions`, ...).
- Each plugin's content renders inside an error boundary with the plugin's name, so a broken
  plugin shows a red card, not a black screen. A `?safe` query or a Settings switch loads no
  plugins at all.
- "Modify anything" beyond slots: `override(componentName, wrap)` replaces a named component
  with a wrapper that receives the original. It is an escape hatch, documented as such, and
  it is the same trick Obsidian plugins use. Slots cover the common cases; overrides cover the
  rest without Dispatch having to predict them.
- Hot reload: the daemon watches `~/.dispatch/plugins` and sends `plugin:changed`; the web
  client re-imports that plugin's bundle (with a cache-busting query) and re-registers. An
  agent edits `web.js`, saves, and the screen updates. No build of Dispatch, no restart.

A plugin author builds `web.js` with esbuild and `react` marked external (mapped to
`window.dispatch.React`). A `create-dispatch-plugin` template and a typed `@dispatchd/sdk`
package make that a one-command start, for a person or an agent.

### 2.2 The MCP part: tools for every harness

Dispatch already writes a per-thread MCP configuration for each harness (Claude Code, Codex,
OpenCode, Grok) and injects the `dispatch` server. A plugin's `mcp/` folder is one more MCP
server in that configuration, started per thread like the others, with the thread's key in
its environment so it can call the daemon's API as that thread. A tool that needs daemon
data (the preview tool reads and writes previews) uses the REST API; the daemon stays the
authority. The `permissions` list in the manifest decides what the plugin's key may do.

This is how Previews becomes a plugin: its `preview` tool moves into the plugin's MCP server,
its list and sheet move into `web.js` (a view, a thread-menu item, a header badge slot), and
its routes and table stay in the daemon as a generic "plugin storage" API (below).

### 2.2.1 Instructions, hooks and the model's turns

A plugin reaches the model, not only the app. Dispatch already assembles each thread's
launch: the MCP servers (`composeInjection`), the system prompt (`buildPeerPrompt` and the
persona), and for Claude Code a settings file with lifecycle hooks. A plugin adds to each of
these through the manifest:

```json
"model": {
  "instructions": "instructions.md",
  "mcp": { "command": "node", "args": ["mcp/server.js"] },
  "hooks": {
    "prompt":    { "run": "hooks/on-prompt.js" },
    "turnEnd":   { "run": "hooks/on-turn-end.js" },
    "toolCall":  { "run": "hooks/on-tool.js", "tools": ["Bash", "secrets_*", "preview"] }
  },
  "harnesses": ["claude-code", "codex", "opencode", "grok"]
}
```

- **Instructions** are text joined into the thread's system prompt, after Dispatch's own
  peer prompt, per harness that supports it (all four do). "Always run the tests before you
  report done." "Write commit messages in this format." An instruction can be scoped per
  project from the plugin's settings.
- **Tools** are the plugin's MCP server, injected like the `dispatch` server, with the
  thread's key in its environment so the daemon still decides what the key may do.
- **Hooks** are the plugin's answer to "log every prompt I send", "log every turn's length",
  "do something when the model calls a tool". Where the harness has native hooks (Claude
  Code: UserPromptSubmit, Stop, PreToolUse, PostToolUse, Notification), Dispatch writes
  them into the per-thread settings file it already writes, pointing at the plugin's script
  with the thread's identity in the environment. Where the harness has none, Dispatch
  derives the same events from what it already sees: the structured stream for Pretty
  threads (every prompt, every tool call with its name and arguments, every turn's end with
  its token counts and duration), and the PTY monitor plus `report_status` for CLI threads.
  The daemon publishes them as events (`thread:prompt`, `thread:tool`, `thread:turn`) that a
  plugin's worker subscribes to, so one hook script works across harnesses. A native hook
  can also **block or rewrite** (PreToolUse can deny a tool call; UserPromptSubmit can add
  context); the derived events are after the fact and can only observe.
- **Tool access audit**: the daemon knows every MCP server and tool a thread was launched
  with (the injected specs: secrets, integrations, the `dispatch` server, plugin servers).
  It records that list on the thread (`tools_available`) and raises `thread:spawned` with it,
  so a plugin can log "this thread had the secrets tool" or alert when a thread gets a tool
  the project's policy forbids. With native PreToolUse hooks the plugin also sees each use.

Examples this enables: a prompt log (every prompt you send, per project, searchable); a
turn ledger (length, tokens, cost and duration per turn, with a chart); a tool audit (which
threads touched secrets, what Bash commands ran); a guardrail (deny `rm -rf`, deny pushes
to main, require a ledger decision before a deploy); a coach (after every turn end, score the
turn against the project's rules and message the thread); a "verify before done" rule that
runs the tests when `report_status(done)` is called and reopens the thread if they fail.

### 2.3 The worker part: jobs and event handlers

A worker is a process the daemon starts with the plugin's key and restarts if it dies. It
subscribes to the daemon's event stream (the same WebSocket the web client uses), runs the
manifest's `jobs` on their cron, and may expose HTTP endpoints that the daemon proxies at
`/plugins/<id>/api/*` so the web part can talk to it. A daily rundown is a worker: at 07:00
it reads yesterday's threads and ledger, writes a summary into plugin storage, and sends a
push notification.

### 2.4 Plugin storage

A plugin needs somewhere to keep settings and data without a schema migration in Dispatch.
The daemon offers `GET/PUT /api/plugins/<id>/data/<key>` (JSON documents, per plugin, with a
size cap) and `GET/PUT /api/plugins/<id>/settings`. The web SDK wraps these as a store.

## 3. The marketplace

A marketplace is an index: a JSON document at a URL that lists plugins and skills, each with
a name, description, version, the manifest's `contributes` and `permissions`, and a download
(a GitHub release tarball, or any URL). That is all it has to be.

- **dispatchd.app** hosts the public index. Publishing is a pull request to the index
  repository, or later a `dispatch plugin publish` that opens it.
- **An organisation** hosts its own index: a private GitHub repository, or any URL that needs
  a token. Settings → Plugins → Marketplaces takes the URL and the token (stored in Doppler
  or the daemon's secrets store). Members add the same marketplace; plugins stay private.
- **Install** downloads the tarball into `~/.dispatch/plugins/<id>`, checks its hash against
  the index, and enables it. **Update** compares versions. **Uninstall** deletes the folder
  and the plugin's storage.
- The Settings → Plugins page: installed (enable, disable, update, settings), and browse
  (per marketplace, search, install). On the phone the same page sits in Settings, and the
  owner's "fifth tab" idea becomes real when a plugin contributes a `mobileTab`.

## 4. Skills

A skill is a folder of prompt material (a `SKILL.md` and files), the format Claude Code,
Codex and OpenCode each already read from their own directories. Dispatch would:

- keep a library at `~/.dispatch/skills/<id>`;
- install skills from the same marketplaces (`kind: "skill"`);
- inject enabled skills into each harness's skill directory per thread (Claude Code's
  plugin dir, Codex's and OpenCode's instruction files), the way the MCP config is injected;
- show a Skills page (desktop rail or Settings) with enable/disable per project.

Skills and plugins stay two kinds, because a skill is text for the model and a plugin is
code for the app and the daemon. A plugin may bundle skills (`"skills": ["skills/*"]`), so a
tool can ship with the instructions for using it.

## 5. The agent's side: build a plugin from inside a thread

Every harness gets plugin tools through the `dispatch` MCP server:

- `plugin_scaffold({ id, name, kinds })` writes a starter folder from the template.
- `plugin_list()`, `plugin_enable({ id })`, `plugin_disable({ id })`, `plugin_remove({ id })`.
- `plugin_reload({ id })`, though the file watcher makes it rarely needed.
- `plugin_publish({ id, marketplace })` once publishing exists.

The agent writes the files with its normal file tools; the SDK's types and the template keep
it on the rails. A `plugin_preview` is not needed: the plugin shows up in the app as it is
saved.

## 6. Plugin ideas, far and wide

The use cases come first; the architecture follows from them. Each idea names what it needs
from Dispatch, in the vocabulary of section 2: a **slot** (a named place in an existing
screen), a **view** (a new screen), a **menu** item, a **tool** (for the harnesses), a
**worker** (a process with jobs and event handlers), **storage**, an **override** (replace
an existing component), or an **external** connection (a credential and a network call).

### 6.1 Mods of what exists

Changes to screens Dispatch already has. These are the owner's "modify anything" cases, and
they decide which slots the screens must expose.

| Idea | What it does | Needs |
| --- | --- | --- |
| Composer favourites | A row of your own buttons under the composer: "Run tests", "Commit and push", "Summarise where you are", each inserts or sends a saved prompt, per project | slot `composer.actions`, storage |
| Composer snippets | `/` or `;` expands a saved snippet; a snippet library in Settings | slot `composer.actions`, override `Composer` input handler, storage |
| Composer templates | A "New thread" form per project: pick a template (bug fix, spike, review) that fills the first message and the model | slot `newThread.form`, storage |
| Send-later | Queue a message to a thread for 07:00 | slot `composer.actions`, worker job |
| Message actions | Buttons on a chat message: copy as markdown, quote in the composer, open the file it names, create a ledger item from it | slot `message.actions` |
| Thread header buttons | Open the project's dev server, open its PR, open its Jira issue, right in the header | slot `thread.header.actions`, external |
| Thread menu items | "Export as markdown", "Duplicate thread with the same prompt", "Send transcript to Slack" | menu `thread` |
| Project menu items | "Open in VS Code", "Open in Finder", "Deploy" | menu `project` |
| Rail reorder and hide | Hide Analytics, put Chat first | registry edit, storage |
| Custom thread list columns | Show cost, model or branch on each thread row | slot `threadRow.meta` |
| Thread list filters and groups | Group by branch, by model, by "needs me"; saved filters | slot `threadList.filters`, store read |
| Inspector tabs | Beside Details and Files: Git, Issues, Tests, Logs | slot `inspector.tabs` |
| Details pane rows | Add rows to Thread details: the PR, the issue, the deploy state | slot `details.rows` |
| Chat rendering | Render a Mermaid block as a diagram, a CSV block as a table, a colour as a swatch | override `Markdown` block renderer |
| Tool-call rendering | A custom card for a tool the plugin added (a map for a geocode tool, a chart for a query tool) | registry `toolRenderers` |
| Notification rules | Only notify on needs-you for projects tagged "work"; quiet hours | event hook, override `notify` |
| Status and presence | A top-bar chip: "3 running, 1 needs you, $4.20 today" | slot `header.chips`, store read |
| Themes | Design tokens: light, high contrast, your brand | registry `themes` |
| Fonts and density packs | Larger terminal font, compact rail | registry `themes` |
| Keyboard shortcuts | `g t` go to threads, `g p` previews; a cheat sheet | registry `shortcuts` |
| Command palette | Jump to anything: threads, projects, settings, plugin screens, actions other plugins register | registry `commands`, override `App` key handler |
| Gestures on the phone | Swipe a thread row to archive; shake to report a bug | override `ThreadRow`, `MobileApp` |
| Onboarding and tips | A first-run tour; tips for a project | slot `app.overlay` |
| Settings sections | Any plugin's own settings; a section that edits the daemon's config file | registry `settings` |
| Previews as a plugin | Its list, sheet, badge and tool move out of the core | view, menu `thread`, slot `thread.header.actions`, tool, storage |
| Analytics panels | A new chart beside the existing ones: cost per model, tokens per hour | slot `analytics.panels` |
| Board columns | Custom columns on Board mode: by owner, by due date | override `BoardView` |
| Login and access | A different sign-in page; a company banner; a device approval flow | override `AuthBanner`, worker |

### 6.2 New functionality that ties into what exists

| Idea | What it does | Needs |
| --- | --- | --- |
| Prompt log | Every prompt you send, per project, searchable; a turn ledger with length, tokens, cost and duration | hook `prompt`, hook `turnEnd`, view, storage |
| Tool audit and guardrails | Which threads used secrets or ran which commands; deny a tool call by rule; alert on a forbidden tool | hook `toolCall`, `tools_available`, view, notify |
| Project rules as instructions | "Run the tests before done", "commit messages like this", scoped per project | instructions, settings |
| Daily rundown | Yesterday's threads, decisions, commits and cost, every morning, with a push; "add to rundown" from a thread menu | view, worker job, menu `thread`, storage, notify |
| Weekly update drafter | A paste-ready weekly update from the week's threads | view, worker job |
| Standup and timesheet | Per project, per day, what the agents did and how long they ran | view, store read |
| SFTP / SSH browser | Browse, edit and upload on a remote box; the worker holds the connection | view, worker with endpoints, external |
| S3 / GCS browser | Same for buckets | view, worker, external |
| Dev-server preview | The project's running app in a pane, phone and desktop frames; a thread can point it at a URL with a tool | view, slot `inspector.tabs`, tool |
| PR board | The agents' pull requests across projects, review state, merge from the phone | view, worker (GitHub polling), external |
| Diff review | What an agent committed since you last looked, as a reviewable diff with comments the agent reads back | view, tool, storage |
| CI and deploy panel | Pipelines per project; trigger and watch a deploy | view, worker, external |
| Issue sync | Jira, Linear or GitHub issues; spawn a thread from an issue; close it when the thread reports done | view, worker event hook on `report_status`, external |
| Approval inbox | Every needs-you across projects in one list; answer from the list | view, store read |
| Slack / Teams bridge | Needs-you to a channel; answer from the channel; a thread's final reply posted | worker, external |
| Email bridge | Mail a thread; the reply starts or continues a thread | worker, external |
| Cost guardrails | Budget per project; warn at 80%; pause new threads at 100% | worker event hook, slot `project.header`, storage |
| Model router rules | Per project: which model for which kind of thread; a cheaper model after N turns | event hook before spawn, settings |
| Project notes | A markdown scratchpad per project the agents read and append with a tool | view, tool, storage |
| Knowledge base | Index the project's docs; a `search_docs` tool for the harnesses | worker, tool |
| Database browser | The project's sqlite or Postgres, read-only by default | view, worker, external |
| Log tailer | Tail a file or a process on this Mac | view, worker |
| Process manager | Start, stop and watch the project's dev processes; a thread can start one with a tool | view, worker, tool |
| Screenshot markup | Draw on a preview image and send it back to the thread | override `FileViewer` toolbar, tool |
| Browser automation panel | Watch what Claude in Chrome does; approve steps | view, worker, external |
| Voice memo to thread | Record, transcribe, send | slot `composer.actions`, external |
| Calendar | A thread at 07:00 on weekdays, from a calendar view (Automations exist; this is a friendlier front) | view, store read |
| Reminders | "Remind me to check this thread at 3" | menu `thread`, worker job, notify |
| Export | A thread or a project to markdown, PDF or a Notion page | menu `thread`, menu `project`, worker |
| Audit log | Who did what, when, for a team | worker event hook, view |
| Team presence | Who runs what right now (multi-user) | view, worker |
| Secrets vault bridge | 1Password or AWS Secrets Manager beside Doppler | settings, worker, external |
| Usage dashboards | Per model and per account over time; export to Sheets | view, store read, external |
| Backup and sync | Nightly export of `~/.dispatch` to a bucket; restore | worker job, settings |
| Health checks | Watch a URL; start a thread when it fails | worker job, tool `spawn` |
| Agent personas | Named coordinator presets with a prompt and a model, switchable per project | settings, override `coordinator prompt` |
| Focus mode | One thread, a timer, quiet notifications | view, override `MobileApp` |
| Fun | Ambient sounds while an agent runs; a different waiting game during updates | slot `app.overlay`, override `Blaster` |

### 6.3 What the use cases ask of the architecture

Reading the two tables back:

- **Slots in the existing screens** are the most asked-for thing, far ahead of new screens.
  The composer, the thread header, the message row, the thread row, the inspector, the
  Details pane, the analytics page and the project header each need a named slot.
- **Overrides** are asked for by a quarter of the ideas (rendering, gestures, the board, the
  auth banner). Slots alone would not reach them. The escape hatch is needed from day one,
  documented as unsupported-but-possible.
- **Store reads and event hooks** are needed by most ideas; **store writes** by few. The SDK
  can expose the stores read-only with explicit actions, and an event bus with hooks that may
  run before an action (model router, cost guardrail) and after (issue sync, audit log).
- **Workers** are needed by every idea that polls, holds a connection, or runs on a clock.
  They are the second-biggest piece after slots.
- **Tools** appear wherever a thread should talk to the plugin (previews, notes, process
  manager, dev-server, diff comments). Every plugin that keeps data wants a tool to read it.
- **Storage** is needed by nearly all; a per-plugin document store is enough.
- **External credentials** are needed by a third; the plugin's settings section plus the
  daemon's secrets store cover it. Plugins never read Doppler directly.
- **Registries** (themes, shortcuts, commands, tool renderers) are simple lists with a
  consumer in the core. They cost little and unlock whole categories.

The composer alone gets four ideas, so it needs a richer slot than most: a row of actions,
an input interceptor (snippets), and a form before the first message (templates).

## 7. What a plugin system changes in Dispatch

- Web: registries and slots in the existing screens (the rail, the phone's tabs, Settings,
  the menus, the thread header, the composer, the inspector), an SDK object, a plugin host
  with error boundaries, hot reload, a Plugins settings page.
- Daemon: a plugin registry (manifests, enable state), static serving of plugin files, keys
  for plugin processes, MCP injection of plugin servers, worker supervision, plugin storage,
  marketplace fetch and install.
- Docs: the SDK reference, the template, the manifest schema, the marketplace index schema.
- Previews moves into a plugin as the proof the surface is complete.

## 7.1 Plugin updates

A plugin is versioned like Dispatch is: the manifest's `version`, and the marketplace index
lists the versions. Updates follow the same shape as the auto-updater:

- **Check**: the daemon polls each marketplace on the same schedule it polls GitHub for
  Dispatch (about every 45 minutes), and compares the installed version with the index.
- **Show**: the Settings → Plugins page lists "updates available", each with the plugin's
  release note. The Settings dot and banner from v3.27.0 cover plugin updates too, with one
  line per plugin.
- **Apply**: per plugin, or all at once. The daemon downloads the new tarball into a staging
  folder, checks its hash, swaps the folders, and sends `plugin:changed`; the web part
  reloads, the MCP server is picked up by the next thread, and the worker is restarted.
  No Dispatch restart.
- **Auto-update**: a per-plugin switch, off by default for marketplace plugins, on for a
  plugin installed from a marketplace the owner marked trusted (the organisation's own).
- **Compatibility**: the manifest declares `"dispatch": ">=3.27"` and the SDK version it was
  built against. The daemon refuses an update that needs a newer Dispatch and says so. An
  SDK major bump is the only way a plugin can break by a Dispatch update: the SDK keeps a
  deprecation window of one major version, and the Plugins page marks plugins built on an
  old SDK.
- **Storage migrations**: a plugin's `web.js` or worker receives `{ from, to }` on first run
  after an update and migrates its own documents. The daemon keeps a copy of the plugin's
  storage from before the update until the plugin reports the migration done, so **rollback**
  (one click on the Plugins page, back to the previous folder and storage) is always possible.
- **Local plugins** (a folder the agent wrote, not from a marketplace) never update from an
  index; they change when their files change. Publishing one to a marketplace turns it into
  a marketplace plugin for everyone else and leaves the author's copy local.
- **Pinned**: a plugin can be pinned to a version, for an organisation that qualifies a
  release before rolling it to members.

## 8. The spike

A throwaway build that proves the riskiest part: third-party UI loaded into the running app,
registering screens and menu items, hot-reloading as the file is saved, with one example
plugin. It skips marketplaces, workers, MCP injection, skills and permissions.

1. Daemon: read `~/.dispatch/plugins/*/plugin.json`; `GET /api/plugins`; serve
   `/plugins/<id>/<file>`; watch the folder and send `plugin:changed`.
2. Web: a plugin host that imports each bundle, a `window.dispatch` SDK, registries for the
   rail, the phone's tabs, the settings sections and the thread menu, an error boundary per
   plugin, hot reload.
3. Example plugin `daily-rundown`: a view (desktop rail item and a phone tab) that lists
   yesterday's threads per project from the existing API, a settings section with one
   option, and a thread-menu item.

What the spike should teach: whether dynamic import works through the Vite build and the
service worker, how much of the SDK a plugin really needs, how hot reload feels, and how
much of the existing screens must change to host slots.

### 8.1 What the spike taught (built 2026-11-07, Fable)

The spike runs. Two plugins written as plain ES modules in `~/.dispatch/plugins/` show up in a
running Dispatch with no build and no restart:

- `daily-rundown`: a screen in the desktop rail and a fifth tab on the phone, a settings
  section under a new PLUGINS group, and a "Pin to rundown" item in the thread menu.
- `composer-favourites`: a row of buttons under every composer (Chat, a Pretty thread, the
  phone's CLI composer) that insert saved prompts, and a settings section that edits them.
- Editing a plugin's file on disk changed the open screen within a second (the daemon watches
  the folder, sends `plugin:changed`, the client re-imports the bundle with a new stamp).

Size: 548 lines across 21 files, about half of it new (registry, host, SDK, boundary, view).
The rest is the existing screens reading one more list each.

What it proved:

- **In-app ES modules work under the CSP.** The bundle is same-origin (`/plugins/<id>/web.js`),
  so `script-src 'self'` allows a dynamic `import()`. Vite needs `/* @vite-ignore */` on the
  import and the dev server needs a `/plugins` proxy. The service worker caches `/assets/`
  only, so plugin bundles are never served stale from it.
- **No build step for authors.** A plugin uses the app's React through `window.dispatch.h`
  (`React.createElement`) and the app's styles through `window.dispatch.ui.styles`. The
  screens look native with no stylesheet of their own. A real SDK would add JSX through a
  template, but an agent writes `h()` calls without trouble.
- **The settings registry was ready; the rest were closed.** `SETTINGS_SECTIONS` took plugin
  sections with one hook. The rail's NAV, the phone's tab tuple, App's view ternary and the
  `View` / `SettingsSectionKey` / `bottomTab` unions each had to be loosened to `plugin:*`
  strings. The thread menu is static JSX and took one `map` after Copy thread ID. The
  composer had no slot; one was added under the pill (`composerActions`) with a context
  object (`surface`, `terminalId`, `value`, `insert`, `set`).
- **One gotcha for the SDK**: a zustand selector that returns a new array every call (a
  `filter` inside the selector) loops React forever under zustand 5. Plugin code will do
  this; the SDK must hand plugins memoised selectors or a `useContributions(kind)` hook.
- **Error boundaries are cheap and necessary.** Each plugin screen, section and slot renders
  inside one; a broken plugin shows a red card with its name. A `?safe` query loads no plugins.
- **Hot reload makes the agent loop real.** Save, look, save again. No `dispatch update`, no
  reload, no lost state in the rest of the app.

What the spike skipped, and what each would need:

| Skipped | Needed for a real version |
| --- | --- |
| Permissions | The manifest's list enforced by the daemon on the plugin's key, and shown before install |
| Plugin storage | `GET/PUT /api/plugins/<id>/data/<key>`; the spike used localStorage |
| Tools, instructions, hooks | The manifest's `model` block wired into `composeInjection`, the per-thread settings file, and the structured stream (section 2.2.1) |
| Workers | Process supervision with the plugin's key; `/plugins/<id>/api/*` proxy |
| Marketplace, install, update | The index format, download and hash check, the Plugins settings page (sections 3 and 7.1) |
| Overrides | A named-component map and `override(name, wrap)` |
| More slots | Thread header, message row, thread row, inspector, Details rows, analytics, project header |
| A typed SDK package | `@dispatchd/sdk` with the `DispatchSdk` interface from the spike, and a template |
| Tests | The spike has none of its own; the existing 377 touched tests still pass |

Recommendation: keep the shape (in-app ES modules, registries plus slots, hot reload) and
build the real version in this order: storage and permissions, the Plugins settings page with
local install, the model block (tools, instructions, hooks), then the marketplace, then
workers. Previews moves into a plugin when the model block lands, since its tool needs it.

## 9. Open questions for the owner

1. **Trust**: is "a marketplace plugin runs with the same power as the app" acceptable with
   a permissions list and a review step, or must marketplace plugins be sandboxed (option A)
   while local plugins get option B?
2. **Previews**: move it into a plugin in the first real version (proves the surface, but
   costs a migration), or leave it built in?
3. **Marketplace hosting**: a GitHub-based index first (zero infrastructure), or dispatchd.app
   as a service from the start (accounts, publishing, org visibility)?
4. **Skills**: Dispatch-managed skill library injected per harness, or a thin page over Claude
   Code's own plugin marketplaces?
5. **The fifth tab**: a fixed "Plugins" tab that lists plugin screens, or a tab per plugin
   that asks for one (the manifest's `mobileTab`), with a cap?
