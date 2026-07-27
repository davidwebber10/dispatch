# Session Identity Adoption Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Dispatch terminals (especially coordinators) from adopting Claude sessions they don't own, and let a wrong/ghost `external_id` heal — ending the cross-session contamination where Control Plane renders a user's terminal history and terminal resumes show Control Plane turns.

**Architecture:** A terminal's Claude identity (`terminals.external_id`) can go wrong three ways, all proven or code-evident in the field: (1) `recoverSessionId` (`sessions/service.ts:719`) adopts the project dir's only `.jsonl` even when that transcript was born long before the terminal existed — proven: the Databricks Order Proxy coordinator (created Jul 24) adopted the user's June 25 terminal session; (2) both capture paths (structured `'session'` listener at `sessions/service.ts:99-104`, PTY hook capture at `status/service.ts:49-52`) are strict first-write-wins, so a captured id whose transcript never materializes (a boot that never ran a turn) locks the terminal onto a **ghost** forever — proven: the Dispatch coordinator's `external_id` has no transcript anywhere and Control Plane serves 0 items; (3) the PTY fallback watcher `captureSessionId` (`providers/claude-code.ts:122`) adopts the newest-born `.jsonl` in a 30s window — a user starting their own `claude` in the same dir inside the window gets adopted. Fixes: an **ownership gate** (a terminal cannot own a transcript born before the terminal was created), a **ghost heal** (the live process's self-reported id overwrites a stored id whose transcript doesn't exist), and an **ambiguity bail** (two candidate births in the watcher window → adopt neither; the hook capture is the authority). Plus a one-time data repair for the two damaged coordinators.

**Tech Stack:** Node/TypeScript (packages/core), better-sqlite3, Vitest.

## Global Constraints

- Fresh branch off updated `origin/main`; push + PR at the end (controller handles branch/PR/repair).
- Core tests: `cd packages/core && pnpm vitest run <file>`; full suite `cd packages/core && pnpm test`. NOTE: the core suite has a known pre-existing intermittent flake (~1 in 5 runs exits nonzero with an unhandled error while all tests pass) — if the full suite fails with 0 failing tests, re-run once before investigating.
- Do not change what a HEALTHY identity does: a stored `external_id` whose transcript exists is never overwritten, and a fresh capture on an id-less terminal behaves exactly as today.
- `resolveTranscriptPath(workDir, sessionId, projectsRoot?)` (`sessions/transcript-path.ts:53`) is the one true "does this session's transcript exist" check — it searches beyond the computed dir (relocated sessions), so a merely-moved transcript is NOT a ghost. Never reimplement that search.
- Line numbers reference current `origin/main` (`6c9bdfa`); re-locate by content if drifted.
- End commit messages with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Ownership gate in `recoverSessionId` — never adopt a transcript older than the terminal

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (`recoverSessionId`, lines 707-730)
- Test: Create `packages/core/tests/sessions/recover-session-id.test.ts`

**Interfaces:**
- Produces: `export function pickRecoverableSession(files: { id: string; birth: number }[], terminalCreatedAtMs: number): string | null` — exported from `packages/core/src/sessions/service.ts` (module scope, above the `SessionService` class). Pure: returns the single file's id iff `files.length === 1` AND `files[0].birth >= terminalCreatedAtMs - 60_000` (1-minute slack for clock skew); null otherwise.

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/sessions/recover-session-id.test.ts`:

```ts
// recoverSessionId's one-file adoption gained an OWNERSHIP gate: a terminal cannot own a
// transcript born before the terminal itself was created. Field case: the Databricks Order
// Proxy coordinator (created 2026-07-24) adopted the user's June 25 terminal session because
// it was the project dir's only .jsonl — "unambiguous" by count, wrong by ownership. The
// count rule (exactly one file) is unchanged; this adds the birth-time gate.
import { describe, it, expect } from 'vitest';
import { pickRecoverableSession } from '../../src/sessions/service.js';

const T0 = Date.parse('2026-07-24T16:08:38.157Z'); // terminal created

