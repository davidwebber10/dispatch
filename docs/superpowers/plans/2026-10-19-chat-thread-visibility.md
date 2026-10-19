# Chat thread visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat shows delegated thread work live (a per-project thread list, a "Started" card, waiting threads first), opens threads and spec/plan docs in place, and lists in-progress docs per project.

**Architecture:** The core adds a `spawnedBy` field at spawn, a pane-thread collector behind `GET /api/endless/projects`, and a read-only doc resolver and lister behind three new Chat routes. The web store reloads the pane on the thread events the daemon already broadcasts. New Chat components draw the pane, the Started card (from the existing `spawn_agent` tool rows), doc chips and a doc viewer. Threads open in the Overseer's existing `WorkerLightbox`.

**Tech Stack:** TypeScript, Node (better-sqlite3, Express, `child_process.execFileSync` for git), React 18 with zustand, vitest with Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-chat-thread-visibility-design.md` (approved 2026-10-19). Section numbers below refer to it.

**Visual reference:** the git-ignored boards in `docs/superpowers/specs/2026-10-19-chat-thread-visibility-designs.local/` (spec section 15). Read the board for a screen before you build it. Copy the values (sizes, colors, spacing), not the markup. Where a board and the spec differ, the spec wins.

## Global Constraints

- The repository is public. No real person, company or project names in code, tests, comments, commits or the PR. Tests use neutral names (`studio`, `rollup`, `dispatch`, `analytics`).
- Never commit `*.local.md` or `*.local/` files.
- Test runs: one vitest process at a time, never two in parallel. Run single files with `node node_modules/vitest/vitest.mjs run <file>` from the package folder (`packages/core` or `packages/web`). Do not call `npx vitest` (a shell hook rewrites it into a full suite run). The vitest configs already cap workers to half the cores and the heap to 1.5 GB; do not override `--maxWorkers`.
- Do not pipe a test run through `head` or `tail`. Write the output to a file, then read the file.
- Never kill a process you did not start. If a test run you did not start is alive, wait for it.
- Core tests never touch the real HOME; the core vitest setup already fakes it. Tests that make git repos create them inside a fresh `fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-'))` folder per test and remove only that folder.
- The visible label is "Open in Threads". The code name of that view stays `workspace` (`View` in `packages/web/src/stores/ui.ts`).
- Read-only doc routes: no write, rename or delete; only `.md`, `.markdown`, `.txt`; real paths inside a registered project folder; 2 MB cap; git through `execFileSync` (no shell), 5 s timeout, branch names only from the server's own `git for-each-ref` list.
- The model's per-turn input must not change: `collectProjects` and `buildStatusBlock` stay as they are.
- No em-dashes in user-facing copy.
- Tasks 1 to 7 are group 1 (spec items 1 to 6); tasks 8 to 12 are group 2 (doc links). One draft PR carries both groups as ordered commits.

## File Structure

**Core (`packages/core`)**

| File | Change | Responsibility |
|---|---|---|
| `src/overseer/worker-payload.ts` | modify | `spawnedBy` in the worker config |
| `src/overseer/agency-shared.ts` | modify | `WorkerSpec.spawnedBy` passed through `createWorker` |
| `src/overseer/agency-mcp.ts` | modify | `spawnAgent`, `queueAgent` send `spawnedBy` |
| `src/endless/memory-mcp.ts` | modify | the `spawn_agent` result gains `projectId` |
| `src/endless/pane.ts` | create | `collectPaneThreads`: the pane's thread rows |
| `src/endless/service.ts` | modify | `projects()` returns `{ projects, threads, truncated }`; owns a `DocsService` |
| `src/endless/store.ts` | modify | `lastWorkMentioning(project, needle)` |
| `src/overseer/source-file.ts` | modify | export the path helpers; `.worktrees/` and `git worktree list` |
| `src/docs/git.ts` | create | small git wrapper (worktrees, refs, blobs) |
| `src/docs/resolve.ts` | create | `resolveDoc`: the right copy of one doc |
| `src/docs/list.ts` | create | `listDocs`: in-progress docs of one project, cached |
| `src/docs/service.ts` | create | `DocsService`: project lookup + the two calls above |
| `src/routes/endless.ts` | modify | `GET /doc`, `GET /docs`, `GET /docs/counts` |
| `src/overseer/prompts.ts` | modify | the doc report rule in `AGENT_AUTONOMY_NOTE` |

**Web (`packages/web/src`)**

| File | Change | Responsibility |
|---|---|---|
| `api/types.ts`, `api/client.ts` | modify | pane and doc types and calls |
| `stores/endless.ts` | modify | threads, watch/unwatch, debounced reload, timer, visibility |
| `stores/ui.ts` | modify | `requestOpenProject` intent |
| `stores/docViewer.ts` | create | the open doc and its back stack |
| `stores/settings.ts` | modify | `editor` setting |
| `components/endless/threadView.ts` | create | `useThreadView(id)`: pane row merged with the live overlay |
| `components/endless/openThread.ts` | create | `openThreadInPlace(projectId, terminalId)` |
| `components/endless/StateMark.tsx` | create | the 5 state shapes |
| `components/endless/StartedItem.tsx` | create | the Started card |
| `components/endless/EndlessMessageRow.tsx` | modify | run pairing in `foldRows`; StartedItem; report card opens in place; doc chips |
| `components/endless/ProjectsPanel.tsx` | modify | Needs you, project blocks, rows, Done today, Docs fold |
| `components/endless/DocsFold.tsx` | create | the per-project Docs list |
| `components/endless/DocViewer.tsx` | create | the doc viewer modal |
| `components/endless/ChatMode.tsx` | modify | watch, lightbox mount, badge, doc viewer mount, sheet close |
| `components/overseer/components/WorkerLightbox.tsx` | modify | optional `onOpenFull` ghost button |
| `lib/docPaths.ts` | create | `findDocPaths(text)` |
| `components/Markdown.tsx` | modify | optional `docs` pass |
| `App.tsx`, `components/mobile/MobileApp.tsx` | modify | consume `requestOpenProject` |
| `components/endless/MemoryInspector.tsx` | modify | the editor choice next to the Chat instructions |

---

## Group 1: thread visibility (spec items 1 to 6)

### Task 1: Core records who spawned a worker

**Files:**
- Modify: `packages/core/src/overseer/worker-payload.ts`
- Modify: `packages/core/src/overseer/agency-shared.ts:93-103`
- Modify: `packages/core/src/overseer/agency-mcp.ts:626-668`
- Modify: `packages/core/src/endless/memory-mcp.ts:234-253`
- Test: `packages/core/src/overseer/worker-payload.test.ts`, `packages/core/tests/overseer/agency-mcp.test.ts`, `packages/core/tests/endless/memory-mcp.test.ts`

**Interfaces:**
- Produces: `config.spawnedBy?: string` on every worker created through the agency MCP (the spawner's terminal id). `buildWorkerCreateBody(input: { ...; spawnedBy?: string })`. `WorkerSpec.spawnedBy?: string`. The Chat `spawn_agent` result is `{ agentId, label, project, projectId, folder }`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/overseer/worker-payload.test.ts`, inside `describe('buildWorkerCreateBody', ...)`:

```ts
  it('writes spawnedBy into config after spawnDepth', () => {
    const body = buildWorkerCreateBody({ agentType: 'implementer', label: 'x', resolved: { harness: 'claude-code' }, spawnDepth: 2, spawnedBy: 'parent-1' });
    expect(body.config).toEqual({ transport: 'structured', agentType: 'implementer', role: 'agent', spawnDepth: 2, spawnedBy: 'parent-1' });
  });

  it('an empty spawnedBy is omitted, so the old body is byte-identical', () => {
    const a = buildWorkerCreateBody({ agentType: 'implementer', label: 'x', resolved: { harness: 'claude-code' }, spawnDepth: 1, spawnedBy: '' });
    const b = buildWorkerCreateBody({ agentType: 'implementer', label: 'x', resolved: { harness: 'claude-code' }, spawnDepth: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
```

Add to `packages/core/tests/overseer/agency-mcp.test.ts`, after the existing `spawn_agent issues create + seed-message fetches` test:

```ts
  it('spawn_agent records the calling thread as spawnedBy', async () => {
    process.env.DISPATCH_TERMINAL = 'parent-1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(workerDefaultsOk())
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'agent-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    global.fetch = fetchMock as any;
    await callTool('spawn_agent', { agentType: 'researcher', task: 'look' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).config.spawnedBy).toBe('parent-1');
  });

  it('queue_agent records the calling thread as spawnedBy', async () => {
    process.env.DISPATCH_TERMINAL = 'parent-1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(workerDefaultsOk())
      .mockResolvedValueOnce({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'agent-2' }) });
    global.fetch = fetchMock as any;
    await callTool('queue_agent', { agentType: 'researcher', task: 'later' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).config.spawnedBy).toBe('parent-1');
  });
```

In `packages/core/tests/endless/memory-mcp.test.ts:64`, change the expected result of the `spawn_agent resolves the project...` test to include the project id. Read the test's project fixture to get the id it uses (the `GET /api/endless/project` mock); for example, when that mock returns `{ id: 's1', name: 'salsify', folder: '/w/salsify' }`:

```ts
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ agentId: 't9', label: 'Fix login', project: 'salsify', projectId: 's1', folder: '/w/salsify' });
```

- [ ] **Step 2: Run the tests and see them fail**

From `packages/core`:
```
node node_modules/vitest/vitest.mjs run src/overseer/worker-payload.test.ts > /tmp/ctv-t1a.log 2>&1; echo exit $?
node node_modules/vitest/vitest.mjs run tests/overseer/agency-mcp.test.ts > /tmp/ctv-t1b.log 2>&1; echo exit $?
node node_modules/vitest/vitest.mjs run tests/endless/memory-mcp.test.ts > /tmp/ctv-t1c.log 2>&1; echo exit $?
```
Read each log. Expected: the new cases FAIL (`spawnedBy` undefined; `projectId` missing). The old cases pass.

- [ ] **Step 3: Implement**

`packages/core/src/overseer/worker-payload.ts`: add `spawnedBy?: string;` to the input type, and in `config` put this line directly after `spawnDepth: input.spawnDepth,`:

```ts
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
```

`packages/core/src/overseer/agency-shared.ts`:

```ts
export interface WorkerSpec { agentType: AgentType; label: string; mission: string; model: string; harness: string; spawnDepth: number; origin?: 'endless'; spawnedBy?: string }
```
and pass `spawnedBy: spec.spawnedBy` in the `buildWorkerCreateBody` call inside `createWorker`.

`packages/core/src/overseer/agency-mcp.ts`: in `spawnAgent`, the `createWorker` call becomes

```ts
  const agentId = await createWorker(apiBase(), sessionId(), { agentType: args.agentType, label, mission, model, harness, spawnDepth: childDepth, spawnedBy: selfTerminalId() || undefined });
```
and in `queueAgent` add `spawnedBy: selfTerminalId() || undefined` to the `buildWorkerCreateBody({...})` input.

`packages/core/src/endless/memory-mcp.ts:253`:

```ts
        return asText({ agentId, label, project: project.name, projectId: project.id, folder: project.folder });
```

- [ ] **Step 4: Run the three test files again**

Same commands as step 2. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/worker-payload.ts packages/core/src/overseer/worker-payload.test.ts packages/core/src/overseer/agency-shared.ts packages/core/src/overseer/agency-mcp.ts packages/core/tests/overseer/agency-mcp.test.ts packages/core/src/endless/memory-mcp.ts packages/core/tests/endless/memory-mcp.test.ts
git commit -m "feat(core): record the spawning thread on workers; spawn_agent returns the project id"
```

### Task 2: Core collects the pane's thread rows

**Files:**
- Create: `packages/core/src/endless/pane.ts`
- Modify: `packages/core/src/endless/service.ts:284-290` (make `waitingText` callable) and `:406` (`projects()`)
- Test: `packages/core/tests/endless/pane.test.ts` (new), `packages/core/tests/routes/endless.test.ts`, `packages/core/tests/endless/status-block.test.ts` (unchanged, guard)

**Interfaces:**
- Consumes: `config.spawnedBy` (Task 1).
- Produces:

```ts
export type PaneState = 'working' | 'needs_you' | 'queued' | 'error' | 'done' | 'idle';
export type StartedBy = 'chat' | 'overseer' | 'thread' | 'role' | 'user';
export interface PaneThread {
  id: string; project: string; label: string; harness: string; state: PaneState;
  startedBy: StartedBy; via: string | null; startedAt: string; lastActivityAt: string | null; question: string | null;
}
export function collectPaneThreads(db, opts: { now: number; timeZone: string; question: (id: string) => string }): { threads: PaneThread[]; truncated: boolean };
// EndlessService.projects(): { projects: ProjectStatus[]; threads: PaneThread[]; truncated: boolean }
```

- [ ] **Step 1: Write the failing test** `packages/core/tests/endless/pane.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { collectPaneThreads, startOfLocalDay, PANE_MAX_THREADS } from '../../src/endless/pane.js';

const NOW = Date.UTC(2026, 9, 19, 15, 45, 0); // 15:45 UTC
const TODAY = new Date(Date.UTC(2026, 9, 19, 9, 0, 0)).toISOString();
const YESTERDAY = new Date(Date.UTC(2026, 9, 18, 9, 0, 0)).toISOString();
let db: Database.Database;

function thread(id: string, o: { session?: string; type?: string; status?: string; config?: Record<string, unknown>; last?: string | null; label?: string; archived?: boolean } = {}) {
  terminalsDb.create(db, { id, sessionId: o.session ?? 's1', type: o.type ?? 'claude-code', label: o.label ?? id, config: o.config ?? {} });
  if (o.status) terminalsDb.updateStatus(db, id, o.status);
  db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(o.last === undefined ? TODAY : o.last, id);
  if (o.archived) db.prepare('UPDATE terminals SET archived_at = ? WHERE id = ?').run(TODAY, id);
}
const run = (question = (_id: string) => '') => collectPaneThreads(db, { now: NOW, timeZone: 'UTC', question });

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'studio', workingDir: '/w/studio' });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'rollup', workingDir: '/w/rollup' });
});

