# Own MCP-centric Integration Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the executor-backed integration layer with a Dispatch-owned catalog of MCP servers that injects into both Claude and Codex via the existing `composeInjection`, with secrets supplied by the existing Doppler env injection.

**Architecture:** A new `integrations` SQLite table holds MCP-server definitions (stdio command, or remote URL bridged via `mcp-remote`). `IntegrationsService` does catalog CRUD and resolves enabled rows to `McpServerSpec[]`, which the spawn path feeds into `composeInjection` alongside the Doppler spec. executor is removed entirely.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, Express, vitest + supertest (core); React + Vite (web). Remote MCP via `mcp-remote` (npx, v0.1.x).

## Global Constraints

- ESM with `.js` import specifiers in all core TypeScript imports.
- `composeInjection` (`packages/core/src/mcp/injection.ts`) is UNCHANGED — it already takes `McpServerSpec[]` (`{ name, command, args, env?, envVars? }`) and emits the Claude `--mcp-config` file + Codex `-c mcp_servers.<name>…` args. Feed it; don't modify it.
- Remote MCP servers are injected as a stdio spec: `{ command: 'npx', args: ['-y', 'mcp-remote', <url>, ...headerArgs] }`. Header args are `['--header', '<HeaderName>:<value>']` per header; for secrets the value is `${VAR}` (no spaces around `:`), resolved at runtime from the spawned process env (Doppler is ambient). Secret VALUES are never written into the catalog-derived `env` of the config file.
- The MCP-server key (`McpServerSpec.name`, used as the Codex `-c mcp_servers.<name>` path and the Claude config object key) must be a bare slug. Integration `name` is validated `^[a-zA-Z0-9_-]+$` and is unique (case-insensitive); the name is used directly as the spec key.
- Doppler injection, the injection seam, the Settings Integrations tab, and the MVP cross-provider behavior are preserved. executor (`executor --version` status, `executor mcp` spec, `executor call` management, `/detect`, the system-prompt hint) is removed.
- Secrets are supplied via the ambient Doppler env that every terminal already receives (`SecretsService.getSpawnEnv()`); spawned MCP servers inherit it. No new secret storage.

---

### Task 1: Catalog table + `db/integrations.ts`

**Files:**
- Modify: `packages/core/src/db/schema.ts` (add the `integrations` table in `initSchema`)
- Create: `packages/core/src/db/integrations.ts`
- Test: `packages/core/tests/db/integrations.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  - `interface Integration { id: string; name: string; type: 'stdio' | 'remote'; command: string | null; args: string[]; url: string | null; headers: Record<string,string>; env: Record<string,string>; enabled: boolean; createdAt: string; updatedAt: string }`
  - `interface CreateIntegrationInput { id: string; name: string; type: 'stdio'|'remote'; command?: string | null; args?: string[]; url?: string | null; headers?: Record<string,string>; env?: Record<string,string>; enabled?: boolean }`
  - `create(db, input): Integration`, `list(db): Integration[]`, `getById(db, id): Integration | null`, `remove(db, id): void`, `setEnabled(db, id, enabled): Integration | null`, `rowToIntegration(row): Integration`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/db/integrations.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as integrationsDb from '../../src/db/integrations.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('integrations db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('creates and reads a remote integration with JSON round-trips', () => {
    const created = integrationsDb.create(d, { id: 'i1', name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', headers: { Authorization: '${LINEAR}' } });
    expect(created).toMatchObject({ id: 'i1', name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse', headers: { Authorization: '${LINEAR}' }, args: [], env: {}, enabled: true });
    const got = integrationsDb.getById(d, 'i1');
    expect(got).toEqual(created);
  });

  it('creates a stdio integration with args + env', () => {
    const created = integrationsDb.create(d, { id: 'i2', name: 'fs', type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } });
    expect(created).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' }, url: null, headers: {} });
  });

  it('lists in creation order and removes', () => {
    integrationsDb.create(d, { id: 'a', name: 'a', type: 'stdio', command: 'x' });
    integrationsDb.create(d, { id: 'b', name: 'b', type: 'stdio', command: 'y' });
    expect(integrationsDb.list(d).map((i) => i.id)).toEqual(['a', 'b']);
    integrationsDb.remove(d, 'a');
    expect(integrationsDb.list(d).map((i) => i.id)).toEqual(['b']);
  });

  it('toggles enabled and returns the updated row', () => {
    integrationsDb.create(d, { id: 'i', name: 'i', type: 'stdio', command: 'x' });
    expect(integrationsDb.setEnabled(d, 'i', false)?.enabled).toBe(false);
    expect(integrationsDb.getById(d, 'i')?.enabled).toBe(false);
    expect(integrationsDb.setEnabled(d, 'missing', false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/db/integrations.test.ts`
