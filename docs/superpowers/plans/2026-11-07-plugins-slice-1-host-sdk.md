# Plugins slice 1: host and SDK — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A folder under `~/.dispatch/plugins/<id>` with a `plugin.json` and a `web.js` shows up in the running app (desktop rail, phone Plugins tab, Settings, thread and project menus, composer buttons) and reloads as its files are saved; Settings → Plugins lists, scaffolds, reloads, enables, disables and removes local plugins.

**Architecture:** The daemon keeps a `PluginRegistry` over the plugins folder (manifests, enabled state, file serving, a watcher that broadcasts `plugin:changed`). The web client has a plugin host that imports each enabled bundle as a same-origin ES module, an SDK object at `window.dispatch`, and a contributions store the existing screens read beside their static lists. Every plugin render sits in an error boundary. The spike on branch `spike/plugins` is the reference; this slice rebuilds it with tests, the Plugins page and the phone's Plugins tab.

**Tech Stack:** Node 18+, Express, better-sqlite3 (no new tables this slice), vitest + supertest (core); React 18, zustand 5, Vite 5, vitest + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` (sections 1, 2, 11 slice 1, 12).

## Global Constraints

- CSP stays `script-src 'self'`: bundles are served by the daemon at `/plugins/<id>/<path>` only.
- Plugin ids match `^[a-z0-9][a-z0-9-]{0,63}$` and equal the folder name.
- Plugin files are confined to the resolved plugin folder (symlinked folders are followed; paths are resolved against the real folder).
- HTML served from a plugin folder carries the previews' sandbox CSP (`HTML_SANDBOX_CSP` from `routes/previews.ts`).
- A broken plugin (bad manifest, throwing bundle) shows its error and never blanks the app.
- Safe mode (`?safe` in the URL, or the Settings switch kept at `localStorage['dispatch:plugins:safe'] = '1'`) loads no plugin.
- `plugin:changed` is debounced 150 ms per folder change.
- Dispatch works with no plugins folder and with an empty one.
- All user-facing copy in the app follows the existing voice (short, present tense, no jargon).

## Review Focus

1. A plugin folder whose `plugin.json` is not valid JSON must list as broken with the parse error, not crash `GET /api/plugins` (Task 1 test "a folder with invalid JSON lists as broken").
2. A plugin folder removed while the app is open must disappear from the rail, the tabs and Settings without a reload (Task 3 test "a removed plugin unregisters"; Task 2 broadcasts `plugin: null`).
3. A bundle whose `activate` throws must not stop the other plugins from loading (Task 5 test "one plugin's throw does not block the next").
4. A plugin view key saved in `localStorage['dispatch:view']` for a plugin that is now disabled must open the workspace, not a blank screen (Task 7 test "a saved view for an unloaded plugin falls back").
5. Disabling a plugin must stop serving its files (Task 2 test "a disabled plugin's files are 404").

---

## File structure

Core (`packages/core`):
- Create `src/plugins/manifest.ts`: types and `parseManifest`.
- Create `src/plugins/registry.ts`: `PluginRegistry` (list, enabled state, resolveFile, watcher).
- Create `src/plugins/template.ts`: the scaffold template.
- Create `src/routes/plugins.ts`: the `/api/plugins` router and the `/plugins/:id/*` asset handler.
- Modify `src/server.ts`: construct the registry (`options.pluginsDir`), mount the asset route, pass the registry to `mountApiRoutes`, start the watcher in `startServer`.
- Modify `src/server-routes.ts`: `plugins` dep, mount the router.
- Test `tests/plugins/manifest.test.ts`, `tests/plugins/registry.test.ts`, `tests/routes/plugins.test.ts`.

Web (`packages/web`):
- Create `src/plugins/registry.ts`: contributions store, `useContributions`, keys.
- Create `src/plugins/sdk.tsx`: `DispatchSdk`, `buildSdk`, `installSdk`, `pluginIcon`.
- Create `src/plugins/host.ts`: `loadPlugins`, `reloadPlugin`, `applyPluginEvent`, safe mode.
- Create `src/plugins/PluginBoundary.tsx`, `src/plugins/PluginView.tsx` (`PluginView`, `Slot`).
- Create `src/components/settings/PluginsSection.tsx`: Settings → Plugins (local list, scaffold, safe mode, promote).
- Create `src/components/mobile/PluginsTab.tsx`: the phone's Plugins tab.
- Modify `src/api/client.ts`, `src/api/types.ts`: plugin API calls and types.
- Modify `src/stores/ui.ts`, `src/components/layout/IconRail.tsx`, `src/App.tsx`, `src/main.tsx`, `src/components/mobile/MobileApp.tsx`, `src/components/settings/sections.tsx`, `SettingsView.tsx`, `MobileSettings.tsx`, `src/components/sidebar/ThreadMenu.tsx`, `src/components/mobile/ProjectMenu.tsx`, `src/components/composer/PillComposer.tsx`, `src/components/tabs/chat/ChatView.tsx`, `src/components/endless/EndlessColumn.tsx`, `src/components/tabs/TerminalTab.tsx`, `vite.config.ts`.
- Tests beside each file.

Docs: `docs/plugins.md` (how to write a plugin in this slice), `docs/plugins/examples/composer-favourites/` and `docs/plugins/examples/daily-rundown/` (from the spike's `docs/spike-plugins`, adjusted to the SDK of this slice).

---

### Task 1: Manifest parsing (core)

**Files:**
- Create: `packages/core/src/plugins/manifest.ts`
- Test: `packages/core/tests/plugins/manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  export interface PluginContributes { views?: { id: string; label: string; icon?: string }[]; settings?: { id: string; label: string }[]; menus?: { thread?: string[]; project?: string[] }; slots?: string[]; tools?: string[] }
  export interface PluginManifest { id: string; name: string; version: string; description?: string; author?: string; dispatch?: string; sdk?: number; web?: string; contributes?: PluginContributes; permissions?: string[] }
  export type ParsedManifest = { ok: true; manifest: PluginManifest } | { ok: false; error: string };
  export function parseManifest(raw: string, folderId: string): ParsedManifest;
  export function satisfiesDispatch(range: string | undefined, running: string): boolean; // supports ">=X.Y" and ">=X.Y.Z"; undefined → true
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { parseManifest, satisfiesDispatch, PLUGIN_ID_RE } from '../../src/plugins/manifest.js';

describe('parseManifest', () => {
  const good = JSON.stringify({ id: 'daily-rundown', name: 'Daily rundown', version: '0.1.0', web: 'web.js', permissions: ['read:threads'] });
  it('accepts a minimal manifest', () => {
    expect(parseManifest(good, 'daily-rundown')).toEqual({ ok: true, manifest: expect.objectContaining({ id: 'daily-rundown', web: 'web.js' }) });
  });
  it('refuses invalid JSON with the parse error', () => {
    const r = parseManifest('{ nope', 'x');
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/JSON/);
  });
  it('refuses an id that does not match the folder', () => {
    const r = parseManifest(good, 'other');
    expect(r).toEqual({ ok: false, error: 'plugin.json id "daily-rundown" does not match the folder "other"' });
  });
  it('refuses a missing name or version, and a web path that leaves the folder', () => {
    expect(parseManifest(JSON.stringify({ id: 'a', version: '1' }), 'a').ok).toBe(false);
    expect(parseManifest(JSON.stringify({ id: 'a', name: 'A' }), 'a').ok).toBe(false);
    expect(parseManifest(JSON.stringify({ id: 'a', name: 'A', version: '1', web: '../x.js' }), 'a')).toEqual({ ok: false, error: 'plugin.json "web" must be a file inside the plugin folder' });
  });
  it('PLUGIN_ID_RE: lowercase, digits, dashes, up to 64', () => {
    expect(PLUGIN_ID_RE.test('a-1')).toBe(true); expect(PLUGIN_ID_RE.test('-a')).toBe(false); expect(PLUGIN_ID_RE.test('A')).toBe(false); expect(PLUGIN_ID_RE.test('a'.repeat(65))).toBe(false);
  });
});
describe('satisfiesDispatch', () => {
  it('compares the running version against a >= range', () => {
    expect(satisfiesDispatch('>=3.28', '3.28.0')).toBe(true);
    expect(satisfiesDispatch('>=3.28', '3.27.9')).toBe(false);
    expect(satisfiesDispatch('>=3.28.1', '3.28.0')).toBe(false);
    expect(satisfiesDispatch(undefined, '1.0.0')).toBe(true);
    expect(satisfiesDispatch('nonsense', '1.0.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/core && npx vitest run tests/plugins/manifest.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `manifest.ts`** with the interfaces above. `parseManifest` checks, in order: JSON parse (error `plugin.json is not valid JSON: <message>`), `id === folderId`, `name` and `version` are non-empty strings, `web` (if present) is a string whose `path.posix.normalize` does not start with `..` or `/`. `satisfiesDispatch` parses `>=` + 2 or 3 numbers; anything else returns false.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git add packages/core/src/plugins/manifest.ts packages/core/tests/plugins/manifest.test.ts && git commit -m "feat(core): plugin manifest parsing"`.

### Task 2: PluginRegistry, routes and server wiring (core)

**Files:**
- Create: `packages/core/src/plugins/registry.ts`, `packages/core/src/plugins/template.ts`, `packages/core/src/routes/plugins.ts`
- Modify: `packages/core/src/server.ts` (createApp options, registry construction after `dispatchDir`, asset route before the web-build block, `plugins` in the `mountApiRoutes` call; `startServer`: `plugins.start()` and `plugins.stop()` on shutdown), `packages/core/src/server-routes.ts` (`plugins: PluginRegistry` dep; `app.use('/api', createPluginsRouter(d.plugins))`)
- Test: `packages/core/tests/plugins/registry.test.ts`, `packages/core/tests/routes/plugins.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // registry.ts
  export interface PluginRow extends Partial<PluginManifest> { id: string; name: string; version: string; enabled: boolean; stamp: number; error?: string; install?: { marketplace: string; version: string; sha256: string; installedAt: string } | null }
  export class PluginRegistry {
    constructor(dir: string, broadcaster: EventBroadcaster, runningVersion: string);
    readonly dir: string;
    list(): PluginRow[];                       // sorted by id; broken rows have `error` and enabled=false
    get(id: string): PluginRow | undefined;
    setEnabled(id: string, enabled: boolean): PluginRow;   // persists to <dir>/../plugins.json as { disabled: string[] }; throws 'unknown plugin' 
    resolveFile(id: string, requested: string): string | null;  // null when disabled, unknown, escaping, or not a regular file
    scaffold(id: string, name: string): PluginRow;        // writes template; throws 'bad id' | 'exists'
    remove(id: string): void;                             // local plugins only: throws 'not local' when install != null; deletes the folder
    announce(id: string): void;                           // broadcast plugin:changed now (reload)
    start(): void; stop(): void;                          // fs.watch recursive, 150 ms debounce → broadcast { type: 'plugin:changed', id, plugin: PluginRow | null }
  }
  // template.ts
  export function pluginTemplate(id: string, name: string): { 'plugin.json': string; 'web.js': string; 'README.md': string };
  // routes/plugins.ts
  export function createPluginsRouter(plugins: PluginRegistry): Router;   // GET /plugins (owner or any key), POST /plugins/scaffold {id,name} (ownerOnlyStrict), POST /plugins/:id/enable|disable|reload (ownerOnlyStrict), DELETE /plugins/:id (ownerOnlyStrict)
  export function pluginAssetHandler(plugins: PluginRegistry): RequestHandler[]; // GET /plugins/:id/*
  ```
- `stamp` = max mtime (ms, rounded) of the folder, `plugin.json` and the `web` file. A row's `dispatch` range that the running version does not satisfy sets `error: 'needs Dispatch <range>; this is <running>'`.
- The asset handler: 404 JSON `{ error: 'plugin file not found' }` when `resolveFile` is null; `Cache-Control: no-cache`; for `.html`/`.htm` files, `setFileHeaders(res, 'text/html', HTML_SANDBOX_CSP)` (from `http/active-content.ts` and `routes/previews.ts`); otherwise `res.sendFile`.
- `createApp` gains `pluginsDir?: string` (default `path.join(dispatchDir, 'plugins')`) and `runningVersion` comes from `getRunningVersion()` (`update/version.ts`).

- [ ] **Step 1: Write the failing registry tests** (`tests/plugins/registry.test.ts`, a temp dir per test; a recording broadcaster `{ broadcast: (e) => events.push(e) }`):

```ts
it('lists manifests sorted by id, with a stamp, enabled by default', ...)      // two folders → ids ['a-two','b-one'] sorted; stamp > 0; enabled true
it('a folder with invalid JSON lists as broken', ...)                            // error matches /JSON/, enabled false, name = id, version '0.0.0'
it('a folder with an id mismatch lists as broken with the reason', ...)
it('a manifest needing a newer Dispatch lists as broken', ...)                   // dispatch '>=99.0', running '3.28.0'
it('ignores folders whose name is not a valid id and non-folders', ...)          // 'Bad Name', 'x.txt'
it('setEnabled persists across a new registry over the same dir', ...)           // disabled → new PluginRegistry(...).get(id).enabled === false
it('resolveFile confines to the real folder and refuses disabled plugins', ...)  // '../../secret' → null; 'web.js' → abs path; after setEnabled(false) → null; a symlinked plugin folder resolves inside its target
it('scaffold writes plugin.json, web.js and README.md and refuses an existing id or a bad id', ...)
it('remove deletes a local plugin and refuses one with an install record', ...) // write .dispatch-install.json → throws 'not local'
it('start() broadcasts plugin:changed once per burst of writes, with the row, and null for a removed folder', ...) // fake timers or a 300 ms wait; write web.js twice quickly → one event with plugin.id; rm folder → event with plugin null
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `registry.ts` and `template.ts`.** The template's `web.js` is the composer-favourites-style minimal plugin: `export default function activate(d) { d.register('<id>', { views: [{ id: 'home', label: '<name>', icon: 'puzzle', Component: () => d.h('div', { style: { padding: 24 } }, 'Hello from <name>') }] }); }`; `README.md` explains the SDK in ten lines and links `docs/plugins.md`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Write the failing route tests** (`tests/routes/plugins.test.ts`, `createApp({ db, skipPty: true, pluginsDir: tmp, managers })` as in `tests/routes/previews.test.ts`; owner calls use no header the way `GET /api/previews` is called there; a thread key via `app.locals.keys.mint`):

```ts
it('GET /api/plugins lists rows for the owner and for a thread key', ...)          // 200, body.plugins[0].id
it('serves an enabled plugin file with no-cache; a disabled plugin\'s files are 404', ...)
it('an html file from a plugin carries the sandbox CSP', ...)                      // Content-Security-Policy includes HTML_SANDBOX_CSP
it('a path that escapes the folder is 404 even with --path-as-is encoding', ...)   // request '/plugins/a/%2e%2e/%2e%2e/secret' → 404
it('scaffold, enable, disable, reload and remove are owner-only; a thread key gets 403', ...)
it('POST /api/plugins/scaffold creates the folder and returns the row; a second call is 409', ...)
it('POST /api/plugins/:id/reload broadcasts plugin:changed', ...)                   // router alone with a recording broadcaster, as previews.test does
```

- [ ] **Step 6: Run to verify it fails.**
- [ ] **Step 7: Implement `routes/plugins.ts` and wire `server.ts` / `server-routes.ts`.** The reload route calls `plugins.announce(id)`. Error mapping: 'unknown plugin' → 404, 'exists' → 409, 'bad id' → 400, 'not local' → 400.
- [ ] **Step 8: Run both test files, then `npx tsc --noEmit -p .`** → PASS, no errors.
- [ ] **Step 9: Commit** — `git commit -m "feat(core): plugin registry, routes and file serving"`.

### Task 3: Contributions store (web)

**Files:**
- Create: `packages/web/src/plugins/registry.ts`
- Test: `packages/web/src/plugins/registry.test.ts`

**Interfaces:**
- Produces (the spike's shapes, plus manifests, promoted tabs and memoised hooks):
  ```ts
  export interface PluginRow { id: string; name: string; version: string; description?: string; web?: string; enabled: boolean; stamp: number; error?: string; install?: {...} | null; contributes?: ...; permissions?: string[] }
  export interface PluginView { plugin: string; id: string; key: string; label: string; icon?: string; Component: ComponentType }
  export interface PluginSettingsSection { plugin: string; id: string; key: string; label: string; blurb?: string; icon?: string; Component: ComponentType<{ onDone?: () => void }> }
  export interface ThreadMenuCtx { tab: Terminal } export interface ProjectMenuCtx { session: Session }
  export interface PluginMenuItem<C> { plugin: string; id: string; label: string; when?: (ctx: C) => boolean; onPick: (ctx: C) => void }
  export interface ComposerCtx { surface: 'thread' | 'terminal' | 'chat' | 'unknown'; terminalId?: string; sessionId?: string; value: string; insert: (t: string) => void; set: (t: string) => void; send?: (t: string) => void }
  export interface PluginComposerAction { plugin: string; id: string; label: string; icon?: string; when?: (ctx: ComposerCtx) => boolean; onClick: (ctx: ComposerCtx) => void }
  export interface PluginSlotContent { plugin: string; id: string; slot: string; Component: ComponentType<Record<string, unknown>> }
  export type PluginStatus = { state: 'loading' | 'ready' | 'error'; error?: string; version?: string; at: number };
  export interface Contributions { views?: ...; settings?: ...; threadMenu?: ...; projectMenu?: ...; composerActions?: ...; slots?: ... }  // each without `plugin`/`key`
  export const usePluginRegistry: zustand store { manifests, status, views, settings, threadMenu, projectMenu, composerActions, slots, promoted: string[] /* view keys, max 2 */, setManifests, setStatus, register, unregister, setPromoted }
  export const viewKey = (plugin, id) => `plugin:${plugin}:${id}`; export const isPluginView = (key: string) => key.startsWith('plugin:');
  export function useContributions<K extends 'views'|'settings'|'threadMenu'|'projectMenu'|'composerActions'|'slots'>(kind: K, filter?: (x) => boolean): ...[]   // memoised by list identity and filter identity
  export function usePluginViews(): PluginView[]; export function usePromotedViews(): PluginView[]  // promoted, in order, that exist
  ```
- `promoted` is read from and saved to `localStorage['dispatch:plugins:promoted']` (JSON array of view keys).

- [ ] **Step 1: Write the failing tests**

```ts
it('register adds every kind under the plugin and derives keys', ...)        // viewKey 'plugin:p:v'; settings key 'plugin:p:s'
it('register again replaces that plugin\'s contributions only', ...)         // two plugins; re-register p1 with one view → p2 untouched
it('unregister drops all of one plugin', ...)
it('useContributions returns the same array for the same state (no new array per render)', ...)  // renderHook twice → Object.is true
it('promoted keeps at most two keys and persists to localStorage', ...)
it('usePromotedViews drops a promoted key whose view is gone', ...)
```

- [ ] **Step 2: Run to verify it fails.** — `cd packages/web && npx vitest run src/plugins/registry.test.ts`
- [ ] **Step 3: Implement.** `useContributions` selects the list by kind with `usePluginRegistry((s) => s[kind])` and `useMemo` for the filter.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): plugin contributions store"`.

