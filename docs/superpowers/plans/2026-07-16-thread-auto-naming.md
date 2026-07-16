# Thread Auto-Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unnamed threads get a one-shot name derived from their own transcript (Claude's summary title or the first user prompt); user-set names are structurally frozen forever.

**Architecture:** A `label_source` column (`'user' | 'default' | 'auto'`) distinguishes who named a thread. A pure namer module derives names from transcript JSONL. A `ThreadAutoNamer` service listens to the same activity moments that stamp `last_activity_at`, debounces one attempt ~5s later, writes through a race-guarded UPDATE, and broadcasts the existing `session:tabs-changed` event. Web needs zero changes.

**Tech Stack:** TypeScript ESM, better-sqlite3, vitest (fake timers), existing transcript parsers as reference.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-thread-auto-naming-design.md`.
- User labels are law: `updateLabel` (the rename path) ALWAYS stamps `'user'`; `setAutoLabel` is the ONLY writer of `'auto'` and is guarded `AND label_source = 'default'`.
- Auto names are one-shot: `'auto'` rows are never renamed by the system.
- Eligible types: `claude-code` and `codex` only. Shell and other tab types keep their defaults.
- Name cleaning: collapse whitespace to single spaces, ≤ 48 chars cut on a word boundary, skip `<`-prefixed payloads (tool noise), never emit an empty string — return `null` instead.
- Max 3 naming attempts per terminal per daemon lifetime; every failure silent (debug log only). Naming must never affect thread operation.
- Run core tests from `packages/core` (`npx vitest run …`), never the repo root. Never point a test daemon at the real `~/.dispatch` (verify-skill rules). Commit after every task on branch `worktree-thread-auto-naming`.

---

### Task 1: `label_source` column + db writers

**Files:**
- Modify: `packages/core/src/db/schema.ts:129-139` (migrations array)
- Modify: `packages/core/src/db/terminals.ts` (CreateInput, INSERT, rowToTerminal, Terminal type, updateLabel, new setAutoLabel)
- Test: `packages/core/tests/db/terminals.test.ts` (extend)

**Interfaces:**
- Produces: `Terminal.labelSource: 'user' | 'default' | 'auto'`; `CreateInput.labelSource: 'user' | 'default'`; `updateLabel(db, id, label)` now also sets `label_source='user'`; `setAutoLabel(db, id, label): boolean` (true if the row changed).

- [ ] **Step 1: Write the failing tests** (extend the existing file, following its setup pattern):

```ts
describe('label_source', () => {
  test('create stamps the provided labelSource', () => {
    const id = createTerminal({ label: 'My name', labelSource: 'user' });   // adapt to the file's existing create helper
    expect(getTerminal(id).labelSource).toBe('user');
    const id2 = createTerminal({ label: 'Claude Code', labelSource: 'default' });
    expect(getTerminal(id2).labelSource).toBe('default');
  });
  test('updateLabel stamps user', () => {
    const id = createTerminal({ label: 'Claude Code', labelSource: 'default' });
    terminals.updateLabel(db, id, 'Renamed');
    expect(getTerminal(id).labelSource).toBe('user');
  });
  test('setAutoLabel only fires on default rows', () => {
    const d = createTerminal({ label: 'Claude Code', labelSource: 'default' });
    expect(terminals.setAutoLabel(db, d, 'Fix the login bug')).toBe(true);
    expect(getTerminal(d).label).toBe('Fix the login bug');
    expect(getTerminal(d).labelSource).toBe('auto');
    // second auto attempt: frozen
    expect(terminals.setAutoLabel(db, d, 'Other')).toBe(false);
    // user row: frozen
    const u = createTerminal({ label: 'Claude Code', labelSource: 'user' });
    expect(terminals.setAutoLabel(db, u, 'Nope')).toBe(false);
    expect(getTerminal(u).label).toBe('Claude Code');
  });
});
```

- [ ] **Step 2: Run** `cd packages/core && npx vitest run tests/db/terminals.test.ts` → FAIL (labelSource undefined).
- [ ] **Step 3: Implement.** schema.ts migrations array gains:

```ts
{ table: 'terminals', column: 'label_source', sql: "ALTER TABLE terminals ADD COLUMN label_source TEXT NOT NULL DEFAULT 'user'" },
```

terminals.ts: add `label_source` to the INSERT column list with `input.labelSource ?? 'user'`; add `labelSource: (row.label_source ?? 'user') as 'user' | 'default' | 'auto'` to `rowToTerminal` and the `Terminal` interface; `updateLabel` becomes `UPDATE terminals SET label = ?, label_source = 'user' WHERE id = ?`; add:

```ts
/** One-shot auto-name. The label_source guard makes any concurrent user rename win. */
export function setAutoLabel(db: Database.Database, id: string, label: string): boolean {
  const r = db.prepare("UPDATE terminals SET label = ?, label_source = 'auto' WHERE id = ? AND label_source = 'default'").run(label, id);
  return r.changes > 0;
}
```

- [ ] **Step 4: Run the db tests** → PASS; then the full core suite once → PASS (existing create call sites compile because `labelSource` is optional-with-'user'-default at the db layer; the service stamps it properly in Task 2).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(db): terminals.label_source with user-wins auto-label writer"`

