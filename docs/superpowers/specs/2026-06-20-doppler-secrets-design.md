# Dispatch × Doppler — Secret Management Integration

**Date:** 2026-06-20
**Branch:** `feat/doppler-secrets` (worktree of `~/Sites/dispatch`)
**Primary runtime:** the **mini** (becomes primary dev host); MacBook also supported. Code ships
to both via git; the token, built MCP server, and authed CLIs are **per-host**.

## Decisions (confirmed)
1. **Agent mechanism:** a **custom lean stdio MCP server** (`packages/doppler-mcp`, 4 tools) wired
   into spawned Claude Code (`--mcp-config`) and Codex (`-c mcp_servers.*`).
2. **Token:** a **cross-project Doppler Service Account token** (`dp.sa.…`), entered in Settings →
   Secrets, stored in a **0600 file** on the host — never in `app_state`, never returned to clients.
3. **Scope now:** build + deploy the feature to both hosts. Provisioning the mini's `claude`/`codex`
   (interactive sign-in) is the user's follow-up; agents run wherever those CLIs are authed.

## Goal
Manage secrets in Doppler from Dispatch: a **Settings → Secrets** UI for connect/list/add/edit/
delete, and **Claude Code + Codex agents that can add/retrieve secrets** during runs via MCP tools —
with a low-leak path (`doppler`-style env injection) for "use a secret without printing it".

## Components

### 1. `packages/doppler-mcp` (new standalone workspace package)
- stdio MCP server: `@modelcontextprotocol/sdk@^1.29` + `zod@^3.25`, `StdioServerTransport`,
  `McpServer.registerTool` (inputSchema = ZodRawShape, **not** `z.object`). Logs to **stderr only**.
- Tools: `doppler_list_secrets`, `doppler_get_secret`, `doppler_set_secret`, `doppler_delete_secret`.
  Each accepts optional `project`/`config` overriding the env defaults.
- Reads `DOPPLER_TOKEN` (required, exit 1 if missing), `DOPPLER_PROJECT`, `DOPPLER_CONFIG`,
  `DOPPLER_READ_ONLY`. When read-only, the `set`/`delete` tools are **not registered**.
- Calls Doppler REST v3 (`Authorization: Bearer`): list `GET /v3/configs/config/secrets`,
  get `GET /v3/configs/config/secret`, set `POST /v3/configs/config/secrets` (`{secrets:{NAME:value}}`,
  `null` value = delete), delete `DELETE /v3/configs/config/secret`. Built-in `fetch`. Build → `dist/index.js`.

### 2. Core — Doppler client + secrets service (`packages/core/src/secrets/`)
- `doppler.ts` — `DopplerClient(token)`: `listProjects()`, `listConfigs(project)`, `listSecrets(p,c)`,
  `getSecret(p,c,name)`, `setSecret(p,c,name,value)`, `deleteSecret(p,c,name)`, `verify()` (lists
  projects to validate the token). Pure REST wrapper, unit-tested with mocked `fetch`.
- `service.ts` — `SecretsService`:
  - Connection persisted to **`~/.dispatch/doppler.json` (mode 0600)**:
    `{ token, project, config, enabled, readOnly }`. `DOPPLER_TOKEN` env is a fallback for `token`.
  - `status()` → `{ connected, project, config, enabled, readOnly }` (**never** the token).
  - `setConnection({token,project,config,enabled,readOnly})` (verifies token before saving),
    `disconnect()`.
  - `getSpawnEnv()` → `{ DOPPLER_TOKEN, DOPPLER_PROJECT, DOPPLER_CONFIG, DOPPLER_READ_ONLY }` when
    enabled, else `{}`.
  - `ensureClaudeMcpConfig()` → writes `~/.dispatch/doppler.mcp.json`
    (`{mcpServers:{doppler:{command:"node",args:[<dist>],env:{DOPPLER_TOKEN:"${DOPPLER_TOKEN}", …}}}}`
    — token **by reference**, never literal) and returns its path, or null when disabled.
  - `codexMcpArgs()` → `['-c','mcp_servers.doppler.command="node"', '-c','mcp_servers.doppler.args=[…]',
    '-c','mcp_servers.doppler.env_vars=["DOPPLER_TOKEN","DOPPLER_PROJECT","DOPPLER_CONFIG"]']` or `[]`.
  - Resolves the doppler-mcp dist path relative to the install (built alongside core).

