# PTY Usage Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record one `usage_turns` row per turn for PTY threads, so analytics covers the roughly half of all threads it currently misses.

**Architecture:** Both providers announce the end of a turn, and `StatusService` already fires on that edge. A capture service subscribes to it, refuses to run for structured threads, and reads the provider's transcript. Claude sums per-message usage from a byte cursor; Codex diffs a running total, which needs no cursor at all.

**Tech Stack:** TypeScript, better-sqlite3, Node fs, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-pty-usage-capture-design.md`

Supporting evidence, read if a decision seems arbitrary:
- `docs/superpowers/specs/2026-08-14-pty-usage-coverage-scoping.md`
- `docs/superpowers/specs/2026-08-14-codex-transcript-findings.md`

## Global Constraints

- **Worktree.** Work in `.claude/worktrees/analytics-usage` on `worktree-analytics-usage`. Never `cd` to the main checkout.
- **Never use bare `git stash` / `git stash pop`.** The stash stack is shared with other worktrees and other live sessions. Use a temporary WIP commit instead.
- **ESM imports in `packages/core` need explicit `.js` extensions.** Missing ones pass the build and the tests, then stop the daemon from starting.
- **The double-count gate is the point of this feature.** PTY capture runs only when `isStructuredTerminal` is false. That predicate tests BOTH `config.transport === 'structured'` AND a registered manager for the type. Never re-implement it as a config read.
- **Bootstrap at the end, never at zero.** A first-sight thread records its current position or total and writes NO row. Starting at zero dumps a thread's whole history into one turn and duplicates the importer.
- **One atomic write.** The row and the cursor-or-total advance in a single transaction.
- **Never sum Codex's `last_token_usage`.** It breaks its own delta invariant in 1.4% of transitions and overcounts a real file by 767,661 tokens. Diff `total_token_usage`.
- **Analytics must never break a turn.** Every listener body is wrapped best-effort.
- **Read-only on `~/.codex` and `~/.claude`.** Never write to a user transcript.
- Commit after every task.

**Test commands**
- Core, one file: `pnpm --filter dispatch-server exec vitest run src/<path>.test.ts`
- Core, all: `pnpm --filter dispatch-server test` — 2 failures in `tests/setup/install.test.ts` are a known environment issue (a real `grok` binary exists at `~/.local/bin/grok`); nothing else may fail.
- Module graph: `pnpm --filter dispatch-server build` then `node --input-type=module -e "await import('./packages/core/dist/server.js'); console.log('OK')"`

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/status/service.ts` | Settled hook becomes a subscriber list (modify) |
| `packages/core/src/sessions/service.ts` | Expose `isStructuredTerminal` (modify) |
| `packages/core/src/db/schema.ts` | Add `usage_pty_state` (modify) |
| `packages/core/src/db/usage-pty.ts` | All SQL for the per-thread capture state |
| `packages/core/src/analytics/pty-claude.ts` | Claude: tail-read from an offset, sum via `frames.ts` |
| `packages/core/src/analytics/codex-locate.ts` | Codex: find a transcript from an `external_id` |
| `packages/core/src/analytics/codex-frames.ts` | Codex: newest total + newest model from a tail |
| `packages/core/src/analytics/pty-capture.ts` | The subscriber: gate, dispatch, atomic write |
| `packages/core/src/server.ts` | Wire the capture service in both builders (modify) |
| `packages/core/src/routes/analytics.ts` | Make the importer provider-aware (modify) |

---

### Task 1: A settled-hook subscriber list, and an exposed transport predicate

**Files:**
- Modify: `packages/core/src/status/service.ts:30,41-43`
- Modify: `packages/core/src/push/notify.ts:17`
- Modify: `packages/core/src/sessions/service.ts:859`
- Test: `packages/core/src/status/settled-listeners.test.ts`

**Interfaces:**
- Produces: `StatusService.addThreadSettledListener(fn: SettledListener): void` where `SettledListener = (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void`
- Produces: `SessionService.isStructuredTerminal(terminal: TerminalRow): boolean` — same body, made public

`setThreadSettledHook` replaces rather than adds, and `wireThreadSettledPush` already owns it. A second consumer would silently disable push notifications.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/status/settled-listeners.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { StatusService } from './service.js';
import { createNoopBroadcaster } from '../ws/events.js';

