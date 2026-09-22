# Control Plane Agent Selector — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick the worker harness and coordinator model for a Control Plane session (inline setup card), with per-agent-type worker-matrix plumbing in the daemon — coordinator stays on Claude.

**Architecture:** The daemon gains a worker matrix (app_state-backed settings) plus a pure resolution function; `ensureCoordinator` accepts `{ model, workerHarness }`; `spawn_agent`/`queue_agent` gain a `harness` arg resolved server-side via a new worker-defaults endpoint. The web peeks for an existing coordinator instead of auto-creating, and renders a setup card in the empty state.

**Tech Stack:** TypeScript, Express, better-sqlite3 (app_state), vitest + supertest (core), React + zustand + vitest (web).

**Spec:** `docs/superpowers/specs/2026-09-22-control-plane-agent-selector-design.md`

## Global Constraints

- Coordinator stays `claude-code` in Phase 1. Only workers get harness choice.
- Claude model aliases (`sonnet`/`opus`/`fable`) must NEVER reach a non-Claude CLI.
- Resolution order (first match wins): explicit spawn args → per-agent-type matrix → session default (`config.workerHarness`) → built-ins (claude: `MODEL_FOR_TYPE`; others: harness default model / CLI default).
- Empty ensure body must behave byte-identically to today.
- An existing coordinator NEVER shows the setup card.
- Naming hazard: `AgentType` in `providers/agent-types.ts` = harness wire type (`'claude-code' | 'codex' | 'grok' | 'opencode'`); `AgentType` in `overseer/agency-mcp.ts` = persona type (`'planner' | 'implementer' | ...`). Alias harness imports as `HarnessType` in new code.
- TDD every task: write the failing test, watch it fail, implement, watch it pass, commit.
- Run tests from `packages/core` or `packages/web` with `npx vitest run <file>`.
- Do NOT run the web vite build (the daemon serves `packages/web/dist`).
- Commits end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Worker-matrix settings storage

**Files:**
- Create: `packages/core/src/settings/overseer-workers.ts`
- Test: `packages/core/src/settings/overseer-workers.test.ts`

**Interfaces:**
- Produces: `WorkerPick = { harness?: HarnessType; model?: string }`,
  `OverseerWorkers = { byType: Partial<Record<PersonaType, WorkerPick>> }` where `PersonaType = 'planner' | 'implementer' | 'researcher' | 'reviewer' | 'design-reviewer' | 'code-reviewer'`,
  `readOverseerWorkers(db): OverseerWorkers`, `updateOverseerWorkers(db, patch): OverseerWorkers`.
