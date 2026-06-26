# Executor CLI — Phase 2 Reference

Probed: executor v1.5.20 (npm global, `/Users/davidwebber/.nvm/versions/node/v23.11.0/bin/executor`)

---

## Version

```
executor v1.5.20
```

---

## Top-Level Surface

```
executor call       # Invoke a tool path
executor resume     # Resume a paused execution
executor tools      # Discover available tools and sources
executor install    # Install as OS-supervised background service
executor login      # Sign in to hosted server (device flow)
executor logout     # Clear stored credentials
executor whoami     # Show signed-in identity
executor server     # Manage named server profiles
executor web        # Open the Executor web UI
executor daemon     # Manage the local daemon
executor service    # Manage the OS-supervised background service
executor mcp        # Start an MCP server over stdio
executor open       # Open running web app in browser (already signed in)
executor docs       # Open documentation in browser
```

---

## Daemon Dependency — Key Architectural Fact

**Every command (list, add, remove) requires the daemon. The CLI is a thin HTTP client.**

- The daemon runs at `http://localhost:4788` and stores data in SQLite (`~/.executor/data.db`).
- **The CLI auto-starts the daemon** when it is not running — you will see `"Starting daemon on localhost:4788..."` printed to stderr before the command result. This means callers do not need to pre-start it, but latency exists on cold start.
- `executor daemon status` → `Daemon running at http://localhost:4788 (pid <N>).`
- `executor daemon stop` → `Daemon stopped at http://localhost:4788.`
- The token for direct HTTP calls lives in `~/.executor/server-control/auth.json` → `{"token": "..."}`.

---

## 1. LISTING Integrations / Sources

### Command: `executor tools sources`

Best command for a "list of integrations with status" in a UI. Returns **JSON by default** (no `--json` flag needed).

```bash
executor tools sources
```

**Output format** (`stdout`):
```json
{
  "items": [
    {
      "id": "executor",
      "name": "executor",
      "kind": "built-in",
      "canRemove": false,
      "canRefresh": false,
      "toolCount": 34
    }
  ],
  "total": 1,
  "hasMore": false,
  "nextOffset": null
}
```

Fields:
- `id` / `name` — source identifier
- `kind` — `"built-in"` | `"openapi"` | `"mcp"` | `"graphql"` (inferred from add commands)
- `canRemove` — whether a DELETE operation is permitted
- `canRefresh` — whether the integration can be re-fetched
- `toolCount` — number of tools contributed

**Flags:**
```
--query string       Filter by string
--limit integer      Limit results
--base-url string    Override server origin
--server string      Named server profile
--scope string       Path to workspace dir containing executor.jsonc
```

### Alternative: `executor call executor coreTools integrations list`

Returns richer integration catalog data including `canRemove`:

```bash
executor call executor coreTools integrations list
```

**Output** (`stdout`):
```json
{
  "ok": true,
  "data": {
    "integrations": [
      {
        "slug": "executor",
        "description": "Executor",
        "kind": "built-in",
        "canRemove": false,
        "canRefresh": false
      }
    ]
  }
}
```

### HTTP API (direct — for server-side use)

```
GET http://localhost:4788/api/integrations
Authorization: Bearer <token from ~/.executor/server-control/auth.json>
```

Response: JSON array of integration objects (same fields as above).

---

## 2. ADDING a Source

All add operations go through `executor call`. There is NO plain `executor add` CLI shorthand — adding is MCP-tool-only via `executor call`.

### 2a. Add OpenAPI/REST Source from URL

```bash
executor call executor openapi addSpec '{"spec":{"kind":"url","url":"https://example.com/openapi.json"},"slug":"my-api"}'
```

**Full input schema:**
```typescript
{
  spec: { kind: "url"; url: string } | { kind: "blob"; value: string };
  slug: string;                          // required, unique identifier
  description?: string | null;
  baseUrl?: string | null;               // defaults to spec's first server
  headers?: { [k: string]: string } | null;
  queryParams?: { [k: string]: string } | null;
  authenticationTemplate?: (
    | { slug: string; kind: "oauth2"; authorizationUrl: string; tokenUrl: string; scopes: string[] }
    | { slug?: string | null; type: "apiKey"; label?: string | null;
        headers?: { [k: string]: string | ... } | null;
        queryParams?: { [k: string]: string | ... } | null }
  )[] | null;
}
```

**Output:** `{ slug: string; toolCount: number }`

**Preview step (optional, recommended):**
```bash
executor call executor openapi previewSpec '{"spec":{"kind":"url","url":"..."}}'
```