describe('settled listeners', () => {
  let d: Database.Database, svc: StatusService, termId: string;

  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    const projectId = sessionsDb.create(d, { id: 'p1', provider: 'claude-code', name: 'P', workingDir: '/tmp/p' });
    termId = 't1';
    terminalsDb.create(d, { id: termId, sessionId: 'p1', type: 'claude-code', label: 'chat' });
    terminalsDb.updateStatus(d, termId, 'working');
    svc = new StatusService(d, createNoopBroadcaster());
  });

  // Registering a second listener must not displace the first. Push notifications
  // own the original hook; usage capture is the second consumer.
  it('fires every registered listener, not only the last', () => {
    const fired: string[] = [];
    svc.addThreadSettledListener(() => fired.push('a'));
    svc.addThreadSettledListener(() => fired.push('b'));
    svc.markIdle(termId);
    expect(fired).toEqual(['a', 'b']);
  });

  it('a throwing listener does not stop the others or the status update', () => {
    const fired: string[] = [];
    svc.addThreadSettledListener(() => { throw new Error('boom'); });
    svc.addThreadSettledListener(() => fired.push('b'));
    expect(() => svc.markIdle(termId)).not.toThrow();
    expect(fired).toEqual(['b']);
    expect(terminalsDb.getById(d, termId)!.status).toBe('waiting');
  });
});
```

- [ ] **Step 2: Verify the fixture signatures**

Run: `rg -n "export function create" -A 12 packages/core/src/db/sessions.ts packages/core/src/db/terminals.ts`
Fix the test's fixture calls to match the real `CreateInput` shapes. Do not change production code to match the test.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/status/settled-listeners.test.ts`
Expected: FAIL — `addThreadSettledListener is not a function`

- [ ] **Step 4: Convert the hook to a list**

In `packages/core/src/status/service.ts`, replace the single field and setter:

```ts
export type SettledListener = (info: { terminalId: string; sessionId: string; threadStatus: ThreadStatus }) => void;
```

```ts
  private settledListeners: SettledListener[] = [];

  /**
   * Subscribe to the turn-settled edge. A LIST, not a single hook: push notifications
   * and analytics capture both consume this, and a setter would have let whichever
   * wired second silently disable the first.
   */
  addThreadSettledListener(fn: SettledListener): void {
    this.settledListeners.push(fn);
  }
```

At the fire site (`apply()`, currently line 205), replace the single call:

```ts
      for (const fn of this.settledListeners) {
        try { fn({ terminalId, sessionId, threadStatus: status }); } catch { /* a listener must never break status */ }
      }
```

Delete `setThreadSettledHook` and the `threadSettledHook` field entirely — leaving both would invite the same bug back.

- [ ] **Step 5: Update the existing consumer**

In `packages/core/src/push/notify.ts:17`, change `statusService.setThreadSettledHook(` to `statusService.addThreadSettledListener(`. Nothing else in that file changes.

- [ ] **Step 6: Expose the transport predicate**

In `packages/core/src/sessions/service.ts:859`, change `private isStructuredTerminal(` to `isStructuredTerminal(`. Leave the body and its doc comment exactly as they are — that comment explains the Codex-Pretty case and is the reason this predicate exists.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter dispatch-server exec vitest run src/status/settled-listeners.test.ts src/push/notify.test.ts`
Expected: PASS. If `notify.test.ts` calls the old setter, update the call — it is a rename, not a behaviour change.

Then: `pnpm --filter dispatch-server test`

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/status/service.ts packages/core/src/push/notify.ts packages/core/src/sessions/service.ts packages/core/src/status/settled-listeners.test.ts
git commit -m "refactor(core): settled hook becomes a subscriber list; expose the transport predicate"
```

---

### Task 2: Per-thread capture state

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Create: `packages/core/src/db/usage-pty.ts`
- Test: `packages/core/src/db/usage-pty.test.ts`

**Interfaces:**
- Produces: `interface PtyStateRow { terminal_id: string; transcript_path: string; byte_offset: number; last_total_input: number; last_total_output: number; last_total_cached: number; updated_at: string }`
- Produces: `getState(db, terminalId): PtyStateRow | null`
- Produces: `putState(db, s: PtyStateRow): void` — insert or replace
- Produces: `recordTurn(db, row: ClosedTurnInput, state: PtyStateRow): void` — **one transaction**

One table serves both providers. Claude uses `byte_offset` and ignores the totals; Codex uses the totals and leaves `byte_offset` at 0. That is simpler than two tables and the unused columns are explicit.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/db/usage-pty.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as ptyDb from './usage-pty.js';

const S = {
  terminal_id: 'term1', transcript_path: '/tmp/a.jsonl', byte_offset: 128,
  last_total_input: 0, last_total_output: 0, last_total_cached: 0,
  updated_at: '2026-08-14T10:00:00.000Z',
};