describe('collectPaneThreads', () => {
  it('local midnight in the daemon time zone', () => {
    expect(startOfLocalDay(NOW, 'UTC')).toBe(Date.UTC(2026, 9, 19, 0, 0, 0));
  });

  it('keeps active threads of any age and finished threads of today only', () => {
    thread('w', { status: 'working', last: YESTERDAY });
    thread('q', { status: 'queued', last: null });
    thread('done-today', { status: 'waiting', config: { role: 'agent' } });
    thread('done-old', { status: 'waiting', config: { role: 'agent' }, last: YESTERDAY });
    expect(run().threads.map((t) => t.id).sort()).toEqual(['done-today', 'q', 'w']);
  });

  it('leaves out archived threads, file tabs and the coordinator', () => {
    thread('arch', { status: 'working', archived: true });
    thread('file', { type: 'file', status: 'working' });
    thread('coord', { status: 'working', config: { role: 'coordinator' } });
    thread('keep', { status: 'working' });
    expect(run().threads.map((t) => t.id)).toEqual(['keep']);
  });

  it('maps the status; an idle worker is done, an idle owner thread is idle', () => {
    thread('a', { status: 'working' });
    thread('b', { status: 'needs_input' });
    thread('c', { status: 'error' });
    thread('d', { status: 'waiting', config: { role: 'agent' } });
    thread('e', { status: 'waiting', config: { origin: 'endless', role: 'agent' } });
    thread('f', { status: 'waiting' });
    const by = Object.fromEntries(run().threads.map((t) => [t.id, t.state]));
    expect(by).toEqual({ a: 'working', b: 'needs_you', c: 'error', d: 'done', e: 'done', f: 'idle' });
  });

  it('orders needs you, working, queued, error, done; newest first inside a group', () => {
    thread('w-old', { status: 'working', last: new Date(Date.UTC(2026, 9, 19, 8)).toISOString() });
    thread('w-new', { status: 'working', last: new Date(Date.UTC(2026, 9, 19, 10)).toISOString() });
    thread('n', { status: 'needs_input' });
    thread('d', { status: 'waiting', config: { role: 'agent' } });
    thread('q', { status: 'queued' });
    thread('e', { status: 'error' });
    expect(run().threads.map((t) => t.id)).toEqual(['n', 'w-new', 'w-old', 'q', 'e', 'd']);
  });

  it('who started it', () => {
    thread('coord', { config: { role: 'coordinator' } });
    thread('chatroot', { status: 'working', config: { role: 'agent', origin: 'endless' } });
    thread('peer', { status: 'working', label: 'Fix PR #2' });
    thread('t-chat', { status: 'working', config: { origin: 'endless', role: 'agent' } });
    thread('t-role', { status: 'working', config: { role: 'agent', roleRun: 'run-1' } });
    thread('t-ov', { status: 'working', config: { role: 'agent', spawnedBy: 'coord' } });
    thread('t-legacy', { status: 'working', config: { role: 'agent' } });
    thread('t-peer', { status: 'working', config: { role: 'agent', spawnedBy: 'peer' } });
    thread('t-chatkid', { status: 'working', config: { role: 'agent', spawnedBy: 'chatroot' } });
    thread('t-user', { status: 'working' });
    const by = Object.fromEntries(run().threads.map((t) => [t.id, [t.startedBy, t.via]]));
    expect(by['t-chat']).toEqual(['chat', null]);
    expect(by['t-role']).toEqual(['role', null]);
    expect(by['t-ov']).toEqual(['overseer', null]);
    expect(by['t-legacy']).toEqual(['overseer', null]);
    expect(by['t-peer']).toEqual(['thread', 'Fix PR #2']);
    expect(by['t-chatkid']).toEqual(['chat', 'chatroot']);
    expect(by['t-user']).toEqual(['user', null]);
  });

  it('fills the question for needs_you only, cut to 280 characters', () => {
    thread('n', { status: 'needs_input' });
    thread('w', { status: 'working' });
    const asked: string[] = [];
    const rows = run((id) => { asked.push(id); return 'x'.repeat(400); }).threads;
    expect(asked).toEqual(['n']);
    expect(rows.find((t) => t.id === 'n')!.question).toHaveLength(280);
    expect(rows.find((t) => t.id === 'w')!.question).toBeNull();
  });

  it('a failing question callback leaves the question empty', () => {
    thread('n', { status: 'needs_input' });
    expect(run(() => { throw new Error('boom'); }).threads[0].question).toBeNull();
  });

  it('caps the response and says so', () => {
    for (let k = 0; k < PANE_MAX_THREADS + 5; k++) thread(`t${k}`, { status: 'working' });
    const r = run();
    expect(r.threads).toHaveLength(PANE_MAX_THREADS);
    expect(r.truncated).toBe(true);
  });
});
```

Add to `packages/core/tests/routes/endless.test.ts`, inside `describe('endless routes', ...)`:

```ts
  it('GET /projects returns the projects, the pane threads and the cut flag', async () => {
    const res = await request(app).get('/api/endless/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(res.body.projects[0]).toMatchObject({ id: 's1' });
    expect(res.body.threads).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });
```

If an existing route test reads `GET /projects` as an array, change it to read `res.body.projects`.

- [ ] **Step 2: Run and see it fail**

From `packages/core`:
```
node node_modules/vitest/vitest.mjs run tests/endless/pane.test.ts > /tmp/ctv-t2a.log 2>&1; echo exit $?
node node_modules/vitest/vitest.mjs run tests/routes/endless.test.ts > /tmp/ctv-t2b.log 2>&1; echo exit $?
```
Expected: `pane.test.ts` fails (module not found); the new route case fails (`res.body.projects` undefined).

- [ ] **Step 3: Implement** `packages/core/src/endless/pane.ts`

```ts
/**
 * The Chat pane's thread rows (spec 2026-10-19 sections 3.2, 3.3, 3.5). Only threads with recent
 * activity: active ones of any age, finished ones of today. The model's status block does not
 * use this; it stays on collectProjects.
 */
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { isAgentType } from '../providers/agent-types.js';

export type PaneState = 'working' | 'needs_you' | 'queued' | 'error' | 'done' | 'idle';
export type StartedBy = 'chat' | 'overseer' | 'thread' | 'role' | 'user';
export interface PaneThread {
  id: string; project: string; label: string; harness: string; state: PaneState;
  startedBy: StartedBy; via: string | null; startedAt: string; lastActivityAt: string | null; question: string | null;
}

export const PANE_MAX_THREADS = 60;
export const QUESTION_MAX_CHARS = 280;
const RANK: Record<PaneState, number> = { needs_you: 0, working: 1, queued: 2, error: 3, done: 4, idle: 4 };

type Cfg = Record<string, unknown>;
const cfgOf = (raw: string | null): Cfg => {
  try { const c = JSON.parse(raw || '{}'); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Local midnight of `now` in `timeZone`, as epoch ms (DST days may be off by the shift; accepted). */
export function startOfLocalDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return now - ((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 - (now % 1000);
}

export function paneState(status: string, cfg: Cfg): PaneState {
  switch (status) {
    case 'working': return 'working';
    case 'needs_input': return 'needs_you';
    case 'queued': return 'queued';
    case 'error': return 'error';
    default: return cfg.role === 'agent' || cfg.origin === 'endless' ? 'done' : 'idle';
  }
}

export function startedByOf(cfg: Cfg, parent: (id: string) => { label: string; cfg: Cfg } | null): { startedBy: StartedBy; via: string | null } {
  if (cfg.origin === 'endless') return { startedBy: 'chat', via: null };
  if (str(cfg.roleRun)) return { startedBy: 'role', via: null };
  if (cfg.role !== 'agent') return { startedBy: 'user', via: null };
  const by = str(cfg.spawnedBy);
  if (!by) return { startedBy: 'overseer', via: null }; // rows from before spawnedBy existed
  const p = parent(by);
  if (!p) return { startedBy: 'thread', via: null };
  if (p.cfg.role === 'coordinator') return { startedBy: 'overseer', via: null };
  if (p.cfg.origin === 'endless') return { startedBy: 'chat', via: p.label };
  return { startedBy: 'thread', via: p.label };
}

export function collectPaneThreads(db: Database.Database, opts: { now: number; timeZone: string; question: (id: string) => string }): { threads: PaneThread[]; truncated: boolean } {
  const midnight = startOfLocalDay(opts.now, opts.timeZone);
  const parent = (id: string) => {
    const r = terminalsDb.getById(db, id);
    return r ? { label: r.label, cfg: cfgOf(r.config) } : null;
  };
  const rows: PaneThread[] = [];
  for (const s of sessionsDb.list(db)) {
    for (const t of terminalsDb.listBySession(db, s.id)) {
      if (!isAgentType(t.type)) continue;
      const cfg = cfgOf(t.config);
      if (cfg.role === 'coordinator') continue;
      const state = paneState(t.status, cfg);
      const last = t.last_activity_at ? Date.parse(t.last_activity_at) : NaN;
      if ((state === 'done' || state === 'idle') && !(last >= midnight)) continue;
      let question: string | null = null;
      if (state === 'needs_you') {
        try { question = opts.question(t.id).trim().slice(0, QUESTION_MAX_CHARS) || null; } catch { question = null; }
      }
      rows.push({ id: t.id, project: s.id, label: t.label, harness: t.type, state, ...startedByOf(cfg, parent), startedAt: t.created_at, lastActivityAt: t.last_activity_at, question });
    }
  }
  const at = (r: PaneThread) => (r.lastActivityAt ? Date.parse(r.lastActivityAt) : 0);
  rows.sort((a, b) => RANK[a.state] - RANK[b.state] || at(b) - at(a));
  return { threads: rows.slice(0, PANE_MAX_THREADS), truncated: rows.length > PANE_MAX_THREADS };
}
```

Note: the `t-chatkid` case expects `via` to be the parent's label. In the test the parent's label is its id (`chatroot`), because `thread()` defaults the label to the id.

`packages/core/src/endless/service.ts`: import `collectPaneThreads, type PaneThread` from `./pane.js`, and replace `projects()`:

```ts
  projects(): { projects: ProjectStatus[]; threads: PaneThread[]; truncated: boolean } {
    const pane = collectPaneThreads(this.o.db, { now: this.now(), timeZone: this.timeZone, question: (id) => this.waitingText(id) });
    return { projects: collectProjects(this.o.db, this.store), ...pane };
  }
```
`waitingText` is already a method of the class; leave it `private` (it is called inside the class).

- [ ] **Step 4: Run the tests again**

Same two commands, plus the guard:
```
node node_modules/vitest/vitest.mjs run tests/endless/status-block.test.ts > /tmp/ctv-t2c.log 2>&1; echo exit $?
```
Expected: all PASS; the status block test is unchanged and passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endless/pane.ts packages/core/src/endless/service.ts packages/core/tests/endless/pane.test.ts packages/core/tests/routes/endless.test.ts
git commit -m "feat(core): the Chat pane lists recent threads with state, origin and question"
```

### Task 3: Web store reloads the pane live

**Files:**
- Modify: `packages/web/src/api/types.ts:448`, `packages/web/src/api/client.ts:82`
- Modify: `packages/web/src/stores/endless.ts`
- Create: `packages/web/src/components/endless/threadView.ts`
- Test: `packages/web/src/stores/endless.test.ts`, `packages/web/src/components/endless/threadView.test.ts` (new)

**Interfaces:**
- Consumes: `GET /api/endless/projects` → `{ projects, threads, truncated }` (Task 2), or an array from an older daemon.
- Produces:

```ts
// api/types.ts
export type EndlessPaneState = 'working' | 'needs_you' | 'queued' | 'error' | 'done' | 'idle';
export interface EndlessPaneThread { id: string; project: string; label: string; harness: string; state: EndlessPaneState; startedBy: 'chat' | 'overseer' | 'thread' | 'role' | 'user'; via: string | null; startedAt: string; lastActivityAt: string | null; question: string | null }
export interface EndlessProjectsResponse { projects: EndlessProject[]; threads: EndlessPaneThread[]; truncated: boolean }
// api.endlessProjects(): Promise<EndlessProjectsResponse | EndlessProject[]>
// useEndless state: threads: EndlessPaneThread[]; truncated: boolean; watch(): void; unwatch(): void
// threadView.ts
export function stateFromStatus(status: string | undefined, threadStatus: string | undefined, fallback: EndlessPaneState | null): EndlessPaneState | null;
export function useThreadView(id: string | null): { row: EndlessPaneThread | null; state: EndlessPaneState | null; activity: string | null };
export const RELOAD_DEBOUNCE_MS = 600; export const RELOAD_EVERY_MS = 60_000; // exported from stores/endless.ts
```

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/stores/endless.test.ts` (the file's `beforeEach` already mocks `api.endlessProjects`; extend its reset to `threads: [], truncated: false`):

```ts
describe('pane live reload', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { useEndless.getState().unwatch(); vi.useRealTimers(); });

  const row = (id: string, state: string) => ({ id, project: 's1', label: id, harness: 'claude-code', state, startedBy: 'chat', via: null, startedAt: '', lastActivityAt: null, question: null });

  it('accepts the new response and the old array', async () => {
    vi.mocked(api.endlessProjects).mockResolvedValueOnce({ projects: [], threads: [row('t1', 'working')], truncated: true } as any);
    await useEndless.getState().loadProjects();
    expect(useEndless.getState().threads.map((t) => t.id)).toEqual(['t1']);
    expect(useEndless.getState().truncated).toBe(true);
    vi.mocked(api.endlessProjects).mockResolvedValueOnce([] as any);
    await useEndless.getState().loadProjects();
    expect(useEndless.getState().threads).toEqual([]);
  });

  it('a thread event reloads once after the debounce while watched', async () => {
    const spy = vi.mocked(api.endlessProjects);
    useEndless.getState().watch();
    spy.mockClear();
    for (let k = 0; k < 5; k++) useEndless.getState().applyEvent({ type: 'terminal:created', terminal: { id: `t${k}` } });
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no one watches', async () => {
    const spy = vi.mocked(api.endlessProjects);
    spy.mockClear();
    useEndless.getState().applyEvent({ type: 'terminal:created', terminal: { id: 't1' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a status event reloads only when the coarse status changed or the thread is new', async () => {
    useEndless.setState({ threads: [row('t1', 'working')] as any });
    const spy = vi.mocked(api.endlessProjects);
    useEndless.getState().watch();
    spy.mockClear();
    useEndless.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'working', activity: 'Editing a.ts' });
    await vi.advanceTimersByTimeAsync(700);
    expect(spy).not.toHaveBeenCalled();
    useEndless.getState().applyEvent({ type: 'terminal:status', terminalId: 't1', status: 'needs_input' });
    await vi.advanceTimersByTimeAsync(700);
    expect(spy).toHaveBeenCalledTimes(1);
    useEndless.getState().applyEvent({ type: 'terminal:status', terminalId: 'other', status: 'working' });
    await vi.advanceTimersByTimeAsync(700);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reloads every 60 s while the page is visible', async () => {
    const spy = vi.mocked(api.endlessProjects);
    useEndless.getState().watch();
    spy.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reloads when the page becomes visible again', async () => {
    const spy = vi.mocked(api.endlessProjects);
    useEndless.getState().watch();
    spy.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```
(Import `afterEach` at the top of the file if it is missing.)

Create `packages/web/src/components/endless/threadView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stateFromStatus } from './threadView';

describe('stateFromStatus', () => {
  it('the live overlay wins over the pane row', () => {
    expect(stateFromStatus('needs_input', undefined, 'working')).toBe('needs_you');
    expect(stateFromStatus('working', 'working', 'done')).toBe('working');
    expect(stateFromStatus('error', undefined, null)).toBe('error');
    expect(stateFromStatus('waiting', 'done', 'working')).toBe('done');
    expect(stateFromStatus('waiting', 'idle', 'idle')).toBe('idle');
  });
  it('no overlay keeps the pane row', () => {
    expect(stateFromStatus(undefined, undefined, 'queued')).toBe('queued');
    expect(stateFromStatus(undefined, undefined, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and see them fail**

From `packages/web`:
```
node node_modules/vitest/vitest.mjs run src/stores/endless.test.ts > /tmp/ctv-t3a.log 2>&1; echo exit $?
node node_modules/vitest/vitest.mjs run src/components/endless/threadView.test.ts > /tmp/ctv-t3b.log 2>&1; echo exit $?
```
Expected: FAIL (`watch` is not a function; module not found).

- [ ] **Step 3: Implement**

`api/types.ts`: add the three types from the Interfaces block. `api/client.ts:82`:

```ts
  endlessProjects: () => req<EndlessProjectsResponse | EndlessProject[]>('/api/endless/projects'),
```

`stores/endless.ts`: add `threads: EndlessPaneThread[]`, `truncated: boolean`, `watch`, `unwatch` to `EndlessStoreState`; initial `threads: []`, `truncated: false`. Above `create(...)`:

```ts
export const RELOAD_DEBOUNCE_MS = 600;
export const RELOAD_EVERY_MS = 60_000;
const COARSE: Record<string, string> = { working: 'working', needs_you: 'needs_input', queued: 'queued', error: 'error', done: 'waiting', idle: 'waiting' };
const normalizePane = (v: EndlessProjectsResponse | EndlessProject[]): EndlessProjectsResponse =>
  Array.isArray(v) ? { projects: v, threads: [], truncated: false } : { projects: v.projects ?? [], threads: v.threads ?? [], truncated: !!v.truncated };
```

Inside the store factory, next to `gen`:

```ts
  let watchers = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let every: ReturnType<typeof setInterval> | null = null;
  let inflight = false;
  let again = false;
  const reload = async () => {
    if (inflight) { again = true; return; }
    inflight = true;
    try { await get().loadProjects(); } catch { /* the store keeps the old list */ }
    finally { inflight = false; if (again) { again = false; void reload(); } }
  };
  const schedule = () => {
    if (watchers === 0) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void reload(); }, RELOAD_DEBOUNCE_MS);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
```

Replace `loadProjects` and add `watch` / `unwatch`:

```ts
    loadProjects: () => load(() => api.endlessProjects(), (v) => { const p = normalizePane(v); set({ projects: p.projects, threads: p.threads, truncated: p.truncated }); }),
    watch: () => {
      watchers++;
      if (watchers > 1) return;
      every = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, RELOAD_EVERY_MS);
      document.addEventListener('visibilitychange', onVisible);
    },
    unwatch: () => {
      if (watchers === 0) return;
      watchers--;
      if (watchers > 0) return;
      if (every) clearInterval(every);
      if (debounce) clearTimeout(debounce);
      every = null; debounce = null;
      document.removeEventListener('visibilitychange', onVisible);
    },
```

In `resyncAfterReconnect`, before its early return, add `if (watchers > 0) void reload();`.

At the end of `applyEvent`, add:

```ts
      if (e.type === 'terminal:created' || e.type === 'terminal:exit' || e.type === 'terminal:removed') { schedule(); return; }
      if (e.type === 'terminal:status' && typeof e.terminalId === 'string') {
        const known = get().threads.find((t) => t.id === e.terminalId);
        if (!known || (typeof e.status === 'string' && COARSE[known.state] !== e.status)) schedule();
      }
```

Create `components/endless/threadView.ts`:

```ts
import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import type { EndlessPaneState, EndlessPaneThread } from '../../api/types';

/** The live overlay (terminal:status) is newer than the pane row, so it wins when present. */
export function stateFromStatus(status: string | undefined, threadStatus: string | undefined, fallback: EndlessPaneState | null): EndlessPaneState | null {
  switch (status) {
    case 'working': return 'working';
    case 'needs_input': return 'needs_you';
    case 'queued': return 'queued';
    case 'error': return 'error';
    case 'waiting': return fallback === 'idle' ? 'idle' : 'done'; // an owner thread stays idle; a worker is done
    default: return fallback;
  }
}

export function useThreadView(id: string | null): { row: EndlessPaneThread | null; state: EndlessPaneState | null; activity: string | null } {
  const row = useEndless((s) => (id ? s.threads.find((t) => t.id === id) ?? null : null));
  const live = useThreadStatus((s) => (id ? s.byTerminal[id] : undefined));
  return { row, state: stateFromStatus(live?.status, live?.threadStatus, row?.state ?? null), activity: live?.activity ?? null };
}
```

- [ ] **Step 4: Run the two test files again**, then `src/components/endless/ProjectsPanel.test.tsx` (it uses `endlessProjects`). Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/stores/endless.ts packages/web/src/stores/endless.test.ts packages/web/src/components/endless/threadView.ts packages/web/src/components/endless/threadView.test.ts
git commit -m "feat(web): the Chat pane reloads on thread events, a 60 s timer and page resume"
```

### Task 4: Tool runs pair in order, and the Started card

**Files:**
- Create: `packages/web/src/components/endless/StateMark.tsx`, `packages/web/src/components/endless/StartedItem.tsx`
- Modify: `packages/web/src/components/endless/EndlessMessageRow.tsx:11-39` (`foldRows`) and `:192-208` (`EndlessRows`)
- Test: `packages/web/src/components/endless/EndlessMessageRow.test.tsx` (new)

**Interfaces:**
- Consumes: `useThreadView` (Task 3); the `spawn_agent` echo with `projectId` (Task 1); `openThreadInPlace` (Task 5; this task imports it from `./openThread`, so create that file here with the Task 5 body if you build Task 4 first).
- Produces: `Row` gains `{ kind: 'started'; tool: EndlessMessage; echo?: EndlessMessage }`. `parseSpawn(tool, echo)`:

```ts
export type Spawn =
  | { kind: 'starting'; name: string; projectName: string | null; task: string }
  | { kind: 'started'; agentId: string; label: string; projectName: string | null; projectId: string | null; task: string }
  | { kind: 'failed'; name: string; error: string; task: string };
export function parseSpawn(tool: EndlessMessage, echo?: EndlessMessage): Spawn;
export function StateMark(props: { state: EndlessPaneState; size?: number }): JSX.Element;
```

- [ ] **Step 0: Check the result order (spec 3.4 assumption)**

On a scratch isolated daemon (the `/verify` skill: fake HOME, port 3999), ask Chat to start two threads in one message. Read `endless_messages` in that daemon's DB (`SELECT i, kind, substr(text,1,80) FROM endless_messages ORDER BY i DESC LIMIT 8`). Expected: tool, tool, echo, echo, with the echoes in call order. Write the result in the task report. If the order differs, stop and report; the run pairing below assumes call order.

- [ ] **Step 1: Write the failing tests** `EndlessMessageRow.test.tsx`

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { foldRows, parseSpawn } from './EndlessMessageRow';
import { StartedItem } from './StartedItem';
import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import * as open from './openThread';
import type { EndlessMessage } from '../../api/types';

const m = (i: number, kind: EndlessMessage['kind'], text: string): EndlessMessage => ({ i, kind, text, size: text.length, project: null, projectName: null, ref: null, media: [], createdAt: 0 });
const spawnTool = (i: number, name: string) => m(i, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', agentType: 'implementer', name, task: 'Fix it' })}`);
const spawnEcho = (i: number, id: string, label: string) => m(i, 'echo', JSON.stringify({ agentId: id, label, project: 'studio', projectId: 's1', folder: '/w/studio' }));

beforeEach(() => {
  useEndless.setState({ threads: [], projects: [] });
  useThreadStatus.setState({ byTerminal: {} });
});

describe('foldRows', () => {
  it('pairs a run of tools with the run of results after it, in order', () => {
    const rows = foldRows([m(0, 'tool', 'Read {}'), m(1, 'tool', 'Grep {}'), m(2, 'echo', 'A'), m(3, 'echo', 'B')]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.kind === 'msg' ? r.m.i : [r.tool.i, r.echo?.i]))).toEqual([[0, 2], [1, 3]]);
  });
  it('a tool with no result yet stays alone; the run of 1 is unchanged', () => {
    expect(foldRows([m(0, 'tool', 'Read {}')]).map((r) => r.kind)).toEqual(['tool']);
    const one = foldRows([m(0, 'tool', 'Read {}'), m(1, 'echo', 'A'), m(2, 'unii', 'hi')]);
    expect(one.map((r) => r.kind)).toEqual(['tool', 'msg']);
  });
  it('a spawn_agent call folds into a started row', () => {
    expect(foldRows([spawnTool(0, 'Fix PR #2'), spawnEcho(1, 't9', 'Fix PR #2')])[0].kind).toBe('started');
  });
});

describe('parseSpawn', () => {
  it('starting, started, failed', () => {
    expect(parseSpawn(spawnTool(0, 'Fix'))).toMatchObject({ kind: 'starting', name: 'Fix', projectName: 'studio' });
    expect(parseSpawn(spawnTool(0, 'Fix'), spawnEcho(1, 't9', 'Fix'))).toMatchObject({ kind: 'started', agentId: 't9', label: 'Fix', projectId: 's1' });
    expect(parseSpawn(spawnTool(0, 'Fix'), m(1, 'echo', 'unknown project: catalog'))).toMatchObject({ kind: 'failed', error: 'unknown project: catalog' });
  });
});

describe('StartedItem', () => {
  it('shows Started with the label and opens the thread in place', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    render(<StartedItem tool={spawnTool(0, 'Fix PR #2')} echo={spawnEcho(1, 't9', 'Fix PR #2')} />);
    expect(screen.getByText('Started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Fix PR #2/ }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
  });
  it('Starting is not a button; Could not start shows the error', () => {
    const { rerender } = render(<StartedItem tool={spawnTool(0, 'Fix')} />);
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<StartedItem tool={spawnTool(0, 'Fix')} echo={m(1, 'echo', 'unknown project: catalog')} />);
    expect(screen.getByText('Could not start')).toBeInTheDocument();
    expect(screen.getByText(/unknown project: catalog/)).toBeInTheDocument();
  });
  it('the chip follows a terminal:status event with no reload', () => {
    useEndless.setState({ threads: [{ id: 't9', project: 's1', label: 'Fix', harness: 'claude-code', state: 'working', startedBy: 'chat', via: null, startedAt: '', lastActivityAt: null, question: null }] });
    render(<StartedItem tool={spawnTool(0, 'Fix')} echo={spawnEcho(1, 't9', 'Fix')} />);
    expect(screen.getByText('working')).toBeInTheDocument();
    useThreadStatus.getState().applyEvent({ type: 'terminal:status', terminalId: 't9', status: 'needs_input' });
    expect(screen.getByText('needs you')).toBeInTheDocument();
  });
});
```
(Wrap renders in `act` only if the test runner warns; `applyEvent` is synchronous.)

- [ ] **Step 2: Run and see it fail**

From `packages/web`: `node node_modules/vitest/vitest.mjs run src/components/endless/EndlessMessageRow.test.tsx > /tmp/ctv-t4.log 2>&1; echo exit $?`. Expected: FAIL (no `parseSpawn`, no `StartedItem`; the parallel pairing case fails on today's `foldRows`).

- [ ] **Step 3: Implement**

`StateMark.tsx`: one inline SVG per state, sized `size` (default 10). Shapes from spec section 15 and `PaneStates.dc.html`: working = filled circle in `var(--color-accent)` with a 2 px halo ring at 35 % opacity; needs_you = diamond (rotated square) in `var(--color-status-yellow)`; queued = hollow circle, 1.5 px stroke `var(--color-text-tertiary)`; error = filled square `var(--color-status-red)`; done and idle = check mark `var(--color-text-tertiary)`. Each SVG has `role="img"` and `aria-label` = the state word ("working", "needs you", "queued", "error", "done", "idle").

```tsx
import type { EndlessPaneState } from '../../api/types';
export const STATE_WORD: Record<EndlessPaneState, string> = { working: 'working', needs_you: 'needs you', queued: 'queued', error: 'error', done: 'done', idle: 'idle' };
export function StateMark({ state, size = 10 }: { state: EndlessPaneState; size?: number }) {
  const s = size; const c = s / 2;
  const body = (() => {
    switch (state) {
      case 'working': return <><circle cx={c} cy={c} r={c - 0.5} fill="none" stroke="var(--color-accent)" strokeOpacity={0.35} strokeWidth={1} /><circle cx={c} cy={c} r={c * 0.5} fill="var(--color-accent)" /></>;
      case 'needs_you': return <rect x={c * 0.35} y={c * 0.35} width={c * 1.3} height={c * 1.3} transform={`rotate(45 ${c} ${c})`} fill="var(--color-status-yellow)" />;
      case 'queued': return <circle cx={c} cy={c} r={c * 0.6} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1.5} />;
      case 'error': return <rect x={c * 0.4} y={c * 0.4} width={c * 1.2} height={c * 1.2} fill="var(--color-status-red)" />;
      default: return <path d={`M${s * 0.15} ${s * 0.55} L${s * 0.42} ${s * 0.8} L${s * 0.88} ${s * 0.25}`} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />;
    }
  })();
  return <svg role="img" aria-label={STATE_WORD[state]} width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ flexShrink: 0 }}>{body}</svg>;
}
```

`EndlessMessageRow.tsx`, replace `Row` and `foldRows`:

```ts
export type Row =
  | { kind: 'msg'; m: EndlessMessage }
  | { kind: 'tool'; tool: EndlessMessage; echo?: EndlessMessage }
  | { kind: 'recall'; tool: EndlessMessage; echo?: EndlessMessage }
  | { kind: 'started'; tool: EndlessMessage; echo?: EndlessMessage };

const ZOOM_TOOL = /^mcp__memory__zoom\s/;
export const SPAWN_TOOL = /^mcp__memory__spawn_agent\s/;

/**
 * A run of N tool calls pairs with the run of up to N results right after it, in order (Claude Code
 * returns parallel results in call order). A `zoom` call is a "recalled" row; a `spawn_agent` call is
 * a Started card.
 */
export function foldRows(messages: EndlessMessage[]): Row[] {
  const rows: Row[] = [];
  let k = 0;
  while (k < messages.length) {
    const m = messages[k];
    if (m.kind !== 'tool') { rows.push({ kind: 'msg', m }); k++; continue; }
    const tools: EndlessMessage[] = [];
    while (k < messages.length && messages[k].kind === 'tool' && (tools.length === 0 || messages[k].i === tools[tools.length - 1].i + 1)) tools.push(messages[k++]);
    const echoes: EndlessMessage[] = [];
    while (k < messages.length && echoes.length < tools.length && messages[k].kind === 'echo' && messages[k].i === (echoes.length ? echoes[echoes.length - 1].i : tools[tools.length - 1].i) + 1) echoes.push(messages[k++]);
    tools.forEach((tool, n) => {
      const kind = ZOOM_TOOL.test(tool.text) ? 'recall' : SPAWN_TOOL.test(tool.text) ? 'started' : 'tool';
      rows.push({ kind, tool, echo: echoes[n] });
    });
  }
  return rows;
}
```

`rowKeyOf` stays as it is (it walks `foldRows`). In `EndlessRows`, render `r.kind === 'started'` as `<StartedItem tool={r.tool} echo={r.echo} />`.

Add `parseSpawn` to `EndlessMessageRow.tsx` (exported):

```ts
const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
export function parseSpawn(tool: EndlessMessage, echo?: EndlessMessage): Spawn {
  let input: { name?: unknown; project?: unknown; task?: unknown; agentType?: unknown } = {};
  try { input = JSON.parse(tool.text.replace(SPAWN_TOOL, '')); } catch { /* keep {} */ }
  const name = (typeof input.name === 'string' && input.name.trim()) || `${typeof input.agentType === 'string' ? input.agentType : 'thread'} agent`;
  const projectName = typeof input.project === 'string' ? input.project : null;
  const task = typeof input.task === 'string' ? input.task : '';
  if (!echo) return { kind: 'starting', name, projectName, task };
  try {
    const r = JSON.parse(echo.text) as { agentId?: unknown; label?: unknown; project?: unknown; projectId?: unknown };
    if (typeof r.agentId === 'string' && r.agentId) {
      return { kind: 'started', agentId: r.agentId, label: typeof r.label === 'string' ? r.label : name, projectName: typeof r.project === 'string' ? r.project : projectName, projectId: typeof r.projectId === 'string' ? r.projectId : null, task };
    }
  } catch { /* not JSON: the spawn failed */ }
  return { kind: 'failed', name, error: firstLine(echo.text), task };
}
```

`StartedItem.tsx`:

```tsx
import { Play } from '@phosphor-icons/react';
import { parseSpawn } from './EndlessMessageRow';
import { useThreadView } from './threadView';
import { StateMark, STATE_WORD } from './StateMark';
import { openThreadInPlace } from './openThread';
import { useEndless } from '../../stores/endless';
import { harnessShort } from './harness';
import type { EndlessMessage } from '../../api/types';

/** The Started card (spec 3.4, board ChatStates): one line; a second line only for doc chips (Task 10). */
export function StartedItem({ tool, echo }: { tool: EndlessMessage; echo?: EndlessMessage }) {
  const s = parseSpawn(tool, echo);
  const view = useThreadView(s.kind === 'started' ? s.agentId : null);
  const projects = useEndless((st) => st.projects);
  const line: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 32, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-pane)', font: '400 12.5px var(--font-sans)', color: 'var(--color-text-secondary)', textAlign: 'left', width: '100%' };
  if (s.kind === 'starting') return <div style={{ ...line, opacity: 0.6 }}><Play size={13} /><span>Starting</span><span style={{ color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span></div>;
  if (s.kind === 'failed') return <div style={{ ...line, borderColor: 'var(--color-status-red)' }}><span style={{ color: 'var(--color-status-red)' }}>Could not start</span><span style={{ color: 'var(--color-text-primary)' }}>{s.name}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.error}</span></div>;
  const projectId = s.projectId ?? projects.find((p) => p.name === s.projectName)?.id ?? null;
  const harness = view.row ? harnessShort(view.row.harness) : null;
  return (
    <button type="button" disabled={!projectId} onClick={() => projectId && void openThreadInPlace(projectId, s.agentId)} style={{ ...line, cursor: projectId ? 'pointer' : 'default' }}>
      <Play size={13} />
      <span>Started</span>
      <span style={{ color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.label}</span>
      <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{[s.projectName, harness].filter(Boolean).join(' · ')}</span>
      <span style={{ flex: 1 }} />
      {view.state && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '400 11px var(--font-mono)' }}><StateMark state={view.state} />{STATE_WORD[view.state]}</span>}
    </button>
  );
}
```

Create `components/endless/harness.ts`:

```ts
import { HARNESSES } from '../../lib/harnesses';
/** "Claude", "Codex", "OpenCode": the catalog label without " Code" / " CLI". */
export function harnessShort(type: string): string {
  const label = HARNESSES.find((h) => h.type === type)?.label ?? type;
  return label.replace(/\s+(Code|CLI)$/i, '');
}
```

- [ ] **Step 4: Run the test file again**, then `src/components/endless/EndlessColumn.test.tsx` (it renders rows). Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/endless/StateMark.tsx packages/web/src/components/endless/StartedItem.tsx packages/web/src/components/endless/harness.ts packages/web/src/components/endless/EndlessMessageRow.tsx packages/web/src/components/endless/EndlessMessageRow.test.tsx
git commit -m "feat(web): Started card from the spawn_agent rows; parallel tool results pair in order"
```

### Task 5: Open threads in place

**Files:**
- Create: `packages/web/src/components/endless/openThread.ts`
- Modify: `packages/web/src/components/endless/ChatMode.tsx`
- Modify: `packages/web/src/components/endless/EndlessMessageRow.tsx:89-93` (`openThread`)
- Modify: `packages/web/src/components/overseer/components/WorkerLightbox.tsx`
- Test: `packages/web/src/components/endless/openThread.test.ts` (new), `packages/web/src/components/endless/ChatMode.test.tsx` (new), `packages/web/src/components/overseer/components/WorkerLightbox.test.tsx` (new), `EndlessMessageRow.test.tsx`

**Interfaces:**
- Produces: `openThreadInPlace(projectId: string, terminalId: string): Promise<void>`; `WorkerLightbox({ onOpenFull?: (terminalId: string) => void })`.

- [ ] **Step 1: Write the failing tests**

`openThread.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openThreadInPlace } from './openThread';
import { useTabs } from '../../stores/tabs';
import { useOverseer } from '../overseer/store';

beforeEach(() => { useTabs.setState({ byProject: {} }); useOverseer.setState({ workerLightboxId: null }); });

describe('openThreadInPlace', () => {
  it('loads the project tabs first when they are not loaded, then opens the lightbox', async () => {
    const order: string[] = [];
    vi.spyOn(useTabs.getState(), 'loadTabs').mockImplementation(async () => { order.push('load'); });
    const drill = vi.spyOn(useOverseer.getState(), 'drillInto').mockImplementation(() => { order.push('drill'); });
    await openThreadInPlace('s1', 't9');
    expect(order).toEqual(['load', 'drill']);
    expect(drill).toHaveBeenCalledWith('t9');
  });
  it('does not reload loaded tabs', async () => {
    useTabs.setState({ byProject: { s1: [] } });
    const load = vi.spyOn(useTabs.getState(), 'loadTabs');
    await openThreadInPlace('s1', 't9');
    expect(load).not.toHaveBeenCalled();
    expect(useOverseer.getState().workerLightboxId).toBe('t9');
  });
});
```

(If spying on store methods does not take, because the store reads the function at call time, use `useTabs.setState({ loadTabs: vi.fn(...) } as any)` instead.)

`ChatMode.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChatMode } from './ChatMode';
import { useOverseer } from '../overseer/store';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

describe('ChatMode', () => {
  it('watches the pane, mounts the lightbox in .overseer-root, and closes it on unmount', () => {
    vi.spyOn(api, 'endlessProjects').mockResolvedValue({ projects: [], threads: [], truncated: false } as any);
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false } as any);
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null } } as any);
    const watch = vi.spyOn(useEndless.getState(), 'watch');
    const { container, unmount } = render(<ChatMode />);
    expect(watch).toHaveBeenCalled();
    expect(container.querySelector('.overseer-root')).not.toBeNull();
    useOverseer.setState({ workerLightboxId: 't9' });
    unmount();
    expect(useOverseer.getState().workerLightboxId).toBeNull();
  });
});
```

(Use the API method names that `stores/endless.ts` calls for `loadTail` and `refreshState`; read them there.)

`WorkerLightbox.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkerLightbox } from './WorkerLightbox';
import { useOverseer } from '../store';

vi.mock('../../tabs/chat/ChatView', () => ({ ChatView: () => <div>chat</div> }));
vi.mock('./AgentDetailHeader', () => ({ AgentDetailHeader: () => <div>header</div> }));

describe('WorkerLightbox onOpenFull', () => {
  it('shows "Open in Threads" only when onOpenFull is passed', () => {
    useOverseer.setState({ workerLightboxId: 't9' });
    const { rerender } = render(<WorkerLightbox />);
    expect(screen.queryByRole('button', { name: 'Open in Threads' })).not.toBeInTheDocument();
    const onOpenFull = vi.fn();
    rerender(<WorkerLightbox onOpenFull={onOpenFull} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Threads' }));
    expect(onOpenFull).toHaveBeenCalledWith('t9');
  });
});
```

Add to `EndlessMessageRow.test.tsx`:

```tsx
import { EndlessRows } from './EndlessMessageRow';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { useUI } from '../../stores/ui';

describe('report card', () => {
  it('opens the thread in place and stays in Chat', () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const setView = vi.spyOn(useUI.getState(), 'setView');
    const work = { ...m(0, 'work', '[Fix] report: done'), project: 's1', ref: 't9' };
    render(<MessageScroller><EndlessRows messages={[work]} focus={null} /></MessageScroller>);
    fireEvent.click(screen.getByRole('button', { name: /\[Fix\] report: done/ }));
    expect(spy).toHaveBeenCalledWith('s1', 't9');
    expect(setView).not.toHaveBeenCalled();
  });
});
```
(Check how `EndlessColumn.test.tsx` wraps rows in the message scroller and copy that wrapper.)

- [ ] **Step 2: Run the four test files and see them fail.**

- [ ] **Step 3: Implement**

`openThread.ts`:

```ts
import { useTabs } from '../../stores/tabs';
import { useOverseer } from '../overseer/store';

/** Open a thread in the Overseer lightbox over Chat (spec 3.6). The lightbox picks ChatView or the terminal from the loaded tabs. */
export async function openThreadInPlace(projectId: string, terminalId: string): Promise<void> {
  if (!useTabs.getState().byProject[projectId]) {
    try { await useTabs.getState().loadTabs(projectId); } catch { /* open anyway: a structured thread still renders */ }
  }
  useOverseer.getState().drillInto(terminalId);
}
```

`EndlessMessageRow.tsx:89-93`:

```ts
function openThread(m: EndlessMessage) {
  if (!m.project || !m.ref) return;
  void openThreadInPlace(m.project, m.ref);
}
```
and remove the now unused `useUI` import if nothing else uses it.

`WorkerLightbox.tsx`: change the signature to `export function WorkerLightbox({ onOpenFull }: { onOpenFull?: (terminalId: string) => void } = {})`, and put this first inside `actions` (spec 15 item 7: a ghost button left of Interrupt, Stop, Archive; match `ThreadViewer.dc.html`):

```tsx
      {onOpenFull && (
        <button type="button" onClick={() => onOpenFull(workerLightboxId)}
          style={{ height: 26, padding: '0 9px', borderRadius: 7, background: 'transparent', border: '1px solid var(--border)', color: 'var(--ts)', font: '500 11.5px var(--font-sans)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Open in Threads
        </button>
      )}
```

`ChatMode.tsx`: import `WorkerLightbox`, `useOverseer`, `useTabs`, `findTerminal`, `useUI`, and `'../overseer/tokens.css'`. In the mount effect, call `s.watch()` and return a cleanup:

```ts
    s.watch();
    return () => { useEndless.getState().unwatch(); useOverseer.getState().closeWorkerLightbox(); };
```
Before the closing `</div>` of the page:

```tsx
      <div className="overseer-root">
        <WorkerLightbox onOpenFull={(id) => {
          const t = findTerminal(useTabs.getState().byProject, id);
          useOverseer.getState().closeWorkerLightbox();
          if (!t) return;
          useUI.getState().requestOpenThread({ sessionId: t.sessionId, terminalId: id });
          useUI.getState().setView('workspace'); // the "Threads" view; `workspace` is its code name
        }} />
      </div>
```

- [ ] **Step 4: Run the four test files again.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/endless/openThread.ts packages/web/src/components/endless/openThread.test.ts packages/web/src/components/endless/ChatMode.tsx packages/web/src/components/endless/ChatMode.test.tsx packages/web/src/components/endless/EndlessMessageRow.tsx packages/web/src/components/endless/EndlessMessageRow.test.tsx packages/web/src/components/overseer/components/WorkerLightbox.tsx packages/web/src/components/overseer/components/WorkerLightbox.test.tsx
git commit -m "feat(web): threads open in the Overseer lightbox over Chat, with Open in Threads"
```

### Task 6: The pane

**Files:**
- Modify: `packages/web/src/components/endless/ProjectsPanel.tsx` (rewrite the body; keep the refresh button and its tests)
- Modify: `packages/web/src/components/endless/ChatMode.tsx` (badge; sheet close)
- Test: `packages/web/src/components/endless/ProjectsPanel.test.tsx`

**Interfaces:**
- Consumes: `useEndless` `projects`, `threads`, `truncated`; `useThreadView`; `StateMark`; `harnessShort`; `openThreadInPlace`.
- Produces: `ProjectsPanel({ onNavigate?: () => void })` (called before a row opens the lightbox; the mobile sheet passes its close). `PANE_ROWS = 6`. Exported pure helpers `orderProjects(projects, threads)` and `formatStart(iso, now)`.

Visual reference: `Main.dc.html`, `PaneStates.dc.html`, `ReportOpen.dc.html` (Done today open), `PhoneProjects.dc.html`.

- [ ] **Step 1: Write the failing tests** (append to `ProjectsPanel.test.tsx`; keep the existing cases, and set `threads: []` in its `beforeEach`)

```tsx
import * as open from './openThread';
import { orderProjects, formatStart } from './ProjectsPanel';

const row = (id: string, project: string, state: string, o: Partial<Record<string, unknown>> = {}) => ({ id, project, label: `Thread ${id}`, harness: 'claude-code', state, startedBy: 'chat', via: null, startedAt: '2026-10-19T10:42:00.000Z', lastActivityAt: '2026-10-19T11:00:00.000Z', question: null, ...o });
const P = (id: string, name: string, over: Partial<Record<string, number>> = {}) => ({ id, name, folder: `/w/${name}`, live: 0, needsYou: 0, openItems: 0, lastReport: null, messages: 0, ...over });

describe('ProjectsPanel thread list', () => {
  it('shows a Needs you section first, with the question', () => {
    useEndless.setState({ projects: [P('s1', 'rollup', { needsYou: 1 })], threads: [row('n', 's1', 'needs_you', { question: 'Use the warehouse view?' })] as any });
    render(<ProjectsPanel />);
    const needs = screen.getByTestId('needs-you');
    expect(needs).toHaveTextContent('Thread n');
    expect(needs).toHaveTextContent('Use the warehouse view?');
  });
  it('rows show name, who started it, harness and the start time', () => {
    useEndless.setState({ projects: [P('s1', 'studio', { live: 1 })], threads: [row('w', 's1', 'working', { startedBy: 'thread', via: 'Fix PR #2', harness: 'codex' })] as any });
    render(<ProjectsPanel />);
    const r = screen.getByTestId('thread-w');
    expect(r).toHaveTextContent('Thread w');
    expect(r).toHaveTextContent('via Fix PR #2');
    expect(r).toHaveTextContent('Codex');
  });
  it('folds finished threads under Done today', () => {
    useEndless.setState({ projects: [P('s1', 'studio')], threads: [row('d1', 's1', 'done'), row('d2', 's1', 'done')] as any });
    render(<ProjectsPanel />);
    expect(screen.queryByTestId('thread-d1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done today (2)' }));
    expect(screen.getByTestId('thread-d1')).toBeInTheDocument();
  });
  it('shows 6 rows, then +N more in place', () => {
    useEndless.setState({ projects: [P('s1', 'studio', { live: 8 })], threads: Array.from({ length: 8 }, (_, k) => row(`w${k}`, 's1', 'working')) as any });
    render(<ProjectsPanel />);
    expect(screen.getAllByTestId(/^thread-w/)).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(screen.getAllByTestId(/^thread-w/)).toHaveLength(8);
  });
  it('a row tap closes the sheet first, then opens the thread in place', async () => {
    const spy = vi.spyOn(open, 'openThreadInPlace').mockResolvedValue();
    const onNavigate = vi.fn();
    useEndless.setState({ projects: [P('s1', 'studio', { live: 1 })], threads: [row('w', 's1', 'working')] as any });
    render(<ProjectsPanel onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('thread-w'));
    expect(onNavigate).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('s1', 'w');
  });
  it('orders projects: waiting, then live, then the rest', () => {
    const ps = [P('a', 'a'), P('b', 'b', { live: 1 }), P('c', 'c', { needsYou: 1 })];
    expect(orderProjects(ps as any, []).map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });
  it('the cut note', () => {
    useEndless.setState({ projects: [P('s1', 'studio', { live: 1 })], threads: [row('w', 's1', 'working')] as any, truncated: true });
    render(<ProjectsPanel />);
    expect(screen.getByText('Some projects are not shown')).toBeInTheDocument();
  });
  it('formats the start time', () => {
    const now = Date.parse('2026-10-19T15:00:00');
    expect(formatStart('2026-10-19T14:02:00', now)).toBe('14:02');
    expect(formatStart('2026-10-17T14:02:00', now)).toMatch(/^Sat 14:02$/);
    expect(formatStart('2026-09-01T14:02:00', now)).toBe('1 Sep');
  });
});
```

Add a ChatMode badge case to `ChatMode.test.tsx`:

```tsx
  it('the Projects button shows the need-you count', () => {
    useEndless.setState({ projects: [{ id: 's1', name: 'rollup', folder: '/w', live: 0, needsYou: 2, openItems: 0, lastReport: null, messages: 0 }] });
    render(<ChatMode />);
    expect(screen.getByRole('button', { name: /Projects/ })).toHaveTextContent('2');
  });
```
(`ChatMode` reloads projects on mount; let the mocked `endlessProjects` return the same project list so the badge stays.)

- [ ] **Step 2: Run both files and see the new cases fail.**

- [ ] **Step 3: Implement**

`ProjectsPanel.tsx` structure (build to the boards; keep the existing header with the refresh button):

```tsx
export const PANE_ROWS = 6;
const RANK = { needs_you: 0, working: 1, queued: 2, error: 3, done: 4, idle: 4 } as const;
const ORIGIN: Record<string, string> = { chat: 'Chat', overseer: 'Overseer', user: 'You', role: 'Role', thread: '' };

export function orderProjects(projects: EndlessProject[], threads: EndlessPaneThread[]): EndlessProject[] {
  const newest = (id: string) => Math.max(0, ...threads.filter((t) => t.project === id).map((t) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) : 0)));
  const group = (p: EndlessProject) => (p.needsYou > 0 ? 0 : p.live > 0 ? 1 : 2);
  return [...projects].sort((a, b) => group(a) - group(b) || newest(b.id) - newest(a.id));
}

export function formatStart(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return hm;
  if (days > 0 && days < 7) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function originText(t: EndlessPaneThread): string {
  if (t.startedBy === 'thread') return t.via ? `via ${t.via}` : 'via a thread';
  if (t.startedBy === 'chat' && t.via) return `Chat, via ${t.via}`;
  return ORIGIN[t.startedBy];
}

function ThreadRow({ t, onOpen, project }: { t: EndlessPaneThread; onOpen: (t: EndlessPaneThread) => void; project?: string }) {
  const view = useThreadView(t.id);
  const state = view.state ?? t.state;
  const step = state === 'working' ? view.activity || 'working' : state === 'needs_you' ? '' : state === 'queued' ? 'queued' : state === 'error' ? 'stopped with an error' : t.lastActivityAt ? `finished ${formatStart(t.lastActivityAt)}` : 'finished';
  // line 1: StateMark, name (ellipsis), start time. line 2 (mono 11.5px, tertiary): [project ·] origin · harness · step.
  // needs_you rows add the question (3 lines max) and the yellow left border (board PaneStates).
  ...
}
```

Write the JSX of `ThreadRow`, the Needs you section (`data-testid="needs-you"`, rows for every `needs_you` thread across projects, with the project name on line 2), and each project block (`data-testid="project-<id>"`: name, the existing counts line, the active rows (state rank 0 to 3) with the first `PANE_ROWS` shown and a `+N more` button that shows the rest in place, then a `Done today (N)` toggle button for `done` and `idle` rows). Each row is a `<button type="button" data-testid={`thread-${t.id}`}>` with `minHeight: 44` on mobile and full width. The row click calls `onNavigate?.()` and then `void openThreadInPlace(t.project, t.id)`. Keep the open state of each project's "Done today" and "+N more" in component state keyed by project id. Use `orderProjects` for the block order. Keep the "which projects show" rule of the current code: `live + needsYou + openItems > 0 || messages > 0 || lastReport || any visible thread`. Show `Some projects are not shown` at the bottom when `truncated`. Keep the empty and unavailable notes. Use only `var(--color-*)` tokens.

`ChatMode.tsx`: compute `const needs = useEndless((s) => s.projects.reduce((n, p) => n + p.needsYou, 0));`. In the Projects toolbar button, after the label, render `{needs > 0 && <span aria-label={`${needs} need you`} style={{ minWidth: 16, height: 16, padding: '0 5px', borderRadius: 8, background: 'var(--color-status-yellow)', color: '#141416', font: '600 10.5px var(--font-mono)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{needs}</span>}` (board `ChatStates.dc.html`, S2). In the mobile sheet, pass `<ProjectsPanel onNavigate={() => setPanel(false)} />`.

- [ ] **Step 4: Run `ProjectsPanel.test.tsx` and `ChatMode.test.tsx` again.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/endless/ProjectsPanel.tsx packages/web/src/components/endless/ProjectsPanel.test.tsx packages/web/src/components/endless/ChatMode.tsx packages/web/src/components/endless/ChatMode.test.tsx
git commit -m "feat(web): the Chat pane lists recent threads, waiting first, with Done today folded"
```

### Task 7: Verify group 1

- [ ] **Step 1:** From `packages/core`: `node node_modules/vitest/vitest.mjs run > /tmp/ctv-core-1.log 2>&1; echo exit $?`. Read the log. Expected: PASS. Record the file and test counts.
- [ ] **Step 2:** After that run ends, from `packages/web`: `node node_modules/vitest/vitest.mjs run > /tmp/ctv-web-1.log 2>&1; echo exit $?`. Expected: PASS. Record the counts.
- [ ] **Step 3:** Types and build: `pnpm -C packages/core exec tsc --noEmit > /tmp/ctv-tsc-core.log 2>&1; echo exit $?` and `pnpm -C packages/web run build > /tmp/ctv-build-web.log 2>&1; echo exit $?`. Expected: exit 0 for both.
- [ ] **Step 4:** Use the `/verify` skill (isolated daemon on a fake HOME, port 3999). Start a Chat turn that spawns two threads. Check that the Started cards show before the turn ends, the pane lists both threads within about 1 s, a thread that asks a question moves to Needs you with its question, and the lightbox opens from a pane row, a Started card and a report card. Then check a 393 px wide window in headless Chrome: the badge, the Projects sheet closing before the lightbox opens, and the lightbox as a sheet.
- [ ] **Step 5:** Fix what fails in the task that owns it, with a new commit there.

---

## Group 2: doc links (spec item 7, section 12)

### Task 8: Core doc resolver and the doc route

**Files:**
- Modify: `packages/core/src/overseer/source-file.ts` (export `leadsOut`, `projectRelative`, `locate`; the worktree list)
- Create: `packages/core/src/docs/git.ts`, `packages/core/src/docs/resolve.ts`, `packages/core/src/docs/service.ts`
- Modify: `packages/core/src/endless/service.ts` (own a `DocsService`), `packages/core/src/routes/endless.ts` (`GET /doc`)
- Test: `packages/core/tests/docs/resolve.test.ts` (new), `packages/core/tests/docs/git-fixture.ts` (new helper), `packages/core/tests/overseer/source-file.test.ts`, `packages/core/tests/routes/endless.test.ts`

**Interfaces:**

```ts
// docs/git.ts
export const GIT_TIMEOUT_MS = 5000;
export function git(dir: string, args: string[]): string | null;            // stdout, or null on any error
export function gitBuffer(dir: string, args: string[]): Buffer | null;
export function isRepo(dir: string): boolean;
export function worktrees(dir: string): { path: string; branch: string | null }[];  // git worktree list --porcelain; branch without refs/heads/
export function refs(dir: string): { name: string; date: number }[];       // refs/heads + refs/remotes, no */HEAD; date = committer unix seconds
export function defaultBranch(dir: string): string | null;                  // origin/HEAD target, else main, else master
export function blobHash(dir: string, ref: string, rel: string): string | null;
export function blobSize(dir: string, ref: string, rel: string): number | null;
export function readBlob(dir: string, ref: string, rel: string): Buffer | null;
export function hashBytes(buf: Buffer): string;                             // git blob sha1
export function commitDate(dir: string, ref: string, rel: string): string | null; // ISO
// overseer/source-file.ts (new exports)
export function leadsOut(rel: string): boolean;
export function projectRelative(projectDir: string, realRoot: string, ref: string): string | null;
export function locate(realRoot: string, rel: string): string | 'missing' | 'outside';
export function projectWorktrees(realRoot: string): { name: string; real: string; rel: string; branch: string | null }[];
// docs/resolve.ts
export const DOC_MAX_BYTES = 2 * 1024 * 1024;
export const DOC_EXT = /\.(md|markdown|txt)$/i;
export interface DocCopy { project: string; path: string; absPath: string | null; source: 'main' | 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'same' | 'changed' | 'not_on_main' | 'unknown'; modifiedAt: string; status: string | null; note: string | null; markdown: string }
export type DocResult = { kind: 'doc'; doc: DocCopy } | { kind: 'not_found'; looked: string[] } | { kind: 'refused'; reason: string } | { kind: 'too_large'; path: string; size: number };
export function resolveDoc(project: { id: string; folder: string }, ref: string, opts?: { branch?: string | null }): DocResult;
export function statusLine(text: string): string | null;
// docs/service.ts
export class DocsService { constructor(db: Database.Database); doc(projectId: string, path: string, branch: string | null): DocResult }
// route: GET /api/endless/doc?project=ID&path=P&branch=B -> 200 DocCopy | 404 { looked } | 403 { reason } | 413 { path, size } | 400 unknown project
```

`vsMain: 'unknown'` is a decision of this plan: a project folder that is not a git repository has no main to compare with, so the viewer shows no "vs main" chip.

- [ ] **Step 1: Write the git fixture helper** `packages/core/tests/docs/git-fixture.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** A throwaway repo under a fresh temp folder. `rm()` removes only that folder. */
export function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-')));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g(dir, 'init', '-q', '-b', 'main');
  const write = (rel: string, text: string, cwd = dir) => { const f = path.join(cwd, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const commit = (msg: string, cwd = dir) => { g(cwd, 'add', '-A'); g(cwd, 'commit', '-q', '-m', msg); };
  return { root, dir, g, write, commit, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
```

- [ ] **Step 2: Write the failing tests** `packages/core/tests/docs/resolve.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDoc, statusLine, DOC_MAX_BYTES } from '../../src/docs/resolve.js';
import { makeRepo } from './git-fixture.js';

const SPEC = 'docs/superpowers/specs/a-design.md';
let r: ReturnType<typeof makeRepo>;
afterEach(() => r?.rm());
const project = () => ({ id: 's1', folder: r.dir });
const doc = (res: ReturnType<typeof resolveDoc>) => { if (res.kind !== 'doc') throw new Error(`not a doc: ${JSON.stringify(res)}`); return res.doc; };

describe('resolveDoc', () => {
  it('the main checkout copy, same as main, with its status line', () => {
    r = makeRepo();
    r.write(SPEC, '# A\n\nStatus: draft, awaiting owner review\n');
    r.commit('a');
    const d = doc(resolveDoc(project(), SPEC));
    expect(d).toMatchObject({ source: 'main', path: SPEC, vsMain: 'same', status: 'draft, awaiting owner review', worktree: null });
    expect(d.absPath).toBe(path.join(r.dir, SPEC));
  });

  it('a .worktrees copy that main lacks: not_on_main, with the worktree and branch', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', path.join(r.dir, '.worktrees', 'a'));
    r.write(SPEC, '# A\n', path.join(r.dir, '.worktrees', 'a'));
    const d = doc(resolveDoc(project(), SPEC));
    expect(d).toMatchObject({ source: 'worktree', worktree: 'a', branch: 'spec/a', vsMain: 'not_on_main' });
  });

  it('a .claude/worktrees copy that changed: changed', () => {
    r = makeRepo();
    r.write(SPEC, 'v1'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/b', path.join(r.dir, '.claude', 'worktrees', 'b'));
    const wt = path.join(r.dir, '.claude', 'worktrees', 'b');
    fs.writeFileSync(path.join(wt, SPEC), 'v2');
    const d = doc(resolveDoc(project(), `.claude/worktrees/b/${SPEC}`));
    expect(d).toMatchObject({ source: 'worktree', worktree: 'b', vsMain: 'changed', markdown: 'v2' });
  });

  it('an absolute path inside a worktree', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
    r.write(SPEC, 'w', wt);
    expect(doc(resolveDoc(project(), path.join(wt, SPEC)))).toMatchObject({ source: 'worktree', worktree: 'a' });
  });

  it('a removed worktree path reads the named branch', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'gone');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/gone', wt);
    r.write(SPEC, 'from branch', wt); r.commit('doc', wt);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    const d = doc(resolveDoc(project(), `.worktrees/gone/${SPEC}`, { branch: 'spec/gone' }));
    expect(d).toMatchObject({ source: 'branch', branch: 'spec/gone', absPath: null, markdown: 'from branch', vsMain: 'not_on_main' });
  });

  it('a removed worktree path with no branch named uses the branch that ends in its name', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'gone');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/gone', wt);
    r.write(SPEC, 'b', wt); r.commit('doc', wt);
    r.g(r.dir, 'worktree', 'remove', '--force', wt);
    expect(doc(resolveDoc(project(), `.worktrees/gone/${SPEC}`))).toMatchObject({ source: 'branch', branch: 'spec/gone' });
  });

  it('an unmerged branch with no worktree', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/c');
    r.write(SPEC, 'c'); r.commit('c');
    r.g(r.dir, 'checkout', '-q', 'main');
    expect(doc(resolveDoc(project(), SPEC))).toMatchObject({ source: 'branch', branch: 'spec/c', vsMain: 'not_on_main', markdown: 'c' });
  });

  it('not found lists where it looked', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const res = resolveDoc(project(), 'docs/plans/none.md');
    expect(res.kind).toBe('not_found');
  });

  it('a folder that is not a git repo: on disk only, vsMain unknown', () => {
    r = makeRepo();
    fs.rmSync(path.join(r.dir, '.git'), { recursive: true, force: true });
    r.write(SPEC, 'plain');
    expect(doc(resolveDoc(project(), SPEC))).toMatchObject({ source: 'main', vsMain: 'unknown' });
  });
});

describe('resolveDoc safety', () => {
  it('refuses ../, an absolute path outside, and a symlink out', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    fs.writeFileSync(path.join(r.root, 'secret.md'), 's');
    fs.mkdirSync(path.join(r.dir, 'docs'), { recursive: true });
    fs.symlinkSync(path.join(r.root, 'secret.md'), path.join(r.dir, 'docs', 'link.md'));
    expect(resolveDoc(project(), '../secret.md').kind).toBe('refused');
    expect(resolveDoc(project(), path.join(r.root, 'secret.md')).kind).toBe('refused');
    expect(resolveDoc(project(), 'docs/link.md').kind).toBe('refused');
  });
  it('refuses other file types and a folder', () => {
    r = makeRepo();
    r.write('docs/a.json', '{}'); r.write('docs/dir.md/x.md', 'x'); r.commit('init');
    expect(resolveDoc(project(), 'docs/a.json').kind).toBe('refused');
    expect(resolveDoc(project(), 'docs/dir.md').kind).toBe('refused');
  });
  it('a worktree outside the project folder is not used', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const outside = path.join(r.root, 'elsewhere');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/out', outside);
    r.write(SPEC, 'o', outside);
    expect(resolveDoc(project(), SPEC).kind).toBe('not_found');
  });
  it('ignores a branch the server did not list, and a branch named like an option', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    expect(resolveDoc(project(), `.worktrees/x/${SPEC}`, { branch: '--output=/tmp/x' }).kind).toBe('not_found');
    expect(resolveDoc(project(), `.worktrees/x/${SPEC}`, { branch: 'no-such-branch' }).kind).toBe('not_found');
  });
  it('a file over 2 MB on disk and a blob over 2 MB on a branch are too large', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    r.write('docs/big.md', 'x'.repeat(DOC_MAX_BYTES + 1));
    expect(resolveDoc(project(), 'docs/big.md').kind).toBe('too_large');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/big');
    r.write('docs/bigb.md', 'x'.repeat(DOC_MAX_BYTES + 1)); r.commit('big');
    r.g(r.dir, 'checkout', '-q', 'main');
    fs.rmSync(path.join(r.dir, 'docs', 'big.md'), { force: true }); // the branch commit took it along
    expect(resolveDoc(project(), 'docs/bigb.md').kind).toBe('too_large');
  });
});

