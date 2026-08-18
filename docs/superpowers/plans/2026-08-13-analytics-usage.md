# Analytics View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every structured turn as it happens, and show usage, throughput, and personal stats in a new Analytics view.

**Architecture:** A recorder subscribes to the structured manager's existing turn events (`busy`, `event`, `idle`, `needs-help`, `scheduled`, `exit`) and writes one row per turn into a new `usage_turns` table. Nothing polls, and no background job runs. A query layer aggregates that table behind `/api/analytics`, and a lazy-loaded React view draws the charts with Recharts.

**Tech Stack:** TypeScript, better-sqlite3, Express, Node EventEmitter, React 18, Zustand, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-analytics-usage-design.md`

## Global Constraints

- **Worktree.** All work happens in `.claude/worktrees/analytics-usage` on branch `worktree-analytics-usage`. Never `cd` to the main checkout.
- **Never use bare `git stash` / `git stash pop`.** The stash stack is shared with other worktrees and other sessions. Use a temporary WIP commit instead. If you must stash, use `git stash push -u -m "<unique-tag>"`, capture the SHA with `git stash list --format='%H %gs'`, and restore with `git stash apply <sha>`.
- **ESM imports in `packages/core` need explicit `.js` extensions.** `import * as usageDb from '../db/usage.js'`. The build and the tests pass without them, but the daemon will not start.
- **One writer per row class.** The recorder is the only thing that writes live turn rows (`backfilled = 0`). The importer writes only `backfilled = 1` rows, and only for turns older than the tracking cutoff. Nothing else writes `usage_turns` at all. `persistAgentTokenUsage` keeps writing `config.totalTokens` for the Done cards and must not be changed.
- **Analytics must never break a turn.** Every recorder entry point is wrapped in `try { … } catch { /* best effort */ }`.
- **Cost is notional.** Any dollar figure is labelled "equivalent API value", never "cost" or "spend".
- **Categorical palette, fixed order, never cycled:** `#3987e5`, `#d95926`, `#199e70`, `#c98500`, `#d55181`. A sixth series folds into "Other" (`#6b6b73`).
- **Status colors are reserved.** `--color-accent` `#3ECF6A`, `--color-status-yellow` `#F5C542`, `--color-status-red` `#F0616D` are only for turn outcomes, never for a model series.
- **No dual-axis charts.** Two measures of different scale get two charts.
- **Commit after every task.** Uncommitted worktree edits can vanish on session resume.

**Test commands:**
- Core, one file: `pnpm --filter dispatch-server exec vitest run src/<path>.test.ts`
- Core, all: `pnpm --filter dispatch-server test`
- Web, one file: `pnpm --filter dispatch-web exec vitest run src/<path>.test.tsx`
- Web, all: `pnpm --filter dispatch-web test`

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/db/schema.ts` | Add the `usage_turns` table and its indexes (modify) |
| `packages/core/src/db/usage.ts` | All SQL for `usage_turns`. No business logic. |
| `packages/core/src/analytics/frames.ts` | Read usage and tool-call counts out of a stream frame. Pure functions. |
| `packages/core/src/analytics/recorder.ts` | Subscribe to manager events, open/update/close turn rows |
| `packages/core/src/analytics/pricing.ts` | Per-model prices and the notional-value calculation |
| `packages/core/src/analytics/queries.ts` | Aggregations: summary, series, top, records |
| `packages/core/src/analytics/importer.ts` | The manual one-off history import |
| `packages/core/src/routes/analytics.ts` | HTTP surface over `queries.ts` and `importer.ts` |
| `packages/core/src/server.ts` | Attach the recorder, close interrupted rows, mount the router (modify) |
| `packages/web/src/api/client.ts` | Analytics fetch methods (modify) |
| `packages/web/src/api/types.ts` | Analytics response types (modify) |
| `packages/web/src/components/analytics/chartTheme.ts` | Resolve CSS custom properties to hex for Recharts |
| `packages/web/src/components/analytics/AnalyticsView.tsx` | The page: filters, tiles, charts |
| `packages/web/src/components/analytics/charts.tsx` | The individual chart components |
| `packages/web/src/stores/ui.ts` | Add `'analytics'` to `View` (modify) |
| `packages/web/src/components/layout/TopBar.tsx` | Add the Analytics segment (modify) |
| `packages/web/src/App.tsx` | Render the view (modify) |
| `packages/web/src/components/mobile/MobileApp.tsx` | Add the fifth bottom tab (modify) |

---

### Task 1: The `usage_turns` table and its data access

**Files:**
- Modify: `packages/core/src/db/schema.ts:4-145`
- Create: `packages/core/src/db/usage.ts`
- Test: `packages/core/src/db/usage.test.ts`

**Interfaces:**
- Consumes: `initSchema(db)` from `./schema.js`
- Produces:
  - `interface TurnRow` — the raw row shape
  - `openTurn(db, input: OpenTurnInput): void`
  - `findOpenTurn(db, terminalId: string): TurnRow | null`
  - `addUsage(db, turnId: string, delta: UsageDelta): void`
  - `closeTurn(db, turnId: string, at: string, outcome: string): void`
  - `setModelIfEmpty(db, turnId: string, model: string): void`
  - `insertClosed(db, row: ClosedTurnInput): void`
  - `deleteBackfilled(db): number`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/db/usage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as usageDb from './usage.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

const OPEN = {
  id: 't1', terminalId: 'term1', projectId: 'proj1', provider: 'claude-code',
  model: 'claude-opus-5', role: 'agent', startedAt: '2026-08-13T10:00:00.000Z',
};

describe('usage_turns db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('opens a turn that reads back as open', () => {
    usageDb.openTurn(d, OPEN);
    const row = usageDb.findOpenTurn(d, 'term1');
    expect(row?.id).toBe('t1');
    expect(row?.ended_at).toBeNull();
    expect(row?.input_tokens).toBe(0);
  });

  it('adds usage deltas cumulatively', () => {
    usageDb.openTurn(d, OPEN);
    usageDb.addUsage(d, 't1', { input: 10, output: 5, cacheRead: 2, cacheCreate: 1, messages: 1, toolCalls: 0 });
    usageDb.addUsage(d, 't1', { input: 3, output: 7, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 2 });
    const row = usageDb.findOpenTurn(d, 'term1')!;
    expect(row.input_tokens).toBe(13);
    expect(row.output_tokens).toBe(12);
    expect(row.cache_read_tokens).toBe(2);
    expect(row.messages).toBe(2);
    expect(row.tool_calls).toBe(2);
  });

  it('closes a turn so it is no longer open', () => {
    usageDb.openTurn(d, OPEN);
    usageDb.closeTurn(d, 't1', '2026-08-13T10:01:00.000Z', 'idle');
    expect(usageDb.findOpenTurn(d, 'term1')).toBeNull();
  });

  it('setModelIfEmpty fills a blank model but never overwrites one', () => {
    usageDb.openTurn(d, { ...OPEN, model: '' });
    usageDb.setModelIfEmpty(d, 't1', 'claude-sonnet-5');
    expect(usageDb.findOpenTurn(d, 'term1')!.model).toBe('claude-sonnet-5');
    usageDb.setModelIfEmpty(d, 't1', 'claude-haiku-4-5');
    expect(usageDb.findOpenTurn(d, 'term1')!.model).toBe('claude-sonnet-5');
  });

  it('deleteBackfilled removes only imported rows', () => {
    usageDb.insertClosed(d, { ...OPEN, id: 'live', endedAt: '2026-08-13T10:01:00.000Z', outcome: 'idle',
      input: 1, output: 1, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false });
    usageDb.insertClosed(d, { ...OPEN, id: 'old', endedAt: '2026-08-01T10:01:00.000Z', outcome: 'idle',
      input: 1, output: 1, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: true });
    expect(usageDb.deleteBackfilled(d)).toBe(1);
    const all = d.prepare('SELECT id FROM usage_turns').all() as { id: string }[];
    expect(all.map((r) => r.id)).toEqual(['live']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/db/usage.test.ts`
Expected: FAIL — `Cannot find module './usage.js'`

- [ ] **Step 3: Add the table to the schema**

In `packages/core/src/db/schema.ts`, inside the `db.exec(...)` template literal, after the `thread_watches` block and before the closing backtick, add:

```sql
    -- One row per structured turn, written live by analytics/recorder.ts as the
    -- turn's own events arrive. This is the ONLY table analytics reads; no query
    -- ever touches a transcript. `backfilled` marks a row imported by the manual
    -- history importer, which only ever writes turns older than
    -- app_state's `analytics_tracking_started_at` — so imported and measured
    -- rows can never describe the same turn.
    CREATE TABLE IF NOT EXISTS usage_turns (
      id                  TEXT PRIMARY KEY,
      terminal_id         TEXT NOT NULL,
      project_id          TEXT NOT NULL,
      provider            TEXT NOT NULL,
      model               TEXT NOT NULL DEFAULT '',
      role                TEXT NOT NULL DEFAULT '',
      started_at          TEXT NOT NULL,
      ended_at            TEXT,
      outcome             TEXT,
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      messages            INTEGER NOT NULL DEFAULT 0,
      tool_calls          INTEGER NOT NULL DEFAULT 0,
      backfilled          INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_turns_started  ON usage_turns(started_at);
    CREATE INDEX IF NOT EXISTS idx_usage_turns_terminal ON usage_turns(terminal_id);
    CREATE INDEX IF NOT EXISTS idx_usage_turns_project  ON usage_turns(project_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_usage_turns_open     ON usage_turns(terminal_id) WHERE ended_at IS NULL;
```

- [ ] **Step 4: Write the data-access module**

Create `packages/core/src/db/usage.ts`:

```ts
import type Database from 'better-sqlite3';

export interface TurnRow {
  id: string;
  terminal_id: string;
  project_id: string;
  provider: string;
  model: string;
  role: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  messages: number;
  tool_calls: number;
  backfilled: number;
}

export interface OpenTurnInput {
  id: string;
  terminalId: string;
  projectId: string;
  provider: string;
  model: string;
  role: string;
  startedAt: string;
}

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  messages: number;
  toolCalls: number;
}

export interface ClosedTurnInput extends OpenTurnInput, UsageDelta {
  endedAt: string;
  outcome: string;
  backfilled: boolean;
}

export function openTurn(db: Database.Database, input: OpenTurnInput): void {
  db.prepare(`
    INSERT INTO usage_turns (id, terminal_id, project_id, provider, model, role, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.terminalId, input.projectId, input.provider, input.model, input.role, input.startedAt);
}