---

### Task 2: creation-path stamping in SessionService

**Files:**
- Modify: `packages/core/src/sessions/service.ts:240-300,353-380` (createTerminal, createQueuedTerminal, createRunnerTerminal, createTab)
- Modify: `packages/core/src/routes/terminals.ts:44` (createTab default moves server-side)
- Test: `packages/core/tests/sessions/service.test.ts` or the routes test that exercises creation (`packages/core/tests/routes/terminals.test.ts`) — follow where creation is already tested.

**Interfaces:**
- Consumes: `CreateInput.labelSource` from Task 1.
- Produces: every creation path passes `labelSource: label ? 'user' : 'default'` (computed BEFORE the `label || defaultTerminalLabel(...)` fallback). `createTab(sessionId, type, label?: string, config?)` now accepts undefined label and defaults internally to `label || type`.

- [ ] **Step 1: Failing test** — POST `/api/sessions/:id/terminals` without `label` → GET the terminal → `labelSource === 'default'`; with `label: 'Mine'` → `'user'`. Follow the existing terminals route test file's app/session setup exactly.
- [ ] **Step 2: Run** → FAIL (always 'user').
- [ ] **Step 3: Implement.** In each create method:

```ts
const labelSource: 'user' | 'default' = label ? 'user' : 'default';
const displayLabel = label || this.defaultTerminalLabel(sessionId, type);
// ...pass labelSource into terminalsDb.create input
```

For `createTab`, change the route (terminals.ts:44) to pass `label` through untouched (`sessionService.createTab(req.params.id, type, label, config)`) and inside createTab: `const labelSource = label ? 'user' as const : 'default' as const; const displayLabel = label || type;`

- [ ] **Step 4: Run** the touched test files, then full core suite → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(core): creation paths stamp label_source"`

---

### Task 3: the namer — `deriveThreadName` + transcript resolution

**Files:**
- Create: `packages/core/src/sessions/thread-namer.ts`
- Test: `packages/core/tests/sessions/thread-namer.test.ts`

**Interfaces:**
- Produces:
  - `cleanName(raw: string): string | null` — whitespace collapse, 48-char word-boundary cut, null when nothing survives.
  - `deriveThreadName(transcriptText: string, kind: 'claude' | 'codex'): string | null` — claude: first `{type:'summary'}` summary wins, else first non-meta user message whose extracted text doesn't start with `<` (mirror `cc-sessions.ts:369-389`'s filtering exactly, including `o.isMeta` skip); codex: first user message per `codex-sessions.ts`'s line format (READ that file first and mirror its role/text extraction — do not invent a format).
  - `resolveTranscriptPath(t: { type: string; externalId: string | null; workingDir: string | null }, sessionWorkingDir: string): string | null` — claude-code: `path.join(platform.claudeProjectDir(t.workingDir ?? sessionWorkingDir), `${t.externalId}.jsonl`)`, null without externalId; codex: mirror `codex-sessions.ts`'s directory + filename construction for a known id.

- [ ] **Step 1: Failing tests** (fixtures inline as template strings):