describe('statusLine', () => {
  it('the first Status: line in the first 20 lines, max 60 chars', () => {
    expect(statusLine('# T\nDate: x\nStatus: approved\n')).toBe('approved');
    expect(statusLine('# T\n'.repeat(25) + 'Status: late\n')).toBeNull();
    expect(statusLine(`Status: ${'y'.repeat(80)}`)).toHaveLength(60);
  });
});
```

Add to `packages/core/tests/overseer/source-file.test.ts` (copy the file's own `write` helper and project folder setup):

```ts
  it('a .worktrees copy is found when the project lacks the file', () => {
    write('project/.worktrees/live-plan/docs/plans/new.md', '# New\n');
    const r = readSourceFile(projectDir, 'docs/plans/new.md');
    expect(r.kind).toBe('file');
    if (r.kind === 'file') expect(r.note).toMatch(/live-plan/);
  });
```

Add to `packages/core/tests/routes/endless.test.ts`:

```ts
  it('GET /doc returns a doc, 403 for a refused path, 404 when missing', async () => {
    fs.mkdirSync(path.join(root, 'salsify', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'salsify', 'docs', 'a.md'), '# A\n');
    const ok = await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/a.md' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ path: 'docs/a.md', markdown: '# A\n' });
    expect((await request(app).get('/api/endless/doc').query({ project: 's1', path: '../x.md' })).status).toBe(403);
    expect((await request(app).get('/api/endless/doc').query({ project: 's1', path: 'docs/none.md' })).status).toBe(404);
    expect((await request(app).get('/api/endless/doc').query({ project: 'nope', path: 'docs/a.md' })).status).toBe(400);
  });
