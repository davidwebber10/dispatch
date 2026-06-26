# Own MCP-centric Integration Layer — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Supersedes:** the executor-based integration layer (MVP phase 1 kept; phase 2's executor management + the `2026-06-26-integration-add-ux-and-export-import-design` spec are replaced by this). Probe notes that informed the pivot: `docs/superpowers/notes/executor-cli-phase2.md`, `executor-cli-phase345.md`.

## Problem

The original goal — "set up an integration once and have it available in both Claude and Codex, manage it in Settings, keep secrets in Doppler" — does not actually require executor. executor added a daemon, a SQLite catalog we don't control, a credential model that fought our Doppler setup, and an awkward add flow. The piece that genuinely solves the cross-provider problem is `composeInjection` (ours, from the MVP), which already merges N MCP servers into both Claude's `--mcp-config` and Codex's `-c mcp_servers…`. So we own the catalog ourselves and feed it to the existing injector. Almost everything worth adding is an MCP server (native MCPs directly; OpenAPI/GraphQL/CLIs via wrapper MCP servers), so the layer is "a managed catalog of MCP servers."

## Goal

A Dispatch-owned catalog of MCP servers, addable from Settings (paste a URL for remote; command for local), injected into both Claude and Codex on every spawn, with secrets supplied by the existing Doppler env injection. Export/import is a JSON dump of our catalog. No executor dependency, no extra daemon.

## Architecture / components

**Catalog (core, our SQLite).** New table `integrations`:
`id` (uuid), `name`, `type` ('stdio' | 'remote'), `command` (stdio), `args` (JSON string[], stdio), `url` (remote), `headers` (JSON map, remote), `env` (JSON map, optional, both), `enabled` (bool, default 1), `created_at`, `updated_at`. A `db/integrations.ts` module provides typed CRUD mirroring the existing `db/*` modules.

**IntegrationsService (rewritten, executor removed).** Methods: `list()`, `add(input)`, `remove(id)`, `setEnabled(id, enabled)`, and `getServerSpecs(): McpServerSpec[]` — resolves every enabled row to an `McpServerSpec`:
- stdio → `{ name, command, args, env }`
- remote → `{ name, command: 'npx', args: ['-y', 'mcp-remote', url, ...headerArgs], env }` (the `mcp-remote` stdio bridge; one mechanism for both providers, reusing `composeInjection` unchanged). Header values that reference secrets are passed as `--header "Name: ${VAR}"` so the value comes from the spawn env, not argv literals.
The old executor methods (`status` via `executor --version`, `getServerSpec` for `executor mcp`, `getSystemPrompt`, the `executor call` list/add/remove/detect) are deleted.

**Spawn injection (sessions/service).** Today it composes `[dopplerSpec, executorSpec]`. Change: compose `[dopplerSpec, ...integrationsService.getServerSpecs()]`. The `setIntegrationsInjection` seam is repointed from the executor single-spec to the catalog's spec list. `composeInjection` is unchanged.

**Secrets.** Doppler secrets are already injected into every terminal's environment (`SecretsService.getSpawnEnv()` → `ptyManager` default env). An MCP server is spawned as a child of the Claude/Codex process and inherits that env, so a server that reads `process.env.FOO` gets Doppler's `FOO` with no per-integration wiring. The optional per-integration `env` map is for literals/overrides; secret *values* are never written into the injected mcp-config file (reference Doppler env by name).

**Routes (`/api/integrations`, repointed to the catalog).** `GET /` → `{ integrations: Integration[] }`; `POST /` (add) → the created `Integration`; `DELETE /:id` → `{ removed: true }`; `PATCH /:id` `{ enabled }` → updated `Integration`; `GET /export` → `{ version, integrations }`; `POST /import` → `{ added, skipped }`. The executor `installed`-gate and the `/detect` route are removed (no executor to detect).

**Web.** `api` methods for list/add/remove/toggle/export/import; mirror types; rebuilt `IntegrationsSection` in the Integrations tab.

## Add UX

Default: **paste a remote MCP URL** + a name → Add (creates a `remote` entry). A collapsed **Advanced** holds the **local command** form (stdio: command + args + optional env) and an optional env/headers editor. The list shows each integration with an enable/disable toggle and a remove button. **Export** downloads the catalog JSON; **Import** uploads it (skips entries whose name already exists). No type dropdown, no slugs, no executor.

## Data flow

Settings → `/api/integrations` → `IntegrationsService` → our SQLite. Terminal spawn → `getServerSpecs()` + Doppler spec → `composeInjection` → Claude `--mcp-config` file + Codex `-c` args → both CLIs launch with every enabled integration. Integration runtime → the MCP server (spawned by the CLI) inherits Doppler env for auth.

## Error handling

Add validation: remote requires a valid http(s) `url` + `name`; stdio requires `command` + `name`. Bad input → 400. A malformed catalog row is skipped during `getServerSpecs()` (logged server-side, never breaks a spawn) so one bad entry can't stop terminals launching. `mcp-remote` unreachable at runtime is the CLI's concern (the agent sees the tool as unavailable) — it never blocks spawn. Import collects per-entry failures into the response, never aborting the batch.

## Testing

Core unit tests: `db/integrations` CRUD; `IntegrationsService.getServerSpecs()` resolves stdio + remote (asserts the exact `mcp-remote` argv and that secret header values use `${VAR}` not literals), skips disabled + malformed rows; `add` validation. Route tests (in-memory db via `createApp`): list/add/remove/toggle shapes, 400 on bad input, export/import round-trip. A spawn-wiring test (extending the existing one) asserting catalog specs reach both providers' argv. Web verified by tsc + build.

## Migration / removal

Remove: the `executor`-specific code in `IntegrationsService`, the `executor mcp` injection, the executor status route + `installed` gating, the executor system-prompt, and the phase-2 detect/`executor call` paths and their tests. Keep: `composeInjection`, the Doppler injection, the injection seam, the Settings tab, the routes file (rewritten). The user's existing executor-added integrations are not migrated (re-add in the new UI); executor can be uninstalled. The MVP cross-provider injection behavior is preserved for Doppler.

## Decisions

- MCP is the substrate: OpenAPI/GraphQL/CLIs are added as wrapper MCP servers (e.g. an `npx openapi-mcp --spec URL` stdio entry), so no special-casing in v1.
- Remote MCP via the `mcp-remote` stdio bridge in v1 (reuses `composeInjection` untouched, works for both providers). Native remote config is a later optimization if `mcp-remote` proves limiting.
- Secrets via ambient Doppler env (inherited by spawned MCP servers); no secret values in the injected config file.
- Export carries catalog definitions only, never secret values (those live in Doppler).
