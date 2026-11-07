# Plugins

A plugin changes Dispatch without a Dispatch release. It is a folder under
`~/.dispatch/plugins/<id>/`. Save a file in it and the running app reloads the plugin at once.
Design: `docs/superpowers/specs/2026-11-07-plugins-design.md`. This page covers what ships
today (slice 1: the web part); tools for the model, workers, storage on the daemon, and the
marketplace follow.

## The folder

```
~/.dispatch/plugins/daily-rundown/
  plugin.json      the manifest
  web.js           the browser part (a plain ES module, no build step needed)
  README.md        shown on the Plugins page later
```

`plugin.json`:

```json
{
  "id": "daily-rundown",
  "name": "Daily rundown",
  "version": "0.1.0",
  "description": "What happened in the last day, per project.",
  "web": "web.js",
  "contributes": { "views": [{ "id": "rundown", "label": "Rundown", "icon": "sun" }] },
  "permissions": []
}
```

- `id` is lowercase letters, digits and dashes, up to 64, and must equal the folder name.
- `web` names the browser bundle inside the folder. A plugin without `web` is listed but does
  nothing yet.
- `dispatch` (optional) is `">=3.28"`: the daemon refuses to load the plugin on an older
  Dispatch and shows why.
- `contributes` and `permissions` describe the plugin for the Plugins page and, later, the
  marketplace. What the bundle registers at runtime is what counts.

Start one from Settings → Plugins → "New plugin…", which writes a starter folder, or write
the files yourself. A thread can write them too.

## The browser part

