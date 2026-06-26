# Integration layer (executor) for Dispatch — Design

**Date:** 2026-06-26
**Status:** Approved (design); ready for implementation plan
**Upstream:** [RhysSullivan/executor](https://github.com/RhysSullivan/executor) — MIT, free, self-hosted (npm). An MCP server + tool runtime + local daemon + web UI + CLI that centralizes integrations (OpenAPI / GraphQL / MCP / Google Discovery + plugins) behind one catalog, one auth store, and one MCP endpoint.

## Problem

Configuring an MCP/integration for Claude Code doesn't make it available in Codex — each provider is wired (and authenticated) separately. We want **one integration layer**, defined once, exposed to whichever model is active, manageable from Settings, exportable/importable across servers, and extensible by handing a model some API docs / a CLI / an MCP and letting it add the integration. Secrets live in the existing Doppler layer.

## Decisions

- **Lifecycle:** Dispatch **manages** executor — checks it's installed, supervises its daemon (auto-start, status), one control plane (mirrors how Dispatch already manages provider CLIs / its own launchd daemon).
- **Secrets:** Doppler is the **source of truth** — selected secrets are injected as env into the executor daemon so integrations authenticate; executor's native OAuth still handles services that need an interactive login.
- **Exposure mechanism:** reuse + generalize the existing per-spawn MCP injection so **both** Claude (`--mcp-config`) and Codex (`-c mcp_servers…`) receive executor's MCP endpoint on every launch.

## Key enabler (existing seam)

`SecretsService.getInjection()` already returns `{ claudeConfigPath, codexArgs, systemPrompt }`, wired via `sessionService.setSecretsInjection()` and applied in `relaunchTerminal`/spawn → both providers get an MCP server (Doppler) today. The integration layer generalizes this to merge **multiple** MCP servers (Doppler + executor + future) into one Claude config file and one set of Codex args.

## Architecture / components

**Core**
- `integrations/service.ts` — `IntegrationsService`: executor lifecycle (installed? start/stop/status), produces executor's MCP-injection entry, proxies executor's CLI for list/add/remove/export/import.
- **Generalized MCP injection** — refactor so spawn merges Doppler + executor (+ future) into one Claude `--mcp-config` file and one Codex `-c mcp_servers…` arg set. (Likely a small `mcp/inject.ts` that both services feed into.)
- **Doppler → executor env bridge** — start the executor daemon with the resolved Doppler secrets as env (`SecretsService` gains/uses an env-map accessor).
- `routes/integrations.ts` — `GET /api/integrations` (status + list), `POST /api/integrations` (add source), `DELETE /api/integrations/:id`, `GET /api/integrations/export`, `POST /api/integrations/import`.

**Web**
- `components/settings/IntegrationsSection.tsx` — daemon status + install prompt; list of integrations with status; Add (URL / OpenAPI / MCP); remove; Export / Import. Added as a Settings tab/section.
- `api/client.ts` + types — integration list/add/remove/export/import.

**Agent-assisted add**
- executor exposes its own management tools *through* the injected MCP, so Claude/Codex can add a source by calling them. Dispatch adds a short system-prompt hint ("you can manage integrations via executor; secrets live in Doppler"). Minimal Dispatch code.

## Data flow

Spawn → injection merges Doppler + executor MCP → Claude/Codex both see the executor catalog. Settings/UI → `/api/integrations` → `IntegrationsService` → executor CLI/daemon. Export = read executor's catalog config; import = write it + reload. Secrets: Doppler → env → executor daemon → integration auth.

## Phasing (MVP first)

1. **MVP — core wiring:** detect/run executor daemon + generalize injection so its MCP reaches Claude **and** Codex + minimal Settings status. (Eliminates "set up twice".)
2. **Settings Integrations UI** — list / add / remove via `/api/integrations`.
3. **Doppler → executor secrets bridge.**
4. **Export / import.**
5. **Agent-assisted add** — system-prompt hint + verify executor's management tools are exposed.

## Error handling

- executor not installed → Settings shows Install + instructions; injection is a no-op so spawns still work.
- daemon down → red status; injection still references executor's MCP (starts on demand or errors gracefully inside the agent).
- import is validated; export is read-only.

## Testing

- Unit: injection merge (Doppler + executor → one Claude config + Codex args); `IntegrationsService` status/list with a mocked executor CLI.
- Routes: `/api/integrations` shapes (mock service).
- Web: `IntegrationsSection` renders list/add/status from a mocked client.

## Open items to verify in the plan (Phase 0)

- **executor's exact CLI/MCP surface** — install command, `executor daemon` supervision, the MCP invocation (`executor mcp` stdio vs an HTTP/SSE URL) and whether it needs the daemon up, `addSource` / `tools sources` / export-import commands and catalog file location. Probe `executor --help` / `executor mcp --help` and adapt the injection + service to the real commands before building Phase 1.
- Confirm Codex accepts the executor MCP server shape via `-c mcp_servers…` (stdio command), matching how Doppler is injected today.

## Deploy

Core change (injection + service + routes) → one daemon restart to ship. Requires executor installed on the host (Dispatch can check + offer to install, like the onboarding providers step).
