# Integration layer — human-friendly Add + Export/Import — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Builds on:** the shipped MVP + phase 2 (`IntegrationsService` list/add/remove, `/api/integrations` routes, Settings Integrations tab). Probe ground-truth: `docs/superpowers/notes/executor-cli-phase2.md` and `docs/superpowers/notes/executor-cli-phase345.md`.

## Problem

Phase 2's Add form is too technical: the user must pick a type (OpenAPI / MCP-stdio / MCP-remote / GraphQL) and fill slugs, commands, args, endpoints. For the common case — adding a hosted MCP server or an API — the user should **just paste a URL**. Separately, the original goal ("export/import to move integrations to another server") needs a real implementation since the spec's `executor.jsonc` assumption was wrong (catalog is SQLite).

## Scope

In scope: (1) human-friendly **Add by URL** with auto-detect; (2) **export / import** of the integration catalog. Out of scope (probe-driven decisions): **phase 3 secrets bridge** — executor has no API to set a credential value (only references provider items keychain/file/1Password); the only no-browser path is a two-hop Doppler→1Password→executor bridge, not worth the complexity now. **Phase 5 agent-assisted add** — the injected `executor mcp` exposes only `execute`+`resume`, not management tools, so an agent can't cleanly add integrations; the URL-detect flow covers the manual case instead.

## Feature 1 — Add by URL (auto-detect)

**Flow:** The Integrations tab leads with a single **URL** field + **Detect**. Dispatch calls executor's `coreTools integrations detect` with the URL; it returns candidate(s) `{kind, name, slug, endpoint, confidence}` identifying the URL as remote **mcp** / **openapi** / **graphql**. The UI shows the top candidate as a confirmation card ("✓ Found: Linear — MCP · remote") with one **Add** button. On confirm, Dispatch maps the detected candidate to the existing `add()` input and adds it; the list refreshes.

**Detected-kind → add mapping** (reuses phase-2 `add()` unchanged):
- `mcp` → `{ type: 'mcp-remote', name, endpoint, slug }`
- `openapi` → `{ type: 'openapi', url, slug }`
- `graphql` → `{ type: 'graphql', endpoint, slug }`

`name`/`slug` come from detect (no user typing in the simple flow).

**Advanced (collapsed, hidden by default):** retains the phase-2 type-based form for the cases a URL can't express — a local **stdio MCP command** (`command` + `args`) — plus manual type/slug override if detect ever misses. The complexity stays available, just not in the default path.

**Errors:** detect returns no candidate → "Couldn't find an integration at that URL — try Advanced." Daemon-unreachable and add-failure reuse the existing safe messages.

## Feature 2 — Export / Import

**Export** (`GET /api/integrations/export`): enumerate non-built-in integrations (`canRemove` true), fetch each one's reconstruct-able config, and return a JSON document `{ version: 1, exportedAt, integrations: [...] }`. Per-kind detail source (from the probe): **mcp** via `mcp getServer` (full `{transport, command, args, endpoint}`); **graphql** via `graphql getIntegration` (`{endpoint, name}`); **openapi** via `GET /api/integrations/{slug}` `displayUrl` (the original spec URL). Each exported entry carries `{ kind, slug, name, description, ...kindConfig }` shaped to be re-addable. **Credentials are never exported** (executor exposes no secret values) — documented in the file and the UI ("you'll reconnect auth on the new server").

**Import** (`POST /api/integrations/import` with the JSON doc): for each entry, replay the matching `add()`. Skip entries whose slug already exists. Return a summary `{ added: string[], skipped: string[], failed: {slug, error}[] }`.

**Web UI:** Export and Import buttons in the Integrations tab. Export downloads the JSON; Import is a file picker → POST → shows the summary. OpenAPI integrations added as an inline blob (no live URL) can't be reconstructed via this path — they're reported in `failed` with a clear reason (rare; URL-added specs round-trip fine).

## Architecture / components

**Core** (`packages/core/src/integrations/service.ts`, additive): `detect(url): Promise<DetectCandidate[]>`; `export(): Promise<IntegrationsExport>`; `import(doc): Promise<ImportSummary>`. New types `DetectCandidate`, `IntegrationsExport`, `ExportedIntegration`, `ImportSummary`. All shell out via the existing injectable `deps.run` / HTTP, so they remain unit-testable with fake deps.

**Routes** (`packages/core/src/routes/integrations.ts`, additive): `POST /detect`, `GET /export`, `POST /import`. All gate on `status().installed` and use the existing fixed-message 502 pattern.

**Web** (`packages/web`): `api.detectIntegration`, `api.exportIntegrations`, `api.importIntegrations`; mirror types; rebuilt `IntegrationsSection` (URL/detect/confirm default + collapsed Advanced + Export/Import buttons).

## Error handling

executor absent → routes return installed:false / 409 as today; UI shows the install prompt. Daemon unreachable → 502 fixed message + the existing "daemon starts on first use" hint. detect no-match → friendly "try Advanced." import per-entry failures collected into the summary, never aborting the whole import.

## Testing

Core unit tests (fake deps): `detect` parses/maps candidates; `export` assembles entries from per-kind detail calls (mock the run outputs) and skips built-ins; `import` replays adds, skips existing slugs, and collects failures. Route tests (fake service): `POST /detect` shape + 409/502; `GET /export` shape; `POST /import` summary + 409/502. Web verified by tsc + build (no web unit runner).

## Decisions

- Add-by-URL reuses phase-2 `add()`; detect only auto-fills it. No new add mechanics.
- Advanced retained (not removed) so stdio/local MCP and manual override stay possible.
- Export is best-effort reconstruct (URL/command/endpoint), NOT a secret-bearing backup; credentials reconnect on the target. Whole-DB copy (`~/.executor/data.db`) is the manual fallback for a full move and is noted in docs, not built into the UI.
- Phases 3 (secrets bridge) and 5 (agent-assisted add) deferred — see Scope for the probe-driven reasons.
