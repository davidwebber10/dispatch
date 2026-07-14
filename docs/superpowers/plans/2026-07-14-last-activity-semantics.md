# Thread `last_activity_at` Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `last_activity_at` on sessions and terminals stamps only when a thread actually did something (message sent, turn ran/completed, asked for input, sustained work output) — never on open/attach/repaint/resize/resume/stop/exit.

**Architecture:** Split activity from status. `sessionsDb.updateStatus()` stops writing `last_activity_at`; the `StatusService` explicitly stamps activity on real lifecycle edges (every normalized status except `'starting'`); the `TerminalMonitor` only stamps when an output burst genuinely crossed the busy threshold, with a `suppress()` grace-window re-arm called from the WebSocket handler on attach/resize so open-repaints never count.

**Tech Stack:** TypeScript (Node ≥18, ESM), better-sqlite3, vitest (fake timers for the monitor tests), pnpm workspace (core package is named `dispatch-server`).

**Spec:** `docs/superpowers/specs/2026-07-14-last-activity-semantics-design.md`

## Global Constraints

- All DB activity writes are best-effort (`try { … } catch { /* best effort */ }`) — matching existing status-write style.
- Do NOT change: status-dot semantics, `updated_at` behavior, sort order (`last_activity_at DESC`), DB schema (no migration).
- Run tests from repo root: `pnpm --filter dispatch-server test -- <path>` (or `cd packages/core && npx vitest run <path>`).
- Working branch: `fix/last-activity-semantics`.

---

### Task 1: DB layer — `updateStatus` stops bumping activity; add `terminalsDb.touchActivity`

**Files:**
- Modify: `packages/core/src/db/sessions.ts:48-52` (`updateStatus`)
- Modify: `packages/core/src/db/terminals.ts` (add `touchActivity` after `updateSessionId`, ~line 158)
- Test: `packages/core/tests/db/sessions.test.ts`
- Test: `packages/core/tests/db/terminals.test.ts`

**Interfaces:**
- Consumes: existing `sessionsDb.touchActivity(db, id)` (already exists at `db/sessions.ts:59`, currently uncalled).
- Produces: `terminalsDb.touchActivity(db: Database.Database, id: string): void` — sets `terminals.last_activity_at` to now. Task 2 and Task 3 call both helpers.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('sessions db', ...)` block in `packages/core/tests/db/sessions.test.ts`:

```ts
  it('updateStatus does not bump lastActivityAt (status flips fire on passive events too)', () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: '/tmp' });
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', 's1');
    sessionsDb.updateStatus(db, 's1', 'working');
    const session = sessionsDb.getById(db, 's1');
    expect(session!.status).toBe('working');
    expect(session!.last_activity_at).toBe('2020-01-01T00:00:00.000Z');
  });