```

- [ ] **Step 3: Run the three files and see them fail.** From `packages/core`, one at a time, output to `/tmp/ctv-t8*.log`.

- [ ] **Step 4: Implement**

`packages/core/src/overseer/source-file.ts`:
- Add `export` to `leadsOut`, `projectRelative` and `locate`.
- Widen the worktree pattern: `const WORKTREE = /^(\.claude\/worktrees|\.worktrees)\/([^/]+)\/(.+)$/;` and update its two uses (`wt[2]` is the name, `wt[3]` the rest; the "gone" check joins `wt[1]` and `wt[2]`).
- Add and use `projectWorktrees`:

```ts
/** Worktrees inside the project folder: `git worktree list`, plus the `.claude/worktrees` and `.worktrees` folders (for a folder git does not know). */
export function projectWorktrees(realRoot: string): { name: string; real: string; rel: string; branch: string | null }[] {
  const out = new Map<string, { name: string; real: string; rel: string; branch: string | null }>();
  const add = (abs: string, branch: string | null) => {
    let real: string;
    try { real = fs.realpathSync(abs); } catch { return; }
    const rel = path.relative(realRoot, real);
    if (leadsOut(rel) || out.has(real)) return;
    out.set(real, { name: path.basename(real), real, rel, branch });
  };
  for (const w of worktrees(realRoot)) add(w.path, w.branch);
  for (const base of ['.claude/worktrees', '.worktrees']) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(realRoot, base)); } catch { continue; }
    for (const n of names) add(path.join(realRoot, base, n), null);
  }
  return [...out.values()];
}
```
(import `worktrees` from `../docs/git.js`). `worktreeCopies` loops over `projectWorktrees(realRoot)` and uses `path.join(w.rel, rel)` as the worktree-relative path instead of the fixed `.claude/worktrees/name` join. Its note text stays `From the worktree "${name}"...`.

`packages/core/src/docs/git.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const GIT_TIMEOUT_MS = 5000;
export function gitBuffer(dir: string, args: string[]): Buffer | null {
  try { return execFileSync('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
}
export function git(dir: string, args: string[]): string | null { const b = gitBuffer(dir, args); return b ? b.toString('utf8') : null; }
export const isRepo = (dir: string) => git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
export function worktrees(dir: string): { path: string; branch: string | null }[] {
  const out = git(dir, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const list: { path: string; branch: string | null }[] = [];
  for (const block of out.split('\n\n')) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    if (!p) continue;
    const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    list.push({ path: p, branch: b });
  }
  return list.slice(1); // the first entry is the main checkout
}
export function refs(dir: string): { name: string; date: number }[] {
  const out = git(dir, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes']);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => { const [name, d] = l.split('\t'); return { name, date: Number(d) || 0 }; }).filter((r) => !r.name.endsWith('/HEAD') && r.name !== 'origin');
}
export function defaultBranch(dir: string): string | null {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (head) return head;
  const names = new Set(refs(dir).map((r) => r.name));
  return names.has('main') ? 'main' : names.has('master') ? 'master' : null;
}
const spec = (ref: string, rel: string) => `${ref}:${rel.split('\\').join('/')}`;
export const blobHash = (dir: string, ref: string, rel: string) => git(dir, ['rev-parse', '--verify', '--quiet', spec(ref, rel)])?.trim() || null;
export function blobSize(dir: string, ref: string, rel: string): number | null { const s = git(dir, ['cat-file', '-s', spec(ref, rel)]); return s ? Number(s.trim()) : null; }
export const readBlob = (dir: string, ref: string, rel: string) => gitBuffer(dir, ['cat-file', 'blob', spec(ref, rel)]);
export function hashBytes(buf: Buffer): string { return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex'); }
export const commitDate = (dir: string, ref: string, rel: string) => git(dir, ['log', '-1', '--format=%cI', ref, '--', rel])?.trim() || null;
```

The `ref` given to `blobHash`, `blobSize`, `readBlob` and `commitDate` must always be a name from `refs()` (or `defaultBranch()`); `resolveDoc` and `listDocs` enforce that.

`packages/core/src/docs/resolve.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { leadsOut, projectRelative, locate, projectWorktrees } from '../overseer/source-file.js';
import { isRepo, refs, defaultBranch, blobHash, blobSize, readBlob, hashBytes, commitDate, git } from './git.js';

export const DOC_MAX_BYTES = 2 * 1024 * 1024;
export const DOC_EXT = /\.(md|markdown|txt)$/i;
export interface DocCopy { project: string; path: string; absPath: string | null; source: 'main' | 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'same' | 'changed' | 'not_on_main' | 'unknown'; modifiedAt: string; status: string | null; note: string | null; markdown: string }
export type DocResult = { kind: 'doc'; doc: DocCopy } | { kind: 'not_found'; looked: string[] } | { kind: 'refused'; reason: string } | { kind: 'too_large'; path: string; size: number };

const WT = /^(\.claude\/worktrees|\.worktrees)\/([^/]+)\/(.+)$/;
const posix = (p: string) => p.split(path.sep).join('/');

export function statusLine(text: string): string | null {
  for (const line of text.split('\n').slice(0, 20)) {
    const m = /^\s*Status:\s*(.+?)\s*$/i.exec(line);
    if (m) return m[1].slice(0, 60);
  }
  return null;
}

export function resolveDoc(project: { id: string; folder: string }, ref: string, opts: { branch?: string | null } = {}): DocResult {
  let realRoot: string;
  try { realRoot = fs.realpathSync(project.folder); } catch { return { kind: 'not_found', looked: [project.folder] }; }
  const rel = projectRelative(project.folder, realRoot, ref);
  if (rel === null) return { kind: 'refused', reason: 'This path is outside the project.' };
  if (!DOC_EXT.test(rel)) return { kind: 'refused', reason: 'Only .md, .markdown and .txt files open here.' };
  const repo = isRepo(realRoot);
  const base = repo ? defaultBranch(realRoot) : null;
  const known = repo ? refs(realRoot) : [];
  const wts = projectWorktrees(realRoot);
  const looked: string[] = [];

  const vs = (mainRel: string, bytes: Buffer): DocCopy['vsMain'] => {
    if (!base) return 'unknown';
    const h = blobHash(realRoot, base, mainRel);
    return h === null ? 'not_on_main' : h === hashBytes(bytes) ? 'same' : 'changed';
  };
  const fromDisk = (real: string, inRoot: string): DocResult => {
    const st = fs.statSync(real);
    if (!st.isFile()) return { kind: 'refused', reason: 'This path is a folder, not a file.' };
    if (st.size > DOC_MAX_BYTES) return { kind: 'too_large', path: posix(inRoot), size: st.size };
    const bytes = fs.readFileSync(real);
    const w = wts.find((x) => inRoot === x.rel || inRoot.startsWith(x.rel + path.sep));
    const docRel = w ? path.relative(w.rel, inRoot) : inRoot;
    const text = bytes.toString('utf8');
    return { kind: 'doc', doc: { project: project.id, path: posix(docRel), absPath: real, source: w ? 'worktree' : 'main', worktree: w?.name ?? null, branch: w?.branch ?? null, vsMain: vs(docRel, bytes), modifiedAt: st.mtime.toISOString(), status: statusLine(text), note: null, markdown: text } };
  };
  const fromBranch = (branch: string, docRel: string, note: string | null = null): DocResult | null => {
    if (!known.some((k) => k.name === branch)) return null;
    const size = blobSize(realRoot, branch, docRel);
    if (size === null) return null;
    if (size > DOC_MAX_BYTES) return { kind: 'too_large', path: posix(docRel), size };
    const bytes = readBlob(realRoot, branch, docRel);
    if (!bytes) return null;
    const text = bytes.toString('utf8');
    return { kind: 'doc', doc: { project: project.id, path: posix(docRel), absPath: null, source: 'branch', worktree: null, branch, vsMain: vs(docRel, bytes), modifiedAt: commitDate(realRoot, branch, docRel) ?? new Date(0).toISOString(), status: statusLine(text), note, markdown: text } };
  };
  const unmerged = (): { name: string; date: number }[] => {
    if (!base) return [];
    const merged = new Set((git(realRoot, ['branch', '-a', '--merged', base, '--format=%(refname:short)']) ?? '').split('\n').map((s) => s.trim()).filter(Boolean));
    return known.filter((k) => k.name !== base && !merged.has(k.name)).sort((a, b) => b.date - a.date);
  };

  // 1. On disk.
  looked.push(posix(rel));
  const found = locate(realRoot, rel);
  if (found === 'outside') return { kind: 'refused', reason: 'This path is outside the project.' };
  if (found !== 'missing') return fromDisk(found, rel);

  const wt = WT.exec(posix(rel));
  if (wt) {
    // 3. A path inside a removed worktree: the named branch, the branch that ends in its name, the main checkout.
    const rest = wt[3];
    if (leadsOut(path.normalize(rest))) return { kind: 'refused', reason: 'This path is outside the project.' };
    const byName = known.filter((k) => k.name === wt[2] || k.name.endsWith(`/${wt[2]}`)).sort((a, b) => b.date - a.date)[0]?.name;
    for (const b of [opts.branch, byName]) {
      if (!b) continue;
      looked.push(`${b}:${rest}`);
      const r = fromBranch(b, rest, `The worktree "${wt[2]}" is gone; read from the branch.`);
      if (r) return r;
    }
    looked.push(rest);
    const main = locate(realRoot, path.normalize(rest));
    if (main === 'outside') return { kind: 'refused', reason: 'This path is outside the project.' };
    if (main !== 'missing') {
      const r = fromDisk(main, path.normalize(rest));
      if (r.kind === 'doc') r.doc.note = `The worktree "${wt[2]}" is gone; this is the main checkout copy.`;
      return r;
    }
    return { kind: 'not_found', looked };
  }

  // 2. Worktree copies, newest first.
  const copies = wts.flatMap((w) => {
    const real = locate(realRoot, path.join(w.rel, rel));
    if (real === 'missing' || real === 'outside') return [];
    return [{ w, real, mtime: fs.statSync(real).mtimeMs }];
  }).sort((a, b) => b.mtime - a.mtime);
  for (const w of wts) looked.push(posix(path.join(w.rel, rel)));
  if (copies.length) {
    const r = fromDisk(copies[0].real, path.join(copies[0].w.rel, rel));
    if (r.kind === 'doc' && copies.length > 1) r.doc.note = `The newest of ${copies.length} copies.`;
    return r;
  }

  // 4. Unmerged branches, newest first.
  for (const b of unmerged()) {
    looked.push(`${b.name}:${posix(rel)}`);
    const r = fromBranch(b.name, rel);
    if (r) return r;
  }
  return { kind: 'not_found', looked };
}
```

`packages/core/src/docs/service.ts`:

```ts
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { resolveDoc, type DocResult } from './resolve.js';

export class DocsService {
  constructor(private readonly db: Database.Database) {}
  project(id: string): { id: string; folder: string } | null {
    const s = sessionsDb.getById(this.db, id);
    return s ? { id: s.id, folder: s.working_dir } : null;
  }
  doc(projectId: string, docPath: string, branch: string | null): DocResult | null {
    const p = this.project(projectId);
    return p ? resolveDoc(p, docPath, { branch }) : null;
  }
}
```

Absolute paths: `GET /doc` takes the message's project when it has one. For an absolute path with no project, the web picks the project by folder prefix (Task 10). The resolver refuses an absolute path outside the given project.

`EndlessService`: add `readonly docs: DocsService;` set in the constructor with `new DocsService(o.db)`.

`routes/endless.ts`, next to `/projects`:

```ts
  router.get('/doc', (req, res) => {
    const r = svc.docs.doc(String(req.query.project ?? ''), String(req.query.path ?? ''), str(req.query.branch));
    if (!r) { res.status(400).json({ error: 'unknown project' }); return; }
    if (r.kind === 'doc') res.json(r.doc);
    else if (r.kind === 'refused') res.status(403).json({ reason: r.reason });
    else if (r.kind === 'too_large') res.status(413).json({ path: r.path, size: r.size });
    else res.status(404).json({ looked: r.looked });
  });
```

- [ ] **Step 5: Run the three test files again** (and the whole `tests/overseer/source-file.test.ts`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/overseer/source-file.ts packages/core/src/docs packages/core/src/endless/service.ts packages/core/src/routes/endless.ts packages/core/tests/docs packages/core/tests/overseer/source-file.test.ts packages/core/tests/routes/endless.test.ts
git commit -m "feat(core): a read-only doc resolver for main, worktrees and unmerged branches"
```

### Task 9: In-progress docs list, counts, and the doc report rule

**Files:**
- Create: `packages/core/src/docs/list.ts`
- Modify: `packages/core/src/docs/service.ts`, `packages/core/src/endless/store.ts`, `packages/core/src/routes/endless.ts`, `packages/core/src/overseer/prompts.ts:391` (the `AGENT_AUTONOMY_NOTE` string)
- Test: `packages/core/tests/docs/list.test.ts` (new), `packages/core/tests/routes/endless.test.ts`, `packages/core/tests/overseer/prompts.test.ts`

**Interfaces:**

```ts
// docs/list.ts
export const DOC_FOLDERS = ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/specs', 'docs/plans'];
export const DOCS_ROWS = 5; export const DOCS_BRANCHES = 20; export const DOCS_CACHE_MS = 60_000;
export interface DocRow { path: string; name: string; status: string | null; source: 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'changed' | 'not_on_main'; modifiedAt: string; copies: number; writer: { id: string; label: string } | null }
export function listDocs(project: { id: string; folder: string }, writerOf: (copy: { path: string; worktreeReal: string | null }) => { id: string; label: string } | null): { rows: DocRow[]; total: number };
// DocsService gains: list(projectId): { rows: DocRow[]; total: number } | null; counts(projectIds: string[]): Record<string, number>  (both cached DOCS_CACHE_MS per project)
// EndlessStore gains: lastWorkMentioning(project: string, needle: string): EndlessMessage | null
// routes: GET /api/endless/docs?project=ID -> { rows, total }; GET /api/endless/docs/counts?projects=a,b -> { counts: Record<string, number> }
```

The counts route takes the list of project ids the pane shows (Q19 and Q20): the pane asks only for the projects it already shows.

- [ ] **Step 1: Write the failing tests** `packages/core/tests/docs/list.test.ts`

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listDocs, DOCS_ROWS } from '../../src/docs/list.js';
import { makeRepo } from './git-fixture.js';

let r: ReturnType<typeof makeRepo>;
afterEach(() => r?.rm());
const noWriter = () => null;

describe('listDocs', () => {
  it('lists only in-progress docs in the four folders', () => {
    r = makeRepo();
    r.write('docs/superpowers/specs/on-main.md', 'same');
    r.write('docs/superpowers/specs/edited.md', 'v1');
    r.commit('init');
    const wt = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
    r.write('docs/superpowers/specs/edited.md', 'v2', wt);         // changed
    r.write('docs/superpowers/plans/new-plan.md', 'p', wt);       // untracked: not on main
    r.write('notes/other.md', 'x', wt);                            // outside the folders
    const { rows, total } = listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.vsMain]).sort()).toEqual([['docs/superpowers/plans/new-plan.md', 'not_on_main'], ['docs/superpowers/specs/edited.md', 'changed']]);
    expect(total).toBe(2);
    expect(rows[0]).toMatchObject({ source: 'worktree', worktree: 'a', branch: 'spec/a' });
  });

  it('a branch with no worktree adds only what it added or changed', () => {
    r = makeRepo();
    r.write('docs/plans/base.md', 'b'); r.commit('init');
    r.g(r.dir, 'checkout', '-q', '-b', 'spec/c');
    r.write('docs/plans/c.md', 'c'); r.commit('c');
    r.g(r.dir, 'checkout', '-q', 'main');
    const { rows } = listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows.map((x) => [x.path, x.source, x.branch])).toEqual([['docs/plans/c.md', 'branch', 'spec/c']]);
  });

  it('a copy that matches main is not listed', () => {
    r = makeRepo();
    r.write('docs/specs/x.md', 'same'); r.commit('init');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/x', path.join(r.dir, '.worktrees', 'x'));
    expect(listDocs({ id: 's1', folder: r.dir }, noWriter).rows).toEqual([]);
  });

  it('one row per path, the newest copy, with the copies count; at most 5 rows and the total', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const a = path.join(r.dir, '.worktrees', 'a'); const b = path.join(r.dir, '.worktrees', 'b');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', a);
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/b', b);
    const old = new Date(2025, 0, 1);
    r.write('docs/specs/same.md', 'old', a);
    fs.utimesSync(path.join(a, 'docs/specs/same.md'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    r.write('docs/specs/same.md', 'new', b); // the newest file of all
    for (let k = 0; k < 6; k++) { r.write(`docs/plans/p${k}.md`, `${k}`, a); fs.utimesSync(path.join(a, `docs/plans/p${k}.md`), old, old); }
    const { rows, total } = listDocs({ id: 's1', folder: r.dir }, noWriter);
    expect(rows).toHaveLength(DOCS_ROWS);
    expect(total).toBe(7);
    expect(rows[0]).toMatchObject({ path: 'docs/specs/same.md', worktree: 'b', copies: 2 });
  });

  it('the writer comes from the callback, with the worktree folder', () => {
    r = makeRepo();
    r.write('README.md', 'x'); r.commit('init');
    const a = path.join(r.dir, '.worktrees', 'a');
    r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', a);
    r.write('docs/specs/w.md', 'w', a);
    const writerOf = vi.fn(() => ({ id: 't1', label: 'Plan: w' }));
    const { rows } = listDocs({ id: 's1', folder: r.dir }, writerOf);
    expect(rows[0].writer).toEqual({ id: 't1', label: 'Plan: w' });
    expect(writerOf).toHaveBeenCalledWith({ path: 'docs/specs/w.md', worktreeReal: fs.realpathSync(a) });
  });

  it('a folder that is not a git repo lists nothing', () => {
    r = makeRepo();
    fs.rmSync(path.join(r.dir, '.git'), { recursive: true, force: true });
    r.write('docs/specs/a.md', 'a');
    expect(listDocs({ id: 's1', folder: r.dir }, noWriter)).toEqual({ rows: [], total: 0 });
  });
});
```

Add to `packages/core/tests/routes/endless.test.ts`:

```ts
  it('GET /docs and /docs/counts answer for a project that is not a repo', async () => {
    fs.mkdirSync(path.join(root, 'salsify'), { recursive: true });
    expect((await request(app).get('/api/endless/docs').query({ project: 's1' })).body).toEqual({ rows: [], total: 0 });
    expect((await request(app).get('/api/endless/docs/counts').query({ projects: 's1' })).body).toEqual({ counts: { s1: 0 } });
    expect((await request(app).get('/api/endless/docs').query({ project: 'nope' })).status).toBe(400);
  });