### 2b. Add MCP Server — stdio transport

```bash
executor call executor mcp addServer '{"transport":"stdio","name":"My MCP","command":"npx","args":["-y","my-mcp-package"]}'
```

**Full input schema:**
```typescript
{
  transport: "stdio";
  name: string;
  description?: string | null;
  command: string;
  args?: string[] | null;
  env?: { [k: string]: string } | null;
  cwd?: string | null;
  slug?: string | null;
}
```

**Output:** `{ slug: string }`

### 2c. Add MCP Server — remote transport (streamable HTTP or SSE)

```bash
executor call executor mcp addServer '{"transport":"remote","name":"Remote MCP","endpoint":"https://example.com/mcp"}'
```

**Full input schema:**
```typescript
{
  transport?: "remote" | null;            // null also defaults to remote
  name: string;
  description?: string | null;
  endpoint: string;
  remoteTransport?: "streamable-http" | "sse" | "auto" | null;
  headers?: { [k: string]: string } | null;
  queryParams?: { [k: string]: string } | null;
  slug?: string | null;
  authenticationTemplate?: (
    | { slug?: string | null; kind: "none" }
    | { slug?: string | null; kind: "oauth2" }
    | { slug?: string | null; type: "apiKey"; label?: string | null;
        headers?: { [k: string]: ... } | null;
        queryParams?: { [k: string]: ... } | null }
  )[] | null;
  auth?: { kind: "none" } | { kind: "header"; headerName: string; prefix?: string | null }
       | { kind: "oauth2" } | null;
}
```

**Output:** `{ slug: string }`

### 2d. Add GraphQL Endpoint

```bash
executor call executor graphql addIntegration '{"endpoint":"https://api.example.com/graphql","slug":"my-graphql"}'
```

**Full input schema:**
```typescript
{
  endpoint: string;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  introspectionJson?: string | null;   // provide pre-fetched introspection to skip live probe
  headers?: { [k: string]: string } | null;
  queryParams?: { [k: string]: string } | null;
  authenticationTemplate?: (
    | { slug?: string | null; kind: "none" }
    | { slug?: string | null; kind: "oauth2"; header?: string | null; prefix?: string | null }
    | { slug?: string | null; type: "apiKey"; label?: string | null;
        headers?: { [k: string]: ... } | null;
        queryParams?: { [k: string]: ... } | null }
  )[] | null;
}
```

**Output:** `{ slug: string; name: string }`

### Post-Add: Creating a Connection

After adding an integration to the catalog, you must create a **connection** to materialize its tools. For no-auth integrations:

```bash
executor call executor coreTools connections create \
  '{"owner":"org","name":"default","integration":"my-api","template":"none"}'
```

For API-key integrations (use `createHandoff` to send user to web UI for credential entry):
```bash
executor call executor coreTools connections createHandoff --help
```

---

## 3. REMOVING a Source

### Remove a Connection (credential)

```bash
executor call executor coreTools connections remove \
  '{"owner":"org","name":"default","integration":"my-api"}'
```

**Input:** `{ owner: "org" | "user"; name: string; integration: string }`
**Output:** `{ removed: boolean }`

This removes the credential/tools, but the integration catalog entry remains.

### Remove the Integration Catalog Entry (HTTP API only)

**There is no `executor call` tool for removing catalog entries.** Use the HTTP API directly:

```
DELETE http://localhost:4788/api/integrations/{slug}
Authorization: Bearer <token>
```

**Response:** `{"removed": true}`

Notes:
- Returns `{"removed": true}` even for non-existent slugs (idempotent).
- Built-in integrations (`canRemove: false`) silently return `{"removed": true}` but are NOT deleted.
- The caller should check `canRemove` from the list endpoint before showing a Remove button.