```

Add to the `describe('terminals db', ...)` block in `packages/core/tests/db/terminals.test.ts`:

```ts
  it('touchActivity stamps last_activity_at', () => {
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
    expect(terminalsDb.getById(db, 't1')!.last_activity_at).toBeNull();
    terminalsDb.touchActivity(db, 't1');
    expect(terminalsDb.getById(db, 't1')!.last_activity_at).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter dispatch-server test -- tests/db/sessions.test.ts tests/db/terminals.test.ts`
Expected: sessions test FAILS (last_activity_at was bumped to now); terminals test FAILS (`touchActivity is not a function`).

- [ ] **Step 3: Implement**

In `packages/core/src/db/sessions.ts`, replace `updateStatus`:

```ts
export function updateStatus(db: Database.Database, id: string, status: string): void {
  // Deliberately does NOT bump last_activity_at: status flips also fire on passive
  // events (SessionStart on open/revive, PTY-exit rollups, stop()), which made
  // "last active" mean "last opened". Real activity is stamped explicitly via
  // touchActivity by the StatusService / TerminalMonitor.
  db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}
```

In `packages/core/src/db/terminals.ts`, add after `updateSessionId`:

```ts
export function touchActivity(db: Database.Database, id: string): void {
  db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server test -- tests/db/sessions.test.ts tests/db/terminals.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/sessions.ts packages/core/src/db/terminals.ts packages/core/tests/db/sessions.test.ts packages/core/tests/db/terminals.test.ts
git commit -m "fix(core): updateStatus no longer bumps last_activity_at; add terminals touchActivity"
```

---

### Task 2: StatusService stamps activity on thinking edges, not on `'starting'`

**Files:**
- Modify: `packages/core/src/status/service.ts:96-105` (`apply`)
- Test: `packages/core/tests/status/service.test.ts`

**Interfaces:**
- Consumes: `sessionsDb.touchActivity(db, id)` and `terminalsDb.touchActivity(db, id)` from Task 1 (both modules are already imported in `status/service.ts`).
- Produces: behavior only — every `apply()` with a normalized status other than `'starting'` stamps both rows.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/tests/status/service.test.ts` (a new top-level `describe`, after the existing `describe('StatusService', ...)` block; the shared `db`/`broadcaster` from the file's `beforeEach` are in scope):

```ts
describe('StatusService activity stamping', () => {
  const OLD = '2020-01-01T00:00:00.000Z';
  const seedOldActivity = () => {
    db.prepare('UPDATE sessions SET last_activity_at = ?').run(OLD);
    db.prepare('UPDATE terminals SET last_activity_at = ?').run(OLD);
  };
  const sessionActivity = () => (db.prepare("SELECT last_activity_at FROM sessions WHERE id = 'proj'").get() as any).last_activity_at;
  const terminalActivity = () => (db.prepare("SELECT last_activity_at FROM terminals WHERE id = 'term'").get() as any).last_activity_at;

  it('SessionStart (open/revive) does NOT stamp activity', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'SessionStart', session_id: 'sid-1' });
    expect(sessionActivity()).toBe(OLD);
    expect(terminalActivity()).toBe(OLD);
  });

  it('UserPromptSubmit (turn start) stamps activity on session and terminal', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'UserPromptSubmit', session_id: 'sid-1' });
    expect(sessionActivity()).not.toBe(OLD);
    expect(terminalActivity()).not.toBe(OLD);
  });

  it('Stop (turn completed) stamps activity', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).ingest('claude', 'term', { hook_event_name: 'Stop', session_id: 'sid-1' });
    expect(sessionActivity()).not.toBe(OLD);
    expect(terminalActivity()).not.toBe(OLD);
  });

  it('markNeedsInput stamps activity', () => {
    seedOldActivity();
    new StatusService(db, broadcaster).markNeedsInput('term', 'Needs approval: Bash');
    expect(sessionActivity()).not.toBe(OLD);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter dispatch-server test -- tests/status/service.test.ts`
Expected: the three "stamps activity" tests FAIL (timestamps stay `2020-01-01…` because `updateStatus` no longer bumps and nothing else does yet); the SessionStart test PASSES already — that is expected, keep it as the regression guard.

- [ ] **Step 3: Implement**

In `packages/core/src/status/service.ts`, replace `apply`:

```ts
  private apply(sessionId: string, terminalId: string, status: ThreadStatus, activity?: string): void {
    const prior = terminalsDb.getById(this.db, terminalId)?.status; // persisted enum before update
    const terminalStatus = TO_TERMINAL[status];
    try { terminalsDb.updateStatus(this.db, terminalId, terminalStatus); } catch { /* best effort */ }
    // Activity means "the thread thought about something": a turn started/ended, it
    // asked for input, went dormant, or errored. 'starting' (SessionStart) is an
    // open/revive edge — attaching to a thread must not make it look recently active.
    if (status !== 'starting') {
      try { terminalsDb.touchActivity(this.db, terminalId); } catch { /* best effort */ }
      try { sessionsDb.touchActivity(this.db, sessionId); } catch { /* best effort */ }
    }
    this.broadcaster.broadcast({ type: 'terminal:status', terminalId, status: terminalStatus, threadStatus: status, activity: activity ?? null });
    if (prior === 'working' && (terminalStatus === 'waiting' || terminalStatus === 'needs_input')) {
      try { this.threadSettledHook?.({ terminalId, sessionId, threadStatus: status }); } catch { /* hook must never break status */ }
    }
    this.aggregateSession(sessionId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server test -- tests/status/service.test.ts`
Expected: PASS (all, including the pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status/service.ts packages/core/tests/status/service.test.ts
git commit -m "feat(core): StatusService stamps last_activity_at on real lifecycle edges only"
```

---

### Task 3: TerminalMonitor — busy-gated stamping + `suppress()`

**Files:**
- Modify: `packages/core/src/terminal-monitor.ts` (imports, idle-timer callback at lines 124-143, new `suppress()` method)
- Test: `packages/core/tests/terminal-monitor.test.ts` (create)

**Interfaces:**
- Consumes: `sessionsDb.touchActivity` / `terminalsDb.touchActivity` from Task 1.
- Produces: `TerminalMonitor.suppress(terminalId: string): void` — re-arms the connection grace window. Task 4's ws handler calls it.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/terminal-monitor.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema.js';
import * as sessionsDb from '../src/db/sessions.js';
import * as terminalsDb from '../src/db/terminals.js';
import { TerminalMonitor } from '../src/terminal-monitor.js';

const OLD = '2020-01-01T00:00:00.000Z';

describe('TerminalMonitor activity stamping', () => {
  let db: Database.Database;
  let monitor: TerminalMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't' });
    db.prepare('UPDATE sessions SET last_activity_at = ?').run(OLD);
    db.prepare('UPDATE terminals SET last_activity_at = ?').run(OLD);
    monitor = new TerminalMonitor({ broadcast: vi.fn() } as any, db);
  });

  afterEach(() => vi.useRealTimers());

  const sessionActivity = () => (db.prepare("SELECT last_activity_at FROM sessions WHERE id = 's1'").get() as any).last_activity_at;
  const terminalActivity = () => (db.prepare("SELECT last_activity_at FROM terminals WHERE id = 't1'").get() as any).last_activity_at;

  it('does NOT stamp for a sub-busy-threshold burst (cursor blinks, tiny redraws)', () => {
    monitor.onOutput('t1', 'x'.repeat(100));
    vi.advanceTimersByTime(4000); // idle timer (3s) fires
    expect(sessionActivity()).toBe(OLD);
    expect(terminalActivity()).toBe(OLD);
  });

  it('stamps when a burst crosses the busy threshold outside the grace window', () => {
    monitor.onOutput('t1', 'boot');            // starts tracking; connection grace begins
    vi.advanceTimersByTime(6000);              // grace (5s) expires; first idle-fire stamped nothing
    monitor.onOutput('t1', 'y'.repeat(600));   // real work burst (>500 bytes) → busy
    vi.advanceTimersByTime(4000);              // idle timer fires while busy
    expect(sessionActivity()).not.toBe(OLD);
    expect(terminalActivity()).not.toBe(OLD);
  });

  it('suppress() re-arms the grace window so an attach/resize repaint does NOT stamp', () => {
    monitor.onOutput('t1', 'boot');
    vi.advanceTimersByTime(6000);              // well past the spawn grace
    monitor.suppress('t1');                    // client attaches → nudgeRepaint/resize incoming
    monitor.onOutput('t1', 'z'.repeat(2000));  // full-screen repaint, > busy threshold
    vi.advanceTimersByTime(4000);
    expect(sessionActivity()).toBe(OLD);
    expect(terminalActivity()).toBe(OLD);
  });

  it('suppress() on an untracked terminal starts it in the grace window', () => {
    monitor.suppress('t1');                    // attach before any output was ever seen
    monitor.onOutput('t1', 'z'.repeat(2000));
    vi.advanceTimersByTime(4000);
    expect(sessionActivity()).toBe(OLD);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter dispatch-server test -- tests/terminal-monitor.test.ts`
Expected: test 1 FAILS (current code stamps unconditionally); tests 3 & 4 FAIL (`suppress is not a function`); test 2 PASSES already (keep as regression guard that real work still stamps).

- [ ] **Step 3: Implement**

In `packages/core/src/terminal-monitor.ts`:

Add imports at the top (after the existing imports):

```ts
import * as sessionsDb from './db/sessions.js';
import * as terminalsDb from './db/terminals.js';
```

Replace the idle-timer block (currently lines 121-143) inside `onOutput`:

```ts
    // Reset idle timer
    const existing = this.idleTimers.get(terminalId);
    if (existing) clearTimeout(existing);
    this.idleTimers.set(terminalId, setTimeout(() => {
      if (status) {
        const wasBusy = status.activity === 'busy';
        status.activity = 'idle';
        this.burstBytes.set(terminalId, 0);
        this.broadcast(terminalId, status);
        // Bump last_activity_at only when this burst was real work — it crossed the
        // busy threshold outside the grace window. Attach/resize repaints end their
        // burst still 'idle' (or grace-suppressed) and must NOT stamp: unconditional
        // stamping here is what made "last active" mean "last opened". The thread
        // STATUS column stays owned by the StatusService (Claude hooks / Codex
        // notify) — writing 'waiting' here on every output pause is what made
        // status flap mid-turn, so we don't.
        if (wasBusy && this.db) {
          try {
            const row = this.db.prepare('SELECT session_id FROM terminals WHERE id = ?').get(terminalId) as any;
            if (row?.session_id) {
              terminalsDb.touchActivity(this.db, terminalId);
              sessionsDb.touchActivity(this.db, row.session_id);
            }
          } catch {}
        }
      }
    }, this.idleThresholdMs));
```

Add the `suppress` method after `onOutput` (before `getStatus`):

```ts
  /**
   * Re-arm the connection grace window for a terminal — called when a client
   * attaches or resizes. The SIGWINCH/fit repaint that follows is passive output
   * (often well over busyThresholdBytes, so the byte filter alone can't catch it);
   * suppressing busy transitions for the grace period keeps "opened a thread" from
   * reading as "thread was active". A thread genuinely mid-turn keeps emitting past
   * the window and still stamps.
   */
  suppress(terminalId: string) {
    const now = Date.now();
    const status = this.statuses.get(terminalId);
    if (status) {
      status.connectedAt = now;
    } else {
      this.statuses.set(terminalId, { terminalId, activity: 'idle', lastOutput: now, connectedAt: now });
    }
    this.burstBytes.set(terminalId, 0);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dispatch-server test -- tests/terminal-monitor.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/terminal-monitor.ts packages/core/tests/terminal-monitor.test.ts
git commit -m "fix(core): monitor stamps activity only on real busy bursts, adds suppress()"
```

---

### Task 4: Suppress on attach/resize — ws handler + server wiring

**Files:**
- Modify: `packages/core/src/ws/terminal.ts` (signature + two `suppress` calls)
- Modify: `packages/core/src/server.ts:449` (pass `terminalMonitor`)
- Test: `packages/core/tests/ws/terminal.test.ts`

**Interfaces:**
- Consumes: `TerminalMonitor.suppress(terminalId)` from Task 3.
- Produces: `handleTerminalConnection(ws, req, ptyManager, sessionService?, monitor?)` — 5th optional param.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/tests/ws/terminal.test.ts`, after the existing `describe` block:

```ts
describe('handleTerminalConnection activity suppression', () => {
  it('suppresses the monitor on attach and on client resize', () => {
    const pty = fakePtyManager();
    const monitor = { suppress: vi.fn() };
    const ws = fakeWs();
    const req = { url: '/api/terminals/t1/ws' } as IncomingMessage;
    handleTerminalConnection(ws as unknown as WebSocket, req, pty as unknown as PTYManager, sessionService, monitor as any);
    expect(monitor.suppress).toHaveBeenCalledWith('t1');

    const onMessage = ws.on.mock.calls.find((c) => c[0] === 'message')![1];
    monitor.suppress.mockClear();
    onMessage(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    expect(monitor.suppress).toHaveBeenCalledWith('t1');
    expect(pty.resize).toHaveBeenCalledWith('t1', 80, 24);
  });

  it('works without a monitor (backwards compatible)', () => {
    const pty = fakePtyManager();
    expect(() => connect(pty)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dispatch-server test -- tests/ws/terminal.test.ts`
Expected: FAIL — `monitor.suppress` not called (the handler ignores the 5th argument).

- [ ] **Step 3: Implement**

In `packages/core/src/ws/terminal.ts`:

Add the type import:

```ts
import type { TerminalMonitor } from '../terminal-monitor.js';
```

Change the signature and add the attach-time suppress right after the `targetId` guard:

```ts
export function handleTerminalConnection(
  ws: WebSocket,
  req: IncomingMessage,
  ptyManager: PTYManager,
  sessionService?: SessionService,
  monitor?: TerminalMonitor,
): void {
```

…and directly after `if (!targetId) { ws.close(4000, 'Invalid URL'); return; }`:

```ts
  // Attaching triggers a full-screen repaint (nudgeRepaint's SIGWINCH below, the
  // client's initial fit resize, or a revive spawn). That's passive output — arm
  // the monitor's grace window so it can't read as thread activity.
  monitor?.suppress(targetId);
```

In the resize branch of the `ws.on('message', …)` handler, add a suppress before the resize:

```ts
        if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
          monitor?.suppress(targetId!); // the repaint a resize causes is not activity
          ptyManager.resize(targetId!, parsed.cols, parsed.rows);
          return;
        }
```

In `packages/core/src/server.ts` line 449, pass the monitor (it is in scope — declared at line ~341):

```ts
        handleTerminalConnection(ws, request, ptyManager, sessionService, terminalMonitor);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dispatch-server test -- tests/ws/terminal.test.ts`
Expected: PASS (all, including the two pre-existing replay tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ws/terminal.ts packages/core/src/server.ts packages/core/tests/ws/terminal.test.ts
git commit -m "fix(core): suppress activity monitor on ws attach and client resize"
```

---

### Task 5: Full verification

**Files:**
- No new files; runs the whole suite + build.

- [ ] **Step 1: Run the full core test suite**

Run: `pnpm --filter dispatch-server test`
Expected: PASS. Watch specifically for pre-existing tests that asserted `updateStatus` bumps activity or that relied on monitor stamping (e.g. `tests/sessions/`, `tests/routes/`, `tests/status/`). If any fail because they asserted the OLD (buggy) semantics, update the assertion to the new semantics — do not weaken unrelated assertions.

- [ ] **Step 2: Typecheck/build both packages**

Run: `pnpm build`
Expected: `tsc` completes for `packages/core` and the web build succeeds with no errors.

- [ ] **Step 3: Commit any test-semantics fixups**

```bash
git add -A
git commit -m "test(core): align remaining tests with activity-vs-status split"
```

(Skip if Step 1 needed no changes.)

- [ ] **Step 4: Manual smoke test (isolated instance — never point a second daemon at the real ~/.dispatch)**

```bash
pnpm --filter dispatch-server build
HOME=/private/tmp/claude-501/-Users-davidwebber-Sites-dispatch/33bd6051-ebc3-48cf-b110-ca83a8162dff/scratchpad/fake-home PORT=3999 node packages/core/dist/server.js
```

Then in a browser (or curl): create a thread, note `lastActivityAt` from `GET /api/sessions`, close and reopen the thread view, confirm `lastActivityAt` did NOT move; send the thread a message, confirm it DID move.