### 3. Core — routes (`routes/secrets.ts`, mounted in `createApp` + `startServer`)
- `GET /api/secrets/status` → connection status (no token).
- `PUT /api/secrets/connection` `{token,project,config,enabled,readOnly}` → verify + save.
- `DELETE /api/secrets/connection` → disconnect.
- `GET /api/secrets/projects`, `GET /api/secrets/configs?project=` → for the UI pickers.
- `GET /api/secrets?project=&config=` → secret names + values (the user's own local manager; UI masks
  with reveal). `POST /api/secrets` `{name,value}` upsert. `DELETE /api/secrets/:name`.
- All 5xx-safe; values never logged.

### 4. Core — inject into spawned CLIs (providers + sessions)
- `providers/types.ts`: extend the build-arg type with optional
  `secretsMcp?: { claudeConfigPath?: string | null; codexArgs?: string[] }`.
- `claude-code.ts` `buildNewCommand/buildResumeCommand/buildRunnerCommand`: when `claudeConfigPath`,
  append `--mcp-config <path>` (additive — **no** `--strict-mcp-config`, so the user's other MCP
  servers still load).
- `codex.ts` same three: when `codexArgs`, splice them in after the subcommand.
- `sessions/service.ts` `spawnTerminal`: obtain the injection from `SecretsService` and pass it to the
  provider build call; the `DOPPLER_*` env is added globally via `PTYManager` `defaultEnv`.
- `server.ts`: construct `SecretsService`; mount the router; on startup + on connection change, set
  `ptyManager.setDefaultEnv({...browserShimEnv, ...secrets.getSpawnEnv()})` and refresh the claude
  MCP config file. (Injection applies to interactive **and** runner/agent terminals.)

### 5. Web — Settings → Secrets section
- `stores/secrets.ts` — server-backed zustand store (mirror `stores/servers.ts`, **not** the
  localStorage settings store): `status`, `secrets`, `projects`, `configs`, `loadStatus`,
  `connect`, `disconnect`, `loadSecrets`, `setSecret`, `deleteSecret`.
- `api/client.ts` — add the `/api/secrets*` methods.
- `SettingsModal.tsx` — a `SecretsSection` (copy the `ServersSection` pattern + a trailing `<Divider/>`):
  connect form (token + project/config pickers), connection status chip, secret list with masked
  values + reveal, add/edit/delete, and a **read-only agent access** toggle. Phosphor icons (`Key`,
  `Eye`/`EyeSlash`, `Plus`, `Trash`).

## Security
- Token: 0600 file, by-reference (`${DOPPLER_TOKEN}`) into MCP config, never in `args` (ps leak),
  never returned by any GET, never logged.
- `--dangerously-skip-permissions`/broad sandbox means agents auto-approve MCP tools → enforce
  read-only at the **server + token scope**, not CLI permission rules. The `readOnly` toggle omits the
  write tools and is reinforced by using a read-scoped token where desired.
- Retrieved values enter the model transcript by design (the feature asks for it); document this and
  prefer env-presence over `get` when a task only needs a secret to be available.

## Testing
- Unit (TDD): `DopplerClient` (mocked fetch — list/get/set/delete/verify), `SecretsService`
  (0600 file round-trip, status hides token, getSpawnEnv/mcp-config generation, readOnly omits write),
  `routes/secrets` (status never leaks token; CRUD happy/ził paths with a mocked client).
- `doppler-mcp`: a stdio smoke (list tools; a get/set round-trip against a mocked Doppler or the MCP
  inspector) — verified manually before wiring.
- Provider tests: claude args include `--mcp-config` when injected; codex args include the `-c` block.
- Keep core + web suites green.

## Build sequence
1. `packages/doppler-mcp` (standalone) + smoke.
2. Core `DopplerClient` (TDD) → `SecretsService` (TDD) → `routes/secrets.ts` (TDD) + mount.
3. Provider/types + claude/codex `build*` injection + `spawnTerminal` wiring + `server.ts` defaultEnv/MCP refresh.
4. Web store + client + `SecretsSection`.
5. Tests green; build; **deploy to the mini first** (primary), then the MacBook.

**Deploy note:** web+core changes need `dispatch build` + restart on each host (the MacBook restart
ends this session — do it last). The doppler-mcp package builds with core. Mini agents won't *run*
until its `claude`/`codex` are installed + signed in (user's follow-up).