**Shell snippet for server-side use:**
```bash
TOKEN=$(cat ~/.executor/server-control/auth.json | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s -X DELETE "http://localhost:4788/api/integrations/${SLUG}" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4. LISTING Connections

```bash
executor call executor coreTools connections list
# Optional filters:
executor call executor coreTools connections list '{"integration":"my-api","owner":"org"}'
```

**Output:** `{ connections: [{ owner, name, integration, template, provider, address, ... }] }`

---

## 5. URL Detection (auto-detect type from URL)

```bash
executor call executor coreTools integrations detect '{"url":"https://api.example.com/openapi.json"}'
```

**Output:** `{ results: [{ kind: string; confidence: "high"|"medium"|"low"; endpoint: string; name: string; slug: string }] }`

Use this to pre-fill the "add integration" form by determining if a URL is OpenAPI, GraphQL, or MCP.

---

## 6. EXPORT / IMPORT

**No dedicated `executor export` or `executor import` commands exist.**

All data is stored in a **SQLite database** at:
```
~/.executor/data.db
```

There is no `executor.jsonc` catalog file for the global (no `--scope`) configuration. The `--scope` flag points to a workspace directory where executor would look for or create a `executor.jsonc`, but the global daemon uses SQLite only.

For backup/migration purposes: copy `~/.executor/data.db`.

---

## 7. Catalog / Storage

| Item | Location |
|------|----------|
| SQLite database | `~/.executor/data.db` |
| Daemon metadata | `~/.executor/daemon-localhost-4788.json` |
| Server config | `~/.executor/server-control/server.json` |
| Auth token | `~/.executor/server-control/auth.json` → `{"token":"..."}` |
| Cache | `~/.executor/cache/` |

**There is no `executor.jsonc` for the global catalog.** The `--scope <dir>` flag is for workspace-level overrides; the global default uses only SQLite.

The HTTP API base URL is always `http://localhost:4788/api` (loopback only).

---

## 8. JSON / Scriptability Summary

| Command | JSON output? | Notes |
|---------|-------------|-------|
| `executor tools sources` | Yes (always) | Best for list rendering |
| `executor call executor coreTools integrations list` | Yes (`{"ok":true,"data":{...}}`) | Richer, has `canRemove` |
| `executor call executor openapi addSpec '...'` | Yes | Emits `{"ok":true,"data":{slug,toolCount}}` |
| `executor call executor mcp addServer '...'` | Yes | Emits `{"ok":true,"data":{slug}}` |
| `executor call executor graphql addIntegration '...'` | Yes | Emits `{"ok":true,"data":{slug,name}}` |
| `executor call executor coreTools connections remove '...'` | Yes | `{"ok":true,"data":{removed:bool}}` |
| `DELETE /api/integrations/{slug}` (HTTP) | Yes | `{"removed":true}` |

All `executor call` commands exit 0 on success and emit JSON to stdout. Parse `stdout` directly.

---

## 9. Daemon Dependency Per Command

| Command | Daemon required? | Auto-starts? |
|---------|-----------------|--------------|
| `executor tools sources` | Yes | Yes — CLI auto-starts if not running |
| `executor call executor coreTools integrations list` | Yes | Yes |
| `executor call executor openapi addSpec` | Yes | Yes |
| `executor call executor mcp addServer` | Yes | Yes |
| `executor call executor graphql addIntegration` | Yes | Yes |
| `executor call executor coreTools connections remove` | Yes | Yes |
| `DELETE /api/integrations/{slug}` (HTTP) | Yes — IS the daemon | N/A |

**Verdict:** All list/add/remove operations require the daemon. The CLI transparently auto-starts it (prints `"Starting daemon on localhost:4788..."` to stderr). For server-side HTTP calls, the caller must ensure the daemon is running (or use the CLI which handles startup automatically).

---

## Example: Full Add + Connect Flow (OpenAPI)

```bash
# 1. Add the integration to the catalog
executor call executor openapi addSpec \
  '{"spec":{"kind":"url","url":"https://petstore3.swagger.io/api/v3/openapi.json"},"slug":"petstore"}'
# → {"ok":true,"data":{"slug":"petstore","toolCount":19}}

# 2. Create a no-auth connection to materialize tools
executor call executor coreTools connections create \
  '{"owner":"org","name":"default","integration":"petstore","template":"none"}'

# 3. Verify it appears
executor tools sources
# → items includes {"id":"petstore","kind":"openapi","toolCount":19,...}

# 4. Remove connection then integration
executor call executor coreTools connections remove \
  '{"owner":"org","name":"default","integration":"petstore"}'
TOKEN=$(python3 -c "import json; print(json.load(open('/Users/davidwebber/.executor/server-control/auth.json'))['token'])")
curl -s -X DELETE "http://localhost:4788/api/integrations/petstore" \
  -H "Authorization: Bearer $TOKEN"
# → {"removed":true}
```

---

## CLI source support

**Probed on executor v1.5.20.** Question: can executor ingest a local CLI / command-line tool as an integration source (the way it ingests OpenAPI, MCP, GraphQL)?

### Answer: NO — there is no native CLI/command/shell source type.

### Complete enumeration of executor's management namespaces (all 34 tools)