```

Add to `packages/core/tests/overseer/prompts.test.ts`:

```ts
  it('every agent prompt asks for the absolute path and branch of each doc it writes', () => {
    for (const p of Object.values(AGENT_PROMPTS)) expect(p).toMatch(/Doc: .*absolute path.*branch/s);
  });
```
(Import `AGENT_PROMPTS` from `../../src/overseer/prompts.js` if the file does not.)

- [ ] **Step 2: Run the three files and see them fail.**

- [ ] **Step 3: Implement**

`packages/core/src/docs/list.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { projectWorktrees } from '../overseer/source-file.js';
import { isRepo, refs, defaultBranch, blobHash, readBlob, hashBytes, commitDate, git } from './git.js';
import { statusLine } from './resolve.js';

export const DOC_FOLDERS = ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/specs', 'docs/plans'];
export const DOCS_ROWS = 5;
export const DOCS_BRANCHES = 20;
export const DOCS_CACHE_MS = 60_000;
export interface DocRow { path: string; name: string; status: string | null; source: 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'changed' | 'not_on_main'; modifiedAt: string; copies: number; writer: { id: string; label: string } | null }

const lines = (s: string | null) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const isDoc = (p: string) => /\.md$/i.test(p) && DOC_FOLDERS.some((f) => p.startsWith(`${f}/`));