```ts
const CC_WITH_SUMMARY = [
  '{"type":"summary","summary":"Fix login redirect loop"}',
  '{"message":{"role":"user","content":"why does the login page loop forever after oauth"}}',
].join('\n');
const CC_PROMPT_ONLY = '{"message":{"role":"user","content":"add dark mode to the settings page please"}}';
const CC_NOISE_FIRST = [
  '{"isMeta":true,"message":{"role":"user","content":"<system-hint>x</system-hint>"}}',
  '{"message":{"role":"user","content":"<local-command-caveat>y</local-command-caveat>"}}',
  '{"message":{"role":"user","content":"rename the widget"}}',
].join('\n');

test('summary wins', () => expect(deriveThreadName(CC_WITH_SUMMARY, 'claude')).toBe('Fix login redirect loop'));
test('first prompt when no summary', () => expect(deriveThreadName(CC_PROMPT_ONLY, 'claude')).toBe('add dark mode to the settings page please'));
test('meta and <-prefixed messages skipped', () => expect(deriveThreadName(CC_NOISE_FIRST, 'claude')).toBe('rename the widget'));
test('empty/garbage → null', () => {
  expect(deriveThreadName('', 'claude')).toBeNull();
  expect(deriveThreadName('not json at all', 'claude')).toBeNull();
});
test('cleanName collapses and cuts on word boundary', () => {
  expect(cleanName('  fix   the\n\nlogin  ')).toBe('fix the login');
  const long = 'implement the frobnicator subsystem with retries and backoff for the flaky api';
  const cut = cleanName(long)!;
  expect(cut.length).toBeLessThanOrEqual(48);
  expect(long.startsWith(cut)).toBe(true);
  expect(cut.endsWith(' ')).toBe(false);
  expect(long[cut.length]).toBe(' ');   // word boundary, no mid-word cut
});
```

