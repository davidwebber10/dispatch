# Auto-Archive Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a thread be marked at creation (or later) as an Auto-Archive Thread with an inactivity deadline (default 12 hours); when it goes that long without doing anything, it archives itself and disappears from the sidebar.

**Architecture:** The policy rides in the existing `terminals.config` JSON blob (`{ autoArchive: true, autoArchiveMs: 43200000 }`) — no schema migration. A 60-second sweep loop in core scans opted-in threads, skips any the system or user is blocked on, and archives the rest by calling the **same** `SessionService.removeTerminal()` that the DELETE route calls, emitting the same `terminal:removed` + `session:tabs-changed` frames the frontend already handles. The frontend gets a unified New Thread modal, a context-menu editor, and a countdown badge.

**Tech Stack:** TypeScript, Express, better-sqlite3, React 18, Zustand, Vitest (+ jsdom / Testing Library for web), `@phosphor-icons/react`.

**Spec:** `docs/superpowers/specs/2026-07-14-auto-archive-threads-design.md`

## Global Constraints

- **Opt-in only.** A thread with no `autoArchive` in its config must behave exactly as it does today. Never sweep a thread that did not opt in.
- **Skip table is authoritative.** Sweep `waiting` and `error` only. Never sweep `working`, `queued`, `scheduled`, or `needs_input`.
- **`terminalsDb.updateConfig` REPLACES the whole config blob** (`packages/core/src/db/terminals.ts:148`). Every config write must read-merge-write. Never PATCH a partial config from the client.
- **Do not modify** `packages/core/src/terminal-monitor.ts`, `packages/core/src/status/service.ts`, or `packages/core/src/db/sessions.ts`. The `last_activity_at` semantics work (commits `5040276`..`dda806a`) owns those files; this feature only *reads* `last_activity_at`.
- **Never break unpin.** `useTabs.setPinned` (`packages/web/src/stores/tabs.ts:97`) relies on `PATCH /api/terminals/:id` replacing config wholesale so it can *delete* the `pinned` key. Do not change `updateTab`'s replace semantics.
- Styling is **inline styles + CSS custom properties** (`var(--color-accent)`, `var(--color-text-tertiary)`, …). This codebase does **not** use Tailwind.
- Default deadline: **12 hours** = `43_200_000` ms.
- Run tests from the package dir: `cd packages/core && npx vitest run <path>` / `cd packages/web && npx vitest run <path>`.

---

### Task 1: Core — auto-archive policy + sweep tick

The heart of the feature. Pure functions plus a tick that can be driven directly in tests with no timers.

**Files:**
- Create: `packages/core/src/sessions/auto-archive.ts`
- Create: `packages/core/src/sessions/auto-archive.test.ts`

**Interfaces:**
- Consumes: `terminalsDb.rowToTerminal`, `terminalsDb.getById`, `SessionService.removeTerminal(id)` (`sessions/service.ts:1123`), `EventBroadcaster.broadcast()`.
- Produces:
  - `readonly DEFAULT_AUTO_ARCHIVE_MS = 43_200_000`
  - `interface AutoArchivePolicy { autoArchive: true; autoArchiveMs: number }`
  - `getAutoArchiveMs(config: Record<string, any>): number | null`
  - `withAutoArchive(config, enabled: boolean, ms?: number): Record<string, any>`
  - `SWEEPABLE_STATUSES: readonly string[]`
  - `autoArchiveTick(db, sessionService, broadcaster, now?): string[]` (returns archived ids)
  - `startAutoArchiveLoop(db, sessionService, broadcaster, intervalMs?): NodeJS.Timeout`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/sessions/auto-archive.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import {
  DEFAULT_AUTO_ARCHIVE_MS,
  getAutoArchiveMs,
  withAutoArchive,
  autoArchiveTick,
} from './auto-archive.js';

const fakePty = { isAlive: () => false, kill: () => {} } as any;
const fakeBroadcaster = { broadcast: () => {} } as any;

let dir: string;
let db: Database.Database;
let svc: SessionService;

/** Create a thread with an explicit status, config and last_activity_at. */
function seedThread(id: string, opts: {
  status?: string;
  config?: Record<string, any>;
  idleMs?: number;          // how long ago it was last active
} = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: id, config: opts.config ?? {} });
  if (opts.status) terminalsDb.updateStatus(db, id, opts.status);
  const at = new Date(Date.now() - (opts.idleMs ?? 0)).toISOString();
  db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(at, id);
}

const archived = (id: string) => !!terminalsDb.getById(db, id)?.archived_at;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-autoarchive-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: '/tmp/proj' });
  svc = new SessionService(db, fakePty, path.join(dir, 'mcp.json'));
});
afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('auto-archive policy helpers', () => {
  it('reads a policy off a config blob', () => {
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 1000 })).toBe(1000);
  });

  it('defaults to 12 hours when enabled with no explicit duration', () => {
    expect(getAutoArchiveMs({ autoArchive: true })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(DEFAULT_AUTO_ARCHIVE_MS).toBe(43_200_000);
  });

  it('returns null for a thread that did not opt in', () => {
    expect(getAutoArchiveMs({})).toBeNull();
    expect(getAutoArchiveMs({ autoArchive: false, autoArchiveMs: 1000 })).toBeNull();
    expect(getAutoArchiveMs({ transport: 'structured' })).toBeNull();
  });

  it('ignores a non-positive or non-numeric duration', () => {
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 0 })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: -5 })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 'soon' as any })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
  });

  it('merges the policy onto an existing config without dropping other keys', () => {
    const next = withAutoArchive({ transport: 'structured', role: 'agent' }, true, 60_000);
    expect(next).toEqual({ transport: 'structured', role: 'agent', autoArchive: true, autoArchiveMs: 60_000 });
  });

  it('strips both policy keys when disabled, preserving the rest', () => {
    const next = withAutoArchive({ transport: 'structured', autoArchive: true, autoArchiveMs: 60_000 }, false);
    expect(next).toEqual({ transport: 'structured' });
  });
});