export function listDocs(project: { id: string; folder: string }, writerOf: (c: { path: string; worktreeReal: string | null }) => { id: string; label: string } | null): { rows: DocRow[]; total: number } {
  let realRoot: string;
  try { realRoot = fs.realpathSync(project.folder); } catch { return { rows: [], total: 0 }; }
  if (!isRepo(realRoot)) return { rows: [], total: 0 };
  const base = defaultBranch(realRoot);
  if (!base) return { rows: [], total: 0 };
  type Copy = Omit<DocRow, 'copies' | 'writer' | 'name'> & { at: number; worktreeReal: string | null };
  const copies: Copy[] = [];
  const vs = (rel: string, bytes: Buffer): DocRow['vsMain'] | null => {
    const h = blobHash(realRoot, base, rel);
    return h === null ? 'not_on_main' : h === hashBytes(bytes) ? null : 'changed';
  };
  const wts = projectWorktrees(realRoot);
  for (const w of wts) {
    const changed = lines(git(w.real, ['diff', '--name-only', base, '--', ...DOC_FOLDERS]));
    const untracked = lines(git(w.real, ['ls-files', '--others', '--exclude-standard', '--', ...DOC_FOLDERS]));
    for (const rel of new Set([...changed, ...untracked])) {
      if (!isDoc(rel)) continue;
      const file = path.join(w.real, rel);
      let st: fs.Stats; try { st = fs.statSync(file); } catch { continue; } // deleted in the worktree
      if (!st.isFile()) continue;
      const bytes = fs.readFileSync(file);
      const v = vs(rel, bytes);
      if (!v) continue;
      copies.push({ path: rel, status: statusLine(bytes.toString('utf8')), source: 'worktree', worktree: w.name, branch: w.branch, vsMain: v, modifiedAt: st.mtime.toISOString(), at: st.mtimeMs, worktreeReal: w.real });
    }
  }
  const checkedOut = new Set(wts.map((w) => w.branch).filter(Boolean) as string[]);
  const merged = new Set(lines(git(realRoot, ['branch', '-a', '--merged', base, '--format=%(refname:short)'])));
  const branches = refs(realRoot).filter((b) => b.name !== base && !merged.has(b.name) && !checkedOut.has(b.name) && !checkedOut.has(b.name.replace(/^[^/]+\//, ''))).sort((a, b) => b.date - a.date).slice(0, DOCS_BRANCHES);
  for (const b of branches) {
    for (const rel of lines(git(realRoot, ['diff', '--name-only', `${base}...${b.name}`, '--', ...DOC_FOLDERS]))) {
      if (!isDoc(rel)) continue;
      const bytes = readBlob(realRoot, b.name, rel);
      if (!bytes) continue; // deleted on the branch
      const v = vs(rel, bytes);
      if (!v) continue;
      const when = commitDate(realRoot, b.name, rel) ?? new Date(b.date * 1000).toISOString();
      copies.push({ path: rel, status: statusLine(bytes.toString('utf8')), source: 'branch', worktree: null, branch: b.name, vsMain: v, modifiedAt: when, at: Date.parse(when), worktreeReal: null });
    }
  }
  const byPath = new Map<string, Copy[]>();
  for (const c of copies) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  const rows: DocRow[] = [...byPath.values()].map((list) => {
    const [best] = list.sort((a, b) => b.at - a.at);
    const { at: _at, worktreeReal, ...row } = best;
    return { ...row, name: path.basename(best.path), copies: list.length, writer: writerOf({ path: best.path, worktreeReal }) };
  }).sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return { rows: rows.slice(0, DOCS_ROWS), total: rows.length };
}
```

`EndlessStore.lastWorkMentioning` (in `packages/core/src/endless/store.ts`, next to `lastOfKind`): read `lastOfKind` and map its row the same way; the query is

```sql
SELECT * FROM endless_messages WHERE kind = 'work' AND project = ? AND instr(text, ?) > 0 ORDER BY i DESC LIMIT 1
```

`DocsService` gains a store and a cache:

```ts
  constructor(private readonly db: Database.Database, private readonly store?: EndlessStore, private readonly now: () => number = Date.now) {}
  private cache = new Map<string, { at: number; value: { rows: DocRow[]; total: number } }>();
  list(projectId: string): { rows: DocRow[]; total: number } | null {
    const p = this.project(projectId);
    if (!p) return null;
    const hit = this.cache.get(projectId);
    if (hit && this.now() - hit.at < DOCS_CACHE_MS) return hit.value;
    const value = listDocs(p, (c) => this.writerOf(projectId, c));
    this.cache.set(projectId, { at: this.now(), value });
    return value;
  }
  counts(ids: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of ids.slice(0, 50)) { const l = this.list(id); if (l) out[id] = l.total; }
    return out;
  }
  private writerOf(projectId: string, c: { path: string; worktreeReal: string | null }): { id: string; label: string } | null {
    if (c.worktreeReal) {
      const rows = this.db.prepare("SELECT id, label, working_dir, last_activity_at FROM terminals WHERE session_id = ? AND archived_at IS NULL AND working_dir IS NOT NULL ORDER BY COALESCE(last_activity_at, created_at) DESC").all(projectId) as { id: string; label: string; working_dir: string }[];
      for (const r of rows) {
        let real = r.working_dir; try { real = fs.realpathSync(r.working_dir); } catch { /* keep */ }
        if (real === c.worktreeReal || real.startsWith(c.worktreeReal + path.sep)) return { id: r.id, label: r.label };
      }
    }
    const m = this.store?.lastWorkMentioning(projectId, c.path);
    if (m?.ref) { const t = terminalsDb.getById(this.db, m.ref); if (t) return { id: t.id, label: t.label }; }
    return null;
  }
```
(The cache key is time only, 60 s, which is the spec's bound; a reopen inside 60 s is free.) `EndlessService` builds it with `new DocsService(o.db, this.store, this.now)`.

Routes:

```ts
  router.get('/docs', (req, res) => {
    const r = svc.docs.list(String(req.query.project ?? ''));
    if (!r) { res.status(400).json({ error: 'unknown project' }); return; }
    res.json(r);
  });
  router.get('/docs/counts', (req, res) => {
    const ids = String(req.query.projects ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    res.json({ counts: svc.docs.counts(ids) });
  });
```

`prompts.ts`: append one sentence to the end of the `AGENT_AUTONOMY_NOTE` string (it is shared by every agent type):

```ts
  ' When you write or change a doc (.md), end your report with one line per doc: "Doc: " and its absolute path, then the branch in parentheses, for example "Doc: /abs/path/docs/plans/x.md (branch spec/x)".' +
```
The test regex needs the words "absolute path" and "branch" after "Doc:"; keep this exact sentence.

- [ ] **Step 4: Run the three test files again.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/docs packages/core/src/endless/store.ts packages/core/src/endless/service.ts packages/core/src/routes/endless.ts packages/core/src/overseer/prompts.ts packages/core/tests/docs/list.test.ts packages/core/tests/routes/endless.test.ts packages/core/tests/overseer/prompts.test.ts
git commit -m "feat(core): in-progress docs per project, cached counts, and the doc report rule"
```

### Task 10: Doc links in chat

**Files:**
- Create: `packages/web/src/lib/docPaths.ts`, `packages/web/src/stores/docViewer.ts`
- Modify: `packages/web/src/components/Markdown.tsx`, `packages/web/src/components/endless/EndlessMessageRow.tsx` (reply, report card), `packages/web/src/components/endless/StartedItem.tsx` (task links)
- Test: `packages/web/src/lib/docPaths.test.ts` (new), `packages/web/src/components/Markdown.test.tsx`, `EndlessMessageRow.test.tsx`

**Interfaces:**

```ts
// lib/docPaths.ts
export interface DocSpan { start: number; end: number; path: string; branch: string | null }
export function findDocPaths(text: string): DocSpan[];
export function docName(path: string): string;            // the file name
export function projectForPath(path: string, messageProject: string | null, projects: { id: string; folder: string }[]): string | null;
// stores/docViewer.ts
export interface DocRef { project: string; path: string; branch: string | null }
export const useDocViewer: { open: DocRef | null; back: DocRef[]; show(ref: DocRef): void; push(ref: DocRef): void; pop(): void; close(): void };
// Markdown: new optional prop docs?: { onOpen: (path: string, branch: string | null) => void }
```

Chip look: `ChatStates.dc.html` S6 (a small file icon and the file name; the full path in `title`).

- [ ] **Step 1: Write the failing tests** `lib/docPaths.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { findDocPaths, docName, projectForPath } from './docPaths';

const paths = (t: string) => findDocPaths(t).map((s) => [s.path, s.branch]);

describe('findDocPaths', () => {
  it('bare and inline-code paths, with trailing punctuation removed', () => {
    expect(paths('See docs/plans/a.md, then `docs/specs/b-design.md`.')).toEqual([['docs/plans/a.md', null], ['docs/specs/b-design.md', null]]);
    expect(paths('(docs/plans/c.md)')).toEqual([['docs/plans/c.md', null]]);
  });
  it('absolute paths and the (branch ...) part', () => {
    expect(paths('Doc: /w/dispatch/.worktrees/x/docs/specs/x.md (branch spec/x)')).toEqual([['/w/dispatch/.worktrees/x/docs/specs/x.md', 'spec/x']]);
  });
  it('only .md, .markdown and .txt; URLs are left alone', () => {
    expect(paths('a.json b.ts notes.txt README.markdown')).toEqual([['notes.txt', null], ['README.markdown', null]]);
    expect(paths('https://example.com/docs/a.md')).toEqual([]);
  });
  it('the span covers the path only', () => {
    const t = 'x docs/a.md.';
    const [s] = findDocPaths(t);
    expect(t.slice(s.start, s.end)).toBe('docs/a.md');
  });
});

describe('projectForPath', () => {
  const projects = [{ id: 's1', folder: '/w/dispatch' }, { id: 's2', folder: '/w/dispatch-web' }];
  it('an absolute path picks the longest folder match; a relative path uses the message project', () => {
    expect(projectForPath('/w/dispatch-web/docs/a.md', null, projects)).toBe('s2');
    expect(projectForPath('/w/dispatch/docs/a.md', 's2', projects)).toBe('s1');
    expect(projectForPath('docs/a.md', 's2', projects)).toBe('s2');
    expect(projectForPath('docs/a.md', null, projects)).toBeNull();
    expect(projectForPath('/elsewhere/a.md', null, projects)).toBeNull();
  });
  it('docName', () => { expect(docName('/a/b/c-design.md')).toBe('c-design.md'); });
});
```

Add to `Markdown.test.tsx`:

```tsx
  it('the docs pass makes doc chips after the sanitizer and opens them', () => {
    const onOpen = vi.fn();
    const { container } = render(<Markdown source={'Read `docs/plans/a.md` and <img src=x onerror=alert(1)>'} docs={{ onOpen }} />);
    const chip = container.querySelector<HTMLElement>('[data-doc-path]')!;
    expect(chip.textContent).toBe('a.md');
    expect(container.innerHTML).not.toMatch(/onerror/);
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith('docs/plans/a.md', null);
  });
  it('no docs prop, no chips', () => {
    const { container } = render(<Markdown source={'docs/plans/a.md'} />);
    expect(container.querySelector('[data-doc-path]')).toBeNull();
  });
```

Add to `EndlessMessageRow.test.tsx`:

```tsx
describe('doc links in chat', () => {
  it('a report card path opens the doc viewer with the report project', () => {
    const work = { ...m(0, 'work', '[Plan] report: done. Doc: docs/specs/x.md (branch spec/x)'), project: 's1', ref: 't1' };
    render(<MessageScroller><EndlessRows messages={[work]} focus={null} /></MessageScroller>);
    fireEvent.click(screen.getByRole('button', { name: 'x.md' }));
    expect(useDocViewer.getState().open).toEqual({ project: 's1', path: 'docs/specs/x.md', branch: 'spec/x' });
  });
  it('a Started card shows up to 2 doc links from its task', () => {
    const tool = m(0, 'tool', `mcp__memory__spawn_agent ${JSON.stringify({ project: 'studio', name: 'Plan', task: 'Read docs/a.md, docs/b.md and docs/c.md' })}`);
    render(<StartedItem tool={tool} echo={spawnEcho(1, 't9', 'Plan')} />);
    expect(screen.getAllByRole('button', { name: /\.md$/ })).toHaveLength(2);
  });
});
```
(Import `useDocViewer` from `../../stores/docViewer`; reset it in `beforeEach` with `useDocViewer.setState({ open: null, back: [] })`. For the Started case the project id comes from the echo: `s1`.)

- [ ] **Step 2: Run the three files and see them fail.**

- [ ] **Step 3: Implement**

`lib/docPaths.ts`:

```ts
export interface DocSpan { start: number; end: number; path: string; branch: string | null }
// A path: absolute or relative, made of path characters, ending in a doc extension. Not part of a URL.
const PATH = /(?<![\w:/.-])((?:\/|\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:md|markdown|txt))(?![\w/-])/gi;
const BRANCH = /^\s*\(branch ([\w./@-]+)\)/;

export function findDocPaths(text: string): DocSpan[] {
  const out: DocSpan[] = [];
  for (const m of text.matchAll(PATH)) {
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 12), start);
    if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(before)) continue; // inside a URL
    const path = m[1];
    const end = start + path.length;
    const b = BRANCH.exec(text.slice(end));
    out.push({ start, end, path, branch: b ? b[1] : null });
  }
  return out;
}
export const docName = (p: string) => p.split('/').pop() || p;
export function projectForPath(p: string, messageProject: string | null, projects: { id: string; folder: string }[]): string | null {
  if (!p.startsWith('/')) return messageProject;
  const hit = projects.filter((x) => p === x.folder || p.startsWith(x.folder.replace(/\/$/, '') + '/')).sort((a, b) => b.folder.length - a.folder.length)[0];
  return hit?.id ?? null;
}
```
Run the URL test; if the lookbehind lets a URL through, widen the URL check to look back to the last whitespace.

`stores/docViewer.ts`:

```ts
import { create } from 'zustand';
export interface DocRef { project: string; path: string; branch: string | null }
interface S { open: DocRef | null; back: DocRef[]; show: (r: DocRef) => void; push: (r: DocRef) => void; pop: () => void; close: () => void }
export const useDocViewer = create<S>((set, get) => ({
  open: null, back: [],
  show: (r) => set({ open: r, back: [] }),
  push: (r) => { const cur = get().open; set({ open: r, back: cur ? [...get().back, cur] : get().back }); },
  pop: () => { const b = get().back; if (!b.length) return; set({ open: b[b.length - 1], back: b.slice(0, -1) }); },
  close: () => set({ open: null, back: [] }),
}));
```

`Markdown.tsx`: add `docs?: { onOpen: (path: string, branch: string | null) => void }` to the props. After the sanitizer (next to `chipifyHtml`), when `docs` is set, run `docifyHtml(clean)`: parse into a detached `<div>`, walk text nodes with a `TreeWalker` (skip text inside `a`, `pre` and `button`; text inside inline `code` is included), and for each `findDocPaths` span replace the text with `<button type="button" class="doc-chip" data-doc-path="PATH" data-doc-branch="BRANCH" title="PATH">NAME</button>` built with `document.createElement` and `textContent` (never string HTML). When a whole inline `code` element is one path, replace the `code` element itself. In `onClick`, before the ledger chip check:

```ts
    const doc = docs ? (t.closest?.('[data-doc-path]') as HTMLElement | null) : null;
    if (doc && docs) { e.stopPropagation(); docs.onOpen(doc.dataset.docPath!, doc.dataset.docBranch || null); return; }
```
Add `.md-view .doc-chip` styles to `packages/web/src/theme.css`: inline-flex, gap 4px, height 20px, padding 0 6px, radius 5px, background `var(--color-elevated)`, 1px border `var(--color-border)`, font 11.5px `var(--font-mono)`, color `var(--color-text-secondary)`, cursor pointer, max-width 100%, `overflow-wrap: anywhere`; a `::before` file glyph is optional (the board uses a Phosphor file icon; an inline SVG background is fine).

`EndlessMessageRow.tsx`:
- A Dispatch reply (`unii`) renders `InsightText`. Pass a `docs` prop through `InsightText` to `Markdown` (add the optional prop to `InsightText` and forward it to every `Markdown` it renders). The `onOpen` is `(p, b) => { const project = projectForPath(p, m.project, useEndless.getState().projects); if (project) useDocViewer.getState().show({ project, path: p, branch: b }); }`.
- The report card renders plain text. Add a small `DocText({ text, project })` component that splits `text` with `findDocPaths` into strings and chip buttons (same class `doc-chip`, `aria-label` = the file name, the text = the file name), and use it for the short card body, the folded preview and the open body. The chip `onClick` calls `e.stopPropagation()` and then the same `show(...)`.
- `StartedItem`: when `findDocPaths(s.task)` is not empty, render a second line under the card with the first 2 chips (spec section 15: a second line only for doc chips). The project is the started thread's `projectId`.

- [ ] **Step 4: Run the three files again**, then `src/components/InsightText*.test.tsx` if present. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/docPaths.ts packages/web/src/lib/docPaths.test.ts packages/web/src/stores/docViewer.ts packages/web/src/components/Markdown.tsx packages/web/src/components/Markdown.test.tsx packages/web/src/components/InsightText.tsx packages/web/src/components/endless/EndlessMessageRow.tsx packages/web/src/components/endless/EndlessMessageRow.test.tsx packages/web/src/components/endless/StartedItem.tsx packages/web/src/theme.css
git commit -m "feat(web): doc paths in Chat replies, reports and Started cards become doc chips"
```

### Task 11: The doc viewer, the Docs list, and Open in Threads for a project

**Files:**
- Create: `packages/web/src/components/endless/DocViewer.tsx`, `packages/web/src/components/endless/DocsFold.tsx`
- Modify: `packages/web/src/api/types.ts`, `packages/web/src/api/client.ts`, `packages/web/src/stores/ui.ts`, `packages/web/src/stores/settings.ts`, `packages/web/src/stores/endless.ts` (doc counts), `packages/web/src/components/endless/ProjectsPanel.tsx`, `packages/web/src/components/endless/ChatMode.tsx`, `packages/web/src/components/endless/MemoryInspector.tsx`, `packages/web/src/App.tsx`, `packages/web/src/components/mobile/MobileApp.tsx`
- Test: `packages/web/src/components/endless/DocViewer.test.tsx` (new), `ProjectsPanel.test.tsx`, `packages/web/src/stores/ui.test.ts` (new or existing)

**Interfaces:**

```ts
// api/types.ts
export interface EndlessDocCopy { project: string; path: string; absPath: string | null; source: 'main' | 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'same' | 'changed' | 'not_on_main' | 'unknown'; modifiedAt: string; status: string | null; note: string | null; markdown: string }
export interface EndlessDocRow { path: string; name: string; status: string | null; source: 'worktree' | 'branch'; worktree: string | null; branch: string | null; vsMain: 'changed' | 'not_on_main'; modifiedAt: string; copies: number; writer: { id: string; label: string } | null }
// api/client.ts
endlessDoc(project: string, path: string, branch: string | null): Promise<EndlessDocCopy>   // throws Error('GET ... failed: 403 ...') etc.
endlessDocs(project: string): Promise<{ rows: EndlessDocRow[]; total: number }>
endlessDocCounts(projects: string[]): Promise<{ counts: Record<string, number> }>
revealFiles(projectId: string, relPaths: string[]): Promise<void>   // reuse the existing client call for POST /api/sessions/:id/files/reveal if one exists; else add it
// stores/ui.ts
pendingOpenProject: string | null; requestOpenProject(id: string): void; clearOpenProject(): void;
// stores/settings.ts
editor: '' | 'vscode' | 'cursor' | 'zed'; setEditor(e): void   // persisted like the other settings
// stores/endless.ts
docCounts: Record<string, number>; loadDocCounts(ids: string[]): Promise<void>  // called on watch() and on the 60 s timer, never on thread events
```

Visual reference: `DocViewer.dc.html`, `DocStates.dc.html`, `PhoneDoc.dc.html`, `PaneStates.dc.html` (S8), `PhoneDocs.dc.html`. The location chip in a Docs row is the short form ("worktree NAME" or "branch NAME"), never cut mid-word (spec 15, board fix).

- [ ] **Step 1: Write the failing tests**

`DocViewer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocViewer } from './DocViewer';
import { useDocViewer } from '../../stores/docViewer';
import { useHost } from '../../stores/host';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

const copy = (o = {}) => ({ project: 's1', path: 'docs/specs/x.md', absPath: '/w/d/.worktrees/x/docs/specs/x.md', source: 'worktree', worktree: 'x', branch: 'spec/x', vsMain: 'not_on_main', modifiedAt: '2026-10-19T11:31:00Z', status: 'draft', note: null, markdown: '# X\n\nSee docs/specs/y.md', ...o });

beforeEach(() => { useDocViewer.setState({ open: { project: 's1', path: 'docs/specs/x.md', branch: null }, back: [] }); useHost.setState({ canReveal: true } as any); });

describe('DocViewer', () => {
  it('shows the location and vs-main chips, the status line and the doc', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<DocViewer />);
    expect(await screen.findByText('worktree x on spec/x')).toBeInTheDocument();
    expect(screen.getByText('not on main')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'X' })).toBeInTheDocument();
  });
  it('a branch copy says as of the last fetch, and has no Reveal', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy({ source: 'branch', absPath: null, worktree: null, branch: 'origin/spec/t', vsMain: 'changed' }) as any);
    render(<DocViewer />);
    expect(await screen.findByText('branch origin/spec/t, as of the last fetch')).toBeInTheDocument();
    expect(screen.getByText('changed here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
  });
  it('Reveal and Open in editor need canReveal; the editor needs a setting', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    useSettings.setState({ editor: '' } as any);
    const { unmount } = render(<DocViewer />);
    expect(await screen.findByRole('button', { name: 'Reveal in Finder' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
    unmount();
    useSettings.setState({ editor: 'vscode' } as any);
    useHost.setState({ canReveal: false } as any);
    render(<DocViewer />);
    await screen.findByText('not on main');
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument();
  });
  it('not found, refused, too large', async () => {
    vi.spyOn(api, 'endlessDoc').mockRejectedValueOnce(new Error('GET /api/endless/doc failed: 404'));
    const { unmount } = render(<DocViewer />);
    expect(await screen.findByText('This file is not in the project, its worktrees or its branches.')).toBeInTheDocument();
    unmount();
    vi.spyOn(api, 'endlessDoc').mockRejectedValueOnce(new Error('GET /api/endless/doc failed: 403'));
    render(<DocViewer />);
    expect(await screen.findByText('This path is outside the project.')).toBeInTheDocument();
  });
  it('a link inside the doc opens the next doc, and Back returns', async () => {
    vi.spyOn(api, 'endlessDoc').mockResolvedValue(copy() as any);
    render(<DocViewer />);
    fireEvent.click(await screen.findByRole('button', { name: 'y.md' }));
    expect(useDocViewer.getState().open?.path).toBe('docs/specs/y.md');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(useDocViewer.getState().open?.path).toBe('docs/specs/x.md'));
  });
});
```
(Match the error text the API client throws: read `req` in `api/client.ts` and use its real message format, for example `GET /api/endless/doc?... failed: 404`.)

Add to `ProjectsPanel.test.tsx`:

```tsx
describe('Docs fold', () => {
  const docRow = (k: number) => ({ path: `docs/specs/d${k}.md`, name: `d${k}.md`, status: 'draft', source: 'worktree', worktree: 'chat-visibility-spec', branch: 'spec/chat-thread-visibility', vsMain: 'not_on_main', modifiedAt: '2026-10-19T11:00:00Z', copies: 1, writer: { id: 't1', label: 'Plan' } });
  it('is hidden at a count of 0', () => {
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 0 } } as any);
    render(<ProjectsPanel />);
    expect(screen.queryByRole('button', { name: /^Docs/ })).not.toBeInTheDocument();
  });
  it('closed by default; opens once; at most 5 rows; +N more opens the project in Threads', async () => {
    const spy = vi.spyOn(api, 'endlessDocs').mockResolvedValue({ rows: [0, 1, 2, 3, 4].map(docRow), total: 7 } as any);
    const ask = vi.spyOn(useUI.getState(), 'requestOpenProject');
    useEndless.setState({ projects: [P('s1', 'dispatch', { live: 1 })], threads: [row('w', 's1', 'working')] as any, docCounts: { s1: 7 } } as any);
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs (7)' }));
    expect(await screen.findAllByTestId(/^doc-row-/)).toHaveLength(5);
    expect(screen.getAllByText('worktree chat-visibility-spec')[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(ask).toHaveBeenCalledWith('s1');
    fireEvent.click(screen.getByRole('button', { name: 'Docs (7)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs (7)' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```
(Import `useUI`. The `+2 more` of the Docs fold and the `+N more` of the thread rows have different numbers in this test, so the names do not clash.)

`stores/ui.test.ts`:

```ts
import { it, expect } from 'vitest';
import { useUI } from './ui';
it('requestOpenProject sets and clears the intent', () => {
  useUI.getState().requestOpenProject('s1');
  expect(useUI.getState().pendingOpenProject).toBe('s1');
  useUI.getState().clearOpenProject();
  expect(useUI.getState().pendingOpenProject).toBeNull();
});
```

- [ ] **Step 2: Run the three files and see them fail.**

- [ ] **Step 3: Implement**

`stores/ui.ts`: add `pendingOpenProject: null`, `requestOpenProject: (id) => set({ pendingOpenProject: id })`, `clearOpenProject: () => set({ pendingOpenProject: null })` next to the open-thread intent.

`App.tsx` (desktop), next to the `pendingThread` effect:

```ts
  const pendingProject = useUI((s) => s.pendingOpenProject);
  useEffect(() => {
    if (!pendingProject || isMobile) return;
    useUI.getState().clearOpenProject();
    useProjects.getState().setActive(pendingProject);
    useUI.getState().setView('workspace'); // the "Threads" view
  }, [pendingProject, isMobile]);
```

`MobileApp.tsx`, next to its `pendingThread` effect:

```ts
  const pendingProject = useUI((s) => s.pendingOpenProject);
  useEffect(() => {
    if (!pendingProject) return;
    useUI.getState().clearOpenProject();
    setBottomTab('projects');
    openProject(pendingProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProject]);
```

`stores/settings.ts`: add `editor` with its setter and persist it the same way as the other settings in that file (read how `accent` is saved and loaded, and do the same).

`MemoryInspector.tsx`: under the Chat instructions textarea, add a labelled `<select aria-label="Open docs in">` with options `None` (`''`), `VS Code` (`vscode`), `Cursor` (`cursor`), `Zed` (`zed`), bound to `useSettings` `editor`.

`stores/endless.ts`: add `docCounts: {}` and `loadDocCounts(ids)` (`api.endlessDocCounts(ids)` → `set({ docCounts: r.counts })`, errors ignored). Call it from `watch()` (first watcher) and from the 60 s timer, with the ids of the projects the pane shows (all `projects` with any activity; the pane rule). Do not call it from `applyEvent`.

`DocViewer.tsx`:

```tsx
const EDITOR_URL: Record<string, (abs: string) => string> = {
  vscode: (p) => `vscode://file${encodeURI(p)}`,
  cursor: (p) => `cursor://file${encodeURI(p)}`,
  zed: (p) => `zed://file${encodeURI(p)}`,
};
const statusOf = (e: unknown) => Number(/failed: (\d{3})/.exec(e instanceof Error ? e.message : '')?.[1] ?? 0);
export const LOCATION = (d: { source: string; worktree: string | null; branch: string | null }) =>
  d.source === 'main' ? 'main' : d.source === 'worktree' ? `worktree ${d.worktree}${d.branch ? ` on ${d.branch}` : ''}` : `branch ${d.branch}, as of the last fetch`;
const VS: Record<string, string | null> = { same: 'on main', changed: 'changed here', not_on_main: 'not on main', unknown: null };
```
The component reads `useDocViewer().open`; when it is null it renders nothing. On each `open` change it calls `api.endlessDoc(open.project, open.path, open.branch)` and shows: loading; the error states (404 → "This file is not in the project, its worktrees or its branches."; 403 → "This path is outside the project."; 413 → "This file is larger than 2 MB, so it does not open here."); or the doc. It renders inside `common/Modal` with `sheet={isMobile}` and `title` = the file name. Header row: Back (only when `back.length`, `aria-label="Back"`), the location chip (`LOCATION(doc)`), the `VS[doc.vsMain]` chip when not null, the status line, the modified time (`formatStart` from `ProjectsPanel`), and the note. Actions: `Reveal in Finder` when `useHost().canReveal && doc.absPath` (calls the reveal client call with `doc.absPath` made relative to the project folder from `useEndless.projects`); `Open in editor` when also `useSettings().editor` is set (`window.location.href = EDITOR_URL[editor](doc.absPath)`); `Copy path` always (`navigator.clipboard.writeText(doc.absPath ?? `${doc.branch}:${doc.path}`)`); `Open the thread that wrote it` is shown by the Docs list rows only (the copy has no writer field), so the viewer does not need it. The body is `<Markdown source={doc.markdown} docs={{ onOpen: (p, b) => useDocViewer.getState().push({ project: projectForPath(p, open.project, projects) ?? open.project, path: p, branch: b }) }} />`.

Mount `<DocViewer />` once in `ChatMode.tsx`.

`DocsFold.tsx`: props `{ projectId: string; count: number; onNavigate?: () => void }`. Renders nothing when `count === 0`. A toggle button `Docs (${count})`, closed by default. On first open it calls `api.endlessDocs(projectId)` once (keep the result in component state; a later open reuses it). Rows (`data-testid={`doc-row-${row.path}`}`), as `PaneStates.dc.html` S8: the file name (wraps: `overflowWrap: 'anywhere'`), the status line, the short location chip (`row.source === 'worktree' ? `worktree ${row.worktree}` : `branch ${row.branch}``, `title` = the full form with the branch, `white-space: normal`), the vs-main chip (`changed here` or `not on main`), the time, `+${row.copies - 1} copy` when more than 1, and the writer as its own small button that calls `onNavigate?.()` and `openThreadInPlace(projectId, row.writer.id)`. A row tap calls `onNavigate?.()` and `useDocViewer.getState().show({ project: projectId, path: row.path, branch: row.branch })`. When `total > rows.length`, a `+${total - rows.length} more` button calls `onNavigate?.()` and `useUI.getState().requestOpenProject(projectId)`. States: loading text while the call runs.

`ProjectsPanel.tsx`: in each project block, after the threads, render `<DocsFold projectId={p.id} count={docCounts[p.id] ?? 0} onNavigate={onNavigate} />`.

- [ ] **Step 4: Run the three files again**, then `ChatMode.test.tsx` and `src/components/endless/MemoryInspector.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api packages/web/src/stores/ui.ts packages/web/src/stores/ui.test.ts packages/web/src/stores/settings.ts packages/web/src/stores/endless.ts packages/web/src/components/endless/DocViewer.tsx packages/web/src/components/endless/DocViewer.test.tsx packages/web/src/components/endless/DocsFold.tsx packages/web/src/components/endless/ProjectsPanel.tsx packages/web/src/components/endless/ProjectsPanel.test.tsx packages/web/src/components/endless/ChatMode.tsx packages/web/src/components/endless/MemoryInspector.tsx packages/web/src/App.tsx packages/web/src/components/mobile/MobileApp.tsx
git commit -m "feat(web): doc viewer, in-progress Docs list, and Open in Threads for a project"
```

### Task 12: Verify everything, then the draft PR

- [ ] **Step 1:** Core full suite (one run): from `packages/core`, `node node_modules/vitest/vitest.mjs run > /tmp/ctv-core-2.log 2>&1; echo exit $?`. Read the log; record the counts.
- [ ] **Step 2:** After it ends, the web full suite: from `packages/web`, `node node_modules/vitest/vitest.mjs run > /tmp/ctv-web-2.log 2>&1; echo exit $?`. Record the counts.
- [ ] **Step 3:** `pnpm -C packages/core exec tsc --noEmit` and `pnpm -C packages/web run build`, each to a log. Expected: exit 0.
- [ ] **Step 4:** `/verify` with a fake project that has a main checkout, a `.worktrees/` worktree with a new spec, and a spec branch with no worktree. A Chat report that names each copy opens the right one; Reveal in Finder works in a local browser; at 393 px the Docs list, the doc viewer sheet and Copy path work and Reveal is hidden.
- [ ] **Step 5:** Scan the branch diff and commit messages for real names (`git diff origin/main --stat`, then search the diff and `git log origin/main..` for person, company and project names). Expected: none.
- [ ] **Step 6:** Push the branch and open a DRAFT PR to `main`. The body lists the decisions (spec "Decisions" section), the test counts, what `/verify` covered, and what was not tested (iPhone Safari as an installed web app, real Finder reveal from Safari on the Mac if not covered). Do not merge, release or deploy.
