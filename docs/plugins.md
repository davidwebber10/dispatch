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

`web.js` exports `activate(d)`. `d` is `window.dispatch`, the SDK: the app's React and
hooks, its stores, its API client, its UI primitives and style tokens, per-plugin storage,
and `register`. A plugin ships no React of its own; it builds elements with `d.h`
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
    composerActions: [{ id: 'sum', label: 'Summarise', onClick: (ctx) => ctx.insert('Summarise where you are.') }],
    slots: [{ id: 'badge', slot: 'thread.header.actions', Component: Badge }],
  });
}
```

What `register` takes:

| Key | Shows up | Shape |
| --- | --- | --- |
| `views` | the desktop rail; the phone's Plugins tab (and a tab of its own once promoted in Settings → Plugins) | `{ id, label, icon?, Component }` |
| `settings` | Settings, under PLUGINS, on desktop and phone | `{ id, label, blurb?, icon?, Component }` |
| `threadMenu` | the thread ⋯ menu, after Copy thread ID | `{ id, label, when?({ tab }), onPick({ tab }) }` |
| `projectMenu` | the phone's project ⋯ menu, after Previews | `{ id, label, when?({ session }), onPick({ session }) }` |
| `composerActions` | a row of buttons above every composer | `{ id, label, when?(ctx), onClick(ctx) }` with `ctx = { surface, terminalId?, sessionId?, value, insert(text), set(text), send?(text) }` |
| `slots` | a named place in an existing screen | `{ id, slot, priority?, Component }` |

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
- `stores`: `useUI`, `useProjects`, `useTabs`, `usePreviews`, `useUpdate`, `useThreadStatus`.
  Read them; write through `actions`.
- `actions`: `setView(key)`, `openThread(projectId, terminalId)`, `openSettings(sectionKey)`.
- `api`: the app's API client, with the owner's credentials.
- `ui`: `Modal`, `Markdown`, `FileViewer`, `Toggle`, and `styles` (`sectionLabel`, `row`,
  `item`, `ghostBtn`, `solidBtn(on)`, `chip`, `fieldInput`).
- `icons`: the map above.
- `storage`: `get(plugin, key, fallback)`, `set(plugin, key, value)`, `remove`, `list`. In this
  slice it is the browser's localStorage; the daemon's plugin storage follows.
- `hint(text)`, `copyText(text)`.
- `register(id, contributions)`, `unregister(id)`.

A selector that returns a new array on every call loops React. Use `useContributions`, or
`useMemo` over a store's list.

## Reloading, errors and safe mode

- Save any file in the folder: the daemon tells the app, which re-imports the bundle and
  re-registers the plugin. Other plugins and the rest of the app keep their state.
- A plugin that throws shows a red card with its name where its content would be; the rest of
  the screen stays. Settings → Plugins shows the error, and can disable the plugin.
- `?safe` on the app's address, or Settings → Plugins → Safe mode, loads no plugin.

## Examples

`docs/plugins/examples/` holds two plugins to copy into `~/.dispatch/plugins/`:

- `daily-rundown`: a screen (rail item and phone tab), a settings section, a thread-menu item.
- `composer-favourites`: buttons above every composer, edited in a settings section.
