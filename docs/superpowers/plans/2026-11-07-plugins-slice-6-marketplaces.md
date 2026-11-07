# Plugins slice 6: marketplaces, updates, skills, commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A marketplace is a git repository the daemon clones; the owner adds one by URL, browses its plugins and skills, installs, gets "update available" in the Settings dot and banner, updates, rolls back, pins; skills install the same way and reach every thread's prompt; plugins contribute commands to a palette; two read-only agent tools list plugins and skills.

**Architecture:** `MarketplaceService` (core) keeps one clone per marketplace under `<dataDir>/marketplaces/<slug>` with `marketplaces.json` beside it, pulls on the updater's schedule (45 min) and on "Check now", reads the catalog from the clone's HEAD (`plugins/<id>/plugin.json`, `skills/<id>/skill.json`, each `CHANGELOG.md`), and resolves versions through `git log -- plugins/<id>/plugin.json`. `PluginInstaller` copies a folder into `<dataDir>/plugins/<id>` with `.dispatch-install.json` (`marketplace`, `version`, `commit`, `installedAt`), updates by staging + swap (`<id>.prev` kept), rolls back by swapping back, pins and auto-updates per plugin in the registry's state file. `SkillsService` lists local and installed skills under `<dataDir>/skills/<id>` (`skill.json` + `SKILL.md`), enabled per project, and hands their texts to the spawn path next to plugin instructions. The web gets Marketplaces + Browse on the Plugins page, Installed-row actions, a Skills section, plugin updates in the existing update dot/banner, and a ⌘K command palette fed by the `commands` contribution.

