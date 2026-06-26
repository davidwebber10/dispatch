# Integration Layer (executor) — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make executor's single MCP catalog available to BOTH Claude Code and Codex on every spawn, so an integration is configured once and works in whichever model is active (kills "set up twice"). Plus minimal Settings status.

**Architecture:** Generalize Dispatch's existing per-spawn MCP injection (today Doppler-only) into a shared composer that merges N MCP server specs into one Claude `--mcp-config` file + one set of Codex `-c mcp_servers…` args. A new `IntegrationsService` contributes executor's MCP server spec + a system-prompt hint and reports executor status. Later phases (full Settings UI, secrets bridge, export/import, agent-assisted add) are separate plans.

**Tech Stack:** Node 18+/TypeScript ESM (`.js` specifiers), Express, better-sqlite3, vitest+supertest (core), React/Vite (web). External: `executor` npm CLI (MIT, v1.5.20+).

## Global Constraints

- ESM only; import specifiers end in `.js`.
- Injection must be a **no-op when executor is absent** (spawns must always work).
- Doppler injection behavior must be **unchanged** after the refactor (regression guard).
- Codex MCP server shape mirrors the existing Doppler pattern: `-c mcp_servers.<name>.command=…`, `.args=[…]`, optional `.env_vars=[…]`.
- Core change → daemon restart to ship; only restart the local daemon on explicit user intent.
- Commit after each task. Don't push unless asked.

## File Structure

- `packages/core/src/mcp/injection.ts` — **New.** `McpServerSpec` type + `composeInjection(specs, prompts)` → `{ claudeConfigPath, codexArgs, systemPrompt }` (writes the merged Claude config, builds merged Codex args, joins prompts).
- `packages/core/src/secrets/service.ts` — **Modify.** `getInjection()` returns its Doppler `McpServerSpec` + prompt via a new `getServerSpec()`; keep `getInjection()` working (delegates to the composer) so existing callers/tests pass.
- `packages/core/src/integrations/service.ts` — **New.** `IntegrationsService`: `status()`, `getServerSpec()`, `getSystemPrompt()`.
- `packages/core/src/sessions/service.ts` — **Modify.** Compose Doppler + executor specs at spawn (extend the existing `secretsInjection` seam to a combined injection).
- `packages/core/src/server.ts` — **Modify.** Construct `IntegrationsService`; wire combined injection; mount integrations router.
- `packages/core/src/routes/integrations.ts` — **New.** `GET /api/integrations/status`.
- `packages/core/tests/mcp/injection.test.ts`, `tests/integrations/service.test.ts`, `tests/routes/integrations.test.ts` — **New.**
- `packages/web/src/api/types.ts` + `client.ts` — **Modify.** `IntegrationsStatus` + `getIntegrationsStatus()`.
- `packages/web/src/components/settings/IntegrationsSection.tsx` — **New.** Minimal status + install hint; rendered in SettingsModal.

---

### Task 1: Probe executor's real CLI/MCP surface (discovery)