Source of truth — `GET http://localhost:4788/api/tools` filtered to the `executor` namespace (matches `executor call executor <ns> --help`). The full namespace set is exactly six groups:

| Namespace | Tools (actions) | Purpose |
|-----------|----------------|---------|
| `coreTools` (21) | `integrations.list`, `integrations.detect`, `connections.list`, `connections.create`, `connections.createHandoff`, `connections.remove`, `connections.refresh`, `providers.list`, `providers.items`, `oauth.clients.list`, `oauth.clients.create`, `oauth.clients.createHandoff`, `oauth.clients.registerDynamic`, `oauth.clients.remove`, `oauth.probe`, `oauth.start`, `oauth.cancel`, `policies.list`, `policies.create`, `policies.update`, `policies.remove` | Connections, OAuth, policies, providers, catalog list/detect |
| `openapi` (2) | `previewSpec`, `addSpec` | Add OpenAPI/REST source |
| `mcp` (3) | `probeEndpoint`, `getServer`, `addServer` | Add MCP server source |
| `graphql` (2) | `getIntegration`, `addIntegration` | Add GraphQL source |
| `onepassword` (5) | `status`, `getConfig`, `listVaults`, `configure`, `removeConfig` | 1Password credential-vault provider (NOT a tool source) |
| `desktopSettings` (1) | `openSettings` | Opens the desktop settings UI |

**The only source-ingestion ("add an integration that produces tools") actions are:** `openapi.addSpec`, `mcp.addServer`, `graphql.addIntegration`. There is no `cli`, `command`, `shell`, `exec`, `process`, `local`, `function`, `plugin`, or `customTool` namespace or action. A natural-language tool search (`executor tools search "command line cli shell exec local executable"`) returns zero results in a default catalog.

There is also no "custom tool / function / plugin authoring" mechanism exposed by the CLI or daemon API. The top-level `executor install` command installs the *daemon itself* as an OS service — it does not install plugins. Plugins are built into the binary; the global daemon stores catalog state in SQLite (`~/.executor/data.db`), and there is no `executor.jsonc` plugin-authoring path for the global scope.

### Closest supported path for "expose a CLI as an integration"

1. **MCP stdio — ONLY if the CLI itself speaks the MCP protocol.**
   `executor call executor mcp addServer` with `transport:"stdio"` launches a local command and speaks **MCP over stdio** to it. The `command`/`args` must be an **MCP server process** (e.g. `npx -y @some/mcp-server`). Executor does **NOT** wrap an arbitrary CLI: it does not parse `--help`, it does not introspect subcommands/flags, and it does not turn ordinary stdout/exit codes into tools. The child process must implement the MCP handshake (`initialize`, `tools/list`, `tools/call`). So:
   - A CLI that *ships an MCP mode* (or has an MCP wrapper package) → register via `mcp.addServer` stdio. Good.
   - A plain CLI (git, ffmpeg, your-app) → cannot be ingested this way.

   ```bash
   # Works ONLY because the command is an MCP server, not because it's a CLI:
   executor call executor mcp addServer \
     '{"transport":"stdio","name":"My MCP","command":"npx","args":["-y","@scope/mcp-server"]}'
   ```

2. **Agent-assisted: author an OpenAPI spec, then `openapi.addSpec`.**
   For an arbitrary CLI, the only route to first-class tools is to hand a model the CLI's `--help` and have it produce an OpenAPI document (or a thin local HTTP shim) describing the operations, then ingest that via `openapi.addSpec` with `{"spec":{"kind":"blob","value":"<openapi json>"}}`. This is bespoke per-CLI work, not a built-in executor feature.

3. **No "custom tool / function" mechanism** exists to register a single raw shell command as a tool.

### Verdict for a Settings "Add integration" UI

- Surface **Add OpenAPI (URL/spec)**, **Add MCP server (stdio command or remote URL)**, and **Add GraphQL endpoint** — these map 1:1 to `openapi.addSpec`, `mcp.addServer`, `graphql.addIntegration`.
- The MCP stdio form already takes a `command` + `args` + `env` + `cwd`, so it doubles as the "run a local command" entry point — but label it **"Add MCP server (command)"**, not "Add CLI", because the command must speak MCP. Presenting it as a generic "Add CLI tool" would mislead users (an arbitrary binary will fail at the MCP handshake).
- **Defer a dedicated "Add CLI" option.** There is no native CLI source type, and the only generic path (author an OpenAPI/MCP wrapper) is per-CLI custom work unsuitable for a one-click Settings action.