- Consumes: `appState.get/set` from `../db/app-state.js` (same pattern as `settings/harness-settings.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/settings/overseer-workers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { readOverseerWorkers, updateOverseerWorkers } from './overseer-workers.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('overseer workers settings', () => {
  let d: ReturnType<typeof db>;
  beforeEach(() => { d = db(); });

  it('reads empty byType when nothing stored', () => {
    expect(readOverseerWorkers(d)).toEqual({ byType: {} });
  });

  it('stores and reads a per-type pick', () => {
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'codex', model: 'gpt-5-codex' } } });
    expect(readOverseerWorkers(d).byType.implementer).toEqual({ harness: 'codex', model: 'gpt-5-codex' });
  });

  it('merges per type; null clears an entry', () => {
    updateOverseerWorkers(d, { byType: { planner: { harness: 'grok' }, implementer: { harness: 'codex' } } });
    updateOverseerWorkers(d, { byType: { planner: null } });
    const w = readOverseerWorkers(d);
    expect(w.byType.planner).toBeUndefined();
    expect(w.byType.implementer).toEqual({ harness: 'codex' });
  });

  it('drops unknown harnesses, unknown persona types, and empty entries', () => {
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'shell' }, wizard: { harness: 'codex' }, planner: {} } } as never);
    expect(readOverseerWorkers(d)).toEqual({ byType: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/settings/overseer-workers.test.ts`
Expected: FAIL — cannot resolve `./overseer-workers.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/settings/overseer-workers.ts
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { isAgentType as isHarnessType, type AgentType as HarnessType } from '../providers/agent-types.js';

/**
 * The Control Plane worker matrix: which harness/model each spawned agent TYPE runs
 * on. Daemon-side (app_state), like harness-settings, because agency-mcp resolves it
 * at spawn time with no browser in the loop. Global on purpose: it survives "New
 * session" and Control Plane resets (spec: per-agent-type plumbing, no UI yet).
 */
export const PERSONA_TYPES = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;
export type PersonaType = (typeof PERSONA_TYPES)[number];

export interface WorkerPick { harness?: HarnessType; model?: string }
export interface OverseerWorkers { byType: Partial<Record<PersonaType, WorkerPick>> }

const STATE_KEY = 'overseer_workers';

const pickString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function sanitizePick(v: unknown): WorkerPick | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const rec = v as Record<string, unknown>;
  const out: WorkerPick = {};
  const harness = pickString(rec.harness);
  if (harness && isHarnessType(harness)) out.harness = harness;
  const model = pickString(rec.model);
  if (model) out.model = model;
  return Object.keys(out).length ? out : undefined;
}

function sanitize(raw: unknown): OverseerWorkers {
  const out: OverseerWorkers = { byType: {} };
  if (!raw || typeof raw !== 'object') return out;
  const byType = (raw as Record<string, unknown>).byType;
  if (!byType || typeof byType !== 'object') return out;
  for (const type of PERSONA_TYPES) {
    const pick = sanitizePick((byType as Record<string, unknown>)[type]);
    if (pick) out.byType[type] = pick;
  }
  return out;
}

export function readOverseerWorkers(db: Database.Database): OverseerWorkers {
  const stored = appState.get(db, STATE_KEY);
  if (stored == null) return { byType: {} };
  try { return sanitize(JSON.parse(stored)); } catch { return { byType: {} }; }
}

/** Merge per persona type; explicit null clears that type's entry. */
export function updateOverseerWorkers(db: Database.Database, patch: unknown): OverseerWorkers {
  const current = readOverseerWorkers(db);
  if (patch && typeof patch === 'object') {
    const byType = (patch as Record<string, unknown>).byType;
    if (byType && typeof byType === 'object') {
      for (const type of PERSONA_TYPES) {
        const p = (byType as Record<string, unknown>)[type];
        if (p === undefined) continue;
        if (p === null) { delete current.byType[type]; continue; }
        current.byType[type] = { ...(current.byType[type] ?? {}), ...(p as object) } as WorkerPick;
      }
    }
  }
  const clean = sanitize(current);
  appState.set(db, STATE_KEY, JSON.stringify(clean));
  return clean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/settings/overseer-workers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings/overseer-workers.ts packages/core/src/settings/overseer-workers.test.ts
git commit -m "feat(core): overseer worker-matrix settings storage"
```

---

### Task 2: Expose the matrix on the harness-settings routes

**Files:**
- Modify: `packages/core/src/routes/harness-settings.ts`
- Test: `packages/core/src/routes/harness-settings.test.ts` (extend if it exists; create otherwise)

**Interfaces:**
- Consumes: Task 1's `readOverseerWorkers` / `updateOverseerWorkers`.
- Produces: `GET /api/settings/harnesses` response gains `overseerWorkers: OverseerWorkers`; new `PUT /api/settings/harnesses/overseer-workers` (body = patch, response = the clean `OverseerWorkers`).

- [ ] **Step 1: Write the failing test** (check for an existing `harness-settings.test.ts` first; if present, ADD these cases to it, matching its app/db helpers)

```ts
// packages/core/src/routes/harness-settings.test.ts (new cases)
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { createHarnessSettingsRouter } from './harness-settings.js';

function app() {
  const db = new Database(':memory:');
  initSchema(db);
  const a = express();
  a.use(express.json());
  a.use('/api/settings/harnesses', createHarnessSettingsRouter(db));
  return a;
}

describe('overseer workers via harness settings routes', () => {
  it('GET payload includes overseerWorkers', async () => {
    const res = await request(app()).get('/api/settings/harnesses');
    expect(res.status).toBe(200);
    expect(res.body.overseerWorkers).toEqual({ byType: {} });
  });

  it('PUT /overseer-workers stores and returns the clean matrix', async () => {
    const a = app();
    const res = await request(a)
      .put('/api/settings/harnesses/overseer-workers')
      .send({ byType: { implementer: { harness: 'codex' } } });
    expect(res.status).toBe(200);
    expect(res.body.byType.implementer).toEqual({ harness: 'codex' });
    const after = await request(a).get('/api/settings/harnesses');
    expect(after.body.overseerWorkers.byType.implementer).toEqual({ harness: 'codex' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/routes/harness-settings.test.ts`
Expected: FAIL — `overseerWorkers` undefined; PUT route 404.

- [ ] **Step 3: Implement**

In `packages/core/src/routes/harness-settings.ts`:

```ts
import { readOverseerWorkers, updateOverseerWorkers } from '../settings/overseer-workers.js';
```

Change `payload`:

```ts
const payload = async () => ({ settings: readHarnessSettings(db), opencodeKey: await keyStatus(), opencodeModels: opencodeModels(db), overseerWorkers: readOverseerWorkers(db) });
```

Add before `return router;`:

```ts
// The Control Plane worker matrix (per-agent-type harness/model). Plumbing only —
// no picker UI edits this yet; spawn-time resolution reads it (overseer/worker-matrix).
router.put('/overseer-workers', (req, res) => {
  res.json(updateOverseerWorkers(db, req.body));
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/routes/harness-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/harness-settings.ts packages/core/src/routes/harness-settings.test.ts
git commit -m "feat(core): expose the overseer worker matrix on the harness-settings routes"
```

---

### Task 3: Pure worker resolution function

**Files:**
- Create: `packages/core/src/overseer/worker-matrix.ts`
- Test: `packages/core/src/overseer/worker-matrix.test.ts`

**Interfaces:**
- Consumes: Task 1's types (`OverseerWorkers`, `PersonaType`, `WorkerPick`), `HarnessType`.
- Produces: `resolveWorker(input: { agentType: PersonaType; explicit?: WorkerPick; matrix: OverseerWorkers; sessionDefault?: HarnessType }): { harness: HarnessType; model?: string }`. `model` is `undefined` when the spawn path should fall through to its existing defaults (claude tiers / opencode settings / CLI default).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/overseer/worker-matrix.test.ts
import { describe, it, expect } from 'vitest';
import { resolveWorker } from './worker-matrix.js';

const empty = { byType: {} };

describe('resolveWorker', () => {
  it('defaults to claude-code with no model (existing tiers apply downstream)', () => {
    expect(resolveWorker({ agentType: 'implementer', matrix: empty })).toEqual({ harness: 'claude-code' });
  });

  it('explicit args win over everything', () => {
    const matrix = { byType: { implementer: { harness: 'grok' as const, model: 'x' } } };
    expect(resolveWorker({ agentType: 'implementer', explicit: { harness: 'codex', model: 'gpt-5-codex' }, matrix, sessionDefault: 'opencode' }))
      .toEqual({ harness: 'codex', model: 'gpt-5-codex' });
  });

  it('explicit model without harness keeps the resolved harness', () => {
    expect(resolveWorker({ agentType: 'researcher', explicit: { model: 'opus' }, matrix: empty }))
      .toEqual({ harness: 'claude-code', model: 'opus' });
  });

  it('matrix entry beats session default', () => {
    const matrix = { byType: { planner: { harness: 'grok' as const } } };
    expect(resolveWorker({ agentType: 'planner', matrix, sessionDefault: 'codex' })).toEqual({ harness: 'grok' });
  });

  it('session default applies when the matrix has no entry for the type', () => {
    expect(resolveWorker({ agentType: 'reviewer', matrix: empty, sessionDefault: 'codex' })).toEqual({ harness: 'codex' });
  });

  it('a matrix model rides only with its own harness pick', () => {
    const matrix = { byType: { implementer: { model: 'gpt-5-codex' } } };
    // Matrix sets only a model: it applies on top of the session-default harness.
    expect(resolveWorker({ agentType: 'implementer', matrix, sessionDefault: 'codex' }))
      .toEqual({ harness: 'codex', model: 'gpt-5-codex' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/overseer/worker-matrix.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/overseer/worker-matrix.ts
import type { AgentType as HarnessType } from '../providers/agent-types.js';
import type { OverseerWorkers, PersonaType, WorkerPick } from '../settings/overseer-workers.js';

/**
 * Resolve which harness/model a Control Plane worker runs on. Precedence
 * (spec: Phase 1 worker resolution order):
 *   explicit spawn args → per-agent-type matrix → session default → claude-code.
 * Fields resolve independently: an explicit model without a harness rides on the
 * otherwise-resolved harness. A returned `model: undefined` means "let the spawn
 * path apply its existing defaults" (claude tiers / opencode settings / CLI default).
 */
export function resolveWorker(input: {
  agentType: PersonaType;
  explicit?: WorkerPick;
  matrix: OverseerWorkers;
  sessionDefault?: HarnessType;
}): { harness: HarnessType; model?: string } {
  const fromMatrix = input.matrix.byType[input.agentType];
  const harness = input.explicit?.harness ?? fromMatrix?.harness ?? input.sessionDefault ?? 'claude-code';
  const model = input.explicit?.model ?? fromMatrix?.model;
  return model ? { harness, model } : { harness };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/overseer/worker-matrix.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/worker-matrix.ts packages/core/src/overseer/worker-matrix.test.ts
git commit -m "feat(core): pure worker harness/model resolution for the control plane"
```

---

### Task 4: `ensureCoordinator` options + widened lookup + route body

**Files:**
- Modify: `packages/core/src/sessions/service.ts:1673-1697` (`ensureCoordinator`)
- Modify: `packages/core/src/routes/sessions.ts:64-76` (the ensure handler)
- Test: `packages/core/src/sessions/ensure-coordinator.test.ts` (create; if a service test harness already exists for `SessionService`, add there instead)

**Interfaces:**
- Produces: `ensureCoordinator(sessionId: string, opts?: { model?: string; workerHarness?: HarnessType }): terminalsDb.Terminal`. Route passes `req.body` through: `{ model?, workerHarness? }`, both optional strings; `workerHarness` validated with `isAgentType`.
- Consumes: `isAgentType` from `../providers/agent-types.js`.

Behavior:
- Lookup widens from `t.type === 'claude-code'` to `isAgentType(t.type)` (still `config?.role === 'coordinator'`). Phase 1 still CREATES only `claude-code`, but a Phase 2 coordinator on another harness must be FOUND, not shadowed.
- On create: config becomes `{ transport: 'structured', role: 'coordinator', ...(opts.model ? { model: opts.model } : {}), ...(opts.workerHarness ? { workerHarness: opts.workerHarness } : {}) }`.
- On find-existing: opts are IGNORED (the session already exists; the card never shows for an existing coordinator, so opts can only arrive on create). Document this in the JSDoc.

- [ ] **Step 1: Write the failing test.** SessionService construction is heavy; test at the ROUTE level with the service's real db behavior mocked thin. Check how `routes/state.test.ts` / `routes/terminals.test.ts` fake `sessionService` and follow that pattern. The test asserts the two contracts the web relies on:

```ts
// packages/core/src/sessions/ensure-coordinator.test.ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
// Follow the existing routes/sessions test wiring (see routes/*.test.ts for the
// createSessionsRouter signature — it takes the sessionService + broadcaster).
import { createSessionsRouter } from '../routes/sessions.js';

function appWith(svc: any) {
  const a = express();
  a.use(express.json());
  a.use('/api/sessions', createSessionsRouter(svc, undefined));
  return a;
}

describe('POST /overseer/coordinator body pass-through', () => {
  it('forwards model + workerHarness to ensureCoordinator', async () => {
    const svc = { ensureCoordinator: vi.fn().mockReturnValue({ id: 't1' }) };
    const res = await appWith(svc) && await request(appWith(svc))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ model: 'opus', workerHarness: 'codex' });
    expect(res.status).toBe(200);
    expect(svc.ensureCoordinator).toHaveBeenCalledWith('s1', { model: 'opus', workerHarness: 'codex' });
  });

  it('rejects an unknown workerHarness with 400', async () => {
    const svc = { ensureCoordinator: vi.fn() };
    const res = await request(appWith(svc))
      .post('/api/sessions/s1/overseer/coordinator')
      .send({ workerHarness: 'shell' });
    expect(res.status).toBe(400);
    expect(svc.ensureCoordinator).not.toHaveBeenCalled();
  });

  it('empty body behaves as today', async () => {
    const svc = { ensureCoordinator: vi.fn().mockReturnValue({ id: 't1' }) };
    const res = await request(appWith(svc)).post('/api/sessions/s1/overseer/coordinator');
    expect(res.status).toBe(200);
    expect(svc.ensureCoordinator).toHaveBeenCalledWith('s1', {});
  });
});
```

NOTE for the implementer: `createSessionsRouter`'s real signature may differ (it may take an options object; it may require more services). Open `packages/core/src/routes/sessions.ts:1-40` and any existing sessions-route test FIRST and adapt the wiring — the three assertions stay as written.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/sessions/ensure-coordinator.test.ts`
Expected: FAIL — `ensureCoordinator` called with one argument (no opts), and no 400 on bad harness.

- [ ] **Step 3: Implement.** In `routes/sessions.ts`, replace the handler body:

```ts
const ensureCoordinator = (req: import('express').Request, res: import('express').Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const opts: { model?: string; workerHarness?: import('../providers/agent-types.js').AgentType } = {};
    if (typeof body.model === 'string' && body.model.trim()) opts.model = body.model.trim();
    if (body.workerHarness !== undefined) {
      if (typeof body.workerHarness !== 'string' || !isAgentType(body.workerHarness)) {
        return res.status(400).json({ error: 'workerHarness must be one of the agent harness types' });
      }
      opts.workerHarness = body.workerHarness;
    }
    const terminal = sessionService.ensureCoordinator(req.params.id, opts);
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: req.params.id });
    res.json({ terminalId: terminal.id });
  } catch (err: any) {
    res.status(err?.message === 'Session not found' ? 404 : 400).json({ error: err.message });
  }
};
```

Add `import { isAgentType } from '../providers/agent-types.js';` (check it is not already imported).

In `sessions/service.ts`, change `ensureCoordinator`:

```ts
ensureCoordinator(sessionId: string, opts: { model?: string; workerHarness?: AgentType } = {}): terminalsDb.Terminal {
  const session = sessionsDb.getById(this.db, sessionId);
  if (!session) throw new Error('Session not found');

  // Widened to any agent harness: Phase 1 creates only claude-code coordinators, but a
  // Phase 2 coordinator on another harness must be FOUND here, not shadowed by a new one.
  const existing = terminalsDb.listBySession(this.db, sessionId)
    .map(terminalsDb.rowToTerminal)
    .find((t) => isAgentType(t.type) && t.config?.role === 'coordinator');
  if (existing) {
    // opts are intentionally ignored for an existing coordinator: the setup card only
    // shows when no coordinator exists, so options can only arrive at create time.
    this.ensureStructuredAlive(existing.id);
    return existing;
  }

  return this.createTerminal(
    sessionId,
    'claude-code',
    'Overseer',
    undefined,
    undefined,
    undefined,
    {
      transport: 'structured', role: 'coordinator',
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.workerHarness ? { workerHarness: opts.workerHarness } : {}),
    },
  );
}
```

`service.ts` already imports from `../providers/agent-types.js` for `isPeerEligible` — reuse that import (add `isAgentType`/`AgentType` to it if missing). Also update the coordinator-finding sites that duplicate the old filter: `service.ts:1052` (question escalation) and `packages/web` copies come later — in core, grep `t.type === 'claude-code' && t.config?.role === 'coordinator'` and widen each hit the same way.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/sessions/ensure-coordinator.test.ts && npx vitest run`
Expected: new tests PASS; full core suite stays green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/sessions.ts packages/core/src/sessions/ensure-coordinator.test.ts
git commit -m "feat(core): ensureCoordinator accepts model + workerHarness; lookup widened to any agent harness"
```

---

### Task 5: Contain Claude model aliases to claude-code spawns

**Files:**
- Create: `packages/core/src/overseer/spawn-model.ts`
- Modify: `packages/core/src/sessions/service.ts:1970-1977` (the `resolvedModel` block)
- Test: `packages/core/src/overseer/spawn-model.test.ts`

**Interfaces:**
- Produces: `resolveSpawnModel(input: { harness: string; config: { model?: unknown; role?: unknown; agentType?: unknown } | null | undefined; opencodeDefault?: string }): string | undefined`.
- Consumes: `modelFor` from `./prompts.js`.

Behavior: for `harness === 'claude-code'`, exactly today's `modelFor(config)` (explicit `config.model` wins, else `MODEL_FOR_TYPE` tier). For any other harness: an explicit `config.model` wins; `MODEL_FOR_TYPE` is NEVER consulted (aliases must not leak); opencode falls back to `opencodeDefault`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/overseer/spawn-model.test.ts
import { describe, it, expect } from 'vitest';
import { resolveSpawnModel } from './spawn-model.js';

describe('resolveSpawnModel', () => {
  it('claude-code coordinator gets the sonnet tier', () => {
    expect(resolveSpawnModel({ harness: 'claude-code', config: { role: 'coordinator' } })).toBe('sonnet');
  });

  it('claude-code agentType gets its tier', () => {
    expect(resolveSpawnModel({ harness: 'claude-code', config: { agentType: 'researcher', role: 'agent' } })).toBe('opus');
  });

  it('a non-claude worker NEVER receives a Claude tier alias', () => {
    expect(resolveSpawnModel({ harness: 'codex', config: { agentType: 'researcher', role: 'agent' } })).toBeUndefined();
    expect(resolveSpawnModel({ harness: 'grok', config: { role: 'coordinator' } })).toBeUndefined();
  });

  it('an explicit config.model wins on every harness', () => {
    expect(resolveSpawnModel({ harness: 'codex', config: { model: 'gpt-5-codex', agentType: 'implementer' } })).toBe('gpt-5-codex');
  });

  it('opencode falls back to its harness default', () => {
    expect(resolveSpawnModel({ harness: 'opencode', config: { agentType: 'implementer' }, opencodeDefault: 'openrouter/z' })).toBe('openrouter/z');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/overseer/spawn-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/overseer/spawn-model.ts
import { modelFor } from './prompts.js';

/**
 * The spawn-time model for a structured thread, harness-aware. MODEL_FOR_TYPE's
 * Claude aliases (sonnet/opus/fable) are meaningful ONLY to the claude CLI — every
 * other harness gets an explicit config.model or its own default, never a tier alias
 * (grok/codex reject them; opencode would write "sonnet" into opencode.json).
 */
export function resolveSpawnModel(input: {
  harness: string;
  config: { model?: unknown; role?: unknown; agentType?: unknown } | null | undefined;
  opencodeDefault?: string;
}): string | undefined {
  if (input.harness === 'claude-code') return modelFor(input.config as never);
  const explicit = typeof input.config?.model === 'string' && input.config.model.trim() ? input.config.model.trim() : undefined;
  if (explicit) return explicit;
  if (input.harness === 'opencode') return input.opencodeDefault;
  return undefined;
}
```

In `sessions/service.ts`, replace the `resolvedModel` expression (lines 1970-1973):

```ts
const resolvedModel = resolveSpawnModel({
  harness: terminal.type,
  config,
  opencodeDefault: readHarnessSettings(this.db).opencode?.defaultModel ?? OPENCODE_DEFAULT_MODEL,
});
```

Add `import { resolveSpawnModel } from '../overseer/spawn-model.js';`. The persist-back block (`if (resolvedModel && !config.model) …`) stays untouched. Note the existing comment above the block should be updated to say the resolution is harness-aware now.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/overseer/spawn-model.test.ts && npx vitest run`
Expected: PASS; full suite green (existing opencode-default behavior is preserved: `modelFor` returned undefined for a plain opencode thread, and the new function returns `opencodeDefault` for it — identical outcome).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/spawn-model.ts packages/core/src/overseer/spawn-model.test.ts packages/core/src/sessions/service.ts
git commit -m "fix(core): claude model tier aliases no longer leak to non-claude spawns"
```

---

### Task 6: Worker-defaults endpoint

**Files:**
- Modify: `packages/core/src/routes/sessions.ts` (add route after the ensure handler)
- Test: `packages/core/src/routes/worker-defaults.test.ts`

**Interfaces:**
- Produces: `GET /api/sessions/:id/overseer/worker-defaults?agentType=<PersonaType>` → `{ harness: HarnessType, model?: string, available: boolean, reason?: string }`.
- Consumes: Task 1 (`readOverseerWorkers`), Task 3 (`resolveWorker`), `harnessCapabilities()` from `../providers/capabilities.js`, `sessionService` for the coordinator's `config.workerHarness`.

Behavior:
- `agentType` must be a `PersonaType`, else 400.
- Session default = the project's live coordinator's `config.workerHarness` (find with the widened filter from Task 4; absent coordinator or field ⇒ no session default).
- `available` = the resolved harness has `modes.length > 0` in `harnessCapabilities()` (structured transport enabled server-side). `reason` set when false. (CLI-not-installed still surfaces at create time via the existing spawn error path — spawn_agent already propagates create failures to the coordinator.)

- [ ] **Step 1: Write the failing test.** Same wiring caveat as Task 4 — mirror the real `createSessionsRouter` signature. The fake service needs `listTerminalsForSession`-equivalent access; check how routes/sessions.ts reads terminals today and mock at that seam. Assertions:

```ts
// packages/core/src/routes/worker-defaults.test.ts — assertions to keep verbatim
// 1. ?agentType=implementer with matrix { implementer: { harness: 'codex' } } → { harness: 'codex', available: <bool> }
// 2. no matrix entry + coordinator config.workerHarness='grok' → { harness: 'grok' }
// 3. no matrix, no coordinator → { harness: 'claude-code', available: true }
// 4. ?agentType=wizard → 400
```

Write these as four `it(...)` cases with supertest against an in-memory db (`initSchema` + `sessionsDb.create` + `terminalsDb` insert for the coordinator row, following the Task 1/2 db pattern), so the matrix and coordinator config are REAL rather than mocked.

- [ ] **Step 2: Run to verify it fails** — route 404.

- [ ] **Step 3: Implement** in `routes/sessions.ts`:

```ts
// GET /api/sessions/:id/overseer/worker-defaults?agentType= — the resolved harness/model
// a spawned worker of this type would get (explicit spawn args excluded — those are the
// caller's own override). agency-mcp calls this before creating a worker thread.
router.get('/:id/overseer/worker-defaults', (req, res) => {
  const agentType = req.query.agentType;
  if (typeof agentType !== 'string' || !(PERSONA_TYPES as readonly string[]).includes(agentType)) {
    return res.status(400).json({ error: `agentType must be one of: ${PERSONA_TYPES.join(', ')}` });
  }
  const coordinator = sessionService.findCoordinator(req.params.id); // added below
  const sessionDefault = coordinator?.config?.workerHarness;
  const resolved = resolveWorker({
    agentType: agentType as PersonaType,
    matrix: readOverseerWorkers(db),
    sessionDefault: typeof sessionDefault === 'string' && isAgentType(sessionDefault) ? sessionDefault : undefined,
  });
  const cap = harnessCapabilities().find((h) => h.type === resolved.harness);
  const available = !!cap && cap.modes.length > 0;
  res.json({ ...resolved, available, ...(available ? {} : { reason: `${resolved.harness} structured transport is disabled on this server` }) });
});
```

Imports to add: `PERSONA_TYPES, type PersonaType, readOverseerWorkers` (settings/overseer-workers.js), `resolveWorker` (overseer/worker-matrix.js), `harnessCapabilities` (providers/capabilities.js), `isAgentType` (providers/agent-types.js). The router needs `db` — check what `createSessionsRouter` already receives; pass the db in if it does not (follow how other routers get it).

In `sessions/service.ts`, extract the widened find from Task 4 into a small public method so the route and `ensureCoordinator` share one filter:

```ts
/** The project's live coordinator thread, any agent harness (null when none). */
findCoordinator(sessionId: string): terminalsDb.Terminal | null {
  return terminalsDb.listBySession(this.db, sessionId)
    .map(terminalsDb.rowToTerminal)
    .find((t) => isAgentType(t.type) && t.config?.role === 'coordinator') ?? null;
}
```

and use it inside `ensureCoordinator` (replacing the inline `.find(...)`) and at `service.ts:1052` (the escalation site) if that site duplicated the filter.

- [ ] **Step 4: Run tests** — new file + full core suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/sessions.ts packages/core/src/sessions/service.ts packages/core/src/routes/worker-defaults.test.ts
git commit -m "feat(core): worker-defaults endpoint resolves harness/model per agent type"
```

---

### Task 7: `spawn_agent` / `queue_agent` harness pass-through

**Files:**
- Create: `packages/core/src/overseer/worker-payload.ts`
- Modify: `packages/core/src/overseer/agency-mcp.ts` (schemas ~lines 83-160; `spawnAgent` :405-426; `queueAgent` :436-459)
- Test: `packages/core/src/overseer/worker-payload.test.ts`

**Interfaces:**
- Produces: `buildWorkerCreateBody(input: { agentType: string; label: string; resolved: { harness: string; model?: string }; explicitModel?: string; mission?: string; dependsOn?: string; spawnDepth: number; queued?: boolean; task?: string }): Record<string, unknown>` — the exact POST body for `/api/sessions/:id/terminals`.
- Consumes (in agency-mcp): Task 6's endpoint via the existing `httpJson` helper.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/overseer/worker-payload.test.ts
import { describe, it, expect } from 'vitest';
import { buildWorkerCreateBody } from './worker-payload.js';

describe('buildWorkerCreateBody', () => {
  it('claude default matches the pre-selector wire shape exactly', () => {
    expect(buildWorkerCreateBody({ agentType: 'implementer', label: 'implementer agent', resolved: { harness: 'claude-code' }, spawnDepth: 1 }))
      .toEqual({ type: 'claude-code', label: 'implementer agent', config: { transport: 'structured', agentType: 'implementer', role: 'agent', spawnDepth: 1 } });
  });

  it('a resolved non-claude harness sets type and model', () => {
    const body = buildWorkerCreateBody({ agentType: 'planner', label: 'planner agent', resolved: { harness: 'codex', model: 'gpt-5-codex' }, spawnDepth: 1, mission: 'Auth' });
    expect(body.type).toBe('codex');
    expect(body.config).toEqual({ transport: 'structured', agentType: 'planner', role: 'agent', mission: 'Auth', model: 'gpt-5-codex', spawnDepth: 1 });
  });

  it('explicit model overrides the resolved one; queued adds queued+task+dependsOn', () => {
    const body = buildWorkerCreateBody({ agentType: 'reviewer', label: 'r', resolved: { harness: 'grok', model: 'x' }, explicitModel: 'grok-4', spawnDepth: 2, queued: true, task: 'T', dependsOn: 'a1' });
    expect(body).toEqual({
      type: 'grok', label: 'r', queued: true, task: 'T',
      config: { transport: 'structured', agentType: 'reviewer', role: 'agent', dependsOn: 'a1', model: 'grok-4', spawnDepth: 2 },
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/overseer/worker-payload.ts
/**
 * The terminals-create body for a Control Plane worker. Extracted pure so the wire
 * shape is testable without running the agency-mcp process. Field order and omission
 * rules mirror the historical spawnAgent/queueAgent bodies exactly — the claude-code
 * default case must stay byte-compatible with pre-selector daemons' expectations.
 */
export function buildWorkerCreateBody(input: {
  agentType: string; label: string;
  resolved: { harness: string; model?: string };
  explicitModel?: string; mission?: string; dependsOn?: string;
  spawnDepth: number; queued?: boolean; task?: string;
}): Record<string, unknown> {
  const model = input.explicitModel || input.resolved.model || '';
  return {
    type: input.resolved.harness,
    label: input.label,
    ...(input.queued ? { queued: true, task: input.task ?? '' } : {}),
    config: {
      transport: 'structured', agentType: input.agentType, role: 'agent',
      ...(input.mission ? { mission: input.mission } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      ...(model ? { model } : {}),
      spawnDepth: input.spawnDepth,
    },
  };
}
```

In `agency-mcp.ts`:

1. Both tool schemas gain (after `model`):

```ts
harness: {
  type: 'string',
  enum: ['claude-code', 'codex', 'grok', 'opencode'],
  description:
    'Optional harness (agent CLI) for this worker. Omit to use the configured default: ' +
    'the per-agent-type worker matrix, else the session default the user picked, else claude-code. ' +
    'Only override when the task clearly benefits from a specific harness.',
},
```

2. `spawnAgent` becomes (same change mirrored in `queueAgent`, keeping its `dependsOn`/`queued`/`task` handling):

```ts
async function spawnAgent(args: { agentType: AgentType; name?: string; task: string; mission?: string; model?: string; harness?: string }): Promise<{ agentId: string; label: string; mission?: string }> {
  if (!args?.agentType) throw new Error('agentType is required');
  if (!args?.task) throw new Error('task is required');
  const depthCheck = checkSpawnDepth(selfSpawnDepth());
  if (!depthCheck.ok) throw new Error(depthCheck.reason);
  const label = args.name || `${args.agentType} agent`;
  const mission = typeof args.mission === 'string' ? args.mission.trim() : '';
  const model = typeof args.model === 'string' ? args.model.trim() : '';
  const harness = typeof args.harness === 'string' ? args.harness.trim() : '';
  const childDepth = selfSpawnDepth() + 1;

  // Server-side resolution: matrix + session default live in the daemon (one tested
  // place); an explicit `harness` arg here overrides the resolved harness.
  const defaults = await httpJson('GET', `${apiBase()}/api/sessions/${sessionId()}/overseer/worker-defaults?agentType=${encodeURIComponent(args.agentType)}`) as { harness: string; model?: string; available: boolean; reason?: string };
  const resolved = harness ? { harness, model: undefined } : { harness: defaults.harness, model: defaults.model };
  if (!harness && !defaults.available) throw new Error(defaults.reason || `${defaults.harness} is not available on this server`);

  const terminal = await httpJson('POST', `${apiBase()}/api/sessions/${sessionId()}/terminals`,
    buildWorkerCreateBody({ agentType: args.agentType, label, resolved, explicitModel: model, mission, spawnDepth: childDepth }));
  const agentId: string | undefined = terminal?.id;
  if (!agentId) throw new Error('spawn did not return a terminal id');
  await httpJson('POST', `${apiBase()}/api/terminals/${agentId}/message`, { text: args.task, source: 'coordinator' });
  return { agentId, label, ...(mission ? { mission } : {}) };
}
```

Add `import { buildWorkerCreateBody } from './worker-payload.js';`. In `queueAgent`, pass `queued: true, task: args.task, dependsOn` into `buildWorkerCreateBody` and keep its return shape.

3. Also update both `model` descriptions: change "pins it to a specific Claude model" to "pins it to a specific model for its harness" and note the tier-alias sentence applies to claude-code workers only.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/overseer/worker-payload.test.ts && npx vitest run && npm run build`
Expected: PASS + suite green + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/worker-payload.ts packages/core/src/overseer/worker-payload.test.ts packages/core/src/overseer/agency-mcp.ts
git commit -m "feat(core): spawn_agent/queue_agent resolve and honor the worker harness"
```

---

### Task 8: Web API client + types

**Files:**
- Modify: `packages/web/src/api/client.ts:107-109` (`ensureOverseerCoordinator`), `:114-117` area (harness settings)
- Modify: `packages/web/src/api/types.ts` (`HarnessSettingsResponse`)
- Test: none (type-level + pass-through; covered by Task 10's store tests)

**Interfaces:**
- Produces: `ensureOverseerCoordinator(sessionId, opts?: { model?: string; workerHarness?: string })`; `putOverseerWorkers(patch)`; `HarnessSettingsResponse.overseerWorkers`.

- [ ] **Step 1: Implement** (no behavior to test in isolation — the store tests in Task 10 exercise it):

```ts
// client.ts — replace ensureOverseerCoordinator
// Overseer: find-or-create this project's coordinator thread (idempotent) → { terminalId }.
// opts apply only when this call CREATES the coordinator (setup card / first directive).
ensureOverseerCoordinator: (sessionId: string, opts?: { model?: string; workerHarness?: string }) =>
  req<{ terminalId: string }>(`/api/sessions/${sessionId}/overseer/coordinator`, { method: 'POST', ...(opts && Object.keys(opts).length ? { body: body(opts) } : {}) }),
// The Control Plane worker matrix (per-agent-type harness/model) — plumbing, no UI yet.
putOverseerWorkers: (patch: { byType: Record<string, { harness?: string; model?: string } | null> }) =>
  req<{ byType: Record<string, { harness?: string; model?: string }> }>('/api/settings/harnesses/overseer-workers', { method: 'PUT', body: body(patch) }),
```

In `types.ts`, add to `HarnessSettingsResponse`:

```ts
overseerWorkers?: { byType: Record<string, { harness?: string; model?: string }> };
```

Check the POST helper: if `req` sets `Content-Type` only when a body exists, the no-opts call stays byte-identical to today (verify by reading `req` at the top of client.ts).

- [ ] **Step 2: Type-check**

Run: `cd packages/web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/api/types.ts
git commit -m "feat(web): api plumbing for coordinator options + worker matrix"
```

---

### Task 9: Extract a shared HarnessStrip component

**Files:**
- Create: `packages/web/src/components/common/HarnessStrip.tsx`
- Modify: `packages/web/src/components/sidebar/NewThreadModal.tsx` (delete the inline marks + strip JSX at :34-81 and :396-450; consume the shared component)
- Test: `packages/web/src/components/common/HarnessStrip.test.tsx`

**Interfaces:**
- Produces:
```ts
export function HarnessStrip(props: {
  harnesses: { id: string; label: string }[];
  value: string;
  onSelect: (id: string) => void;
  isAvailable?: (id: string) => boolean;   // default: always true
  mobile: boolean;                          // pill row (bleed) vs segmented grid
  markSize?: { mobile: number; desktop: number }; // default { mobile: 16, desktop: 18 }
}): JSX.Element;
export const HARNESS_MARK: Record<string, (p: { size: number }) => JSX.Element>;
```
- MOVE (do not copy) `ClaudeMark`, `OpenAIMark`, `GrokMark`, `OpenCodeMark`, `TerminalMark`, `HARNESS_MARK`, and the two strip renderings (NewThreadModal.tsx:34-81, :396-450) into the new file, converting the `harness`/`selectHarness`/`isAvailable` closures into the props above. Keep the exact styles (ON_BG/ON_RING/BORDER/ACCENT constants move too, or import them if they are shared). Guard the unknown-id crash: `const Mark = HARNESS_MARK[h.id] ?? TerminalMark;`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/common/HarnessStrip.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HarnessStrip } from './HarnessStrip';

const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

describe('HarnessStrip', () => {
  it('renders a pressed state on the selected harness and fires onSelect', () => {
    const onSelect = vi.fn();
    render(<HarnessStrip harnesses={HARNESSES} value="claude" onSelect={onSelect} mobile={false} />);
    expect(screen.getByRole('button', { name: /Claude Code/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

  it('dims and tags an unavailable harness with Install', () => {
    render(<HarnessStrip harnesses={HARNESSES} value="claude" onSelect={() => {}} isAvailable={(id) => id !== 'codex'} mobile={false} />);
    expect(screen.getByText('Install')).toBeTruthy();
  });

  it('does not crash on an unknown harness id', () => {
    render(<HarnessStrip harnesses={[{ id: 'future', label: 'Future' }]} value="future" onSelect={() => {}} mobile />);
    expect(screen.getByRole('button', { name: /Future/ })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/web && npx vitest run src/components/common/HarnessStrip.test.tsx` — module not found.

- [ ] **Step 3: Implement the move**, then update `NewThreadModal.tsx` to `import { HarnessStrip, HARNESS_MARK } from '../common/HarnessStrip';` and replace :396-450 with:

```tsx
<HarnessStrip
  harnesses={harnesses}
  value={harness}
  onSelect={(id) => { const h = harnesses.find(x => x.id === id); if (h) selectHarness(h); }}
  isAvailable={(id) => { const h = harnesses.find(x => x.id === id); return h ? isAvailable(h) : true; }}
  mobile={m}
/>
```

(`selectHarness` takes the full spec object today — keep its signature and adapt at the call site as shown.)

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run src/components/common/HarnessStrip.test.tsx src/components/sidebar/NewThreadModal.test.tsx src/components/sidebar/NewThreadModal.capabilities.test.tsx`
Expected: all PASS — the NewThreadModal suites are the regression net for the extraction.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/common/HarnessStrip.tsx packages/web/src/components/common/HarnessStrip.test.tsx packages/web/src/components/sidebar/NewThreadModal.tsx
git commit -m "refactor(web): extract the shared HarnessStrip from NewThreadModal"
```

---

### Task 10: Store sequencing — peek, setup state, create-with-options

**Files:**
- Modify: `packages/web/src/components/overseer/store.ts` (`ensureForProject` :329-366; `newCoordinatorSession` :368-379; state fields; the greeting block :743-746)
- Test: `packages/web/src/components/overseer/setup-sequencing.test.ts`

**Interfaces:**
- Produces (store additions):
  - state: `setupNeeded: boolean` (default false), `setupSelection: { workerHarness: string; model: string }` (default `{ workerHarness: 'claude-code', model: 'sonnet' }`)
  - actions: `setSetupSelection(patch: Partial<{ workerHarness: string; model: string }>): void`, `startCoordinator(sessionId: string): Promise<void>` (calls `api.ensureOverseerCoordinator(sessionId, { model, workerHarness })`, clears `setupNeeded`, sets `coordinatorId`)
- Consumes: `api.listTerminals`, Task 8's `ensureOverseerCoordinator(sessionId, opts)`.

Behavior changes in `ensureForProject`:
- After the reset `set({...})` (add `setupNeeded: false` to the reset fields), call `api.listTerminals(sessionId)` and look for `t.config?.role === 'coordinator'` where `t.type !== 'shell'` (mirror of the daemon's widened filter; web `Terminal` rows carry `type`).
- Found → exactly today's path: `api.ensureOverseerCoordinator(sessionId)` (no body) to revive, then set `coordinatorId`.
- None → `set({ setupNeeded: true, ensuring: false })`; NO create call.
- `listTerminals` failure → fall back to today's behavior (plain ensure), so a flaky fetch never strands the card.

`newCoordinatorSession`: unchanged flow — after archiving, `ensureForProject` now peeks, finds none, and shows the card. Verify no code change is needed beyond the peek (the guard-clear at :376 already re-runs it).

The greeting (`store.ts:744-746`): when `setupNeeded`, suppress the canned greeting message (the card carries the copy):

```ts
const base: StreamMessage[] = gatedStream.length
  ? gatedStream
  : get().setupNeeded ? [] : [m('overseer', 'Control Plane', CANNED.emptyGreeting, '', 'greeting')];
```

(Adapt to how the memoized selector accesses state — if `setupNeeded` must join the dependency array at :769, add it.)

Composer first-directive path: find the store's send action (the one `Composer.tsx` calls with the directive text; grep `sendStructuredMessage(coordinatorId` in store.ts). At its top:

```ts
if (!get().coordinatorId && get().setupNeeded) {
  const sessionId = get().coordinatorProject ?? useProjects.getState().activeId;
  if (sessionId) await get().startCoordinator(sessionId);
}
```

then proceed with the existing send using the fresh `coordinatorId`.

- [ ] **Step 1: Write the failing test.** Follow the existing overseer store test file's setup if one exists (grep `store.test` under components/overseer); otherwise mock `../../api/client` with `vi.mock` and drive the zustand store directly:

```ts
// packages/web/src/components/overseer/setup-sequencing.test.ts — cases to implement
// 1. ensureForProject: listTerminals returns a coordinator row → ensureOverseerCoordinator
//    called with NO opts; setupNeeded stays false.
// 2. ensureForProject: listTerminals returns [] → NO ensure call; setupNeeded true.
// 3. startCoordinator: calls ensureOverseerCoordinator(sessionId, { model, workerHarness })
//    with the current setupSelection; sets coordinatorId; clears setupNeeded.
// 4. listTerminals rejects → ensure called with no opts (fallback), setupNeeded false.
```

Write all four as real `it(...)` cases with `vi.mock`'d api (`listTerminals`, `ensureOverseerCoordinator` as `vi.fn()`), asserting call args and store state via `useOverseer.getState()`.

- [ ] **Step 2: Run to verify it fails** — `cd packages/web && npx vitest run src/components/overseer/setup-sequencing.test.ts`.

- [ ] **Step 3: Implement** the store changes above.

- [ ] **Step 4: Run tests** — new file + the full web suite (`npx vitest run`) green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/overseer/store.ts packages/web/src/components/overseer/setup-sequencing.test.ts
git commit -m "feat(web): control plane peeks before creating; setup state + create-with-options"
```

---

### Task 11: The setup card component + rendering

**Files:**
- Create: `packages/web/src/components/overseer/components/SetupCard.tsx`
- Modify: `packages/web/src/components/overseer/components/Stream.tsx` (render the card when `setupNeeded`)
- Modify: `packages/web/src/components/overseer/OverseerMobile.tsx` (same, in the stream tab)
- Test: `packages/web/src/components/overseer/components/SetupCard.test.tsx`

**Interfaces:**
- Consumes: Task 9's `HarnessStrip`, `SearchSelect` from `../../common/SearchSelect`, Task 10's store fields (`setupSelection`, `setSetupSelection`, `startCoordinator`), `api.getHarnessCapabilities`, `HARNESSES` from `../../../lib/harnesses`.
- Produces: `export function ControlPlaneSetupCard(): JSX.Element` — self-contained (reads the store itself, no props), so both Stream and OverseerMobile mount it bare.

Component content:
- Header copy (replaces the canned greeting): `"I'm Control Plane — the coordinator for this project."` and a one-line sub: `"Pick the agents I run, then fire the first directive — or just start."`
- `HarnessStrip` bound to `setupSelection.workerHarness`, listing the AGENT harnesses only (filter `id !== 'terminal'`), phone variant via `useIsMobile()`. Availability from `api.getHarnessCapabilities` like NewThreadModal:117-128 (seed from `HARNESSES`, replace on load, filter `modes.length > 0`). Label the section `Workers`.
- One model row labeled `Coordinator model`: a `SearchSelect` over the claude catalog models (`HARNESSES.find(h => h.id === 'claude').models`), value `setupSelection.model`, default `'sonnet'`.
- A Start button: `onClick={() => startCoordinator(sessionId)}` where `sessionId = useOverseer(s => s.coordinatorProject) ?? useProjects.getState().activeId`. Disabled while a start is in flight.
- Note: the strip uses catalog ids (`claude`/`codex`/...) but the daemon wants wire types (`claude-code`/...). Map on selection: `const WIRE: Record<string,string> = { claude: 'claude-code', codex: 'codex', grok: 'grok', opencode: 'opencode' };` and store the WIRE value in `setupSelection.workerHarness` (display-select by reverse lookup).

Rendering: in `Stream.tsx` (the `ConversationStream` export), before the message list, render:

```tsx
{setupNeeded && <ControlPlaneSetupCard />}
```

with `const setupNeeded = useOverseer((s) => s.setupNeeded);`. Same one-liner in `OverseerMobile.tsx`'s stream tab body. Find each component's top-level scroll container and place the card as its first child; match surrounding container styles (padding, maxWidth) by reading the neighboring JSX.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/overseer/components/SetupCard.test.tsx — cases
// 1. renders the Workers strip (four agent harnesses, no Terminal pill) and the
//    Coordinator model select with 'sonnet' preselected.
// 2. selecting Codex updates the store: setupSelection.workerHarness === 'codex'.
// 3. Start calls startCoordinator with the active project id.
```

Write with @testing-library/react; mock `../../../api/client` (`getHarnessCapabilities` resolving the four agent harnesses) and seed `useOverseer.setState({ setupNeeded: true, coordinatorProject: 'p1', ... })`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** the component + the two mount points.

- [ ] **Step 4: Run tests** — new file + full web suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/overseer/components/SetupCard.tsx packages/web/src/components/overseer/components/SetupCard.test.tsx packages/web/src/components/overseer/components/Stream.tsx packages/web/src/components/overseer/OverseerMobile.tsx
git commit -m "feat(web): control plane inline setup card (worker harness + coordinator model)"
```

---

### Task 12: Widen the web's coordinator filters

**Files:**
- Modify: `packages/web/src/components/overseer/components/CoordinatorMenu.tsx:75` (archived filter `x.type === 'claude-code' && x.config?.role === 'coordinator'`)
- Modify: any other web-side `type === 'claude-code' … role === 'coordinator'` filters — grep `role === 'coordinator'` across `packages/web/src` and widen each to drop the type check (keep `config?.role === 'coordinator'`; a coordinator row is created only by the daemon, so role alone identifies it)
- Test: extend the existing `CoordinatorMenu` test if present; otherwise add a focused test asserting a `codex`-typed archived coordinator appears in "Previous sessions…"

- [ ] **Step 1: Failing test** — archived list contains `{ type: 'codex', config: { role: 'coordinator' } }` → it must be offered.
- [ ] **Step 2: Watch it fail.**
- [ ] **Step 3: Implement the widened filters.**
- [ ] **Step 4: Web suite green.**
- [ ] **Step 5: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): coordinator filters accept any agent harness (phase 2 ready)"
```

---

### Task 13: Full verification + PR

- [ ] **Step 1: Full core suite + build**: `cd packages/core && npx vitest run && npm run build` — expect all green, tsc clean.
- [ ] **Step 2: Full web suite + type check**: `cd packages/web && npx vitest run && npx tsc --noEmit` — green. (No vite build.)
- [ ] **Step 3: Live smoke via the verify skill** (isolated daemon): create a project, POST `overseer/coordinator` with `{ "workerHarness": "codex" }`, confirm the terminal row's config carries it; GET `worker-defaults?agentType=implementer` returns `{ harness: 'codex', ... }`; PUT a matrix entry and confirm it wins over the session default.
- [ ] **Step 4: Open the PR** (do NOT merge — per-action approval):

```bash
git push -u origin <branch>
gh pr create --title "feat: control plane agent selector — phase 1 (worker harness + coordinator model)" --body "<summary of tasks, spec link, test counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Report CI status and stop.

---

## Self-review notes (kept honest)

- Spec coverage: daemon opts (T4), widened lookup (T4/T6/T12), spawn harness arg + resolution order (T3/T6/T7), matrix storage w/o UI (T1/T2), alias containment (T5), availability guard (T6/T7), api plumbing (T8), extraction (T9), peek + card + first-directive (T10/T11), New-session-shows-card (T10, via peek), Previous-sessions widen (T12). No spec item uncovered.
- Known wiring unknowns are flagged inline where the implementer must read first (Task 4/6 router signatures, Task 10 send-action name, Task 11 mount points). These are look-and-adapt points, not TBDs — the assertions and behavior are fully specified.
- Type consistency: `WorkerPick`/`OverseerWorkers`/`PersonaType` defined in T1 and consumed by name in T3/T6; `resolveWorker` (T3) consumed in T6; `buildWorkerCreateBody` (T7) self-contained; store fields `setupNeeded`/`setupSelection`/`startCoordinator` defined in T10 and consumed in T11.