/** The newest still-open turn for a terminal, or null. */
export function findOpenTurn(db: Database.Database, terminalId: string): TurnRow | null {
  return db.prepare(`
    SELECT * FROM usage_turns
    WHERE terminal_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(terminalId) as TurnRow | null;
}

/**
 * Add a frame's usage to an open turn. Deliberately additive SQL rather than a
 * read-modify-write in JS: the recorder writes through on every frame, so a
 * daemon restart mid-turn loses nothing, and there is no in-memory counter that
 * could drift from the row.
 */
export function addUsage(db: Database.Database, turnId: string, d: UsageDelta): void {
  db.prepare(`
    UPDATE usage_turns SET
      input_tokens        = input_tokens        + ?,
      output_tokens       = output_tokens       + ?,
      cache_read_tokens   = cache_read_tokens   + ?,
      cache_create_tokens = cache_create_tokens + ?,
      messages            = messages            + ?,
      tool_calls          = tool_calls          + ?
    WHERE id = ?
  `).run(d.input, d.output, d.cacheRead, d.cacheCreate, d.messages, d.toolCalls, turnId);
}

/** Set the model on a turn that opened without one (the frame names it, the terminal row may not). */
export function setModelIfEmpty(db: Database.Database, turnId: string, model: string): void {
  db.prepare(`UPDATE usage_turns SET model = ? WHERE id = ? AND model = ''`).run(model, turnId);
}

export function closeTurn(db: Database.Database, turnId: string, at: string, outcome: string): void {
  db.prepare(`UPDATE usage_turns SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL`)
    .run(at, outcome, turnId);
}

export function insertClosed(db: Database.Database, r: ClosedTurnInput): void {
  db.prepare(`
    INSERT INTO usage_turns (
      id, terminal_id, project_id, provider, model, role, started_at, ended_at, outcome,
      input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, messages, tool_calls, backfilled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.terminalId, r.projectId, r.provider, r.model, r.role, r.startedAt, r.endedAt, r.outcome,
    r.input, r.output, r.cacheRead, r.cacheCreate, r.messages, r.toolCalls, r.backfilled ? 1 : 0,
  );
}

export function deleteBackfilled(db: Database.Database): number {
  return db.prepare(`DELETE FROM usage_turns WHERE backfilled = 1`).run().changes;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/db/usage.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Run the whole core suite to check nothing regressed**

Run: `pnpm --filter dispatch-server test`
Expected: PASS — the baseline is 126 files / 1210 tests, so expect 127 files / 1215 tests

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/usage.ts packages/core/src/db/usage.test.ts
git commit -m "feat(core): usage_turns table and data access"
```

---

### Task 2: Read usage out of a stream frame

**Files:**
- Create: `packages/core/src/analytics/frames.ts`
- Test: `packages/core/src/analytics/frames.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface FrameUsage { input: number; output: number; cacheRead: number; cacheCreate: number; model: string }`
  - `usageFromFrame(ev: unknown): FrameUsage | null`
  - `toolCallsInFrame(ev: unknown): number`

Both Claude Code and Codex reach this function in Claude's shape: Claude emits it natively, and `structured/codex-translate.ts` translates Codex frames into the same `{ type: 'assistant', message: { usage } }` envelope. So one parser serves both, and no per-provider code is needed.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/frames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

const claudeFrame = {
  type: 'assistant',
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 12, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
  },
};

describe('usageFromFrame', () => {
  it('reads Claude/Codex assistant usage', () => {
    expect(usageFromFrame(claudeFrame)).toEqual({
      input: 12, output: 30, cacheRead: 900, cacheCreate: 40, model: 'claude-opus-5',
    });
  });

  it('treats missing usage counters as zero, not NaN', () => {
    const u = usageFromFrame({ type: 'assistant', message: { usage: { output_tokens: 5 } } })!;
    expect(u).toEqual({ input: 0, output: 5, cacheRead: 0, cacheCreate: 0, model: '' });
  });

  it('returns null for a frame with no usage block', () => {
    expect(usageFromFrame({ type: 'system', subtype: 'init' })).toBeNull();
    expect(usageFromFrame({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(usageFromFrame(null)).toBeNull();
    expect(usageFromFrame('nonsense')).toBeNull();
  });
});

describe('toolCallsInFrame', () => {
  it('counts tool_use blocks', () => {
    expect(toolCallsInFrame({ type: 'assistant', message: { content: [
      { type: 'text', text: 'a' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' },
    ] } })).toBe(2);
  });

  it('returns 0 when there is no content array', () => {
    expect(toolCallsInFrame({ type: 'result' })).toBe(0);
    expect(toolCallsInFrame(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/frames.test.ts`
Expected: FAIL — `Cannot find module './frames.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/frames.ts`:

```ts
/**
 * Pull token usage and tool-call counts out of a structured stream frame.
 *
 * Claude Code emits `{ type:'assistant', message:{ model, content, usage } }` natively,
 * and structured/codex-translate.ts rebuilds Codex frames into the same envelope
 * (see its `usage: { input_tokens, cache_read_input_tokens, output_tokens }` construction).
 * So a single parser covers both providers and analytics needs no per-provider code.
 *
 * A provider that never reaches the structured manager at all — Grok, and anything
 * else running as a raw PTY — produces no frames here. Its threads record no turns,
 * which the API reports as "usage not reported", never as zero.
 */

export interface FrameUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  model: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function message(ev: unknown): Record<string, any> | null {
  if (!ev || typeof ev !== 'object') return null;
  const msg = (ev as Record<string, any>).message;
  return msg && typeof msg === 'object' ? msg : null;
}

export function usageFromFrame(ev: unknown): FrameUsage | null {
  const msg = message(ev);
  const usage = msg?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreate: num(usage.cache_creation_input_tokens),
    model: typeof msg.model === 'string' ? msg.model : '',
  };
}

export function toolCallsInFrame(ev: unknown): number {
  const content = message(ev)?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && typeof b === 'object' && b.type === 'tool_use').length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/frames.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analytics/frames.ts packages/core/src/analytics/frames.test.ts
git commit -m "feat(core): parse token usage out of structured stream frames"
```

---

### Task 3: The recorder

**Files:**
- Create: `packages/core/src/analytics/recorder.ts`
- Test: `packages/core/src/analytics/recorder.test.ts`

**Interfaces:**
- Consumes: `usageDb.*` from Task 1, `usageFromFrame` / `toolCallsInFrame` from Task 2, `terminalsDb.getById`
- Produces: `attachUsageRecorder(manager: EventEmitter, deps: RecorderDeps): void`, where `RecorderDeps = { db: Database.Database; now?: () => string; onTurnClosed?: () => void }`

The event names and payloads come from `structured/manager.ts` and are already wired in `server.ts:118-175`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/recorder.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import { attachUsageRecorder } from './recorder.js';

const FRAME = {
  type: 'assistant',
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }],
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  },
};

function rows(d: Database.Database) {
  return d.prepare('SELECT * FROM usage_turns ORDER BY started_at').all() as usageDb.TurnRow[];
}

describe('usage recorder', () => {
  let d: Database.Database;
  let mgr: EventEmitter;
  let termId: string;

  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    const projectId = sessionsDb.create(d, { provider: 'claude-code', name: 'P', workingDir: '/tmp/p' });
    termId = terminalsDb.create(d, { sessionId: projectId, type: 'claude-code', label: 'chat' });
    terminalsDb.updateConfig(d, termId, { role: 'coordinator' });
    mgr = new EventEmitter();
    attachUsageRecorder(mgr, { db: d });
  });

  it('records one closed turn for busy → frame → idle', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, FRAME);
    mgr.emit('idle', termId, { declared: true });

    const all = rows(d);
    expect(all.length).toBe(1);
    expect(all[0].output_tokens).toBe(20);
    expect(all[0].input_tokens).toBe(10);
    expect(all[0].cache_read_tokens).toBe(5);
    expect(all[0].tool_calls).toBe(1);
    expect(all[0].messages).toBe(1);
    expect(all[0].model).toBe('claude-opus-5');
    expect(all[0].outcome).toBe('idle');
    expect(all[0].ended_at).not.toBeNull();
  });

  // The regression test for the noteAgentCompletion trap: that hook returns early
  // on role !== 'agent', so a recorder hung off it would silently miss chat threads.
  it('records a turn for a non-agent chat thread', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, FRAME);
    mgr.emit('idle', termId, { declared: false });
    expect(rows(d).length).toBe(1);
    expect(rows(d)[0].role).toBe('coordinator');
  });

  it('sums several frames into one turn without double counting', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, FRAME);
    mgr.emit('event', termId, FRAME);
    mgr.emit('idle', termId, { declared: true });
    const all = rows(d);
    expect(all.length).toBe(1);
    expect(all[0].output_tokens).toBe(40);
    expect(all[0].messages).toBe(2);
  });

  it('closes with the right outcome for needs-help, scheduled and exit', () => {
    for (const [event, payload, outcome] of [
      ['needs-help', { ask: 'a', summary: 's', inferred: false }, 'needs_help'],
      ['scheduled', 'waking later', 'scheduled'],
      ['exit', 0, 'exit'],
    ] as const) {
      mgr.emit('busy', termId);
      mgr.emit('event', termId, FRAME);
      mgr.emit(event, termId, payload);
      const open = usageDb.findOpenTurn(d, termId);
      expect(open).toBeNull();
    }
    expect(rows(d).map((r) => r.outcome)).toEqual(['needs_help', 'scheduled', 'exit']);
  });

  it('ignores frames that arrive with no open turn', () => {
    mgr.emit('event', termId, FRAME);
    expect(rows(d).length).toBe(0);
  });

  it('ignores events for an unknown terminal', () => {
    mgr.emit('busy', 'ghost');
    mgr.emit('idle', 'ghost', { declared: true });
    expect(rows(d).length).toBe(0);
  });

  it('never throws when the database rejects a write', () => {
    d.exec('DROP TABLE usage_turns');
    expect(() => {
      mgr.emit('busy', termId);
      mgr.emit('event', termId, FRAME);
      mgr.emit('idle', termId, { declared: true });
    }).not.toThrow();
  });

  it('calls onTurnClosed once per closed turn', () => {
    let closed = 0;
    const m2 = new EventEmitter();
    attachUsageRecorder(m2, { db: d, onTurnClosed: () => { closed += 1; } });
    m2.emit('busy', termId);
    m2.emit('idle', termId, { declared: true });
    expect(closed).toBe(1);
  });
});
```

- [ ] **Step 2: Verify the helper signatures the test relies on**

Run: `rg -n "export function create" packages/core/src/db/sessions.ts packages/core/src/db/terminals.ts`
If `sessionsDb.create` or `terminalsDb.create` take different fields than the test uses, fix the test's setup to match the real signature. Do not change the production modules.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/recorder.test.ts`
Expected: FAIL — `Cannot find module './recorder.js'`

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/analytics/recorder.ts`:

```ts
import { randomUUID } from 'crypto';
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import * as usageDb from '../db/usage.js';
import * as terminalsDb from '../db/terminals.js';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

