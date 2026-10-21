# Endless Chat — Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Chat start and steer Dispatch threads in any project, and make a thread that Chat started report its final output into the endless log exactly once, where the report starts (or joins) a Chat turn.

**Architecture:** The memory MCP server gets the thread tools (`spawn_agent`, `message_thread`, `read_agent`) and a Chat subset of the ledger tools. They reuse the agency server's HTTP logic through a new shared module `overseer/agency-shared.ts`, and take an explicit `project` (name or id) that the daemon resolves against the sessions table. A Chat thread carries `config.origin = 'endless'`. Each time Chat sends it work, the daemon "arms" one report (a row in `endless_pending_reports`). The existing `StatusService` settled edge (`addThreadSettledListener`), plus the `onWatchStatus` error edge, makes `EndlessService` log one `work` message; the claim (row delete) and the log append share one SQLite transaction, so a report is logged once, also across a restart. The logged report goes to `TurnRunner.deliver()`, which starts a turn when Chat is idle, or hands the report to the running or starting turn.

**Tech Stack:** Node 22 + TypeScript (ESM, explicit `.js` imports), better-sqlite3, Express, vitest + supertest (core); React 18 + zustand, vitest + Testing Library (web); Claude Code CLI.

**Spec:** docs/superpowers/specs/2026-10-13-endless-chat-design.md (section 1 "Build stages", section 6 item 4, Appendix A). Stage 1 plan: docs/superpowers/plans/2026-10-13-endless-chat-stage1.md.

## Global Constraints

- Core imports use explicit `.js` extensions (`tests/esm-import-extensions.test.ts` guards it; the build passes without them, but the daemon does not start).
- Never point a test or verify daemon at the real `~/.dispatch`: use `HOME=<fake> PORT=3999 node packages/core/dist/server.js` (project skill `verify`). From this worktree, also pass `DISPATCH_WEB_DIST=<worktree>/packages/web/dist`.
- Run core tests from `packages/core` and web tests from `packages/web` (`npx vitest run <file>`). Running vitest from the repo root breaks the web jsdom config.
- Must run unchanged under WSL2: only POSIX paths built from `os.homedir()` / `os.tmpdir()` + `path.join`. Do not use macOS-only commands (`open`, `pbcopy`, `launchctl`) or flags in code, and do not hardcode `/Users/...`.
- Git safety: never `git stash`, `git reset`, `git checkout <branch>`, or `git switch`. Other sessions share this checkout. Stage only the paths each task lists. Commit at the end of every task.
- The cache rule: tool definitions and the system prompt are fixed text. Do not put dates, counts, project names, ids, or any other state in them. Adding the stage-2 tools changes the cached prefix once, and that is accepted.
- The thread tools never read `DISPATCH_SESSION`. Each tool that needs a project takes an explicit `project` argument (a name or an id).
- The log is append-only (stage 1 triggers). The new `endless_pending_reports` table is the only stage-2 table, and only `store.ts` touches it.
- A report is ONE `work` message: `[<thread label>] report: <final output>`, with `project` = the thread's session id and `ref` = the terminal id. The output is clipped head + tail, so that the whole message is at most 30,000 characters (`TOOL_CLIP_CHARS` = `PIECE_CHARS`) and `splitLongText` never splits it.
- Completion detection uses the existing events only: `StatusService.addThreadSettledListener` (the turn-settled edge) and the `onWatchStatus` edge for `error`. Do not add a background scan. The one boot pass over `endless_pending_reports` is recovery (the same pattern as `Compactor.recover()`).
- Spawned threads use the same harness and model defaults as the Control Plane's `spawn_agent` (`GET /api/sessions/:id/overseer/worker-defaults` + `buildWorkerCreateBody`).
- Out of scope: a Stop button, and the open search-jump scroll bug.

## Review Focus

These are the five failures most likely to reach a user that ordinary tests miss. Each one has a pinning test in the task that owns the code.

1. **A duplicate report after a daemon restart.** The report is logged, the daemon restarts, and the boot pass (or a replayed edge) logs it again. Expected: never. A report that was armed but not logged before the restart is logged exactly once at the next start. Pinned in Task 6: `a report logged before a restart is never logged again` and `a report lost to a restart is logged once at the next start, and only once`.
2. **A report races a user send.** The user sends a message, and a report arrives while that turn waits for summaries. Expected: one process. The user message is the turn's message, and the report reaches the same process as a hand-off. The view does not hold the report (no duplicate context). Pinned in Task 4: `a report that arrives while a user turn is starting joins that turn, and the view leaves it out`.
3. **An unknown or ambiguous project name.** Chat calls `spawn_agent` with `project: "salsfy"` or a name that two projects share. Expected: a clear error that names the known projects (or the ids of the two matches), and no thread is created. Pinned in Task 5 (`resolveProject` tests) and Task 8: `spawn_agent with an unknown project creates nothing and returns the daemon's error`.
4. **A thread that dies without output.** The thread's process crashes before it writes a word, so it never settles (the status goes `working` → `error`). Expected: one report `[Label] report: (stopped with an error) (no output)`, and Chat is never left waiting. Pinned in Task 6: `an armed thread that fails with no output reports that it stopped`.
5. **Two reports at once.** Two Chat threads finish in the same moment. Expected: one `claude` process, both reports logged in order, the first as the turn's message and the second as a hand-off. Pinned in Task 4: `two reports at once start one process; the second is handed off`, and in Task 6: `two threads that finish together make two reports and one turn`.

## File Structure

Core (`packages/core`):

