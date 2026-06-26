# Executor CLI — Phase 3/4/5 Reference

Probed: executor v1.5.20 (npm global), 2026-06-26.
All commands below use `/Users/davidwebber/.nvm/versions/node/v23.11.0/bin/executor` (on PATH as `executor`).

---

## Area A — Authentication / Credentials Model

### Goal
Bridge "Doppler holds a secret → executor integration uses it" without a human web-UI step.

---

### A.1 `connections.create` full input schema

```
executor call executor coreTools connections create --help
```

```
Tool: executor.coreTools.connections.create
Low-level create or replace for a saved connection from provider item references.
For a no-auth integration (public MCP/REST), pass template:"none" with no from/inputs.
For API keys/tokens, use connections.createHandoff so the user enters the credential in the web UI.
OAuth credentials should use oauth.start.

Input:
{
  owner: "org" | "user";
  name: string;
  integration: string;
  template: string;
  identityLabel?: string | null;
  from?: { provider: string; id: string; } | null;
  inputs?: { [k: string]: { from: { provider: string; id: string; }; }; } | null;
}

Output:
{
  owner: "org" | "user"; name: string; integration: string; template: string;
  provider: string; address: string; identityLabel?: string | null;
  description?: string | null; expiresAt: number | null;
  oauthClient: string | null; oauthClientOwner: "org" | "user" | null; oauthScope: string | null;
}
```

**Critical finding:** There is NO `secret`, `credentials`, `apiKey`, or `value` field. Credentials are ALWAYS supplied via `from: { provider, id }` referencing an existing item in a credential provider — never inline. The SQLite `connection.item_ids` column stores `{"token": "<id>"}` for apiKey templates (key name comes from the template type).

---

### A.2 `connections.createHandoff` full input schema

```
executor call executor coreTools connections createHandoff --help
```

```
Tool: executor.coreTools.connections.createHandoff
Return a browser URL that opens the Add account flow for one integration.
Use this for API keys/tokens so the user enters secrets directly in the web UI.
Optionally preselect owner, auth template, and a non-secret label.

Input:
{ integration: string; owner?: "org" | "user" | null; template?: string | null; label?: string | null; }

Output:
{ url: string; instructions: string; }
```

This returns a `http://localhost:4788/...` URL the user must open in a browser to enter the credential.

---

### A.3 OAuth tools schemas

```
executor call executor coreTools oauth.clients.create --help
```
```
Input:
{
  owner: "org" | "user"; slug: string; authorizationUrl: string; tokenUrl: string;
  grant: "authorization_code" | "client_credentials"; clientId: string; resource?: string | null;
}
```
**Explicitly EXCLUDES client secret** — the description says "Register or replace an owner-scoped OAuth client WITHOUT a client secret: a PUBLIC client (PKCE / authorization_code) or a discovery-prefill placeholder. To register a CONFIDENTIAL client that has a secret, call `oauth.clients.createHandoff` instead."

```
executor call executor coreTools oauth.probe --help
```
```
Input:  { url: string; }
Output: { authorizationUrl, tokenUrl, resource?, scopesSupported?, registrationEndpoint?,
          tokenEndpointAuthMethodsSupported? }
```

```
executor call executor coreTools oauth.start --help
```
```
Input:
{ client: string; clientOwner: "org" | "user"; owner: "org" | "user"; name: string;
  integration: string; template: string; identityLabel?: string | null; redirectUri?: string | null; }
Output: { status: "connected"; connection: {...} } | { status: "redirect"; authorizationUrl: string; state: string; }
```
`client_credentials` clients (machine-to-machine OAuth, no user) return `status:"connected"` immediately — fully programmatic.

---

### A.4 Available credential providers

```bash
executor call executor coreTools providers list
# → { "providers": ["keychain", "file", "onepassword"] }
```

**`providers.items`** (read-only browse — returns `{ id, name }` pairs, never values):
```bash
executor call executor coreTools providers items '{"provider":"keychain"}'
executor call executor coreTools providers items '{"provider":"file"}'
executor call executor coreTools providers items '{"provider":"onepassword"}'
```

**There is no `providers.add`, `providers.create`, or any write tool for the `file` or `keychain` provider.** The full executor management tool list (34 tools) contains no credential-write path for either. Standard macOS Keychain entries written via `security add-generic-password` do NOT appear in executor's `keychain` provider — executor uses its own keychain namespace.

