# Coordinator Session Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Control Plane coordinator a session menu — Restart (reload tools, keep history), New session (archive + fresh coordinator), Previous sessions (swap an archived coordinator back in).

**Architecture:** One server fix makes `POST /terminals/:id/relaunch` structured-aware (kill the structured transport before respawn). Everything else is web: two `useOverseer` store actions and one shared `CoordinatorMenu` component mounted on three surfaces (desktop composer row, mobile header, Board coordinator lightbox).

**Tech Stack:** TypeScript, Express (packages/core), React + Zustand + Vitest + Testing Library (packages/web). Monorepo uses pnpm.

**Spec:** `docs/superpowers/specs/2026-08-05-coordinator-session-controls-design.md`

## Global Constraints

- Branch: `feat/coordinator-session-controls` (already exists; spec committed on it). Never push to main; stop at "PR open, CI reported".
- Test commands: `pnpm --filter dispatch-server test`, `pnpm --filter dispatch-web test`. Run a focused file with `pnpm --filter dispatch-server exec vitest run src/sessions/restart-structured.test.ts`.
- Known flake: the core suite occasionally exits nonzero with 0 failures (~1 in 5 runs). If every test shows PASS but the exit code is nonzero, re-run once before investigating.
- `api.restoreTerminal` ALREADY EXISTS (`packages/web/src/api/client.ts:102`) — do not add it again. So do `relaunchTerminal` (:101), `stopTerminal` (:105), `archiveTerminal` (:106), `listArchivedTerminals` (:45).
- Verified, no action needed: archived coordinators never pollute the WorkRail — `groupByMission` filters archived rows through `isStructuredWorker` (`packages/web/src/components/overseer/live.ts:386`), which excludes `config.role === 'coordinator'` (live.ts:96-100).
- Match surrounding comment style (comments explain WHY, in the codebase's voice).

---

### Task 1: Structured-aware `restartTerminal` (core)

**Files:**
- Modify: `packages/core/src/sessions/service.ts:821-840` (the `restartTerminal` method)
- Test: `packages/core/src/sessions/restart-structured.test.ts` (create)

**Interfaces:**
- Consumes: existing private helpers in the same class — `isStructuredTerminal(terminal: terminalsDb.TerminalRow): boolean` (service.ts:864) and `killCurrentTransport(type: string, terminalId: string, current: 'structured' | 'pty'): Promise<void>` (service.ts:1502).
- Produces: `restartTerminal(terminalId)` now actually restarts a live structured thread. `POST /api/terminals/:id/relaunch` (routes/terminals.ts:299) needs no change.

Background: today `restartTerminal` kills only via `this.ptyManager`. A live structured thread is not in the PTY manager, so the kill is skipped and `relaunchTerminal → spawnTerminal → spawnStructured` bails at `if (manager.isAlive(terminal.id)) return;` (service.ts:1764) — a silent no-op.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/sessions/restart-structured.test.ts`. The harness is copied from `switch-transport.test.ts` (same fakes), with one addition: `FakeStructured.spawn` captures its `opts` so the resume args are assertable.

```typescript
// restartTerminal for STRUCTURED threads — regression test for the silent no-op:
// the old implementation killed only via ptyManager, so a live structured thread was
// never killed and spawnStructured bailed on `manager.isAlive` — relaunch did nothing.
// The coordinator "Restart session" menu action rides this path, and a respawn is what
// re-reads the MCP config (a structured process loads its tools once, at spawn).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import type { IStructuredManager, StructuredSpawnOpts } from '../structured/manager.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  spawns: string[] = [];
  kills: string[] = [];
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.kills.push(id); if (this.alive.delete(id)) this.emit('exit', id, 0); }
  spawn(id: string) { this.spawns.push(id); this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  spawns: string[] = [];
  spawnOpts: Record<string, StructuredSpawnOpts> = {};
  kills: string[] = [];
  setDefaultEnv() {}
  spawn(id: string, opts: StructuredSpawnOpts) { this.live.add(id); this.spawns.push(id); this.spawnOpts[id] = opts; return 4321; }
  sendMessage() {}
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.kills.push(id); this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let pty: FakePty;
let structured: FakeStructured;

function seed(id: string, opts: { config?: Record<string, any>; externalId?: string | null } = {}) {
  terminalsDb.create(db, {
    id,
    sessionId: 's1',
    type: 'claude-code',
    label: id,
    workingDir: path.join(dir, 'proj'),
    externalId: opts.externalId === undefined ? 'ext-1' : opts.externalId ?? undefined,
    config: opts.config ?? {},
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-restart-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty();
  structured = new FakeStructured();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
  // Deterministic spawn command (and the seam that still appends `-r <id>` on resume).
  svc.setStructuredCommandOverride({ command: 'fake-claude', args: ['--fake'] });
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('restartTerminal — structured thread (the coordinator Restart action)', () => {
  it('kills the LIVE structured session, then respawns it resuming the same conversation', async () => {
    seed('t1', { config: { transport: 'structured', role: 'coordinator' } });
    structured.live.add('t1'); // a live structured process backs the thread

    const out = await svc.restartTerminal('t1');

    expect(structured.kills).toEqual(['t1']);              // the old process died…
    expect(structured.spawns).toEqual(['t1']);             // …and a fresh one spawned
    expect(structured.spawnOpts['t1'].args).toContain('-r');
    expect(structured.spawnOpts['t1'].args).toContain('ext-1'); // same conversation
    expect(out?.id).toBe('t1');
  });

  it('respawns a DEAD structured thread too (restart never strands a stopped coordinator)', async () => {
    seed('t2', { config: { transport: 'structured', role: 'coordinator' } });
    // not in structured.live — process already gone (e.g. stopped via /stop)

    await svc.restartTerminal('t2');

    expect(structured.spawns).toEqual(['t2']);
    expect(structured.spawnOpts['t2'].args).toContain('-r');
  });

  it('still restarts a plain PTY thread through the PTY manager (unchanged behavior)', async () => {
    seed('t3', { config: {} });
    pty.alive.add('t3');

    await svc.restartTerminal('t3');

    expect(pty.kills).toContain('t3');
    expect(pty.spawns).toEqual(['t3']);
    expect(structured.spawns).toEqual([]); // structured manager untouched
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/sessions/restart-structured.test.ts`
Expected: the first two tests FAIL — `structured.kills` is `[]` and `structured.spawns` is `[]` (the no-op). The PTY test PASSES (existing behavior).

(`StructuredSpawnOpts` is exported from `packages/core/src/structured/manager.ts:80` — verified.)

- [ ] **Step 3: Implement — replace `restartTerminal`**

In `packages/core/src/sessions/service.ts`, replace the whole method (lines 821-840):

```typescript
  /** Restart a thread: kill the running process (if any) and re-spawn it fresh. */
  async restartTerminal(terminalId: string): Promise<terminalsDb.Terminal | null> {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return null;
    if (!terminalsDb.isPtyType(terminal.type)) return terminalsDb.rowToTerminal(terminal);

    // Kill whichever transport actually backs the thread. A structured thread lives in
    // its manager, not the PTY table — killing only via ptyManager left it alive, and
    // spawnStructured bails while the manager still reports alive, making relaunch a
    // silent no-op. The respawn is what re-reads the MCP config (tools load at spawn),
    // so the coordinator's "Restart session" action depends on this kill landing.
    const current = this.isStructuredTerminal(terminal) ? ('structured' as const) : ('pty' as const);
    await this.killCurrentTransport(terminal.type, terminalId, current);
    return this.relaunchTerminal(terminalId);
  }
```

Note: this deletes the old inline kill-and-await block for the PTY case. `killCurrentTransport` (service.ts:1502) does the same bounded await via `awaitExit`, and its not-alive branch (`kill` then return) matches `PtyManager.kill`'s tolerance for dead ids — `switchTransport` already relies on exactly that.

- [ ] **Step 4: Run the test file to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/sessions/restart-structured.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Run the whole core suite (restart touches a shared path)**

Run: `pnpm --filter dispatch-server test`
Expected: all pass. Remember the known flake (Global Constraints) — nonzero exit with 0 failures → re-run once.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/sessions/restart-structured.test.ts
git commit -m "fix(core): make terminal relaunch kill the structured transport too

A live structured thread was never killed by restartTerminal (PTY-only kill),
so spawnStructured bailed on isAlive and POST /terminals/:id/relaunch was a
silent no-op. Kill the backing transport via killCurrentTransport, then
relaunch — the respawn resumes the same conversation (-r) and re-reads the
MCP config, which is what the coordinator Restart action needs.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `useOverseer` store actions — `newCoordinatorSession` / `resumeCoordinatorSession`

**Files:**
- Modify: `packages/web/src/components/overseer/store.ts` (interface near line 147; implementation right after `ensureForProject`, which ends at line 353)
- Test: `packages/web/src/components/overseer/store-session-actions.test.ts` (create)

**Interfaces:**
- Consumes: `api.archiveTerminal(id)`, `api.restoreTerminal(id)`, `api.ensureOverseerCoordinator(sessionId)` (all exist in `packages/web/src/api/client.ts`); the store's own `ensureForProject` (store.ts:317) and its guard `if (st.coordinatorProject === sessionId && (st.coordinatorId || st.ensuring)) return;` (store.ts:320); `useTabs` (already imported in store.ts).
- Produces (Task 3 calls these exact signatures):
  - `newCoordinatorSession(sessionId: string, currentTerminalId: string): Promise<void>`
  - `resumeCoordinatorSession(sessionId: string, currentTerminalId: string, archivedTerminalId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/overseer/store-session-actions.test.ts`:

```typescript
// Coordinator session swaps (the CoordinatorMenu actions). Invariant under test:
// at most ONE active coordinator per project — so the current one is archived
// BEFORE any restore/ensure, and a failed archive aborts without touching state.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverseer } from './store';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  // ensureForProject refreshes the project's threads; stub it out of the way.
  useTabs.setState({ loadTabs: vi.fn().mockResolvedValue(undefined) } as never);
  useOverseer.setState({ coordinatorProject: 'proj-1', coordinatorId: 'coord-1', ensuring: false } as never);
});

describe('newCoordinatorSession — archive current, then find-or-create fresh', () => {
  it('archives the current coordinator and lands on the freshly ensured one', async () => {
    const archive = vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'fresh-1' });

    await useOverseer.getState().newCoordinatorSession('proj-1', 'coord-1');

    expect(archive).toHaveBeenCalledWith('coord-1');
    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('fresh-1'));
    expect(ensure).toHaveBeenCalledWith('proj-1');
  });

  it('a failed archive aborts — the current session stays intact', async () => {
    vi.spyOn(api, 'archiveTerminal').mockRejectedValue(new Error('boom'));
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator');

    await useOverseer.getState().newCoordinatorSession('proj-1', 'coord-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(useOverseer.getState().coordinatorId).toBe('coord-1');
  });

  it('does not touch the store when the view moved to ANOTHER project mid-flight', async () => {
    vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator');
    useOverseer.setState({ coordinatorProject: 'proj-2', coordinatorId: 'coord-2' } as never);

    await useOverseer.getState().newCoordinatorSession('proj-1', 'coord-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(useOverseer.getState().coordinatorId).toBe('coord-2'); // untouched
  });
});

describe('resumeCoordinatorSession — swap an archived coordinator back in', () => {
  it('archives the current coordinator BEFORE restoring, then points the store at the restored id', async () => {
    const archive = vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    const restore = vi.spyOn(api, 'restoreTerminal').mockResolvedValue({ id: 'old-1' } as never);

    await useOverseer.getState().resumeCoordinatorSession('proj-1', 'coord-1', 'old-1');

    expect(archive).toHaveBeenCalledWith('coord-1');
    expect(restore).toHaveBeenCalledWith('old-1');
    // Order: archive strictly before restore (one active coordinator per project).
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
    expect(useOverseer.getState().coordinatorId).toBe('old-1');
    expect(useOverseer.getState().coordinatorStream).toEqual([]); // view reset for the swap
  });

  it('falls back to a FRESH coordinator when the restore fails (never zero coordinators)', async () => {
    vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, 'restoreTerminal').mockRejectedValue(new Error('gone'));
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'fresh-2' });

    await useOverseer.getState().resumeCoordinatorSession('proj-1', 'coord-1', 'old-1');

    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('fresh-2'));
    expect(ensure).toHaveBeenCalledWith('proj-1');
  });

  it('a failed archive aborts the swap entirely', async () => {
    vi.spyOn(api, 'archiveTerminal').mockRejectedValue(new Error('boom'));
    const restore = vi.spyOn(api, 'restoreTerminal');

    await useOverseer.getState().resumeCoordinatorSession('proj-1', 'coord-1', 'old-1');

    expect(restore).not.toHaveBeenCalled();
    expect(useOverseer.getState().coordinatorId).toBe('coord-1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/overseer/store-session-actions.test.ts`
Expected: FAIL — `newCoordinatorSession is not a function` (and the same for `resumeCoordinatorSession`).

- [ ] **Step 3: Implement the two actions**

In `packages/web/src/components/overseer/store.ts`:

(a) In the `OverseerState` interface, directly under the `ensureForProject` declaration (line 147), add:

```typescript
  /** "New session": archive the current coordinator, then find-or-create a fresh one now. */
  newCoordinatorSession: (sessionId: string, currentTerminalId: string) => Promise<void>;
  /** "Previous sessions" swap: archive the current coordinator FIRST, then restore the chosen
   *  archived one (preserves the one-active-coordinator-per-project invariant). */
  resumeCoordinatorSession: (sessionId: string, currentTerminalId: string, archivedTerminalId: string) => Promise<void>;
```

(b) In the store implementation, directly after the `ensureForProject` action (its closing `},` is at line 353), add:

```typescript
  newCoordinatorSession: async (sessionId, currentTerminalId) => {
    // Archive first; a failure here means the current session is fully intact — abort.
    try { await api.archiveTerminal(currentTerminalId); } catch { return; }
    if (get().coordinatorProject !== sessionId) return; // view moved on mid-flight
    // Clear the guard fields so ensureForProject actually runs (it bails while a
    // coordinatorId is loaded) — it then resets the view + find-or-creates fresh.
    set({ coordinatorId: null, ensuring: false });
    get().ensureForProject(sessionId);
  },

  resumeCoordinatorSession: async (sessionId, currentTerminalId, archivedTerminalId) => {
    // Order matters: archive the current coordinator BEFORE restoring, or the project
    // briefly holds two active coordinators and ensureCoordinator's find-first pick
    // becomes order-dependent.
    try { await api.archiveTerminal(currentTerminalId); } catch { return; }
    let restored = true;
    try { await api.restoreTerminal(archivedTerminalId); } catch { restored = false; }
    if (get().coordinatorProject !== sessionId) return; // view moved on mid-flight
    if (!restored) {
      // The archived row wouldn't come back (e.g. daemon hiccup) — never leave the
      // project with ZERO active coordinators; fall back to a fresh one.
      set({ coordinatorId: null, ensuring: false });
      get().ensureForProject(sessionId);
      return;
    }
    // Point the view at the restored thread; reset the same derived fields
    // ensureForProject resets so the stream remounts cleanly on the new id.
    set({
      coordinatorId: archivedTerminalId,
      coordinatorStream: [],
      coordinatorBusy: false,
      coordinatorContextTokens: undefined,
      coordinatorCompacting: false,
      coordinatorCompactResult: null,
      coordinatorApiRetry: null,
      coordinatorModel: undefined,
      coordinatorHasMore: true,
      coordinatorLoadingOlder: false,
      coordinatorLoadOlder: () => {},
      coordinatorPending: null,
      coordinatorAnswer: () => {},
      sendError: null,
      ensuring: false,
    });
    void useTabs.getState().loadTabs(sessionId).catch(() => {});
  },
```

If any of the reset field names has drifted from `ensureForProject`'s reset block (store.ts:322-341), copy the current names from there — the two blocks must reset the same view fields (minus `resolved`/`pendingByTerminal`, which stay: the project's workers are unchanged by a coordinator swap).

- [ ] **Step 4: Run the test file to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/overseer/store-session-actions.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/overseer/store.ts packages/web/src/components/overseer/store-session-actions.test.ts
git commit -m "feat(web): overseer store actions for coordinator session swap

newCoordinatorSession archives the current coordinator then find-or-creates a
fresh one; resumeCoordinatorSession swaps an archived coordinator back in
(archive current first — one active coordinator per project).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `CoordinatorMenu` component

**Files:**
- Modify: `packages/web/src/components/overseer/components/AutonomyControls.tsx:17-25` (export the scheme tokens)
- Modify: `packages/web/src/components/overseer/atoms.tsx` (register three missing icon names)
- Create: `packages/web/src/components/overseer/components/CoordinatorMenu.tsx`
- Test: `packages/web/src/components/overseer/components/CoordinatorMenu.test.tsx` (create)

**Interfaces:**
- Consumes: `SCHEMES` / `Scheme` from AutonomyControls (exported in this task); store actions from Task 2 (`newCoordinatorSession(sessionId, currentTerminalId)`, `resumeCoordinatorSession(sessionId, currentTerminalId, archivedTerminalId)`); `api.relaunchTerminal(id)`, `api.listArchivedTerminals(sessionId)`.
- Produces: `CoordinatorMenu({ terminalId, sessionId, scheme?: 'scoped' | 'global', direction?: 'up' | 'down' })` — Task 4 mounts exactly this.

- [ ] **Step 1: Export the scheme tokens from AutonomyControls**

In `packages/web/src/components/overseer/components/AutonomyControls.tsx`, change lines 17-25 so the shared tokens are importable (values unchanged):

```typescript
export type Mode = 'supervised' | 'autonomous';
export type Scheme = 'scoped' | 'global';

export interface Tokens { border: string; dim: string; accent: string; accentFg: string; surface: string; danger: string; }

export const SCHEMES: Record<Scheme, Tokens> = {
  scoped: { border: 'var(--border)', dim: 'var(--ts)', accent: 'var(--acc)', accentFg: '#06140B', surface: 'var(--elev)', danger: 'var(--red)' },
  global: { border: 'var(--color-border)', dim: 'var(--color-text-secondary)', accent: 'var(--color-accent)', accentFg: '#06140B', surface: 'var(--color-elevated)', danger: 'var(--color-status-red)' },
};
```

(`Mode` may stay unexported if nothing else needs it — only add `export` where the new component imports it: `Scheme`, `Tokens`, `SCHEMES`.)

- [ ] **Step 2: Write the failing test**

Create `packages/web/src/components/overseer/components/CoordinatorMenu.test.tsx`:

```tsx
// CoordinatorMenu — the Control Plane session menu (Restart / New session / Previous
// sessions). Coordinator semantics differ from worker Stop/Archive: Restart relaunches
// in place (same conversation, tools re-read at spawn); New session and Previous
// sessions go through the store's swap actions (one active coordinator per project).
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../../../api/client';
import { useOverseer } from '../store';
import { CoordinatorMenu } from './CoordinatorMenu';

const newSession = vi.fn().mockResolvedValue(undefined);
const resumeSession = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.restoreAllMocks();
  newSession.mockClear();
  resumeSession.mockClear();
  useOverseer.setState({
    newCoordinatorSession: newSession,
    resumeCoordinatorSession: resumeSession,
  } as never);
});
afterEach(cleanup);

const mount = () => render(<CoordinatorMenu terminalId="coord-1" sessionId="proj-1" />);
const openMenu = () => fireEvent.click(screen.getByTitle('Session menu'));

describe('CoordinatorMenu — Restart', () => {
  it('relaunches the coordinator in place', async () => {
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue({ id: 'coord-1' } as never);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Restart session'));
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledWith('coord-1'));
    expect(newSession).not.toHaveBeenCalled();
  });
});

describe('CoordinatorMenu — New session (two-step confirm)', () => {
  it('the first click only arms the confirm — nothing is archived yet', () => {
    mount();
    openMenu();
    fireEvent.click(screen.getByText('New session…'));
    expect(newSession).not.toHaveBeenCalled();
    expect(screen.getByText(/End this session\?/)).toBeInTheDocument();
  });

  it('Confirm runs the store swap; Cancel disarms', async () => {
    mount();
    openMenu();
    fireEvent.click(screen.getByText('New session…'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(/End this session\?/)).not.toBeInTheDocument();
    expect(newSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('New session…'));
    fireEvent.click(screen.getByText('Confirm'));
    await vi.waitFor(() => expect(newSession).toHaveBeenCalledWith('proj-1', 'coord-1'));
  });
});

describe('CoordinatorMenu — Previous sessions', () => {
  it('lists only archived COORDINATORS and swaps the chosen one in', async () => {
    vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([
      { id: 'old-1', type: 'claude-code', config: { role: 'coordinator' }, archivedAt: '2026-08-01T10:00:00Z' },
      { id: 'w-1', type: 'claude-code', config: { role: 'agent' }, archivedAt: '2026-08-02T10:00:00Z' },
    ] as never);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Previous sessions…'));
    const row = await screen.findByText(/Archived .*2026/); // one coordinator row
    expect(screen.queryAllByText(/Archived /)).toHaveLength(1); // the worker is filtered out
    fireEvent.click(row);
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledWith('proj-1', 'coord-1', 'old-1'));
  });

  it('shows an empty state when no archived coordinators exist', async () => {
    vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([] as never);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Previous sessions…'));
    expect(await screen.findByText('No previous sessions.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/overseer/components/CoordinatorMenu.test.tsx`
Expected: FAIL — cannot resolve `./CoordinatorMenu`.

- [ ] **Step 4: Implement the component**

Create `packages/web/src/components/overseer/components/CoordinatorMenu.tsx`:

```tsx
// Overseer — coordinator session menu (the ⋯ kebab): Restart / New session / Previous
// sessions. Workers get Stop/Archive (AutonomyControls); the coordinator gets THIS
// instead because its semantics differ:
//   Restart          → POST /terminals/:id/relaunch — kill + respawn now, SAME
//                      conversation (`-r` resume + backfill). The respawn re-reads the
//                      MCP config, so this is the one-click "reload tools" fix.
//   New session…     → archive (soft delete) + find-or-create a fresh coordinator,
//                      via the store swap (two-step inline confirm; no window.confirm —
//                      a browser modal would block the event loop).
//   Previous sessions→ archived coordinators for this project; picking one swaps it
//                      back in (archive current FIRST — one active coordinator).
// Mounted: desktop composer row (direction 'up'), mobile header + Board coordinator
// lightbox (direction 'down'). Scheme-aware like AutonomyControls.

import { useState } from 'react';
import { api } from '../../../api/client';
import type { Terminal } from '../../../api/types';
import { useOverseer } from '../store';
import { Icon } from '../atoms';
import { SCHEMES, type Scheme, type Tokens } from './AutonomyControls';

const itemStyle = (t: Tokens, color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  padding: '7px 9px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.2,
  textAlign: 'left' as const,
  cursor: 'pointer',
  fontFamily: 'inherit',
});

export function CoordinatorMenu({ terminalId, sessionId, scheme = 'scoped', direction = 'down' }: {
  terminalId: string;
  sessionId: string;
  scheme?: Scheme;
  direction?: 'up' | 'down';
}) {
  const t = SCHEMES[scheme];
  const newCoordinatorSession = useOverseer((s) => s.newCoordinatorSession);
  const resumeCoordinatorSession = useOverseer((s) => s.resumeCoordinatorSession);
  const [open, setOpen] = useState(false);
  const [confirmingNew, setConfirmingNew] = useState(false);
  const [previous, setPrevious] = useState<Terminal[] | null>(null); // null = list closed
  const [busy, setBusy] = useState(false);

  const close = () => { setOpen(false); setConfirmingNew(false); setPrevious(null); setBusy(false); };

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); close(); }
    catch { setBusy(false); } // keep the menu open so the failure is visible
  };

  const openPrevious = async () => {
    setConfirmingNew(false);
    try {
      const all = await api.listArchivedTerminals(sessionId);
      setPrevious(all.filter((x) => x.type === 'claude-code' && x.config?.role === 'coordinator'));
    } catch { setPrevious([]); }
  };

  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title="Session menu"
        aria-label="Session menu"
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: t.surface,
          border: `1px solid ${t.border}`,
          color: t.dim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <Icon name="ph-dots-three" weight="bold" size={16} color={t.dim} />
      </button>

      {open && (
        <>
          {/* click-away scrim (transparent) — closes without stealing the next click's target */}
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 69 }} />
          <div
            style={{
              position: 'absolute',
              right: 0,
              [direction === 'up' ? 'bottom' : 'top']: 'calc(100% + 6px)',
              zIndex: 70,
              minWidth: 230,
              padding: 4,
              borderRadius: 10,
              background: t.surface,
              border: `1px solid ${t.border}`,
              boxShadow: '0 12px 32px -12px rgba(0,0,0,.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              opacity: busy ? 0.7 : 1,
            }}
          >
            <button
              type="button"
              onClick={() => void run(() => api.relaunchTerminal(terminalId))}
              disabled={busy}
              title="Restart — reload tools and connections; history is kept"
              style={itemStyle(t, t.dim)}
            >
              <Icon name="ph-arrow-clockwise" size={13} color={t.dim} />
              Restart session
            </button>

            {confirmingNew ? (
              <div style={{ padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11.5, color: t.dim, lineHeight: 1.4 }}>
                  End this session? A fresh one starts now. The old conversation is archived.
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => void run(() => newCoordinatorSession(sessionId, terminalId))} disabled={busy}
                    style={{ ...itemStyle(t, t.danger), width: 'auto', border: `1px solid ${t.border}` }}>
                    Confirm
                  </button>
                  <button type="button" onClick={() => setConfirmingNew(false)} disabled={busy}
                    style={{ ...itemStyle(t, t.dim), width: 'auto', border: `1px solid ${t.border}` }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setPrevious(null); setConfirmingNew(true); }}
                disabled={busy}
                title="End this session and start a fresh one (the old one is archived)"
                style={itemStyle(t, t.danger)}
              >
                <Icon name="ph-sparkle" size={13} color={t.danger} />
                New session…
              </button>
            )}

            {previous === null ? (
              <button type="button" onClick={() => void openPrevious()} disabled={busy}
                title="Swap a previously archived session back in" style={itemStyle(t, t.dim)}>
                <Icon name="ph-clock-counter-clockwise" size={13} color={t.dim} />
                Previous sessions…
              </button>
            ) : previous.length === 0 ? (
              <span style={{ padding: '7px 9px', fontSize: 11.5, color: t.dim }}>No previous sessions.</span>
            ) : (
              previous.map((p) => (
                <button key={p.id} type="button" onClick={() => void run(() => resumeCoordinatorSession(sessionId, terminalId, p.id))}
                  disabled={busy} title="Resume this session (the current one is archived, not lost)"
                  style={itemStyle(t, t.dim)}>
                  <Icon name="ph-clock-counter-clockwise" size={13} color={t.dim} />
                  {`Archived ${p.archivedAt ? new Date(p.archivedAt).toLocaleString() : 'earlier'}`}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

Two facts already verified against the codebase (no need to re-derive): the web `Terminal` type has `archivedAt: string | null` (`packages/web/src/api/types.ts:21`), and `ph-arrow-clockwise` is already in the atoms icon map. The other three icon names are NOT registered yet — register them in `packages/web/src/components/overseer/atoms.tsx`: add `DotsThree`, `Sparkle`, and `ClockCounterClockwise` to the existing `@phosphor-icons/react` import at the top of the file, and add these entries to the icon map object (alongside `'ph-arrow-clockwise': ArrowClockwise` at line 65):

```typescript
  'ph-dots-three': DotsThree,
  'ph-sparkle': Sparkle,
  'ph-clock-counter-clockwise': ClockCounterClockwise,
```

- [ ] **Step 5: Run the test file to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/overseer/components/CoordinatorMenu.test.tsx`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/overseer/components/AutonomyControls.tsx packages/web/src/components/overseer/atoms.tsx packages/web/src/components/overseer/components/CoordinatorMenu.tsx packages/web/src/components/overseer/components/CoordinatorMenu.test.tsx
git commit -m "feat(web): CoordinatorMenu — Restart / New session / Previous sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mount the menu on all three coordinator surfaces

**Files:**
- Modify: `packages/web/src/components/overseer/components/Composer.tsx` (desktop + mobile composer row)
- Modify: `packages/web/src/components/overseer/OverseerMobile.tsx` (consolidated header)
- Modify: `packages/web/src/components/overseer/WorkerLightbox.tsx` (the Board lightbox — NOT `components/WorkerLightbox.tsx`)

**Interfaces:**
- Consumes: `CoordinatorMenu` (Task 3), `coordinatorMatchesView` (store.ts:50), `useProjects` (`packages/web/src/stores/projects`).
- Produces: nothing new — mounts only.

- [ ] **Step 1: Mount in the Composer input row (desktop + mobile composer)**

In `packages/web/src/components/overseer/components/Composer.tsx`:

(a) Add imports (merge into the existing import block):

```typescript
import { useOverseer, useComposerImages, coordinatorMatchesView } from '../store';
import { useProjects } from '../../../stores/projects';
import { CoordinatorMenu } from './CoordinatorMenu';
```

(b) Inside `Composer()`, next to the existing selectors (after line 89 `const coordinatorProject = ...`):

```typescript
  const coordinatorId = useOverseer((s) => s.coordinatorId);
  const activeId = useProjects((s) => s.activeId);
  // Same cross-tab gate as every coordinator read: never show (or act on) a coordinator
  // that belongs to another project while an ensureForProject swap is in flight.
  const showSessionMenu = !!coordinatorId && !!coordinatorProject && coordinatorMatchesView(coordinatorProject, activeId);
```

(c) In the JSX input row, directly AFTER the send button (`</button>` at line 327, before the row's closing `</div>`):

```tsx
        {/* session menu (⋯) — Restart / New session / Previous sessions. Opens upward:
            the composer sits at the bottom of the pane. */}
        {showSessionMenu && (
          <CoordinatorMenu terminalId={coordinatorId} sessionId={coordinatorProject} scheme="scoped" direction="up" />
        )}
```

- [ ] **Step 2: Mount in the mobile consolidated header**

In `packages/web/src/components/overseer/OverseerMobile.tsx`:

(a) Add imports:

```typescript
import { useOverseer, useRenderVals, coordinatorMatchesView } from './store';
import { useProjects } from '../../stores/projects';
import { CoordinatorMenu } from './components/CoordinatorMenu';
```

(b) Inside `OverseerMobile()`, with the other selectors (after line 71 `const setMobileTab = ...`):

```typescript
  const coordinatorId = useOverseer((s) => s.coordinatorId);
  const coordinatorProject = useOverseer((s) => s.coordinatorProject);
  const activeId = useProjects((s) => s.activeId);
  const showSessionMenu = !!coordinatorId && !!coordinatorProject && coordinatorMatchesView(coordinatorProject, activeId);
```

(c) In the header JSX, directly BEFORE `<NeedsAlert />` (line 120 — NeedsAlert stays rightmost so its popover keeps right-anchoring):

```tsx
        {showSessionMenu && (
          <CoordinatorMenu terminalId={coordinatorId} sessionId={coordinatorProject} scheme="scoped" direction="down" />
        )}
```

- [ ] **Step 3: Mount in the Board coordinator lightbox**

In `packages/web/src/components/overseer/WorkerLightbox.tsx` (the file BoardView uses — global scheme):

(a) Add import:

```typescript
import { CoordinatorMenu } from './components/CoordinatorMenu';
```

(b) In the header JSX, directly AFTER `<InterruptButton terminalId={terminalId} scheme="global" />` (line 131):

```tsx
          {/* coordinator-only session menu — workers get Stop/Archive in the overseer
              lightbox instead; the coordinator's swap semantics live in this menu. */}
          {isCoordinator && terminal && (
            <CoordinatorMenu terminalId={terminalId} sessionId={terminal.sessionId} scheme="global" direction="down" />
          )}
```

- [ ] **Step 4: Typecheck + run the full web suite**

Run: `pnpm --filter dispatch-web exec tsc -b`
Expected: clean (no output).

Run: `pnpm --filter dispatch-web test`
Expected: all pass — including the pre-existing `Stream.test.tsx` and `store.test.ts` (the mounts must not disturb them).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/overseer/components/Composer.tsx packages/web/src/components/overseer/OverseerMobile.tsx packages/web/src/components/overseer/WorkerLightbox.tsx
git commit -m "feat(web): mount the coordinator session menu on all three CP surfaces

Desktop composer row (opens upward), mobile consolidated header, and the
Board coordinator lightbox. Gated by coordinatorMatchesView like every
other coordinator read.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full verification + PR (STOP at open PR)

**Files:** none (verification + PR only)

- [ ] **Step 1: Run both full suites**

```bash
pnpm --filter dispatch-server test
pnpm --filter dispatch-web test
```

Expected: all pass (core flake caveat in Global Constraints).

- [ ] **Step 2: Push the branch and open the PR**

```bash
git push -u origin feat/coordinator-session-controls
gh pr create --title "feat: coordinator session controls (Restart / New session / Previous sessions)" --body "$(cat <<'EOF'
## Summary
- **Server:** `POST /terminals/:id/relaunch` now kills the structured transport before respawning (was a silent no-op for live structured threads). The respawn resumes the same conversation (`-r`) and re-reads the MCP config — the one-click "reload tools" fix for a coordinator holding a stale tool set.
- **Web:** new `CoordinatorMenu` (⋯) on the desktop composer row, the mobile header, and the Board coordinator lightbox:
  - **Restart session** — relaunch in place, history kept, tools reloaded.
  - **New session…** — inline confirm → archive the coordinator → a fresh one is find-or-created immediately.
  - **Previous sessions…** — archived coordinators for the project; picking one swaps it back in (archive current first — one active coordinator per project).

Spec: `docs/superpowers/specs/2026-08-05-coordinator-session-controls-design.md`

## Test plan
- [ ] `restart-structured.test.ts`: live structured kill→respawn with `-r`, dead-thread respawn, PTY path unchanged
- [ ] `store-session-actions.test.ts`: swap ordering (archive before restore), failure aborts, restore-failure fallback, mid-flight project switch
- [ ] `CoordinatorMenu.test.tsx`: restart call, two-step confirm, coordinator-only archived list, empty state
- [ ] Full core + web suites green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report CI status and STOP**

Watch CI with `gh pr checks --watch` and report the result. Do NOT merge and do NOT deploy — merge and deploy each require explicit per-action user approval.