describe('usage_pty_state', () => {
  let d: Database.Database;
  beforeEach(() => { d = new Database(':memory:'); initSchema(d); });

  it('round-trips state and replaces on a second put', () => {
    ptyDb.putState(d, S);
    expect(ptyDb.getState(d, 'term1')!.byte_offset).toBe(128);
    ptyDb.putState(d, { ...S, byte_offset: 512 });
    expect(ptyDb.getState(d, 'term1')!.byte_offset).toBe(512);
    const n = (d.prepare('SELECT COUNT(*) AS n FROM usage_pty_state').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('returns null for a thread it has never seen', () => {
    expect(ptyDb.getState(d, 'nope')).toBeNull();
  });

  // The atomicity guard. If the row lands but the state does not, the next turn
  // re-reads the same range and double-counts.
  it('recordTurn writes the row and the state together, or neither', () => {
    ptyDb.recordTurn(d, {
      id: 'turn1', terminalId: 'term1', projectId: 'p1', provider: 'claude-code',
      model: 'claude-opus-5', role: '', startedAt: '2026-08-14T10:00:00.000Z',
      endedAt: '2026-08-14T10:00:30.000Z', outcome: 'idle',
      input: 10, output: 20, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    }, { ...S, byte_offset: 900 });

    expect((d.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number }).n).toBe(1);
    expect(ptyDb.getState(d, 'term1')!.byte_offset).toBe(900);
  });

  it('recordTurn rolls back the row when the state write fails', () => {
    d.exec('DROP TABLE usage_pty_state');
    expect(() => ptyDb.recordTurn(d, {
      id: 'turn2', terminalId: 'term1', projectId: 'p1', provider: 'claude-code',
      model: '', role: '', startedAt: '2026-08-14T10:00:00.000Z',
      endedAt: '2026-08-14T10:00:30.000Z', outcome: 'idle',
      input: 1, output: 1, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    }, S)).toThrow();
    expect((d.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/db/usage-pty.test.ts`
Expected: FAIL — cannot find `./usage-pty.js`

- [ ] **Step 3: Add the table**

In `packages/core/src/db/schema.ts`, inside the `db.exec(...)` template literal, after `usage_turns` and its indexes:

```sql
    -- Per-thread PTY capture state. A PTY thread emits no frames, so its usage is
    -- read from the provider's own transcript when the turn-settled edge fires.
    --
    -- Claude uses `byte_offset`: its transcript carries per-message usage and no
    -- running total, so a turn's usage is the sum of the messages since the last
    -- read. Codex uses the `last_total_*` columns instead: its transcript carries a
    -- monotonic running total, so a turn's usage is a diff — and a diff needs no
    -- position, which makes Codex immune to the relocation and compaction desync
    -- risks the byte cursor has to defend against.
    --
    -- Both bootstrap from the CURRENT end state at first sight, never from zero.
    -- Starting at zero would attribute a thread's whole history to one turn and
    -- duplicate what the history importer already covers.
    CREATE TABLE IF NOT EXISTS usage_pty_state (
      terminal_id       TEXT PRIMARY KEY,
      transcript_path   TEXT NOT NULL,
      byte_offset       INTEGER NOT NULL DEFAULT 0,
      last_total_input  INTEGER NOT NULL DEFAULT 0,
      last_total_output INTEGER NOT NULL DEFAULT 0,
      last_total_cached INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL
    );
```

- [ ] **Step 4: Write the data-access module**

Create `packages/core/src/db/usage-pty.ts`:

```ts
import type Database from 'better-sqlite3';
import * as usageDb from './usage.js';

export interface PtyStateRow {
  terminal_id: string;
  transcript_path: string;
  byte_offset: number;
  last_total_input: number;
  last_total_output: number;
  last_total_cached: number;
  updated_at: string;
}

export function getState(db: Database.Database, terminalId: string): PtyStateRow | null {
  const row = db.prepare('SELECT * FROM usage_pty_state WHERE terminal_id = ?').get(terminalId);
  return (row as PtyStateRow | undefined) ?? null;
}

export function putState(db: Database.Database, s: PtyStateRow): void {
  db.prepare(`
    INSERT INTO usage_pty_state
      (terminal_id, transcript_path, byte_offset, last_total_input, last_total_output, last_total_cached, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(terminal_id) DO UPDATE SET
      transcript_path   = excluded.transcript_path,
      byte_offset       = excluded.byte_offset,
      last_total_input  = excluded.last_total_input,
      last_total_output = excluded.last_total_output,
      last_total_cached = excluded.last_total_cached,
      updated_at        = excluded.updated_at
  `).run(s.terminal_id, s.transcript_path, s.byte_offset, s.last_total_input, s.last_total_output, s.last_total_cached, s.updated_at);
}

/**
 * Write the turn row and advance the capture state together.
 *
 * These MUST be one transaction. Row first then a crash re-reads the same range on
 * the next turn and double-counts; state first then a crash silently drops a turn.
 * better-sqlite3's `transaction()` rolls back both on any throw.
 */
export function recordTurn(db: Database.Database, row: usageDb.ClosedTurnInput, state: PtyStateRow): void {
  db.transaction(() => {
    usageDb.insertClosed(db, row);
    putState(db, state);
  })();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/db/usage-pty.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/usage-pty.ts packages/core/src/db/usage-pty.test.ts
git commit -m "feat(core): per-thread PTY capture state with an atomic turn write"
```

---

### Task 3: The Claude PTY reader

**Files:**
- Create: `packages/core/src/analytics/pty-claude.ts`
- Test: `packages/core/src/analytics/pty-claude.test.ts`

**Interfaces:**
- Consumes: `usageFromFrame`, `toolCallsInFrame` from `./frames.js`
- Produces: `interface TailResult { input: number; output: number; cacheRead: number; cacheCreate: number; messages: number; toolCalls: number; model: string; nextOffset: number }`
- Produces: `readClaudeTail(file: string, fromOffset: number): TailResult | null` — null when the file cannot be read

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/pty-claude.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readClaudeTail } from './pty-claude.js';

function line(model: string, output: number) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Read' }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
    },
  });
}

describe('readClaudeTail', () => {
  let dir: string, file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-claude-'));
    file = path.join(dir, 's.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('sums only the bytes after the offset', () => {
    fs.writeFileSync(file, line('claude-opus-5', 20) + '\n');
    const first = readClaudeTail(file, 0)!;
    expect(first.output).toBe(20);
    expect(first.messages).toBe(1);
    expect(first.toolCalls).toBe(1);
    expect(first.model).toBe('claude-opus-5');

    fs.appendFileSync(file, line('claude-opus-5', 7) + '\n');
    const second = readClaudeTail(file, first.nextOffset)!;
    expect(second.output).toBe(7);      // NOT 27 — the first message is behind the offset
    expect(second.messages).toBe(1);
    expect(second.nextOffset).toBe(fs.statSync(file).size);
  });

  it('reports zero usage and an advanced offset when nothing new arrived', () => {
    fs.writeFileSync(file, line('claude-opus-5', 20) + '\n');
    const first = readClaudeTail(file, 0)!;
    const again = readClaudeTail(file, first.nextOffset)!;
    expect(again.output).toBe(0);
    expect(again.messages).toBe(0);
    expect(again.nextOffset).toBe(first.nextOffset);
  });

  // Compaction guard: a file shorter than the cursor means something rewrote it.
  // Reading from a stale offset would return garbage, so re-read from the start.
  it('re-reads from zero when the file is shorter than the offset', () => {
    fs.writeFileSync(file, line('claude-opus-5', 20) + '\n');
    const r = readClaudeTail(file, 999999)!;
    expect(r.output).toBe(20);
  });

  it('returns null for a missing file', () => {
    expect(readClaudeTail(path.join(dir, 'nope.jsonl'), 0)).toBeNull();
  });

  it('ignores malformed lines without throwing', () => {
    fs.writeFileSync(file, 'not json\n' + line('claude-opus-5', 5) + '\n\n');
    const r = readClaudeTail(file, 0)!;
    expect(r.output).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pty-claude.test.ts`
Expected: FAIL — cannot find `./pty-claude.js`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/pty-claude.ts`:

```ts
import fs from 'fs';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

export interface TailResult {
  input: number; output: number; cacheRead: number; cacheCreate: number;
  messages: number; toolCalls: number; model: string; nextOffset: number;
}

/**
 * Sum the usage in a Claude transcript from `fromOffset` to the end.
 *
 * A Claude transcript carries per-message usage and no running total, so a turn's
 * usage is the sum of the messages written since the previous read — which is why
 * this needs a byte cursor at all. The Codex reader does not, because it diffs a
 * total that means the same thing wherever it is found.
 *
 * A file SHORTER than the offset means something rewrote it (a compaction is the
 * suspected cause; nobody has verified Claude's transcript is strictly append-only
 * across one). Reading from a stale offset would return garbage, so start over.
 */
export function readClaudeTail(file: string, fromOffset: number): TailResult | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }

  const start = fromOffset > size ? 0 : fromOffset;

  let raw: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf-8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }

  const out: TailResult = {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
    messages: 0, toolCalls: 0, model: '', nextOffset: size,
  };

  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let ev: unknown;
    try { ev = JSON.parse(ln); } catch { continue; }
    out.toolCalls += toolCallsInFrame(ev);
    const usage = usageFromFrame(ev);
    if (!usage) continue;
    out.input += usage.input;
    out.output += usage.output;
    out.cacheRead += usage.cacheRead;
    out.cacheCreate += usage.cacheCreate;
    out.messages += 1;
    if (usage.model) out.model = usage.model;
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pty-claude.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analytics/pty-claude.ts packages/core/src/analytics/pty-claude.test.ts
git commit -m "feat(core): read a Claude PTY transcript tail from a byte cursor"
```

---

### Task 4: Locate a Codex transcript

**Files:**
- Create: `packages/core/src/analytics/codex-locate.ts`
- Test: `packages/core/src/analytics/codex-locate.test.ts`

**Interfaces:**
- Produces: `codexSessionsRoot(): string` and `codexArchivedRoot(): string`
- Produces: `locateCodexTranscript(externalId: string, roots?: { sessions?: string; archived?: string }): string | undefined`

Established by investigation, do not re-derive:
- The uuid in `rollout-<timestamp>-<uuid>.jsonl` **equals** the `external_id` (verified 5 of 5).
- `session_index.jsonl` is stale (last written 2026-06-08) and carries no path field. Do not use it.
- The date bucket is **local** time while `terminals.created_at` is UTC, so a session created late in the evening lands in what a naive UTC conversion calls the previous day. **Never compute one bucket** — glob across them. On the real machine that is 441 files across 51 directories and costs 0.00s, because a filename glob reads metadata only.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/codex-locate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { locateCodexTranscript } from './codex-locate.js';

describe('locateCodexTranscript', () => {
  let root: string, sessions: string, archived: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loc-'));
    sessions = path.join(root, 'sessions');
    archived = path.join(root, 'archived_sessions');
    fs.mkdirSync(path.join(sessions, '2026', '08', '13'), { recursive: true });
    fs.mkdirSync(path.join(sessions, '2026', '08', '14'), { recursive: true });
    fs.mkdirSync(archived, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const roots = () => ({ sessions, archived });

  it('finds a transcript by its id regardless of which date bucket holds it', () => {
    const f = path.join(sessions, '2026', '08', '13', 'rollout-2026-08-13T22-10-00-abc123.jsonl');
    fs.writeFileSync(f, '');
    expect(locateCodexTranscript('abc123', roots())).toBe(f);
  });

  // The real gotcha: the bucket is LOCAL time, the database timestamp is UTC. A
  // locator that computed one bucket from created_at would miss this file entirely.
  it('finds a file whose bucket does not match its UTC date', () => {
    const f = path.join(sessions, '2026', '08', '14', 'rollout-2026-08-14T01-30-00-lateNight.jsonl');
    fs.writeFileSync(f, '');
    expect(locateCodexTranscript('lateNight', roots())).toBe(f);
  });

  it('falls back to archived sessions', () => {
    const f = path.join(archived, 'rollout-2026-07-01T09-00-00-oldId.jsonl');
    fs.writeFileSync(f, '');
    expect(locateCodexTranscript('oldId', roots())).toBe(f);
  });

  it('returns undefined for an unknown id and for an empty id', () => {
    expect(locateCodexTranscript('missing', roots())).toBeUndefined();
    expect(locateCodexTranscript('', roots())).toBeUndefined();
  });

  it('does not throw when the roots do not exist', () => {
    expect(locateCodexTranscript('x', { sessions: '/nope/a', archived: '/nope/b' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/codex-locate.test.ts`
Expected: FAIL — cannot find `./codex-locate.js`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/codex-locate.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export function codexSessionsRoot(): string { return path.join(os.homedir(), '.codex', 'sessions'); }
export function codexArchivedRoot(): string { return path.join(os.homedir(), '.codex', 'archived_sessions'); }

/**
 * Find a Codex transcript from the thread id Dispatch stores.
 *
 * The uuid in `rollout-<timestamp>-<uuid>.jsonl` IS the external_id — verified
 * against real rows. `session_index.jsonl` looks like the obvious answer and is not:
 * it went stale in June and carries no path field.
 *
 * The date directories are LOCAL time while `terminals.created_at` is UTC, so a
 * session started late in the evening sits in a bucket a naive UTC conversion would
 * never look in. Hence a walk over all buckets rather than a computed path. It reads
 * directory entries only — no file contents — which measured 0.00s over 441 files.
 */
export function locateCodexTranscript(
  externalId: string,
  roots: { sessions?: string; archived?: string } = {},
): string | undefined {
  if (!externalId) return undefined;
  const suffix = `-${externalId}.jsonl`;

  const inDir = (dir: string): string | undefined => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = inDir(full);
        if (hit) return hit;
      } else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) {
        return full;
      }
    }
    return undefined;
  };

  return inDir(roots.sessions ?? codexSessionsRoot()) ?? inDir(roots.archived ?? codexArchivedRoot());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/codex-locate.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analytics/codex-locate.ts packages/core/src/analytics/codex-locate.test.ts
git commit -m "feat(core): locate a Codex transcript by thread id"
```

---

### Task 5: Read Codex totals and model

**Files:**
- Create: `packages/core/src/analytics/codex-frames.ts`
- Test: `packages/core/src/analytics/codex-frames.test.ts`

**Interfaces:**
- Produces: `interface CodexTotals { input: number; output: number; cached: number }`
- Produces: `interface CodexTail { totals: CodexTotals | null; model: string }`
- Produces: `readCodexTail(file: string, tailBytes?: number): CodexTail | null`

**The token shape, measured from a real file — do not re-derive:**

```
total_token_usage: { input_tokens: 25591, cached_input_tokens: 11008,
                     output_tokens: 487, reasoning_output_tokens: 343,
                     total_tokens: 26078 }
```

`25591 + 487 = 26078`, so `total = input + output`. `cached_input_tokens` is a **subset** of `input_tokens`, and `reasoning_output_tokens` is a subset of `output_tokens`.

Mapping into `usage_turns`, which follows Claude's semantics where input excludes cache reads:
- `cacheRead` = `cached_input_tokens`
- `input` = `input_tokens - cached_input_tokens`
- `output` = `output_tokens` (reasoning already included)
- `cacheCreate` = 0 — Codex reports none

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/codex-frames.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCodexTail } from './codex-frames.js';

const tokenCount = (input: number, cached: number, output: number) => JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input, cached_input_tokens: cached,
        output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
      },
      last_token_usage: { input_tokens: 999999, cached_input_tokens: 0, output_tokens: 999999, reasoning_output_tokens: 0, total_tokens: 1999998 },
    },
  },
});

const turnContext = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });

describe('readCodexTail', () => {
  let dir: string, file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-frames-'));
    file = path.join(dir, 'r.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('takes the NEWEST total, not the first', () => {
    fs.writeFileSync(file, [tokenCount(100, 10, 5), tokenCount(300, 40, 9)].join('\n') + '\n');
    expect(readCodexTail(file)!.totals).toEqual({ input: 300, cached: 40, output: 9 });
  });

  it('takes the newest model from turn_context', () => {
    fs.writeFileSync(file, [turnContext('gpt-5.6-terra'), tokenCount(1, 0, 1), turnContext('gpt-5.6-sol')].join('\n') + '\n');
    expect(readCodexTail(file)!.model).toBe('gpt-5.6-sol');
  });

  // The guard on a measured 0.96% overcount. last_token_usage is deliberately absurd
  // in these fixtures: if anything ever reads it, these numbers make it obvious.
  it('never reads last_token_usage', () => {
    fs.writeFileSync(file, tokenCount(50, 5, 7) + '\n');
    const t = readCodexTail(file)!.totals!;
    expect(t.input).toBe(50);
    expect(t.output).toBe(7);
  });

  it('returns null totals when the file has no token_count at all', () => {
    fs.writeFileSync(file, turnContext('gpt-5.6-sol') + '\n');
    const r = readCodexTail(file)!;
    expect(r.totals).toBeNull();
    expect(r.model).toBe('gpt-5.6-sol');
  });

  it('returns null for a missing file and survives malformed lines', () => {
    expect(readCodexTail(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(file, 'garbage\n' + tokenCount(2, 0, 3) + '\n');
    expect(readCodexTail(file)!.totals).toEqual({ input: 2, cached: 0, output: 3 });
  });

  it('widens the read when the tail window holds no token_count', () => {
    const filler = 'x'.repeat(4096);
    fs.writeFileSync(file, tokenCount(11, 1, 2) + '\n' + JSON.stringify({ type: 'response_item', payload: { filler } }) + '\n');
    expect(readCodexTail(file, 512)!.totals).toEqual({ input: 11, cached: 1, output: 2 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/codex-frames.test.ts`
Expected: FAIL — cannot find `./codex-frames.js`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/codex-frames.ts`:

```ts
import fs from 'fs';

export interface CodexTotals { input: number; output: number; cached: number }
export interface CodexTail { totals: CodexTotals | null; model: string }

const DEFAULT_TAIL_BYTES = 256 * 1024;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Read the newest running total and the newest model from a Codex transcript.
 *
 * Deliberately reads `total_token_usage` and NEVER `last_token_usage`. The latter
 * looks like a per-turn delta and is not: it breaks the delta invariant in 9 of 648
 * real transitions, and summing it overcounts one real file by 767,661 tokens
 * (0.96%). The total is monotonic across those same 648 transitions and survives a
 * /compact, so a diff of totals is the honest per-turn figure.
 *
 * Only the NEWEST of each matters, so a bounded tail read suffices. The window widens
 * to the whole file if the tail holds neither — a quiet turn can be a long way from
 * the last token_count.
 */
export function readCodexTail(file: string, tailBytes: number = DEFAULT_TAIL_BYTES): CodexTail | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }

  const scan = (from: number): CodexTail => {
    let raw = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const len = size - from;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        raw = buf.toString('utf-8');
      } finally { fs.closeSync(fd); }
    } catch { return { totals: null, model: '' }; }

    const out: CodexTail = { totals: null, model: '' };
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(ln); } catch { continue; }

      if (ev?.type === 'turn_context' && typeof ev?.payload?.model === 'string') {
        out.model = ev.payload.model;
        continue;
      }
      const info = ev?.payload?.type === 'token_count' ? ev?.payload?.info : undefined;
      const total = info?.total_token_usage;
      if (total && typeof total === 'object') {
        out.totals = {
          input: num(total.input_tokens),
          cached: num(total.cached_input_tokens),
          output: num(total.output_tokens),
        };
      }
    }
    return out;
  };

  const from = size > tailBytes ? size - tailBytes : 0;
  const first = scan(from);
  if (first.totals || from === 0) return first;
  return scan(0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/codex-frames.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analytics/codex-frames.ts packages/core/src/analytics/codex-frames.test.ts
git commit -m "feat(core): read Codex running totals and per-turn model"
```

---

### Task 6: The capture service

**Files:**
- Create: `packages/core/src/analytics/pty-capture.ts`
- Test: `packages/core/src/analytics/pty-capture.test.ts`

**Interfaces:**
- Consumes: `getState`/`putState`/`recordTurn` (Task 2), `readClaudeTail` (Task 3), `locateCodexTranscript` (Task 4), `readCodexTail` (Task 5), `resolveTranscriptPath` from `../sessions/transcript-path.js`
- Produces: `attachPtyCapture(deps: PtyCaptureDeps): SettledListener`
- `PtyCaptureDeps = { db: Database.Database; isStructured: (terminalId: string) => boolean; now?: () => string; onTurnClosed?: () => void }`

Returns the listener rather than subscribing itself, so a test can drive it directly and `server.ts` decides where it attaches.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/pty-capture.test.ts`. It must cover, at minimum:

```ts
// The double-count gate. This is the most important test in the plan.
it('writes NOTHING for a structured terminal', () => { /* isStructured: () => true */ });

// Bootstrap. A thread seen for the first time records its position and writes no row,
// or the whole of its history lands in one turn and duplicates the importer.
it('writes no row on first sight, and records the end position', () => { /* … */ });

it('writes one row on the second settle, covering only the new bytes (claude-code)', () => { /* … */ });

it('diffs the running total for a codex terminal', () => { /* … */ });

it('records zero and resets when a codex total goes backwards', () => { /* … */ });

it('starts fresh when a claude transcript path changes (relocation)', () => { /* … */ });

it('writes nothing for a grok terminal', () => { /* … */ });

it('never throws when the transcript is missing', () => { /* … */ });
```

Write these out fully, driving a real in-memory database and real temp files as the other analytics tests do. Assert on rows read back from `usage_turns`, not on mock calls.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pty-capture.test.ts`
Expected: FAIL — cannot find `./pty-capture.js`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/pty-capture.ts`. The shape:

```ts
export function attachPtyCapture(deps: PtyCaptureDeps): SettledListener {
  return ({ terminalId, sessionId, threadStatus }) => {
    try {
      // 1. GATE. A structured thread is already covered by the live recorder.
      //    markIdle() fires this same settled edge for structured threads, so
      //    without this check every structured turn gets a second row.
      if (deps.isStructured(terminalId)) return;

      // 2. Resolve the terminal, its provider, and its transcript.
      //    claude-code -> resolveTranscriptPath(workDir, external_id)
      //    codex       -> locateCodexTranscript(external_id)
      //    anything else (grok, shell) -> return

      // 3. First sight -> putState with the CURRENT end position/total. No row.

      // 4. Path changed since last time (claude) -> treat as fresh: putState at the
      //    new file's end, no row. A byte offset from another file is meaningless.

      // 5. Read, compute the turn's usage, and recordTurn(row, nextState) — one
      //    transaction. outcome is 'needs_help' when threadStatus is 'needs_input',
      //    otherwise 'idle'. startedAt is the previous state's updated_at, endedAt is
      //    now, so the row carries a real duration.

      // 6. deps.onTurnClosed?.()
    } catch { /* analytics must never break a turn */ }
  };
}
```

Write it out fully. Keep every branch inside the single `try`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pty-capture.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full core suite**

Run: `pnpm --filter dispatch-server test`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analytics/pty-capture.ts packages/core/src/analytics/pty-capture.test.ts
git commit -m "feat(core): capture PTY turn usage on the settled edge"
```

---

### Task 7: Wire the capture service into the server

**Files:**
- Modify: `packages/core/src/server.ts` — both `createApp` and `startServer`
- Test: `packages/core/src/analytics/pty-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Assert that after `createApp({ db, skipPty: true })`, a settled edge on a PTY terminal produces a `usage_pty_state` row — proving the listener is attached in the app builder, not only in `startServer`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pty-wiring.test.ts`

- [ ] **Step 3: Wire it**

In both builders, beside the existing `wireThreadSettledPush(db, statusService, pushService);`:

```ts
  statusService.addThreadSettledListener(attachPtyCapture({
    db,
    isStructured: (terminalId) => {
      const t = terminalsDb.getById(db, terminalId);
      return !!t && sessionService.isStructuredTerminal(t);
    },
    onTurnClosed: () => broadcaster.broadcast({ type: 'analytics-dirty' }),
  }));
```

Import with an explicit `.js` extension.

- [ ] **Step 4: Verify the daemon still starts**

Run: `pnpm --filter dispatch-server build` then
`node --input-type=module -e "await import('./packages/core/dist/server.js'); console.log('OK')"`

- [ ] **Step 5: Run the full core suite, then commit**

```bash
git add packages/core/src/server.ts packages/core/src/analytics/pty-wiring.test.ts
git commit -m "feat(core): attach PTY usage capture in both app builders"
```

---

### Task 8: Make the history importer provider-aware

**Files:**
- Modify: `packages/core/src/routes/analytics.ts:101`
- Modify: `packages/core/src/analytics/importer.ts`
- Test: `packages/core/src/analytics/importer.test.ts`

`routes/analytics.ts:101` calls the Claude-only `resolveTranscriptPath` for **every** provider. For a Codex terminal it always returns undefined, so Codex threads silently import zero rows today — a bug that shipped with the importer, independent of PTY.

Now that a Codex locator and parser exist, route by provider and give Codex history for free.

- [ ] **Step 1: Write the failing test**

Assert that a Codex terminal with a real temp transcript imports rows, and that its tokens map as `cacheRead = cached_input_tokens`, `input = input_tokens - cached_input_tokens`.

Codex has no per-message usage, so an import must derive per-turn rows by walking the totals **forward** and diffing consecutive `token_count` events — the same arithmetic the live path uses, applied across the file.

- [ ] **Step 2: Run the test to verify it fails**

- [ ] **Step 3: Implement**

Add a Codex branch to the importer that walks `token_count` events in order, diffs consecutive totals, and attributes each diff to the model named by the most recent preceding `turn_context`. Route on `terminal.type` in the route's thread-collection loop.

- [ ] **Step 4: Run the tests, then commit**

```bash
git add packages/core/src/routes/analytics.ts packages/core/src/analytics/importer.ts packages/core/src/analytics/importer.test.ts
git commit -m "fix(core): import Codex history, which silently imported nothing"
```

---

### Task 9: End-to-end verification

No production code. Prove the feature works in a real process.

- [ ] **Step 1: Build**

`pnpm -r build`

- [ ] **Step 2: Verify against real data, read-only**

With the daemon NOT running against it, open a **copy** of `~/.dispatch/dispatch.db` and confirm:
- `usage_pty_state` exists after a boot.
- Picking a real Codex `external_id`, `locateCodexTranscript` finds its file.
- `readCodexTail` on that file returns plausible totals and a real model string.

Never write to the user's live database. Copy it first.

- [ ] **Step 3: Drive one real PTY turn**

Start an isolated daemon (a fake data dir, an unusual port). Run one Claude Code PTY thread through a turn. Confirm exactly one `usage_turns` row, with a real model and non-zero output tokens.

- [ ] **Step 4: Prove the gate**

Run one **structured** thread through a turn on the same instance. Confirm it produced exactly one row, from the live recorder — not two.

This is the check the whole design exists to satisfy. If it produces two rows, stop and report.

- [ ] **Step 5: Report**

State each result with its actual output. An honest NOT VERIFIED beats a guess.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 trigger, subscriber list, transport gate | 1, 6, 7 |
| §3 Claude byte cursor | 2, 3 |
| §3 Codex total diff | 2, 5 |
| §4 Codex locator, local-vs-UTC bucket | 4 |
| §5 model attribution per turn | 5, 6 |
| §6 bootstrap, atomicity, relocation, compaction | 2, 3, 6 |
| §7 Grok uncovered | 6 |
| §8 importer provider-awareness | 8 |
| §10 testing | every task, plus 9 |

**Deliberate gap:** Task 6 and Task 8 give test *names* and a structural outline rather than complete literal bodies, because both depend on fixture shapes the implementer will confirm against the real modules from Tasks 2-5. Every other task carries full code. The named tests are mandatory; an implementer who ships fewer must say which and why.

**Type consistency:** `TailResult` (Task 3) and `CodexTotals`/`CodexTail` (Task 5) are distinct on purpose — Claude yields summed usage plus an offset, Codex yields a point-in-time total. Task 6 maps both into `ClosedTurnInput` from `db/usage.ts`, whose field names (`input`/`output`/`cacheRead`/`cacheCreate`) match `UsageDelta` and `FrameUsage` already in the codebase.