---

### A.5 1Password namespace (the one programmatically configurable provider)

```
executor call executor onepassword configure --help
```

```
Tool: executor.onepassword.configure
Configure the 1Password credential provider for the acting owner.
Use desktop-app auth for local biometric access, or service-account auth with the token.
The token is stored in the plugin's owner-partitioned config and never surfaced again.

Input:
{
  auth: { kind: "desktop-app"; accountName: string; }
       | { kind: "service-account"; token: string; };
  vaultId: string;
  name: string;
}
Output: { configured: boolean; }
```

Other 1Password tools:
- `onepassword.status` → `{ connected: boolean; vaultName?, error? }` (no secrets)
- `onepassword.getConfig` → returns `{ auth: { kind, accountName? }, vaultId, name }` (no token value)
- `onepassword.listVaults` → `{ vaults: [{ id, name }] }` — accepts service-account token inline
- `onepassword.removeConfig` — removes provider config

**This is 1Password-specific** — there is no plugin/extension API to register a custom secret provider (e.g., Doppler). The `onepassword` namespace is a hard-coded integration, not a generic "external secret provider" framework.

---

### A.6 Verdict for Area A

**There is no fully-direct programmatic path.** Inline credential values are never accepted by `connections.create`. The hierarchy of options, best-first:

#### Option 1 — Machine-to-machine OAuth (best if the integration supports it)
For integrations with OAuth `client_credentials` grant:
```bash
# Register public OAuth client (no secret needed for client_credentials with PKCE)
executor call executor coreTools oauth.clients.create \
  '{"owner":"org","slug":"my-m2m-client","authorizationUrl":"https://...","tokenUrl":"https://...","grant":"client_credentials","clientId":"<id>"}'

# Mint connection immediately (no browser redirect for client_credentials)
executor call executor coreTools oauth.start \
  '{"client":"my-m2m-client","clientOwner":"org","owner":"org","name":"default","integration":"my-api","template":"oauth2"}'
# → { "status": "connected", "connection": {...} }
```

#### Option 2 — 1Password service account as the Doppler bridge
Requires a 1Password account with API. Configure once, no human interaction after:
```bash
# Step 1: configure 1Password provider with service-account token (fully programmatic)
executor call executor onepassword configure \
  '{"auth":{"kind":"service-account","token":"<OP_SERVICE_ACCOUNT_TOKEN>"},"vaultId":"<VAULT_ID>","name":"dispatch-vault"}'

# Step 2: find the 1Password item ID for the secret
executor call executor coreTools providers items '{"provider":"onepassword"}'
# → { "items": [{ "id": "abc123", "name": "My API Key" }] }

# Step 3: create connection referencing 1Password item
executor call executor coreTools connections create \
  '{"owner":"org","name":"default","integration":"my-api","template":"apikey-0","from":{"provider":"onepassword","id":"abc123"}}'
```

Doppler → 1Password sync uses Doppler's native 1Password integration or OP CLI (`op item edit ...`). 
Verdict: **viable two-hop bridge (Doppler → 1Password → executor)** with no human interaction after initial setup.

#### Option 3 — Web handoff (human required)
```bash
executor call executor coreTools connections createHandoff \
  '{"integration":"my-api","owner":"org","template":"apikey-0","label":"My API Key"}'
# → { "url": "http://localhost:4788/...", "instructions": "..." }
```
User must visit URL in browser and enter the credential. Not suitable for automated Dispatch provisioning.

#### Option 4 — No-auth connection (only for public APIs)
```bash
executor call executor coreTools connections create \
  '{"owner":"org","name":"default","integration":"my-api","template":"none"}'
```
Only works for integrations with no auth requirement.

---

## Area B — Export / Import Feasibility

### Goal
Move a catalog of integrations to a different executor daemon instance.

---

### B.1 Per-integration get* calls