Expected: FAIL — module `db/integrations.js` not found.

- [ ] **Step 3: Add the table**

In `packages/core/src/db/schema.ts`, inside the `db.exec(\`…\`)` block, add this table after the `app_state` table (before the closing backtick):

```sql
    CREATE TABLE IF NOT EXISTS integrations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      command     TEXT,
      args        TEXT DEFAULT '[]',
      url         TEXT,
      headers     TEXT DEFAULT '{}',
      env         TEXT DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
```

- [ ] **Step 4: Create the db module**

Create `packages/core/src/db/integrations.ts`:

```ts
import type Database from 'better-sqlite3';

export interface IntegrationRow {
  id: string; name: string; type: string;
  command: string | null; args: string | null;
  url: string | null; headers: string | null; env: string | null;
  enabled: number; created_at: string; updated_at: string;
}

export interface Integration {
  id: string; name: string; type: 'stdio' | 'remote';
  command: string | null; args: string[];
  url: string | null; headers: Record<string, string>; env: Record<string, string>;
  enabled: boolean; createdAt: string; updatedAt: string;
}

export interface CreateIntegrationInput {
  id: string; name: string; type: 'stdio' | 'remote';
  command?: string | null; args?: string[];
  url?: string | null; headers?: Record<string, string>; env?: Record<string, string>;
  enabled?: boolean;
}

function parseObj(s: string | null): Record<string, string> { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
function parseArr(s: string | null): string[] { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v : []; } catch { return []; } }

export function rowToIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id, name: row.name, type: row.type === 'remote' ? 'remote' : 'stdio',
    command: row.command, args: parseArr(row.args),
    url: row.url, headers: parseObj(row.headers), env: parseObj(row.env),
    enabled: !!row.enabled, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function create(db: Database.Database, input: CreateIntegrationInput): Integration {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO integrations (id, name, type, command, args, url, headers, env, enabled, created_at, updated_at)
    VALUES (@id, @name, @type, @command, @args, @url, @headers, @env, @enabled, @created_at, @updated_at)`).run({
    id: input.id, name: input.name, type: input.type,
    command: input.command ?? null, args: JSON.stringify(input.args ?? []),
    url: input.url ?? null, headers: JSON.stringify(input.headers ?? {}), env: JSON.stringify(input.env ?? {}),
    enabled: input.enabled === false ? 0 : 1, created_at: now, updated_at: now,
  });
  return getById(db, input.id)!;
}

export function list(db: Database.Database): Integration[] {
  return (db.prepare('SELECT * FROM integrations ORDER BY created_at ASC, id ASC').all() as IntegrationRow[]).map(rowToIntegration);
}

export function getById(db: Database.Database, id: string): Integration | null {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
  return row ? rowToIntegration(row) : null;
}

export function remove(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
}