describe('autoArchiveTick', () => {
  it('archives an opted-in thread that is past its deadline', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual(['t1']);
    expect(archived('t1')).toBe(true);
  });

  it('leaves an opted-in thread that is still inside its deadline', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 30_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
    expect(archived('t1')).toBe(false);
  });

  it('never touches a thread that did not opt in, however old', () => {
    seedThread('t1', { status: 'waiting', config: {}, idleMs: 999 * 24 * 3600_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
    expect(archived('t1')).toBe(false);
  });

  it('never touches a thread whose config blob is malformed', () => {
    seedThread('t1', { status: 'waiting', config: {}, idleMs: 120_000 });
    db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run('{not json', 't1');
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
    expect(archived('t1')).toBe(false);
  });

  it('archives an errored thread (nobody is blocked on it)', () => {
    seedThread('t1', { status: 'error', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual(['t1']);
    expect(archived('t1')).toBe(true);
  });

  it.each(['working', 'queued', 'scheduled', 'needs_input'])(
    'never archives a %s thread, however idle — something is blocked on it',
    (status) => {
      seedThread('t1', { status, config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 999 * 3600_000 });
      expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
      expect(archived('t1')).toBe(false);
    },
  );

  it('never re-archives an already-archived thread', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    terminalsDb.archive(db, 't1');
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual([]);
  });

  it('falls back to created_at when the thread never recorded activity', () => {
    // A thread that has never done anything has a NULL last_activity_at; measuring
    // from created_at is the correct conservative reading.
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't1', config: { autoArchive: true, autoArchiveMs: 60_000 } });
    db.prepare('UPDATE terminals SET last_activity_at = NULL, created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 120_000).toISOString(), 't1');
    expect(autoArchiveTick(db, svc, fakeBroadcaster)).toEqual(['t1']);
  });

  it('broadcasts terminal:removed and session:tabs-changed for each archived thread', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    const sent: any[] = [];
    autoArchiveTick(db, svc, { broadcast: (m: any) => sent.push(m) } as any);
    expect(sent).toEqual([
      { type: 'terminal:removed', terminalId: 't1', sessionId: 's1' },
      { type: 'session:tabs-changed', sessionId: 's1' },
    ]);
  });

  it('keeps sweeping after one thread fails to archive', () => {
    seedThread('t1', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    seedThread('t2', { status: 'waiting', config: { autoArchive: true, autoArchiveMs: 60_000 }, idleMs: 120_000 });
    const exploding = {
      removeTerminal: (id: string) => {
        if (id === 't1') throw new Error('pty refuses to die');
        svc.removeTerminal(id);
      },
    } as any;
    expect(autoArchiveTick(db, exploding, fakeBroadcaster)).toEqual(['t2']);
    expect(archived('t2')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/sessions/auto-archive.test.ts`
Expected: FAIL — `Failed to resolve import "./auto-archive.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/sessions/auto-archive.ts`:

```ts
import type Database from 'better-sqlite3';
import type { SessionService } from './service.js';
import type { EventBroadcaster } from '../ws/events.js';
import * as terminalsDb from '../db/terminals.js';

/** Default inactivity deadline: 12 hours. */
export const DEFAULT_AUTO_ARCHIVE_MS = 43_200_000;

const DEFAULT_INTERVAL_MS = 60_000;

export interface AutoArchivePolicy {
  autoArchive: true;
  autoArchiveMs: number;
}

/**
 * A thread is swept only when NOBODY is blocked on it — not the system, not the
 * user. 'working' is mid-turn (a thinking agent can be silent for a long time);
 * 'queued' is waiting on a dependsOn agent; 'scheduled' is parked for a future
 * wake; 'needs_input' is blocked on the user at a permission prompt. Archiving
 * any of those would kill work somebody is still waiting for.
 */
export const SWEEPABLE_STATUSES: readonly string[] = ['waiting', 'error'];

/**
 * The thread's deadline in ms, or null if it never opted in. An enabled policy
 * with a missing/invalid duration falls back to the 12h default rather than
 * being treated as "archive immediately".
 */
export function getAutoArchiveMs(config: Record<string, any>): number | null {
  if (!config || config.autoArchive !== true) return null;
  const ms = config.autoArchiveMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_AUTO_ARCHIVE_MS;
  return ms;
}

/**
 * Read-merge-write helper. `terminalsDb.updateConfig` REPLACES the whole blob,
 * so callers must never hand it a partial config — doing so would silently drop
 * `transport`, `role`, `agentType`, etc. Disabling strips both keys rather than
 * leaving `autoArchive: false` noise behind.
 */
export function withAutoArchive(
  config: Record<string, any>,
  enabled: boolean,
  ms: number = DEFAULT_AUTO_ARCHIVE_MS,
): Record<string, any> {
  const next = { ...(config ?? {}) };
  if (enabled) {
    next.autoArchive = true;
    next.autoArchiveMs = (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? ms : DEFAULT_AUTO_ARCHIVE_MS;
  } else {
    delete next.autoArchive;
    delete next.autoArchiveMs;
  }
  return next;
}

/**
 * One sweep pass (exported for tests — no timers involved). Archives every
 * opted-in thread that is past its inactivity deadline and that nothing is
 * blocked on. Returns the ids it archived.
 *
 * Archiving goes through SessionService.removeTerminal — the SAME method the
 * DELETE route calls — so auto-archive and manual archive are one operation and
 * cannot drift. It emits the same two frames the DELETE route emits, which the
 * frontend already handles, so the sidebar row vanishes live.
 */
export function autoArchiveTick(
  db: Database.Database,
  sessionService: Pick<SessionService, 'removeTerminal'>,
  broadcaster: EventBroadcaster,
  now: number = Date.now(),
): string[] {
  const archived: string[] = [];

  let rows: terminalsDb.TerminalRow[];
  try {
    rows = db.prepare('SELECT * FROM terminals WHERE archived_at IS NULL').all() as terminalsDb.TerminalRow[];
  } catch {
    return archived; // DB closed mid-shutdown — nothing to do
  }

  for (const row of rows) {
    // One bad thread must never abort the sweep for the rest.
    try {
      const terminal = terminalsDb.rowToTerminal(row);   // malformed config parses to {}
      const deadlineMs = getAutoArchiveMs(terminal.config);
      if (deadlineMs === null) continue;                 // did not opt in
      if (!SWEEPABLE_STATUSES.includes(terminal.status)) continue;

      const lastActive = Date.parse(terminal.lastActivityAt);
      if (!Number.isFinite(lastActive)) continue;        // unparseable clock — leave it alone
      if (now - lastActive < deadlineMs) continue;       // still inside its lease

      sessionService.removeTerminal(terminal.id);
      archived.push(terminal.id);
      broadcaster.broadcast({ type: 'terminal:removed', terminalId: terminal.id, sessionId: terminal.sessionId });
      broadcaster.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    } catch (err) {
      console.error(`auto-archive: failed to sweep terminal ${row.id}`, err);
    }
  }

  return archived;
}

/** Start the sweep loop. Returns the interval id for cleanup. */
export function startAutoArchiveLoop(
  db: Database.Database,
  sessionService: SessionService,
  broadcaster: EventBroadcaster,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    try {
      autoArchiveTick(db, sessionService, broadcaster);
    } catch (err) {
      console.error('auto-archive sweep failed', err);
    }
  }, intervalMs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/sessions/auto-archive.test.ts`
Expected: PASS — all tests green (the `it.each` produces 4 skip-table cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/auto-archive.ts packages/core/src/sessions/auto-archive.test.ts
git commit -m "feat(core): auto-archive policy helpers and idle sweep tick"
```

---

### Task 2: Core — register the sweep loop

Wire the loop into the daemon beside the three existing loops, and clear it on shutdown.

**Files:**
- Modify: `packages/core/src/server.ts` (import; register near line 516; clear in `cleanup()` near line 529)

**Interfaces:**
- Consumes: `startAutoArchiveLoop` from Task 1.
- Produces: nothing new — the running daemon now sweeps every 60s.

- [ ] **Step 1: Add the import**

In `packages/core/src/server.ts`, alongside the other `sessions/` imports:

```ts
import { startAutoArchiveLoop } from './sessions/auto-archive.js';
```

- [ ] **Step 2: Register the loop**

Immediately after the `agentSchedulerInterval` block (currently `server.ts:516-522`):

```ts
  // Auto-archive sweep — prunes opted-in threads that have gone idle past their
  // deadline. Cheap: one indexed read of a small table per minute.
  const autoArchiveInterval = startAutoArchiveLoop(db, sessionService, broadcaster);
```

- [ ] **Step 3: Clear it on shutdown**

In `cleanup()` (currently `server.ts:525-538`), beside the other `clearInterval` calls:

```ts
    clearInterval(autoArchiveInterval);
```

- [ ] **Step 4: Verify the daemon still builds and boots**

Run: `cd packages/core && npx tsc --noEmit`
Expected: exit 0, no output.

Run: `cd packages/core && npx vitest run`
Expected: PASS — the full core suite, including the new auto-archive tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/server.ts
git commit -m "feat(core): run the auto-archive sweep every 60s"
```

---

### Task 3: Core — `setAutoArchive` service method + PATCH route

The context-menu editor needs to change a thread's policy **without** clobbering the rest of its config. `PATCH /api/terminals/:id` cannot be used for this: `updateTab` (`service.ts:444-450`) passes `fields.config` straight to `updateConfig`, which replaces the whole blob — PATCHing a partial config onto a structured thread would wipe `transport: 'structured'`, `role`, `agentType`, `model`. And it cannot be made to merge, because `useTabs.setPinned` (`web/src/stores/tabs.ts:97`) *depends* on replace semantics to delete the `pinned` key on unpin.

So: a dedicated endpoint that merges server-side.

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (add method after `updateTab`, ~line 450)
- Modify: `packages/core/src/routes/terminals.ts` (add route after the PATCH at ~line 275)
- Modify: `packages/core/tests/routes/terminals.test.ts` (append tests)

**Interfaces:**
- Consumes: `withAutoArchive`, `DEFAULT_AUTO_ARCHIVE_MS` from Task 1.
- Produces:
  - `SessionService.setAutoArchive(terminalId: string, enabled: boolean, ms?: number): terminalsDb.Terminal | null`
  - `PATCH /api/terminals/:terminalId/auto-archive` body `{ enabled: boolean, ms?: number }` → `200 Terminal` | `404`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/tests/routes/terminals.test.ts` (follow the file's existing `createApp({ db, skipPty: true })` + supertest setup):

```ts
describe('PATCH /api/terminals/:terminalId/auto-archive', () => {
  it('enables auto-archive without clobbering the rest of the config', async () => {
    const created = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'claude-code', label: 'quick q', config: { transport: 'structured', role: 'agent' } })
      .expect(201);

    const res = await request(app)
      .patch(`/api/terminals/${created.body.id}/auto-archive`)
      .send({ enabled: true, ms: 60_000 })
      .expect(200);

    expect(res.body.config).toEqual({
      transport: 'structured',
      role: 'agent',
      autoArchive: true,
      autoArchiveMs: 60_000,
    });
  });

  it('defaults to 12 hours when no duration is given', async () => {
    const created = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'shell', label: 'sh' })
      .expect(201);

    const res = await request(app)
      .patch(`/api/terminals/${created.body.id}/auto-archive`)
      .send({ enabled: true })
      .expect(200);

    expect(res.body.config.autoArchiveMs).toBe(43_200_000);
  });

  it('disabling strips both policy keys and keeps the rest', async () => {
    const created = await request(app)
      .post(`/api/sessions/${sessionId}/terminals`)
      .send({ type: 'claude-code', config: { transport: 'structured', autoArchive: true, autoArchiveMs: 60_000 } })
      .expect(201);

    const res = await request(app)
      .patch(`/api/terminals/${created.body.id}/auto-archive`)
      .send({ enabled: false })
      .expect(200);

    expect(res.body.config).toEqual({ transport: 'structured' });
  });

  it('404s for an unknown terminal', async () => {
    await request(app)
      .patch('/api/terminals/nope/auto-archive')
      .send({ enabled: true })
      .expect(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/routes/terminals.test.ts`
Expected: FAIL — the PATCH returns 404 (route does not exist) where 200 is expected.

- [ ] **Step 3: Add the service method**

In `packages/core/src/sessions/service.ts`, import at the top:

```ts
import { withAutoArchive, DEFAULT_AUTO_ARCHIVE_MS } from './auto-archive.js';
```

and add immediately after `updateTab` (which ends at line 450):

```ts
  /**
   * Turn a thread's auto-archive policy on or off. Merges server-side: the
   * generic PATCH /terminals/:id replaces the config blob wholesale (and must
   * keep doing so — unpin relies on it), so a partial config from the client
   * would silently drop `transport`, `role`, `agentType`, etc.
   */
  setAutoArchive(terminalId: string, enabled: boolean, ms: number = DEFAULT_AUTO_ARCHIVE_MS): terminalsDb.Terminal | null {
    const row = terminalsDb.getById(this.db, terminalId);
    if (!row) return null;
    const current = terminalsDb.rowToTerminal(row).config;   // malformed blob parses to {}
    terminalsDb.updateConfig(this.db, terminalId, withAutoArchive(current, enabled, ms));
    return terminalsDb.rowToTerminal(terminalsDb.getById(this.db, terminalId)!);
  }
```

- [ ] **Step 4: Add the route**

In `packages/core/src/routes/terminals.ts`, immediately after the existing `PATCH /terminals/:terminalId` handler (ends line 275):

```ts
  // PATCH /api/terminals/:terminalId/auto-archive — merge the auto-archive policy
  // server-side. Deliberately NOT the generic PATCH above: that one replaces the
  // whole config blob (unpin depends on it), which would wipe transport/role/etc.
  router.patch('/terminals/:terminalId/auto-archive', (req, res) => {
    const { enabled, ms } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (ms !== undefined && (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)) {
      return res.status(400).json({ error: 'ms must be a positive number' });
    }
    const terminal = sessionService.setAutoArchive(req.params.terminalId, enabled, ms);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    res.json(terminal);
  });
```

> **Route-order note:** Express matches in registration order. `/terminals/:terminalId/auto-archive` is a distinct path from `/terminals/:terminalId`, so it does not shadow or get shadowed. No reordering needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/routes/terminals.test.ts`
Expected: PASS — including the four new cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/terminals.ts packages/core/tests/routes/terminals.test.ts
git commit -m "feat(core): PATCH /terminals/:id/auto-archive merges policy server-side"
```

---

### Task 4: Web — duration formatting + countdown math

One small module so the modal, the editor, and the badge all agree. Pure functions, no React.

**Files:**
- Create: `packages/web/src/lib/autoArchive.ts`
- Create: `packages/web/src/lib/autoArchive.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_AUTO_ARCHIVE_MS = 43_200_000`
  - `type DurationUnit = 'minutes' | 'hours' | 'days'`
  - `UNIT_MS: Record<DurationUnit, number>`
  - `toDuration(ms: number): { value: number; unit: DurationUnit }`
  - `fromDuration(value: number, unit: DurationUnit): number`
  - `getAutoArchiveMs(config: Record<string, unknown>): number | null`
  - `formatRemaining(ms: number): string`
  - `remainingMs(lastActivityAt: string, autoArchiveMs: number, now?: number): number`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/autoArchive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTO_ARCHIVE_MS, toDuration, fromDuration, getAutoArchiveMs, formatRemaining, remainingMs,
} from './autoArchive';

describe('toDuration', () => {
  it('picks the largest unit that divides evenly', () => {
    expect(toDuration(43_200_000)).toEqual({ value: 12, unit: 'hours' });
    expect(toDuration(1_800_000)).toEqual({ value: 30, unit: 'minutes' });
    expect(toDuration(172_800_000)).toEqual({ value: 2, unit: 'days' });
  });

  it('falls back to minutes when nothing divides evenly', () => {
    expect(toDuration(90 * 60_000)).toEqual({ value: 90, unit: 'minutes' });
  });
});

describe('fromDuration', () => {
  it('round-trips with toDuration', () => {
    expect(fromDuration(12, 'hours')).toBe(DEFAULT_AUTO_ARCHIVE_MS);
    expect(fromDuration(30, 'minutes')).toBe(1_800_000);
    expect(fromDuration(2, 'days')).toBe(172_800_000);
  });
});

describe('getAutoArchiveMs', () => {
  it('reads an enabled policy', () => {
    expect(getAutoArchiveMs({ autoArchive: true, autoArchiveMs: 60_000 })).toBe(60_000);
  });
  it('defaults to 12h when enabled with no duration', () => {
    expect(getAutoArchiveMs({ autoArchive: true })).toBe(DEFAULT_AUTO_ARCHIVE_MS);
  });
  it('returns null when not opted in', () => {
    expect(getAutoArchiveMs({})).toBeNull();
    expect(getAutoArchiveMs({ autoArchive: false })).toBeNull();
  });
});

describe('remainingMs', () => {
  it('counts down from the last activity', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const last = '2026-07-14T11:00:00.000Z';                 // 1h ago
    expect(remainingMs(last, 43_200_000, now)).toBe(11 * 3600_000);
  });

  it('clamps to zero once past the deadline', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    expect(remainingMs('2026-07-13T12:00:00.000Z', 3600_000, now)).toBe(0);
  });
});

describe('formatRemaining', () => {
  it('renders a compact countdown', () => {
    expect(formatRemaining(11 * 3600_000)).toBe('11h');
    expect(formatRemaining(90 * 60_000)).toBe('1h');
    expect(formatRemaining(45 * 60_000)).toBe('45m');
    expect(formatRemaining(3 * 24 * 3600_000)).toBe('3d');
  });

  it('shows <1m rather than 0m on the last stretch', () => {
    expect(formatRemaining(30_000)).toBe('<1m');
    expect(formatRemaining(0)).toBe('<1m');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/lib/autoArchive.test.ts`
Expected: FAIL — `Failed to resolve import "./autoArchive"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/autoArchive.ts`:

```ts
/** Default inactivity deadline: 12 hours. Mirrors core's DEFAULT_AUTO_ARCHIVE_MS. */
export const DEFAULT_AUTO_ARCHIVE_MS = 43_200_000;

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const UNIT_MS: Record<DurationUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/**
 * Render ms as the largest unit that divides evenly, so a stored 43_200_000
 * reads back as "12 hours" rather than "720 minutes". The policy is stored in
 * ms precisely so the unit picker stays presentational.
 */
export function toDuration(ms: number): { value: number; unit: DurationUnit } {
  for (const unit of ['days', 'hours'] as const) {
    if (ms % UNIT_MS[unit] === 0) return { value: ms / UNIT_MS[unit], unit };
  }
  return { value: Math.max(1, Math.round(ms / UNIT_MS.minutes)), unit: 'minutes' };
}

export function fromDuration(value: number, unit: DurationUnit): number {
  return value * UNIT_MS[unit];
}

/** The thread's deadline in ms, or null if it never opted in. */
export function getAutoArchiveMs(config: Record<string, unknown>): number | null {
  if (!config || config.autoArchive !== true) return null;
  const ms = config.autoArchiveMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_AUTO_ARCHIVE_MS;
  return ms;
}

/** Time left before the thread archives itself. Clamped at zero. */
export function remainingMs(lastActivityAt: string, autoArchiveMs: number, now: number = Date.now()): number {
  const last = Date.parse(lastActivityAt);
  if (!Number.isFinite(last)) return autoArchiveMs;
  return Math.max(0, last + autoArchiveMs - now);
}

/** Compact countdown for the sidebar badge: "3d", "11h", "45m", "<1m". */
export function formatRemaining(ms: number): string {
  if (ms >= UNIT_MS.days) return `${Math.floor(ms / UNIT_MS.days)}d`;
  if (ms >= UNIT_MS.hours) return `${Math.floor(ms / UNIT_MS.hours)}h`;
  if (ms >= UNIT_MS.minutes) return `${Math.floor(ms / UNIT_MS.minutes)}m`;
  return '<1m';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/lib/autoArchive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/autoArchive.ts packages/web/src/lib/autoArchive.test.ts
git commit -m "feat(web): auto-archive duration and countdown helpers"
```

---

### Task 5: Web — API client + types

**Files:**
- Modify: `packages/web/src/api/client.ts` (add beside `archiveTerminal`, ~line 90)

**Interfaces:**
- Produces: `api.setAutoArchive(id: string, enabled: boolean, ms?: number): Promise<Terminal>`

- [ ] **Step 1: Add the client method**

In `packages/web/src/api/client.ts`, next to `archiveTerminal` (line 90):

```ts
  setAutoArchive: (id: string, enabled: boolean, ms?: number) =>
    req<Terminal>(`/api/terminals/${id}/auto-archive`, { method: 'PATCH', body: body({ enabled, ...(ms !== undefined ? { ms } : {}) }) }),
```

> `Terminal.config` is already `Record<string, unknown>` (`api/types.ts:31`) and `lastActivityAt?: string` already exists (`:30`), so **no type changes are needed**. The policy keys are read through `getAutoArchiveMs` from Task 4, never off a typed field.

- [ ] **Step 2: Verify it typechecks**

Run: `cd packages/web && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api/client.ts
git commit -m "feat(web): api.setAutoArchive"
```

---

### Task 6: Web — the auto-archive form control

The toggle + `[12] [hours ▾]` control is used by **two** callers (the New Thread modal in Task 7 and the context-menu editor in Task 8). Build it once.

**Files:**
- Create: `packages/web/src/components/sidebar/AutoArchiveField.tsx`
- Create: `packages/web/src/components/sidebar/AutoArchiveField.test.tsx`

**Interfaces:**
- Consumes: `toDuration`, `fromDuration`, `DEFAULT_AUTO_ARCHIVE_MS`, `UNIT_MS`, `DurationUnit` from Task 4.
- Produces:
  ```ts
  interface AutoArchiveFieldProps {
    enabled: boolean;
    ms: number;
    onChange: (enabled: boolean, ms: number) => void;
  }
  export function AutoArchiveField(props: AutoArchiveFieldProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sidebar/AutoArchiveField.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoArchiveField } from './AutoArchiveField';
import { DEFAULT_AUTO_ARCHIVE_MS } from '../../lib/autoArchive';

describe('AutoArchiveField', () => {
  it('hides the duration input when the toggle is off', () => {
    render(<AutoArchiveField enabled={false} ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={() => {}} />);
    expect(screen.queryByLabelText('Inactivity before archiving')).not.toBeInTheDocument();
  });

  it('reveals the duration input, defaulted to 12 hours, when toggled on', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AutoArchiveField enabled={false} ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    expect(onChange).toHaveBeenCalledWith(true, DEFAULT_AUTO_ARCHIVE_MS);

    rerender(<AutoArchiveField enabled ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);
    expect((screen.getByLabelText('Inactivity before archiving') as HTMLInputElement).value).toBe('12');
    expect((screen.getByLabelText('Inactivity unit') as HTMLSelectElement).value).toBe('hours');
  });

  it('emits the new duration in ms when the value changes', () => {
    const onChange = vi.fn();
    render(<AutoArchiveField enabled ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Inactivity before archiving'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(true, 3 * 3_600_000);
  });

  it('emits the new duration in ms when the unit changes', () => {
    const onChange = vi.fn();
    render(<AutoArchiveField enabled ms={DEFAULT_AUTO_ARCHIVE_MS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Inactivity unit'), { target: { value: 'minutes' } });
    expect(onChange).toHaveBeenCalledWith(true, 12 * 60_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/sidebar/AutoArchiveField.test.tsx`
Expected: FAIL — `Failed to resolve import "./AutoArchiveField"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/sidebar/AutoArchiveField.tsx`:

```tsx
import { Timer } from '@phosphor-icons/react';
import { DEFAULT_AUTO_ARCHIVE_MS, UNIT_MS, toDuration, fromDuration, type DurationUnit } from '../../lib/autoArchive';

interface AutoArchiveFieldProps {
  enabled: boolean;
  ms: number;
  onChange: (enabled: boolean, ms: number) => void;
}

const UNITS: DurationUnit[] = ['minutes', 'hours', 'days'];

/**
 * The auto-archive toggle + duration control, shared by the New Thread modal and
 * the context-menu editor. The stored value is always ms; the unit picker is
 * presentational (toDuration picks the unit that reads most naturally).
 */
export function AutoArchiveField({ enabled, ms, onChange }: AutoArchiveFieldProps) {
  const { value, unit } = toDuration(ms || DEFAULT_AUTO_ARCHIVE_MS);

  const input: React.CSSProperties = {
    height: 32, width: 64, padding: '0 8px', background: 'var(--color-elevated)', border: '1px solid #2C2C32',
    borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13,
  };

  return (
    <div style={{ marginTop: 14, padding: 12, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <Timer size={16} weight="fill" color="var(--color-text-tertiary)" />
        <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text-primary)' }}>Auto-archive thread</span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Auto-archive thread"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked, ms || DEFAULT_AUTO_ARCHIVE_MS)}
          style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--color-accent)' }}
        />
      </label>

      {enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Archive after</span>
          <input
            type="number"
            min={1}
            aria-label="Inactivity before archiving"
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) onChange(true, fromDuration(n, unit));
            }}
            style={input}
          />
          <select
            aria-label="Inactivity unit"
            value={unit}
            onChange={(e) => onChange(true, fromDuration(value, e.target.value as DurationUnit))}
            style={{ ...input, width: 'auto' }}
          >
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>of inactivity</span>
        </div>
      )}

      {enabled && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Archived automatically once idle this long. It won't be archived while it's working, queued, or waiting on you.
        </div>
      )}
    </div>
  );
}
```

> `UNIT_MS` is imported for the `fromDuration` math it backs; if your linter flags it as unused, drop it from the import list — `fromDuration` already closes over it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/components/sidebar/AutoArchiveField.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sidebar/AutoArchiveField.tsx packages/web/src/components/sidebar/AutoArchiveField.test.tsx
git commit -m "feat(web): shared auto-archive toggle + duration field"
```

---

### Task 7: Web — unified New Thread modal

Today `NewTabMenu` is a four-item dropdown where only two items open a modal (Claude Code PTY and Codex); Claude (structured) and Terminal create instantly. Replace all of it with one modal carrying a type picker, so every type can opt in at creation.

**Files:**
- Create: `packages/web/src/components/sidebar/NewThreadModal.tsx`
- Create: `packages/web/src/components/sidebar/NewThreadModal.test.tsx`
- Modify: `packages/web/src/components/sidebar/NewTabMenu.tsx` (every item now opens the modal)
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (swap the two old modals for the new one)
- Delete: `packages/web/src/components/sidebar/NewClaudeThreadModal.tsx` + `.test.tsx`
- Delete: `packages/web/src/components/sidebar/NewCodexThreadModal.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: `AutoArchiveField` (Task 6), `api.createTerminal`, `api.recentCcSessions`, `useTabs`, `DEFAULT_AUTO_ARCHIVE_MS`.
- Produces:
  ```ts
  export type NewThreadKind = 'claude-code' | 'claude-structured' | 'codex' | 'shell';
  export function NewThreadModal(props: {
    sessionId: string;
    initialKind: NewThreadKind;
    onClose: () => void;
    onCreated: (id: string) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sidebar/NewThreadModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewThreadModal } from './NewThreadModal';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';

vi.mock('../../api/client', () => ({
  api: {
    createTerminal: vi.fn().mockResolvedValue({ id: 't-new' }),
    recentCcSessions: vi.fn().mockResolvedValue([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useTabs.setState({ byProject: {}, loading: {} } as any);
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('NewThreadModal', () => {
  it('creates a plain thread with no auto-archive config by default', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="shell" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.type).toBe('shell');
    expect(input.config?.autoArchive).toBeUndefined();
  });

  it('carries transport:structured for the structured Claude kind', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="claude-structured" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.type).toBe('claude-code');
    expect(input.config.transport).toBe('structured');
  });

  it('posts the auto-archive policy alongside the transport when toggled on', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="claude-structured" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    const [, input] = (api.createTerminal as any).mock.calls[0];
    expect(input.config).toEqual({ transport: 'structured', autoArchive: true, autoArchiveMs: 43_200_000 });
  });

  it('lets the type be changed before creating', async () => {
    render(<NewThreadModal sessionId="s1" initialKind="shell" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Thread type'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: /start new thread/i }));

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    expect((api.createTerminal as any).mock.calls[0][1].type).toBe('codex');
  });

  it('offers RESUME RECENT only for the PTY Claude kind', async () => {
    (api.recentCcSessions as any).mockResolvedValue([
      { id: 'x1', preview: 'earlier chat', mtime: Date.now(), messageCount: 3, truncated: false },
    ]);
    render(<NewThreadModal sessionId="s1" initialKind="claude-code" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('earlier chat')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Thread type'), { target: { value: 'shell' } });
    await waitFor(() => expect(screen.queryByText('earlier chat')).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/sidebar/NewThreadModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./NewThreadModal"`.

- [ ] **Step 3: Write the modal**

Create `packages/web/src/components/sidebar/NewThreadModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { AutoArchiveField } from './AutoArchiveField';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import { DEFAULT_AUTO_ARCHIVE_MS } from '../../lib/autoArchive';
import type { CcRecentSession } from '../../api/types';

export type NewThreadKind = 'claude-code' | 'claude-structured' | 'codex' | 'shell';

/** The four things the New Thread menu offers, and what each maps to on the wire. */
const KINDS: { kind: NewThreadKind; label: string; type: string; config?: Record<string, unknown> }[] = [
  { kind: 'claude-code', label: 'Claude Code', type: 'claude-code' },
  { kind: 'claude-structured', label: 'Claude (structured)', type: 'claude-code', config: { transport: 'structured' } },
  { kind: 'codex', label: 'Codex', type: 'codex' },
  { kind: 'shell', label: 'Terminal', type: 'shell' },
];

export function NewThreadModal({ sessionId, initialKind, onClose, onCreated }: {
  sessionId: string;
  initialKind: NewThreadKind;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<NewThreadKind>(initialKind);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoArchive, setAutoArchive] = useState(false);
  const [autoArchiveMs, setAutoArchiveMs] = useState(DEFAULT_AUTO_ARCHIVE_MS);
  const [recent, setRecent] = useState<CcRecentSession[] | null>(null);

  const spec = KINDS.find((k) => k.kind === kind)!;
  // Resuming an on-disk Claude Code session only makes sense for the PTY kind —
  // that's the only one that takes an externalId today.
  const canResume = kind === 'claude-code';

  useEffect(() => {
    if (!canResume) { setRecent(null); return; }
    let on = true;
    api.recentCcSessions(sessionId).then((r) => { if (on) setRecent(r); }).catch(() => { if (on) setRecent([]); });
    return () => { on = false; };
  }, [sessionId, canResume]);

  async function create(externalId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      // Build the config fresh at creation — nothing to merge with yet.
      const config: Record<string, unknown> = { ...(spec.config ?? {}) };
      if (autoArchive) { config.autoArchive = true; config.autoArchiveMs = autoArchiveMs; }

      const t = await api.createTerminal(sessionId, {
        type: spec.type,
        label: name.trim() || undefined,
        externalId,
        ...(Object.keys(config).length ? { config } : {}),
      });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 36, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 14 };
  const labelStyle: React.CSSProperties = { display: 'block', font: '600 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', marginBottom: 6 };

  return (
    <Modal open onClose={onClose} title="New Thread">
      <label style={labelStyle} htmlFor="new-thread-type">TYPE</label>
      <select id="new-thread-type" aria-label="Thread type" value={kind}
        onChange={(e) => setKind(e.target.value as NewThreadKind)} style={input}>
        {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>

      <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="new-thread-name">NAME</label>
      <input id="new-thread-name" autoFocus style={input} placeholder="Optional" value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />

      <AutoArchiveField
        enabled={autoArchive}
        ms={autoArchiveMs}
        onChange={(enabled, ms) => { setAutoArchive(enabled); setAutoArchiveMs(ms); }}
      />

      <button disabled={busy} onClick={() => void create()}
        style={{ marginTop: 14, height: 38, width: '100%', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
        Start new thread
      </button>

      {canResume && (recent === null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 13, marginTop: 18 }}>
          <Spinner size={13} /> Loading recent sessions…
        </div>
      ) : recent.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ font: '600 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>RESUME RECENT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
            {recent.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => void create(s.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: '9px 11px', cursor: busy ? 'default' : 'pointer' }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.preview}</div>
                <div style={{ marginTop: 3, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                  {timeAgo(new Date(s.mtime).toISOString())} · {s.messageCount}{s.truncated ? '+' : ''} msg{s.messageCount === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null)}
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/components/sidebar/NewThreadModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Rewire `NewTabMenu` so every item opens the modal**

Replace `packages/web/src/components/sidebar/NewTabMenu.tsx` entirely:

```tsx
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NewThreadKind } from './NewThreadModal';

const KINDS: { kind: NewThreadKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'claude-structured', label: 'Claude (structured)' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'shell', label: 'Terminal' },
];

/**
 * The "+" menu. Every type now opens the unified New Thread modal (with that type
 * preselected) rather than some creating instantly — that's what gives every type
 * a place to set auto-archive at creation.
 */
export function NewTabMenu({ onClose, onPick }: { onClose: () => void; onPick: (kind: NewThreadKind) => void }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_W = 184;

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, r.right - MENU_W) });
  }, []);

  return (
    <span ref={anchorRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {createPortal(
        <>
          <div onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden', zIndex: 201, width: MENU_W, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '4px 8px' }}>NEW THREAD</div>
            {KINDS.map((k) => (
              <button key={k.kind} onClick={() => { onClose(); onPick(k.kind); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>
                {k.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
```

- [ ] **Step 6: Rewire `ProjectCard` to the new modal**

In `packages/web/src/components/sidebar/ProjectCard.tsx`:

Replace the two modal imports:

```tsx
// remove:
// import { NewClaudeThreadModal } from './NewClaudeThreadModal';
// import { NewCodexThreadModal } from './NewCodexThreadModal';
// add:
import { NewThreadModal, type NewThreadKind } from './NewThreadModal';
```

Replace the two booleans (currently lines 207-208):

```tsx
// remove:
//   const [newClaude, setNewClaude] = useState(false);
//   const [newCodex, setNewCodex] = useState(false);
// add:
  const [newThread, setNewThread] = useState<NewThreadKind | null>(null);
```

Update **both** `<NewTabMenu … />` usages (currently at lines ~279 and ~373) to the new props:

```tsx
<NewTabMenu
  onClose={() => setMenu(false)}
  onPick={(kind) => setNewThread(kind)}
/>
```

And replace the two rendered modals with one:

```tsx
{newThread && (
  <NewThreadModal
    sessionId={session.id}
    initialKind={newThread}
    onClose={() => setNewThread(null)}
    onCreated={(id) => onSelectTab(id)}
  />
)}
```

> Grep for every remaining reference before building: `grep -rn "newClaude\|newCodex\|NewClaudeThreadModal\|NewCodexThreadModal\|onPickClaude\|onPickCodex\|onCreated=" packages/web/src`. Any `NewTabMenu` prop that no longer exists (`sessionId`, `onCreated`, `onPickClaude`, `onPickCodex`) must go.

- [ ] **Step 7: Delete the two superseded modals**

```bash
git rm packages/web/src/components/sidebar/NewClaudeThreadModal.tsx \
       packages/web/src/components/sidebar/NewClaudeThreadModal.test.tsx \
       packages/web/src/components/sidebar/NewCodexThreadModal.tsx \
       packages/web/src/components/sidebar/NewCodexThreadModal.test.tsx
```

The old `NewTabMenu.test.tsx` asserts the removed instant-create behavior; rewrite it to assert the new contract instead — clicking each of the four items calls `onPick` with the matching kind and does **not** call `api.createTerminal`.

- [ ] **Step 8: Run the web suite**

Run: `cd packages/web && npx vitest run && npx tsc --noEmit`
Expected: PASS, exit 0. Zero references to the deleted modals remain.

- [ ] **Step 9: Commit**

```bash
git add -A packages/web/src/components/sidebar
git commit -m "feat(web): unified New Thread modal with auto-archive at creation"
```

---

### Task 8: Web — context-menu editor for existing threads

This is what lets auto-archive attack the clutter that **already** exists.

**Files:**
- Create: `packages/web/src/components/sidebar/AutoArchiveModal.tsx`
- Create: `packages/web/src/components/sidebar/AutoArchiveModal.test.tsx`
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (context-menu item + state + render)

**Interfaces:**
- Consumes: `AutoArchiveField` (Task 6), `api.setAutoArchive` (Task 5), `getAutoArchiveMs` (Task 4), `useTabs.loadTabs`.
- Produces:
  ```ts
  export function AutoArchiveModal(props: {
    tab: Terminal;
    onClose: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sidebar/AutoArchiveModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoArchiveModal } from './AutoArchiveModal';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import type { Terminal } from '../../api/types';

vi.mock('../../api/client', () => ({
  api: { setAutoArchive: vi.fn().mockResolvedValue({}) },
}));

const tab = (config: Record<string, unknown>): Terminal => ({
  id: 't1', sessionId: 's1', type: 'claude-code', label: 'quick q', pid: null, externalId: null,
  workingDir: null, status: 'waiting', createdAt: '2026-07-14T00:00:00.000Z', config,
  archivedAt: null, sortOrder: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('AutoArchiveModal', () => {
  it('starts off for a thread with no policy', () => {
    render(<AutoArchiveModal tab={tab({ transport: 'structured' })} onClose={() => {}} />);
    expect((screen.getByRole('switch', { name: /auto-archive thread/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('pre-fills the existing policy', () => {
    render(<AutoArchiveModal tab={tab({ autoArchive: true, autoArchiveMs: 3 * 3_600_000 })} onClose={() => {}} />);
    expect((screen.getByRole('switch', { name: /auto-archive thread/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Inactivity before archiving') as HTMLInputElement).value).toBe('3');
  });

  it('saves an enabled policy through the dedicated endpoint', async () => {
    const onClose = vi.fn();
    render(<AutoArchiveModal tab={tab({ transport: 'structured' })} onClose={onClose} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.setAutoArchive).toHaveBeenCalledWith('t1', true, 43_200_000));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('saves a disabled policy (takes a thread off the clock)', async () => {
    render(<AutoArchiveModal tab={tab({ autoArchive: true, autoArchiveMs: 60_000 })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.setAutoArchive).toHaveBeenCalledWith('t1', false, 60_000));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/sidebar/AutoArchiveModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./AutoArchiveModal"`.

- [ ] **Step 3: Write the modal**

Create `packages/web/src/components/sidebar/AutoArchiveModal.tsx`:

```tsx
import { useState } from 'react';
import { Modal } from '../common/Modal';
import { AutoArchiveField } from './AutoArchiveField';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { DEFAULT_AUTO_ARCHIVE_MS, getAutoArchiveMs } from '../../lib/autoArchive';
import type { Terminal } from '../../api/types';

/**
 * Edit an existing thread's auto-archive policy. Saves through the dedicated
 * /auto-archive endpoint, which merges server-side — the generic PATCH replaces
 * the config blob wholesale and would wipe transport/role/agentType.
 */
export function AutoArchiveModal({ tab, onClose }: { tab: Terminal; onClose: () => void }) {
  const existing = getAutoArchiveMs(tab.config);
  const [enabled, setEnabled] = useState(existing !== null);
  const [ms, setMs] = useState(existing ?? DEFAULT_AUTO_ARCHIVE_MS);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api.setAutoArchive(tab.id, enabled, ms);
      await useTabs.getState().loadTabs(tab.sessionId);
      onClose();
    } catch { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Auto-archive thread">
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
        “{tab.label}” will archive itself once it has been idle this long.
      </div>

      <AutoArchiveField enabled={enabled} ms={ms} onChange={(e, m) => { setEnabled(e); setMs(m); }} />

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button onClick={onClose}
          style={{ flex: 1, height: 38, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, color: 'var(--color-text-primary)', fontWeight: 500, fontSize: 14, cursor: 'pointer' }}>
          Cancel
        </button>
        <button disabled={busy} onClick={() => void save()}
          style={{ flex: 1, height: 38, background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
          Save
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Wire it into the thread context menu**

In `packages/web/src/components/sidebar/ProjectCard.tsx`:

Import it:

```tsx
import { AutoArchiveModal } from './AutoArchiveModal';
```

Add state beside the other targets (near line 201):

```tsx
  const [autoArchiveTarget, setAutoArchiveTarget] = useState<Terminal | null>(null);
```

Add the menu item inside the `ctxMenu` portal, **after** the "Branch thread" item and **before** the Archive item (currently lines 429-435), so the destructive action stays last:

```tsx
            {ctxMenu.tab.type !== 'file' && (
              <button onClick={() => { setAutoArchiveTarget(ctxMenu.tab); setCtxMenu(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>
                Auto-archive…
              </button>
            )}
```

Render the modal beside the other modals (near the `ConfirmModal` at line 456):

```tsx
      {autoArchiveTarget && (
        <AutoArchiveModal tab={autoArchiveTarget} onClose={() => setAutoArchiveTarget(null)} />
      )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/sidebar/AutoArchiveModal.test.tsx && npx tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/sidebar/AutoArchiveModal.tsx packages/web/src/components/sidebar/AutoArchiveModal.test.tsx packages/web/src/components/sidebar/ProjectCard.tsx
git commit -m "feat(web): auto-archive editor on the thread context menu"
```

---

### Task 9: Web — countdown badge on the thread row

**Files:**
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (`ThreadRow`, lines 54-133)
- Create: `packages/web/src/components/sidebar/ThreadRow.autoArchive.test.tsx`

**Interfaces:**
- Consumes: `getAutoArchiveMs`, `remainingMs`, `formatRemaining` (Task 4).
- Produces: nothing consumed elsewhere.

The right-hand status slot (`ProjectCard.tsx:117-133`) is a mutually-exclusive chain: hover-× → working spinner → needs-attention dot → `timeAgo`. The countdown **replaces `timeAgo`** for auto-archive threads: both are derived from `lastActivityAt`, so showing "2h ago" *and* "10h left" is redundant, and "time until it disappears" is the more useful of the two. Layout is unchanged, so this cannot reintroduce the label-offset bug.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sidebar/ThreadRow.autoArchive.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import type { Session, Terminal } from '../../api/types';

const session: Session = {
  id: 's1', provider: 'claude-code', name: 'proj', notes: '', status: 'waiting',
  workingDir: '/tmp/proj', tags: [], pid: null, createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z', lastActivityAt: '2026-07-14T00:00:00.000Z', archivedAt: null,
};

const thread = (id: string, config: Record<string, unknown>, lastActivityAt: string): Terminal => ({
  id, sessionId: 's1', type: 'claude-code', label: id, pid: null, externalId: null, workingDir: null,
  status: 'waiting', createdAt: lastActivityAt, lastActivityAt, config, archivedAt: null, sortOrder: 0,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('ThreadRow auto-archive badge', () => {
  it('shows the countdown instead of timeAgo for an auto-archive thread', () => {
    useTabs.setState({
      byProject: {
        s1: [thread('t1', { autoArchive: true, autoArchiveMs: 43_200_000 }, '2026-07-14T11:00:00.000Z')],
      },
      loading: {},
    } as any);

    render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
    // Idle 1h of a 12h lease → 11h left.
    expect(screen.getByText('11h')).toBeInTheDocument();
    expect(screen.getByTitle(/archives after 12 hours of inactivity/i)).toBeInTheDocument();
  });

  it('shows plain timeAgo for a thread with no policy', () => {
    useTabs.setState({
      byProject: { s1: [thread('t1', {}, '2026-07-14T11:00:00.000Z')] },
      loading: {},
    } as any);

    render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
    expect(screen.queryByTitle(/archives after/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/sidebar/ThreadRow.autoArchive.test.tsx`
Expected: FAIL — no element with text `11h` / no `title` matching `archives after`.

- [ ] **Step 3: Add a shared 60s ticker**

Append to `packages/web/src/lib/autoArchive.ts`:

```ts
import { useEffect, useState } from 'react';

/**
 * One shared 60-second tick for every countdown badge, so N rows don't each hold
 * their own timer. Returns the current epoch ms.
 */
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
```

- [ ] **Step 4: Render the badge in `ThreadRow`**

In `packages/web/src/components/sidebar/ProjectCard.tsx`, add the imports:

```tsx
import { Timer } from '@phosphor-icons/react';
import { getAutoArchiveMs, remainingMs, formatRemaining, toDuration, useMinuteTick } from '../../lib/autoArchive';
```

Inside `ThreadRow`, after `const iconSlot = …` (line 72):

```tsx
  // Auto-archive threads trade their timeAgo for a countdown: both derive from
  // lastActivityAt, and "how long until this disappears" is the more useful read.
  const now = useMinuteTick();
  const autoArchiveMs = getAutoArchiveMs(tab.config);
  const left = autoArchiveMs === null ? null : remainingMs(tab.lastActivityAt ?? tab.createdAt, autoArchiveMs, now);
```

Then replace the final `timeAgo` branch of the status chain (line 131) with:

```tsx
        ) : left !== null && autoArchiveMs !== null ? (
          <span
            title={`Archives after ${toDuration(autoArchiveMs).value} ${toDuration(autoArchiveMs).unit} of inactivity`}
            style={{ display: 'flex', alignItems: 'center', gap: 3, font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: showActive ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}
          >
            <Timer size={isMobile ? 12 : 10} weight="fill" />
            {formatRemaining(left)}
          </span>
        ) : (
          <span style={{ font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: showActive ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{timeAgo(tab.lastActivityAt ?? tab.createdAt)}</span>
        )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/sidebar/ThreadRow.autoArchive.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/autoArchive.ts packages/web/src/components/sidebar/ProjectCard.tsx packages/web/src/components/sidebar/ThreadRow.autoArchive.test.tsx
git commit -m "feat(web): idle countdown badge on auto-archive threads"
```

---

### Task 10: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Core suite + typecheck**

Run: `cd packages/core && npx vitest run && npx tsc --noEmit`
Expected: all green, exit 0.

- [ ] **Step 2: Web suite + typecheck + build**

Run: `cd packages/web && npx vitest run && npx tsc --noEmit && npx vite build`
Expected: all green, exit 0. (A >500kB chunk-size warning from `vite build` is pre-existing and unrelated.)

- [ ] **Step 3: Confirm no dead references remain**

Run:
```bash
grep -rn "NewClaudeThreadModal\|NewCodexThreadModal\|onPickClaude\|onPickCodex" packages/web/src || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: End-to-end smoke against an isolated daemon**

Never point a second daemon at the real `~/.dispatch`. Build core, then run a throwaway instance:

```bash
cd packages/core && npx tsc -b
HOME=$(mktemp -d) PORT=3999 node dist/server.js
```

In a second shell, create an auto-archive thread with a 1-minute deadline, backdate nothing, and watch it go:

```bash
S=$(curl -s -X POST localhost:3999/api/sessions -H 'content-type: application/json' \
     -d '{"name":"t","workingDir":"/tmp","provider":"claude-code"}' | jq -r .id)
T=$(curl -s -X POST localhost:3999/api/sessions/$S/terminals -H 'content-type: application/json' \
     -d '{"type":"shell","label":"ephemeral","config":{"autoArchive":true,"autoArchiveMs":60000}}' | jq -r .id)

# Present now:
curl -s localhost:3999/api/sessions/$S/terminals | jq '.[].label'

# Wait out the deadline + one sweep interval (60s lease + 60s tick), then:
sleep 130
curl -s localhost:3999/api/sessions/$S/terminals | jq '.[].label'            # ephemeral is gone
curl -s localhost:3999/api/sessions/$S/terminals/archived | jq '.[].label'   # ephemeral is here
```

Expected: the thread disappears from the live list and appears in the archived list, with `archivedAt` set.

- [ ] **Step 5: Commit any fixes and push the branch**

```bash
git push -u origin worktree-auto-archive-threads
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Policy in `config`, ms-valued, no migration | 1 |
| Read-merge-write (never clobber the blob) | 1 (`withAutoArchive`), 3 (`setAutoArchive`) |
| 60s sweep loop, pure tick for tests | 1, 2 |
| Skip table: `working`/`queued`/`scheduled`/`needs_input` exempt; `waiting`/`error` swept | 1 |
| Archive via `removeTerminal` + same two broadcasts | 1 |
| Unified New Thread modal with type picker + toggle + duration | 6, 7 |
| RESUME RECENT preserved for PTY Claude | 7 |
| Context-menu `Auto-archive…` for existing threads | 6, 8 |
| Countdown badge | 4, 9 |
| Per-thread try/catch; malformed config inert; `created_at` fallback | 1 |
| No archived/restore UI (explicitly out of scope) | — |

**Deviations from the spec, and why:**

1. **The spec said the context-menu editor would PATCH `config`.** It cannot: `updateTab` (`service.ts:448`) replaces the blob wholesale, and `useTabs.setPinned` *depends* on that replace behavior to delete the `pinned` key on unpin — so `updateTab` can't be made to merge either. Task 3 adds a dedicated `PATCH /terminals/:id/auto-archive` that merges server-side. Strictly safer than the spec's plan, and race-free.
2. **The spec said the badge renders "alongside `timeAgo`".** It **replaces** it (Task 9). Both are derived from `lastActivityAt`; showing "2h ago" next to "10h left" is redundant, and the layout stays byte-identical, which keeps the recently-fixed label alignment intact.
3. **`AutoArchiveField` was factored out** (Task 6) rather than duplicating the toggle in two modals. DRY; not a behavior change.

**Type consistency:** `getAutoArchiveMs` exists in *both* packages with the same signature and semantics (core reads `Record<string, any>`, web reads `Record<string, unknown>` to match `Terminal.config`). `DEFAULT_AUTO_ARCHIVE_MS = 43_200_000` is asserted equal in both suites. `NewThreadKind` is defined once in `NewThreadModal.tsx` and imported by `NewTabMenu.tsx`.