| File | Action | Responsibility |
|---|---|---|
| `src/overseer/agency-shared.ts` | Create | The agency tools' shared parts: `httpJson`, `resolveWorkerDefaults`, `createWorker`, `sendTask`, `readAgentOutput`, the agent and harness lists, and the fixed schema texts (`HARNESS_ARG_DESCRIPTION`, `TITLE_RULES`, `CARD_FIELDS_SCHEMA`). Every function takes the API base and the session id as arguments. |
| `src/overseer/agency-mcp.ts` | Modify | Import the moved parts. `spawn_agent` uses `createWorker` + `sendTask`, and `read_agent` uses `readAgentOutput`. There is no behavior change. |
| `src/overseer/worker-payload.ts` | Modify | `buildWorkerCreateBody` takes an optional `origin: 'endless'` and writes `config.origin`. |
| `src/sessions/service.ts` | Modify | A thread with `config.origin === 'endless'` never notifies the project's Control Plane, and its owner-decisions block is not captured. New public `finalOutput(terminalId)`. |
| `src/db/schema.ts` | Modify | Migration `009-endless-pending-reports`. |
| `src/endless/store.ts` | Modify | `armReport`, `hasPendingReport`, `claimReport`, `pendingReports`. |
| `src/endless/log.ts` | Modify | `appendLogged(t, input, opts)` with `opts.claim`, which runs first inside the transaction. |
| `src/endless/view-keeper.ts` | Modify | `turnBlocks(before?)` renders only the lines that start before message `before`. |
| `src/endless/turn-runner.ts` | Modify | `LoggedInput`, `deliver()`. Reports start a turn, join a starting turn, or are handed off. They are never logged again. |
| `src/endless/projects.ts` | Create | `resolveProject` (name or id → project, or a clear error) and `overseerOf` (the project's Control Plane terminal). |
| `src/endless/reports.ts` | Create | `reportText`, `threadOrigin`, `recoveryOutcome` (pure). |
| `src/endless/service.ts` | Modify | `project()`, `arm()`, `onThreadSettled()`, `reportThread()`, boot recovery, `ledger()`; the new options `finalOutput` and `ledger`; `log()` passes `LogOptions`. |
| `src/routes/endless.ts` | Modify | `GET /project`, `POST /arm`, `POST /ledger/:action`. |
| `src/endless/memory-mcp.ts` | Modify | The new tools `spawn_agent`, `message_thread`, `read_agent`, `ledger_list`, `ledger_show`, `ledger_add`, `ledger_resolve`, `ledger_set_title`; `requestJson`. |
| `src/endless/prompt.ts` | Modify | One fixed paragraph that names the thread tools. |
| `src/server.ts` | Modify | Build one `LedgerService` before Endless; pass `finalOutput` and `ledger`; connect the settled listener and the error edge. |
| `tests/overseer/agency-shared.test.ts` | Create | `createWorker` / `sendTask` / `readAgentOutput` against a fetch mock. |
| `src/overseer/worker-payload.test.ts` | Modify | The `origin` field. |
| `tests/sessions/endless-origin-notice.test.ts` | Create | No Control Plane notices for Chat threads; `finalOutput`. |
| `tests/endless/store.test.ts`, `tests/endless/log.test.ts` (create), `tests/endless/view-keeper.test.ts` | Modify / Create | The pending-report rows, the claim, `turnBlocks(before)`. |
| `tests/endless/turn-runner.test.ts` | Modify | `deliver()` cases. |
| `tests/endless/projects.test.ts`, `tests/endless/reports.test.ts`, `tests/endless/ledger.test.ts` | Create | Project resolution; reports end to end in the service; the Chat ledger. |
| `tests/routes/endless.test.ts` | Modify | `/project`, `/arm`, `/ledger/:action`. |
| `tests/endless/memory-mcp.test.ts` | Modify | The tool list and the new tools. |
| `tests/endless/prompt.test.ts` | Unchanged | It already checks that the prompt equals Appendix A verbatim. |

Web (`packages/web/src`):

| File | Action | Responsibility |
|---|---|---|
| `stores/endless.ts` | Modify | A broadcast `work` message reloads the projects (the panel's "last report" updates at once). |
| `stores/endless.test.ts` | Modify | The test for that reload. |
| `components/endless/EndlessColumn.test.tsx` | Modify | A work card click requests its thread (`sessionId` = project, `terminalId` = ref) and switches to the workspace. |

Docs:

| File | Action | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-10-13-endless-chat-design.md` | Modify | Appendix A gets the same new paragraph as `prompt.ts` (the prompt test compares them). |

---

## Task 1: Shared agency helpers and the origin marker

The Control Plane's spawn and read logic moves into `overseer/agency-shared.ts`, so the memory MCP server can call it for any project. `buildWorkerCreateBody` learns `origin`. The agency server's behavior does not change: its existing tests guard that.

**Files:**
- Create: `packages/core/src/overseer/agency-shared.ts`
- Modify: `packages/core/src/overseer/agency-mcp.ts` (the constants at lines 39–134, `httpJson` at 669–684, `resolveWorkerDefaults` at 694–699, `spawnAgent` at 701–723, `queueAgent` at 732–753, `readAgent` at 831–840)
- Modify: `packages/core/src/overseer/worker-payload.ts`
- Test: `packages/core/tests/overseer/agency-shared.test.ts`, `packages/core/src/overseer/worker-payload.test.ts`

**Interfaces:**
- Consumes: `buildWorkerCreateBody` (worker-payload.ts).
- Produces:
  - `export const AGENT_TYPES: readonly ['planner','implementer','researcher','reviewer','design-reviewer','code-reviewer']`, `export type AgentType = (typeof AGENT_TYPES)[number]`, `export const HARNESSES: readonly ['claude-code','codex','grok','opencode']`
  - `export const HARNESS_ARG_DESCRIPTION: string`, `export const TITLE_RULES: string`, `export const CARD_FIELDS_SCHEMA` (moved verbatim)
  - `export async function httpJson(method: string, url: string, body?: unknown): Promise<any>`
  - `export async function resolveWorkerDefaults(api: string, sessionId: string, agentType: AgentType, harness: string): Promise<{ harness: string; model?: string }>`
  - `export interface WorkerSpec { agentType: AgentType; label: string; mission: string; model: string; harness: string; spawnDepth: number; origin?: 'endless' }`
  - `export async function createWorker(api: string, sessionId: string, spec: WorkerSpec): Promise<string>` (the new terminal id; the task is NOT sent)
  - `export async function sendTask(api: string, terminalId: string, text: string): Promise<void>`
  - `export async function readAgentOutput(api: string, agentId: string): Promise<{ agentId: string; status: string | null; output: string; tools: string[] }>`
  - `buildWorkerCreateBody(input: { …existing fields…; origin?: 'endless' })`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/overseer/worker-payload.test.ts`, inside `describe('buildWorkerCreateBody', …)`:

```ts
  it('origin endless marks a thread Chat started; no origin keeps the wire shape', () => {
    expect(buildWorkerCreateBody({ agentType: 'researcher', label: 'r', resolved: { harness: 'claude-code' }, spawnDepth: 1, origin: 'endless' }).config)
      .toEqual({ transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1, origin: 'endless' });
    expect(buildWorkerCreateBody({ agentType: 'researcher', label: 'r', resolved: { harness: 'claude-code' }, spawnDepth: 1 }).config)
      .not.toHaveProperty('origin');
  });
```

Create `packages/core/tests/overseer/agency-shared.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWorker, sendTask, readAgentOutput, AGENT_TYPES, HARNESSES } from '../../src/overseer/agency-shared.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const origSession = process.env.DISPATCH_SESSION;
afterEach(() => {
  vi.unstubAllGlobals();
  if (origSession === undefined) delete process.env.DISPATCH_SESSION; else process.env.DISPATCH_SESSION = origSession;
});

describe('agency-shared', () => {
  it('createWorker resolves the defaults and creates the thread in the given project, never DISPATCH_SESSION', async () => {
    process.env.DISPATCH_SESSION = 'other-project';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', model: 'sonnet', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9' }));
    vi.stubGlobal('fetch', fetchMock);
    const id = await createWorker('http://d', 's9', { agentType: 'implementer', label: 'Fix login', mission: '', model: '', harness: '', spawnDepth: 1, origin: 'endless' });
    expect(id).toBe('t9');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://d/api/sessions/s9/overseer/worker-defaults?agentType=implementer');
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://d/api/sessions/s9/terminals');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      type: 'claude-code', label: 'Fix login',
      config: { transport: 'structured', agentType: 'implementer', role: 'agent', model: 'sonnet', spawnDepth: 1, origin: 'endless' },
    });
  });

  it('createWorker refuses an unavailable harness before it creates anything', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { harness: 'codex', available: false, reason: 'codex is not signed in' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createWorker('http://d', 's9', { agentType: 'researcher', label: 'r', mission: '', model: '', harness: 'codex', spawnDepth: 1 }))
      .rejects.toThrow('codex is not signed in');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendTask posts the task as a coordinator message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendTask('http://d', 't9', 'do it');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://d/api/terminals/t9/message');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ text: 'do it', source: 'coordinator' });
  });

  it('readAgentOutput joins the assistant text and reads the status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, { items: [{ kind: 'assistant', text: 'one' }, { kind: 'tool', toolName: 'Read' }, { kind: 'assistant', text: 'two' }] }))
      .mockResolvedValueOnce(json(200, { status: 'waiting' })));
    expect(await readAgentOutput('http://d', 't9')).toEqual({ agentId: 't9', status: 'waiting', output: 'one\n\ntwo', tools: ['Read'] });
  });

  it('lists the agent types and harnesses the schemas use', () => {
    expect(AGENT_TYPES).toEqual(['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer']);
    expect(HARNESSES).toEqual(['claude-code', 'codex', 'grok', 'opencode']);
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/overseer/agency-shared.test.ts src/overseer/worker-payload.test.ts`
Expected: FAIL. The output shows "Failed to load url ../../src/overseer/agency-shared.js", and the origin test fails on `config.origin`.

- [ ] **Step 3: Add `origin` to `buildWorkerCreateBody`**

In `packages/core/src/overseer/worker-payload.ts`, add `origin?: 'endless';` to the input type after `task?: string;`. Then add the field as the last key of `config`:

```ts
      spawnDepth: input.spawnDepth,
      ...(input.origin ? { origin: input.origin } : {}),
```

- [ ] **Step 4: Create `agency-shared.ts`**

Create `packages/core/src/overseer/agency-shared.ts`. Move `HARNESS_ARG_DESCRIPTION`, `TITLE_RULES` and `CARD_FIELDS_SCHEMA` here from `agency-mcp.ts` word for word (cut, then paste, with `export` added). Also move `httpJson` word for word with `export` added:

```ts
/**
 * The agency tools' shared parts, used by the Control Plane's agency MCP server
 * (overseer/agency-mcp.ts) and the Endless Chat memory MCP server (endless/memory-mcp.ts):
 * the HTTP helper, worker creation, the output read, and the fixed schema texts. Every
 * function takes the daemon base URL and, where a project is needed, its session id as
 * arguments. Nothing here reads DISPATCH_SESSION.
 */
import { buildWorkerCreateBody } from './worker-payload.js';

export const AGENT_TYPES = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
export const HARNESSES = ['claude-code', 'codex', 'grok', 'opencode'] as const;

// export const HARNESS_ARG_DESCRIPTION = …   (moved from agency-mcp.ts, unchanged text)
// export const TITLE_RULES = …               (moved from agency-mcp.ts, unchanged text)
// export const CARD_FIELDS_SCHEMA = … as const; (moved from agency-mcp.ts, unchanged text)
// export async function httpJson(…)          (moved from agency-mcp.ts, unchanged body)

/**
 * Resolve harness/model through the daemon's single tested place (matrix + session default +
 * availability guard): GET .../overseer/worker-defaults. An explicit `harness` goes THROUGH the
 * endpoint as `?harness=`, so the availability guard always runs.
 */
export async function resolveWorkerDefaults(api: string, sessionId: string, agentType: AgentType, harness: string): Promise<{ harness: string; model?: string }> {
  const url = `${api}/api/sessions/${sessionId}/overseer/worker-defaults?agentType=${encodeURIComponent(agentType)}${harness ? `&harness=${encodeURIComponent(harness)}` : ''}`;
  const defaults = await httpJson('GET', url) as { harness: string; model?: string; available: boolean; reason?: string };
  if (!defaults.available) throw new Error(defaults.reason || `${defaults.harness} is not available on this server`);
  return { harness: defaults.harness, model: defaults.model };
}

export interface WorkerSpec { agentType: AgentType; label: string; mission: string; model: string; harness: string; spawnDepth: number; origin?: 'endless' }

/** Create a worker thread in project `sessionId` and return its id. The caller sends the task. */
export async function createWorker(api: string, sessionId: string, spec: WorkerSpec): Promise<string> {
  const resolved = await resolveWorkerDefaults(api, sessionId, spec.agentType, spec.harness);
  const terminal = await httpJson('POST', `${api}/api/sessions/${sessionId}/terminals`,
    buildWorkerCreateBody({ agentType: spec.agentType, label: spec.label, resolved, explicitModel: spec.model, mission: spec.mission, spawnDepth: spec.spawnDepth, origin: spec.origin }));
  const agentId: string | undefined = terminal?.id;
  if (!agentId) throw new Error('spawn did not return a terminal id');
  return agentId;
}

/** Seed or steer a thread: the message route takes it on either transport. */
export async function sendTask(api: string, terminalId: string, text: string): Promise<void> {
  await httpJson('POST', `${api}/api/terminals/${terminalId}/message`, { text, source: 'coordinator' });
}

/** An agent's assistant output, the tools it ran (last 30) and its status. */
export async function readAgentOutput(api: string, agentId: string): Promise<{ agentId: string; status: string | null; output: string; tools: string[] }> {
  const conv = await httpJson('GET', `${api}/api/terminals/${agentId}/conversation?limit=500`);
  const items: any[] = Array.isArray(conv?.items) ? conv.items : [];
  const output = items.filter((it) => it?.kind === 'assistant' && it.text).map((it) => it.text).join('\n\n').trim();
  const tools = items.filter((it) => it?.kind === 'tool' && it.toolName).map((it) => it.toolName as string);
  let status: string | null = null;
  try { const t = await httpJson('GET', `${api}/api/terminals/${agentId}`); status = t?.status ?? null; } catch { /* ignore */ }
  return { agentId, status, output: output || '(no assistant output captured yet)', tools: tools.slice(-30) };
}
```

Replace the four `//` comment lines with the moved code. Do not change the moved text.

- [ ] **Step 5: Point `agency-mcp.ts` at the shared module**

In `packages/core/src/overseer/agency-mcp.ts`:

1. Replace `export type AgentType = 'planner' | … ;` with:
   ```ts
   import {
     httpJson, resolveWorkerDefaults, createWorker, sendTask, readAgentOutput,
     HARNESS_ARG_DESCRIPTION, TITLE_RULES, CARD_FIELDS_SCHEMA, type AgentType,
   } from './agency-shared.js';
   export type { AgentType };
   ```
   Put the `import` with the other imports at the top of the file. Keep the `export type` line where the old type was.
2. Delete the moved definitions: `HARNESS_ARG_DESCRIPTION`, `TITLE_RULES`, `CARD_FIELDS_SCHEMA`, `httpJson`, and the local `resolveWorkerDefaults`.
3. Replace the body of `spawnAgent` from `const resolved = await resolveWorkerDefaults(…)` to the end with:
   ```ts
   const agentId = await createWorker(apiBase(), sessionId(), { agentType: args.agentType, label, mission, model, harness, spawnDepth: childDepth });
   await sendTask(apiBase(), agentId, task);
   return { agentId, label, ...(mission ? { mission } : {}) };
   ```
4. In `queueAgent`, change `await resolveWorkerDefaults(args.agentType, harness)` to `await resolveWorkerDefaults(apiBase(), sessionId(), args.agentType, harness)`.
5. Replace the body of `readAgent` after its `agentId is required` check with `return readAgentOutput(apiBase(), args.agentId);`.

- [ ] **Step 6: Run the tests to verify that they pass, including the agency suites**

Run (from `packages/core`): `npx vitest run tests/overseer/agency-shared.test.ts src/overseer/worker-payload.test.ts tests/overseer/agency-mcp.test.ts tests/overseer/agency-mcp-ledger.test.ts tests/esm-import-extensions.test.ts`
Expected: PASS. The agency tests pass unchanged, which shows that the refactor kept the wire shape and the tool text.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/overseer/agency-shared.ts packages/core/src/overseer/agency-mcp.ts packages/core/src/overseer/worker-payload.ts packages/core/src/overseer/worker-payload.test.ts packages/core/tests/overseer/agency-shared.test.ts
git commit -m "refactor(agency): share worker creation and reads; add the endless origin marker"
```

---

## Task 2: Chat threads stay out of the Control Plane; `finalOutput`

A Chat thread is a `role: 'agent'` thread. Without a guard, its completion, questions and the user's direct messages would wake the project's Control Plane, which did not start it. This task applies the same rule as a scheduled role run (`config.roleRun`). It also adds the public text read that reports use.

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (`notifyCoordinatorOfAgent` at ~1129; `noteAgentCompletion` at ~1384; new `finalOutput` next to `lastTurnTexts` at ~1426)
- Test: `packages/core/tests/sessions/endless-origin-notice.test.ts`

**Interfaces:**
- Consumes: `config.origin === 'endless'` (Task 1).
- Produces: `SessionService.finalOutput(terminalId: string): string`. This is the texts of the thread's last turn in order (oldest first), joined with blank lines and trimmed, or `''`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/sessions/endless-origin-notice.test.ts`:

```ts
// Endless Chat stage 2: a thread Chat started (config.origin 'endless') reports to Chat, never to
// the project's Control Plane, exactly like a scheduled role run.
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-endless-origin-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'chat', sessionId: 's1', type: 'claude-code', label: 'Fix login', config: { role: 'agent', agentType: 'implementer', origin: 'endless', spawnDepth: 1 } });
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  const revived = vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  return { svc, sent, revived };
}

const QUESTION = { toolName: 'AskUserQuestion', questions: [{ header: 'Fix', question: 'Which file?', options: ['a', 'b'] }] };

describe('a thread Chat started never reaches the Control Plane', () => {
  it('no notice on completion, on a question, on a stop, or on a direct message', () => {
    const { svc, sent, revived } = makeService();
    svc.noteAgentCompletion('chat');
    svc.noteAgentNeedsHelp('chat', 'which file?');
    expect(svc.routeAgentQuestionToCoordinator('chat', QUESTION)).toBe(false);
    svc.noteAgentLifecycle('chat', 'stopped');
    svc.noteUserMessageToAgent('chat', 'use b');
    expect(sent).not.toHaveBeenCalled();
    expect(revived).not.toHaveBeenCalled();
  });

  it('does not capture its owner-decisions block into the ledger', () => {
    const { svc } = makeService();
    const capture = vi.spyOn(svc as any, 'captureOwnerDecisions');
    svc.noteAgentCompletion('chat');
    expect(capture).not.toHaveBeenCalled();
  });

  it('finalOutput gives the last turn texts in order, or an empty string', () => {
    const { svc } = makeService();
    expect(svc.finalOutput('chat')).toBe('');
    vi.spyOn(svc as any, 'lastTurnTexts').mockReturnValue(['Done: login fixed.', 'Report: the cookie path was wrong.']);
    expect(svc.finalOutput('chat')).toBe('Report: the cookie path was wrong.\n\nDone: login fixed.');
  });
});
```

(`lastTurnTexts` returns the newest text first. So the mocked list reads newest, then older, and `finalOutput` reverses it.)

- [ ] **Step 2: Run the test to verify that it fails**

Run (from `packages/core`): `npx vitest run tests/sessions/endless-origin-notice.test.ts`
Expected: FAIL. The first test sees `sent` called with `'coord'`, and `svc.finalOutput is not a function`.

- [ ] **Step 3: Implement the guards and `finalOutput`**

In `notifyCoordinatorOfAgent`, directly after the `roleRun` check (`if (typeof cfg.roleRun === 'string' && cfg.roleRun) return false;`), add:

```ts
    // A thread Chat started reports to Chat (Endless Chat stage 2), never to the project's Control Plane.
    if (cfg.origin === 'endless') return false;
```

In `noteAgentCompletion`, change:

```ts
    const decisions = isRoleRun ? [] : this.captureOwnerDecisions(agent, mission);
```

to:

```ts
    // A Chat thread's report goes to Chat whole; no overseer triages proposed items for it.
    const decisions = isRoleRun || cfg.origin === 'endless' ? [] : this.captureOwnerDecisions(agent, mission);
```

Add after `lastTurnTexts`:

```ts
  /**
   * A thread's final output for its Endless Chat report: the texts of its last turn in order,
   * in full, joined by blank lines. '' when it wrote none.
   */
  finalOutput(terminalId: string): string {
    return [...this.lastTurnTexts(terminalId)].reverse().join('\n\n').trim();
  }
```

- [ ] **Step 4: Run the tests to verify that they pass**

Run (from `packages/core`): `npx vitest run tests/sessions/endless-origin-notice.test.ts tests/sessions/role-run-coordinator-notice.test.ts tests/sessions/owner-decisions-notice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/tests/sessions/endless-origin-notice.test.ts
git commit -m "feat(endless): Chat threads never notify the Control Plane; add finalOutput"
```

---

## Task 3: Pending reports, the claimed log append, and the cut view

**Files:**
- Modify: `packages/core/src/db/schema.ts` (after migration `008-endless-chat`)
- Modify: `packages/core/src/endless/store.ts`, `packages/core/src/endless/log.ts`, `packages/core/src/endless/view-keeper.ts`
- Test: `packages/core/tests/endless/store.test.ts`, `packages/core/tests/endless/log.test.ts` (create), `packages/core/tests/endless/view-keeper.test.ts`

**Interfaces:**
- Produces:
  - `EndlessStore.armReport(terminalId: string, at?: number): void`, `hasPendingReport(terminalId: string): boolean`, `claimReport(terminalId: string): boolean`, `pendingReports(): string[]`
  - `export interface LogOptions { claim?: () => boolean }`; `appendLogged(t, input: LogInput, opts?: LogOptions): EndlessMessage[]`. A `claim` that returns false logs nothing and returns `[]`.
  - `ViewKeeper.turnBlocks(before?: number): string[]`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/tests/endless/store.test.ts`, inside `describe('EndlessStore', …)`:

```ts
  it('arms, claims once, and lists pending reports', () => {
    store.armReport('t1', 10);
    store.armReport('t2', 5);
    store.armReport('t1', 20); // re-arming keeps one row
    expect(store.pendingReports()).toEqual(['t2', 't1']);
    expect(store.hasPendingReport('t1')).toBe(true);
    expect(store.claimReport('t1')).toBe(true);
    expect(store.claimReport('t1')).toBe(false);
    expect(store.hasPendingReport('t1')).toBe(false);
    expect(store.pendingReports()).toEqual(['t2']);
  });

  it('pending reports survive a restart', () => {
    store.armReport('t1', 1);
    expect(new EndlessStore(db).pendingReports()).toEqual(['t1']);
  });
```

Create `packages/core/tests/endless/log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessStore } from '../../src/endless/store.js';
import { ViewKeeper } from '../../src/endless/view-keeper.js';
import { Compactor } from '../../src/endless/compactor.js';
import { appendLogged } from '../../src/endless/log.js';
import { FakeSummarizer } from './fake-summarizer.js';

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  const store = new EndlessStore(db);
  const views = new ViewKeeper(store);
  const compactor = new Compactor({ store, views, summarizer: new FakeSummarizer(), systemPrompt: () => 'SYS', projectName: () => null });
  return { store, views, compactor };
}