**Files:** none (records findings into this plan's later tasks via the commit message + a short note file).

- [ ] **Step 1: Install executor**

Run: `npm install -g executor && executor --version`
Expected: prints a version ≥ 1.5.20.

- [ ] **Step 2: Capture the command surface**

Run: `executor --help; echo '---'; executor mcp --help 2>&1 | head -40`
Record, in `docs/superpowers/notes/executor-cli.md` (create it): (a) the exact MCP launch — is it a stdio command (e.g. `executor mcp`) or an HTTP/SSE URL; (b) whether it needs `executor daemon` running; (c) the add-source command; (d) the catalog/config file path; (e) the `tools sources`/list command.

- [ ] **Step 3: Determine the MCP server spec**

From Step 2, write down the `McpServerSpec` executor needs (used in Task 4), e.g. `{ name: 'executor', command: 'executor', args: ['mcp'], env: {} }`. If executor's MCP is HTTP-only, note the URL form (Claude supports `{ type: 'http', url }`; Codex stdio-only may need `executor mcp` as a stdio bridge — record which).

- [ ] **Step 4: Commit the note**

```bash
git add docs/superpowers/notes/executor-cli.md
git commit -m "docs: record executor CLI/MCP surface for integration wiring"
```

---

### Task 2: Shared MCP injection composer

**Files:**
- Create: `packages/core/src/mcp/injection.ts`
- Test: `packages/core/tests/mcp/injection.test.ts`

**Interfaces:**
- Produces:
  - `interface McpServerSpec { name: string; command: string; args: string[]; env?: Record<string, string>; envVars?: string[] }` (`env` = literal env map for the Claude config; `envVars` = names for Codex `env_vars`).
  - `composeInjection(specs: McpServerSpec[], opts: { configPath: string; prompts: string[] }): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/mcp/injection.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { composeInjection } from '../../src/mcp/injection.js';

describe('composeInjection', () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 'mcp.json');

  it('returns nulls/[] when there are no specs', () => {
    const r = composeInjection([], { configPath, prompts: [] });
    expect(r).toEqual({ claudeConfigPath: null, codexArgs: [], systemPrompt: null });
  });

  it('merges multiple servers into one Claude config + Codex args', () => {
    const r = composeInjection([
      { name: 'doppler', command: 'node', args: ['/x/doppler.js'], env: { DOPPLER_TOKEN: '${DOPPLER_TOKEN}' }, envVars: ['DOPPLER_TOKEN'] },
      { name: 'executor', command: 'executor', args: ['mcp'] },
    ], { configPath, prompts: ['use doppler', 'use executor'] });

    const cfg = JSON.parse(fs.readFileSync(r.claudeConfigPath!, 'utf-8'));
    expect(Object.keys(cfg.mcpServers)).toEqual(['doppler', 'executor']);
    expect(cfg.mcpServers.executor).toEqual({ command: 'executor', args: ['mcp'] });
    expect(r.codexArgs).toContain('mcp_servers.executor.command="executor"');
    expect(r.codexArgs).toContain('mcp_servers.doppler.env_vars=["DOPPLER_TOKEN"]');
    expect(r.systemPrompt).toBe('use doppler\n\nuse executor');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/mcp/injection.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/injection.js`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/mcp/injection.ts
import * as fs from 'fs';
import * as path from 'path';

export interface McpServerSpec { name: string; command: string; args: string[]; env?: Record<string, string>; envVars?: string[]; }

export function composeInjection(specs: McpServerSpec[], opts: { configPath: string; prompts: string[] }): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null } {
  if (specs.length === 0) return { claudeConfigPath: null, codexArgs: [], systemPrompt: null };

  const mcpServers: Record<string, unknown> = {};
  const codexArgs: string[] = [];
  for (const s of specs) {
    mcpServers[s.name] = { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) };
    codexArgs.push('-c', `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
    codexArgs.push('-c', `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
    if (s.envVars?.length) codexArgs.push('-c', `mcp_servers.${s.name}.env_vars=${JSON.stringify(s.envVars)}`);
  }
  fs.mkdirSync(path.dirname(opts.configPath), { recursive: true });
  fs.writeFileSync(opts.configPath, JSON.stringify({ mcpServers }, null, 2));
  const prompts = opts.prompts.filter(Boolean);
  return { claudeConfigPath: opts.configPath, codexArgs, systemPrompt: prompts.length ? prompts.join('\n\n') : null };
}
```

Note: the Codex `args` assertion in the test expects exact JSON — adjust the test's expected `mcp_servers.executor.command="executor"` to match `JSON.stringify('executor')` which is `"executor"` (already correct).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/mcp/injection.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/injection.ts packages/core/tests/mcp/injection.test.ts
git commit -m "feat(core): shared MCP injection composer (merge N servers → claude config + codex args)"
```

---

### Task 3: SecretsService emits a spec via the composer (no behavior change)

