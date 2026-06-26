# Integration Layer — Phase 2 (Settings Integrations UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user list, add, and remove executor integrations (OpenAPI / MCP server / GraphQL) from Dispatch Settings, managed in one place and shared across Claude & Codex.

**Architecture:** Dispatch's core talks to the locally-installed `executor` daemon. `IntegrationsService` gains async `list()`/`add()`/`remove()` that shell out to the `executor` CLI (`executor call …`, which auto-starts the daemon and emits JSON to stdout) for list/add/connection-remove, and use one authenticated HTTP `DELETE http://localhost:4788/api/integrations/{slug}` for catalog-entry removal (the only path executor exposes for that). New REST routes wrap these; the Settings `IntegrationsSection` renders the list + an Add form + Remove buttons.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, vitest + supertest (core); React + Zustand + Vite (web). Node 18+ global `fetch`.

## Global Constraints

- ESM with `.js` import specifiers in all core TypeScript imports.
- The executor HTTP API is loopback-only at `http://localhost:4788`. The bearer token lives at `~/.executor/server-control/auth.json` (`{"token":"..."}`); it is read server-side ONLY and MUST NEVER be returned to a web client or logged.
- All `executor call …` commands emit JSON to **stdout** wrapped as `{"ok":true,"data":{…}}` (errors: `{"ok":false,"error":"…"}` or non-zero exit). The daemon-start notice goes to **stderr**, so parse stdout only.
- Exact executor command paths (space-separated args after `executor call`): list = `executor call executor coreTools integrations list`; add OpenAPI = `executor call executor openapi addSpec '<json>'`; add MCP = `executor call executor mcp addServer '<json>'`; add GraphQL = `executor call executor graphql addIntegration '<json>'`; create connection = `executor call executor coreTools connections create '<json>'`; remove connection = `executor call executor coreTools connections remove '<json>'`.
- `connections create`/`remove` use `{"owner":"org","name":"default","integration":"<slug>"[,"template":"none"]}` verbatim.
- Catalog-entry removal is `DELETE http://localhost:4788/api/integrations/{slug}` with `Authorization: Bearer <token>` → `{"removed":true}` (idempotent; built-ins silently no-op, so gate the Remove button on `canRemove`).
- Do NOT touch `IntegrationsService.status()`, `getServerSpec()`, or `getSystemPrompt()` — they are tested and in production use. Add only.
- Do NOT restart the daemon as part of this plan (it ends the dev session). Web changes are live on refresh; new core routes need a restart the user runs manually.
- Web layer has no unit-test runner; web tasks are verified by `tsc --noEmit` + `vite build` (consistent with phase-1 Task 5).

## Decisions log (made autonomously; rationale)

- **D1 transport:** CLI (`execFile`) for list/add/connection-remove (auto-starts daemon, JSON stdout, no token); HTTP DELETE for catalog removal (only available path). Minimizes daemon-lifecycle code.
- **D2 layering:** injectable `deps` (`run`, `deleteCatalogEntry`) on `IntegrationsService` so list/add/remove unit-test without a real daemon and without mocking `execFile`/`promisify`.
- **D3 add flow:** catalog add (fatal on failure) + best-effort `connections create {template:"none"}` (logged, non-fatal) to materialize no-auth tools.
- **D4 remove gating:** Remove button shown only when `canRemove` is true.
- **D5 scope:** phases 3–5 (Doppler→executor secrets bridge, export/import, agent-assisted CLI add) are NOT in this plan; export/import's spec design is invalid (executor global catalog is SQLite, not `executor.jsonc`).

## File Structure

- `packages/core/src/integrations/service.ts` (MODIFY) — add exported types (`Integration`, `AddIntegrationInput`, `AddIntegrationResult`, `IntegrationsDeps`), an injectable `deps` constructor arg, and async `list()`/`add()`/`remove()` + a private `callJson()` helper. Owns all executor command/HTTP knowledge.
- `packages/core/src/routes/integrations.ts` (MODIFY) — add `GET /` (list), `POST /` (add, validated), `DELETE /:slug` (remove). Keep existing `GET /status`.
- `packages/core/tests/integrations/management.test.ts` (CREATE) — unit tests for list/add/remove via injected fake deps.
- `packages/core/tests/routes/integrations.test.ts` (MODIFY) — supertest tests for the three new endpoints using the router with a fake service.
- `packages/web/src/api/types.ts` (MODIFY) — add `Integration`, `IntegrationsList`, `AddIntegrationInput`, `AddIntegrationResult`.
- `packages/web/src/api/client.ts` (MODIFY) — add `listIntegrations`, `addIntegration`, `removeIntegration`.
- `packages/web/src/components/settings/IntegrationsSection.tsx` (MODIFY) — expand to list + add form + remove.

