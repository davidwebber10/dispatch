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
  "sdk": 2,
  "web": "web.js",
  "contributes": { "views": [{ "id": "rundown", "label": "Rundown", "icon": "sun" }] },
  "permissions": []
}
```

- `id` is lowercase letters, digits and dashes, up to 64, and must equal the folder name.
- `sdk` is the SDK version that `web.js` is written for. Write `2`. Without it the plugin gets
  the deprecated version 1 object (see [SDK version 1](#sdk-version-1-deprecated)). "New plugin…"
  still writes a version 1 starter that uses no deprecated member; add `"sdk": 2` and change
  `d.register('<id>', {...})` to `d.register({...})` and `d.hint` to `d.ui.hint`.
- `web` names the browser bundle inside the folder. A plugin without `web` is listed but does
  nothing yet.
- `dispatch` (optional) is `">=3.28"`: the daemon refuses to load the plugin on an older
  Dispatch and shows why.
- `contributes` and `permissions` describe the plugin for the Plugins page and, later, the
  marketplace. What the bundle registers at runtime is what counts.

Start one from Settings → Plugins → "New plugin…", which writes a starter folder, or write
the files yourself. A thread can write them too.

## The browser part

`web.js` exports `activate(d)`. `d` is the SDK: the app's React and hooks, its UI primitives and
style tokens, the plugin's documents and settings, the app's threads and projects as plain data,
and `register`. A plugin ships no React of its own; it builds elements with `d.h`
(`React.createElement`), or with JSX through a build that maps `react` to the app's React.

There are two versions of `d`. `"sdk": 2` in `plugin.json` gives **SDK version 2**, which this
document describes. Without it, the plugin gets [SDK version 1](#sdk-version-1-deprecated),
which is kept for one release.

The version 2 object is **bound to the plugin**. No function takes a plugin id: `d.docs.get(key)`
reads this plugin's document, `d.register(contributions)` registers under this plugin's id, and
`d.worker.fetch(path)` reaches this plugin's worker. So a plugin cannot name another plugin's
documents, settings, worker, files or budget, and a copy to local runs under its new id without
an edit. `d.id` is the id, to read.

```js
export default function activate(d) {
  const { h, hooks: { useProjects }, ui, docs } = d;

  function Rundown() {
    const projects = useProjects();   // plain data: [{ id, name, workingDir, archived }]
    return h('div', { style: { padding: 24 } },
      h('h1', { style: { fontSize: 18 } }, 'Daily rundown'),
      ...projects.map((p) => h('div', { key: p.id, style: ui.styles.item }, p.name)));
  }

  d.register({
    views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', Component: Rundown }],
    settings: [{ id: 'rundown', label: 'Daily rundown', blurb: 'How far back it looks', icon: 'sun', Component: Settings }],
    threadMenu: [{ id: 'pin', label: 'Pin to rundown', onPick: ({ tab }) => { docs.set('pinned', tab.id); ui.hint('Pinned'); } }],
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
| `threadMenu` | the thread ⋯ menu, after Copy thread ID (on a phone: the sheet's Plugins section) | `{ id, label, icon?, when?({ tab }), onPick({ tab }), badge? }` (`icon`: a name from `icons`, such as `eye`; `badge`: `{ subscribe(onChange), get({ tab }) }`, a live count on the row; above 0 the phone's thread ⋯ shows a dot) |
| `projectMenu` | the phone's project ⋯ menu, with the project's own rows | `{ id, label, when?({ session }), onPick({ session }) }` |
| `composerActions` | a row of buttons above every composer | `{ id, label, when?(ctx), onClick(ctx) }` with `ctx = { surface, terminalId?, sessionId?, value, insert(text), set(text) }` |
| `slots` | a named place in an existing screen | `{ id, slot, priority?, Component }`; mounted slots: `composer.before` (above the composer, the composer context as props), `project.header.actions` (the phone's project header, `{ session }`), `thread.header.actions` (the thread header on the phone and the desktop's floating controls, `{ terminal, floating? }`), `app.overlay` (the app root, for sheets and modals) |
| `inspectorTabs` | the desktop right column, after Details and Files; on a phone, the thread ⋯ menu (a full-height sheet) | `{ id, label, icon?, priority?, Component }`, see [Right-column tabs](#right-column-tabs) |

`surface` is `'thread'` (a Pretty thread), `'terminal'` (a CLI thread's phone composer),
`'chat'` (the Control Plane chat) or `'unknown'`.

Icons are names from the SDK's map (`puzzle`, `sun`, `star`, `sparkle`, `lightning`,
`calendar`, `clock`, `note`, `rocket`, `flag`, `heart`, `folder`, `terminal`, `git`, `cloud`,
`database`, `bell`, `chart`, `list`, `play`, `gear`, `eye`, `chat`, `book`, `bug`, `shield`,
`globe`, `wrench`, `copy`, `check`, `trash`, `image`, `file`, `pdf`, `html`, `csv`, `x`, `thumbs-up`, `thumbs-down`, `dots`, `bell-slash`, `arrow-up`, `arrow-down`, `arrow-right`, `target`, `plus`, `caret-down`, `caret-right`); an unknown name shows the puzzle piece.

### Right-column tabs

`inspectorTabs` adds tabs to the desktop right column, after Details and Files. Tabs sort by
`priority` (higher first), then by plugin id. The selected tab's key is
`plugin:<pluginId>:<id>`; when that tab goes away (the plugin is disabled or removed), the
column goes back to Details. A tab keeps its place while its plugin reloads. The component gets
the open thread's `terminalId` and its project's `sessionId`, each `null` when nothing is open.
On a phone there is no right column: the thread's ⋯ menu lists each tab, and a tap opens the
component in a full-height sheet with the same props. A tab that throws shows the plugin's
error card; the other tabs keep working. `icon` is a name from the map above or an icon
component.

```js
export default function activate(d) {
  const { h, hooks: { useDoc } } = d;
  function Notes({ terminalId, sessionId }) {
    const [text] = useDoc(`notes:${terminalId ?? sessionId ?? 'none'}`, '');
    if (!terminalId) return h('div', { style: { padding: 16 } }, 'Open a thread to see its notes.');
    return h('pre', { style: { padding: 16, whiteSpace: 'pre-wrap' } }, text || 'No notes yet.');
  }
  d.register({ inspectorTabs: [{ id: 'notes', label: 'Notes', icon: 'note', priority: 10, Component: Notes }] });
}
```

The SDK object (version 2), in full:

- `version` (the number 2), `id` (this plugin's id), `React`, `h`, `Fragment`.
- `hooks`: `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useIsMobile`,
  `useContributions(kind, filter?)`.
  - `useDoc(key, fallback)` gives `[value, setValue, loading]` for one of this plugin's documents,
    and refreshes when another client (or a thread) writes that document.
  - `useProjects()` gives the projects, and `useThreads()` the loaded threads, as React state.
    The array is the same object until the list changes, so it is safe in a `useMemo` dependency.
- `docs`: this plugin's documents. `get(key, fallback)`, `set(key, value)`, `delete(key)`,
  `keys()`, `entries()` (every document with its value, in one request), all async. Documents live
  on the daemon (`~/.dispatch/dispatch.db`), so they are the same on every device. Writes land in
  order. A document is at most 256 KB; a plugin holds at most 2000. `delete` of a missing key is
  not an error.
- `settings`: `get(fallback?)` and `set(value)`, one JSON value for the plugin.
- `threads`: the app's threads as plain data.
  - `list()` gives the threads of every project whose list the app has loaded; `get(id)` gives one,
    or null. A thread is `{ id, projectId, label, kind, status, archived, createdAt,
    lastActivityAt }`. `kind` is the harness (`claude-code`, `codex`, …).
  - `status(id)` gives `{ status, state, activity, stalledSince }`, or null. `state` and `activity`
    are null until a live status event arrives.
  - `load(projectId?)` asks the app to read the thread list of one project (of every project
    with no id) and resolves with those threads.
  - `onChange(fn)` calls `fn` when a thread is added, removed or changed, or a status changes. It
    returns the function that stops it. A reload of the plugin stops it too.
- `projects`: `list()`, `active()` (the open project, or null) and `onChange(fn)`. A project is
  `{ id, name, workingDir, archived }`.
- `navigate(route)` goes to a screen and adds one history entry. A route is
  `{ view: 'workspace', projectId?, threadId?, agentId? }`, `{ view: 'settings', section?, subPage? }`,
  `{ view: 'chat' }`, `{ view: 'analytics' }` or `{ view: 'plugin:<id>:<view>' }`.
- `actions`: `setView(key)`, `openThread(projectId, terminalId)`, `openSettings(sectionKey)`,
  `setBadge(view, n)` (an unseen count on one of this plugin's views, by the view's id or its key; 0 clears it; another plugin's key is ignored).
  `openSchedule({ projectId?, prompt, cron?, label? })` opens the new-automation dialog with those
  fields filled; `openNewThreads({ projectId?, prompts })` opens the new-thread dialog listing one
  thread per prompt. Neither creates anything: the person reviews and presses Save or Start (each
  new thread then gets its prompt as its first message). No `projectId` = the open project.
  `createSkill({ name, description?, body, id?, projects?, projectId? })` opens a review sheet with
  a drafted skill (name, id, description, the `SKILL.md` body, and all projects or the open one,
  all editable); only its **Create** writes and enables the skill. It resolves with `{ id }`, or
  null on Cancel.
- `events.on(type, handler)`: see [Thread events and hooks](#thread-events-and-hooks).
- `assist(request)`: see [Assist: one model call](#assist-one-model-call).
- `model`: what this plugin's model calls cost. `usage({ from?, to? })`, `share({ accountId?,
  harness? })`, `budget()` and `setBudget({ percentWeekly?, usdWeekly? })`.
- `plugin.disable()` turns this plugin off, as the switch on the Plugins page does.
- `files`: the file references that threads registered with this plugin. `url(fileId)` is the
  address of the bytes (for an `<img src>` or the `FileViewer`); `remove(fileId)` removes the
  reference.
- `worker.fetch(path, init?)`: this plugin's worker, see [The worker](#the-worker). A path that
  leaves the worker (`..`, a full URL) is refused.
- `url(path)`: an app-root-relative path (`/api/...`, `/plugins/...`) as the browser must request it.
- `zustand.create`: the app's zustand, for a store of the plugin's own.
- `ui`: `Modal`, `Markdown`, `FileViewer`, `Toggle`, `FilterBar`, `Select`, `MultiSelect`,
  `Segmented`, `SettingsGroup`, `SettingsRow`, and `styles` (`sectionLabel`, `row`, `item`,
  `ghostBtn`, `solidBtn(on)`, `chip`, `fieldInput`).
  - `SettingsGroup` and `SettingsRow` build a settings page in the same grouped-card shape as
    Settings → Plugins. A group is `{ title?, footer?, action?, children }`: a small heading over
    a card, with a hairline between rows (falsy children are skipped). A row is
    `{ label, hint?, control?, children? }`: the label and a one-line hint on the left, a small
    `control` on the right (a `Toggle`, a short `Select`, a number field, a `MultiSelect`
    trigger). A wide control goes in `children`, on its own full-width line under the label, so
    the text is never squeezed.
  - `Segmented` is a full-width segmented choice for 2 to 5 options: `{ value, options:
    [{ value, label, hint? }], onChange(value), ariaLabel, size? }`. It is a `radiogroup`, and the
    picked option's `hint` shows under it. Put it in a row's `children`, not in `control`. For
    more options, or long labels, use `Select`.
  - `MultiSelect` picks several values from a long list: `{ value: string[], options: [{ value,
    label, note? }], onChange(values), ariaLabel, title?, summary?, allLabel?, noneLabel?, noun?,
    searchable?, variant? }`. The trigger names the pick ("All projects", "All except 2",
    "3 projects"); a tap opens a popover on the desktop and a bottom sheet on the phone, with a
    search box (past 8 options), Select all / None (they act on the rows the search shows), and a
    checklist. Each tap calls `onChange` at once with the whole new list.

    ```js
    h(ui.SettingsGroup, { title: 'What it looks at' },
      h(ui.SettingsRow, { label: 'Projects', hint: 'Only these projects.',
        control: h(ui.MultiSelect, { ariaLabel: 'Projects', allLabel: 'All projects',
          noun: ['project', 'projects'], value: watched, onChange: setWatched,
          options: projects.map((p) => ({ value: p.id, label: p.name })) }) }),
      h(ui.SettingsRow, { label: 'How often' },
        h(ui.Segmented, { ariaLabel: 'How often', value, onChange: setValue,
          options: [{ value: 'quiet', label: 'Quiet', hint: 'Only the weekly recap.' }, { value: 'normal', label: 'Normal' }] })))
    ```
  - `FilterBar` is the app's filter control, the same one the Threads list uses: a search field
    with a Filters button to its right. The button opens a panel (a popover on the desktop, a
    bottom sheet on the phone) with one section per facet. Each facet is a single-select list,
    with a count per option when you give one and a search box past 8 options. The active
    filters show as removable pills under the row, and Clear resets them all. Props:
    `facets`, `query`, `onQueryChange` (no search without it), `placeholder`, `doneLabel`,
    `onClear`. A facet is `{ id, title, value, options, onChange, allLabel?, allCount?,
    display?: 'list' | 'segmented', searchable?, defaultOpen? }`; `value: null` means no filter,
    and an option is `{ value, label, note?, count? }`.

    ```js
    h(ui.FilterBar, {
      query, onQueryChange: setQuery, placeholder: 'Search previews',
      facets: [{ id: 'project', title: 'Project', allLabel: 'All projects', value: project,
        onChange: setProject, options: projects.map((p) => ({ value: p.id, label: p.name, count: p.count })) }],
    })
    ```
  - `Select` is the app's dropdown for a form field: `{ value, options: [{ value, label, hint? }],
    onChange(value), ariaLabel, id?, searchable?, placeholder?, size?, disabled? }`. It has a
    search box past 8 options, and full keyboard support (arrows, Enter, Escape, a letter jumps).
    Do not render a native `<select>`: the app has none, and a test fails on one in a bundled
    plugin.
- `icons`: the map above.
- `ui.hint(text)` shows a short line at the bottom of the screen. `ui.copyText(text)` copies.
- `register(contributions)` replaces this plugin's contributions.

The object and its namespaces are frozen. The types are in the `@dispatchd/sdk` package
(`packages/sdk/index.d.ts`): `DispatchSdkV2`, `ThreadInfo`, `ProjectInfo`, `ThreadStatusInfo`.

A selector that returns a new array on every call loops React. Use `useProjects`, `useThreads` or
`useContributions`, or `useMemo` over a list.

### What the binding does, and what it does not

Each request that the version 2 object makes carries the header `X-Dispatch-Plugin-Bound: <id>`.
The daemon refuses a request whose header names one plugin and whose path names another, with
`403 out_of_scope`. So a wrong path through the SDK cannot reach another plugin.

This is not a sandbox. A bundle is code in the owner's page, and it runs with the owner's session.
Install a plugin only from a source that you trust. A plugin's worker and its MCP server are
different: they hold the plugin key, and the daemon limits that key to the plugin's own routes
(see [Permissions and the plugin key](#permissions-and-the-plugin-key)).

### SDK version 1 (deprecated)

A plugin whose `plugin.json` says `"sdk": 1`, or has no `sdk` field, gets the version 1 object.
It still works in this release. It has two members that version 2 does not have:

- `api`: the app's API client, with the owner's credentials.
- `stores`: the app's stores (`useUI`, `useProjects`, `useTabs`, `useUpdate`, `useThreadStatus`),
  and `hooks.useStore(store, selector)`.

**`sdk.api` and `sdk.stores` go away in the next major version of Dispatch.** The first use of each
by a plugin writes one warning to the browser console. The warning names the plugin and the
replacement.

The other members of version 1 take the plugin id as their first argument: `storage.get(plugin,
key, fallback)`, `storage.set`, `storage.remove`, `storage.list`, `storage.all`,
`settings.get(plugin, fallback)`, `settings.set(plugin, value)`, `hooks.useDoc(plugin, key,
fallback)`, `assist(plugin, request)`, `fetch(plugin, path, init)`, `worker.fetch(plugin, path,
init)`, `register(id, contributions)`, `unregister(id)`. The id must be the plugin's own (`d.id`).
A call that names another plugin is refused before any request. `hint(text)`, `copyText(text)`
and `apiPath(path)` are at the top level. A bundle with no default export can still register
through the shared `window.dispatch`.

### Moving a plugin to SDK version 2

1. Set `"sdk": 2` in `plugin.json` (`"sdkVersion": 2` is read as the same field).
2. Change each call as the table shows.
3. Reload the plugin. Open its screens with the browser console open: there must be no warning.

| Version 1 | Version 2 |
| --- | --- |
| `d.register(id, contributions)` | `d.register(contributions)` |
| `d.storage.get(id, key, fallback)` / `set` / `remove` / `list` / `all` | `d.docs.get(key, fallback)` / `set(key, value)` / `delete(key)` / `keys()` / `entries()` |
| `d.settings.get(id, fallback)` / `set(id, value)` | `d.settings.get(fallback)` / `set(value)` |
| `d.hooks.useDoc(id, key, fallback)` | `d.hooks.useDoc(key, fallback)` |
| `d.assist(id, request)` | `d.assist(request)` |
| `d.worker.fetch(id, path, init)` | `d.worker.fetch(path, init)` |
| `d.fetch(id, '/api/plugins/<id>/files/<fileId>', { method: 'DELETE' })` | `d.files.remove(fileId)` |
| `d.apiPath('/api/plugins/<id>/files/<fileId>')` | `d.files.url(fileId)` |
| `d.apiPath(path)` | `d.url(path)` |
| `d.hint(text)`, `d.copyText(text)` | `d.ui.hint(text)`, `d.ui.copyText(text)` |
| `d.stores.useProjects((s) => s.sessions)` | `d.hooks.useProjects()` (or `d.projects.list()` outside a component) |
| `d.stores.useTabs((s) => s.byProject)` | `d.hooks.useThreads()` (or `d.threads.list()`); a thread's project is `projectId`, its harness is `kind` |
| `d.stores.useThreadStatus(...)` | `d.threads.status(id)` with `d.threads.onChange(fn)` |
| `d.stores.useUI` (`setView`) | `d.actions.setView(key)` or `d.navigate(route)` |
| `d.api.listSessions()` | `d.projects.list()` |
| `d.api.listTerminals(projectId)` | `d.threads.load(projectId)` |
| `d.api.pluginAssistUsage(id)`, `pluginAssistShare(id, q)`, `pluginBudget(id)`, `setPluginBudget(id, b)` | `d.model.usage()`, `d.model.share(q)`, `d.model.budget()`, `d.model.setBudget(b)` |
| `d.api.disablePlugin(id)` | `d.plugin.disable()` |
| `d.actions.setBadge('plugin:<id>:<view>', n)` | the same, or `d.actions.setBadge('<view>', n)` |
| another `d.api` method | no replacement. Put the work in the plugin's [worker](#the-worker) (it holds the plugin key and its permissions) and call it with `d.worker.fetch`. |

`threadMenu` and `projectMenu` items still get `{ tab }` and `{ session }`. Read `tab.id`,
`tab.sessionId`, `tab.label` and `session.id`, `session.name` only.


## Themes

Dispatch has light and dark themes (Settings → Appearance → Theme), and the user can pick
their own accent. A plugin renders inside the app's page, so it follows the theme when it takes
every color from the app's CSS variables. Do not write a literal color (`#fff`, `rgb(…)`,
`white`): it stays the same in every theme and reads as a bug on a light one.

- Surfaces: `--color-canvas` (the backdrop), `--color-base`, `--color-pane`, `--color-elevated`
  (cards, inputs), `--color-modal`, `--color-hover`, `--color-selected`.
- Borders: `--color-border`, `--color-border-strong` (controls), `--color-border-hover`.
- Text: `--color-text-primary`, `--color-text-body`, `--color-text-secondary`,
  `--color-text-tertiary`, `--color-text-emphasis` (the strongest).
- Accent: `--color-accent`, and `--color-on-accent` for text on a filled accent button.
  `--color-link` for links.
- Status: `--color-status-green`, `--color-status-yellow`, `--color-status-amber`,
  `--color-status-red`, `--color-status-coral`, `--color-status-blue`.
- Hues for categories: `--color-red`, `--color-orange`, `--color-yellow`, `--color-green`,
  `--color-cyan`, `--color-blue`, `--color-purple`, `--color-pink`.
- Scrims and shadows: `--color-overlay`, `--color-shadow`, `--color-shadow-strong`.
- Code: `--color-code-bg` and the `--syntax-*` colors; highlight.js classes (`.hljs-*`) are
  already styled.

For a tint, mix a variable: `color-mix(in srgb, var(--color-accent) 12%, transparent)`. Code
that needs a real color value (a canvas, a chart library) can read one with
`getComputedStyle(document.documentElement).getPropertyValue('--color-accent')`; read it again
when `document.documentElement.dataset.theme` changes. The full list is the `:root` block of
`packages/web/src/theme.css`. `ui.styles` already uses these variables.

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
| `read:usage` | the usage-limit summary (`GET /api/usage-limits/summary`): every account's windows and resets |
| `read:analytics` | the analytics routes (`GET /api/analytics/*`), read only |
| `notify:push` | `POST /api/plugins/<id>/notify { title, body, url? }` from its own key: a push to every device, at most one an hour (429 `rate_limited` with `retryAfterSeconds`). `url` is an app path a tap opens |
| `model:assist` | model calls (see Assist below) |
| `threads:read-storage` | a thread key may read this plugin's documents |
| `threads:write-storage` | a thread key may write them; the daemon stamps the writing thread on the document |
| `threads:call-worker` | a thread key may call the plugin's worker through the proxy |
| `storage` | implied: the plugin's own documents and settings |

## Storage and settings routes

For a plugin's processes:

- `GET /api/plugins/<id>/data` lists documents (key, writer, size, time).
- `GET`, `PUT`, `DELETE /api/plugins/<id>/data/<key>`; the PUT body is `{ "value": ... }`.
- `GET`, `PUT /api/plugins/<id>/settings`; the PUT body is `{ "value": ... }`.

The owner (the browser) reaches everything. A plugin key reaches its own plugin only. A thread
key reaches a plugin's documents only with the grants above.

### Export and import

In Settings → Plugins, a plugin row's ⋯ menu has **Export data** and **Import data…**. The
Remove dialog has a **Download data and settings** button too. An export is one JSON file,
`<id>-data-<YYYY-MM-DD>.json`, with the plugin's documents, settings and file references. A file
reference holds the path in its project, not the bytes. An import asks for a mode: **Merge**
(the default) overwrites the same keys and keeps the others; **Replace** deletes the plugin's
data and settings first. An import that would go over the storage limits (2,000 documents,
256 KB each) writes nothing. The routes are owner only: `GET /api/plugins/<id>/export` and
`POST /api/plugins/<id>/import?mode=merge|replace` (add `&force=1` to import a file exported from
another plugin id). Both work after a Remove that kept the data.

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
| `thread:prompt` | a prompt went to the thread | `text` (with `read:prompts`), `textLength`, `source`: `user`, `coordinator`, `thread` (a peer), `daemon` (an auto-resume) or `schedule` (any prompt in a thread a schedule or a role started) |
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

`d.assist({ system, messages, maxTokens, harness?, model?, accountId? })` runs one turn
with no tools and returns `{ text, usage, ms, model, harness, accountId, costUsd }`. `usage`
keeps `cacheReadTokens` and `cacheCreateTokens` apart from `inputTokens`.

- `harness`: `claude` (the `claude` CLI), `codex` (`codex exec`), `openrouter` (the OpenRouter
  key), or `auto` (the signed-in account with the most weekly room, never one at 90% of its
  5-hour window). An explicit harness runs alone: no fallback. With no harness the call runs
  as before: the Claude CLI, else OpenRouter.
- `model`: that harness's model id (no spaces, at most 120 characters). Defaults:
  `claude-haiku-5-5`, Codex's small model, `anthropic/claude-haiku-5.5`.
- `accountId`: the account (Settings → Accounts) a CLI harness signs in as; default: the
  harness's default account.

It needs `model:assist`; at most three calls run at once per plugin (a fourth gets 429 `busy`).
A plugin's processes call `POST /api/plugins/<id>/assist` with the same body. A plugin that
judges in the browser should claim its result document before it calls, or every open tab pays
for the same call.

**Metering.** Every call is a row, failed calls included: model, harness, account, tokens,
cost (the harness's own figure, else priced from the tokens; an OpenRouter call with neither is
priced at a conservative $15 / $75 per million input / output tokens and marked as an estimate, so
the dollar budget still fills). The Plugins page shows the last
7 days on the plugin's row. `GET /api/plugins/<id>/assist/usage?from&to` (the owner, or the
plugin's own key) gives `{ calls, failed, inputTokens, outputTokens, costUsd, byModel }`; no
`from` is the last 7 days. `GET /api/plugins/<id>/assist/share?accountId&harness` (the owner, or
the plugin's own key with `read:usage`) gives the plugin's estimated share of that account's 5-hour and weekly windows: its price-weighted tokens
over every Dispatch token on the account in the window, times the window's used percent. Usage
outside Dispatch is not seen, so the estimate reads high.

**Budget.** `PUT /api/plugins/<id>/budget { percentWeekly?, usdWeekly? }` (owner only; `null`
clears one; `GET` also answers the plugin's own key, so its worker can plan by it) caps the plugin's model calls: at most `percentWeekly` % (0.1 to 100) of the weekly
limit of the account a call runs on, and at most `usdWeekly` dollars over 7 days on OpenRouter.
At the cap, or with the account at 90% of its 5-hour window, assist answers 429
`{ error: 'budget', usedPercent, capPercent, window }` (`usedUsd`, `capUsd` on OpenRouter).
Calls in flight count as reserved at their `maxTokens`. Each answer carries
`X-Budget-Used-Percent`, `X-Budget-Cap-Percent` and `X-Budget-Resets-At` (`X-Budget-Used-Usd`, `X-Budget-Cap-Usd`), so
a caller can step down before it is refused. No budget: no cap.
**Fail safe:** with a percent budget but no weekly figure for the account (no usage data yet, a
poll gap after a restart), the cap becomes tokens, never unlimited: `percentWeekly` x 50,000
tokens over the plugin's subscription calls of the last 7 days (3% = 150,000; input, output and
cache writes count in full, a cache read counts one tenth). The answer then carries
`X-Budget-Used-Tokens` and `X-Budget-Cap-Tokens`, the share route adds `fallback: { usedTokens,
capTokens }`, and at the cap assist answers 429 `{ error: 'budget', window: 'unknown', usedTokens, capTokens }`.

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
  `plugin:<id>`) and `X-Dispatch-Session`. A JSON body is re-serialized (so it is under the daemon's 1 MiB JSON cap); a large upload uses another content type and streams through. In the browser, `d.worker.fetch('jobs/run', { method: 'POST' })`.

## Bundled plugins

`packages/plugins/<id>` in the Dispatch checkout ships with Dispatch: Previews (the `preview` tool, the sheet, the history and the badges) and the Coach (it replaced the Prompt coach; it is off by default, and an owner who turned it on, or had turned the Prompt coach on, keeps it on) are the two.
A bundled plugin updates with Dispatch, cannot be removed, and is not edited in place; "Copy
to local…" on the Plugins page duplicates it under a new id. A local plugin with the same id
hides the bundled one. A bundled plugin starts **disabled** unless its manifest says
`"enabledByDefault": true`, as Previews' does (the Coach's no longer does: owner, 2026-11-08). A
manifest may also say `"budget": { "percentWeekly": 3, "usdWeekly": 5 }`: that budget holds from
the plugin's first call until the owner sets one (`PUT /budget`; an owner's `null` stays). A local plugin made with New plugin… or Copy to local… starts
enabled; one that appears in the folder on its own starts disabled (see below).

The Coach (`packages/plugins/coach`) is also a worked example of the plugin features: its worker
(`worker/index.mjs`, logic in `lib/engine.mjs`) reads the thread events, runs rules over them and
asks `assist` with a harness and a model per tier, reading the `X-Budget-*` headers to step down
before the budget refuses (it also reads `GET /budget` and the share at start, every 15 minutes,
on a settings change, and before it settles on no call, so a reset or a raised budget resumes it); its web part fills the `composer.before` slot, a right-column tab, a
view, a settings section and two commands, and opens the schedule and new-thread dialogs through
`d.actions`. Its default budget is in `plugin.json`; the settings write a change (`PUT /budget`).
Its worker makes no model call before the person has seen the welcome card and the first week has
passed (the rules still collect, at no cost), nor during a mute or quiet hours; and its weekly job pushes
the recap through `notify:push` only when the person turns that on. Its documents: `signals`,
`candidates`, `cards`, `cardState`, `cadence`, `memory`, `status`, `measures`, `recap`, `chat`,
and `reviews:<id>` (one per review job: the web part writes the request and Start, the worker
reads the transcripts with `read:threads` and writes the progress and the report). It also adds a
thread menu row (Review this thread). See its `README.md`.

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
other files; Dispatch never writes into a project for this. The owner can also create one:
`POST /api/skills { id, name, description, body, projects? }` writes `<id>/SKILL.md` and
`skill.json` and enables it (201 `{ skill }`; 409 for an id that exists; 400 for an id that is not
a lower-case slug or a body over 64 KB). `projects` limits the skill to those projects
(`skill.json` `projects`). A thread's `skill_list` tool lists
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