### Task 4: PluginBoundary, PluginView and Slot (web)

**Files:**
- Create: `packages/web/src/plugins/PluginBoundary.tsx`, `packages/web/src/plugins/PluginView.tsx`
- Test: `packages/web/src/plugins/PluginView.test.tsx`

**Interfaces:**
- Consumes: Task 3.
- Produces: `PluginBoundary({ plugin, resetKey?, children })` (class component; shows a `role="alert"` card "The plugin "<name>" failed" with the message; resets when `resetKey` changes); `PluginView({ viewKey })` (renders the view's Component in a boundary with `data-testid="plugin-view"`, or the line "This plugin screen is not loaded." when unknown); `Slot({ name, ...props })` (renders every slot content for `name`, each in a boundary, null when none).

- [ ] **Step 1: Write the failing tests**

```ts
it('PluginView renders the view, and a throw shows the plugin\'s name in an alert, not a blank', ...)
it('PluginView for an unknown key says the screen is not loaded', ...)
it('a boundary resets when the plugin reloads (resetKey changes)', ...)
it('Slot renders every content for its name and nothing for another', ...)
it('one slot content throwing leaves the others rendered', ...)
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (the spike's files).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): plugin view, slot and error boundary"`.

### Task 5: SDK and host (web)

**Files:**
- Create: `packages/web/src/plugins/sdk.tsx`, `packages/web/src/plugins/host.ts`
- Modify: `packages/web/src/api/types.ts` (PluginRow), `packages/web/src/api/client.ts` (`listPlugins`, `scaffoldPlugin(id, name)`, `enablePlugin(id)`, `disablePlugin(id)`, `reloadPlugin(id)`, `removePlugin(id)`), `packages/web/src/main.tsx` (`void loadPlugins()` after the render), `packages/web/src/App.tsx` (`applyPluginEvent(e)` in the event fan-out), `packages/web/vite.config.ts` (`/plugins` proxy)
- Test: `packages/web/src/plugins/host.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4.
- Produces:
  ```ts
  // sdk.tsx
  export interface DispatchSdk { version: string; React; h; Fragment; hooks: { useState, useEffect, useMemo, useCallback, useRef, useIsMobile, useContributions, useStore: <S, T>(store: UseBoundStore<StoreApi<S>>, selector: (s: S) => T) => T }; zustand: { create }; stores: { useUI, useProjects, useTabs, usePreviews, useUpdate, useThreadStatus }; actions: { setView(key: string), openThread(terminalId: string), openSettings(sectionKey: string) }; api; ui: { Modal, Markdown, FileViewer, Toggle, styles: {...} }; icons: Record<string, Icon>; storage: { get, set, remove, list }; hint(msg); copyText(text): Promise<void>; register; unregister }
  export function buildSdk(): DispatchSdk; export function installSdk(): DispatchSdk; export const pluginIcon: (name?: string) => Icon;
  // host.ts
  export function isSafeMode(): boolean;            // '?safe' in location.search or localStorage['dispatch:plugins:safe'] === '1'
  export async function loadPlugins(importer?: (url: string) => Promise<unknown>): Promise<void>;   // fetch /api/plugins, setManifests, load each enabled row with `web`; errors per plugin → status error
  export async function reloadPlugin(row: PluginRow, importer?): Promise<void>;
  export function applyPluginEvent(e: ServerEvent): void;  // 'plugin:changed': null → unregister + drop manifest; row → setManifests merge + reloadPlugin (skipped when disabled: unregister)
  ```
- `storage` keys: `dispatch:plugin:<id>:<key>` in localStorage (slice 2 moves it to the daemon).
- The importer defaults to `(url) => import(/* @vite-ignore */ url)`; tests pass a fake.
- `openThread` = `useTabs.getState().open(terminalId)` or the existing helper the sidebar uses (find `openThread` in `components/endless/openThread.ts`); `openSettings` = `useUI.getState().requestSettings(key)`.

- [ ] **Step 1: Write the failing tests** (mock `fetch` for `/api/plugins`; a fake importer that returns `{ default: (sdk) => sdk.register(...) }`):

```ts
it('loadPlugins imports each enabled bundle with ?v=<stamp> and marks it ready', ...)
it('a disabled row and a broken row are not imported; the broken one\'s error is its status', ...)
it('one plugin\'s throw does not block the next', ...)      // importer throws for p1, p2 loads; status p1 error, p2 ready; p1 has no contributions
it('safe mode loads nothing', ...)                            // localStorage flag
it('applyPluginEvent reloads a changed plugin with the new stamp and unregisters a removed one', ...)
it('installSdk puts one object on window.dispatch and keeps it across calls', ...)
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `sdk.tsx` and `host.ts` (from the spike, with the interface above), the API client methods, the `main.tsx` call, the App fan-out line, the Vite proxy.
- [ ] **Step 4: Run to verify it passes; `npx tsc --noEmit -p .`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): plugin SDK and host with hot reload"`.