#### MCP — `mcp.getServer`
```bash
executor call executor mcp getServer '{"slug":"my-mcp"}'
```
**Returns:**
```json
{
  "ok": true,
  "data": {
    "integration": {
      "slug": "test-mcp",
      "name": "Test MCP",
      "description": "Test MCP",
      "kind": "mcp",
      "canRemove": true,
      "canRefresh": true,
      "authMethods": [],
      "config": {
        "transport": "stdio",
        "command": "echo",
        "args": ["hello"]
      }
    }
  }
}
```
**Round-trip gap:** None for stdio. Returns `transport`, `command`, `args` — exact fields needed for `mcp.addServer`. For `remote` transport, returns `endpoint` and `auth` headers.

#### GraphQL — `graphql.getIntegration`
```bash
executor call executor graphql getIntegration '{"slug":"countries-test"}'
```
**Returns:**
```json
{
  "ok": true,
  "data": {
    "integration": {
      "endpoint": "https://countries.trevorblades.com/graphql",
      "name": "Countries",
      "authenticationTemplate": []
    }
  }
}
```
**Round-trip gap:** None. Returns `endpoint`, `name`, `authenticationTemplate` — exact fields for `graphql.addIntegration`.

#### OpenAPI — no `openapi.getSpec`
There are only 2 tools in the `openapi` namespace: `addSpec` and `previewSpec`. **No get/export tool exists.**

However the HTTP API detail endpoint returns `displayUrl`:
```bash
TOKEN=$(python3 -c "import json; print(json.load(open('~/.executor/server-control/auth.json'))['token'])")
curl -s "http://localhost:4788/api/integrations/petstore-test" -H "Authorization: Bearer $TOKEN"
# → {"slug":"petstore-test","displayUrl":"https://petstore3.swagger.io/api/v3/openapi.json",...}
```
`displayUrl` = the source URL originally passed to `addSpec`. Round-trip replay: `addSpec '{"spec":{"kind":"url","url":"<displayUrl>"},"slug":"..."}'`.

**Round-trip gap for OpenAPI:** If the spec was added as a `blob` (inline JSON, not URL), `displayUrl` is null — the spec cannot be retrieved via CLI or HTTP API. The full spec IS stored in the `blob` SQLite table (content-addressed by SHA256), so it's in `data.db` but not exposed through any API endpoint.

---

### B.2 Bulk HTTP export

```bash
GET /api/export   → 404 (does not exist)
GET /api/backup   → 404 (does not exist)
GET /api/dump     → 404 (does not exist)
```

The HTTP API (`http://localhost:4788/api`) has these confirmed endpoints:
- `GET /api/integrations` — array of all integrations (with `displayUrl` for OpenAPI, but NO auth template details beyond `authMethods[].kind`)
- `GET /api/integrations/{slug}` — detail for one integration (same fields)
- `GET /api/connections` — array of saved connections (no credential values, only `provider` + internal `address`)
- `GET /api/providers` — `["keychain","file","onepassword"]`
- `DELETE /api/integrations/{slug}` — remove integration

**No bulk export endpoint exists.**

---

### B.3 SQLite database copy

Location: `~/.executor/data.db` (plus WAL files while daemon is running)

```
~/.executor/data.db        — main SQLite file (4 KB base, minimal until WAL checkpoint)
~/.executor/data.db-shm    — shared memory for WAL (32 KB)
~/.executor/data.db-wal    — write-ahead log (contains all runtime data until checkpoint; ~320 KB with 3 integrations)
```

**Database schema** (confirmed from inspection):

| Table | Contents |
|-------|----------|
| `integration` | slug, plugin_id (openapi/mcp/graphql), name, description, config (JSON blob with sourceUrl/endpoint/command+args), canRemove, timestamps |
| `connection` | integration, owner, name, template, provider, item_ids (JSON with credential item references), oauth metadata |
| `oauth_client` | slug, authorizationUrl, tokenUrl, grant, clientId, `client_secret_item_id` (reference to provider item) |
| `oauth_session` | active OAuth in-flight sessions |
| `tool` / `definition` | populated after connection create (tool metadata) |
| `tool_policy` | permission policies |
| `plugin_storage` | per-plugin data (OpenAPI: `operation` rows with full endpoint bindings) |
| `blob` | content-addressed storage: OpenAPI specs stored as full JSON keyed by SHA256 hash |
| `private_executor_local_settings` | local config |
| `data_migration` | migration history |