**Tech Stack:** as before; git through `docs/git.ts`'s async helpers (no new dependency).

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` sections 7 (7.1, 7.2), 8, 9 (read-only tools only — ruling), 2 (`commands`, the Installed list).

## Global Constraints

- A marketplace URL is https or ssh (or `file://` / an absolute path for tests and local repos); the daemon runs git with the owner's own credentials and never stores a token; a failed clone shows git's own last line and the sign-in hint.
- The catalog is read from the clone only (never from the network at request time); a pull happens on the 45-minute schedule, on "Check now", and before an install or update.
- A plugin's version is its `plugin.json` version at HEAD; roll back and pin resolve older versions through git history of `plugins/<id>/plugin.json`.
- Install checks `dispatch` (version range) and `sdk` before copying; an installed plugin's id must not collide with a bundled or local one (409 with the reason).
- Update keeps `<id>.prev`; storage and settings are untouched (same id, same tables); `plugin:changed` fires after the swap and `plugin:updated { id, from, to }` once; the worker restarts (the registry's announce → worker sync).
- Auto-update is off per plugin unless the marketplace is marked trusted; a pin stops updates past the pinned version; a plugin without `.dispatch-install.json` (local, bundled) never checks.
- Skills: `SKILL.md` texts go into the thread's system prompt under `## Skill: <name>` with the folder's absolute path; Dispatch never writes into a project; no harness-native skill folders in this slice (ruling).
- The Settings dot and banner show Dispatch's own update first, then plugin updates (each with Update); `updatePending` covers both.
- Agent tools in this slice: `plugin_list` and `skill_list` (read-only). Scaffold, enable, disable, remove through a thread need owner approval, which this slice does not build (ruling: a thread that wants a plugin writes the folder itself; the watcher picks it up).

## Review Focus

1. A marketplace URL that is a shell-sensitive string (`-oProxyCommand=…`, spaces, a `--upload-pack` flag) must never reach git as an option (Task 1 test "a URL that looks like a flag is refused").
2. An update that fails mid-copy must leave the installed plugin as it was (Task 2 test "a failed update keeps the old folder").
3. A skill text that contains prompt-looking text (`## Plugin:`, `Peer tools`) is still just text under its heading, and a skill disabled for a project must not reach that project's threads (Task 4 tests).
4. The banner's plugin Update must not double-fire while one runs (Task 5 test).
5. A marketplace removed while a plugin installed from it stays: the plugin keeps working and shows "marketplace removed" (Task 3 test).

---

### Task 1: MarketplaceService — clone, pull, catalog, versions

**Files:**
- Create: `packages/core/src/plugins/marketplaces.ts` (`MarketplaceService(dir, stateFile, { git?: typeof gitAsync })`: `list(): Marketplace[]` (`{ url, slug, name, description, trusted, addedAt, lastPulledAt, error }`), `add(url): Promise<Marketplace>` (validates the URL: `https://`, `ssh://`, `git@host:path`, `file://` or an absolute path; refuses anything starting with `-`; slug = a safe name from the host and path; `git clone`), `remove(slug)`, `setTrusted(slug, on)`, `pull(slug): Promise<Marketplace>` (`git pull --ff-only`; the error line kept on the row), `pullAll()`, `catalog(): Promise<CatalogEntry[]>` (`{ marketplace, kind: 'plugin' | 'skill', id, name, version, description, dispatch?, sdk?, changelog: string | null, folder }` from every clone's HEAD), `versions(slug, id): Promise<{ version, commit, date }[]>` (newest first, through `git log --format=%H%x09%cI -- plugins/<id>/plugin.json` and `git show <sha>:plugins/<id>/plugin.json`), `folderAt(slug, id, commit?)` (a temp export of `plugins/<id>` at HEAD or at a commit: `git archive <commit> plugins/<id> | tar -x` into a temp folder))
- Test: `packages/core/tests/plugins/marketplaces.test.ts` with a local bare repository fixture (`git init --bare`, a working clone that commits `marketplace.json`, `plugins/hello/plugin.json` v1.0.0 and `CHANGELOG.md`, `skills/tidy/skill.json` + `SKILL.md`; later commits bump hello to 1.1.0)

- [ ] Tests: 'add clones a repository by path and lists it with its name; a second add of the same url is the same row'; 'a URL that looks like a flag, or a relative path, is refused'; 'the catalog lists plugins and skills at HEAD with the changelog'; 'pull brings a new version; versions lists both with their commits'; 'folderAt exports the plugin at a commit'; 'a clone that fails keeps git's last line on the row'.
- [ ] Implement; commit `feat(core): marketplaces are git repositories — clone, pull, catalog, versions`.

### Task 2: PluginInstaller — install, update, roll back, pin, auto-update, the schedule

**Files:**
- Create: `packages/core/src/plugins/installer.ts` (`PluginInstaller(registry, marketplaces, pluginsDir, runningVersion)`: `install(slug, id, version?)` (pull, check `dispatch`/`sdk`, refuse a bundled or local id, copy `folderAt` into `<pluginsDir>/<id>`, write `.dispatch-install.json`, enable, announce), `updates(): Promise<PluginUpdate[]>` (`{ id, name, marketplace, from, to, changelog }` for installed plugins whose catalog version is newer and not past a pin), `update(id)` (stage into `<id>.staging`, move the old folder to `<id>.prev`, move staging into place, write the install file, announce, broadcast `plugin:updated`), `rollback(id)` (swap `.prev` back; 409 when none), `pin(id, version | null)`, `setAutoUpdate(id, on)`, `applyAutoUpdates()`), state in the registry's state file (`pins: Record<id, version>`, `autoUpdate: string[]`)
- Modify: `packages/core/src/plugins/registry.ts` (`PluginInstall` gains `commit`; `readInstall` reads it; rows gain `update?: { to, changelog }`, `pinned?: string`, `autoUpdate?: boolean` through a provider `setUpdatesProvider`), `packages/core/src/server.ts` (construct both services in both builds; `setInterval` 45 min: `pullAll` → `applyAutoUpdates` → broadcast `plugin:updates { updates }` when the list changed; `stop` clears it; run once 20 s after boot)
- Test: `packages/core/tests/plugins/installer.test.ts`

- [ ] Tests: 'install copies the plugin, writes the install file with the commit, and enables it; a bundled or local id is refused; a dispatch range the daemon fails is refused'; 'updates lists a newer version with its changelog; a pin hides it; update swaps the folder, keeps .prev, broadcasts plugin:updated, and the row shows the new version'; 'a failed update keeps the old folder' (a staging copy that throws); 'rollback swaps .prev back and refuses when none'; 'auto-update applies to plugins switched on, and to every plugin of a trusted marketplace'.
- [ ] Implement; commit `feat(core): plugin install, update, roll back, pin, auto-update`.

### Task 3: Routes

**Files:**
- Modify: `packages/core/src/routes/plugins.ts` (owner-only: `GET /plugins/marketplaces`, `POST /plugins/marketplaces { url }`, `DELETE /plugins/marketplaces/:slug`, `POST /plugins/marketplaces/:slug/pull`, `POST /plugins/marketplaces/:slug/trusted { on }`, `GET /plugins/catalog`, `GET /plugins/updates`, `POST /plugins/install { marketplace, id, version? }`, `POST /plugins/:id/update`, `POST /plugins/:id/rollback`, `POST /plugins/:id/pin { version }`, `POST /plugins/:id/auto-update { on }`; `GET /plugins/:id/versions`), the completeness list
- Test: `packages/core/tests/routes/plugins-marketplaces.test.ts` (the bare-repo fixture through `createApp`)

- [ ] Tests: 'add, list, pull, trust and remove a marketplace; a bad URL is 400 with git's line'; 'catalog, install, updates, update, rollback and pin through the routes'; 'a marketplace removed while a plugin installed from it stays: the row says marketplace removed and the plugin still serves'; 'every route is owner-only (a thread key and a plugin key get 403)'.
- [ ] Implement; commit `feat(core): marketplace and install routes`.

### Task 4: Skills

**Files:**
- Create: `packages/core/src/plugins/skills.ts` (`SkillsService(dir, stateFile, marketplaces)`: `list(): SkillRow[]` (`{ id, name, version, description, harnesses, folder, install, enabled, text? }`), `install(slug, id)`, `remove(id)`, `setEnabled(id, on, sessionId?)` (global or per project), `injection(sessionId, harness): string[]` (the `## Skill: <name>` blocks with the folder path, for enabled skills whose `harnesses` include the harness or are unset)), `skill.json` parsing (`id` = folder, `name`, `version`, `description`, `harnesses?`)
- Modify: `packages/core/src/sessions/service.ts` (`setPluginInjection((harness, sessionId) => …)`; `applyPluginInjection` passes the terminal's session), `packages/core/src/server.ts` (prompts = plugin prompts + skill blocks), `packages/core/src/routes/plugins.ts` (`GET /skills?project=`, `POST /skills/install`, `DELETE /skills/:id`, `POST /skills/:id/enable|disable { project? }`), the completeness list
- Test: `packages/core/tests/plugins/skills.test.ts`, `tests/sessions/plugin-injection.test.ts` (add)

- [ ] Tests: 'a local skill folder lists with its text; install copies one from a marketplace; remove deletes it'; 'enabled skills reach a Claude spawn's system prompt under their heading with the folder path; a skill disabled for the project does not; a skill for another harness does not'; 'a skill text with prompt-looking lines is still one block under its heading'.
- [ ] Implement; commit `feat(core): skills — local and installed, per-project, injected into the prompt`.

### Task 5: Web — Marketplaces, Browse, Installed actions, Skills, the banner, the palette

**Files:**
- Modify: `packages/web/src/api/types.ts`, `api/client.ts` (the new methods), `packages/web/src/components/settings/PluginsSection.tsx` (MARKETPLACES: a list with Check now / Trusted / Remove and an "Add marketplace" URL field with git's error line; BROWSE: the catalog grouped by marketplace, plugins then skills, each with Install (or Installed / Update available); INSTALLED rows gain the marketplace chip, "v1.0.0 → v1.1.0 available" with the changelog folded, Update, Roll back, Pin (a version picker from `versions`), Auto-update switch), `packages/web/src/components/settings/SkillsSection.tsx` (new, under THIS MAC: installed and local skills, enabled globally and per project), `settings/sections.tsx` (`skills` section), `packages/web/src/stores/update.ts` (`pluginUpdates`, fed by `GET /plugins/updates` on load and `plugin:updates` events; `updatePending` true when either), `components/update/UpdateBanner.tsx` (Dispatch first, then one line per plugin update with Update; disabled while one runs), `components/update/UpdateDot.tsx` (unchanged: reads `updatePending`), `packages/web/src/plugins/registry.ts` (`commands` contribution `{ id, label, run }`), `components/CommandPalette.tsx` (new: ⌘K / Ctrl+K on desktop; built-in rows: the views, the settings sections; then plugin commands; a filter box; Enter runs), `App.tsx` (mount), the phone's Plugins tab (a COMMANDS list under the screens)
- Test: `PluginsSection.test.tsx` (add: marketplaces list/add/error, browse + install, the installed row's update/rollback/pin), `SkillsSection.test.tsx`, `UpdateBanner.test.tsx` (add: plugin updates listed under Dispatch; Update disabled while one runs), `CommandPalette.test.tsx`, `registry.test.ts` (commands)

- [ ] Tests, implement, commit `feat(web): marketplaces, browse, install/update/rollback/pin, skills, plugin updates in the banner, command palette`.

### Task 6: Agent tools, docs, suites, e2e

**Files:**
- Modify: `packages/core/src/overseer/agency-mcp.ts` (`plugin_list`, `skill_list`: read-only, through `GET /api/plugins` and `GET /api/skills` with the thread key — the skills list route allows thread keys with `read:projects`-style listing), `packages/core/src/overseer/prompts.ts` (one paragraph: "You can build a plugin for this Dispatch: write a folder under ~/.dispatch/plugins/<id> with a plugin.json and web.js; the app reloads it as you save; the SDK reference is docs/plugins.md"), `roles/role-policy.ts` (allow the two), tests in `tests/overseer/agency-mcp.test.ts`; `docs/plugins.md` (Marketplaces, Install/update, Skills, Commands sections)

- [ ] Tests, implement, commit `feat(agency): plugin_list and skill_list; docs`.
- [ ] Full suites.
- [ ] E2E on an isolated daemon with a local bare marketplace (`file://`): add it in Settings, browse, install `hello`, bump it in the repository, Check now, the Settings dot and banner show the plugin update, Update, the row shows the new version, Roll back, Pin; install the skill, open a Claude thread and read its system prompt file for the skill block; ⌘K shows a plugin command and runs it.