### Task 6: Views in the rail, App and the phone (web)

**Files:**
- Modify: `packages/web/src/stores/ui.ts` (`View` union adds `` `plugin:${string}` ``; `loadView` accepts `plugin:*`), `packages/web/src/components/layout/IconRail.tsx` (plugin views after NAV), `packages/web/src/App.tsx` (`isPluginView(view) ? <PluginView viewKey={view} />`), `packages/web/src/components/mobile/MobileApp.tsx` (`bottomTab` union adds `'plugins'` and `` `plugin:${string}` ``; a fixed Plugins tab between Analytics and Settings when any plugin view exists; promoted views get tabs before it; the level-0 screen for `'plugins'` is `<PluginsTab onOpen={(key) => setBottomTab(key)} />` and for `plugin:*` is `<PluginView />`)
- Create: `packages/web/src/components/mobile/PluginsTab.tsx` (a list of plugin views: icon, label, the plugin's name; "No plugin screens yet. Settings → Plugins." when empty)
- Test: `packages/web/src/components/layout/IconRail.plugins.test.tsx`, `packages/web/src/components/mobile/MobileApp.plugins.test.tsx`, `packages/web/src/stores/ui.test.ts` (add a case)

- [ ] **Step 1: Write the failing tests**

```ts
// IconRail
it('a registered plugin view is a rail item after Previews; clicking sets the view to its key', ...)
// ui store
it('a saved view for an unloaded plugin falls back to workspace', ...)   // loadView returns 'plugin:x:y' (accepted) — then App renders PluginView "not loaded"; the test asserts loadView accepts it and App shows the not-loaded line, or (simpler) loadView('plugin:…') is accepted and PluginView shows the fallback text
// MobileApp
it('with no plugin views the tab bar has four tabs', ...)
it('with a plugin view the Plugins tab appears and lists it; tapping opens the view', ...)
it('a promoted view gets its own tab before Plugins; at most two', ...)
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (the spike's edits, plus the fixed Plugins tab and `PluginsTab.tsx`). The tab icon for Plugins is `PuzzlePiece`.
- [ ] **Step 4: Run the three test files and the full `MobileApp.test.tsx`; `npx tsc --noEmit -p .`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): plugin screens in the rail and on the phone"`.

### Task 7: Settings sections from plugins (web)

**Files:**
- Modify: `packages/web/src/components/settings/sections.tsx` (`SettingsGroup` adds `'PLUGINS'`; `SettingsSection.key: string`; `settingsSection(key)` also finds plugin sections; `useAllSettingsSections()`, `useSettingsGroups()`), `SettingsView.tsx`, `MobileSettings.tsx`, `MobileApp.tsx` (`settingsKey: string`)
- Test: `packages/web/src/components/settings/SettingsView.test.tsx` (add), `MobileSettings.test.tsx` (add)

- [ ] **Step 1: Write the failing tests**

```ts
it('a plugin settings section shows under PLUGINS on desktop and opens; the group is absent with no plugin', ...)
it('the phone list shows the PLUGINS group and drills into the plugin section', ...)
it('a plugin section that throws shows the boundary card inside Settings', ...)
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (the spike's edits; plugin sections wrapped in `PluginBoundary`, cached per section object).
- [ ] **Step 4: Run; `npx tsc --noEmit -p .`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): plugin settings sections"`.

### Task 8: Menu items and composer actions (web)

**Files:**
- Modify: `packages/web/src/components/sidebar/ThreadMenu.tsx` (plugin items after Copy thread ID, `when` honoured), `packages/web/src/components/mobile/ProjectMenu.tsx` (plugin items after Previews), `packages/web/src/components/composer/PillComposer.tsx` (`pluginContext?: { surface; terminalId?; sessionId? }`; the actions row above the pill, `data-testid="composer-plugin-actions"`; `send` provided when the caller passes `onSendText`), `ChatView.tsx` (`surface: 'thread'`), `EndlessColumn.tsx` (`surface: 'chat'`), `TerminalTab.tsx` (`surface: 'terminal'`)
- Test: `ThreadMenu.plugins.test.tsx`, `ProjectMenu.test.tsx` (add), `PillComposer.test.tsx` (add)

- [ ] **Step 1: Write the failing tests**

```ts
it('a plugin thread-menu item shows for a thread, honours `when`, and calls onPick with the tab', ...)
it('a plugin project-menu item shows in the phone project menu with the session', ...)
it('composer actions render as a row; insert appends with a space, set replaces; `when` hides', ...)
it('the row is absent with no actions', ...)
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; `npx tsc --noEmit -p .`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): plugin menu items and composer actions"`.

### Task 9: Settings → Plugins page (web)

**Files:**
- Create: `packages/web/src/components/settings/PluginsSection.tsx`
- Modify: `packages/web/src/components/settings/sections.tsx` (a built-in `plugins` section in THIS MAC: label "Plugins", blurb "Local plugins, safe mode", icon `PuzzlePiece`)
- Test: `packages/web/src/components/settings/PluginsSection.test.tsx`

**Interfaces:**
- Consumes: Tasks 3, 5 (`api.listPlugins` etc., `usePluginRegistry.manifests/status/promoted`, `reloadPlugin`).
- The page: a LOCAL list (one row per manifest without `install`: name, version, state chip — Ready / Loading / Error with the message / Disabled; buttons Reload, Disable/Enable, Remove (confirm with `ConfirmModal`), Copy path (`~/.dispatch/plugins/<id>`), and "Promote to a tab" / "Unpromote" for each of its views); a "New plugin…" form (id, name) calling `api.scaffoldPlugin`; a SAFE MODE row with a `Toggle` that sets the localStorage flag and says "Reload the app to apply"; an empty state: "No plugins yet. New plugin… writes a starter folder you or a thread can edit; it shows up here as it is saved."

- [ ] **Step 1: Write the failing tests**

```ts
it('lists local plugins with state, and Enable/Disable calls the API and reloads the list', ...)
it('New plugin scaffolds and the new row appears', ...)
it('Remove asks first, then calls the API', ...)
it('a broken plugin shows its error', ...)
it('Promote to a tab stores the view key, at most two', ...)
it('the safe-mode switch writes the flag and says to reload', ...)
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; `npx tsc --noEmit -p .`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): Settings → Plugins"`.

### Task 10: Examples, docs and the end-to-end check

**Files:**
- Create: `docs/plugins.md` (writing a plugin: the folder, the manifest, `activate(d)`, `register`, the slots this slice has, hot reload, safe mode, `h()` vs JSX), `docs/plugins/examples/daily-rundown/{plugin.json,web.js}`, `docs/plugins/examples/composer-favourites/{plugin.json,web.js}` (from the spike's `docs/spike-plugins`, using `d.hooks.useContributions` where a list is filtered)
- Modify: `README.md` (one line under features linking `docs/plugins.md`)

- [ ] **Step 1: Copy the examples and adjust them to the SDK of Task 5.**
- [ ] **Step 2: Run the full suites** — `cd packages/web && npx vitest run` and `cd packages/core && env -u DISPATCH_API -u DISPATCH_AUTH -u DISPATCH_SESSION -u DISPATCH_TERMINAL npx vitest run`, output to a file; expected: all pass except the two pre-existing `files.test.ts` cases.
- [ ] **Step 3: End-to-end on an isolated daemon** (verify skill): fake HOME with the two examples under `.dispatch/plugins`, `pnpm build`, daemon on a free port with `DISPATCH_WEB_DIST`, open it in the browser: the Rundown rail item, the Plugins tab on a phone viewport, the PLUGINS settings group, the composer row, the thread-menu item, a hot reload after editing `web.js`, and `?safe` loading nothing. Save screenshots under `.dispatch/inbox/`.
- [ ] **Step 4: Commit** — `git commit -m "docs: writing a plugin; example plugins"`.