---

### Task 1: Core — `IntegrationsService` list/add/remove

**Files:**
- Modify: `packages/core/src/integrations/service.ts`
- Test: `packages/core/tests/integrations/management.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `node:child_process`, `node:util`, `node:fs`, `node:os`, `node:path`, global `fetch`).
- Produces (later tasks rely on these exact names/shapes):
  - `interface Integration { slug: string; description: string; kind: string; canRemove: boolean; canRefresh: boolean }`
  - `type AddIntegrationInput = { type: 'openapi'; url: string; slug: string } | { type: 'mcp-stdio'; name: string; command: string; args: string[]; slug?: string } | { type: 'mcp-remote'; name: string; endpoint: string; slug?: string } | { type: 'graphql'; endpoint: string; slug: string }`
  - `interface AddIntegrationResult { slug: string; toolCount?: number }`
  - `interface IntegrationsDeps { run: (args: string[]) => Promise<string>; deleteCatalogEntry: (slug: string) => Promise<{ removed: boolean }> }`
  - `class IntegrationsService` constructor now `constructor(deps?: Partial<IntegrationsDeps>)`; new async methods `list(): Promise<Integration[]>`, `add(input: AddIntegrationInput): Promise<AddIntegrationResult>`, `remove(slug: string): Promise<{ removed: boolean }>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/integrations/management.test.ts`:

```ts
import { it, expect } from 'vitest';
import { IntegrationsService } from '../../src/integrations/service.js';

// Build a service with fake deps that records every `run` arg vector.
function harness(runImpl: (args: string[]) => string | Promise<string>) {
  const calls: string[][] = [];
  const deleted: string[] = [];
  const svc = new IntegrationsService({
    run: async (args: string[]) => { calls.push(args); return runImpl(args); },
    deleteCatalogEntry: async (slug: string) => { deleted.push(slug); return { removed: true }; },
  });
  return { svc, calls, deleted };
}

it('list() parses {ok,data} and maps integrations', async () => {
  const { svc } = harness(() => JSON.stringify({ ok: true, data: { integrations: [
    { slug: 'executor', description: 'Executor', kind: 'built-in', canRemove: false, canRefresh: false },
    { slug: 'petstore', description: 'Petstore', kind: 'openapi', canRemove: true, canRefresh: true },
  ] } }));
  const list = await svc.list();
  expect(list).toEqual([
    { slug: 'executor', description: 'Executor', kind: 'built-in', canRemove: false, canRefresh: false },
    { slug: 'petstore', description: 'Petstore', kind: 'openapi', canRemove: true, canRefresh: true },
  ]);
});

it('list() defaults missing fields safely', async () => {
  const { svc } = harness(() => JSON.stringify({ ok: true, data: { integrations: [{ slug: 'x' }] } }));
  expect(await svc.list()).toEqual([{ slug: 'x', description: '', kind: 'unknown', canRemove: false, canRefresh: false }]);
});

it('add(openapi) calls addSpec with url spec then creates a connection', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addSpec') ? JSON.stringify({ ok: true, data: { slug: 'my-api', toolCount: 5 } })
                             : JSON.stringify({ ok: true, data: {} }));
  const res = await svc.add({ type: 'openapi', url: 'https://x/openapi.json', slug: 'my-api' });
  expect(res).toEqual({ slug: 'my-api', toolCount: 5 });
  const addCall = calls.find((c) => c.includes('addSpec'))!;
  expect(addCall.slice(0, 4)).toEqual(['call', 'executor', 'openapi', 'addSpec']);
  expect(JSON.parse(addCall[4])).toEqual({ spec: { kind: 'url', url: 'https://x/openapi.json' }, slug: 'my-api' });
  const connCall = calls.find((c) => c.includes('connections') && c.includes('create'))!;
  expect(JSON.parse(connCall[5])).toEqual({ owner: 'org', name: 'default', integration: 'my-api', template: 'none' });
});