describe('appendLogged with a claim', () => {
  it('logs when the claim succeeds, and only once', () => {
    const t = setup();
    t.store.armReport('t1', 1);
    const claim = () => t.store.claimReport('t1');
    expect(appendLogged(t, { kind: 'work', text: '[A] report: ok', ref: 't1' }, { claim })).toHaveLength(1);
    expect(appendLogged(t, { kind: 'work', text: '[A] report: ok', ref: 't1' }, { claim })).toEqual([]);
    expect(t.store.count()).toBe(1);
    expect(t.views.lines()).toHaveLength(1);
  });

  it('a claim and an append that fail together leave the report pending', () => {
    const t = setup();
    t.store.armReport('t1', 1);
    const boom = () => { t.store.claimReport('t1'); throw new Error('disk full'); };
    expect(() => appendLogged(t, { kind: 'work', text: 'x', ref: 't1' }, { claim: boom })).toThrow('disk full');
    expect(t.store.count()).toBe(0);
    expect(t.store.hasPendingReport('t1')).toBe(true); // rolled back with the transaction
  });
});
```

Append to `packages/core/tests/endless/view-keeper.test.ts` (top level):

```ts
describe('turnBlocks(before)', () => {
  it('leaves out the lines from message `before` on', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EndlessStore(db);
    const keeper = new ViewKeeper(store, limits);
    for (const text of ['one', 'two', 'three']) logBuilt(store, keeper, text);
    expect(keeper.turnBlocks().join('')).toContain('2+1|');
    expect(keeper.turnBlocks(2).join('')).not.toContain('2+1|');
    expect(keeper.turnBlocks(2).join('')).toContain('1+1|');
    expect(keeper.turnBlocks(0)).toEqual(['<chat>\n</chat>']);
  });
});
```

(`logBuilt` and `limits` already exist at the top of `view-keeper.test.ts`. `logBuilt` builds each node and calls `keeper.onMessage`.)

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/endless/store.test.ts tests/endless/log.test.ts tests/endless/view-keeper.test.ts`
Expected: FAIL. The output shows `store.armReport is not a function` and `no such table: endless_pending_reports`, and the `turnBlocks(2)` test still contains `2+1|`.

- [ ] **Step 3: Add the migration**

In `packages/core/src/db/schema.ts`, after the `008-endless-chat` call:

```ts
  // Endless Chat stage 2 (spec 2026-10-13, section 6.4): a thread Chat started owes Chat one report
  // each time Chat sends it work. The row is deleted in the same transaction that logs the report,
  // so a report is logged exactly once, also across a restart.
  migrate(db, '009-endless-pending-reports', () => db.exec(`
    CREATE TABLE IF NOT EXISTS endless_pending_reports (
      terminal_id TEXT PRIMARY KEY,
      armed_at    INTEGER NOT NULL
    );
  `));
```

- [ ] **Step 4: Add the store methods**

In `packages/core/src/endless/store.ts`, add these methods to `EndlessStore` (after `setState`):

```ts
  /** A thread Chat sent work to owes Chat one report (stage 2). Re-arming keeps one row. */
  armReport(terminalId: string, at: number = Date.now()): void {
    this.db.prepare('INSERT INTO endless_pending_reports (terminal_id, armed_at) VALUES (?, ?) ON CONFLICT(terminal_id) DO UPDATE SET armed_at = excluded.armed_at')
      .run(terminalId, at);
  }

  hasPendingReport(terminalId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM endless_pending_reports WHERE terminal_id = ?').get(terminalId);
  }

  /** Take the pending report: true once, then false. Call it inside the transaction that logs the report. */
  claimReport(terminalId: string): boolean {
    return this.db.prepare('DELETE FROM endless_pending_reports WHERE terminal_id = ?').run(terminalId).changes === 1;
  }

  pendingReports(): string[] {
    return (this.db.prepare('SELECT terminal_id FROM endless_pending_reports ORDER BY armed_at, terminal_id').all() as { terminal_id: string }[])
      .map((r) => r.terminal_id);
  }
```

- [ ] **Step 5: Add the claim to `appendLogged`**

Replace the body of `packages/core/src/endless/log.ts` from `export interface LogInput` to the end with:

```ts
export interface LogInput { kind: EndlessKind; text: string; project?: string | null; ref?: string | null; media?: string[] }
/** `claim` runs first inside the transaction; false logs nothing (a report already logged). */
export interface LogOptions { claim?: () => boolean }

export function appendLogged(t: { store: EndlessStore; views: ViewKeeper; compactor: Compactor }, input: LogInput, opts: LogOptions = {}): EndlessMessage[] {
  const pieces = splitLongText(input.text);
  const done = t.store.transaction((): { written: EndlessMessage[]; staged: StagedViews } | null => {
    if (opts.claim && !opts.claim()) return null;
    const written = pieces.map((text, k) =>
      t.store.append({ kind: input.kind, text, project: input.project ?? null, ref: input.ref ?? null, media: k === 0 ? input.media ?? [] : [] }));
    return { written, staged: t.views.stage(written.map((m) => m.i)) };
  });
  if (!done) return [];
  t.views.commit(done.staged);
  for (const m of done.written) t.compactor.onMessage(m.i);
  return done.written;
}
```

- [ ] **Step 6: Add `turnBlocks(before)`**

In `packages/core/src/endless/view-keeper.ts`, change the `tree.js` import to `import { firstMessage, lastMessage, nodeName, type Line, type NodeRef } from './tree.js';`. Then replace `turnBlocks()` with:

```ts
  /**
   * The turn view. With `before`, only the lines that start before message `before`: a message
   * that is already logged (a thread report) is the turn's message, not a view line.
   */
  turnBlocks(before?: number): string[] {
    const lines = before === undefined ? this.chat.lines : this.chat.lines.filter(([l, i]) => firstMessage(l, i) < before);
    return renderChatBlocks(lines, this.text);
  }
```

- [ ] **Step 7: Run the tests to verify that they pass**

Run (from `packages/core`): `npx vitest run tests/endless/store.test.ts tests/endless/log.test.ts tests/endless/view-keeper.test.ts tests/endless/turn-runner.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/endless/store.ts packages/core/src/endless/log.ts packages/core/src/endless/view-keeper.ts packages/core/tests/endless/store.test.ts packages/core/tests/endless/log.test.ts packages/core/tests/endless/view-keeper.test.ts
git commit -m "feat(endless): pending report rows, a claimed log append, and a cut turn view"
```

---

## Task 4: The turn runner delivers a logged report

The gist rule: a report starts a turn when Chat is idle. When a turn runs, the report reaches the process between tool calls, the same as a user's mid-turn message. Reports never start a second process, and they are never logged twice.

**Files:**
- Modify: `packages/core/src/endless/turn-runner.ts`
- Test: `packages/core/tests/endless/turn-runner.test.ts`

**Interfaces:**
- Consumes: `ViewKeeper.turnBlocks(before?)` (Task 3).
- Produces:
  - `export interface LoggedInput { i: number; kind: 'work'; text: string; project: string | null }`
  - `TurnRunner.deliver(input: LoggedInput): void`
  - `TurnRunner.send(input: UserInput): void` (unchanged behavior)

- [ ] **Step 1: Write the failing tests**

Append inside `describe('TurnRunner', …)` in `packages/core/tests/endless/turn-runner.test.ts`:

```ts
  it('a report while Chat is idle starts a turn whose message is the report; the view leaves it out', async () => {
    const t = setup();
    t.log({ kind: 'user', text: 'start a thread' });
    await settle();
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', project: 'p1', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: 'p1' });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    const parts = texts(t.fake.sent[0].content);
    expect(parts[0]).toBe('<chat>\n0+1|user: start a thread\n</chat>');
    expect(parts.at(-1)).toBe('work (name-p1): [Fix] report: done');
    expect(t.store.count()).toBe(2); // not logged again
    await finish(t);
  });

  it('a report while a turn runs reaches the process between tool calls and is not logged again', async () => {
    const t = setup();
    t.runner.send({ text: 'go', project: null, media: [] });
    await settle();
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', project: 'p1', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: 'p1' });
    expect(t.fake.spawned).toHaveLength(1);
    expect(texts(t.fake.sent[1].content)).toEqual(['work (name-p1): [Fix] report: done']);
    expect(t.store.count()).toBe(2);
    reply(t, 'noted');
    await finish(t);
  });

  it('two reports at once start one process; the second is handed off', async () => {
    const t = setup();
    const [a] = t.log({ kind: 'work', text: '[A] report: one', ref: 'ta' });
    const [b] = t.log({ kind: 'work', text: '[B] report: two', ref: 'tb' });
    t.runner.deliver({ i: a.i, kind: 'work', text: a.text, project: null });
    t.runner.deliver({ i: b.i, kind: 'work', text: b.text, project: null });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    expect(texts(t.fake.sent[0].content).at(-1)).toBe('work: [A] report: one');
    expect(texts(t.fake.sent[0].content).join('')).not.toContain('[B] report');
    expect(texts(t.fake.sent[1].content)).toEqual(['work: [B] report: two']);
    expect(t.store.count()).toBe(2);
    reply(t, 'both seen');
    await finish(t);
  });

  it('a report that arrives while a user turn is starting joins that turn, and the view leaves it out', async () => {
    const t = setup();
    t.runner.send({ text: 'hello', project: null, media: [] }); // waiting for summaries
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: null });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    const first = texts(t.fake.sent[0].content);
    expect(first.at(-1)).toBe('user: hello');
    expect(first.join('')).not.toContain('[Fix] report');
    expect(texts(t.fake.sent[1].content)).toEqual(['work: [Fix] report: done']);
    expect(userRows(t.store)).toEqual(['hello']);
    expect(t.store.count()).toBe(2);
    reply(t, 'both seen');
    await finish(t);
  });

  it('a report queued behind a turn that fails before its process starts is not logged again', async () => {
    const t = setup({ failLogOn: 'user' });
    t.runner.send({ text: 'hello', project: null, media: [] });
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: null });
    await t.runner.whenIdle();
    expect(t.fake.spawned).toHaveLength(0);
    expect(t.store.count()).toBe(1); // only the report, once
  });
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/endless/turn-runner.test.ts`
Expected: FAIL with `t.runner.deliver is not a function`.