describe('pickRecoverableSession', () => {
  it('adopts the single file when it was born after the terminal was created', () => {
    expect(pickRecoverableSession([{ id: 's1', birth: T0 + 5_000 }], T0)).toBe('s1');
  });

  it('adopts within the 60s clock-skew slack before creation', () => {
    expect(pickRecoverableSession([{ id: 's1', birth: T0 - 30_000 }], T0)).toBe('s1');
  });

  it('REFUSES the single file when it predates the terminal (the June-25 adoption bug)', () => {
    const juneBirth = Date.parse('2026-06-25T18:21:02.840Z');
    expect(pickRecoverableSession([{ id: 'users-own-session', birth: juneBirth }], T0)).toBeNull();
  });

  it('refuses when the dir has zero files', () => {
    expect(pickRecoverableSession([], T0)).toBeNull();
  });

  it('refuses when the dir has 2+ files, regardless of births (existing ambiguity rule)', () => {
    expect(pickRecoverableSession([
      { id: 'a', birth: T0 + 1_000 },
      { id: 'b', birth: T0 + 2_000 },
    ], T0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/sessions/recover-session-id.test.ts`
Expected: FAIL — `pickRecoverableSession` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/sessions/service.ts`, add at module scope (above the `SessionService` class):

```ts
/**
 * The one-file recovery decision, pure for testability: adopt the project dir's single
 * transcript ONLY when it could plausibly belong to this terminal — i.e. it was born at or
 * after the terminal's creation (60s slack for clock skew). A transcript that predates the
 * terminal is someone else's session that happens to share the project dir (the user's own
 * `claude` runs) — adopting it made a coordinator resume the USER'S conversation (Control
 * Plane rendered their terminal history; their terminal resume showed coordinator turns).
 * 0 files = nothing to recover; 2+ = ambiguous (unchanged rule, see recoverSessionId).
 */
export function pickRecoverableSession(
  files: { id: string; birth: number }[],
  terminalCreatedAtMs: number,
): string | null {
  if (files.length !== 1) return null;
  return files[0].birth >= terminalCreatedAtMs - 60_000 ? files[0].id : null;
}
```

Then rewrite `recoverSessionId` (lines 719-730) to collect births and delegate. Replace its body:

```ts
  private recoverSessionId(terminalId: string, dir: string): string | null {
    let files: { id: string; birth: number }[];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const s = fs.statSync(path.join(dir, f));
          return { id: f.replace(/\.jsonl$/, ''), birth: s.birthtimeMs || s.ctimeMs };
        });
    } catch { return null; }
    const terminal = terminalsDb.getById(this.db, terminalId);
    const createdAtMs = terminal ? Date.parse(terminal.created_at) : NaN;
    if (!Number.isFinite(createdAtMs)) return null; // no terminal row → nothing to attribute to
    const id = pickRecoverableSession(files, createdAtMs);
    if (!id) return null;
    try { terminalsDb.updateExternalId(this.db, terminalId, id); } catch { /* best effort */ }
    return id;
  }
```

Also update the doc comment above it (lines 707-718): keep the existing issue-#7 rationale and append one sentence: `Even a single file is adopted only if it was born after this terminal was created (see pickRecoverableSession) — the sole transcript in a quiet dir is usually the USER'S own session, not this terminal's.`

- [ ] **Step 4: Run tests**

Run: `cd packages/core && pnpm vitest run tests/sessions/recover-session-id.test.ts`
Expected: PASS (5 tests). Then `cd packages/core && pnpm test` — expected: no new failures (see flake note in Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/tests/sessions/recover-session-id.test.ts
git commit -m "fix(core): recoverSessionId refuses a transcript born before the terminal existed

A quiet project dir's only .jsonl is usually the USER'S own claude session; adopting
it made a coordinator resume the user's conversation (field case: the Databricks Order
Proxy coordinator, created Jul 24, adopted a June 25 terminal session).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Ghost heal — a live process's self-reported id overwrites a stored id whose transcript doesn't exist

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (the `'session'` listener in `setStructuredManager`, lines 93-104)
- Modify: `packages/core/src/status/service.ts` (the hook capture in `ingest`, lines 49-52; add imports)
- Test: `packages/core/tests/status/service.test.ts` (update the "does not clobber" test's premise; add ghost-heal tests)
- Test: Create `packages/core/tests/sessions/session-id-heal.test.ts` (structured listener)

**Interfaces:**
- Consumes: `resolveTranscriptPath(workDir, sessionId)` from `sessions/transcript-path.ts` (already imported in `sessions/service.ts:24`; must be ADDED to `status/service.ts` imports).
- Produces: both capture sites share the rule — write the reported id when the terminal has no `external_id` (today's behavior), OR when the stored id differs from the reported one AND `resolveTranscriptPath(workDir, stored)` is undefined (the stored id is a ghost: no transcript anywhere). A stored id whose transcript exists is never overwritten.

- [ ] **Step 1: Write the failing tests**

In `packages/core/tests/status/service.test.ts`, REPLACE the existing test `does not clobber an existing external_id` (line ~29) with these three (same describe block; `vi.mock` must be at module top level, above the imports it affects — place it right after the existing import lines):

```ts
// Ghost heal: the live process's self-reported session id is authoritative when the STORED
// id has no transcript anywhere (a captured id from a boot that never ran a turn — the
// Dispatch coordinator was locked onto such a ghost and Control Plane served 0 items
// forever). A stored id whose transcript EXISTS is still never overwritten.
vi.mock('../../src/sessions/transcript-path.js', () => ({
  resolveTranscriptPath: vi.fn((workDir: string, sessionId: string) =>
    sessionId.startsWith('ghost') ? undefined : `/fake/${sessionId}.jsonl`),
}));
```

```ts
  it('does not clobber an existing external_id whose transcript exists', () => {
    terminalsDb.create(db, { id: 't2', sessionId: 'proj', type: 'claude-code', label: 't2', skipPermissions: true, externalId: 'orig' });
    new StatusService(db, broadcaster).ingest('claude', 't2', { hook_event_name: 'SessionStart', session_id: 'new' });
    expect(terminalsDb.getById(db, 't2')?.external_id).toBe('orig');
  });

  it('HEALS a ghost external_id (stored id has no transcript anywhere)', () => {
    terminalsDb.create(db, { id: 't3', sessionId: 'proj', type: 'claude-code', label: 't3', skipPermissions: true, externalId: 'ghost-1' });
    new StatusService(db, broadcaster).ingest('claude', 't3', { hook_event_name: 'SessionStart', session_id: 'real-1' });
    expect(terminalsDb.getById(db, 't3')?.external_id).toBe('real-1');
  });

  it('a ghost stored id is left alone when the reported id is the SAME id (no pointless write)', () => {
    terminalsDb.create(db, { id: 't4', sessionId: 'proj', type: 'claude-code', label: 't4', skipPermissions: true, externalId: 'ghost-2' });
    new StatusService(db, broadcaster).ingest('claude', 't4', { hook_event_name: 'SessionStart', session_id: 'ghost-2' });
    expect(terminalsDb.getById(db, 't4')?.external_id).toBe('ghost-2');
  });
```

Create `packages/core/tests/sessions/session-id-heal.test.ts` for the structured listener. The listener is wired in `setStructuredManager` and fires on the manager's `'session'` event — drive it with a bare `EventEmitter` as the fake manager (only `.on` is needed for this path). Construct `SessionService` the same way an existing sessions test does (copy the minimal constructor setup from `packages/core/tests/sessions/message-source.test.ts`, which also calls `setStructuredManager` with an EventEmitter-based fake):

```ts
// Structured-path twin of the StatusService ghost-heal tests: the manager's 'session'
// event (claude session_id from the structured init event) heals a stored external_id
// whose transcript no longer / never existed, and still never clobbers a healthy one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';

vi.mock('../../src/sessions/transcript-path.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sessions/transcript-path.js')>();
  return {
    ...orig,
    resolveTranscriptPath: vi.fn((workDir: string, sessionId: string) =>
      sessionId.startsWith('ghost') ? undefined : `/fake/${sessionId}.jsonl`),
  };
});

import { SessionService } from '../../src/sessions/service.js';

describe('structured session-id capture heals ghosts', () => {
  let db: Database.Database;
  let manager: EventEmitter;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
    manager = new EventEmitter();
    // Construct SessionService with the same minimal deps message-source.test.ts uses,
    // then: (service as any).setStructuredManager(manager as any);
  });

  it('captures on an id-less terminal (unchanged first-write behavior)', () => {
    terminalsDb.create(db, { id: 'tA', sessionId: 'proj', type: 'claude-code', label: 'a', skipPermissions: true });
    // ...setStructuredManager wired in beforeEach per harness...
    manager.emit('session', 'tA', 'real-1');
    expect(terminalsDb.getById(db, 'tA')?.external_id).toBe('real-1');
  });

  it('never clobbers a stored id whose transcript exists', () => {
    terminalsDb.create(db, { id: 'tB', sessionId: 'proj', type: 'claude-code', label: 'b', skipPermissions: true, externalId: 'orig' });
    manager.emit('session', 'tB', 'real-2');
    expect(terminalsDb.getById(db, 'tB')?.external_id).toBe('orig');
  });

  it('HEALS a stored ghost id to the live-reported one', () => {
    terminalsDb.create(db, { id: 'tC', sessionId: 'proj', type: 'claude-code', label: 'c', skipPermissions: true, externalId: 'ghost-1' });
    manager.emit('session', 'tC', 'real-3');
    expect(terminalsDb.getById(db, 'tC')?.external_id).toBe('real-3');
  });
});
```

(The exact `SessionService` construction is whatever `message-source.test.ts` does — mirror it verbatim, including any fake pty/managers it passes. If that harness proves unusable for this listener, STOP and report NEEDS_CONTEXT.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run tests/status/service.test.ts tests/sessions/session-id-heal.test.ts`
Expected: the two HEAL tests FAIL (stored ghost survives); the never-clobber and first-write tests pass.

- [ ] **Step 3: Implement the heal in both sites**

In `packages/core/src/sessions/service.ts`, replace the `'session'` listener body (lines 98-104):

```ts
    // Persist the claude session_id (surfaced from the structured init event) onto the
    // terminal's external_id, mirroring how the PTY path captures session ids. This is
    // what lets us resume the SAME conversation after a daemon restart. First-write-wins
    // for a HEALTHY identity — but a stored id whose transcript exists NOWHERE (captured
    // from a boot that never ran a turn) is a ghost: it can never be resumed or read, and
    // leaving it locked the terminal onto an empty history forever (the Dispatch
    // coordinator served 0 items and every resume referenced a nonexistent session). The
    // live process's self-reported id is authoritative over a ghost.
    m.on('session', (terminalId: string, sessionId: string) => {
      try {
        const t = terminalsDb.getById(this.db, terminalId);
        if (!t || !sessionId || t.external_id === sessionId) return;
        if (t.external_id) {
          const session = sessionsDb.getById(this.db, t.session_id);
          const workDir = t.working_dir || session?.working_dir || '';
          if (resolveTranscriptPath(workDir, t.external_id)) return; // healthy — never clobber
        }
        terminalsDb.updateExternalId(this.db, terminalId, sessionId);
      } catch { /* best effort */ }
    });
```

In `packages/core/src/status/service.ts`: add imports `import * as sessionsDb from '../db/sessions.js';` (if not present) and `import { resolveTranscriptPath } from '../sessions/transcript-path.js';`, then replace the capture block (lines 49-52):

```ts
    // Capture the session/thread id at the source — no more filesystem polling. First-write
    // for a healthy identity; a stored id with NO transcript anywhere (a ghost from a boot
    // that never ran a turn) is healed to the live process's self-reported id — see the
    // structured twin in sessions/service.ts setStructuredManager.
    if (norm.sessionId && terminal.external_id !== norm.sessionId) {
      let healthy = false;
      if (terminal.external_id) {
        const session = sessionsDb.getById(this.db, terminal.session_id);
        const workDir = terminal.working_dir || session?.working_dir || '';
        healthy = !!resolveTranscriptPath(workDir, terminal.external_id);
      }
      if (!healthy) {
        try { terminalsDb.updateExternalId(this.db, terminalId, norm.sessionId); } catch { /* best effort */ }
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && pnpm vitest run tests/status/service.test.ts tests/sessions/session-id-heal.test.ts tests/sessions/message-source.test.ts`
Expected: all PASS (message-source included — same harness, must not regress). Then the full core suite once.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/status/service.ts packages/core/tests/status/service.test.ts packages/core/tests/sessions/session-id-heal.test.ts
git commit -m "fix(core): heal a ghost external_id from the live process's self-reported session id

First-write-wins locked a terminal onto a captured id whose transcript never
materialized — unreadable, unresumable, unfixable. Both capture paths (structured
init event, PTY status hooks) now overwrite a stored id only when its transcript
exists nowhere; a healthy identity is still never clobbered.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Ambiguity bail in the PTY transcript watcher

**Files:**
- Modify: `packages/core/src/providers/claude-code.ts` (`captureSessionId`, lines 122-150)
- Test: `packages/core/tests/` — create `packages/core/tests/providers/capture-session-id.test.ts` (create the `providers` dir if absent)

**Interfaces:**
- Produces: `export function pickBornSession(candidates: { name: string; birth: number }[], minBirth: number): { id: string } | 'ambiguous' | null` — exported from `packages/core/src/providers/claude-code.ts`. Pure: filter to `birth >= minBirth`; 0 in-window → `null` (keep polling), exactly 1 → `{ id }`, 2+ → `'ambiguous'` (caller stops polling and returns null — a second session started in the window, so "newest" can no longer be attributed to our spawn; the hook capture at `status/service.ts` is the authority).

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/providers/capture-session-id.test.ts`:

```ts
// The PTY fallback watcher adopts the .jsonl born after our spawn. With TWO candidates in
// the window, "newest" can't be attributed to our spawn — a user starting their own claude
// in the same project dir would be adopted. Bail instead; the status-hook capture is the
// authoritative id source and the watcher is only a fallback.
import { describe, it, expect } from 'vitest';
import { pickBornSession } from '../../src/providers/claude-code.js';

const MIN = 1_000_000;

describe('pickBornSession', () => {
  it('returns null (keep polling) when nothing was born in the window', () => {
    expect(pickBornSession([{ name: 'old.jsonl', birth: MIN - 5_000 }], MIN)).toBeNull();
  });

  it('adopts a single in-window birth', () => {
    expect(pickBornSession([
      { name: 'old.jsonl', birth: MIN - 5_000 },
      { name: 'mine.jsonl', birth: MIN + 400 },
    ], MIN)).toEqual({ id: 'mine' });
  });

  it("returns 'ambiguous' when 2+ births land in the window (user's concurrent session)", () => {
    expect(pickBornSession([
      { name: 'mine.jsonl', birth: MIN + 400 },
      { name: 'users.jsonl', birth: MIN + 900 },
    ], MIN)).toBe('ambiguous');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run tests/providers/capture-session-id.test.ts`
Expected: FAIL — `pickBornSession` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/providers/claude-code.ts`, add at module scope (above the provider object):

```ts
/**
 * The watcher's adoption decision, pure for testability. Exactly one transcript born in
 * the window is attributable to our spawn; two or more means another session (usually the
 * user's own `claude` in the same project dir) started concurrently and "newest" proves
 * nothing — adopting it cross-wired a Dispatch thread onto the user's conversation. On
 * 'ambiguous' the caller stops polling entirely (more polling can't disambiguate) and
 * leaves capture to the status-hook path, which reports the id from inside the session.
 */
export function pickBornSession(
  candidates: { name: string; birth: number }[],
  minBirth: number,
): { id: string } | 'ambiguous' | null {
  const born = candidates.filter((c) => c.birth >= minBirth);
  if (born.length === 0) return null;
  if (born.length > 1) return 'ambiguous';
  return { id: born[0].name.replace(/\.jsonl$/, '') };
}
```

Then in `captureSessionId` (lines 131-149), replace the selection block. The current code is:

```ts
        const newest = stats
          .filter((s) => s.birth >= minBirth)
          .sort((a, b) => b.birth - a.birth)[0];
        if (newest) return newest.name.replace(/\.jsonl$/, '');
```

Replace with:

```ts
        const pick = pickBornSession(stats, minBirth);
        if (pick === 'ambiguous') return null; // a concurrent session appeared — hooks own capture now
        if (pick) return pick.id;
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && pnpm vitest run tests/providers/capture-session-id.test.ts`
Expected: PASS (3 tests). Then the full core suite once.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/claude-code.ts packages/core/tests/providers/capture-session-id.test.ts
git commit -m "fix(core): PTY transcript watcher bails on ambiguous births instead of adopting the newest

Two transcripts born in the capture window means one is likely the user's own
concurrent claude session; 'newest' cannot be attributed to our spawn. Leave
capture to the status-hook path, which reports the id from inside the session.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification + PR

**Files:** none (verification only; controller handles PR).

- [ ] **Step 1: Suites + build**

```bash
cd packages/core && pnpm test && cd ../.. && pnpm build
```
Expected: 0 failing tests (re-run once on the known flake), build clean.

- [ ] **Step 2: PR** — controller pushes and opens the PR, citing the field evidence (June-25 adoption, the Dispatch ghost) and noting the data repair is a separate operational step.

---

### Task 5 (controller, post-merge, this machine only): data repair + deploy

NOT a subagent task — run by the controller with output shown to the user.

1. Deploy the fix locally: `dispatch update` (pull + rebuild + restart).
2. Repair the two proven-bad rows (the heal fixes ghosts on next boot, but the Databricks adoption is a HEALTHY-looking id — its transcript exists — so it must be cleared by hand):
   ```sql
   -- Dispatch coordinator: ghost id (no transcript anywhere)
   UPDATE terminals SET external_id = NULL WHERE id = 'a9db040f-6e3f-41f2-848f-39797bdbd0aa' AND external_id = 'a4dc6344-c85e-4744-b2cd-db3363b86718';
   -- Databricks Order Proxy coordinator: adopted the user's June 25 terminal session
   UPDATE terminals SET external_id = NULL WHERE external_id = 'c27e2168-91a8-46d2-976d-79f7b26b45bf' AND id IN (SELECT id FROM terminals WHERE json_extract(config,'$.role')='coordinator');
   ```
3. Sweep for other victims and REPORT (do not auto-clear): every non-archived terminal whose `external_id` transcript is missing everywhere, or whose transcript's birth predates the terminal's `created_at` by more than 60s. Present the list to the user before touching anything beyond the two above.
4. Note to user: the June 25 transcript permanently contains a few coordinator turns (appended while adopted) — unmixing it isn't practical; clearing the pointer stops further contamination. The Databricks coordinator starts a fresh conversation.

---

## Notes for the implementer

- **Why birth-time, not content inspection, for ownership:** a coordinator transcript legitimately contains interactive-terminal line types (the CLI⇄Pretty transport switch attaches an interactive CLI to the same session), so "does it look interactive" cannot distinguish ownership. Creation-time ordering can: a terminal cannot own a transcript that predates it.
- **Why the heal requires a MISSING transcript, not just a mismatch:** `-r <id>` keeps the session id (verified on CLI 2.1.212), so a healthy resume never reports a different id; but a resume of a half-broken state or a fresh fallback spawn reports a NEW id — overwriting a healthy stored id on any mismatch would let a single anomalous boot steal a real history. Ghost-only healing is monotonic: it can only go from unreadable to readable.
- **`s.birthtimeMs || s.ctimeMs`:** keep the existing fallback exactly as `captureSessionId` already does it — on filesystems without birthtime this degrades to ctime, which is the pre-fix behavior, not a new risk.