export function setEnabled(db: Database.Database, id: string, enabled: boolean): Integration | null {
  const res = db.prepare('UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, new Date().toISOString(), id);
  return res.changes > 0 ? getById(db, id) : null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run tests/db/integrations.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/integrations.ts packages/core/tests/db/integrations.test.ts
git commit -m "feat(core): integrations catalog table + db module"
```

---

### Task 2: `IntegrationsService` rewrite (catalog CRUD + getServerSpecs); remove executor

**Files:**
- Rewrite: `packages/core/src/integrations/service.ts`
- Delete: `packages/core/tests/integrations/service-installed.test.ts`, `packages/core/tests/integrations/management.test.ts`
- Rewrite: `packages/core/tests/integrations/service.test.ts`

**Interfaces:**
- Consumes: `db/integrations` (Task 1); `McpServerSpec` from `../mcp/injection.js`.
- Produces (consumed by Tasks 3 & 4):
  - `type AddIntegrationInput = { type: 'remote'; name: string; url: string; headers?: Record<string,string>; env?: Record<string,string> } | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string,string> }`
  - `interface IntegrationsExport { version: 1; integrations: Omit<Integration,'id'|'createdAt'|'updatedAt'>[] }`
  - class `IntegrationsService` with `constructor(db)`, `list(): Integration[]`, `add(input): Integration`, `remove(id): { removed: boolean }`, `setEnabled(id, enabled): Integration | null`, `getServerSpecs(): McpServerSpec[]`, `export(): IntegrationsExport`, `import(doc): { added: string[]; skipped: string[] }`, and static `validate(input): string | null`.

- [ ] **Step 1: Write the failing tests**

Delete the two executor test files, then rewrite `packages/core/tests/integrations/service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { IntegrationsService } from '../../src/integrations/service.js';

function svc() { const d = new Database(':memory:'); initSchema(d); return new IntegrationsService(d); }

describe('IntegrationsService', () => {
  let s: IntegrationsService;
  beforeEach(() => { s = svc(); });

  it('adds a remote integration and lists it', () => {
    const i = s.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    expect(i.name).toBe('linear');
    expect(s.list().map((x) => x.name)).toEqual(['linear']);
  });

  it('rejects invalid names and bad input via validate()', () => {
    expect(IntegrationsService.validate({ type: 'remote', name: 'has space', url: 'https://x' })).toMatch(/name/);
    expect(IntegrationsService.validate({ type: 'remote', name: 'ok', url: 'not-a-url' })).toMatch(/url/);
    expect(IntegrationsService.validate({ type: 'stdio', name: 'ok' })).toMatch(/command/);
    expect(IntegrationsService.validate({ type: 'remote', name: 'ok', url: 'https://x' })).toBeNull();
  });

  it('rejects a duplicate name (case-insensitive)', () => {
    s.add({ type: 'stdio', name: 'fs', command: 'x' });
    expect(() => s.add({ type: 'stdio', name: 'FS', command: 'y' })).toThrow(/exists/);
  });

  it('getServerSpecs resolves stdio directly', () => {
    s.add({ type: 'stdio', name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } });
    expect(s.getServerSpecs()).toEqual([{ name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } }]);
  });

  it('getServerSpecs wraps remote via mcp-remote with header args (secrets stay as ${VAR})', () => {
    s.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse', headers: { Authorization: '${LINEAR}' } });
    expect(s.getServerSpecs()).toEqual([{ name: 'linear', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse', '--header', 'Authorization:${LINEAR}'] }]);
  });

  it('getServerSpecs skips disabled rows', () => {
    const i = s.add({ type: 'stdio', name: 'fs', command: 'x' });
    s.setEnabled(i.id, false);
    expect(s.getServerSpecs()).toEqual([]);
  });

  it('export omits id/timestamps; import replays and skips existing names', () => {
    s.add({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    const doc = s.export();
    expect(doc.version).toBe(1);
    expect(doc.integrations[0]).not.toHaveProperty('id');
    const s2 = svc();
    expect(s2.import(doc)).toEqual({ added: ['linear'], skipped: [] });
    // re-import into the same store skips the existing name
    expect(s2.import(doc)).toEqual({ added: [], skipped: ['linear'] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/integrations/service.test.ts`
Expected: FAIL — `IntegrationsService` constructor/method signatures don't match (still the executor version).

- [ ] **Step 3: Rewrite the service**

Replace the entire contents of `packages/core/src/integrations/service.ts` with:

```ts
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import * as integrationsDb from '../db/integrations.js';
import type { Integration } from '../db/integrations.js';
import type { McpServerSpec } from '../mcp/injection.js';

export type AddIntegrationInput =
  | { type: 'remote'; name: string; url: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> };

export type ExportedIntegration = Omit<Integration, 'id' | 'createdAt' | 'updatedAt'>;
export interface IntegrationsExport { version: 1; integrations: ExportedIntegration[] }

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class IntegrationsService {
  constructor(private db: Database.Database) {}

  /** Returns an error string if the input is invalid, else null. */
  static validate(input: any): string | null {
    if (!input || typeof input !== 'object') return 'body required';
    if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) return 'name must match ^[a-zA-Z0-9_-]+$ (no spaces)';
    if (input.type === 'remote') {
      if (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url)) return 'remote requires an http(s) url';
      return null;
    }
    if (input.type === 'stdio') {
      if (typeof input.command !== 'string' || !input.command.trim()) return 'stdio requires a command';
      return null;
    }
    return `unknown integration type: ${String(input.type)}`;
  }

  list(): Integration[] { return integrationsDb.list(this.db); }

  add(input: AddIntegrationInput): Integration {
    const err = IntegrationsService.validate(input);
    if (err) throw new Error(err);
    if (this.list().some((i) => i.name.toLowerCase() === input.name.toLowerCase())) {
      throw new Error(`an integration named "${input.name}" already exists`);
    }
    return integrationsDb.create(this.db, {
      id: uuid(), name: input.name, type: input.type,
      command: input.type === 'stdio' ? input.command : null,
      args: input.type === 'stdio' ? (input.args ?? []) : [],
      url: input.type === 'remote' ? input.url : null,
      headers: input.type === 'remote' ? (input.headers ?? {}) : {},
      env: input.env ?? {},
    });
  }

  remove(id: string): { removed: boolean } { integrationsDb.remove(this.db, id); return { removed: true }; }

  setEnabled(id: string, enabled: boolean): Integration | null { return integrationsDb.setEnabled(this.db, id, enabled); }

  /** Resolve every enabled integration to an McpServerSpec for composeInjection. */
  getServerSpecs(): McpServerSpec[] {
    const specs: McpServerSpec[] = [];
    for (const i of this.list()) {
      if (!i.enabled) continue;
      try {
        if (i.type === 'stdio') {
          if (!i.command) continue;
          specs.push({ name: i.name, command: i.command, args: i.args, ...(Object.keys(i.env).length ? { env: i.env } : {}) });
        } else {
          if (!i.url) continue;
          const headerArgs = Object.entries(i.headers).flatMap(([k, v]) => ['--header', `${k}:${v}`]);
          specs.push({ name: i.name, command: 'npx', args: ['-y', 'mcp-remote', i.url, ...headerArgs], ...(Object.keys(i.env).length ? { env: i.env } : {}) });
        }
      } catch { /* skip a malformed row rather than break a spawn */ }
    }
    return specs;
  }

  export(): IntegrationsExport {
    return { version: 1, integrations: this.list().map(({ id, createdAt, updatedAt, ...rest }) => rest) };
  }

  import(doc: IntegrationsExport): { added: string[]; skipped: string[] } {
    const added: string[] = []; const skipped: string[] = [];
    const existing = new Set(this.list().map((i) => i.name.toLowerCase()));
    for (const e of doc?.integrations ?? []) {
      if (!e || typeof e.name !== 'string' || existing.has(e.name.toLowerCase())) { if (e?.name) skipped.push(e.name); continue; }
      const input: AddIntegrationInput = e.type === 'stdio'
        ? { type: 'stdio', name: e.name, command: e.command ?? '', args: e.args, env: e.env }
        : { type: 'remote', name: e.name, url: e.url ?? '', headers: e.headers, env: e.env };
      if (IntegrationsService.validate(input)) { skipped.push(e.name); continue; }
      this.add(input); existing.add(e.name.toLowerCase()); added.push(e.name);
    }
    return { added, skipped };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run tests/integrations/service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git rm packages/core/tests/integrations/service-installed.test.ts packages/core/tests/integrations/management.test.ts
git add packages/core/src/integrations/service.ts packages/core/tests/integrations/service.test.ts
git commit -m "feat(core): catalog-backed IntegrationsService (getServerSpecs); drop executor"
```

---

### Task 3: Spawn injection repoint + server wiring

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (the integrations seam + spawn)
- Modify: `packages/core/src/server.ts` (both `createApp` and `startServer`)
- Test: `packages/core/tests/sessions/injection-wiring.test.ts` (extend)

**Interfaces:**
- Consumes: `IntegrationsService.getServerSpecs()` (Task 2).
- Produces: `SessionService.setIntegrationsSpecs(fn: () => McpServerSpec[])`.

- [ ] **Step 1: Update the spawn-wiring test**

In `packages/core/tests/sessions/injection-wiring.test.ts`, replace the integrations-seam setup. Find where the test calls `svc.setIntegrationsInjection(...)` and replace that line with a multi-spec catalog stub, and assert BOTH catalog servers reach the argv. Replace the `setIntegrationsInjection` call with:

```ts
  svc.setIntegrationsSpecs(() => [
    { name: 'fs', command: 'npx', args: ['-y', 'server-fs'] },
    { name: 'linear', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'] },
  ]);
```

And in the codex assertion block, after the existing doppler/executor checks, assert both catalog servers are present:

```ts
    expect(args).toContain('mcp_servers.fs.command="npx"');
    expect(args).toContain('mcp_servers.linear.command="npx"');
```

(If the existing test asserted an `executor` spec, replace those `executor` assertions with the `fs`/`linear` ones above — executor is gone.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/sessions/injection-wiring.test.ts`
Expected: FAIL — `setIntegrationsSpecs` is not a function.

- [ ] **Step 3: Repoint the seam in `sessions/service.ts`**

Replace the field declaration (currently around lines 29-30):

```ts
  /** Supplies the executor MCP spec for spawned CLIs; set by the server wiring. */
  private integrationsInjection: (() => { spec: McpServerSpec | null; prompt: string | null }) | null = null;
```

with:

```ts
  /** Supplies the catalog MCP specs for spawned CLIs; set by the server wiring. */
  private integrationsSpecs: (() => McpServerSpec[]) | null = null;
```

Replace the setter (currently around lines 45-47):

```ts
  setIntegrationsInjection(fn: () => { spec: McpServerSpec | null; prompt: string | null }): void {
    this.integrationsInjection = fn;
  }
```

with:

```ts
  setIntegrationsSpecs(fn: () => McpServerSpec[]): void {
    this.integrationsSpecs = fn;
  }
```

In `spawnTerminal`, replace the executor injection block (currently):

```ts
      const intg = this.integrationsInjection?.();
      if (intg?.spec) { specs.push(intg.spec); if (intg.prompt) prompts.push(intg.prompt); }
```

with:

```ts
      const intgSpecs = this.integrationsSpecs?.() ?? [];
      specs.push(...intgSpecs);
```

- [ ] **Step 4: Repoint the wiring in `server.ts`**

In `createApp` (around lines 90-92), replace:

```ts
  const integrationsService = new IntegrationsService();
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsInjection(() => ({ spec: integrationsService.getServerSpec(), prompt: integrationsService.getSystemPrompt() }));
```

with:

```ts
  const integrationsService = new IntegrationsService(db);
  sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }));
  sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());
```

In `startServer` apply the identical change: `new IntegrationsService(db)` and `sessionService.setIntegrationsSpecs(() => integrationsService.getServerSpecs());` (find the matching `new IntegrationsService()` + `setIntegrationsInjection` lines there and replace them the same way).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run tests/sessions/injection-wiring.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/server.ts packages/core/tests/sessions/injection-wiring.test.ts
git commit -m "feat(core): inject the integration catalog into both providers at spawn"
```

---

### Task 4: Routes (list / add / remove / toggle / export / import)

**Files:**
- Rewrite: `packages/core/src/routes/integrations.ts`
- Rewrite: `packages/core/tests/routes/integrations.test.ts`

**Interfaces:**
- Consumes: `IntegrationsService` (Task 2).
- Produces: `GET /api/integrations` → `{ integrations: Integration[] }`; `POST /api/integrations` (body `AddIntegrationInput`) → `Integration`; `DELETE /api/integrations/:id` → `{ removed: boolean }`; `PATCH /api/integrations/:id` (`{ enabled: boolean }`) → `Integration`; `GET /api/integrations/export` → `IntegrationsExport`; `POST /api/integrations/import` (body `IntegrationsExport`) → `{ added, skipped }`.

- [ ] **Step 1: Write the failing tests**

Replace `packages/core/tests/routes/integrations.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('integrations routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });

  it('GET / returns an empty catalog initially', async () => {
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ integrations: [] });
  });

  it('POST / adds a remote integration and GET / lists it', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ name: 'linear', type: 'remote', enabled: true });
    const list = await request(app).get('/api/integrations');
    expect(list.body.integrations.map((i: any) => i.name)).toEqual(['linear']);
  });

  it('POST / rejects a bad name with 400', async () => {
    const res = await request(app).post('/api/integrations').send({ type: 'remote', name: 'bad name', url: 'https://x' });
    expect(res.status).toBe(400);
  });

  it('POST / rejects a duplicate name with 409', async () => {
    await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'y' });
    expect(res.status).toBe(409);
  });

  it('PATCH /:id toggles enabled', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).patch(`/api/integrations/${post.body.id}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('PATCH /:id returns 404 for a missing id', async () => {
    const res = await request(app).patch('/api/integrations/nope').send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('DELETE /:id removes', async () => {
    const post = await request(app).post('/api/integrations').send({ type: 'stdio', name: 'fs', command: 'x' });
    const res = await request(app).delete(`/api/integrations/${post.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
  });

  it('export then import round-trips into a fresh app', async () => {
    await request(app).post('/api/integrations').send({ type: 'remote', name: 'linear', url: 'https://mcp.linear.app/sse' });
    const exp = await request(app).get('/api/integrations/export');
    expect(exp.body.version).toBe(1);
    const db2 = new Database(':memory:'); initSchema(db2); const app2 = createApp({ db: db2, skipPty: true });
    const imp = await request(app2).post('/api/integrations/import').send(exp.body);
    expect(imp.body).toEqual({ added: ['linear'], skipped: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/integrations.test.ts`
Expected: FAIL — routes return old shapes / 404.

- [ ] **Step 3: Rewrite the router**

Replace `packages/core/src/routes/integrations.ts` with:

```ts
import { Router } from 'express';
import type { IntegrationsService, AddIntegrationInput, IntegrationsExport } from '../integrations/service.js';

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();

  router.get('/', (_req, res) => res.json({ integrations: integrations.list() }));

  router.post('/', (req, res) => {
    const err = (integrations.constructor as typeof IntegrationsService).validate(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      res.json(integrations.add(req.body as AddIntegrationInput));
    } catch (e: any) {
      const msg = String(e?.message ?? 'add failed');
      res.status(/exists/.test(msg) ? 409 : 502).json({ error: /exists/.test(msg) ? msg : 'Could not add the integration.' });
    }
  });

  router.patch('/:id', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    const updated = integrations.setEnabled(req.params.id, req.body.enabled);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => res.json(integrations.remove(req.params.id)));

  router.get('/export', (_req, res) => res.json(integrations.export()));

  router.post('/import', (req, res) => {
    try {
      res.json(integrations.import(req.body as IntegrationsExport));
    } catch {
      res.status(400).json({ error: 'Invalid import document.' });
    }
  });

  return router;
}
```

Note: `validate` is static; `integrations.constructor as typeof IntegrationsService` reaches it without importing the class value into the route module. The duplicate-name throw is mapped to 409; other add errors to a safe 502.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/integrations.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/integrations.ts packages/core/tests/routes/integrations.test.ts
git commit -m "feat(core): integrations catalog routes (list/add/remove/toggle/export/import)"
```

---

### Task 5: Web — types, client, and the rebuilt IntegrationsSection

**Files:**
- Modify: `packages/web/src/api/types.ts`
- Modify: `packages/web/src/api/client.ts`
- Rewrite: `packages/web/src/components/settings/IntegrationsSection.tsx`

**Interfaces:**
- Consumes: the Task 4 routes.
- Produces: `api.listIntegrations/addIntegration/removeIntegration/setIntegrationEnabled/exportIntegrations/importIntegrations`; types `Integration`, `AddIntegrationInput`, `IntegrationsExport`.

- [ ] **Step 1: Replace the web types**

In `packages/web/src/api/types.ts`, REMOVE the phase-2 integration types (`IntegrationsStatus`, `Integration`, `IntegrationsList`, `AddIntegrationInput`, `AddIntegrationResult` if present) and add:

```ts
export interface Integration { id: string; name: string; type: 'stdio' | 'remote'; command: string | null; args: string[]; url: string | null; headers: Record<string, string>; env: Record<string, string>; enabled: boolean; createdAt: string; updatedAt: string }
export type AddIntegrationInput =
  | { type: 'remote'; name: string; url: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> };
export interface IntegrationsExport { version: 1; integrations: Omit<Integration, 'id' | 'createdAt' | 'updatedAt'>[] }
```

- [ ] **Step 2: Replace the client methods**

In `packages/web/src/api/client.ts`, update the type import to include `Integration, AddIntegrationInput, IntegrationsExport` (remove `IntegrationsStatus`/`IntegrationsList`/`AddIntegrationResult`). Replace the `// Integrations` block with:

```ts
  // Integrations (own MCP catalog)
  listIntegrations: () => req<{ integrations: Integration[] }>('/api/integrations'),
  addIntegration: (input: AddIntegrationInput) => req<Integration>('/api/integrations', { method: 'POST', body: body(input) }),
  setIntegrationEnabled: (id: string, enabled: boolean) => req<Integration>(`/api/integrations/${encodeURIComponent(id)}`, { method: 'PATCH', body: body({ enabled }) }),
  removeIntegration: (id: string) => req<{ removed: boolean }>(`/api/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportIntegrations: () => req<IntegrationsExport>('/api/integrations/export'),
  importIntegrations: (doc: IntegrationsExport) => req<{ added: string[]; skipped: string[] }>('/api/integrations/import', { method: 'POST', body: body(doc) }),
```

- [ ] **Step 3: Rebuild the component**

Replace `packages/web/src/components/settings/IntegrationsSection.tsx` with:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Integration, AddIntegrationInput, IntegrationsExport } from '../../api/types';

const label: React.CSSProperties = { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' };
const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const input: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
const ghost: React.CSSProperties = { height: 30, padding: '0 12px', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };
const addBtn = (on: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.5 });
const chip: React.CSSProperties = { font: '400 10px var(--font-mono)', color: '#c9c9cf', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 5, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.5px' };

function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

export function IntegrationsSection() {
  const [list, setList] = useState<Integration[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try { setList((await api.listIntegrations()).integrations); }
    catch { setErr('Could not reach Dispatch.'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const canAdd = !busy && /^[a-zA-Z0-9_-]+$/.test(name.trim()) && (advanced ? command.trim() : /^https?:\/\//.test(url.trim()));

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    const inputData: AddIntegrationInput = advanced
      ? { type: 'stdio', name: name.trim(), command: command.trim(), args: args.split(' ').filter(Boolean), env: parseKV(env) }
      : { type: 'remote', name: name.trim(), url: url.trim(), headers: parseKV(headers) };
    try {
      await api.addIntegration(inputData);
      setName(''); setUrl(''); setHeaders(''); setCommand(''); setArgs(''); setEnv('');
      await reload();
    } catch { setErr('Could not add — check the name is unique and the inputs are valid.'); }
    setBusy(false);
  }
  async function toggle(i: Integration) { try { await api.setIntegrationEnabled(i.id, !i.enabled); await reload(); } catch { setErr('Could not update.'); } }
  async function remove(id: string) { try { await api.removeIntegration(id); await reload(); } catch { setErr('Could not remove.'); } }

  async function doExport() {
    const doc = await api.exportIntegrations();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'integrations.json'; a.click(); URL.revokeObjectURL(a.href);
  }
  async function doImport(file: File) {
    setErr('');
    try { const doc = JSON.parse(await file.text()) as IntegrationsExport; const r = await api.importIntegrations(doc); await reload(); setErr(`Imported ${r.added.length}, skipped ${r.skipped.length}.`); }
    catch { setErr('Import failed — invalid file.'); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={label}>INTEGRATIONS</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button style={ghost} onClick={() => void doExport()}>Export</button>
          <button style={ghost} onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
        </span>
      </div>
      <div style={sub}>MCP servers shared across Claude &amp; Codex. Secrets come from Doppler (servers inherit your session env).</div>

      {list.length === 0 && <div style={sub}>No integrations yet. Add one below.</div>}
      {list.map((i) => (
        <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: i.enabled ? 1 : 0.5 }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13, color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
              <span style={chip}>{i.type}</span>
            </span>
            <span style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.type === 'remote' ? i.url : `${i.command} ${i.args.join(' ')}`}</span>
          </span>
          <button title={i.enabled ? 'Disable' : 'Enable'} onClick={() => void toggle(i)} style={{ ...ghost, height: 26, padding: '0 9px' }}>{i.enabled ? 'On' : 'Off'}</button>
          <button title="Remove" onClick={() => void remove(i.id)} style={{ width: 26, height: 26, flexShrink: 0, background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
        </div>
      ))}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. linear)" style={{ ...input, flex: '0 0 32%' }} />
          {!advanced && <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" style={{ ...input, flex: 1 }} />}
          {advanced && <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx)" style={{ ...input, flex: 1 }} />}
          <button onClick={() => void add()} disabled={!canAdd} style={addBtn(canAdd)}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
        {!advanced && <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="optional headers, one per line: Authorization=Bearer ${MY_TOKEN}" style={{ ...input, height: 'auto', minHeight: 30, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11 }} rows={2} />}
        {advanced && (
          <>
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="args (space-separated, e.g. -y @scope/mcp-server)" style={input} />
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder="optional env, one per line: ROOT=/tmp" style={{ ...input, height: 'auto', minHeight: 30, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11 }} rows={2} />
          </>
        )}
        <button onClick={() => setAdvanced((a) => !a)} style={{ ...ghost, alignSelf: 'flex-start', border: 'none', padding: '0 2px', color: 'var(--color-text-tertiary)' }}>{advanced ? '← back to URL' : 'Advanced: add a local command'}</button>
      </div>

      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web build`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/components/settings/IntegrationsSection.tsx
git commit -m "feat(web): own-catalog Integrations UI (paste-URL add, advanced command, toggle, export/import)"
```

---

## Self-Review

**1. Spec coverage:** catalog table (T1), service CRUD + `getServerSpecs` + export/import + executor removal (T2), spawn injection of the catalog into both providers (T3), routes (T4), web paste-URL add + Advanced + list/toggle/remove + export/import (T5). Doppler-env secrets need no code (ambient) — covered by the constraint + UI copy. ✅
**2. Placeholder scan:** every code step has complete code; commands have expected output. ✅
**3. Type consistency:** `Integration`/`AddIntegrationInput`/`IntegrationsExport` identical across db (T1), service (T2), routes (T4), web (T5). `getServerSpecs(): McpServerSpec[]` consumed by T3's `setIntegrationsSpecs`. `validate` static, used by T2 + T4. Remote→`['-y','mcp-remote',url,'--header','K:V']` identical in spec/T2/T3. ✅

## Notes for the executor cleanup
- After Task 2, `packages/core/src/integrations/service.ts` no longer imports `node:child_process`/`execFileSync` — confirm no other file imports the removed executor methods (`getServerSpec`, `getSystemPrompt`, `status` on IntegrationsService). The only callers were `server.ts` (updated in T3) and the deleted tests.
- `mcp-remote` is fetched on demand by `npx -y` at spawn; no dependency is added to package.json. Document this in the PR description.
- The historical `docs/superpowers/notes/executor-cli*.md` stay as a record of why executor was dropped.