**Files:**
- Modify: `packages/core/src/secrets/service.ts`
- Test: existing `tests/routes/setup.test.ts` + add `tests/secrets/injection.test.ts`

**Interfaces:**
- Produces on `SecretsService`: `getServerSpec(): McpServerSpec | null` (the Doppler spec) and `getSystemPrompt()` (already exists). `getInjection()` keeps its existing return shape but is implemented via `composeInjection([doppler spec], …)` so existing callers are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/secrets/injection.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { SecretsService } from '../../src/secrets/service.js';

it('getServerSpec is null when Doppler is not connected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const svc = new SecretsService(dir);
  expect(svc.getServerSpec()).toBeNull();
  expect(svc.getInjection()).toEqual({ claudeConfigPath: null, codexArgs: [], systemPrompt: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/secrets/injection.test.ts`
Expected: FAIL — `getServerSpec` is not a function.

- [ ] **Step 3: Implement**

In `secrets/service.ts`: import `{ composeInjection, McpServerSpec } from '../mcp/injection.js'`. Add:

```ts
  getServerSpec(): McpServerSpec | null {
    if (!this.active()) return null;
    return {
      name: 'doppler', command: 'node', args: [this.dopplerMcpPath],
      env: { DOPPLER_TOKEN: '${DOPPLER_TOKEN}', DOPPLER_PROJECT: '${DOPPLER_PROJECT}', DOPPLER_CONFIG: '${DOPPLER_CONFIG}', DOPPLER_READ_ONLY: '${DOPPLER_READ_ONLY}' },
      envVars: ['DOPPLER_TOKEN', 'DOPPLER_PROJECT', 'DOPPLER_CONFIG', 'DOPPLER_READ_ONLY'],
    };
  }
```

Reimplement `getInjection()` to delegate:

```ts
  getInjection(): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null } {
    const spec = this.getServerSpec();
    return composeInjection(spec ? [spec] : [], { configPath: this.mcpConfigPath, prompts: [this.getSystemPrompt() ?? ''] });
  }
```

Keep `ensureClaudeMcpConfig()`/`codexMcpArgs()` for any other internal callers, or delete if unused (grep first).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run tests/secrets/injection.test.ts tests/routes/setup.test.ts`
Expected: PASS (Doppler injection shape unchanged → setup route test still green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/secrets/service.ts packages/core/tests/secrets/injection.test.ts
git commit -m "refactor(core): SecretsService emits an McpServerSpec via the shared composer"
```

---

### Task 4: IntegrationsService + combined spawn injection

**Files:**
- Create: `packages/core/src/integrations/service.ts`
- Modify: `packages/core/src/sessions/service.ts` (compose secrets + integrations), `packages/core/src/server.ts` (construct + wire)
- Test: `packages/core/tests/integrations/service.test.ts`

**Interfaces:**
- Produces: `class IntegrationsService { constructor(); status(): { installed: boolean; version: string | null }; getServerSpec(): McpServerSpec | null; getSystemPrompt(): string | null }`.
- `getServerSpec()` returns the executor spec **from Task 1** (e.g. `{ name: 'executor', command: 'executor', args: ['mcp'] }`) only when executor is installed; else null.
- Consumes: `composeInjection` (Task 2), `SecretsService.getServerSpec()` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/integrations/service.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFileSync: () => { throw new Error('not installed'); } }));
import { IntegrationsService } from '../../src/integrations/service.js';

it('reports not installed + null spec when executor is absent', () => {
  const svc = new IntegrationsService();
  expect(svc.status().installed).toBe(false);
  expect(svc.getServerSpec()).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/integrations/service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/integrations/service.ts
import { execFileSync } from 'node:child_process';
import type { McpServerSpec } from '../mcp/injection.js';

export class IntegrationsService {
  private detected: { installed: boolean; version: string | null } | null = null;

  status(): { installed: boolean; version: string | null } {
    if (this.detected) return this.detected;
    try {
      const v = execFileSync('executor', ['--version'], { encoding: 'utf-8', timeout: 4000 }).trim();
      this.detected = { installed: true, version: v };
    } catch { this.detected = { installed: false, version: null }; }
    return this.detected;
  }

  // The executor MCP server spec recorded in Task 1. Update command/args to the
  // real surface from docs/superpowers/notes/executor-cli.md.
  getServerSpec(): McpServerSpec | null {
    if (!this.status().installed) return null;
    return { name: 'executor', command: 'executor', args: ['mcp'] };
  }

  getSystemPrompt(): string | null {
    if (!this.status().installed) return null;
    return 'An "executor" MCP server exposes your shared integration catalog (the same tools across Claude and Codex). Use its tools to call integrations, and its management tools to add a new integration when given API docs, a CLI, or an MCP. Store any credentials in Doppler.';
  }
}
```

In `sessions/service.ts`: add `private integrationsInjection: (() => { spec: McpServerSpec | null; prompt: string | null }) | null = null;` + `setIntegrationsInjection(fn)`, and at spawn, replace the single secrets injection with a composed one:

```ts
import { composeInjection, type McpServerSpec } from '../mcp/injection.js';
// at spawn, instead of `const secretsMcp = this.secretsInjection?.()`:
const specs: McpServerSpec[] = [];
const prompts: string[] = [];
const sec = this.secretsServerSpec?.(); if (sec?.spec) { specs.push(sec.spec); if (sec.prompt) prompts.push(sec.prompt); }
const intg = this.integrationsInjection?.(); if (intg?.spec) { specs.push(intg.spec); if (intg.prompt) prompts.push(intg.prompt); }
const secretsMcp = composeInjection(specs, { configPath: this.mcpConfigPath, prompts });
```

(Add a `mcpConfigPath` to sessionService — a path under the data dir, e.g. `~/.dispatch/mcp.json` — and a `setSecretsServerSpec(fn)` returning `{spec, prompt}` from SecretsService. Keep the existing `secretsMcp` variable name so the downstream `provider.build*Command({ secretsMcp })` calls are unchanged.)

In `server.ts` (both `createApp` and `startServer`): construct `const integrationsService = new IntegrationsService();`, wire `sessionService.setSecretsServerSpec(() => ({ spec: secretsService.getServerSpec(), prompt: secretsService.getSystemPrompt() }))` and `sessionService.setIntegrationsInjection(() => ({ spec: integrationsService.getServerSpec(), prompt: integrationsService.getSystemPrompt() }))`.

- [ ] **Step 4: Run to verify it passes + full core suite**

Run: `pnpm --filter dispatch-server exec vitest run tests/integrations/service.test.ts && pnpm --filter dispatch-server exec tsc --noEmit && pnpm --filter dispatch-server exec vitest run`
Expected: new test passes; tsc clean; full suite green (Doppler-injection + spawn tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/integrations/service.ts packages/core/src/sessions/service.ts packages/core/src/server.ts packages/core/tests/integrations/service.test.ts
git commit -m "feat(core): IntegrationsService — inject executor MCP into both providers via the shared composer"
```

---

### Task 5: Status route + minimal Settings section

**Files:**
- Create: `packages/core/src/routes/integrations.ts`
- Modify: `packages/core/src/server.ts` (mount), `packages/web/src/api/types.ts`, `packages/web/src/api/client.ts`, `packages/web/src/components/settings/SettingsModal.tsx`
- Create: `packages/web/src/components/settings/IntegrationsSection.tsx`
- Test: `packages/core/tests/routes/integrations.test.ts`

**Interfaces:**
- `GET /api/integrations/status` → `{ installed: boolean; version: string | null }`.
- Web: `IntegrationsStatus` type; `api.getIntegrationsStatus()`.

- [ ] **Step 1: Write the failing route test**

```ts
// packages/core/tests/routes/integrations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('integrations routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });
  it('GET /api/integrations/status returns the installed shape', async () => {
    const res = await request(app).get('/api/integrations/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.installed).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/integrations.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement the router + mount**

```ts
// packages/core/src/routes/integrations.ts
import { Router } from 'express';
import type { IntegrationsService } from '../integrations/service.js';

export function createIntegrationsRouter(integrations: IntegrationsService): Router {
  const router = Router();
  router.get('/status', (_req, res) => res.json(integrations.status()));
  return router;
}
```

In `server.ts` (both apps): `app.use('/api/integrations', createIntegrationsRouter(integrationsService));`

- [ ] **Step 4: Web client + Settings section**

`api/types.ts`: `export interface IntegrationsStatus { installed: boolean; version: string | null }`.
`api/client.ts`: `getIntegrationsStatus: () => req<IntegrationsStatus>('/api/integrations/status'),` (+ import the type).
`components/settings/IntegrationsSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { IntegrationsStatus } from '../../api/types';

export function IntegrationsSection() {
  const [s, setS] = useState<IntegrationsStatus | null>(null);
  useEffect(() => { void api.getIntegrationsStatus().then(setS).catch(() => setS({ installed: false, version: null })); }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }}>INTEGRATIONS</span>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
        {s == null ? 'Checking…'
          : s.installed ? `executor ${s.version} — connected. Integrations are shared across Claude & Codex.`
          : 'executor not installed. Install with: npm i -g executor — then it’s shared across Claude & Codex.'}
      </div>
    </div>
  );
}
```

Render `<IntegrationsSection />` in `SettingsModal.tsx` (general tab, after the existing sections, with a `<Divider />`).

- [ ] **Step 5: Run tests + typecheck + build**

Run: `pnpm --filter dispatch-server exec vitest run tests/routes/integrations.test.ts && pnpm --filter dispatch-web exec tsc --noEmit && pnpm --filter dispatch-web build`
Expected: route test passes; web typecheck + build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/routes/integrations.ts packages/core/src/server.ts packages/core/tests/routes/integrations.test.ts packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/components/settings/IntegrationsSection.tsx packages/web/src/components/settings/SettingsModal.tsx
git commit -m "feat: /api/integrations/status + Settings integrations status section"
```

---

### Task 6: End-to-end verify + deploy

- [ ] **Step 1: Full suites + builds**

Run: `pnpm --filter dispatch-server exec vitest run && pnpm --filter dispatch-web exec vitest run && pnpm -r run build`
Expected: all green.

- [ ] **Step 2: Manual injection check (no restart)**

Confirm a spawned thread's Claude `--mcp-config` file (under `~/.dispatch/mcp.json`) contains both `doppler` (if connected) and `executor` servers, and the Codex args include `mcp_servers.executor`. (Inspect via a temporary log or by reading the written file after a spawn on a throwaway terminal.)

- [ ] **Step 3: Deploy**

Commit/push; then restart the daemon **on explicit user intent** (ends the session) so the new injection + routes go live. After restart: open a new Claude thread and a Codex thread, confirm the executor tools appear in both.

---

## Self-Review

- **Spec coverage:** MVP = "executor MCP available to both models" (Tasks 2-4) + minimal Settings status (Task 5) + executor probe (Task 1). Later spec phases (full Integrations UI with add/remove, Doppler→executor env bridge, export/import, agent-assisted add) are intentionally deferred to follow-up plans — noted in the spec's phasing.
- **Placeholder scan:** the only deferred value is executor's exact MCP command, which Task 1 discovers and Task 4 plugs in (documented dependency, not a placeholder).
- **Type consistency:** `McpServerSpec` (Task 2) is reused by Tasks 3-4; `composeInjection` signature consistent; `IntegrationsStatus` matches the route shape.
- **Risk:** Task 3 refactors working Doppler injection — guarded by re-running `tests/routes/setup.test.ts` (which asserts the Doppler-connected `secrets.connected` path) + the new injection test. If Codex rejects the merged `-c` arg form, fall back to per-server `--mcp-config`-only for Claude and keep Codex args identical to today's Doppler pattern (same shape, just more servers).
