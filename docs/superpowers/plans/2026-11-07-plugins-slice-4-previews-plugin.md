# Plugins slice 4: Previews as a bundled plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Previews becomes the bundled plugin `previews`: its `preview` tool runs in the plugin's MCP server, its documents live in plugin storage with checked file references served by a generic daemon route, and its screens (the desktop history, the phone sheet, the badges, the menu items) are the plugin's web part. The core loses the previews table reads, routes, store and components. Every promise of the previews spec still holds.

**Architecture:** The daemon gains a generic checked-file service for plugins (`plugin_files`): a thread registers a file of its own project (the previews checks: inside the real root, a known type, a regular file, size cap) and gets a `fileId`; the daemon serves it with the same sandbox headers as today, re-checked at serve time. The web gains three mounted slots (`thread.header.actions`, `project.header.actions`, `app.overlay`) and view badges. The plugin's MCP server is a small standalone stdio JSON-RPC server. A one-time migration copies old `previews` rows into plugin documents and file references.

**Tech Stack:** as before.

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` sections 5 (file references), 10, 2.3 (slots); `docs/superpowers/specs/2026-10-28-previews-design.md` (the promises).

## Global Constraints

- The previews spec's promises hold: one tool with files and/or text; images in the viewer, markdown/text in place, pdf/html framed with Open; badges and menus on the phone; the desktop history; no arbitrary file read; HTML sandboxed; a thread posts into its own project only.
- `post_image` keeps returning its inline image block; its best-effort preview copy goes through the plugin's storage.
- A file reference is checked when registered and again when served; the path must stay inside the project's current real root; only `PREVIEW_MIME` types; 50 MB per file; 20 files per preview; 64 KB of text.
- No `preview:*` events remain; the plugin's web part reacts to `plugin:data`.
- Old installs: the migration runs once at boot, copies every row, and marks itself done in the plugin's settings; the old table stays (dropped in a later release).

## Review Focus

1. A preview posted by thread A must not be readable by thread B of another project through the file route (Task 1 test "a file reference is served to the owner only; a thread key gets 403").
2. A file whose project folder moved since the post must 404 at serve time, not leak (Task 1 test "serve re-checks the real root").
3. After the migration an old preview's files must still open in the viewer (Task 4 test "migrated rows carry file ids that serve").
4. With the plugin disabled the preview tool must fail with a plain message and the thread must keep working (Task 5 e2e).
5. The unseen badge must clear when the sheet closes, as before (Task 3 web.js; Task 5 e2e).

---

### Task 1: Plugin file references (core)

**Files:**
- Modify: `packages/core/src/db/schema.ts` (migration `'020-plugin-files'`: `plugin_files(plugin_id, file_id PRIMARY KEY, session_id, path, name, mime, size, created_at)`), `packages/core/src/db/plugin-data.ts` (`addFile(db, pluginId, sessionId, file): fileId`, `getFile(db, pluginId, fileId)`, `removeFile`, `clearPlugin` also clears files), `packages/core/src/http/active-content.ts` (`HTML_SANDBOX_CSP` moves here; `routes/previews.ts` re-exports until Task 4 deletes it), `packages/core/src/plugins/files.ts` (new: `PREVIEW_MIME`, limits and `checkProjectFile(workingDir, requested)` moved from `routes/previews.ts`), `packages/core/src/routes/plugins.ts` (`POST /plugins/:id/files { path, sessionId? }`: a thread key with `threads:write-storage` registers a file of its own project; the owner passes `sessionId`; answers `{ fileId, name, mime, size }`; `GET /plugins/:id/files/:fileId`: owner only (like the old route), re-checks the real root and serves with `setFileHeaders`; `DELETE /plugins/:id/files/:fileId`: owner or the plugin key)
- Test: `packages/core/tests/routes/plugins-files.test.ts`

- [ ] Tests: 'a thread registers a file of its project and the owner opens it with the right type and sandbox header'; 'a path outside the project, an unknown type, a missing file and an oversize file are refused with the previews messages'; 'a file reference is served to the owner only; a thread key gets 403'; 'serve re-checks the real root (a swapped folder 404s)'; 'remove clears a plugin's files'.
- [ ] Implement; add the routes to the completeness list; commit `feat(core): checked file references for plugins`.

### Task 2: Slots, badges and the overlay (web)

**Files:**
- Modify: `packages/web/src/plugins/registry.ts` (`badges: Record<string, number>`, `setBadge(viewKey, n)`, `useViewBadge(key)`), `packages/web/src/plugins/sdk.tsx` (`actions.setBadge`, `actions.openView(key)`), `packages/web/src/components/layout/IconRail.tsx` (plugin rail items show their badge), `packages/web/src/components/mobile/MobileApp.tsx` (`<Slot name="thread.header.actions" terminal={leafTab} />` before the thread ⋯; `<Slot name="project.header.actions" session={project} />` before the project ⋯; `<Slot name="app.overlay" />` at the root; the Plugins tab shows a dot when any plugin view has a badge), `packages/web/src/App.tsx` (`<Slot name="app.overlay" />`), `packages/web/src/components/tabs/TabHost.tsx` or the desktop thread header (`thread.header.actions`)
- Test: `MobileApp.plugins.test.tsx` (add: the three slots render plugin content with their props; a badge shows on the promoted tab and dots the Plugins tab), `IconRail.plugins.test.tsx` (add: a badge on a plugin item).

- [ ] Tests, implement, commit `feat(web): header and overlay slots, view badges`.

### Task 3: The bundled previews plugin

**Files:**
- Create: `packages/plugins/previews/plugin.json` (permissions `threads:write-storage`, `threads:read-storage`; `model.mcp` → `mcp/server.js`, `model.instructions` → `instructions.md`; contributes the view `history`, project and thread menu items, the three slots), `instructions.md` (the `preview` tool, when to use it: what the old TOOLS description said), `mcp/server.js` (a standalone stdio JSON-RPC MCP server, protocol 2024-11-05, one tool `preview { paths?, text?, title?, note? }`: resolves paths against cwd, `POST /api/plugins/previews/files` per path with the thread key (`DISPATCH_AUTH` or `DISPATCH_AUTH_FILE`), then `PUT /api/plugins/previews/data/preview:<id>` with `{ id, sessionId, sessionName?, terminalId, terminalLabel?, title, note, text, files: [{ fileId, name, mime, size }], createdAt, seenAt: null }` — the session and thread names come from `GET /api/whoami` and `GET /api/terminals/<id>`; answers `{ ok, id, files }` or a plain error), `web.js` (a store over the `preview:*` documents loaded from `storage.list` + `get`, refreshed on `plugin:data`; `history` view = the old PreviewsView; the sheet = the old PreviewSheet rendered in `app.overlay` from `useStore` state; `PreviewItem` ported to `h()` with `ui.FileViewer` for files (`src = /api/plugins/previews/files/<fileId>`, `loadText` via `d.fetch`); badges: `setBadge('plugin:previews:history', unseenAll)`; `project.header.actions` and `thread.header.actions` render an eye button with the project's unseen count that opens the sheet; `projectMenu` and `threadMenu` items "Previews"; mark seen on sheet close and on leaving the history (`seenAt` written into the document)), `README.md`, `CHANGELOG.md`
- Test: `packages/plugins/previews/mcp/server.test.ts`? No test runner there; instead `packages/core/tests/plugins/previews-mcp.test.ts` spawns `mcp/server.js` against a `createApp` daemon on a port and calls `tools/list` and `tools/call preview` over stdio.

- [ ] Test, write, commit `feat(plugins): the Previews plugin (bundled)`.

### Task 4: Migration and removal

**Files:**
- Modify: `packages/core/src/db/schema.ts` (no drop), `packages/core/src/plugins/previews-migration.ts` (new: at boot, if the previews plugin's settings lack `migrated`, copy every `previews` row into `preview:<id>` documents and `plugin_files` rows, then set `migrated: true`), `packages/core/src/server.ts` (run it after the registry), `packages/core/src/overseer/agency-mcp.ts` (remove the `preview` tool and handler; `postImageToPreviews` posts through the plugin routes), `packages/core/src/roles/role-policy.ts` (remove `preview` from the list), `packages/core/src/server-routes.ts` (unmount the previews router), delete `packages/core/src/routes/previews.ts`, `packages/core/src/db/previews.ts` and their tests; `packages/web`: delete `stores/previews.ts`, `components/previews/*` and their tests; remove from `App.tsx`, `IconRail.tsx`, `MobileApp.tsx`, `ProjectMenu.tsx`, `ui.ts` (`'previews'` leaves the `View` union; `loadView` maps a saved `'previews'` to `'plugin:previews:history'`), `api/client.ts`, `api/types.ts`, `plugins/sdk.tsx` (`usePreviews` leaves `stores`), `PluginsSection.tsx` (`read:previews` label leaves); docs: `docs/plugins.md` notes Previews is a plugin; the previews spec gets a status line.
- Test: `packages/core/tests/plugins/previews-migration.test.ts` ('migrated rows carry file ids that serve'; 'runs once'); the completeness list; the agency MCP tests lose the `preview` cases.

- [ ] Tests, implement, commit `refactor: Previews moves into its plugin; old routes, store and components removed`.

### Task 5: Suites, docs and end-to-end

- [ ] Full suites.
- [ ] E2E on an isolated daemon: run `packages/plugins/previews/mcp/server.js` with a thread's key against the daemon, call `preview` with a png and a markdown file in the project; in the browser (phone and desktop) see the badge, the sheet, the history, open the files in the viewer, see the badge clear; disable the plugin and call the tool again: a plain error, the thread's other tools unaffected.