- [ ] **Step 3: Implement `deliver`**

In `packages/core/src/endless/turn-runner.ts`:

Add after `export interface UserInput …`:

```ts
/** A message already in the log that a turn must answer: a thread's report (spec section 6.4). */
export interface LoggedInput { i: number; kind: 'work'; text: string; project: string | null }
type Pending = { logged: false; input: UserInput } | { logged: true; input: LoggedInput };
```

Change the field `private queued: UserInput[] = [];` to `private queued: Pending[] = [];`.

Replace `send`, `retry`, `start`, `content` and `handOff` with:

```ts
  send(input: UserInput): void { this.accept({ logged: false, input }); }

  /**
   * A message the service already logged (a thread report). It starts a turn when Chat is idle,
   * joins a turn that is starting, or reaches the running process between tool calls. It is
   * never logged again.
   */
  deliver(input: LoggedInput): void { this.accept({ logged: true, input }); }

  private accept(p: Pending): void {
    if (this.state === 'running' && this.turnId) { this.handOff(p); return; }
    if (this.state === 'waiting') { this.queued.push(p); return; }
    this.start(p, true);
  }

  /** Run the last user message again (it is already logged; it is not logged twice). */
  retry(): boolean {
    if (this.state !== 'idle') return false;
    const run = this.d.store.lastUserRun();
    if (!run.length) return false;
    this.start({ logged: false, input: { text: run.map((m) => m.text).join(''), project: run[0].project, media: run.flatMap((m) => m.media) } }, false);
    return true;
  }

  private start(first: Pending, logIt: boolean): void {
    this.state = 'waiting';
    this.turnProject = first.input.project;
    this.handoffPending = false;
    this.d.emit({ type: 'endless:turn', status: 'waiting' });
    const done: Promise<void> = this.run(first, logIt).finally(() => { if (this.done === done) this.done = null; });
    this.done = done;
  }

  private content(p: Pending, before: string[]): ContentBlock[] {
    const blocks: ContentBlock[] = before.map((text) => ({ type: 'text', text }));
    blocks.push({ type: 'text', text: messageLine(p.logged ? p.input.kind : 'user', p.input.text, this.d.projectName(p.input.project)) });
    if (!p.logged) {
      for (const file of p.input.media) {
        const img = this.d.readImage(file);
        if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
      }
    }
    return blocks;
  }

  private logUser(input: UserInput): void {
    this.d.log({ kind: 'user', text: input.text, project: input.project, media: input.media });
  }

  private handOff(p: Pending): void {
    if (!p.logged) this.logUser(p.input);
    this.handoffPending = true;
    this.afterHandOff?.();
    this.d.manager.sendMessage(this.turnId!, this.content(p, []));
  }
```

In `run`, change the signature to `private async run(first: Pending, logIt: boolean): Promise<void>`. Replace its first four lines inside `try` (from `await d.compactor.waitForSettled(…)` to the `d.log(…)` line) with:

```ts
      const upTo = first.logged ? first.input.i : d.store.count();
      await d.compactor.waitForSettled(upTo, d.waitMs ?? TURN_WAIT_MS);
      // A report logged while this turn waited is a message of this turn, not a view line.
      const cut = Math.min(first.logged ? first.input.i : d.store.count(), ...this.queued.flatMap((q) => (q.logged ? [q.input.i] : [])));
      const view = d.views.turnBlocks(cut);          // render the view first …
      const status = d.statusBlock(first.input.project);
      if (logIt && !first.logged) this.logUser(first.input); // … then log
```

In the same `try`, change `d.manager.sendMessage(id, this.content(first, [...view, status]));` so it passes `first` (it already does). Keep `for (const q of this.queued.splice(0)) this.handOff(q);`.

In `finally`, replace:

```ts
        for (const q of this.queued.splice(0)) d.log({ kind: 'user', text: q.text, project: q.project, media: q.media });
```

with:

```ts
        // User messages that never reached a process are logged so that they are not lost.
        // Reports are already in the log; the next turn sees them in its view.
        for (const q of this.queued.splice(0)) if (!q.logged) this.logUser(q.input);
```

- [ ] **Step 4: Run the tests to verify that they pass**

Run (from `packages/core`): `npx vitest run tests/endless/turn-runner.test.ts`
Expected: PASS. The stage-1 tests in the file still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endless/turn-runner.ts packages/core/tests/endless/turn-runner.test.ts
git commit -m "feat(endless): a logged thread report starts or joins a turn"
```

---

## Task 5: Project resolution and `GET /api/endless/project`

**Files:**
- Create: `packages/core/src/endless/projects.ts`
- Modify: `packages/core/src/endless/service.ts`, `packages/core/src/routes/endless.ts`
- Test: `packages/core/tests/endless/projects.test.ts`, `packages/core/tests/routes/endless.test.ts`

**Interfaces:**
- Produces:
  - `export interface ProjectRef { id: string; name: string; folder: string }`
  - `export type ProjectLookup = { ok: true; project: ProjectRef } | { ok: false; error: string }`
  - `export function resolveProject(sessions: readonly { id: string; name: string | null; working_dir: string }[], ref: unknown): ProjectLookup`
  - `export function overseerOf(db: Database.Database, sessionId: string): string | null`
  - `EndlessService.project(ref: string): ProjectRef` (throws `UserError`)
  - `GET /api/endless/project?ref=<name or id>` → `200 ProjectRef` or `400 { error }`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/endless/projects.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { resolveProject, overseerOf } from '../../src/endless/projects.js';

const rows = [
  { id: 's1', name: 'salsify', working_dir: '/w/salsify' },
  { id: 's2', name: 'Dispatch', working_dir: '/w/dispatch' },
  { id: 's3', name: 'site', working_dir: '/w/site-a' },
  { id: 's4', name: 'Site', working_dir: '/w/site-b' },
];

describe('resolveProject', () => {
  it('finds a project by id, or by name without regard to case or outer spaces', () => {
    expect(resolveProject(rows, 's2')).toEqual({ ok: true, project: { id: 's2', name: 'Dispatch', folder: '/w/dispatch' } });
    expect(resolveProject(rows, '  dispatch ')).toEqual({ ok: true, project: { id: 's2', name: 'Dispatch', folder: '/w/dispatch' } });
  });
  it('names the known projects when the name is unknown', () => {
    expect(resolveProject(rows, 'salsfy')).toEqual({ ok: false, error: 'unknown project "salsfy". Known projects: salsify, Dispatch, site, Site' });
  });
  it('lists the ids when a name is ambiguous', () => {
    expect(resolveProject(rows, 'SITE')).toEqual({
      ok: false,
      error: '"SITE" names 2 projects: site (id s3, folder /w/site-a); Site (id s4, folder /w/site-b). Pass the id.',
    });
  });
  it('asks for a project when none is given', () => {
    expect(resolveProject(rows, '')).toEqual({ ok: false, error: 'project is required: a project name or id from the status block' });
    expect(resolveProject(rows, undefined)).toEqual({ ok: false, error: 'project is required: a project name or id from the status block' });
  });
});

describe('overseerOf', () => {
  it('finds the live Control Plane terminal of a project, or null', () => {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    expect(overseerOf(db, 's1')).toBeNull();
    terminalsDb.create(db, { id: 'w', sessionId: 's1', type: 'claude-code', label: 'w', config: { role: 'agent' } });
    terminalsDb.create(db, { id: 'c', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    expect(overseerOf(db, 's1')).toBe('c');
    terminalsDb.archive(db, 'c');
    expect(overseerOf(db, 's1')).toBeNull();
  });
});
```

Append to `describe('endless routes', …)` in `packages/core/tests/routes/endless.test.ts`:

```ts
  it('GET /project resolves a name and explains an unknown one', async () => {
    const ok = await request(app).get('/api/endless/project?ref=SALSIFY');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 's1', name: 'salsify', folder: path.join(root, 'salsify') });
    const bad = await request(app).get('/api/endless/project?ref=nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown project "nope". Known projects: salsify');
  });
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/endless/projects.test.ts tests/routes/endless.test.ts`
Expected: FAIL. The output shows "Failed to load url ../../src/endless/projects.js" and a 404 for `/project`.

- [ ] **Step 3: Implement `projects.ts`**

Create `packages/core/src/endless/projects.ts`:

```ts
/**
 * Chat works across all projects, so every thread tool names its project. A project is
 * found by its sessions.id, or by its name (case and outer spaces ignored). An unknown
 * or ambiguous name is an error that tells the model what to pass instead.
 */
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';

export interface ProjectRef { id: string; name: string; folder: string }
export type ProjectLookup = { ok: true; project: ProjectRef } | { ok: false; error: string };

const MAX_LISTED = 30;

export function resolveProject(sessions: readonly { id: string; name: string | null; working_dir: string }[], ref: unknown): ProjectLookup {
  const want = typeof ref === 'string' ? ref.trim() : '';
  if (!want) return { ok: false, error: 'project is required: a project name or id from the status block' };
  const toRef = (s: { id: string; name: string | null; working_dir: string }): ProjectRef => ({ id: s.id, name: s.name ?? '', folder: s.working_dir });
  const byId = sessions.find((s) => s.id === want);
  if (byId) return { ok: true, project: toRef(byId) };
  const named = sessions.filter((s) => (s.name ?? '').trim().toLowerCase() === want.toLowerCase());
  if (named.length === 1) return { ok: true, project: toRef(named[0]) };
  if (named.length > 1) {
    const list = named.map((s) => `${s.name} (id ${s.id}, folder ${s.working_dir})`).join('; ');
    return { ok: false, error: `"${want}" names ${named.length} projects: ${list}. Pass the id.` };
  }
  const known = sessions.map((s) => s.name ?? s.id);
  const more = known.length > MAX_LISTED ? `, and ${known.length - MAX_LISTED} more` : '';
  return { ok: false, error: `unknown project "${want}". Known projects: ${known.slice(0, MAX_LISTED).join(', ')}${more}` };
}

/** The project's live Control Plane terminal (config.role 'coordinator'), or null. */
export function overseerOf(db: Database.Database, sessionId: string): string | null {
  for (const t of terminalsDb.listBySession(db, sessionId)) {
    if (t.archived_at) continue;
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(t.config || '{}'); } catch { /* not a coordinator */ }
    if (cfg.role === 'coordinator') return t.id;
  }
  return null;
}
```

- [ ] **Step 4: Add `EndlessService.project` and the route**

In `packages/core/src/endless/service.ts`, add `import { resolveProject, type ProjectRef } from './projects.js';` and this method (after `projectName`):

```ts
  /** A project by name or id, for the thread tools; UserError when unknown or ambiguous. */
  project(ref: string): ProjectRef {
    const r = resolveProject(sessionsDb.list(this.o.db), ref);
    if (!r.ok) throw new UserError(r.error);
    return r.project;
  }
```

In `packages/core/src/routes/endless.ts`, after the `/threads` route:

```ts
  router.get('/project', (req, res) => {
    try { res.json(svc.project(String(req.query.ref ?? ''))); } catch (err) { fail(res, err); }
  });
```

- [ ] **Step 5: Run the tests to verify that they pass**