Plus one codex-format test after reading `codex-sessions.ts` (assert first user text extraction with a fixture matching its real line shape — copy the shape from that parser's expectations).

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `thread-namer.ts` (mirror cc-sessions extraction; reuse its `extractText` logic — import it if exported, else replicate the minimal content-to-text mapping with a comment pointing at the source).
- [ ] **Step 4: Run** `npx vitest run tests/sessions/thread-namer.test.ts` → PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(core): thread-namer — transcript-derived names"`

---

### Task 4: `ThreadAutoNamer` service (debounce, cap, guarded write, broadcast)

**Files:**
- Create: `packages/core/src/sessions/thread-auto-namer.ts`
- Test: `packages/core/tests/sessions/thread-auto-namer.test.ts`

**Interfaces:**
- Consumes: `terminalsDb.setAutoLabel` (Task 1), `deriveThreadName`/`resolveTranscriptPath` (Task 3), `EventBroadcaster` (existing type — see `routes/terminals.ts` usage: `broadcast({ type: 'session:tabs-changed', sessionId })`).
- Produces:

```ts
export class ThreadAutoNamer {
  constructor(db: Database.Database, broadcaster?: EventBroadcaster, opts?: {
    delayMs?: number;              // default 5000
    maxAttempts?: number;          // default 3
    readFile?: (p: string) => string;   // injectable for tests
  });
  /** Call on every real-activity moment. Cheap; self-filters. */
  notifyActivity(terminalId: string): void;
}
```

Behavior: `notifyActivity` looks up the row; returns immediately unless `label_source === 'default'` and type is `claude-code` or `codex` and attempts < maxAttempts and no timer pending for this terminal. Otherwise schedules `setTimeout(delayMs)` (tracked per terminal, `unref()`d). The attempt: resolve transcript path (needs the session's workingDir — one `sessionsDb.getById`), read file (missing → count attempt, done), `deriveThreadName` (null → count attempt, done), `setAutoLabel` (false → done, a user won the race), on true broadcast `{ type: 'session:tabs-changed', sessionId: row.session_id }`. Everything in try/catch; failures logged with `console.debug` only.

- [ ] **Step 1: Failing tests** (vi.useFakeTimers; in-memory db via the test helpers used in tests/db; fake readFile):

```ts
test('names a default-labeled claude thread once after the delay', ...);   // advance 5s, expect label + labelSource auto + broadcast called once
test('debounce: 5 notifies → one attempt', ...);
test('user rename during the delay wins', ...);                            // updateLabel before timer fires → setAutoLabel returns false, label untouched, no broadcast
test('gives up silently after 3 null attempts, 4th notify schedules nothing', ...); // readFile throws
test('shell threads and auto/user rows never schedule', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** file then full core suite → PASS, tsc clean.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(core): ThreadAutoNamer — debounced one-shot naming with user-wins semantics"`

---

### Task 5: wiring the activity signals

**Files:**
- Modify: `packages/core/src/server.ts` (construct ThreadAutoNamer next to TerminalMonitor/StatusService; pass broadcaster)
- Modify: `packages/core/src/status/service.ts:100-106` (alongside the `touchActivity` calls)
- Modify: `packages/core/src/terminal-monitor.ts:140-146` (alongside its `touchActivity` calls)
- Test: extend `packages/core/tests/status/service.test.ts` and `packages/core/tests/terminal-monitor.test.ts`

**Interfaces:**
- Consumes: `ThreadAutoNamer.notifyActivity(terminalId)`.
- Produces: both classes accept an optional `onActivity?: (terminalId: string) => void` (constructor option, matching each class's existing option style); they invoke it exactly where `touchActivity` fires (StatusService: non-`starting` statuses only, same guard; TerminalMonitor: the `wasBusy` idle-bump branch). `server.ts` passes `(id) => threadAutoNamer.notifyActivity(id)` to both.

- [ ] **Step 1: Failing tests** — in each class's existing test file, assert the callback fires on the same edges the existing activity-stamping tests cover (reuse their setup; e.g. StatusService: UserPromptSubmit fires callback, SessionStart does not; TerminalMonitor: busy-then-idle fires, connection-grace repaint does not).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (optional param, one call site each). **Step 4: Run** both files + full core suite → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(core): activity signals feed ThreadAutoNamer"`

---

### Task 6: runtime verification (isolated daemon)

**Files:** none committed (verification only; fix anything found).

- [ ] **Step 1:** Build (`pnpm --filter dispatch-server build && pnpm --filter dispatch-web build`), launch per `.claude/skills/verify/SKILL.md`: fake HOME, PORT=3999, `DISPATCH_WEB_DIST=<worktree>/packages/web/dist`.
- [ ] **Step 2:** Create a session (workingDir = a scratch dir) and an UNNAMED claude-code terminal via curl. Confirm GET shows `label: "Claude Code"`.
- [ ] **Step 3:** Seed the transcript: compute the fake-HOME claude project dir (`<fakeHome>/.claude/projects/<encoded workingDir>/<uuid>.jsonl`), write a JSONL with a summary line + a user message; PATCH or use the discovery path to set the terminal's external_id to that uuid (`sqlite3` against the fake HOME's db is acceptable: `UPDATE terminals SET external_id='<uuid>' WHERE id='<tid>'`).
- [ ] **Step 4:** POST `/api/events/claude/<tid>` with `{"hook_event_name":"UserPromptSubmit","session_id":"x"}`; within ~7s GET the terminal → label equals the summary text; verify a `session:tabs-changed` reached the events websocket if convenient (optional).
- [ ] **Step 5:** PATCH the terminal label to `Claude Code`; POST more UserPromptSubmit events; wait 7s; GET → label still `Claude Code` (user name frozen). Kill the daemon, report evidence in the task report.

---

## Self-Review (performed)

- **Spec coverage:** migration/writers → T1; creation stamping → T2; namer + cleaning + resolution → T3; trigger service (debounce/cap/broadcast/silence) → T4; signals → T5; integration behavior incl. freeze-after-rename → T6. Web: no task, per spec. Backfill: none, per spec.
- **Placeholder scan:** codex transcript shape deliberately says "read codex-sessions.ts and mirror" — grounded in a checked-in file, not invention. No TBDs.
- **Type consistency:** `labelSource` union literal everywhere; `setAutoLabel → boolean`; `notifyActivity(terminalId: string)`; `onActivity?: (terminalId: string) => void` in both signal classes.