it('add(mcp-stdio) builds the stdio addServer payload', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addServer') ? JSON.stringify({ ok: true, data: { slug: 'my-mcp' } })
                               : JSON.stringify({ ok: true, data: {} }));
  const res = await svc.add({ type: 'mcp-stdio', name: 'My MCP', command: 'npx', args: ['-y', 'pkg'] });
  expect(res).toEqual({ slug: 'my-mcp', toolCount: undefined });
  expect(JSON.parse(calls.find((c) => c.includes('addServer'))![4]))
    .toEqual({ transport: 'stdio', name: 'My MCP', command: 'npx', args: ['-y', 'pkg'] });
});

it('add(mcp-remote) builds the remote addServer payload with optional slug', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addServer') ? JSON.stringify({ ok: true, data: { slug: 'remote-mcp' } })
                               : JSON.stringify({ ok: true, data: {} }));
  await svc.add({ type: 'mcp-remote', name: 'Remote', endpoint: 'https://x/mcp', slug: 'remote-mcp' });
  expect(JSON.parse(calls.find((c) => c.includes('addServer'))![4]))
    .toEqual({ transport: 'remote', name: 'Remote', endpoint: 'https://x/mcp', slug: 'remote-mcp' });
});

it('add(graphql) builds the addIntegration payload', async () => {
  const { svc, calls } = harness((args) =>
    args.includes('addIntegration') ? JSON.stringify({ ok: true, data: { slug: 'gql', name: 'GQL' } })
                                    : JSON.stringify({ ok: true, data: {} }));
  const res = await svc.add({ type: 'graphql', endpoint: 'https://x/graphql', slug: 'gql' });
  expect(res.slug).toBe('gql');
  expect(JSON.parse(calls.find((c) => c.includes('addIntegration'))![4]))
    .toEqual({ endpoint: 'https://x/graphql', slug: 'gql' });
});

it('add() still returns the slug when connection-create fails', async () => {
  const svc = new IntegrationsService({
    run: async (args: string[]) => {
      if (args.includes('addSpec')) return JSON.stringify({ ok: true, data: { slug: 'my-api', toolCount: 3 } });
      throw new Error('connection failed');
    },
    deleteCatalogEntry: async () => ({ removed: true }),
  });
  expect(await svc.add({ type: 'openapi', url: 'https://x', slug: 'my-api' })).toEqual({ slug: 'my-api', toolCount: 3 });
});

it('add() throws when executor returns ok:false', async () => {
  const { svc } = harness(() => JSON.stringify({ ok: false, error: 'bad spec' }));
  await expect(svc.add({ type: 'openapi', url: 'x', slug: 's' })).rejects.toThrow('bad spec');
});

it('remove() drops the connection (best-effort) then deletes the catalog entry', async () => {
  const { svc, calls, deleted } = harness(() => JSON.stringify({ ok: true, data: { removed: true } }));
  expect(await svc.remove('petstore')).toEqual({ removed: true });
  expect(calls.some((c) => c.includes('connections') && c.includes('remove'))).toBe(true);
  expect(deleted).toEqual(['petstore']);
});