export interface RecorderDeps {
  db: Database.Database;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => string;
  /** Called after a turn row closes, so the server can broadcast a refresh hint. */
  onTurnClosed?: () => void;
}

/**
 * Record one row per structured turn, live, from the events the manager already
 * emits (server.ts:118-175 wires the same ones for status).
 *
 * Deliberately NOT hung off sessionService.noteAgentCompletion: that returns early
 * on `cfg.role !== 'agent'` (service.ts:1117), so it never runs for ordinary chat
 * threads and half the usage would vanish. The manager's own events fire for every
 * structured thread.
 *
 * Every handler is best-effort. Analytics must never break a turn.
 */
export function attachUsageRecorder(manager: EventEmitter, deps: RecorderDeps): void {
  const { db, onTurnClosed } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  const close = (terminalId: string, outcome: string): void => {
    try {
      const open = usageDb.findOpenTurn(db, terminalId);
      if (!open) return;
      usageDb.closeTurn(db, open.id, now(), outcome);
      onTurnClosed?.();
    } catch { /* best effort */ }
  };

  manager.on('busy', (terminalId: string) => {
    try {
      // A turn that never settled (a resume over a live turn) is closed first, so
      // one terminal can never hold two open rows.
      const stale = usageDb.findOpenTurn(db, terminalId);
      if (stale) usageDb.closeTurn(db, stale.id, now(), 'interrupted');

      const terminal = terminalsDb.getById(db, terminalId);
      if (!terminal) return;
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }

      usageDb.openTurn(db, {
        id: randomUUID(),
        terminalId,
        projectId: terminal.session_id,
        provider: terminal.type,
        model: typeof cfg.model === 'string' ? cfg.model : '',
        role: typeof cfg.role === 'string' ? cfg.role : '',
        startedAt: now(),
      });
    } catch { /* best effort */ }
  });

  manager.on('event', (terminalId: string, ev: unknown) => {
    try {
      const usage = usageFromFrame(ev);
      const toolCalls = toolCallsInFrame(ev);
      if (!usage && !toolCalls) return;

      const open = usageDb.findOpenTurn(db, terminalId);
      if (!open) return; // a frame outside a turn is not attributable; drop it

      usageDb.addUsage(db, open.id, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheCreate: usage?.cacheCreate ?? 0,
        messages: usage ? 1 : 0,
        toolCalls,
      });
      if (usage?.model) usageDb.setModelIfEmpty(db, open.id, usage.model);
    } catch { /* best effort */ }
  });

  manager.on('idle', (terminalId: string) => close(terminalId, 'idle'));
  manager.on('needs-help', (terminalId: string) => close(terminalId, 'needs_help'));
  manager.on('scheduled', (terminalId: string) => close(terminalId, 'scheduled'));
  manager.on('exit', (terminalId: string) => close(terminalId, 'exit'));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/recorder.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analytics/recorder.ts packages/core/src/analytics/recorder.test.ts
git commit -m "feat(core): record each structured turn from manager events"
```

---

### Task 4: Wire the recorder into the server

**Files:**
- Modify: `packages/core/src/server.ts:118-176` and its import block
- Test: `packages/core/src/analytics/startup.test.ts`

**Interfaces:**
- Consumes: `attachUsageRecorder` (Task 3), `usageDb.closeAllOpen` (Task 1), `EventBroadcaster` from `ws/events.js`
- Produces: `closeInterruptedTurns(db, now?): number` exported from `packages/core/src/analytics/recorder.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/startup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { closeInterruptedTurns } from './recorder.js';