Run (from `packages/core`): `npx vitest run tests/endless/projects.test.ts tests/routes/endless.test.ts`
Expected: PASS. (`terminalsDb.listBySession` returns archived rows too, so the `archived_at` check is needed. If it already filters them, the test still passes.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/endless/projects.ts packages/core/src/endless/service.ts packages/core/src/routes/endless.ts packages/core/tests/endless/projects.test.ts packages/core/tests/routes/endless.test.ts
git commit -m "feat(endless): resolve a project by name or id for the thread tools"
```

---

## Task 6: Reports — arm, log once, start a turn, recover at start; daemon wiring

**Files:**
- Create: `packages/core/src/endless/reports.ts`
- Modify: `packages/core/src/endless/service.ts`, `packages/core/src/routes/endless.ts`, `packages/core/src/server.ts` (~504–530 and 679)
- Test: `packages/core/tests/endless/reports.test.ts`, `packages/core/tests/routes/endless.test.ts`

**Interfaces:**
- Consumes: `store.armReport/hasPendingReport/claimReport/pendingReports`, `appendLogged(…, { claim })` (Task 3); `TurnRunner.deliver` (Task 4); `SessionService.finalOutput` (Task 2); `StatusService.addThreadSettledListener` and the `onWatchStatus` constructor callback (existing).
- Produces:
  - `export function reportText(label: string, outcome: string, output: string): string`
  - `export function threadOrigin(t: { config: string | null }): string | null`
  - `export function recoveryOutcome(t: { status: string; archived_at: string | null } | null): string | null`
  - `EndlessServiceOptions.finalOutput?: (terminalId: string) => string`
  - `EndlessService.arm(terminalId: string): { armed: boolean }`
  - `EndlessService.onThreadSettled(info: { terminalId: string; threadStatus: string }): void` (it defers one tick)
  - `EndlessService.reportThread(terminalId: string, outcome: string): EndlessMessage[]`
  - `EndlessService.log(input: LogInput, opts?: LogOptions): EndlessMessage[]`
  - `POST /api/endless/arm { terminalId }` → `200 { armed: boolean }` or `400 { error }`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/endless/reports.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { EndlessService, UserError } from '../../src/endless/service.js';
import { reportText, recoveryOutcome } from '../../src/endless/reports.js';
import { FakeSummarizer, settle } from './fake-summarizer.js';
import { FakeManager, texts } from './fake-manager.js';

let root: string;
let db: Database.Database;
let outputs: Record<string, string>;
const live: { svc: EndlessService; fake: FakeManager }[] = [];
const flush = () => new Promise<void>((r) => setImmediate(r));

function make() {
  const fake = new FakeManager();
  const svc = new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: fake.asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 }, finalOutput: (id) => outputs[id] ?? '',
  });
  svc.start(3999);
  live.push({ svc, fake });
  return { svc, fake };
}
// Read the table itself: each service keeps its own in-memory message count.
const works = () => db.prepare("SELECT i, text, project, ref FROM endless_messages WHERE kind = 'work' ORDER BY i").all() as { i: number; text: string; project: string | null; ref: string | null }[];
const endTurn = async (x: { svc: EndlessService; fake: FakeManager }) => {
  x.fake.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  x.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
  await x.svc.turns.whenIdle();
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-reports-'));
  db = new Database(':memory:');
  initSchema(db);
  outputs = {};
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: path.join(root, 'salsify') });
  const chat = { role: 'agent', agentType: 'implementer', origin: 'endless', spawnDepth: 1 };
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix login', config: chat });
  terminalsDb.create(db, { id: 't3', sessionId: 's1', type: 'claude-code', label: 'Check docs', config: chat });
  terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'Mine', config: { role: 'agent', agentType: 'implementer' } });
});
afterEach(async () => {
  for (const x of live.splice(0)) { x.svc.stop(); x.fake.killAll(); }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('report texts', () => {
  it('says what happened, and fits one message', () => {
    expect(reportText('Fix login', 'idle', ' Fixed. ')).toBe('[Fix login] report: Fixed.');
    expect(reportText('Fix login', 'needs_input', 'Which file?')).toBe('[Fix login] report: (waiting for an answer) Which file?');
    expect(reportText('Fix login', 'error', '')).toBe('[Fix login] report: (stopped with an error) (no output)');
    const long = reportText('Fix login', 'idle', 'x'.repeat(50_000));
    expect(long.length).toBeLessThanOrEqual(30_000);
    expect(long).toContain('characters clipped');
  });
  it('recovery reports a settled or gone thread, and waits for a working one', () => {
    expect(recoveryOutcome(null)).toBe('gone');
    expect(recoveryOutcome({ status: 'waiting', archived_at: '2026-01-01' })).toBe('gone');
    expect(recoveryOutcome({ status: 'waiting', archived_at: null })).toBe('idle');
    expect(recoveryOutcome({ status: 'needs_input', archived_at: null })).toBe('needs_input');
    expect(recoveryOutcome({ status: 'error', archived_at: null })).toBe('error');
    for (const status of ['working', 'queued', 'scheduled']) expect(recoveryOutcome({ status, archived_at: null })).toBeNull();
  });
});

describe('thread reports', () => {
  it('arms only a thread Chat started', () => {
    const { svc } = make();
    expect(svc.arm('t1')).toEqual({ armed: true });
    expect(svc.arm('t2')).toEqual({ armed: false });
    expect(() => svc.arm('nope')).toThrow(UserError);
  });

  it('an armed thread that settles logs one work report and starts a turn with it', async () => {
    const x = make();
    outputs.t1 = 'Fixed the login cookie path.';
    x.svc.arm('t1');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toEqual([expect.objectContaining({ text: '[Fix login] report: Fixed the login cookie path.', project: 's1', ref: 't1' })]);
    await settle();
    expect(x.fake.spawned).toHaveLength(1);
    expect(texts(x.fake.sent[0].content).at(-1)).toBe('work (salsify): [Fix login] report: Fixed the login cookie path.');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' }); // a second edge: nothing is owed
    await flush();
    expect(works()).toHaveLength(1);
    await endTurn(x);
  });

  it('a thread Chat did not start, or did not arm, never reports', async () => {
    const x = make();
    outputs.t2 = 'mine';
    x.svc.onThreadSettled({ terminalId: 't2', threadStatus: 'idle' });
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toEqual([]);
    expect(x.fake.spawned).toHaveLength(0);
  });

  it('an armed thread that fails with no output reports that it stopped', async () => {
    const x = make();
    x.svc.arm('t1');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'error' });
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: (stopped with an error) (no output)']);
    await settle();
    await endTurn(x);
  });

  it('two threads that finish together make two reports and one turn', async () => {
    const x = make();
    outputs.t1 = 'one';
    outputs.t3 = 'two';
    x.svc.arm('t1');
    x.svc.arm('t3');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    x.svc.onThreadSettled({ terminalId: 't3', threadStatus: 'idle' });
    await flush();
    await settle();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: one', '[Check docs] report: two']);
    expect(x.fake.spawned).toHaveLength(1);
    expect(texts(x.fake.sent[1].content)).toEqual(['work (salsify): [Check docs] report: two']);
    await endTurn(x);
  });

  it('a report logged before a restart is never logged again', async () => {
    const a = make();
    outputs.t1 = 'done';
    a.svc.arm('t1');
    a.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    await settle();
    await endTurn(a);
    a.svc.stop();
    terminalsDb.updateStatus(db, 't1', 'waiting');
    const b = make(); // the restart: a new service over the same database
    b.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toHaveLength(1);
    expect(b.fake.spawned).toHaveLength(0);
  });

  it('a report lost to a restart is logged once at the next start, and only once', async () => {
    const a = make();
    outputs.t1 = 'done while the daemon was down';
    a.svc.arm('t1');
    a.svc.stop(); // the settle edge never reached Chat
    terminalsDb.updateStatus(db, 't1', 'waiting');
    const b = make();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: done while the daemon was down']);
    await settle();
    await endTurn(b);
    b.svc.stop();
    make(); // a second restart
    expect(works()).toHaveLength(1);
  });

  it('recovery leaves a thread that is still working to its own settle edge', () => {
    const a = make();
    a.svc.arm('t1');
    a.svc.stop();
    terminalsDb.updateStatus(db, 't1', 'working');
    make();
    expect(works()).toEqual([]);
    expect(live[1].svc.store.hasPendingReport('t1')).toBe(true);
  });
});
```

Append to `describe('endless routes', …)` in `packages/core/tests/routes/endless.test.ts`:

```ts
  it('POST /arm arms a Chat thread and refuses an unknown one', async () => {
    const db = (svc as any).o.db as Database.Database;
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix', config: { role: 'agent', origin: 'endless' } });
    expect((await request(app).post('/api/endless/arm').send({ terminalId: 't1' })).body).toEqual({ armed: true });
    const bad = await request(app).post('/api/endless/arm').send({ terminalId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown thread: nope');
  });
```

Add `import * as terminalsDb from '../../src/db/terminals.js';` at the top of the route test.

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/endless/reports.test.ts tests/routes/endless.test.ts`
Expected: FAIL. The output shows "Failed to load url ../../src/endless/reports.js", and `/arm` returns 404.

- [ ] **Step 3: Implement `reports.ts`**

Create `packages/core/src/endless/reports.ts`:

```ts
/**
 * Thread reports (spec 2026-10-13, section 6.4). A thread Chat started owes Chat one report
 * each time Chat sends it work (spawn_agent, message_thread). Pure helpers; the service logs.
 */
import { clipToolOutput, TOOL_CLIP_CHARS } from './text.js';

const NOTES: Record<string, string> = {
  needs_input: '(waiting for an answer) ',
  error: '(stopped with an error) ',
  gone: '(the thread is gone) ',
};

/** `[Label] report: <output>`, clipped head + tail so that the whole text is one message. */
export function reportText(label: string, outcome: string, output: string): string {
  const head = `[${label.trim().slice(0, 120) || 'thread'}] report: ${NOTES[outcome] ?? ''}`;
  return head + clipToolOutput(output.trim() || '(no output)', TOOL_CLIP_CHARS - head.length);
}

export function threadOrigin(t: { config: string | null }): string | null {
  try {
    const origin = JSON.parse(t.config || '{}')?.origin;
    return typeof origin === 'string' ? origin : null;
  } catch {
    return null;
  }
}

/** At start: what a pending report says now, or null while the thread can still settle on its own. */
export function recoveryOutcome(t: { status: string; archived_at: string | null } | null): string | null {
  if (!t || t.archived_at) return 'gone';
  if (t.status === 'error') return 'error';
  if (t.status === 'needs_input') return 'needs_input';
  if (t.status === 'waiting') return 'idle';
  return null; // working, queued, scheduled: the settle or error edge reports it
}
```

- [ ] **Step 4: Implement the service part**

In `packages/core/src/endless/service.ts`:

1. Change the log import to `import { appendLogged, type LogInput, type LogOptions } from './log.js';` and add `import { reportText, threadOrigin, recoveryOutcome } from './reports.js';`.
2. Add to `EndlessServiceOptions`:
   ```ts
     /** A thread's final output for its report (SessionService.finalOutput). */
     finalOutput?: (terminalId: string) => string;
   ```
3. In `start()`, after `this.phase = 'ready';`, add `this.recoverReports();`.
4. Replace `log(input: LogInput)` with:
   ```ts
     log(input: LogInput, opts: LogOptions = {}): EndlessMessage[] {
       if (this.closed) return [];
       const written = appendLogged({ store: this.store, views: this.views, compactor: this.compactor }, input, opts);
       for (const m of written) this.o.broadcaster.broadcast({ type: 'endless:message', message: this.toWire(m) });
       return written;
     }
   ```
5. Add these methods after `project()`:
   ```ts
     /** Chat sent work to a thread. A thread Chat started then owes Chat one report. */
     arm(terminalId: string): { armed: boolean } {
       const t = terminalsDb.getById(this.o.db, terminalId);
       if (!t) throw new UserError(`unknown thread: ${terminalId}`);
       if (threadOrigin(t) !== 'endless') return { armed: false };
       this.store.armReport(terminalId, this.now());
       return { armed: true };
     }

     /**
      * The StatusService settled edge (and the error edge). Deferred one tick, like the roles
      * listener, so that the turn's outcome and texts are recorded first. Never throws.
      */
     onThreadSettled(info: { terminalId: string; threadStatus: string }): void {
       setImmediate(() => {
         try { this.reportThread(info.terminalId, info.threadStatus); }
         catch (err) { console.warn(`[endless] the report of ${info.terminalId} failed:`, err); }
       });
     }

     /**
      * Log the thread's report once (the claim and the append share one transaction), then hand
      * it to the turn runner: it starts a turn, joins a starting one, or reaches the running one.
      */
     reportThread(terminalId: string, outcome: string): EndlessMessage[] {
       if (this.phase !== 'ready' || this.closed || !this.store.hasPendingReport(terminalId)) return [];
       const t = terminalsDb.getById(this.o.db, terminalId);
       const gone = !t || outcome === 'gone';
       const output = gone ? '' : this.o.finalOutput?.(terminalId) ?? '';
       const text = reportText(t?.label || terminalId, gone ? 'gone' : outcome, output);
       const written = this.log({ kind: 'work', text, project: t?.session_id ?? null, ref: terminalId }, { claim: () => this.store.claimReport(terminalId) });
       if (written.length) {
         this.turns.deliver({ i: written[0].i, kind: 'work', text: written.map((m) => m.text).join(''), project: written[0].project });
       }
       return written;
     }

     /** At start: report each pending thread that settled while no one listened. */
     private recoverReports(): void {
       try {
         for (const id of this.store.pendingReports()) {
           const outcome = recoveryOutcome(terminalsDb.getById(this.o.db, id));
           if (outcome) this.reportThread(id, outcome);
         }
       } catch (err) {
         console.warn('[endless] report recovery failed:', err);
       }
     }
   ```

- [ ] **Step 5: Add the route**

In `packages/core/src/routes/endless.ts`, after `/project`:

```ts
  router.post('/arm', (req, res) => {
    try { res.json(svc.arm(String(req.body?.terminalId ?? ''))); } catch (err) { fail(res, err); }
  });
```

- [ ] **Step 6: Run the tests to verify that they pass**

Run (from `packages/core`): `npx vitest run tests/endless/reports.test.ts tests/routes/endless.test.ts tests/endless/turn-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Wire the daemon**

In `packages/core/src/server.ts`, in `startServer`:

1. Before `const statusService = new StatusService(`, add:
   ```ts
   // Endless Chat hears a thread's error edge here; its settles come from the settled listener below.
   let onEndlessStatus: ((terminalId: string, status: string) => void) | null = null;
   ```
   Change the fourth constructor argument from `(terminalId, status) => watchDispatcher.onStatus(terminalId, status),` to:
   ```ts
       (terminalId, status) => { watchDispatcher.onStatus(terminalId, status); onEndlessStatus?.(terminalId, status); },
   ```
2. In the `new EndlessService({ … })` options, add `finalOutput: (id) => sessionService.finalOutput(id),`.
3. Directly after the `new EndlessService` statement, add:
   ```ts
   // Stage 2: a thread Chat started reports when it settles (finished or asking) or fails.
   statusService.addThreadSettledListener(({ terminalId, threadStatus }) => endless.onThreadSettled({ terminalId, threadStatus }));
   onEndlessStatus = (terminalId, status) => { if (status === 'error') endless.onThreadSettled({ terminalId, threadStatus: 'error' }); };
   ```

Run (from the repo root): `pnpm --filter dispatch-server build`
Expected: the build succeeds with no type errors.

Run (from `packages/core`): `npx vitest run tests/esm-import-extensions.test.ts tests/server-shutdown.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/endless/reports.ts packages/core/src/endless/service.ts packages/core/src/routes/endless.ts packages/core/src/server.ts packages/core/tests/endless/reports.test.ts packages/core/tests/routes/endless.test.ts
git commit -m "feat(endless): a thread Chat started reports once into the log and starts a turn"
```

---

## Task 7: The Chat ledger route

The ledger rules make the project's overseer (its Control Plane terminal) the only writer, and they check the user's quotes against the Control Plane's messages. Chat acts as that overseer through a daemon route. Chat gets only the actions that need no quote of the user: list, show, add, withdraw, and set a title.

**Files:**
- Modify: `packages/core/src/endless/service.ts`, `packages/core/src/routes/endless.ts`, `packages/core/src/server.ts` (the `wireLedger` call at ~679)
- Test: `packages/core/tests/endless/ledger.test.ts`, `packages/core/tests/routes/endless.test.ts`

**Interfaces:**
- Consumes: `LedgerService` (`list`, `show`, `add`, `resolve`, `setTitle`; `LedgerError`); `overseerOf`, `EndlessService.project` (Task 5).
- Produces:
  - `EndlessServiceOptions.ledger?: LedgerService`
  - `EndlessService.ledger(action: string, body: Record<string, unknown>): unknown`
  - `POST /api/endless/ledger/:action` with `action` ∈ `list | show | add | resolve | title` and the body `{ project, …args }` → `200` result, `400 { error }`, or the `LedgerError` status with `{ error }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/endless/ledger.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { EndlessService, UserError } from '../../src/endless/service.js';
import { FakeSummarizer } from './fake-summarizer.js';
import { FakeManager } from './fake-manager.js';

let root: string;
let svc: EndlessService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-ledger-'));
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: path.join(root, 'salsify') });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'bare', workingDir: path.join(root, 'bare') });
  terminalsDb.create(db, { id: 'c1', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  svc = new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: new FakeManager().asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', ledger: new LedgerService(db),
  });
  svc.start(3999);
});
afterEach(() => { svc.stop(); fs.rmSync(root, { recursive: true, force: true }); });

describe('the Chat ledger', () => {
  it('adds, lists, shows, retitles and withdraws an item as the project\'s overseer', () => {
    const added = svc.ledger('add', { project: 'salsify', kind: 'do', text: 'Rotate the API key on staging.', title: 'Rotate the staging key' }) as { id: string; line: string };
    expect(added.id).toBe('N1');
    expect((svc.ledger('list', { project: 'salsify' }) as { text: string }).text).toContain('Rotate the staging key');
    expect((svc.ledger('show', { project: 'salsify', ids: ['N1'] }) as { text: string }).text).toContain('Rotate the API key on staging.');
    expect(svc.ledger('title', { project: 'salsify', id: 'N1', title: 'Rotate the staging API key' })).toEqual({ id: 'N1', title: 'Rotate the staging API key' });
    expect((svc.ledger('resolve', { project: 'salsify', id: 'N1', status: 'withdrawn', reason: 'done by hand' }) as { status: string }).status).toBe('withdrawn');
  });

  it('refuses an answer or a park: those need the user\'s words in the Control Plane', () => {
    svc.ledger('add', { project: 'salsify', kind: 'do', text: 'Check the banner.', title: 'Check the banner' });
    expect(() => svc.ledger('resolve', { project: 'salsify', id: 'N1', status: 'answered', quote: 'yes' }))
      .toThrow('Chat can only withdraw an item (status "withdrawn", with a reason). The user answers or parks items in the project\'s Control Plane.');
  });

  it('explains a project without a Control Plane, and an unknown project', () => {
    expect(() => svc.ledger('list', { project: 'bare' }))
      .toThrow("bare has no Control Plane, and its ledger belongs to it. Ask the user to open the project's Control Plane once.");
    expect(() => svc.ledger('list', { project: 'nope' })).toThrow(UserError);
  });
});
```

Append to `describe('endless routes', …)` in `packages/core/tests/routes/endless.test.ts`:

```ts
  it('POST /ledger/:action answers 400 for a project with no Control Plane', async () => {
    const res = await request(app).post('/api/endless/ledger/list').send({ project: 'salsify' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/has no Control Plane/);
  });
```

(The route test's service has no `ledger` option. Give it one: in its `beforeEach`, add `ledger: new LedgerService(db),` to the `EndlessService` options, and add `import { LedgerService } from '../../src/overseer/ledger-service.js';`.)

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/endless/ledger.test.ts tests/routes/endless.test.ts`
Expected: FAIL with `svc.ledger is not a function`, and the route returns 404.

- [ ] **Step 3: Implement `EndlessService.ledger`**

In `packages/core/src/endless/service.ts`, change the projects import to `import { resolveProject, overseerOf, type ProjectRef } from './projects.js';`. Then add `import type { LedgerService } from '../overseer/ledger-service.js';`. Add `ledger?: LedgerService;` to `EndlessServiceOptions`, and add this method:

```ts
  /**
   * The ledger tools for Chat. The ledger belongs to the project's Control Plane (only its
   * overseer writes, and quotes are checked against its user messages), so Chat acts as that
   * overseer, for the actions that need no quote of the user.
   */
  ledger(action: string, body: Record<string, unknown>): unknown {
    const ledger = this.o.ledger;
    if (!ledger) throw new UserError('the ledger is not available');
    const { project: ref, ...args } = body;
    const p = this.project(typeof ref === 'string' ? ref : '');
    const overseer = overseerOf(this.o.db, p.id);
    if (!overseer) throw new UserError(`${p.name} has no Control Plane, and its ledger belongs to it. Ask the user to open the project's Control Plane once.`);
    switch (action) {
      case 'list': {
        const r = ledger.list(p.id, overseer, { forRecap: false });
        return { text: r.text, openIds: r.openIds, rules: r.rules };
      }
      case 'show': return ledger.show(p.id, overseer, args);
      case 'add': return ledger.add(p.id, overseer, args);
      case 'resolve':
        if (args.status !== 'withdrawn') {
          throw new UserError('Chat can only withdraw an item (status "withdrawn", with a reason). The user answers or parks items in the project\'s Control Plane.');
        }
        return ledger.resolve(p.id, overseer, args);
      case 'title': return ledger.setTitle(p.id, overseer, args);
      default: throw new UserError(`unknown ledger action: ${action}`);
    }
  }
```

- [ ] **Step 4: Add the route**

In `packages/core/src/routes/endless.ts`, add `import { LedgerError } from '../overseer/ledger-service.js';`. Then add after `/arm`:

```ts
  router.post('/ledger/:action', (req, res) => {
    try { res.json(svc.ledger(req.params.action, req.body ?? {})); }
    catch (err) {
      if (err instanceof LedgerError) res.status(err.status).json({ error: err.message, ...err.body });
      else fail(res, err);
    }
  });
```

- [ ] **Step 5: Share one LedgerService with the daemon**

In `packages/core/src/server.ts`, in `startServer`, before `const endless = new EndlessService({`, add:

```ts
  const ledgerService = wireLedger(db, sessionService, broadcaster);
```

Add `ledger: ledgerService,` to the `EndlessService` options. Change the startServer route line `app.use('/api', createLedgerRouter(wireLedger(db, sessionService, broadcaster)));` to `app.use('/api', createLedgerRouter(ledgerService));`. Do not change `createApp` (line ~368).

- [ ] **Step 6: Run the tests and the build**

Run (from `packages/core`): `npx vitest run tests/endless/ledger.test.ts tests/routes/endless.test.ts tests/overseer/ledger-service.test.ts`
Expected: PASS.

Run (from the repo root): `pnpm --filter dispatch-server build`
Expected: the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/endless/service.ts packages/core/src/routes/endless.ts packages/core/src/server.ts packages/core/tests/endless/ledger.test.ts packages/core/tests/routes/endless.test.ts
git commit -m "feat(endless): a Chat ledger route that acts as the project's overseer"
```

---

## Task 8: The thread and ledger tools in the memory MCP server

**Files:**
- Modify: `packages/core/src/endless/memory-mcp.ts`
- Test: `packages/core/tests/endless/memory-mcp.test.ts`

**Interfaces:**
- Consumes: `createWorker`, `sendTask`, `readAgentOutput`, `AGENT_TYPES`, `HARNESSES`, `HARNESS_ARG_DESCRIPTION`, `TITLE_RULES`, `CARD_FIELDS_SCHEMA` (Task 1); `GET /api/endless/project` (Task 5); `POST /api/endless/arm` (Task 6); `POST /api/endless/ledger/:action` (Task 7).
- Produces: the tools (in this order) `zoom`, `date`, `list_threads`, `read_thread`, `spawn_agent`, `message_thread`, `read_agent`, `ledger_list`, `ledger_show`, `ledger_add`, `ledger_resolve`, `ledger_set_title`. `spawn_agent` returns `{ agentId, label, project, folder }`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/tests/endless/memory-mcp.test.ts`, replace the first test (`lists exactly the stage-1 tools …`) with:

```ts
  it('lists the stage-1 tools, then the thread and ledger tools, as fixed text', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((res!.result as any).tools.map((t: any) => t.name)).toEqual([
      'zoom', 'date', 'list_threads', 'read_thread',
      'spawn_agent', 'message_thread', 'read_agent',
      'ledger_list', 'ledger_show', 'ledger_add', 'ledger_resolve', 'ledger_set_title',
    ]);
    expect(TOOLS[0].description).toBe('Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.');
    expect(TOOLS[1].description).toBe('The date and time of message id.');
    const all = JSON.stringify(TOOLS);
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(all).not.toContain('DISPATCH_SESSION');
    for (const t of TOOLS) {
      if (t.name === 'spawn_agent' || t.name.startsWith('ledger_')) expect((t.inputSchema as any).required).toContain('project');
    }
  });
```

Append inside `describe('memory MCP server', …)`:

```ts
  const calls = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.map((c) => [String(c[0]).replace(/^http:\/\/localhost:\d+/, ''), (c[1] as RequestInit | undefined)?.method ?? 'GET']);
  const bodyOf = (m: ReturnType<typeof vi.fn>, k: number) => JSON.parse(String((m.mock.calls[k][1] as RequestInit).body));

  it('spawn_agent resolves the project, creates a Chat thread there with the Control Plane defaults, arms its report, then sends the task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 's1', name: 'salsify', folder: '/w/salsify' }))
      .mockResolvedValueOnce(json(200, { harness: 'claude-code', available: true }))
      .mockResolvedValueOnce(json(201, { id: 't9', label: 'Fix login' }))
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsify', agentType: 'implementer', name: 'Fix login', task: 'Fix the login bug in /w/salsify/src/login.ts' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ agentId: 't9', label: 'Fix login', project: 'salsify', folder: '/w/salsify' });
    expect(calls(fetchMock)).toEqual([
      ['/api/endless/project?ref=salsify', 'GET'],
      ['/api/sessions/s1/overseer/worker-defaults?agentType=implementer', 'GET'],
      ['/api/sessions/s1/terminals', 'POST'],
      ['/api/endless/arm', 'POST'],
      ['/api/terminals/t9/message', 'POST'],
    ]);
    expect(bodyOf(fetchMock, 2).config).toEqual({ transport: 'structured', agentType: 'implementer', role: 'agent', spawnDepth: 1, origin: 'endless' });
    expect(bodyOf(fetchMock, 3)).toEqual({ terminalId: 't9' });
    expect(bodyOf(fetchMock, 4)).toEqual({ text: 'Fix the login bug in /w/salsify/src/login.ts', source: 'coordinator' });
  });

  it("spawn_agent with an unknown project creates nothing and returns the daemon's error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(400, { error: 'unknown project "salsfy". Known projects: salsify' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('spawn_agent', { project: 'salsfy', agentType: 'researcher', task: 'look' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toBe('Error: unknown project "salsfy". Known projects: salsify');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('spawn_agent refuses a bad agentType or an empty task before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await callTool('spawn_agent', { project: 'salsify', agentType: 'wizard', task: 'x' })).isError).toBe(true);
    expect((await callTool('spawn_agent', { project: 'salsify', agentType: 'researcher' })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('message_thread arms the report, then sends; an unknown thread sends nothing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { armed: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await callTool('message_thread', { id: 't9', text: 'Also fix the logout.' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ ok: true, id: 't9' });
    expect(calls(fetchMock)).toEqual([['/api/endless/arm', 'POST'], ['/api/terminals/t9/message', 'POST']]);

    const bad = vi.fn().mockResolvedValueOnce(json(400, { error: 'unknown thread: nope' }));
    vi.stubGlobal('fetch', bad);
    const r2 = await callTool('message_thread', { id: 'nope', text: 'hi' });
    expect((r2.content[0] as any).text).toBe('Error: unknown thread: nope');
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('read_agent returns the status, output and tools', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(200, { items: [{ kind: 'assistant', text: 'done' }] }))
      .mockResolvedValueOnce(json(200, { status: 'waiting' })));
    const r = await callTool('read_agent', { agentId: 't9' });
    expect(JSON.parse((r.content[0] as any).text)).toEqual({ agentId: 't9', status: 'waiting', output: 'done', tools: [] });
  });

  it('the ledger tools post the project and the arguments to the Chat ledger route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 'N1', line: 'N1 · Rotate the staging key' }))
      .mockResolvedValueOnce(json(200, { text: 'Open: N1', openIds: ['N1'], rules: ['N4 · Never deploy on Fridays'] }));
    vi.stubGlobal('fetch', fetchMock);
    const add = await callTool('ledger_add', { project: 'salsify', kind: 'do', text: 'Rotate the key.', title: 'Rotate the staging key' });
    expect(JSON.parse((add.content[0] as any).text)).toEqual({ id: 'N1', line: 'N1 · Rotate the staging key' });
    expect(calls(fetchMock)[0]).toEqual(['/api/endless/ledger/add', 'POST']);
    expect(bodyOf(fetchMock, 0)).toEqual({ project: 'salsify', kind: 'do', text: 'Rotate the key.', title: 'Rotate the staging key' });
    const list = await callTool('ledger_list', { project: 'salsify' });
    expect((list.content[0] as any).text).toBe('Open: N1\n\nProject rules:\n- N4 · Never deploy on Fridays');
  });
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run (from `packages/core`): `npx vitest run tests/endless/memory-mcp.test.ts`
Expected: FAIL. The tool list shows only the 4 stage-1 tools, and `Unknown tool: spawn_agent`.

- [ ] **Step 3: Implement the tools**

In `packages/core/src/endless/memory-mcp.ts`:

1. Change the header comment's first line to `Endless Chat memory MCP server: zoom, date, the thread tools, and the Chat ledger tools.`
2. Add the imports:
   ```ts
   import {
     createWorker, sendTask, readAgentOutput, AGENT_TYPES, HARNESSES, HARNESS_ARG_DESCRIPTION, TITLE_RULES, CARD_FIELDS_SCHEMA, type AgentType,
   } from '../overseer/agency-shared.js';
   ```
3. Before `export const TOOLS`, add:
   ```ts
   const PROJECT_ARG = { type: 'string', description: 'The project: its name or id, as the status block shows it.' } as const;
   ```
4. Append these entries to `TOOLS`, after `read_thread`:
   ```ts
     {
       name: 'spawn_agent',
       description:
         'Start a Dispatch thread in a project\'s folder and give it a task. Its report reaches you later as a work ' +
         'message starting "[Name]"; never wait for it. Pick agentType by the work: researcher to investigate, planner ' +
         'to plan, implementer to build, reviewer to check, design-reviewer or code-reviewer only to gate a plan or a ' +
         'finished diff. Returns the thread id.',
       inputSchema: {
         type: 'object',
         properties: {
           project: PROJECT_ARG,
           agentType: { type: 'string', enum: AGENT_TYPES, description: 'The kind of thread.' },
           task: { type: 'string', description: 'The task brief: everything the thread needs, with absolute paths. The thread does not see your memory.' },
           name: { type: 'string', description: 'Optional short label for the thread. Its report starts with it.' },
           mission: { type: 'string', description: 'Optional mission name that groups related threads in the project.' },
           model: { type: 'string', description: 'Optional model override for its harness. Omit to use the default for the type.' },
           harness: { type: 'string', enum: HARNESSES, description: HARNESS_ARG_DESCRIPTION },
         },
         required: ['project', 'agentType', 'task'],
       },
     },
     {
       name: 'message_thread',
       description: 'Send a message to a running thread in any project, to steer it or answer it. A thread you started reports again when it next finishes.',
       inputSchema: {
         type: 'object',
         properties: {
           id: { type: 'string', description: 'The thread id (from spawn_agent or list_threads).' },
           text: { type: 'string', description: 'The message.' },
         },
         required: ['id', 'text'],
       },
     },
     {
       name: 'read_agent',
       description: "Read a thread's status and output: its assistant text and the tools it ran.",
       inputSchema: { type: 'object', properties: { agentId: { type: 'string', description: 'The thread id.' } }, required: ['agentId'] },
     },
     {
       name: 'ledger_list',
       description: "List a project's decision ledger: the open items, the recent decisions, and the project rules.",
       inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, required: ['project'] },
     },
     {
       name: 'ledger_show',
       description: "Show items of a project's ledger as full cards: pass ids (e.g. [\"N17\"]), or all: true for every open item.",
       inputSchema: {
         type: 'object',
         properties: {
           project: PROJECT_ARG,
           ids: { type: 'array', items: { type: 'string' }, description: 'Item ids, e.g. ["N17"].' },
           all: { type: 'boolean', description: 'true shows every open item.' },
         },
         required: ['project'],
       },
     },
     {
       name: 'ledger_add',
       description:
         'Record an item that needs the user in a project\'s decision ledger: kind "go" (a merge, deploy or release ' +
         'approval), "decide" (a choice) or "do" (a manual step for the user). A go or decide item is a full decision ' +
         'card: it needs context, default and source; a decide item also needs at least 2 options with a ' +
         'recommendation and why. Every item needs a title. The source kind "user" is not available here. ' +
         'Returns { id, line }.',
       inputSchema: {
         type: 'object',
         properties: {
           project: PROJECT_ARG,
           kind: { type: 'string', enum: ['go', 'decide', 'do'], description: 'go = an approval, decide = a choice, do = a manual step for the user.' },
           text: { type: 'string', description: 'The question as the user will see it: one decision. It never changes after creation.' },
           title: { type: 'string', description: `${TITLE_RULES} Required.` },
           ...CARD_FIELDS_SCHEMA,
           blocks: { type: 'string', description: 'Optional: what this item holds up.' },
           mission: { type: 'string', description: 'Optional mission name this item belongs to.' },
         },
         required: ['project', 'kind', 'text', 'title'],
       },
     },
     {
       name: 'ledger_resolve',
       description: "Withdraw an open item of a project's ledger, with a reason. The user answers or parks items in the project's Control Plane.",
       inputSchema: {
         type: 'object',
         properties: {
           project: PROJECT_ARG,
           id: { type: 'string', description: 'The item id, e.g. "N12".' },
           status: { type: 'string', enum: ['withdrawn'], description: 'Always "withdrawn".' },
           reason: { type: 'string', description: 'Why the item is no longer needed.' },
         },
         required: ['project', 'id', 'status', 'reason'],
       },
     },
     {
       name: 'ledger_set_title',
       description: "Set or change the title of an item in a project's ledger.",
       inputSchema: {
         type: 'object',
         properties: {
           project: PROJECT_ARG,
           id: { type: 'string', description: 'The item id, e.g. "N12".' },
           title: { type: 'string', description: TITLE_RULES },
         },
         required: ['project', 'id', 'title'],
       },
     },
   ```
5. Replace `getJson` with `requestJson`, and keep a `getJson` wrapper so the stage-1 cases do not change:
   ```ts
   /** Call the daemon; a failure throws the route's own `{ error }` text. */
   async function requestJson(method: string, url: string, body?: unknown): Promise<any> {
     const res = await fetch(url, {
       method,
       headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
       body: body !== undefined ? JSON.stringify(body) : undefined,
     });
     const text = await res.text().catch(() => '');
     let data: any = null;
     try { data = text ? JSON.parse(text) : null; } catch { data = text; }
     if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `${method} ${url} -> ${res.status}`);
     return data;
   }
   const getJson = (url: string): Promise<any> => requestJson('GET', url);
   const asText = (v: unknown): { content: McpContent[] } => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
   const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
   ```
   (Move the `type McpContent = …` line above these helpers.)
6. Add these cases to the `switch` in `callTool`, before `default`:
   ```ts
         case 'spawn_agent': {
           if (!AGENT_TYPES.includes(a.agentType)) throw new Error(`agentType must be one of: ${AGENT_TYPES.join(', ')}`);
           if (!str(a.task)) throw new Error('task is required');
           const project = await requestJson('GET', `${apiBase()}/api/endless/project?ref=${encodeURIComponent(str(a.project))}`);
           const label = str(a.name) || `${a.agentType} agent`;
           const agentId = await createWorker(apiBase(), project.id, {
             agentType: a.agentType as AgentType, label, mission: str(a.mission), model: str(a.model), harness: str(a.harness), spawnDepth: 1, origin: 'endless',
           });
           await requestJson('POST', `${apiBase()}/api/endless/arm`, { terminalId: agentId });
           await sendTask(apiBase(), agentId, String(a.task));
           return asText({ agentId, label, project: project.name, folder: project.folder });
         }
         case 'message_thread': {
           if (!str(a.id)) throw new Error('id is required');
           if (!str(a.text)) throw new Error('text is required');
           const id = str(a.id);
           await requestJson('POST', `${apiBase()}/api/endless/arm`, { terminalId: id });
           await sendTask(apiBase(), id, String(a.text));
           return asText({ ok: true, id });
         }
         case 'read_agent': {
           if (!str(a.agentId)) throw new Error('agentId is required');
           return asText(await readAgentOutput(apiBase(), str(a.agentId)));
         }
         case 'ledger_list': {
           const r = await requestJson('POST', `${apiBase()}/api/endless/ledger/list`, { project: a.project });
           const rules: string[] = Array.isArray(r?.rules) ? r.rules : [];
           return asText([String(r?.text ?? ''), ...(rules.length ? [['Project rules:', ...rules.map((x) => `- ${x}`)].join('\n')] : [])].join('\n\n'));
         }
         case 'ledger_show': {
           const r = await requestJson('POST', `${apiBase()}/api/endless/ledger/show`, a);
           return asText(String(r?.text ?? ''));
         }
         case 'ledger_add':
           return asText(await requestJson('POST', `${apiBase()}/api/endless/ledger/add`, a));
         case 'ledger_resolve':
           return asText(await requestJson('POST', `${apiBase()}/api/endless/ledger/resolve`, a));
         case 'ledger_set_title':
           return asText(await requestJson('POST', `${apiBase()}/api/endless/ledger/title`, a));
   ```

- [ ] **Step 4: Run the tests to verify that they pass**

Run (from `packages/core`): `npx vitest run tests/endless/memory-mcp.test.ts tests/esm-import-extensions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endless/memory-mcp.ts packages/core/tests/endless/memory-mcp.test.ts
git commit -m "feat(endless): thread and ledger tools in the memory MCP server, scoped to all projects"
```

---

## Task 9: The system prompt names the thread tools

Appendix A lists tools (`zoom`, `date`), so the prompt names the new ones too. The paragraph is fixed text. The prompt test compares `prompt.ts` with Appendix A verbatim, so both change in one commit.

**Files:**
- Modify: `packages/core/src/endless/prompt.ts`, `docs/superpowers/specs/2026-10-13-endless-chat-design.md` (Appendix A)
- Test: `packages/core/tests/endless/prompt.test.ts` (unchanged; it already pins Appendix A)

**Interfaces:**
- Produces: `ENDLESS_SYSTEM_PROMPT` with one more paragraph in "# Projects and threads".

- [ ] **Step 1: Change the spec first (the test then fails)**

In `docs/superpowers/specs/2026-10-13-endless-chat-design.md`, Appendix A, replace:

```
thread (no sleep, no polling): go on, or end your turn and tell the user what is
running.

# Turns
```

with:

```
thread (no sleep, no polling): go on, or end your turn and tell the user what is
running.

Thread tools name the project by its name or id: spawn_agent starts a thread
with a task brief (a thread does not see your memory), message_thread steers
any thread, read_agent and read_thread read one, list_threads lists them all,
and the ledger_ tools read and add a project's open items.

# Turns
```

- [ ] **Step 2: Run the test to verify that it fails**

Run (from `packages/core`): `npx vitest run tests/endless/prompt.test.ts`
Expected: FAIL in `the system prompt is Appendix A verbatim`.

- [ ] **Step 3: Make the same change in `prompt.ts`**

In `packages/core/src/endless/prompt.ts`, make the identical replacement inside `ENDLESS_SYSTEM_PROMPT`.

- [ ] **Step 4: Run the test to verify that it passes**

Run (from `packages/core`): `npx vitest run tests/endless/prompt.test.ts`
Expected: PASS (it also checks again that the prompt holds no date).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/endless/prompt.ts docs/superpowers/specs/2026-10-13-endless-chat-design.md
git commit -m "feat(endless): the system prompt names the thread tools"
```

---

## Task 10: Web — the report card and the projects panel

The work card already calls `requestOpenThread({ sessionId: m.project, terminalId: m.ref })` and `setView('workspace')`, and the App consumer opens the thread. This task pins that with a test. It adds the one missing piece: the projects panel's "last report" reloads only at the end of a turn, so a report that arrives during a turn does not show until then.

**Files:**
- Modify: `packages/web/src/stores/endless.ts` (`applyEvent`, the `endless:message` branch)
- Test: `packages/web/src/stores/endless.test.ts`, `packages/web/src/components/endless/EndlessColumn.test.tsx`

**Interfaces:**
- Consumes: the `endless:message` event with `kind: 'work'`, `project` and `ref` (Task 6).
- Produces: no new names.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('useEndless', …)` in `packages/web/src/stores/endless.test.ts`:

```ts
  it('a work message reloads the projects, so the last report is current at once', () => {
    const spy = vi.mocked(api.endlessProjects);
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(0) });
    expect(spy).not.toHaveBeenCalled();
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(1, { kind: 'work', text: '[Fix] report: done', project: 's1', ref: 't9' }) });
    expect(spy).toHaveBeenCalledTimes(1);
  });
```

Append inside the top `describe` of `packages/web/src/components/endless/EndlessColumn.test.tsx`, and add `import { useUI } from '../../stores/ui';` at the top:

```ts
  it('a work card opens its thread: project as sessionId, ref as terminalId, in the workspace', () => {
    useEndless.setState({ messages: [msg(0, 'work', '[Fix login] report: done', { project: 's1', projectName: 'salsify', ref: 't9' })] });
    useUI.setState({ view: 'chat', pendingOpenThread: null });
    render(<EndlessColumn />);
    fireEvent.click(screen.getByRole('button', { name: /\[Fix login\] report: done/ }));
    expect(useUI.getState().pendingOpenThread).toEqual({ sessionId: 's1', terminalId: 't9' });
    expect(useUI.getState().view).toBe('workspace');
  });
```

- [ ] **Step 2: Run the tests to verify the state**

Run (from `packages/web`): `npx vitest run src/stores/endless.test.ts src/components/endless/EndlessColumn.test.tsx`
Expected: the store test FAILS (`endlessProjects` is not called). The card test PASSES; it pins the existing behavior.

- [ ] **Step 3: Reload the projects on a work message**

In `packages/web/src/stores/endless.ts`, in the `endless:message` branch of `applyEvent`, replace:

```ts
        set(patch);
        return;
```

with:

```ts
        set(patch);
        // A thread report changes its project's "last report" in the projects panel.
        if (m.kind === 'work') void get().loadProjects().catch(() => {});
        return;
```

- [ ] **Step 4: Run the tests to verify that they pass**

Run (from `packages/web`): `npx vitest run src/stores/endless.test.ts src/components/endless/EndlessColumn.test.tsx src/components/endless/ProjectsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/stores/endless.ts packages/web/src/stores/endless.test.ts packages/web/src/components/endless/EndlessColumn.test.tsx
git commit -m "feat(web): a thread report refreshes the projects panel; pin the work card's thread link"
```

---

## Task 11: End-to-end verification on an isolated daemon

No repo code changes. A real Chat turn (Opus) starts a real thread (a researcher on Haiku) in a scratch project under `/tmp`. The thread finishes, its report card appears, and a Chat turn starts from it. This costs a few subscription turns.

**Files:**
- Scratch (not committed): `/tmp/endless-s2/home`, `/tmp/endless-s2/proj/NOTES.md`, `/tmp/endless-s2/run.mjs`, `/tmp/endless-s2/daemon.log`

**Interfaces:**
- Consumes: the built daemon and web bundle; `/api/endless/*`; `/api/terminals/:id`.
- Produces: the recorded results in the final report of the executing agent (no file).

- [ ] **Step 1: Build, check the CLI under the fake HOME, prepare the project**

Run from the worktree root:

```bash
pnpm build
mkdir -p /tmp/endless-s2/home /tmp/endless-s2/proj
printf 'alpha-7 is the build code.\nSecond line.\n' > /tmp/endless-s2/proj/NOTES.md
HOME=/tmp/endless-s2/home claude -p "Reply with the word ok." --model haiku
```

Expected: `ok`. If the CLI says that it is not signed in under the fake HOME, stop and report it to the user. Do not point the daemon at the real `~/.dispatch`.

- [ ] **Step 2: Start the isolated daemon**

```bash
HOME=/tmp/endless-s2/home PORT=3999 DISPATCH_WEB_DIST="$PWD/packages/web/dist" \
  node packages/core/dist/server.js > /tmp/endless-s2/daemon.log 2>&1 &
sleep 5
grep 'listening on port 3999' /tmp/endless-s2/daemon.log
grep 'Serving web client from' /tmp/endless-s2/daemon.log
```

Expected: both lines print, and the web path is inside this worktree. A daemon that does not start usually means a missing `.js` import extension.

- [ ] **Step 3: Write and run the driver**

Write `/tmp/endless-s2/run.mjs`:

```js
// Chat starts a real thread; the thread reports; the report starts a Chat turn.
const base = 'http://127.0.0.1:3999';
const j = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = async () => { for (;;) { const s = await j('GET', '/api/endless/state'); if (s.turn.status !== 'waiting' && s.turn.status !== 'running') return s; await sleep(1000); } };
const all = async () => (await j('GET', '/api/endless/messages?limit=200')).messages;

const proj = await j('POST', '/api/sessions', { provider: 'claude-code', name: 'scratch', workingDir: '/tmp/endless-s2/proj' });
await j('POST', '/api/endless/send', {
  project: proj.id,
  text: 'Start a thread for this, do not do it yourself: call spawn_agent with project "scratch", agentType "researcher", ' +
    'model "haiku", name "Read notes", and the task: "Read /tmp/endless-s2/proj/NOTES.md and reply with its first line, word for word." ' +
    'Then end your turn.',
});
const first = await idle();
console.log('first turn', first.turn.status, first.turn.error ?? '');
const tools = (await all()).filter((m) => m.kind === 'tool').map((m) => m.text.split(' ')[0]);
console.log('tools called', tools.join(', '));

let work = null;
for (let k = 0; k < 180 && !work; k++) { work = (await all()).find((m) => m.kind === 'work') ?? null; if (!work) await sleep(2000); }
if (!work) throw new Error('no work message within 6 minutes');
console.log('work', JSON.stringify({ i: work.i, text: work.text, project: work.project === proj.id, ref: work.ref }));

const thread = await j('GET', `/api/terminals/${work.ref}`);
console.log('thread', JSON.stringify({ id: thread.id, inProject: thread.sessionId === proj.id, config: thread.config }));

await sleep(2000);
const second = await idle();
const after = (await all()).filter((m) => m.i > work.i);
console.log('second turn', second.turn.status, second.turn.error ?? '');
console.log('after report', after.map((m) => `${m.i}:${m.kind}`).join(' '));
console.log('a reply after the report', after.some((m) => m.kind === 'unii'));
console.log('works for this thread', (await all()).filter((m) => m.kind === 'work' && m.ref === work.ref).length);
console.log('ref', work.ref, 'project', proj.id);
```

Run: `node /tmp/endless-s2/run.mjs | tee /tmp/endless-s2/out.txt`

Expected:
- `first turn idle`, and `tools called` includes `mcp__memory__spawn_agent`.
- `work` text starts with `[Read notes] report: ` and contains `alpha-7 is the build code.`; `project` is `true`; `ref` is a terminal id.
- `thread` shows `inProject: true` and a config with `"origin":"endless"`, `"role":"agent"`, `"agentType":"researcher"`, `"model":"haiku"`.
- `second turn idle`; `after report` holds at least one `unii` (the turn that the report started); `a reply after the report true`.
- `works for this thread 1`.

If `first turn` is still running when the report arrives, the report is handed off instead. That is also correct; record which path ran.

- [ ] **Step 4: Restart check (Review Focus 1, live)**

```bash
lsof -ti :3999 | xargs kill
sleep 2
HOME=/tmp/endless-s2/home PORT=3999 DISPATCH_WEB_DIST="$PWD/packages/web/dist" \
  node packages/core/dist/server.js > /tmp/endless-s2/daemon2.log 2>&1 &
sleep 8
curl -s 'http://127.0.0.1:3999/api/endless/messages?limit=200' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).messages;console.log("works",m.filter(x=>x.kind==="work").length)})'
sqlite3 "$(find /tmp/endless-s2/home -name dispatch.db | head -1)" 'SELECT COUNT(*) FROM endless_pending_reports'
```

Expected: `works 1` and `0`.

- [ ] **Step 5: Check the UI**

Browse to http://localhost:3999 (with the Playwright browser tools, or by hand). Open Chat mode. Check each item, and take one screenshot of each:
1. The report shows as a work card that starts with `[Read notes] report:`.
2. The Projects panel shows `scratch` with the report text as its last report.
3. A click on the card switches to the workspace with the project `scratch` active and the thread "Read notes" open.

- [ ] **Step 6: Tear down and report**

```bash
lsof -ti :3999 | xargs kill
```

Report the `out.txt` lines, the restart counts, the three UI results, and which path ran (a new turn or a hand-off). Do not commit scratch files.

---

## Self-review

**Spec coverage (stage 2):**

| Spec item / ruling | Task |
|---|---|
| §1 stage 2: `spawn_agent`, `message_thread`, ledger tools reused from agency-mcp | 1 (shared helpers), 7 (ledger route), 8 (tools) |
| Ruling 1: tools scoped to all projects with an explicit `project` (name or id), a clear error on unknown/ambiguous, no `DISPATCH_SESSION`, fixed text | 5, 8 (`not.toContain('DISPATCH_SESSION')`, no-date check) |
| Ruling 1: `read_agent` | 1 (`readAgentOutput`), 8 |
| Ruling 1: `watch_thread` "if useful" | Not added. A watch wakes a watcher terminal, and Chat is not a terminal. The report mechanism replaces it, and the prompt forbids polling. |
| Ruling 2: Chat-started threads marked (`config.origin = 'endless'`) | 1 (`buildWorkerCreateBody`), 8 (spawn passes it) |
| §6.4 / ruling 3: one `work` message `[Label] report: …`, clipped head + tail, project = thread's project, ref = terminal id, through appendLogged + broadcast; once, also across a restart; persisted marker | 3 (table + claim), 6 (`reportThread`, recovery) |
| §6.4: threads not started by Chat never report | 6 (`a thread Chat did not start … never reports`), 2 (no Control Plane cross-talk) |
| Ruling 3: completion from the existing settled event, no background scan | 6 (`addThreadSettledListener` + `onWatchStatus` error edge) |
| Ruling 4: a report starts a turn when idle; a hand-off when running; several reports → one process; reuse the runner's queue | 4 |
| Ruling 5: the Control Plane's harness/model defaults | 1 (`createWorker` → worker-defaults route), 8 |
| Ruling 6: the work card opens the right thread; the projects panel's last report; the status block | 10 (card test, panel reload), 11 (live UI check). The status block needs no change: it does not show the last report. |
| Ruling 7: prompt names the tools (it lists `zoom`/`date`) | 9 |
| §5 render-then-log for a report-started turn | 3 (`turnBlocks(before)`), 4 (the view leaves the report out) |

**Placeholder scan:** each code step holds complete code. Task 1 Step 4 moves four existing definitions word for word. Its comment lines name each one and its source, and the agency tests check that the text did not change.

**Type consistency:** `LoggedInput { i, kind: 'work', text, project }` is the same in Task 4 and in `reportThread` (Task 6). `LogOptions { claim }` is the same in `log.ts` (Task 3) and `EndlessService.log` (Task 6). `WorkerSpec` (Task 1) is what `memory-mcp.ts` passes in Task 8. `ProjectRef { id, name, folder }` (Task 5) is the `/project` body that `spawn_agent` reads (`project.id`, `project.name`, `project.folder`). `finalOutput(terminalId): string` is the same in `SessionService` (Task 2) and in `EndlessServiceOptions` (Task 6).

**Review Focus tests present:** (1) restart duplicates: Task 6, two tests, plus the Task 11 Step 4 live check; (2) report racing a user send: Task 4; (3) unknown/ambiguous project: Task 5 + Task 8; (4) a thread that dies without output: Task 6, plus `reportText` for `error`; (5) two reports at once: Task 4 + Task 6.

**Decisions and items that do not map fully (for the controller):**
- **Ledger tools are a subset.** The ledger rules make the project's Control Plane the only writer, and the quote checks read the Control Plane's user messages (`coordinator_messages`). Chat's user words are in `endless_messages`. So Chat gets `ledger_list`, `ledger_show`, `ledger_add` (source kind `user` not available), `ledger_resolve` (`withdrawn` only) and `ledger_set_title`, and it acts as the project's overseer. `ledger_note`, `ledger_decide_self`, `ledger_import`, `ledger_add_from_agent`, `ledger_mark_default`, and resolving `answered`/`parked` are not mapped. They need a decision on a quote source for Chat. A project without a Control Plane has no ledger writer, and Chat says so.
- **Report arming.** A Chat thread owes a report each time Chat sends it work (`spawn_agent`, or `message_thread` to a Chat thread). A turn that the user starts by typing in the thread directly does not report. Each settle without a pending row is silent.
- **`needs_input` reports.** A Chat thread that stops to ask (AskUserQuestion, or a turn that ends with a question) reports `(waiting for an answer) …`. Its questions do not go to the Control Plane (Task 2), so without this report nobody would hear them.
- **`watch_thread`, `queue_agent`, `complete_agent`, `answer_agent`** are not added (not in the rulings, or replaced by reports).