it('remove() deletes the catalog entry even if connection-remove throws', async () => {
  let deleted = false;
  const svc = new IntegrationsService({
    run: async () => { throw new Error('no connection'); },
    deleteCatalogEntry: async () => { deleted = true; return { removed: true }; },
  });
  const r = await svc.remove('petstore');
  expect(deleted).toBe(true);
  expect(r.removed).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/integrations/management.test.ts`
Expected: FAIL — `svc.list is not a function` / constructor does not accept deps.

- [ ] **Step 3: Implement**

Edit `packages/core/src/integrations/service.ts`. Keep the existing `import { execFileSync }` line and the existing `status()`/`getServerSpec()`/`getSystemPrompt()` methods unchanged. Add the new imports at the top, the new exported types, the constructor, and the new methods. Final file:

```ts
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerSpec } from '../mcp/injection.js';

const execFileP = promisify(execFile);

export interface Integration {
  slug: string;
  description: string;
  kind: string;
  canRemove: boolean;
  canRefresh: boolean;
}

export type AddIntegrationInput =
  | { type: 'openapi'; url: string; slug: string }
  | { type: 'mcp-stdio'; name: string; command: string; args: string[]; slug?: string }
  | { type: 'mcp-remote'; name: string; endpoint: string; slug?: string }
  | { type: 'graphql'; endpoint: string; slug: string };

export interface AddIntegrationResult { slug: string; toolCount?: number }

/** Injectable IO so list/add/remove are unit-testable without a real executor daemon. */
export interface IntegrationsDeps {
  /** Run `executor <args>` and return stdout. */
  run: (args: string[]) => Promise<string>;
  /** DELETE the catalog entry via the daemon's HTTP API (token read server-side). */
  deleteCatalogEntry: (slug: string) => Promise<{ removed: boolean }>;
}

// --- default deps (real IO) ---------------------------------------------------

async function defaultRun(args: string[]): Promise<string> {
  // 30s timeout covers daemon cold-start (~1s) plus remote spec fetches.
  const { stdout } = await execFileP('executor', args, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function defaultDeleteCatalogEntry(slug: string): Promise<{ removed: boolean }> {
  const authPath = path.join(os.homedir(), '.executor', 'server-control', 'auth.json');
  const token = JSON.parse(fs.readFileSync(authPath, 'utf-8')).token as string;
  const res = await fetch(`http://localhost:4788/api/integrations/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`executor DELETE failed: ${res.status}`);
  return (await res.json()) as { removed: boolean };
}

export class IntegrationsService {
  // Detection result is cached for the daemon's lifetime: installing `executor`
  // after startup is not reflected until the daemon is restarted.
  private detected: { installed: boolean; version: string | null } | null = null;
  private readonly deps: IntegrationsDeps;

  constructor(deps?: Partial<IntegrationsDeps>) {
    this.deps = { run: defaultRun, deleteCatalogEntry: defaultDeleteCatalogEntry, ...deps };
  }

  status(): { installed: boolean; version: string | null } {
    if (this.detected) return this.detected;
    try {
      const v = execFileSync('executor', ['--version'], { encoding: 'utf-8', timeout: 4000 }).trim();
      this.detected = { installed: true, version: v };
    } catch { this.detected = { installed: false, version: null }; }
    return this.detected;
  }

  getServerSpec(): McpServerSpec | null {
    if (!this.status().installed) return null;
    return { name: 'executor', command: 'executor', args: ['mcp', '--elicitation-mode', 'model'] };
  }

  getSystemPrompt(): string | null {
    if (!this.status().installed) return null;
    return 'An "executor" MCP server exposes your shared integration catalog (the same tools across Claude and Codex). Use its tools to call integrations, and its management tools to add a new integration when given API docs, a CLI, or an MCP. If Doppler is connected, store any credentials there.';
  }

  /** List integrations from the executor catalog. */
  async list(): Promise<Integration[]> {
    const data = await this.callJson(['call', 'executor', 'coreTools', 'integrations', 'list']);
    const arr: any[] = Array.isArray(data?.integrations) ? data.integrations : [];
    return arr.map((i) => ({
      slug: String(i.slug),
      description: typeof i.description === 'string' ? i.description : '',
      kind: typeof i.kind === 'string' ? i.kind : 'unknown',
      canRemove: !!i.canRemove,
      canRefresh: !!i.canRefresh,
    }));
  }

  /** Add a source to the catalog, then best-effort materialize its tools. */
  async add(input: AddIntegrationInput): Promise<AddIntegrationResult> {
    let slug: string;
    let toolCount: number | undefined;
    if (input.type === 'openapi') {
      const d = await this.callJson(['call', 'executor', 'openapi', 'addSpec',
        JSON.stringify({ spec: { kind: 'url', url: input.url }, slug: input.slug })]);
      slug = d.slug; toolCount = typeof d.toolCount === 'number' ? d.toolCount : undefined;
    } else if (input.type === 'mcp-stdio') {
      const d = await this.callJson(['call', 'executor', 'mcp', 'addServer',
        JSON.stringify({ transport: 'stdio', name: input.name, command: input.command, args: input.args, ...(input.slug ? { slug: input.slug } : {}) })]);
      slug = d.slug;
    } else if (input.type === 'mcp-remote') {
      const d = await this.callJson(['call', 'executor', 'mcp', 'addServer',
        JSON.stringify({ transport: 'remote', name: input.name, endpoint: input.endpoint, ...(input.slug ? { slug: input.slug } : {}) })]);
      slug = d.slug;
    } else {
      const d = await this.callJson(['call', 'executor', 'graphql', 'addIntegration',
        JSON.stringify({ endpoint: input.endpoint, slug: input.slug })]);
      slug = d.slug;
    }
    // Materialize tools for no-auth sources; non-fatal (catalog entry exists regardless).
    try {
      await this.callJson(['call', 'executor', 'coreTools', 'connections', 'create',
        JSON.stringify({ owner: 'org', name: 'default', integration: slug, template: 'none' })]);
    } catch { /* best-effort: auth'd sources get credentials via executor's own UI */ }
    return { slug, toolCount };
  }

  /** Remove a source: drop its connection (best-effort) then delete the catalog entry. */
  async remove(slug: string): Promise<{ removed: boolean }> {
    try {
      await this.callJson(['call', 'executor', 'coreTools', 'connections', 'remove',
        JSON.stringify({ owner: 'org', name: 'default', integration: slug })]);
    } catch { /* no connection / already gone — the connection call also auto-starts the daemon */ }
    return this.deps.deleteCatalogEntry(slug);
  }

  /** Run an `executor call` and unwrap its {ok,data} envelope. */
  private async callJson(args: string[]): Promise<any> {
    const stdout = await this.deps.run(args);
    let parsed: any;
    try { parsed = JSON.parse(stdout); }
    catch { throw new Error(`executor: unparseable output: ${stdout.slice(0, 200)}`); }
    if (parsed && parsed.ok === false) throw new Error(typeof parsed.error === 'string' ? parsed.error : 'executor call failed');
    return parsed && 'data' in parsed ? parsed.data : parsed;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run tests/integrations/management.test.ts`
Expected: PASS (10 tests). Also run the existing integration tests to confirm no regression: `pnpm --filter dispatch-server exec vitest run tests/integrations/service.test.ts tests/integrations/service-installed.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/integrations/service.ts packages/core/tests/integrations/management.test.ts
git commit -m "feat(core): IntegrationsService list/add/remove via executor CLI + HTTP delete"
```

---

### Task 2: Core — integrations routes (list / add / remove)

**Files:**
- Modify: `packages/core/src/routes/integrations.ts`
- Test: `packages/core/tests/routes/integrations.test.ts`

**Interfaces:**
- Consumes: `IntegrationsService` with `status()`, `list()`, `add(input)`, `remove(slug)` (Task 1).
- Produces (web relies on these): `GET /api/integrations` → `{ installed: boolean; integrations: Integration[] }`; `POST /api/integrations` (body = `AddIntegrationInput`) → `AddIntegrationResult`; `DELETE /api/integrations/:slug` → `{ removed: boolean }`. `GET /api/integrations/status` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/tests/routes/integrations.test.ts` (keep the existing imports + describe block; add `express` import and a second describe). New full file:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { createIntegrationsRouter } from '../../src/routes/integrations.js';

describe('integrations routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });
  it('GET /api/integrations/status returns the installed shape', async () => {
    const res = await request(app).get('/api/integrations/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.installed).toBe('boolean');
    expect(res.body.version === null || typeof res.body.version === 'string').toBe(true);
  });
});

// Mount the router directly with a fake service to test list/add/remove in isolation.
function appWith(overrides: Record<string, any> = {}) {
  const svc: any = {
    status: () => ({ installed: true, version: '1.5.20' }),
    list: async () => [{ slug: 'petstore', description: 'P', kind: 'openapi', canRemove: true, canRefresh: true }],
    add: async (_input: any) => ({ slug: 'new-one', toolCount: 2 }),
    remove: async (_slug: string) => ({ removed: true }),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', createIntegrationsRouter(svc));
  return app;
}

describe('integrations management routes', () => {
  it('GET / returns installed + the integration list', async () => {
    const res = await request(appWith()).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installed: true, integrations: [{ slug: 'petstore', description: 'P', kind: 'openapi', canRemove: true, canRefresh: true }] });
  });

  it('GET / short-circuits to empty when executor is not installed (list never called)', async () => {
    let listed = false;
    const res = await request(appWith({ status: () => ({ installed: false, version: null }), list: async () => { listed = true; return []; } })).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ installed: false, integrations: [] });
    expect(listed).toBe(false);
  });

  it('GET / returns 502 when list throws', async () => {
    const res = await request(appWith({ list: async () => { throw new Error('daemon down'); } })).get('/api/integrations');
    expect(res.status).toBe(502);
  });

  it('POST / adds a valid openapi source', async () => {
    const res = await request(appWith()).post('/api/integrations').send({ type: 'openapi', url: 'https://x/openapi.json', slug: 'my-api' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: 'new-one', toolCount: 2 });
  });

  it('POST / rejects an unknown type with 400', async () => {
    const res = await request(appWith()).post('/api/integrations').send({ type: 'cli', command: 'git' });
    expect(res.status).toBe(400);
  });

  it('POST / rejects openapi missing slug with 400', async () => {
    const res = await request(appWith()).post('/api/integrations').send({ type: 'openapi', url: 'https://x' });
    expect(res.status).toBe(400);
  });

  it('POST / returns 409 when executor is not installed', async () => {
    const res = await request(appWith({ status: () => ({ installed: false, version: null }) })).post('/api/integrations').send({ type: 'openapi', url: 'https://x', slug: 's' });
    expect(res.status).toBe(409);
  });

  it('DELETE /:slug removes an integration', async () => {
    const res = await request(appWith()).delete('/api/integrations/petstore');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
  });

  it('DELETE /:slug returns 409 when executor is not installed', async () => {
    const res = await request(appWith({ status: () => ({ installed: false, version: null }) })).delete('/api/integrations/petstore');
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/integrations.test.ts`
Expected: FAIL — new endpoints 404.

- [ ] **Step 3: Implement**

Replace `packages/core/src/routes/integrations.ts` with:

```ts
import { Router } from 'express';
import type { IntegrationsService, AddIntegrationInput } from '../integrations/service.js';

/** Validate a POST body as an AddIntegrationInput. Returns an error string or null. */
function validateAddInput(b: any): string | null {
  if (!b || typeof b !== 'object') return 'body required';
  const s = (v: any) => typeof v === 'string' && v.trim().length > 0;
  switch (b.type) {
    case 'openapi': return s(b.url) && s(b.slug) ? null : 'openapi requires url and slug';
    case 'mcp-stdio': return s(b.name) && s(b.command) && Array.isArray(b.args) && b.args.every((a: any) => typeof a === 'string') ? null : 'mcp-stdio requires name, command, and string[] args';
    case 'mcp-remote': return s(b.name) && s(b.endpoint) ? null : 'mcp-remote requires name and endpoint';
    case 'graphql': return s(b.endpoint) && s(b.slug) ? null : 'graphql requires endpoint and slug';
    default: return `unknown integration type: ${String(b.type)}`;
  }
}

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();

  router.get('/status', (_req, res) => res.json(integrations.status()));

  router.get('/', async (_req, res) => {
    if (!integrations.status().installed) return res.json({ installed: false, integrations: [] });
    try {
      const list = await integrations.list();
      res.json({ installed: true, integrations: list });
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? 'executor error' });
    }
  });

  router.post('/', async (req, res) => {
    if (!integrations.status().installed) return res.status(409).json({ error: 'executor not installed' });
    const err = validateAddInput(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
      const result = await integrations.add(req.body as AddIntegrationInput);
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? 'add failed' });
    }
  });

  router.delete('/:slug', async (req, res) => {
    if (!integrations.status().installed) return res.status(409).json({ error: 'executor not installed' });
    try {
      const result = await integrations.remove(req.params.slug);
      res.json(result);
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? 'remove failed' });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/integrations.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/integrations.ts packages/core/tests/routes/integrations.test.ts
git commit -m "feat(core): GET/POST/DELETE /api/integrations (list/add/remove)"
```

---

### Task 3: Web — types, client, and IntegrationsSection UI

**Files:**
- Modify: `packages/web/src/api/types.ts`
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/components/settings/IntegrationsSection.tsx`

**Interfaces:**
- Consumes: routes from Task 2 (`GET/POST/DELETE /api/integrations`).
- Produces: `api.listIntegrations()`, `api.addIntegration(input)`, `api.removeIntegration(slug)`; types `Integration`, `IntegrationsList`, `AddIntegrationInput`, `AddIntegrationResult`.

- [ ] **Step 1: Add web types**

Append to `packages/web/src/api/types.ts` (after the existing `IntegrationsStatus` line):

```ts
export interface Integration { slug: string; description: string; kind: string; canRemove: boolean; canRefresh: boolean }
export interface IntegrationsList { installed: boolean; integrations: Integration[] }
export type AddIntegrationInput =
  | { type: 'openapi'; url: string; slug: string }
  | { type: 'mcp-stdio'; name: string; command: string; args: string[]; slug?: string }
  | { type: 'mcp-remote'; name: string; endpoint: string; slug?: string }
  | { type: 'graphql'; endpoint: string; slug: string };
export interface AddIntegrationResult { slug: string; toolCount?: number }
```

- [ ] **Step 2: Add client methods**

In `packages/web/src/api/client.ts`, extend the type import to include the new types, and replace the existing Integrations block (the line `getIntegrationsStatus: …`) with:

```ts
  // Integrations
  getIntegrationsStatus: () => req<IntegrationsStatus>('/api/integrations/status'),
  listIntegrations: () => req<IntegrationsList>('/api/integrations'),
  addIntegration: (input: AddIntegrationInput) => req<AddIntegrationResult>('/api/integrations', { method: 'POST', body: body(input) }),
  removeIntegration: (slug: string) => req<{ removed: boolean }>(`/api/integrations/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
```

Update the top-of-file `import type { … } from './types';` to also import `IntegrationsList, AddIntegrationInput, AddIntegrationResult` (alongside the existing `IntegrationsStatus`).

- [ ] **Step 3: Implement the UI**

Replace `packages/web/src/components/settings/IntegrationsSection.tsx` with:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Integration, AddIntegrationInput } from '../../api/types';

type AddType = 'openapi' | 'mcp-stdio' | 'mcp-remote' | 'graphql';

const sectionLabel: React.CSSProperties = { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' };
const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const input: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
const select: React.CSSProperties = { ...input, appearance: 'none', cursor: 'pointer' };
const addBtn = (enabled: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5 });
const kindChip: React.CSSProperties = { font: '400 10px var(--font-mono)', color: '#c9c9cf', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 5, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.5px' };

function buildInput(type: AddType, f: Record<string, string>): AddIntegrationInput | null {
  const t = (k: string) => (f[k] ?? '').trim();
  if (type === 'openapi') return t('url') && t('slug') ? { type, url: t('url'), slug: t('slug') } : null;
  if (type === 'mcp-stdio') return t('name') && t('command') ? { type, name: t('name'), command: t('command'), args: t('args').split(' ').filter(Boolean), ...(t('slug') ? { slug: t('slug') } : {}) } : null;
  if (type === 'mcp-remote') return t('name') && t('endpoint') ? { type, name: t('name'), endpoint: t('endpoint'), ...(t('slug') ? { slug: t('slug') } : {}) } : null;
  if (type === 'graphql') return t('endpoint') && t('slug') ? { type, endpoint: t('endpoint'), slug: t('slug') } : null;
  return null;
}

export function IntegrationsSection() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [list, setList] = useState<Integration[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<AddType>('mcp-stdio');
  const [fields, setFields] = useState<Record<string, string>>({});
  const setF = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  const reload = useCallback(async () => {
    setErr('');
    try {
      const st = await api.getIntegrationsStatus();
      setInstalled(st.installed); setVersion(st.version);
      if (!st.installed) { setList([]); return; }
      const r = await api.listIntegrations();
      setList(r.integrations);
    } catch {
      // status said installed but the catalog call failed: surface a reachable-daemon hint.
      setErr('Could not reach the executor daemon. It starts on first use — try again in a moment.');
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function add() {
    const built = buildInput(type, fields);
    if (!built) { setErr('Fill in the required fields.'); return; }
    setBusy(true); setErr('');
    try { await api.addIntegration(built); setFields({}); await reload(); }
    catch { setErr('Could not add — check the inputs and that executor is reachable.'); }
    setBusy(false);
  }
  async function remove(slug: string) {
    setErr('');
    try { await api.removeIntegration(slug); await reload(); }
    catch { setErr('Could not remove.'); }
  }

  const canAdd = !busy && !!buildInput(type, fields);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={sectionLabel}>INTEGRATIONS</span>
      <div style={sub}>One catalog shared across Claude &amp; Codex, via executor.</div>

      {installed === null && <div style={sub}>Checking…</div>}

      {installed === false && (
        <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          executor not installed. Install with: <code>npm i -g executor</code> — then restart the daemon and it&apos;s shared across Claude &amp; Codex.
        </div>
      )}

      {installed === true && (
        <>
          <div style={{ ...sub, color: 'var(--color-text-secondary)' }}>executor {version ?? '(unknown version)'} — connected.</div>

          {list.length === 0 && <div style={sub}>No integrations yet. Add one below.</div>}
          {list.map((i) => (
            <div key={i.slug} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 13, color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.slug}</span>
                  <span style={kindChip}>{i.kind}</span>
                </span>
                {i.description && <span style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.description}</span>}
              </span>
              {i.canRemove && (
                <button title="Remove integration" onClick={() => void remove(i.slug)} style={{ width: 26, height: 26, flexShrink: 0, background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
              )}
            </div>
          ))}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <select value={type} onChange={(e) => { setType(e.target.value as AddType); setFields({}); }} style={select}>
              <option value="mcp-stdio">Add MCP server (command)</option>
              <option value="mcp-remote">Add MCP server (remote URL)</option>
              <option value="openapi">Add OpenAPI / REST (URL)</option>
              <option value="graphql">Add GraphQL endpoint</option>
            </select>

            {type === 'openapi' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={fields.url ?? ''} onChange={(e) => setF('url', e.target.value)} placeholder="OpenAPI spec URL" style={{ ...input, flex: 1 }} />
                <input value={fields.slug ?? ''} onChange={(e) => setF('slug', e.target.value)} placeholder="slug" style={{ ...input, flex: '0 0 28%' }} />
              </div>
            )}
            {type === 'mcp-stdio' && (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={fields.name ?? ''} onChange={(e) => setF('name', e.target.value)} placeholder="Name" style={{ ...input, flex: '0 0 38%' }} />
                  <input value={fields.command ?? ''} onChange={(e) => setF('command', e.target.value)} placeholder="command (must speak MCP, e.g. npx)" style={{ ...input, flex: 1 }} />
                </div>
                <input value={fields.args ?? ''} onChange={(e) => setF('args', e.target.value)} placeholder="args (space-separated, e.g. -y @scope/mcp-server)" style={input} />
              </>
            )}
            {type === 'mcp-remote' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={fields.name ?? ''} onChange={(e) => setF('name', e.target.value)} placeholder="Name" style={{ ...input, flex: '0 0 38%' }} />
                <input value={fields.endpoint ?? ''} onChange={(e) => setF('endpoint', e.target.value)} placeholder="https://host/mcp" style={{ ...input, flex: 1 }} />
              </div>
            )}
            {type === 'graphql' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={fields.endpoint ?? ''} onChange={(e) => setF('endpoint', e.target.value)} placeholder="GraphQL endpoint URL" style={{ ...input, flex: 1 }} />
                <input value={fields.slug ?? ''} onChange={(e) => setF('slug', e.target.value)} placeholder="slug" style={{ ...input, flex: '0 0 28%' }} />
              </div>
            )}

            <button onClick={() => void add()} disabled={!canAdd} style={addBtn(canAdd)}>{busy ? 'Adding…' : 'Add integration'}</button>
          </div>
        </>
      )}

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
git commit -m "feat(web): Settings Integrations UI — list, add (OpenAPI/MCP/GraphQL), remove"
```

---

## Self-Review

**1. Spec coverage (phase 2 = "Settings Integrations UI — list / add / remove via /api/integrations"):**
- List → Task 1 `list()` + Task 2 `GET /` + Task 3 UI list. ✅
- Add (OpenAPI / MCP / GraphQL) → Task 1 `add()` + Task 2 `POST /` + Task 3 add form. ✅
- Remove → Task 1 `remove()` + Task 2 `DELETE /:slug` + Task 3 remove button (gated on `canRemove`). ✅
- executor-not-installed handling → Task 2 routes (409/empty) + Task 3 install prompt. ✅
- Secret-safety (token server-side only) → Task 1 `defaultDeleteCatalogEntry` reads token, never returns it; routes return only integration data. ✅
- CLIs explicitly deferred (no native support) — not in this plan. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✅

**3. Type consistency:** `Integration`/`AddIntegrationInput`/`AddIntegrationResult` identical across core (Task 1) and web (Task 3). Route shapes (`{installed, integrations}`, `AddIntegrationResult`, `{removed}`) match between Task 2 and the web client (Task 3). `IntegrationsDeps.run`/`deleteCatalogEntry` used consistently in Task 1 impl + tests. ✅

## Post-merge (manual, by the user — NOT in this plan)

Activation requires the executor daemon and a Dispatch restart:
```bash
npm i -g executor   # already installed during probing
pnpm --filter dispatch-server build && ./bin/dispatch restart
```
The restart ends the active dev session, so it is left to the user.