`web.js` exports `activate(d)`. `d` is the SDK (the shared `window.dispatch`, with `d.id` set
to this plugin's own id): the app's React and hooks, its stores, its API client, its UI
primitives and style tokens, per-plugin storage, and `register`. Use `d.id` wherever the
plugin names itself (`register`, `storage`, `settings`, `fetch`): a copy to local then runs
under its new id without an edit. A plugin ships no React of its own; it builds elements with `d.h`
(`React.createElement`), or with JSX through a build that maps `react` to
`window.dispatch.React`.

```js
export default function activate(d) {
  const { h, hooks: { useState, useEffect }, api, ui, storage, hint } = d;

  function Rundown() {
    const [rows, setRows] = useState(null);
    useEffect(() => { api.listSessions().then(setRows); }, []);
    return h('div', { style: { padding: 24 } },
      h('h1', { style: { fontSize: 18 } }, 'Daily rundown'),
      ...(rows ?? []).map((s) => h('div', { key: s.id, style: ui.styles.item }, s.name)));
  }

  d.register('daily-rundown', {
    views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', Component: Rundown }],
    settings: [{ id: 'rundown', label: 'Daily rundown', blurb: 'How far back it looks', icon: 'sun', Component: Settings }],
    threadMenu: [{ id: 'pin', label: 'Pin to rundown', onPick: ({ tab }) => { storage.set('daily-rundown', 'pinned', tab.id); hint('Pinned'); } }],
    composerActions: [{ id: 'sum', label: 'Summarize', onClick: (ctx) => ctx.insert('Summarize where you are.') }],
    slots: [{ id: 'form', slot: 'composer.before', Component: TemplatePicker }],
  });
}
```

What `register` takes:

| Key | Shows up | Shape |
| --- | --- | --- |
| `views` | the desktop rail; the phone's Plugins tab (and a tab of its own once promoted in Settings → Plugins) | `{ id, label, icon?, Component }` |
| `settings` | Settings, under PLUGINS, on desktop and phone | `{ id, label, blurb?, icon?, Component }` |
| `threadMenu` | the thread ⋯ menu, after Copy thread ID | `{ id, label, when?({ tab }), onPick({ tab }) }` |
| `projectMenu` | the phone's project ⋯ menu, with the project's own rows | `{ id, label, when?({ session }), onPick({ session }) }` |
| `composerActions` | a row of buttons above every composer | `{ id, label, when?(ctx), onClick(ctx) }` with `ctx = { surface, terminalId?, sessionId?, value, insert(text), set(text) }` |
| `slots` | a named place in an existing screen | `{ id, slot, priority?, Component }`; mounted slots: `composer.before` (above the composer, the composer context as props), `project.header.actions` (the phone's project header, `{ session }`), `thread.header.actions` (the thread header on the phone and the desktop's floating controls, `{ terminal, floating? }`), `app.overlay` (the app root, for sheets and modals) |

`surface` is `'thread'` (a Pretty thread), `'terminal'` (a CLI thread's phone composer),
`'chat'` (the Control Plane chat) or `'unknown'`.

Icons are names from the SDK's map (`puzzle`, `sun`, `star`, `sparkle`, `lightning`,
`calendar`, `clock`, `note`, `rocket`, `flag`, `heart`, `folder`, `terminal`, `git`, `cloud`,
`database`, `bell`, `chart`, `list`, `play`, `gear`, `eye`, `chat`, `book`, `bug`, `shield`,
`globe`, `wrench`); an unknown name shows the puzzle piece.

The SDK object, in full:

- `version`, `React`, `h`, `Fragment`.
- `hooks`: `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useIsMobile`,
  `useContributions(kind, filter?)`, `useStore(store, selector)`.
- `stores`: `useUI`, `useProjects`, `useTabs`, `useUpdate`, `useThreadStatus`.
  Read them; write through `actions`.
- `actions`: `setView(key)`, `openThread(projectId, terminalId)`, `openSettings(sectionKey)`, `setBadge(viewKey, n)` (an unseen count on one of the plugin's views; 0 clears it).
- `id`, `apiPath(path)`, `storage.all(plugin)` (every document with its value in one call).
- `api`: the app's API client, with the owner's credentials.
- `ui`: `Modal`, `Markdown`, `FileViewer`, `Toggle`, and `styles` (`sectionLabel`, `row`,
  `item`, `ghostBtn`, `solidBtn(on)`, `chip`, `fieldInput`).
- `icons`: the map above.
- `storage`: `get(plugin, key, fallback)`, `set(plugin, key, value)`, `remove(plugin, key)`,
  `list(plugin)`, all async. Documents live on the daemon (`~/.dispatch/dispatch.db`), so they
  are the same on every device. Writes to one plugin land in order. A document is at most
  256 KB; a plugin holds at most 2000.
- `settings`: `get(plugin, fallback)` and `set(plugin, value)`, one document per plugin.
- `hooks.useDoc(plugin, key, fallback)` gives `[value, setValue, loading]` and refreshes when
  another client (or a thread) writes that document.
- `fetch(plugin, path, init)`: the app's fetch with an `X-Dispatch-Plugin` header, for a
  plugin's own calls to the API.
- `hint(text)`, `copyText(text)`.
- `register(id, contributions)`, `unregister(id)`.

A selector that returns a new array on every call loops React. Use `useContributions`, or
`useMemo` over a store's list.

## Permissions and the plugin key

`permissions` in the manifest is the full list of what the plugin's own key may do. The web
part runs with your credentials; the key is for the plugin's processes (an MCP server, a
worker: later slices). While a plugin is enabled, its key sits in
`~/.dispatch/keys/plugin-<id>` (mode 0600) and is revoked when the plugin is disabled or
removed. Anything not listed is refused: `The plugin "<id>" lacks the permission "<name>".`

| Permission | Grants |
| --- | --- |
| `read:projects` | the project list |
| `read:threads` | a project's threads and a thread's transcript |
| `read:ledger` | a project's ledger card and item sources |
| `threads:read-storage` | a thread key may read this plugin's documents |
| `threads:write-storage` | a thread key may write them; the daemon stamps the writing thread on the document |
| `threads:call-worker` | a thread key may call the plugin's worker through the proxy |
| `storage` | implied: the plugin's own documents and settings |

## Storage and settings routes

For a plugin's processes (or `d.fetch`):

- `GET /api/plugins/<id>/data` lists documents (key, writer, size, time).
- `GET`, `PUT`, `DELETE /api/plugins/<id>/data/<key>`; the PUT body is `{ "value": ... }`.
- `GET`, `PUT /api/plugins/<id>/settings`; the PUT body is `{ "value": ... }`.

The owner (the browser) reaches everything. A plugin key reaches its own plugin only. A thread
key reaches a plugin's documents only with the grants above.

## Instructions and tools for the model

The `model` block of the manifest reaches every thread (all harnesses, or the ones in
`harnesses`):

```json
"model": {
  "instructions": "instructions.md",
  "mcp": { "command": "node", "args": ["mcp/server.js"], "env": { "LOG": "1" } },
  "hooks": { "prompt": { "run": "hooks/on-prompt.js" }, "toolCall": { "run": "hooks/on-tool.js", "tools": ["Bash", "mcp__dispatch__*"] } },
  "harnesses": ["claude-code", "codex", "opencode", "grok"]
}
```

- `instructions` is a Markdown file whose text joins the thread's system prompt after
  Dispatch's own prompts, under `## Plugin: <name>`, in plugin id order.
- `mcp` is an MCP server the daemon injects into every thread as `plugin-<id>`. It runs with
  `DISPATCH_PLUGIN=<id>`, `DISPATCH_PLUGIN_AUTH_FILE=<the plugin's key file>` and, like the
  `dispatch` server, the thread's key in `DISPATCH_AUTH`. A relative command or arg that names
  a file in the plugin folder is made absolute. Thread details show every server a thread was
  launched with (`toolsAvailable`).

## Thread events and hooks

The daemon raises one stream of events for every thread, whichever harness:

| Event | When | Carries |
| --- | --- | --- |
| `thread:spawned` | a thread starts | `toolsAvailable` |
| `thread:prompt` | a prompt went to the thread | `text` (with `read:prompts`), `textLength`, `source`: `user`, `coordinator`, `thread` (a peer) or `daemon` (an auto-resume) |
| `thread:tool` | the model called a tool | `tool`, `input` (with `read:prompts`), `inputLength` |
| `thread:turn` | a turn ended | `ms`, `inputTokens`, `outputTokens`, `costUsd`, `outcome`, `summary`; `partial: true` when a CLI thread gave no usage |
| `thread:status` | `report_status` | `state`, `summary`, `ask`, `blocker` |

In the browser, `d.events.on('thread:prompt', handler)` (one type, a list, or `'*'`) receives
them; the browser runs with your power, so it sees the text. Listeners a plugin adds are
dropped when it reloads, so `activate` can add them without a guard. A prompt the owner typed
into a CLI thread, or one a peer sent, is reported once: the daemon matches the hook's copy
against what it sent.

`model.hooks` runs a script in the plugin folder per event (`prompt`, `toolCall` with an
optional `tools` glob list, `turnEnd`, `spawn`, `status`) with the event as JSON on stdin and
`DISPATCH_PLUGIN`, `DISPATCH_PLUGIN_AUTH_FILE`, `DISPATCH_API`, `DISPATCH_TERMINAL` and
`DISPATCH_SESSION` in the environment (the daemon's own environment, minus its keys and box
token). The script runs under the daemon's Node. Without `read:prompts` the script gets
lengths, not text. One script runs at a time per plugin, with a 10 s timeout and a backlog of 100; the
Plugins page shows runs, failures and drops. Hooks observe; a blocking hook (deny a tool
call) is not in this slice.

## Assist: one model call

`d.assist(plugin, { system, messages, maxTokens })` runs one turn on the daemon's assist model
(the signed-in Claude Code CLI, else the OpenRouter key) with no tools, and returns
`{ text, usage, ms, model }`. It needs `model:assist`; every call is metered on the Plugins
page, and at most three run at once per plugin (a fourth gets 429). A plugin's processes call
`POST /api/plugins/<id>/assist` with the same body. A plugin that judges in the browser
should claim its result document before it calls (the Prompt coach does), or every open tab
pays for the same call.

## The worker

`worker` in `plugin.json` names a process the daemon runs while the plugin is enabled:

```json
"worker": { "command": "node", "args": ["worker/index.js"], "env": {}, "jobs": [{ "id": "morning", "cron": "0 7 * * 1-5" }] }
```

- It starts in the plugin folder with the daemon's environment (minus its keys), `DISPATCH_PLUGIN`,
  `DISPATCH_PLUGIN_AUTH_FILE` (the plugin's key), `DISPATCH_API`, and `DISPATCH_PLUGIN_SOCKET` (a
  Unix socket path it may listen on). It restarts on exit with backoff (1 s, 2 s, 4 s … 60 s) and
  stays down after ten crashes in a row (the first run counts); the Plugins page shows the state and offers Restart. A worker exits on SIGTERM; the daemon sends SIGKILL three seconds later.
- Its stdout and stderr go to `~/Library/Logs/dispatch/plugins/<id>.log` (rotated at 5 MB); the
  Plugins page shows the last lines (Logs), and `GET /api/plugins/<id>/logs?lines=200` serves them to the owner.
- **The feed**: the daemon writes events to the worker's **stdin**, one JSON object per line: the
  `thread:*` events (without prompt text unless the plugin has `read:prompts`), the plugin's own
  `plugin:data` and `plugin:settings`, and `plugin:job { id, at }` when a job's cron minute comes
  (`min hour dom mon dow`, local wall time, so a job in the repeated hour of a fall-back night fires twice and one in the skipped hour of a spring-forward night not at all; a minute missed while the daemon was down is not replayed).
  No key may open the events WebSocket, so this is how a worker hears the daemon. A worker that
  does not read its stdin loses the oldest lines past 500 lines or 4 MB (a single line over 1 MB is dropped with a note in the log); the daemon never waits for it.
- **The socket**: a worker that listens on `DISPATCH_PLUGIN_SOCKET` is reachable at
  `/api/plugins/<id>/worker/<path>`: the owner, the plugin's own key, and thread keys when the
  plugin grants `threads:call-worker`. The daemon forwards the method, path, query, headers and
  body, drops the caller's credential, and adds `X-Dispatch-Principal` (`owner`, `thread:<id>`,
  `plugin:<id>`) and `X-Dispatch-Session`. A JSON body is re-serialized (so it is under the daemon's 1 MiB JSON cap); a large upload uses another content type and streams through. In the browser, `d.worker.fetch(d.id, 'jobs/run', { method: 'POST' })`.

## Bundled plugins

`packages/plugins/<id>` in the Dispatch checkout ships with Dispatch: Previews (the `preview` tool, the sheet, the history and the badges) and the Prompt coach are the two.
A bundled plugin updates with Dispatch, cannot be removed, and is not edited in place; "Copy
to local…" on the Plugins page duplicates it under a new id. A local plugin with the same id
hides the bundled one. A bundled plugin starts **disabled** unless its manifest says
`"enabledByDefault": true`: the coach makes a model call per prompt, so turning it on is the
owner's choice on the Plugins page. A local plugin made with New plugin… or Copy to local… starts
enabled; one that appears in the folder on its own starts disabled (see below).

## Marketplaces, install, update

A marketplace is a git repository (spec section 7.1). Dispatch has no public marketplace: an
organization (or a person) keeps its own, usually private, and the people who can clone it can
install from it. Settings → Plugins → Marketplaces takes
its URL (https, ssh, `git@host:path`, or an absolute path); the daemon clones it under
`~/.dispatch/marketplaces/<slug>` with your own git login (ssh keys, the credential helper,
`gh auth`), so a private repository is a private marketplace for the people who can read it.
No token is stored. The repository's layout is the catalog:

```
marketplace.json          { "name": "...", "description": "..." }   (optional)
plugins/<id>/             plugin.json, web.js, README.md, CHANGELOG.md, …
skills/<id>/              skill.json, SKILL.md, …
```

- **Browse** on the Plugins page lists every marketplace's plugins and skills at the clone's
  HEAD; **Install** copies `plugins/<id>` into `~/.dispatch/plugins/<id>` with
  `.dispatch-install.json` (the marketplace, the version, the commit) and enables it. An id that
  a local or bundled plugin already has is refused.
- The daemon pulls every marketplace about every 45 minutes and on **Check now**. A newer
  `plugin.json` version is an update: the Settings dot and banner list it under Dispatch's own,
  with Update; the Installed row shows it with "What's new" (the `CHANGELOG.md`).
- **Update** stages the new folder and swaps it in; the old one stays as `<id>.prev`, so **Roll
  back** swaps them again. Storage and settings are untouched. The web part hears
  `plugin:updated { id, from, to }` once. **Pin…** stops updates past a version. **Auto-update**
  (off by default) applies updates at the check; every plugin of a **Trusted** marketplace
  auto-updates.
- A marketplace removed while a plugin installed from it stays: the plugin keeps working and its
  row says "Marketplace removed".

## Publishing

```
dispatch plugin publish <folder> --to <marketplace url or slug> [--branch name] [--dry-run]
```

The command validates `plugin.json`, clones the marketplace into a temp folder with your own git
login, refuses a version that is not newer than the one there, copies the folder to
`plugins/<id>` (no `node_modules`, no install record, no symlinks), commits on
`plugin/<id>-<version>`, pushes, and opens the pull request through `gh` (or prints the compare
URL). Without write access to a GitHub marketplace, the command forks it with `gh` and opens
the pull request from your fork. Hidden files (`.env`, `.npmrc`), `node_modules`, symlinks and
what the plugin's `.gitignore` names stay out; the file list is printed; a plugin over 10 MB is
refused. Your local plugin stays local. `dispatch plugin list` and `dispatch skill list` read the
daemon. `@dispatchd/sdk` (packages/sdk) types what `activate(d)` receives.

## Skills

A skill is a folder under `~/.dispatch/skills/<id>` with a `skill.json` (`id`, `name`,
`version`, `description`, optional `harnesses`: any of `claude-code`, `codex`, `grok`, `opencode`) and a `SKILL.md`. Install one from a marketplace
(Browse) or write the folder yourself. Settings → Skills switches each skill on or off
everywhere, or for one project. The enabled skills' texts go into every thread's system prompt
under `## Skill: <name>` with the folder's absolute path, so the model can read the skill's
other files; Dispatch never writes into a project for this. A thread's `skill_list` tool lists
them; `plugin_list` lists the plugins (both read-only).

## Commands

`commands: [{ id, label, run }]` in `register` adds rows to the command palette (⌘K / Ctrl+K on
the desktop, after the views and the settings sections) and to the phone's Plugins tab under
COMMANDS. `run` is called with no arguments.

## Reloading, errors and safe mode

- Save any file in the folder: the daemon tells the app, which re-imports the bundle and
  re-registers the plugin. Other plugins and the rest of the app keep their state.
- A plugin folder that appears under `~/.dispatch/plugins` while the daemon runs (a thread wrote
  it, a copy landed) starts **disabled**: the Plugins page shows it, and the owner enables it. New
  plugin… and Copy to local… on the page start enabled, as does an install from a marketplace.
- Hot reload watches the plugin folder, and the real folder behind a symlinked one. On Linux it
  needs Node 20 or newer (recursive watching); without it the Reload button on the Plugins page
  does the same by hand.
- A plugin that throws shows a red card with its name where its content would be; the rest of
  the screen stays. Settings → Plugins shows the error, and can disable the plugin.
- `?safe` on the app's address, or Settings → Plugins → Safe mode, loads no plugin.

## Examples

`docs/plugins/examples/` holds two plugins to copy into `~/.dispatch/plugins/`:

- `daily-rundown`: a screen (rail item and phone tab), a settings section, a thread-menu item.
- `composer-favorites`: buttons above every composer, edited in a settings section.