**Credential storage:** The `connection.item_ids` stores `{"token": "<provider-item-id>"}` — a REFERENCE to a credential in an external provider (`keychain`, `file`, `onepassword`). The credential value itself is NEVER in SQLite. The `oauth_client.client_secret_item_id` is similarly a reference.

**Copying data.db:**
- Stop daemon first: `executor daemon stop`
- Copy all 3 files: `cp ~/.executor/data.db{,-shm,-wal} /dest/`  
  OR checkpoint WAL first (`PRAGMA wal_checkpoint(FULL)` via sqlite3 CLI), then copy only `data.db`
- Restart daemon with the new data directory
- **Copies everything** including OAuth tokens and credential provider references (but NOT the actual secret values — those must be set up in the provider on the target machine)

---

### B.4 Verdict for Area B

**Best export/import approach: hybrid per-integration replay for known-URL integrations, data.db copy for everything else.**

| Integration type | Best approach | Round-trip gap |
|-----------------|---------------|----------------|
| MCP (stdio/remote) | `mcp.getServer` → `mcp.addServer` | None — config fully reconstructed |
| GraphQL | `graphql.getIntegration` → `graphql.addIntegration` | None — endpoint+auth fully reconstructed |
| OpenAPI (URL-based) | `GET /api/integrations/{slug}` → `addSpec` with `displayUrl` | None if URL is still live |
| OpenAPI (blob/inline spec) | data.db `blob` table extraction only | No API; must manually extract from SQLite |
| Credentials/OAuth tokens | Not exportable via API | Must re-run `createHandoff` or `oauth.start` on target; OR restore entire `data.db` (copies provider references, but external provider must be configured on target) |

**Recommended per-integration export script:**
```bash
TOKEN=$(python3 -c "import json; print(json.load(open('/Users/davidwebber/.executor/server-control/auth.json'))['token'])")
# Get all integrations with displayUrl
curl -s "http://localhost:4788/api/integrations" -H "Authorization: Bearer $TOKEN"
# For each mcp slug: executor call executor mcp getServer '{"slug":"<slug>"}'
# For each graphql slug: executor call executor graphql getIntegration '{"slug":"<slug>"}'
```

**For a full catalog move with credentials:** copy `data.db` after stopping the daemon, then re-configure credential providers on the target machine. OAuth tokens and API key references will work only if the same provider (1Password vault, keychain) is available on the target.

---

## Area C — Does `executor mcp` (stdio) Expose Management Tools?

### Goal
Confirm whether an agent connected to `executor mcp` (the stdio MCP server) can call `openapi.addSpec`, `mcp.addServer`, `graphql.addIntegration`, `coreTools.*` — or only integration-use tools.

---

### C.1 Probe method

```bash
# Stop daemon first (executor mcp starts its own internal daemon)
executor daemon stop

# Send newline-delimited JSON-RPC over stdin
python3 - <<'EOF'
import subprocess, json, time, threading

proc = subprocess.Popen(
    ['executor', 'mcp'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0
)

# NOTE: executor mcp uses newline-delimited JSON (NOT Content-Length framing)
# Content-Length framing produces zero stdout output.

lines = []
def reader():
    buf = b''
    while True:
        c = proc.stdout.read(1)
        if not c: break
        if c == b'\n':
            lines.append(buf.decode()); buf = b''
        else: buf += c

threading.Thread(target=reader, daemon=True).start()
time.sleep(2)

def send(msg):
    proc.stdin.write((json.dumps(msg)+'\n').encode()); proc.stdin.flush()

send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'probe','version':'1'}}})
time.sleep(1)
send({'jsonrpc':'2.0','method':'notifications/initialized','params':{}})
time.sleep(0.5)
send({'jsonrpc':'2.0','id':3,'method':'tools/list','params':{}})
time.sleep(4)
proc.terminate()

for line in lines:
    obj = json.loads(line)
    if obj.get('id') == 3:
        print([t['name'] for t in obj['result']['tools']])
EOF
# → ['execute', 'resume']
```

---

### C.2 Full tool list returned by `executor mcp`

**Total: 2 tools.**

| Tool | Description |
|------|-------------|
| `execute` | Run TypeScript in a sandboxed runtime with access to configured API tools. Input: `{ code: string }`. The TypeScript runs against a `tools` proxy that exposes all configured integrations by address. |
| `resume` | Resume a paused execution (approval/elicitation). Input: `{ executionId, action, content? }`. Only present because `--elicitation-mode model` is defaulted. |