describe('closeInterruptedTurns', () => {
  it('closes rows left open by a dead daemon, with zero duration', () => {
    const d = new Database(':memory:');
    initSchema(d);
    usageDb.openTurn(d, {
      id: 't1', terminalId: 'term1', projectId: 'p', provider: 'claude-code',
      model: '', role: '', startedAt: '2026-08-13T10:00:00.000Z',
    });

    expect(closeInterruptedTurns(d)).toBe(1);

    const row = d.prepare('SELECT * FROM usage_turns').get() as usageDb.TurnRow;
    expect(row.outcome).toBe('interrupted');
    // ended_at equals started_at so the turn contributes no duration — otherwise a
    // restart would look like a turn that ran for hours.
    expect(row.ended_at).toBe('2026-08-13T10:00:00.000Z');
  });

  it('is a no-op when nothing is open', () => {
    const d = new Database(':memory:');
    initSchema(d);
    expect(closeInterruptedTurns(d)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/startup.test.ts`
Expected: FAIL — `closeInterruptedTurns is not a function`

- [ ] **Step 3: Add `closeInterruptedTurns` to the recorder module**

Append to `packages/core/src/analytics/recorder.ts`:

```ts
/**
 * Close every row left open by a daemon that died mid-turn. `ended_at` is set to
 * `started_at`, not to now: the turn's real end is unknown, and a multi-hour
 * phantom duration would poison every duration statistic. Called once at startup.
 */
export function closeInterruptedTurns(db: Database.Database): number {
  try {
    return db.prepare(`
      UPDATE usage_turns SET ended_at = started_at, outcome = 'interrupted'
      WHERE ended_at IS NULL
    `).run().changes;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/startup.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Wire it into `server.ts`**

Add to the import block near `import { createStateRouter } from './routes/state.js';`:

```ts
import { attachUsageRecorder, closeInterruptedTurns } from './analytics/recorder.js';
```

Find the function that wires the manager listeners (it contains `structuredManager.on('resolved', …)` at line 118). Immediately **before** that first `.on('resolved'` line, add:

```ts
  // Analytics: one row per turn, written live from the same events that drive status.
  // Kept as its own subscriber rather than folded into the status handlers so a
  // failure here can never affect a turn. See analytics/recorder.ts.
  attachUsageRecorder(structuredManager, {
    db,
    onTurnClosed: () => broadcaster.broadcast({ type: 'analytics-dirty' }),
  });
```

If `db` or `broadcaster` is not in scope in that function, thread them in from the caller rather than reaching for a module-level singleton.

Then find the daemon start-up path where the routers are mounted (`app.use('/api/state', createStateRouter(db));` at line 269) and add this line just before the first `app.use('/api'` call:

```ts
  // A daemon that died mid-turn left rows open; close them before anything reads them.
  closeInterruptedTurns(db);
```

- [ ] **Step 6: Verify the daemon still starts**

Run: `pnpm --filter dispatch-server build && node packages/core/dist/server.js --help 2>&1 | head -5`
Expected: no `ERR_MODULE_NOT_FOUND`. A missing `.js` extension on the new import fails here and nowhere else.

- [ ] **Step 7: Run the full core suite**

Run: `pnpm --filter dispatch-server test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/server.ts packages/core/src/analytics/recorder.ts packages/core/src/analytics/startup.test.ts
git commit -m "feat(core): attach the usage recorder and close interrupted turns on start"
```

---

### Task 5: Pricing

**Files:**
- Create: `packages/core/src/analytics/pricing.ts`
- Test: `packages/core/src/analytics/pricing.test.ts`
- Modify: `packages/core/src/routes/state.ts:100-110`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface ModelPrice { input: number; output: number; cacheRead: number; cacheCreate: number }`
  - `priceFor(model: string): ModelPrice | null`
  - `notionalValueUsd(t: { input: number; output: number; cacheRead: number; cacheCreate: number; model: string }): number | null`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { priceFor, notionalValueUsd } from './pricing.js';

describe('pricing', () => {
  it('prices a known model per million tokens', () => {
    const v = notionalValueUsd({ model: 'claude-opus-5', input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 })!;
    expect(v).toBeCloseTo(15, 5);
  });

  it('adds every token class', () => {
    const v = notionalValueUsd({ model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreate: 1_000_000 })!;
    expect(v).toBeCloseTo(3 + 15 + 0.3 + 3.75, 5);
  });

  // An unpriced model must not silently price at zero — the caller has to be able to
  // tell "this cost nothing" from "we do not know what this would have cost".
  it('returns null for an unknown model', () => {
    expect(priceFor('some-future-model')).toBeNull();
    expect(notionalValueUsd({ model: 'some-future-model', input: 999, output: 999, cacheRead: 0, cacheCreate: 0 })).toBeNull();
  });

  it('matches a dated model id by prefix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pricing.test.ts`
Expected: FAIL — `Cannot find module './pricing.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/pricing.ts`:

```ts
/**
 * Per-model list prices, in dollars per million tokens.
 *
 * These produce a NOTIONAL figure: on a subscription plan no dollars change hands,
 * so every surface that shows this number must label it "equivalent API value",
 * never "cost" or "spend".
 *
 * Ids are matched by prefix, so a dated id (claude-haiku-4-5-20251001) resolves to
 * its family. An unknown model returns null rather than 0 — "we do not know" and
 * "it was free" are different facts and the UI shows them differently.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const PRICES: ReadonlyArray<readonly [string, ModelPrice]> = [
  ['claude-opus-5',   { input: 15,  output: 75, cacheRead: 1.5,  cacheCreate: 18.75 }],
  ['claude-sonnet-5', { input: 3,   output: 15, cacheRead: 0.3,  cacheCreate: 3.75 }],
  ['claude-haiku-4-5',{ input: 0.8, output: 4,  cacheRead: 0.08, cacheCreate: 1 }],
  ['claude-fable-5',  { input: 3,   output: 15, cacheRead: 0.3,  cacheCreate: 3.75 }],
];

export function priceFor(model: string): ModelPrice | null {
  if (!model) return null;
  for (const [prefix, price] of PRICES) {
    if (model.startsWith(prefix)) return price;
  }
  return null;
}

export function notionalValueUsd(t: {
  model: string; input: number; output: number; cacheRead: number; cacheCreate: number;
}): number | null {
  const p = priceFor(t.model);
  if (!p) return null;
  return (t.input / 1e6) * p.input
       + (t.output / 1e6) * p.output
       + (t.cacheRead / 1e6) * p.cacheRead
       + (t.cacheCreate / 1e6) * p.cacheCreate;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/pricing.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Replace the stale table in the state route**

In `packages/core/src/routes/state.ts`, delete the local `pricing` record and the `totalCost` arithmetic at lines 100-110, and use the shared module. Add the import at the top:

```ts
import { notionalValueUsd } from '../analytics/pricing.js';
```

Replace lines 100-110 with:

```ts
      // Notional: list-price arithmetic, not a bill. Null when the model is unpriced.
      const totalCost = notionalValueUsd({
        model: stats.model,
        input: stats.inputTokens,
        output: stats.outputTokens,
        cacheRead: stats.cacheReadTokens,
        cacheCreate: stats.cacheCreationTokens,
      }) ?? 0;
```

- [ ] **Step 6: Run the full core suite**

Run: `pnpm --filter dispatch-server test`
Expected: PASS. If a `state` route test asserted a dollar figure from the old table, update the expected number and note in the test why it changed.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/analytics/pricing.ts packages/core/src/analytics/pricing.test.ts packages/core/src/routes/state.ts
git commit -m "feat(core): one shared model price table, refreshed"
```

---

### Task 6: The query layer

**Files:**
- Create: `packages/core/src/analytics/queries.ts`
- Test: `packages/core/src/analytics/queries.test.ts`

**Interfaces:**
- Consumes: `usage_turns` (Task 1), `notionalValueUsd` (Task 5), `terminalsDb`, `sessionsDb`
- Produces:
  - `interface Range { from?: string; to?: string; projectId?: string }`
  - `summary(db, r: Range): Summary`
  - `series(db, r: Range & { metric: Metric; groupBy: GroupBy }): SeriesPoint[]`
  - `top(db, r: Range & { dimension: Dimension; limit?: number }): TopRow[]`
  - `records(db): Records`
  - `type Metric = 'tokens' | 'outputTokens' | 'turns' | 'duration'`
  - `type GroupBy = 'model' | 'provider' | 'project' | 'outcome' | 'none'`
  - `type Dimension = 'project' | 'thread' | 'model'`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/analytics/queries.test.ts`:

```ts
// Day buckets are local time, so the assertions below only hold in a known zone.
// Set it before anything reads the clock; a test that passes only in one timezone
// is a defect, not a quirk.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { summary, series, top, records } from './queries.js';

function turn(d: Database.Database, o: Partial<usageDb.ClosedTurnInput> & { id: string; startedAt: string }) {
  usageDb.insertClosed(d, {
    terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', model: 'claude-opus-5',
    role: 'agent', endedAt: o.startedAt, outcome: 'idle',
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    ...o,
  } as usageDb.ClosedTurnInput);
}

describe('analytics queries', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    turn(d, { id: 'a', startedAt: '2026-08-10T10:00:00.000Z', endedAt: '2026-08-10T10:00:30.000Z', input: 100, output: 50 });
    turn(d, { id: 'b', startedAt: '2026-08-10T22:00:00.000Z', endedAt: '2026-08-10T22:00:10.000Z', input: 10, output: 5, model: 'claude-sonnet-5' });
    turn(d, { id: 'c', startedAt: '2026-08-12T09:00:00.000Z', endedAt: '2026-08-12T09:01:00.000Z', input: 1, output: 2, projectId: 'proj2', terminalId: 'term2' });
  });

  it('summarises tokens, turns and threads', () => {
    const s = summary(d, {});
    expect(s.turns).toBe(3);
    expect(s.threads).toBe(2);
    expect(s.inputTokens).toBe(111);
    expect(s.outputTokens).toBe(57);
    expect(s.totalTokens).toBe(168);
  });

  // A turn that reported no usage at all is not a turn that used nothing. Codex can
  // settle through its error path with no tokenUsage frame, and a PTY thread emits
  // no frames at all. Those must be countable separately so the UI never shows them
  // as a measured zero.
  it('counts turns that reported no usage separately', () => {
    turn(d, { id: 'silent', startedAt: '2026-08-12T15:00:00.000Z', endedAt: '2026-08-12T15:00:05.000Z', messages: 0 });
    const s = summary(d, {});
    expect(s.turns).toBe(4);
    expect(s.unreportedTurns).toBe(1);
    expect(summary(d, { from: '2026-08-13T00:00:00.000Z' }).unreportedTurns).toBe(0);
  });

  it('filters by project and by date range', () => {
    expect(summary(d, { projectId: 'proj2' }).turns).toBe(1);
    expect(summary(d, { from: '2026-08-11T00:00:00.000Z' }).turns).toBe(1);
    expect(summary(d, { to: '2026-08-11T00:00:00.000Z' }).turns).toBe(2);
  });

  it('buckets a series by day and splits by model', () => {
    const pts = series(d, { metric: 'tokens', groupBy: 'model' });
    const day10 = pts.filter((p) => p.day === '2026-08-10');
    expect(day10.length).toBe(2);
    expect(day10.find((p) => p.key === 'claude-opus-5')!.value).toBe(150);
    expect(day10.find((p) => p.key === 'claude-sonnet-5')!.value).toBe(15);
  });

  it('counts turns per day when grouping is none', () => {
    const pts = series(d, { metric: 'turns', groupBy: 'none' });
    expect(pts.find((p) => p.day === '2026-08-10')!.value).toBe(2);
    expect(pts.find((p) => p.day === '2026-08-12')!.value).toBe(1);
  });

  it('excludes zero-duration rows from the duration metric', () => {
    turn(d, { id: 'z', startedAt: '2026-08-12T12:00:00.000Z', endedAt: '2026-08-12T12:00:00.000Z', outcome: 'interrupted' });
    const pts = series(d, { metric: 'duration', groupBy: 'none' });
    // 2026-08-12 has one real 60s turn; the interrupted row must not drag the mean to 30s
    expect(pts.find((p) => p.day === '2026-08-12')!.value).toBe(60);
  });

  it('ranks top projects by tokens', () => {
    const rows = top(d, { dimension: 'project' });
    expect(rows[0].key).toBe('proj1');
    expect(rows[0].value).toBe(165);
  });

  it('reports all-time records', () => {
    const r = records(d);
    expect(r.totalTokens).toBe(168);
    expect(r.busiestDay).toBe('2026-08-10');
    expect(r.topModel).toBe('claude-opus-5');
    expect(r.activeDays).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/queries.test.ts`
Expected: FAIL — `Cannot find module './queries.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/analytics/queries.ts`:

```ts
import type Database from 'better-sqlite3';
import { notionalValueUsd } from './pricing.js';

export type Metric = 'tokens' | 'outputTokens' | 'turns' | 'duration';
export type GroupBy = 'model' | 'provider' | 'project' | 'outcome' | 'none';
export type Dimension = 'project' | 'thread' | 'model';

export interface Range { from?: string; to?: string; projectId?: string }

export interface Summary {
  turns: number;
  threads: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  notionalUsd: number;
  unpricedTokens: number;
  /**
   * Turns that closed without a single usage-bearing frame (`messages = 0`).
   *
   * This is NOT the same as a turn that used zero tokens. A Codex turn can settle
   * through the error path without ever emitting a `tokenUsage` frame
   * (`structured/codex-translate.ts:320-326` settles straight to idle), and a PTY
   * thread emits no frames at all. Those turns really did consume tokens; we
   * simply never saw a count. The spec forbids showing that as a measured zero,
   * so the UI reports this number separately as "turns that reported no usage".
   */
  unreportedTurns: number;
}

export interface SeriesPoint { day: string; key: string; value: number }
export interface TopRow { key: string; label: string; value: number }
export interface Records {
  totalTokens: number;
  totalTurns: number;
  busiestDay: string | null;
  busiestDayTokens: number;
  topModel: string | null;
  activeDays: number;
  longestTurnSeconds: number;
}

/** Build the shared WHERE clause. Every query filters identically. */
function where(r: Range): { sql: string; params: unknown[] } {
  const parts = ['ended_at IS NOT NULL'];
  const params: unknown[] = [];
  if (r.from) { parts.push('started_at >= ?'); params.push(r.from); }
  if (r.to) { parts.push('started_at < ?'); params.push(r.to); }
  if (r.projectId) { parts.push('project_id = ?'); params.push(r.projectId); }
  return { sql: parts.join(' AND '), params };
}

export function summary(db: Database.Database, r: Range): Summary {
  const w = where(r);
  const agg = db.prepare(`
    SELECT COUNT(*) AS turns, COUNT(DISTINCT terminal_id) AS threads,
           COALESCE(SUM(CASE WHEN messages = 0 THEN 1 ELSE 0 END), 0) AS unreported_turns,
           COALESCE(SUM(input_tokens), 0)        AS input_tokens,
           COALESCE(SUM(output_tokens), 0)       AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
           COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens
    FROM usage_turns WHERE ${w.sql}
  `).get(...w.params) as Record<string, number>;

  // Value is summed per model, because the price differs per model.
  const byModel = db.prepare(`
    SELECT model,
           COALESCE(SUM(input_tokens), 0)        AS input,
           COALESCE(SUM(output_tokens), 0)       AS output,
           COALESCE(SUM(cache_read_tokens), 0)   AS cacheRead,
           COALESCE(SUM(cache_create_tokens), 0) AS cacheCreate
    FROM usage_turns WHERE ${w.sql} GROUP BY model
  `).all(...w.params) as { model: string; input: number; output: number; cacheRead: number; cacheCreate: number }[];

  let notionalUsd = 0;
  let unpricedTokens = 0;
  for (const m of byModel) {
    const v = notionalValueUsd(m);
    if (v == null) unpricedTokens += m.input + m.output + m.cacheRead + m.cacheCreate;
    else notionalUsd += v;
  }

  return {
    turns: agg.turns,
    threads: agg.threads,
    inputTokens: agg.input_tokens,
    outputTokens: agg.output_tokens,
    cacheReadTokens: agg.cache_read_tokens,
    cacheCreateTokens: agg.cache_create_tokens,
    totalTokens: agg.input_tokens + agg.output_tokens + agg.cache_read_tokens + agg.cache_create_tokens,
    notionalUsd,
    unpricedTokens,
    unreportedTurns: agg.unreported_turns,
  };
}

const GROUP_COLUMN: Record<Exclude<GroupBy, 'none'>, string> = {
  model: 'model', provider: 'provider', project: 'project_id', outcome: 'outcome',
};

export function series(
  db: Database.Database,
  r: Range & { metric: Metric; groupBy: GroupBy },
): SeriesPoint[] {
  const w = where(r);
  const key = r.groupBy === 'none' ? `''` : GROUP_COLUMN[r.groupBy];

  // Day buckets are LOCAL time: 'localtime' converts before the date is taken, so a
  // 22:00 turn lands on the day the human worked, not the following UTC day.
  const day = `date(started_at, 'localtime')`;

  if (r.metric === 'duration') {
    // Mean seconds per bucket, over turns that actually have a duration. An
    // interrupted row has ended_at == started_at and is excluded, so a restart
    // cannot drag the average down.
    return db.prepare(`
      SELECT ${day} AS day, ${key} AS key,
             CAST(ROUND(AVG((julianday(ended_at) - julianday(started_at)) * 86400.0)) AS INTEGER) AS value
      FROM usage_turns
      WHERE ${w.sql} AND ended_at > started_at
      GROUP BY day, key ORDER BY day
    `).all(...w.params) as SeriesPoint[];
  }

  const value = r.metric === 'turns' ? 'COUNT(*)'
    : r.metric === 'outputTokens' ? 'SUM(output_tokens)'
    : 'SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens)';

  return db.prepare(`
    SELECT ${day} AS day, ${key} AS key, COALESCE(${value}, 0) AS value
    FROM usage_turns WHERE ${w.sql}
    GROUP BY day, key ORDER BY day
  `).all(...w.params) as SeriesPoint[];
}

export function top(db: Database.Database, r: Range & { dimension: Dimension; limit?: number }): TopRow[] {
  const w = where(r);
  const limit = r.limit ?? 10;

  if (r.dimension === 'model') {
    return db.prepare(`
      SELECT model AS key, model AS label,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS value
      FROM usage_turns WHERE ${w.sql} GROUP BY model ORDER BY value DESC LIMIT ?
    `).all(...w.params, limit) as TopRow[];
  }

  if (r.dimension === 'thread') {
    return db.prepare(`
      SELECT u.terminal_id AS key, COALESCE(t.label, u.terminal_id) AS label,
             SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_create_tokens) AS value
      FROM usage_turns u LEFT JOIN terminals t ON t.id = u.terminal_id
      WHERE ${w.sql.replace(/\b(ended_at|started_at|project_id)\b/g, 'u.$1')}
      GROUP BY u.terminal_id ORDER BY value DESC LIMIT ?
    `).all(...w.params, limit) as TopRow[];
  }

  return db.prepare(`
    SELECT u.project_id AS key, COALESCE(s.name, u.project_id) AS label,
           SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_create_tokens) AS value
    FROM usage_turns u LEFT JOIN sessions s ON s.id = u.project_id
    WHERE ${w.sql.replace(/\b(ended_at|started_at|project_id)\b/g, 'u.$1')}
    GROUP BY u.project_id ORDER BY value DESC LIMIT ?
  `).all(...w.params, limit) as TopRow[];
}

export function records(db: Database.Database): Records {
  const s = summary(db, {});
  const busiest = db.prepare(`
    SELECT date(started_at, 'localtime') AS day,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS value
    FROM usage_turns WHERE ended_at IS NOT NULL
    GROUP BY day ORDER BY value DESC LIMIT 1
  `).get() as { day: string; value: number } | undefined;

  const topModel = top(db, { dimension: 'model', limit: 1 })[0]?.key ?? null;

  const activeDays = (db.prepare(`
    SELECT COUNT(DISTINCT date(started_at, 'localtime')) AS n
    FROM usage_turns WHERE ended_at IS NOT NULL
  `).get() as { n: number }).n;

  const longest = (db.prepare(`
    SELECT COALESCE(MAX((julianday(ended_at) - julianday(started_at)) * 86400.0), 0) AS s
    FROM usage_turns WHERE ended_at > started_at
  `).get() as { s: number }).s;

  return {
    totalTokens: s.totalTokens,
    totalTurns: s.turns,
    busiestDay: busiest?.day ?? null,
    busiestDayTokens: busiest?.value ?? 0,
    topModel,
    activeDays,
    longestTurnSeconds: Math.round(longest),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/queries.test.ts`
Expected: PASS, 7 tests.

If vitest hoists the imports above the `process.env.TZ` assignment and the day-bucket assertions fail, move the assignment into a `setupFiles` entry in `packages/core/vitest.config.ts` instead. Do not weaken the assertions to make them timezone-agnostic — the local-time bucket is the behaviour under test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analytics/queries.ts packages/core/src/analytics/queries.test.ts
git commit -m "feat(core): analytics aggregation queries"
```

---

### Task 7: The API router

**Files:**
- Create: `packages/core/src/routes/analytics.ts`
- Test: `packages/core/src/routes/analytics.test.ts`
- Modify: `packages/core/src/server.ts:269` area

**Interfaces:**
- Consumes: `summary`, `series`, `top`, `records` (Task 6); `appState.get/set`
- Produces: `createAnalyticsRouter(db: Database.Database): Router`, mounted at `/api/analytics`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/routes/analytics.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { createAnalyticsRouter } from './analytics.js';

function app(d: Database.Database) {
  const a = express();
  a.use(express.json());
  a.use('/api/analytics', createAnalyticsRouter(d));
  return a;
}

describe('analytics routes', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    usageDb.insertClosed(d, {
      id: 'a', terminalId: 'term1', projectId: 'proj1', provider: 'claude-code',
      model: 'claude-opus-5', role: 'agent',
      startedAt: '2026-08-10T10:00:00.000Z', endedAt: '2026-08-10T10:00:30.000Z', outcome: 'idle',
      input: 100, output: 50, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    });
  });

  it('GET /summary returns totals', async () => {
    const res = await request(app(d)).get('/api/analytics/summary');
    expect(res.status).toBe(200);
    expect(res.body.turns).toBe(1);
    expect(res.body.totalTokens).toBe(150);
  });

  it('GET /series validates metric and groupBy', async () => {
    const ok = await request(app(d)).get('/api/analytics/series?metric=tokens&groupBy=model');
    expect(ok.status).toBe(200);
    expect(ok.body[0].key).toBe('claude-opus-5');

    const bad = await request(app(d)).get('/api/analytics/series?metric=DROP&groupBy=model');
    expect(bad.status).toBe(400);
  });

  it('GET /records returns all-time facts', async () => {
    const res = await request(app(d)).get('/api/analytics/records');
    expect(res.status).toBe(200);
    expect(res.body.totalTurns).toBe(1);
  });

  it('GET /backfill reports the tracking start, stamping it on first read', async () => {
    const res = await request(app(d)).get('/api/analytics/backfill');
    expect(res.status).toBe(200);
    expect(typeof res.body.trackingStartedAt).toBe('string');
    const again = await request(app(d)).get('/api/analytics/backfill');
    expect(again.body.trackingStartedAt).toBe(res.body.trackingStartedAt);
  });
});
```

- [ ] **Step 2: Confirm `supertest` is available**

Run: `rg -n "supertest" packages/core/package.json`
If it is absent, check how the other route tests drive Express (`rg -l "supertest\|node-mocks-http" packages/core/src/routes/`) and rewrite the test to match the pattern already in the repo. Do not add a dependency if one is already in use.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/routes/analytics.test.ts`
Expected: FAIL — `Cannot find module './analytics.js'`

- [ ] **Step 4: Write the router**

Create `packages/core/src/routes/analytics.ts`:

```ts
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { summary, series, top, records } from '../analytics/queries.js';
import type { Metric, GroupBy, Dimension } from '../analytics/queries.js';

const METRICS: ReadonlySet<string> = new Set(['tokens', 'outputTokens', 'turns', 'duration']);
const GROUPS: ReadonlySet<string> = new Set(['model', 'provider', 'project', 'outcome', 'none']);
const DIMENSIONS: ReadonlySet<string> = new Set(['project', 'thread', 'model']);

export const TRACKING_KEY = 'analytics_tracking_started_at';

/**
 * The instant recording began, stamped once on first read. The history importer
 * accepts only turns OLDER than this, so imported and live rows can never
 * describe the same turn — that boundary is what makes the import button safe to
 * press twice.
 */
export function trackingStartedAt(db: Database.Database): string {
  const existing = appState.get(db, TRACKING_KEY);
  if (existing) return existing;
  const now = new Date().toISOString();
  appState.set(db, TRACKING_KEY, now);
  return now;
}

export function createAnalyticsRouter(db: Database.Database): Router {
  const router = Router();

  const range = (q: Record<string, any>) => ({
    from: typeof q.from === 'string' ? q.from : undefined,
    to: typeof q.to === 'string' ? q.to : undefined,
    projectId: typeof q.projectId === 'string' ? q.projectId : undefined,
  });

  router.get('/summary', (req, res) => {
    res.json(summary(db, range(req.query)));
  });

  router.get('/series', (req, res) => {
    const metric = String(req.query.metric ?? 'tokens');
    const groupBy = String(req.query.groupBy ?? 'none');
    if (!METRICS.has(metric)) { res.status(400).json({ error: `unknown metric: ${metric}` }); return; }
    if (!GROUPS.has(groupBy)) { res.status(400).json({ error: `unknown groupBy: ${groupBy}` }); return; }
    res.json(series(db, { ...range(req.query), metric: metric as Metric, groupBy: groupBy as GroupBy }));
  });

  router.get('/top', (req, res) => {
    const dimension = String(req.query.dimension ?? 'project');
    if (!DIMENSIONS.has(dimension)) { res.status(400).json({ error: `unknown dimension: ${dimension}` }); return; }
    res.json(top(db, { ...range(req.query), dimension: dimension as Dimension }));
  });

  router.get('/records', (_req, res) => {
    res.json(records(db));
  });

  router.get('/backfill', (_req, res) => {
    res.json({ trackingStartedAt: trackingStartedAt(db), ...readBackfillState(db) });
  });

  return router;
}

export interface BackfillState {
  state: 'idle' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  lastFinishedAt: string | null;
  error?: string;
}

const BACKFILL_KEY = 'analytics_backfill_state';

export function readBackfillState(db: Database.Database): BackfillState {
  const raw = appState.get(db, BACKFILL_KEY);
  if (!raw) return { state: 'idle', done: 0, total: 0, lastFinishedAt: null };
  try { return JSON.parse(raw) as BackfillState; }
  catch { return { state: 'idle', done: 0, total: 0, lastFinishedAt: null }; }
}

export function writeBackfillState(db: Database.Database, s: BackfillState): void {
  appState.set(db, BACKFILL_KEY, JSON.stringify(s));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/routes/analytics.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Mount the router**

In `packages/core/src/server.ts`, add the import beside the other route imports:

```ts
import { createAnalyticsRouter } from './routes/analytics.js';
```

And add the mount next to `app.use('/api/watches', createWatchesRouter(db));`:

```ts
  app.use('/api/analytics', createAnalyticsRouter(db));
```

- [ ] **Step 7: Verify the daemon still starts, then run the full suite**

Run: `pnpm --filter dispatch-server build && pnpm --filter dispatch-server test`
Expected: build succeeds, tests PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/routes/analytics.ts packages/core/src/routes/analytics.test.ts packages/core/src/server.ts
git commit -m "feat(core): /api/analytics router"
```

---

### Task 8: The manual history importer

**Files:**
- Create: `packages/core/src/analytics/importer.ts`
- Test: `packages/core/src/analytics/importer.test.ts`
- Modify: `packages/core/src/routes/analytics.ts`

**Interfaces:**
- Consumes: `usageDb.insertClosed` / `deleteBackfilled` (Task 1), `usageFromFrame` (Task 2), `trackingStartedAt` / `readBackfillState` / `writeBackfillState` (Task 7), `resolveTranscriptPath` from `sessions/cc-sessions.js`
- Produces:
  - `importHistory(db, opts: { cutoff: string; onProgress?: (done: number, total: number) => void }): ImportResult`
  - `interface ImportResult { imported: number; skipped: number; threads: number }`

- [ ] **Step 1: Check the transcript path helper's real signature**

Run: `rg -n "export function resolveTranscriptPath" -A 12 packages/core/src/sessions/cc-sessions.ts`
Use whatever it actually exports. If it is not exported, export it, and note that in the commit message.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/analytics/importer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { importHistory } from './importer.js';

const CUTOFF = '2026-08-13T00:00:00.000Z';

function line(at: string, output: number) {
  return JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

describe('history importer', () => {
  let dir: string;
  let d: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-import-'));
    d = new Database(':memory:');
    initSchema(d);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeTranscript(name: string, lines: string[]) {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  it('imports turns older than the cutoff and marks them backfilled', () => {
    const file = writeTranscript('s1', [line('2026-08-10T10:00:00.000Z', 20)]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: 'agent', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    const row = d.prepare('SELECT * FROM usage_turns').get() as any;
    expect(row.backfilled).toBe(1);
    expect(row.output_tokens).toBe(20);
  });

  // The safety property: live recording owns everything at or after the cutoff.
  it('refuses data at or after the cutoff', () => {
    const file = writeTranscript('s2', [line('2026-08-13T09:00:00.000Z', 20), line(CUTOFF, 5)]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(2);
  });

  it('is idempotent — a second run replaces imported rows, not adds to them', () => {
    const file = writeTranscript('s3', [line('2026-08-10T10:00:00.000Z', 20)]);
    const threads = [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }];
    importHistory(d, { cutoff: CUTOFF, threads });
    importHistory(d, { cutoff: CUTOFF, threads });
    const n = (d.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('leaves live rows untouched', () => {
    d.prepare(`INSERT INTO usage_turns (id, terminal_id, project_id, provider, started_at, ended_at, outcome, output_tokens)
               VALUES ('live','term1','proj1','claude-code','2026-08-14T10:00:00.000Z','2026-08-14T10:00:05.000Z','idle',7)`).run();
    const file = writeTranscript('s4', [line('2026-08-10T10:00:00.000Z', 20)]);
    importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }] });
    const live = d.prepare(`SELECT * FROM usage_turns WHERE id = 'live'`).get() as any;
    expect(live.output_tokens).toBe(7);
  });

  it('skips a thread whose transcript is missing', () => {
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'grok', role: '', transcriptPath: path.join(dir, 'nope.jsonl') }] });
    expect(res.imported).toBe(0);
    expect(res.threads).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/importer.test.ts`
Expected: FAIL — `Cannot find module './importer.js'`

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/analytics/importer.ts`:

```ts
import fs from 'fs';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import * as usageDb from '../db/usage.js';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

export interface ImportThread {
  terminalId: string;
  projectId: string;
  provider: string;
  role: string;
  transcriptPath: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  threads: number;
}

/**
 * The manual, one-off history import. It runs ONLY when the human presses the
 * button — never on daemon start, and never on a timer.
 *
 * Two properties make it safe to press twice:
 *   1. It writes only turns strictly OLDER than `cutoff`
 *      (app_state's analytics_tracking_started_at). Live recording owns everything
 *      from that instant on, so the two can never describe the same turn.
 *   2. Every row it writes carries backfilled = 1, and a run deletes those rows
 *      first. A live row is never touched, so a failed import cannot damage a
 *      real measurement.
 *
 * One imported assistant message becomes one turn row. A transcript records no
 * turn boundaries, so `ended_at` equals `started_at` and the row contributes no
 * duration — the duration queries exclude `ended_at == started_at` for exactly
 * this reason.
 */
export function importHistory(
  db: Database.Database,
  opts: { cutoff: string; threads: ImportThread[]; onProgress?: (done: number, total: number) => void },
): ImportResult {
  usageDb.deleteBackfilled(db);

  let imported = 0;
  let skipped = 0;
  let threads = 0;
  let done = 0;

  for (const t of opts.threads) {
    done += 1;
    opts.onProgress?.(done, opts.threads.length);

    let raw: string;
    try { raw = fs.readFileSync(t.transcriptPath, 'utf-8'); }
    catch { continue; } // a missing transcript is normal: PTY threads have none

    let wroteForThread = false;
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(ln); } catch { continue; }

      const usage = usageFromFrame(ev);
      if (!usage) continue;

      const at = typeof ev.timestamp === 'string' ? ev.timestamp : null;
      if (!at) { skipped += 1; continue; }
      if (at >= opts.cutoff) { skipped += 1; continue; }

      usageDb.insertClosed(db, {
        id: randomUUID(),
        terminalId: t.terminalId,
        projectId: t.projectId,
        provider: t.provider,
        model: usage.model,
        role: t.role,
        startedAt: at,
        endedAt: at,
        outcome: 'idle',
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheCreate: usage.cacheCreate,
        messages: 1,
        toolCalls: toolCallsInFrame(ev),
        backfilled: true,
      });
      imported += 1;
      wroteForThread = true;
    }
    if (wroteForThread) threads += 1;
  }

  return { imported, skipped, threads };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-server exec vitest run src/analytics/importer.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Add the POST and DELETE routes**

In `packages/core/src/routes/analytics.ts`, add these imports:

```ts
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import { importHistory } from '../analytics/importer.js';
import { resolveTranscriptPath } from '../sessions/cc-sessions.js';
import * as usageDb from '../db/usage.js';
```

And add these routes inside `createAnalyticsRouter`, before `return router;`:

```ts
  // Manual, human-triggered import. Runs synchronously: a few hundred transcripts
  // parse in seconds, and a synchronous run cannot leave a half-written state
  // record behind if the daemon dies mid-import.
  router.post('/backfill', (_req, res) => {
    const cutoff = trackingStartedAt(db);
    const state = readBackfillState(db);
    if (state.state === 'running') { res.status(409).json({ error: 'an import is already running' }); return; }

    const threads = [];
    for (const project of sessionsDb.list(db)) {
      for (const terminal of terminalsDb.listBySession(db, project.id)) {
        if (!terminal.external_id) continue;
        const workDir = terminal.working_dir || project.working_dir;
        if (!workDir) continue;
        const transcriptPath = resolveTranscriptPath(workDir, terminal.external_id);
        if (!transcriptPath) continue;
        let cfg: Record<string, any> = {};
        try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
        threads.push({
          terminalId: terminal.id, projectId: project.id, provider: terminal.type,
          role: typeof cfg.role === 'string' ? cfg.role : '', transcriptPath,
        });
      }
    }

    writeBackfillState(db, { state: 'running', done: 0, total: threads.length, lastFinishedAt: null });
    try {
      const result = importHistory(db, {
        cutoff, threads,
        onProgress: (done, total) => writeBackfillState(db, { state: 'running', done, total, lastFinishedAt: null }),
      });
      writeBackfillState(db, { state: 'done', done: threads.length, total: threads.length, lastFinishedAt: new Date().toISOString() });
      res.json(result);
    } catch (err: any) {
      writeBackfillState(db, { state: 'error', done: 0, total: threads.length, lastFinishedAt: null, error: String(err?.message ?? err) });
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // Remove imported rows. Live measurements are never touched.
  router.delete('/backfill', (_req, res) => {
    const removed = usageDb.deleteBackfilled(db);
    writeBackfillState(db, { state: 'idle', done: 0, total: 0, lastFinishedAt: null });
    res.json({ removed });
  });
```

If `sessionsDb.list` has a different name or signature, run `rg -n "export function list" packages/core/src/db/sessions.ts` and use the real one.

- [ ] **Step 7: Run the full core suite and build**

Run: `pnpm --filter dispatch-server build && pnpm --filter dispatch-server test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/analytics/importer.ts packages/core/src/analytics/importer.test.ts packages/core/src/routes/analytics.ts
git commit -m "feat(core): manual one-off history import, bounded by the tracking cutoff"
```

---

### Task 9: Web API client and types

**Files:**
- Modify: `packages/web/src/api/types.ts`
- Modify: `packages/web/src/api/client.ts`
- Test: `packages/web/src/api/analytics-client.test.ts`

**Interfaces:**
- Consumes: the routes from Tasks 7 and 8
- Produces: `api.analyticsSummary`, `api.analyticsSeries`, `api.analyticsTop`, `api.analyticsRecords`, `api.analyticsBackfillState`, `api.analyticsRunBackfill`, `api.analyticsClearBackfill`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/api/analytics-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './client';

describe('analytics api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ turns: 3 }) })));
  });

  it('passes the range as query parameters', async () => {
    await api.analyticsSummary({ from: '2026-08-01T00:00:00.000Z', projectId: 'p1' });
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/api/analytics/summary?');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('projectId=p1');
  });

  it('omits absent range fields instead of sending "undefined"', async () => {
    await api.analyticsSummary({});
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain('undefined');
  });

  it('sends the metric and groupBy on a series request', async () => {
    await api.analyticsSeries({ metric: 'tokens', groupBy: 'model' });
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('metric=tokens');
    expect(url).toContain('groupBy=model');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/api/analytics-client.test.ts`
Expected: FAIL — `api.analyticsSummary is not a function`

- [ ] **Step 3: Add the types**

Append to `packages/web/src/api/types.ts`:

```ts
export interface AnalyticsRange { from?: string; to?: string; projectId?: string }
export type AnalyticsMetric = 'tokens' | 'outputTokens' | 'turns' | 'duration';
export type AnalyticsGroupBy = 'model' | 'provider' | 'project' | 'outcome' | 'none';
export type AnalyticsDimension = 'project' | 'thread' | 'model';

export interface AnalyticsSummary {
  turns: number;
  threads: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /** Notional list-price value. Not a bill — on a subscription no dollars change hands. */
  notionalUsd: number;
  /** Tokens from models with no price entry, so the UI can mark the value partial. */
  unpricedTokens: number;
}

export interface AnalyticsPoint { day: string; key: string; value: number }
export interface AnalyticsTopRow { key: string; label: string; value: number }

export interface AnalyticsRecords {
  totalTokens: number;
  totalTurns: number;
  busiestDay: string | null;
  busiestDayTokens: number;
  topModel: string | null;
  activeDays: number;
  longestTurnSeconds: number;
}

export interface AnalyticsBackfillState {
  trackingStartedAt: string;
  state: 'idle' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  lastFinishedAt: string | null;
  error?: string;
}
```

- [ ] **Step 4: Add the client methods**

In `packages/web/src/api/client.ts`, add the new type names to the existing `import type { … } from './types'` list, then add these methods to the exported `api` object:

```ts
  analyticsSummary: (r: AnalyticsRange) => req<AnalyticsSummary>(`/api/analytics/summary${qs(r)}`),
  analyticsSeries: (o: AnalyticsRange & { metric: AnalyticsMetric; groupBy: AnalyticsGroupBy }) =>
    req<AnalyticsPoint[]>(`/api/analytics/series${qs(o)}`),
  analyticsTop: (o: AnalyticsRange & { dimension: AnalyticsDimension }) =>
    req<AnalyticsTopRow[]>(`/api/analytics/top${qs(o)}`),
  analyticsRecords: () => req<AnalyticsRecords>('/api/analytics/records'),
  analyticsBackfillState: () => req<AnalyticsBackfillState>('/api/analytics/backfill'),
  analyticsRunBackfill: () => req<{ imported: number; skipped: number; threads: number }>('/api/analytics/backfill', { method: 'POST' }),
  analyticsClearBackfill: () => req<{ removed: number }>('/api/analytics/backfill', { method: 'DELETE' }),
```

And add this helper next to the existing `const body = …` line:

```ts
/** Build a query string from defined values only — an absent filter must not become "undefined". */
const qs = (o: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/api/analytics-client.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/api/client.ts packages/web/src/api/analytics-client.test.ts
git commit -m "feat(web): analytics api client"
```

---

### Task 10: Chart theme and palette

**Files:**
- Create: `packages/web/src/components/analytics/chartTheme.ts`
- Test: `packages/web/src/components/analytics/chartTheme.test.ts`
- Modify: `packages/web/package.json` (add `recharts`)

**Interfaces:**
- Consumes: CSS custom properties from `theme.css`
- Produces:
  - `SERIES: readonly string[]` — the five validated hues plus the "Other" gray
  - `seriesColor(keys: string[], key: string): string`
  - `OUTCOME_COLOR: Record<string, string>`
  - `resolveChartTheme(): { text: string; muted: string; grid: string; surface: string }`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter dispatch-web add recharts`
Then confirm the lockfile changed: `git diff --stat pnpm-lock.yaml`

- [ ] **Step 2: Write the failing test**

Create `packages/web/src/components/analytics/chartTheme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SERIES, OTHER, seriesColor, OUTCOME_COLOR } from './chartTheme';

describe('chart palette', () => {
  it('uses the five validated hues in fixed order', () => {
    expect(SERIES).toEqual(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']);
  });

  // Color follows the entity, not its rank: filtering a series out must not
  // repaint the ones that survive.
  it('gives a key the same color regardless of the other keys present', () => {
    const all = ['opus', 'sonnet', 'haiku'];
    expect(seriesColor(all, 'haiku')).toBe(seriesColor(['opus', 'haiku'], 'haiku'));
  });

  it('folds a sixth series into Other rather than inventing a hue', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(seriesColor(keys, 'f')).toBe(OTHER);
    expect(SERIES).not.toContain(OTHER);
  });

  it('reserves the status colors for outcomes only', () => {
    expect(OUTCOME_COLOR.idle).toBe('#3ECF6A');
    expect(OUTCOME_COLOR.needs_help).toBe('#F5C542');
    expect(OUTCOME_COLOR.exit).toBe('#F0616D');
    for (const c of Object.values(OUTCOME_COLOR)) expect(SERIES).not.toContain(c);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/analytics/chartTheme.test.ts`
Expected: FAIL — cannot resolve `./chartTheme`

- [ ] **Step 4: Write the implementation**

Create `packages/web/src/components/analytics/chartTheme.ts`:

```ts
/**
 * The analytics palette.
 *
 * Dispatch's theme offers only three chart-usable colors, and all three are STATUS
 * colors (accent green, warning yellow, error red). Reusing one as "series 4" would
 * make a model look like a failure, so the categorical hues below are the view's
 * own. They were validated against the Dispatch pane surface #141416 in dark mode:
 * lightness band, chroma floor, colorblind separation (worst adjacent pair ΔE 8.4
 * protan), normal-vision floor (worst 19.3) and contrast all pass.
 *
 * Hues are assigned by sorted key, never by the order a filter happens to return —
 * so hiding one model does not repaint the others. A sixth series folds into
 * OTHER rather than generating a new hue.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
export const OTHER = '#6b6b73';

export function seriesColor(keys: string[], key: string): string {
  const i = [...keys].sort().indexOf(key);
  if (i < 0) return OTHER;
  return i < SERIES.length ? SERIES[i] : OTHER;
}

/** Outcomes are states, not identities, so they wear the reserved status colors. */
export const OUTCOME_COLOR: Record<string, string> = {
  idle: '#3ECF6A',
  needs_help: '#F5C542',
  scheduled: '#8E8E96',
  exit: '#F0616D',
  interrupted: '#5A5A61',
};

/**
 * Recharts needs literal colors — it cannot take `var(--color-text-tertiary)`.
 * Read the computed custom properties once, so theme.css stays the single source
 * of truth for everything except the categorical hues above.
 */
export function resolveChartTheme(): { text: string; muted: string; grid: string; surface: string } {
  const fallback = { text: '#E9E9EC', muted: '#8E8E96', grid: '#29292E', surface: '#141416' };
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const s = getComputedStyle(document.documentElement);
  const read = (name: string, dflt: string) => s.getPropertyValue(name).trim() || dflt;
  return {
    text: read('--color-text-primary', fallback.text),
    muted: read('--color-text-secondary', fallback.muted),
    grid: read('--color-border', fallback.grid),
    surface: read('--color-pane', fallback.surface),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/analytics/chartTheme.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add packages/web/package.json pnpm-lock.yaml packages/web/src/components/analytics/chartTheme.ts packages/web/src/components/analytics/chartTheme.test.ts
git commit -m "feat(web): validated analytics palette and Recharts dependency"
```

---

### Task 11: The Analytics view

**Files:**
- Create: `packages/web/src/components/analytics/AnalyticsView.tsx`
- Test: `packages/web/src/components/analytics/AnalyticsView.test.tsx`

**Interfaces:**
- Consumes: `api.analytics*` (Task 9), `chartTheme` (Task 10)
- Produces: `export function AnalyticsView(): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/analytics/AnalyticsView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AnalyticsView } from './AnalyticsView';
import { api } from '../../api/client';

const EMPTY = {
  turns: 0, threads: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheCreateTokens: 0, totalTokens: 0, notionalUsd: 0, unpricedTokens: 0,
};

function stub(summary = EMPTY, points: any[] = []) {
  vi.spyOn(api, 'analyticsSummary').mockResolvedValue(summary as any);
  vi.spyOn(api, 'analyticsSeries').mockResolvedValue(points as any);
  vi.spyOn(api, 'analyticsTop').mockResolvedValue([] as any);
  vi.spyOn(api, 'analyticsRecords').mockResolvedValue({
    totalTokens: summary.totalTokens, totalTurns: summary.turns, busiestDay: null,
    busiestDayTokens: 0, topModel: null, activeDays: 0, longestTurnSeconds: 0,
  } as any);
  vi.spyOn(api, 'analyticsBackfillState').mockResolvedValue({
    trackingStartedAt: '2026-08-13T00:00:00.000Z', state: 'idle', done: 0, total: 0, lastFinishedAt: null,
  } as any);
}

describe('AnalyticsView', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('explains an empty table instead of showing zeroes as if they were measured', async () => {
    stub();
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/No turns recorded yet/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Import history/i })).toBeTruthy();
  });

  it('shows totals once data exists', async () => {
    stub({ ...EMPTY, turns: 12, threads: 3, totalTokens: 1_500_000, outputTokens: 40_000 });
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText('12')).toBeTruthy());
  });

  it('labels the dollar figure as notional, never as cost or spend', async () => {
    stub({ ...EMPTY, turns: 1, notionalUsd: 4.2 });
    render(<AnalyticsView />);
    await waitFor(() => expect(screen.getByText(/equivalent api value/i)).toBeTruthy());
    expect(screen.queryByText(/^cost$/i)).toBeNull();
    expect(screen.queryByText(/spend/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/analytics/AnalyticsView.test.tsx`
Expected: FAIL — cannot resolve `./AnalyticsView`

- [ ] **Step 3: Write the view**

Create `packages/web/src/components/analytics/AnalyticsView.tsx`. Build it in this order, matching the spec's block table:

1. A filter row: project select, range select (7 / 30 / 90 days / all), provider select.
2. Stat tiles: total tokens, output tokens, turns, threads, equivalent API value.
3. `Tokens over time` — Recharts `BarChart` with one stacked `Bar` per model, colored by `seriesColor`.
4. `Output tokens over time` — Recharts `LineChart`, 2px stroke.
5. `Turns per day by outcome` — stacked `BarChart` colored by `OUTCOME_COLOR`.
6. `Model mix` and `Top projects` — horizontal `BarChart` with `layout="vertical"`.
7. `Activity calendar` — a plain CSS-grid heatmap, not a Recharts component. One
   cell per day for the last 26 weeks, fed by `series(metric='tokens', groupBy='none')`.
   The ramp is a single hue with monotonic lightness, from near-surface to full
   accent: `#1B1B1E`, `#1E3D28`, `#256B3C`, `#2E9C52`, `#3ECF6A`. A day with no
   turns uses the surface color and an empty title, so "no work" reads differently
   from "a little work".
8. `Personal records` — a plain number list.
9. An `Import history` button wired to `api.analyticsRunBackfill`, shown with the tracking-start date.

Follow these rules from the spec, which the tests and the review will check:

```tsx
// Every chart:
//  - <CartesianGrid stroke={theme.grid} vertical={false} />, recessive
//  - axis ticks in theme.muted, never in a series color
//  - <Tooltip contentStyle={{ background: theme.surface, border: `1px solid ${theme.grid}` }} />
//  - <Legend /> whenever there are 2+ series; omitted for a single series
//  - <Bar radius={[4, 4, 0, 0]} /> for vertical bars, so data-ends are rounded
//  - stackId set, and a 2px gap between stacked segments via stroke={theme.surface} strokeWidth={2}
//  - NEVER two <YAxis> elements. Two measures mean two charts.
```

The empty state must read `No turns recorded yet — analytics started <date>.` and offer the import button. Do not render a chart full of zeroes.

The dollar tile's label is exactly `EQUIVALENT API VALUE`. When `unpricedTokens > 0`, append a `partial` marker and a title explaining that some models have no price entry.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/analytics/AnalyticsView.test.tsx`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/analytics/AnalyticsView.tsx packages/web/src/components/analytics/AnalyticsView.test.tsx
git commit -m "feat(web): the analytics view"
```

---

### Task 12: Mount the view — desktop, mobile, and live refresh

**Files:**
- Modify: `packages/web/src/stores/ui.ts:7,15`
- Modify: `packages/web/src/components/layout/TopBar.tsx:42-49`
- Modify: `packages/web/src/App.tsx:192`
- Modify: `packages/web/src/components/mobile/MobileApp.tsx:90,230,315`
- Test: `packages/web/src/components/analytics/mount.test.tsx`

**Interfaces:**
- Consumes: `AnalyticsView` (Task 11)
- Produces: `View = 'workspace' | 'board' | 'analytics'`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/analytics/mount.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUI } from '../../stores/ui';
import { TopBar } from '../layout/TopBar';

describe('analytics mounting', () => {
  it('offers an Analytics segment in the top bar', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy();
  });

  it('accepts analytics as a view and persists it', () => {
    useUI.getState().setView('analytics');
    expect(useUI.getState().view).toBe('analytics');
    expect(localStorage.getItem('dispatch:view')).toBe('analytics');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/analytics/mount.test.tsx`
Expected: FAIL — no Analytics button

- [ ] **Step 3: Widen the View union**

In `packages/web/src/stores/ui.ts`, replace line 7:

```ts
export type View = 'workspace' | 'board' | 'analytics';
```

And replace `loadView` on line 15, so the persisted value round-trips for all three:

```ts
const VIEWS: readonly View[] = ['workspace', 'board', 'analytics'];
const loadView = (): View => {
  try {
    const v = localStorage.getItem(VKEY) as View | null;
    return v && VIEWS.includes(v) ? v : 'workspace';
  } catch { return 'workspace'; }
};
```

- [ ] **Step 4: Add the top-bar segment**

In `packages/web/src/components/layout/TopBar.tsx`, after the Board button (line 46-48), add:

```tsx
        <button type="button" aria-pressed={view === 'analytics'} onClick={() => setView('analytics')} style={segBtn(view === 'analytics')}>
          Analytics
        </button>
```

- [ ] **Step 5: Render the view**

In `packages/web/src/App.tsx`, add the lazy import beside the other imports:

```tsx
const AnalyticsView = lazy(() => import('./components/analytics/AnalyticsView').then((m) => ({ default: m.AnalyticsView })));
```

Add `lazy` and `Suspense` to the existing `react` import. Then replace the ternary at line 192:

```tsx
        {view === 'analytics'
          ? <Suspense fallback={null}><AnalyticsView /></Suspense>
          : view === 'board'
          ? <BoardView />
          : (
```

The lazy import is what keeps Recharts out of the initial bundle, so do not convert it to a static import.

- [ ] **Step 6: Add the mobile tab**

In `packages/web/src/components/mobile/MobileApp.tsx`:

Line 90 — widen the state:

```tsx
  const [bottomTab, setBottomTab] = useState<'projects' | 'pinned' | 'agents' | 'analytics' | 'settings'>('projects');
```

Line 230 — add a branch at the top of the chain:

```tsx
            {bottomTab === 'analytics' ? (
              <Suspense fallback={null}><AnalyticsView /></Suspense>
            ) : bottomTab === 'settings' ? (
```

Line 315 — add the tab, and import `ChartBar` from `@phosphor-icons/react`:

```tsx
          {([['projects', 'Projects', Folders], ['pinned', 'Pinned', PushPin], ['agents', 'Automations', Robot], ['analytics', 'Usage', ChartBar], ['settings', 'Settings', Gear]] as const).map(([key, label, Icon]) => {
```

Use the same `lazy` + `Suspense` import for `AnalyticsView` here as in `App.tsx`.

- [ ] **Step 7: Add the live refresh**

The daemon broadcasts `{ type: 'analytics-dirty' }` when a turn closes (Task 4). In `AnalyticsView.tsx`, subscribe to the existing events socket and re-fetch on that message. Find how other components subscribe:

Run: `rg -n "events-socket\|useEvents" packages/web/src/components --no-heading | head -5`

Follow that pattern. Do not add a polling timer.

- [ ] **Step 8: Run the mount test, then the full web suite**

Run: `pnpm --filter dispatch-web exec vitest run src/components/analytics/mount.test.tsx`
Expected: PASS, 2 tests

Run: `pnpm --filter dispatch-web test`
Expected: PASS. `App.test.tsx` exercises the view switch, so if it asserts an exhaustive union, update it to include `'analytics'`.

- [ ] **Step 9: Build the web bundle and check the split**

Run: `pnpm --filter dispatch-web build`
Expected: the build succeeds and reports a separate chunk containing Recharts. If Recharts appears in the main chunk, the lazy import was lost — fix it before committing.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/stores/ui.ts packages/web/src/components/layout/TopBar.tsx packages/web/src/App.tsx packages/web/src/components/mobile/MobileApp.tsx packages/web/src/components/analytics/
git commit -m "feat(web): mount the analytics view on desktop and mobile"
```

---

### Task 13: End-to-end verification against a live daemon

**Files:**
- Test: manual, using the isolated-instance pattern

No production code changes. This task proves the recorder works against a real daemon, which no unit test can.

- [ ] **Step 1: Build everything**

Run: `pnpm -r build`
Expected: success

- [ ] **Step 2: Start an isolated daemon**

Never point a second daemon at the real `~/.dispatch`.

```bash
FAKE_HOME=$(mktemp -d)
HOME="$FAKE_HOME" PORT=3999 node packages/core/dist/server.js
```

Expected: it starts with no `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Confirm the table exists and starts empty**

The `sqlite3` CLI may not be installed. If `command -v sqlite3` is empty, run the
same query through the dependency the project already has:
`node -e "const D=require('better-sqlite3');console.table(new D(process.env.DB).prepare('<SQL>').all())"`
with `DB="$FAKE_HOME/.dispatch/dispatch.db"`.

```bash
sqlite3 "$FAKE_HOME/.dispatch/dispatch.db" "SELECT COUNT(*) FROM usage_turns;"
```

Expected: `0`

- [ ] **Step 4: Run one real turn**

Create a project and a Claude Code thread through the API on port 3999, send it a one-line prompt, and wait for it to settle.

- [ ] **Step 5: Confirm one row was recorded**

The `sqlite3` CLI may not be installed. If `command -v sqlite3` is empty, run the
same query through the dependency the project already has:
`node -e "const D=require('better-sqlite3');console.table(new D(process.env.DB).prepare('<SQL>').all())"`
with `DB="$FAKE_HOME/.dispatch/dispatch.db"`.

```bash
sqlite3 "$FAKE_HOME/.dispatch/dispatch.db" \
  "SELECT provider, model, outcome, input_tokens, output_tokens, messages, tool_calls FROM usage_turns;"
```

Expected: exactly one row, with a non-zero `output_tokens`, `outcome = 'idle'`, and a real model id.

- [ ] **Step 6: Confirm the restart path**

Kill the daemon mid-turn, restart it, then run:

The `sqlite3` CLI may not be installed. If `command -v sqlite3` is empty, run the
same query through the dependency the project already has:
`node -e "const D=require('better-sqlite3');console.table(new D(process.env.DB).prepare('<SQL>').all())"`
with `DB="$FAKE_HOME/.dispatch/dispatch.db"`.

```bash
sqlite3 "$FAKE_HOME/.dispatch/dispatch.db" \
  "SELECT outcome, started_at = ended_at FROM usage_turns WHERE outcome = 'interrupted';"
```

Expected: the interrupted row exists and `started_at = ended_at` is `1`.

- [ ] **Step 7: Check the API**

```bash
curl -s localhost:3999/api/analytics/summary | jq
curl -s 'localhost:3999/api/analytics/series?metric=tokens&groupBy=model' | jq
```

Expected: the totals match the rows in the table.

- [ ] **Step 8: Clean up**

```bash
rm -rf "$FAKE_HOME"
```

- [ ] **Step 9: Record the result**

If every check passed, say so plainly with the actual output. If any check failed, stop and report it — do not mark the plan complete.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 Cost is notional | 5 (pricing), 11 (label) |
| §5 What the daemon can see | 2 (frames), 3 (recorder) |
| §6 Data model | 1 |
| §7 The recorder, restart handling, failure policy | 3, 4 |
| §8 Backfill | 8 |
| §9 API | 7, 8 |
| §10 UI, colors, Recharts | 10, 11, 12 |
| §11 Other users and the update | 1 (additive migration), 12 (lazy load) |
| §12 Testing | every task, plus 13 |

**One gap accepted deliberately:**
- The spec's "turn duration" block asks for a distribution. Task 11 draws a mean per day instead, from the `duration` metric. A true histogram needs a bucketing endpoint that no other block uses, and a mean per day answers "are turns getting slower" with code that already exists. If you want the distribution, that is a follow-up task, not a gap in this one.

**Type consistency:** `UsageDelta` (Task 1) uses `input` / `output` / `cacheRead` / `cacheCreate`; `FrameUsage` (Task 2) uses the same four names plus `model`; `notionalValueUsd` (Task 5) takes the same four plus `model`. The recorder maps `FrameUsage` to `UsageDelta` explicitly in Task 3, and the importer does the same in Task 8.
