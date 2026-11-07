# Plugins slice 2: storage, settings, permissions and keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin has a key of its own (principal kind `plugin`) scoped by its manifest's permissions, daemon-side storage and settings documents, and the web SDK reads and writes them through the daemon; the Plugins page shows each plugin's permissions.

**Architecture:** `KeyRegistry` gains the `plugin` kind (`dpk_` prefix, one live key per plugin); the registry mints a key when a plugin is enabled and revokes it when disabled or removed, writing `~/.dispatch/keys/plugin-<id>` (0600) for the plugin's processes (slices 3 and 5). `keyRoute` gains a `plugin` rule with `PluginFacts { id, permissions }` from a provider the registry installs; `needs(permission)` is the rule most routes use. Two tables, `plugin_data` and `plugin_settings`, with routes under `/api/plugins/:id/`; a thread key may read or write a plugin's data when the plugin grants `threads:read-storage` / `threads:write-storage`, and the daemon stamps the writer from the key. The web SDK's `storage` becomes async over these routes; `settings` is added.

**Tech Stack:** as slice 1.

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` sections 5 and 6 (and 11, slice 2). Slice 1 plan: `2026-11-07-plugins-slice-1-host-sdk.md`.

## Global Constraints

- Key literals: prefix `dpk_` + 43 base64url characters, like the other kinds; only hashes are held.
- A plugin key is live for exactly one plugin at a time; enabling again mints a new key and revokes the old one.
- Key file: `~/.dispatch/keys/plugin-<id>`, mode 0600, the key literal plus a newline; deleted on disable and remove; never served by a route.
- Permissions are the manifest's `permissions` list; `storage` is implied for the plugin's own data; anything not listed is refused with 403 `{ error: 'owner_only', message: 'The plugin "<id>" lacks the permission "<name>".' }`.
- A document is at most 262144 bytes of JSON; a plugin holds at most 2000 documents (builder's figures, spec leaves them open).
- A thread key's write stamps `writer: { terminalId, sessionId, label }` from the key, never from the body.
- Refusals name the plugin and the permission; they never echo a key.

## Review Focus

1. A plugin key whose plugin was removed must get 401 on every route, not 500 (Task 1 test "a removed plugin's key is refused").
2. A thread key must not read another plugin's data when only one plugin granted `threads:read-storage` (Task 5 test "a thread reads only plugins that granted it").
3. A document over the size cap must be refused with 413 and the stored value unchanged (Task 5 test "a document over 256 KB is refused").
4. Disabling a plugin while its process holds the key must make the next call 401 (Task 2 test "disable revokes the key at once").
5. The SDK's async storage must not lose a write made while the previous one is in flight (Task 6 test "two sets in a row land in order").

---

### Task 1: The `plugin` principal kind

**Files:**
- Modify: `packages/core/src/auth/principals.ts` (`KeyKind` adds `'plugin'`, `KEY_PREFIX.plugin = 'dpk_'`, `KeyPrincipal` adds `{ kind: 'plugin'; pluginId: string; handle }`, `MintInput` adds `{ kind: 'plugin'; pluginId }`; `mint` keys the live map by `plugin:<id>` for this kind; `liveHandleForPlugin(id)`), `packages/core/src/auth/route-policy.ts` (`RuleCtx.plugin: PluginFacts | null`; `KeyRules.plugin?: Rule`; `keyRoute` resolves `principal.kind === 'plugin'` through `pluginFacts(id)` — 401 when null — and `rules.plugin`; `configurePluginFacts(fn)`; `export function needs(permission: string): Rule`), `packages/core/src/auth/request-principal.ts` (`whoamiHandler` answers `{ kind: 'plugin', pluginId, permissions }`; `noCredentialStatsHandler` treats `plugin` like the other keys), `packages/core/src/auth/key-rules.ts` (`describe` for the plugin kind in refusal text)
- Test: `packages/core/src/auth/route-policy.test.ts` (add), `packages/core/src/auth/principals.test.ts` (add)

**Interfaces:**
- Produces: `export interface PluginFacts { id: string; permissions: string[] }`; `configurePluginFacts(fn: (id: string) => PluginFacts | null): void`; `needs(permission: string): Rule`; `KeyRegistry.mint({ kind: 'plugin', pluginId })`; `KeyRegistry.liveHandleForPlugin(id)`.

- [ ] **Step 1: Write the failing tests** — principals: 'a plugin key has the dpk_ prefix and resolves to its plugin; a second mint for the same plugin revokes the first'. route-policy: 'a plugin key reaches a keyRoute with a plugin rule; without one it gets 403 owner_only'; 'needs(permission) passes when the plugin lists it and refuses with the plugin and permission named'; 'a removed plugin's key is refused with 401' (facts provider returns null); 'whoami for a plugin key names the plugin and its permissions'.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; `npx tsc --noEmit -p .`; also run `tests/auth/route-policy-completeness.test.ts`.**
- [ ] **Step 5: Commit** — `feat(core): the plugin principal kind, plugin rules and needs(permission)`.

### Task 2: Keys issued by the registry

**Files:**
- Modify: `packages/core/src/plugins/registry.ts` (constructor gains `keys: KeyRegistry` and `keyDir: string`; `issueKeys()` mints for every enabled, unbroken plugin and writes the files; `setEnabled(id, true)` mints and writes, `setEnabled(id, false)` and `remove(id)` revoke and delete; `keyFor(id): string | null` returns the path; `facts(id): PluginFacts | null` for the policy provider; `list()` rows gain `permissions` (already) and `keyed: boolean`), `packages/core/src/server.ts` (pass `keys` and `path.join(dispatchDir, 'keys')`; `configurePluginFacts((id) => plugins.facts(id))`; `plugins.issueKeys()` in both app builds after construction), `packages/core/src/routes/plugins.ts` (no change in shape; the row carries `keyed`)
- Test: `packages/core/tests/plugins/registry.test.ts` (add), `packages/core/tests/routes/plugins.test.ts` (add)

- [ ] **Step 1: Write the failing tests** — registry: 'issueKeys writes a 0600 key file per enabled plugin and none for a disabled or broken one'; 'disable revokes the key at once and deletes the file; enable mints a new one'; 'remove deletes the key file'; 'facts(id) returns the manifest permissions, null for unknown or disabled'. routes: 'a plugin key lists plugins and calls whoami; a disabled plugin's key is 401'.
- [ ] **Step 2–5 as the pattern**; commit `feat(core): plugin keys issued on enable, revoked on disable and remove`.

### Task 3: Read routes open to plugin keys

**Files:**
- Modify: `packages/core/src/routes/sessions.ts` (`GET /` adds `plugin: needs('read:projects')`), `packages/core/src/routes/terminals.ts` (`GET /sessions/:id/terminals`, `GET /terminals/:terminalId`, `GET /terminals/:terminalId/conversation` add `plugin: needs('read:threads')`), `packages/core/src/routes/ledger.ts` (`list`, `show` add `plugin: needs('read:ledger')`; `add`, `note`, `resolve`, `decide-self` add `plugin: needs('write:ledger')`), `packages/core/src/routes/plugins.ts` (`GET /plugins` adds `plugin: allowRule`), `packages/core/src/routes/previews.ts` (`GET /previews`, `GET /sessions/:id/previews` become keyRoutes with `plugin: needs('read:previews')`, thread/roleRun `allowRule`)
- Test: `packages/core/tests/routes/plugin-keys.test.ts` (new)

- [ ] **Step 1: Write the failing tests** — 'a plugin with read:projects lists sessions; without it 403 names the permission'; 'read:threads opens the terminal list and a transcript'; 'read:ledger opens list and show; write:ledger is needed to add'; 'read:previews opens the previews list'.
- [ ] **Step 2–5**; commit `feat(core): plugin keys read projects, threads, ledger and previews by permission`. Add the new key routes to `tests/auth/route-policy-completeness.test.ts`.

### Task 4: The tables and the db module

**Files:**
- Modify: `packages/core/src/db/schema.ts` (migration `'018-plugin-data'`: `plugin_data(plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, writer TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (plugin_id, key))`, `plugin_settings(plugin_id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`)
- Create: `packages/core/src/db/plugin-data.ts`
- Test: `packages/core/src/db/plugin-data.test.ts`

**Interfaces:**
- Produces: `export const DOC_MAX_BYTES = 262144; export const DOCS_MAX = 2000;` `export interface Writer { terminalId: string; sessionId: string; label: string | null }` `export interface PluginDoc { key: string; value: unknown; writer: Writer | null; updatedAt: string; bytes: number }` `getDoc(db, pluginId, key): PluginDoc | null`, `setDoc(db, pluginId, key, value: unknown, writer: Writer | null): PluginDoc` (throws `'too large'` | `'too many'`), `deleteDoc(db, pluginId, key): boolean`, `listDocs(db, pluginId): Omit<PluginDoc, 'value'>[]`, `clearPlugin(db, pluginId): void`, `getSettings(db, pluginId): { value: unknown; updatedAt: string } | null`, `setSettings(db, pluginId, value): { value; updatedAt }`.
- Key rule: `^[A-Za-z0-9._:-]{1,128}$`, else throws `'bad key'`.

- [ ] **Step 1: Write the failing tests** — 'set then get round-trips JSON and records the writer and size'; 'set over 256 KB throws too large and leaves the old value'; 'the 2001st key throws too many'; 'a bad key throws'; 'list omits values; delete returns whether it existed; clearPlugin drops data and settings'; 'settings round-trip'.
- [ ] **Step 2–5**; commit `feat(core): plugin_data and plugin_settings tables`.

### Task 5: Storage and settings routes

**Files:**
- Modify: `packages/core/src/routes/plugins.ts`
- Test: `packages/core/tests/routes/plugins-data.test.ts` (new)

Routes (all under `/api/plugins/:id/`), rules:
- `GET data` (list), `GET data/:key`, `PUT data/:key` (body is the JSON value; `Content-Type: application/json`), `DELETE data/:key`.
  - owner: always. plugin key: own id only (`ownPluginRule`: 403 `'A plugin reaches its own storage only.'`). thread key: `GET` needs the plugin to grant `threads:read-storage`, `PUT`/`DELETE` `threads:write-storage` (`grantRule(permission)`: 403 `'The plugin "<id>" does not let threads <read|write> its storage.'`); a thread's PUT stamps the writer from `ctx.caller` (`terminalId`, `sessionId`, `label`); an owner's or the plugin's own write stamps `null`.
  - errors: 404 unknown plugin or key; 413 `{ error: 'too_large' }`; 409 `{ error: 'too_many' }`; 400 bad key or invalid JSON.
- `GET settings`, `PUT settings`: owner and the plugin's own key.
- `DELETE /api/plugins/:id` (remove) also calls `clearPlugin`.
- Every data write broadcasts `plugin:data { id, key, deleted? }` so the web SDK can refresh a subscribed document.

- [ ] **Step 1: Write the failing tests** — 'the owner lists, writes, reads and deletes a document'; 'a plugin key reaches its own storage only'; 'a thread reads only plugins that granted it, and its write carries the writer from the key'; 'a document over 256 KB is refused with 413 and the old value stays'; 'settings round-trip for the owner and the plugin; a thread key gets 403'; 'remove clears the plugin's data'; 'a write broadcasts plugin:data'.
- [ ] **Step 2–5**; commit `feat(core): plugin storage and settings routes`. Add the routes to the completeness list.

### Task 6: The SDK on daemon storage

**Files:**
- Modify: `packages/web/src/api/client.ts` (`pluginData(id)`, `getPluginDoc(id, key)`, `setPluginDoc(id, key, value)`, `deletePluginDoc(id, key)`, `getPluginSettings(id)`, `setPluginSettings(id, value)`), `packages/web/src/plugins/sdk.tsx` (`storage` becomes `{ get<T>(plugin, key, fallback): Promise<T>; set(plugin, key, value): Promise<void>; remove(plugin, key): Promise<void>; list(plugin): Promise<string[]> }` with a per-plugin write queue so sets land in order; `settings: { get<T>(plugin, fallback): Promise<T>; set(plugin, value): Promise<void> }`; `hooks.useDoc(plugin, key, fallback)` returns `[value, setValue, loading]` and refreshes on `plugin:data`; `fetch(path, init)` adds `X-Dispatch-Plugin`), `packages/web/src/plugins/host.ts` (`applyPluginEvent` also routes `plugin:data` to a small subscriber map the hook uses), `docs/plugins.md`, `docs/plugins/examples/*` (async storage; `useDoc`)
- Test: `packages/web/src/plugins/sdk.test.ts` (new), `host.test.ts` (add the `plugin:data` fan-out)

- [ ] **Step 1: Write the failing tests** — 'storage.get returns the fallback on 404 and the value on 200'; 'two sets in a row land in order'; 'useDoc loads, sets, and refreshes when plugin:data names its key'; 'fetch adds the X-Dispatch-Plugin header'.
- [ ] **Step 2–5**; commit `feat(web): plugin storage and settings on the daemon; useDoc`.

### Task 7: Permissions on the Plugins page

**Files:**
- Modify: `packages/web/src/components/settings/PluginsSection.tsx` (each row lists `permissions` as chips with a one-line meaning from a map; "No permissions" when empty; a key chip "Key issued" when `keyed`), `packages/web/src/api/types.ts` (`keyed: boolean`)
- Test: `PluginsSection.test.tsx` (add 'a row lists the plugin's permissions with their meaning').

- [ ] **Step 1–5**; commit `feat(web): the Plugins page shows permissions and the key state`.

### Task 8: Suites, docs and the end-to-end check

- [ ] Full web and core suites (output to files). Expected: all pass but the two pre-existing files.test cases.
- [ ] E2E on an isolated daemon: a plugin key from `~/.dispatch/keys/plugin-<id>` lists sessions with `read:projects` and is refused without; a thread key reads a granted plugin's document; the example `daily-rundown` keeps its pins across a reload through daemon storage.
- [ ] Commit docs: `docs/plugins.md` gains "Permissions", "Storage and settings" and "The plugin key" sections.