**No management tools are exposed:** `openapi`, `mcp`, `graphql`, `coreTools`, `onepassword`, `desktopSettings` do NOT appear in the MCP tools list.

---

### C.3 What `execute` CAN reach (indirect access)

The `execute` tool runs a TypeScript code snippet that has access to ALL configured tools via the `tools` proxy, INCLUDING executor's own management namespace. From the tool description:

> Use `tools.executor.coreTools.connections.list({})` when you need live saved-connection inventory.

This means an agent connected via `executor mcp` CAN call management operations by writing TypeScript inside `execute`:

```typescript
// Example: list all connections
const { connections } = await tools.executor.coreTools.connections.list({});

// Example: add an integration (if executor's own management tools are accessible)
// The tool address follows: tools.<integration>.<owner>.<connection>.<tool>(args)
// executor management tools: tools.executor.<ns>.<action>(args) where ns = openapi, mcp, graphql, etc.
```

**However:** management operations via `execute` will still trigger the same elicitation/approval flow that direct `executor call` triggers. The `resume` tool handles those approvals.

---

### C.4 Verdict for Area C

**NO — `executor mcp` does NOT expose management tools as first-class MCP tools.**

The MCP tool list contains only `execute` and `resume`. There is no `openapi__addSpec`, `mcp__addServer`, `graphql__addIntegration`, or any `coreTools.*` MCP tool.

**Implication for Phase 5 ("agent-assisted add"):**
- An agent connected via `executor mcp` CANNOT call `openapi.addSpec` directly as an MCP tool call.
- It CAN call management operations INDIRECTLY by writing TypeScript in the `execute` tool — but this requires the agent to know the executor management tool paths and to handle the approval resume flow.
- For Dispatch's "agent-assisted add" feature: the agent must use `execute` with TypeScript that calls `tools.executor.openapi.addSpec(...)` etc., then use `resume` to approve. This is more complex than direct MCP tool calls.
- **Alternative:** Use `executor call` (HTTP CLI) directly from the Dispatch daemon — this is simpler and more reliable for management operations than going through the MCP stdio interface.

---

## Summary of Verdicts

### Area A — Credential injection
**Best programmatic path: 1Password service account (two-hop: Doppler → 1Password → executor).**

```bash
# Configure once:
executor call executor onepassword configure \
  '{"auth":{"kind":"service-account","token":"<OP_TOKEN>"},"vaultId":"<VAULT_ID>","name":"dispatch-vault"}'

# Per connection:
executor call executor coreTools providers items '{"provider":"onepassword"}'
# Note the item id for your secret, then:
executor call executor coreTools connections create \
  '{"owner":"org","name":"default","integration":"<slug>","template":"<template-id>","from":{"provider":"onepassword","id":"<item-id>"}}'
```

Direct injection (passing the API key value) is impossible — `connections.create` has no `secret`/`value` field. The `createHandoff` web-UI route requires human interaction. No custom provider plugin mechanism exists.

### Area B — Export/import
**Best approach: per-integration CLI replay for MCP and GraphQL; `displayUrl` from HTTP API for OpenAPI (URL-based specs); `data.db` WAL copy for a full-catalog move.**

Round-trip gaps:
- MCP stdio: zero gap (`getServer` → `addServer`)
- GraphQL: zero gap (`getIntegration` → `addIntegration`)
- OpenAPI URL: zero gap (HTTP `/api/integrations/{slug}` `displayUrl` → `addSpec`)
- OpenAPI blob: gap — spec only in SQLite `blob` table, no API
- Credentials: never exported; must be re-provisioned on target (provider references copy in `data.db` but the provider itself must exist on the target machine)

### Area C — Management tools in MCP interface
**NO.** `executor mcp` exposes only 2 tools: `execute` (TypeScript sandbox) and `resume` (approval). Management tools (`openapi.addSpec`, `mcp.addServer`, `graphql.addIntegration`, `coreTools.*`) are not in the MCP tool list. They are indirectly reachable by writing TypeScript inside `execute`, but this complicates the integration flow. Direct `executor call` commands from the Dispatch daemon are the recommended path for management operations.
